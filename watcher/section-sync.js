// Section sync — role-scoped annex repos mounted inside the brain.
//
// A brain can carry "sections": separate private repos (today: the leadership
// annex) that mount as folders inside the brain root and sync ONLY on entitled
// machines. The server is the single source of truth: every git-token response
// carries a `sections` array for THIS member ([] for everyone else), and the
// minted token is scoped so an unentitled machine's token cannot read an annex
// repo at all. This module reconciles local mounts against that answer:
//
//   granted                      -> exclude the mount from the main repo,
//                                   clone if missing, run a sync cycle.
//   absent on a SUCCESSFUL answer -> delete the local mount (revocation
//                                   hygiene; the entitlement already ended
//                                   server-side, this just tidies the disk).
//   no answer (offline/auth fail) -> touch NOTHING. Missing context is safe;
//                                   deleting on a network blip is not.
//
// Ordering guard (the one catastrophic failure this must prevent): section
// content must never be committed into the SHARED repo. The mount is written
// into the main repo's .git/info/exclude BEFORE any clone happens, and the
// mount holds its own .git (a nested repo), which `git add -A` records as a
// bare gitlink, never as file contents. Belt and braces.
//
// Same invariants as the main watcher: never rebase, never reset --hard,
// never stash. Conflicts keep OUR file and write THEIRS to a
// __from-remote-<ts> sidecar, committed alongside.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOCK_STALE_MS = 45000;

function create({ repoPath, getAuth, log }) {
  const say = log || ((m) => console.log(m));
  const manifestPath = path.join(repoPath, '.git', 'agencybrain-sections.json');

  // Every slug this machine has ever mounted (survives restarts via the
  // manifest) — used to answer ownsPath() and to find revoked mounts.
  const known = new Set(readManifest());

  function readManifest() {
    try {
      const j = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return Array.isArray(j.mounts) ? j.mounts.filter((s) => SLUG_RE.test(s)) : [];
    } catch (_) { return []; }
  }

  function writeManifest() {
    const mounts = [...known].filter((slug) =>
      fs.existsSync(path.join(repoPath, slug, '.git'))
    );
    try {
      fs.writeFileSync(manifestPath, JSON.stringify({ mounts }));
    } catch (_) { /* best-effort */ }
  }

  function mountDir(slug) { return path.join(repoPath, slug); }

  // True when p (absolute) lives inside any section mount — the main watcher
  // uses this to keep chokidar (and therefore its own debounce) off section
  // files. Section repos sync on their own cadence.
  function ownsPath(p) {
    for (const slug of known) {
      const dir = mountDir(slug);
      if (p === dir || p.startsWith(dir + path.sep)) return true;
    }
    return false;
  }

  // ── git plumbing (argument arrays, no shell — same rule as the watcher) ──

  function gitC(dir, args, captureStderr) {
    const r = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'ignore'],
      maxBuffer: 1024 * 1024 * 50,
    });
    const out = (r.stdout || '').toString().trim();
    const err = (r.stderr || (r.error && r.error.message) || '').toString().trim();
    return { ok: !r.error && r.status === 0, out, err };
  }

  function cleanRemoteUrl(url) {
    let prev; let u = url;
    do { prev = u; u = u.replace(/^(https:\/\/)[^@/]*@/i, '$1'); } while (u !== prev);
    return u;
  }

  function authedUrl(repoUrl, token) {
    if (!token || !/^https:\/\//i.test(repoUrl)) return repoUrl; // tests use local paths
    return cleanRemoteUrl(repoUrl).replace(/^https:\/\//, `https://x-access-token:${token}@`);
  }

  function withAuthedRemote(dir, token, fn) {
    const current = gitC(dir, ['remote', 'get-url', 'origin']);
    if (!current.ok) return { ok: false, err: 'no origin remote' };
    const clean = cleanRemoteUrl(current.out);
    const authed = authedUrl(clean, token);
    if (authed !== clean) gitC(dir, ['remote', 'set-url', 'origin', authed]);
    try {
      return fn();
    } finally {
      if (authed !== clean) gitC(dir, ['remote', 'set-url', 'origin', clean]);
    }
  }

  function clearStaleLock(dir) {
    const lock = path.join(dir, '.git', 'index.lock');
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs >= LOCK_STALE_MS) fs.unlinkSync(lock);
    } catch (_) { /* no lock */ }
  }

  // ── mount lifecycle ──

  // The mount must be invisible to the SHARED repo before it ever exists on
  // disk. .git/info/exclude is per-clone and never syncs, so this can't touch
  // the shared .gitignore.
  function addExclude(slug) {
    const p = path.join(repoPath, '.git', 'info', 'exclude');
    let cur = '';
    try { cur = fs.readFileSync(p, 'utf8'); } catch (_) { /* may not exist */ }
    const line = `/${slug}/`;
    if (cur.split('\n').includes(line)) return;
    const sep = cur.length && !cur.endsWith('\n') ? '\n' : '';
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, `${sep}${line}\n`);
    } catch (_) { /* best-effort */ }
  }

  function ensureCloned(slug, repoUrl, token) {
    const dir = mountDir(slug);
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
      // A plain local folder already uses this name. Never clobber user files —
      // skip and say so; the mount waits until the collision is resolved.
      say(`section ${slug}: a local folder with this name already exists — not touching it`);
      return false;
    }
    const r = gitC(repoPath, ['clone', authedUrl(repoUrl, token), dir], true);
    if (!r.ok) {
      say(`section ${slug}: clone failed — ${r.err.slice(0, 200)}`);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* partial clone */ }
      return false;
    }
    // The embedded token must not persist in the clone's origin URL.
    gitC(dir, ['remote', 'set-url', 'origin', cleanRemoteUrl(repoUrl)]);
    // Commits need an identity; inherit the main repo's (set at wizard time).
    const email = gitC(repoPath, ['config', 'user.email']);
    const name = gitC(repoPath, ['config', 'user.name']);
    if (email.ok && email.out) gitC(dir, ['config', 'user.email', email.out]);
    if (name.ok && name.out) gitC(dir, ['config', 'user.name', name.out]);
    say(`section ${slug}: mounted`);
    return true;
  }

  function tsCompact() {
    return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
  }

  function sidecarName(rel, stamp) {
    const dir = path.dirname(rel);
    const base = path.basename(rel);
    const dot = base.lastIndexOf('.');
    const tag = `__from-remote-${stamp}`;
    const renamed = dot > 0 ? base.slice(0, dot) + tag + base.slice(dot) : base + tag;
    return dir === '.' ? renamed : path.join(dir, renamed);
  }

  // Keep OUR version live, write THEIRS to a sidecar, commit the merge.
  function resolveConflicts(dir, stamp) {
    const unmerged = gitC(dir, ['diff', '--name-only', '--diff-filter=U']).out
      .split('\n').filter(Boolean);
    for (const f of unmerged) {
      const theirs = gitC(dir, ['show', `:3:${f}`], true);
      if (theirs.ok) {
        const sc = sidecarName(f, stamp);
        const scAbs = path.join(dir, sc);
        try {
          fs.mkdirSync(path.dirname(scAbs), { recursive: true });
          fs.writeFileSync(scAbs, theirs.out.endsWith('\n') ? theirs.out : `${theirs.out}\n`);
          gitC(dir, ['add', '--', sc]);
        } catch (_) { /* sidecar is best-effort; ours is kept either way */ }
      }
      const ours = gitC(dir, ['checkout', '--ours', '--', f]);
      if (!ours.ok) gitC(dir, ['checkout', '--theirs', '--', f]);
      gitC(dir, ['add', '--', f]);
    }
    gitC(dir, ['add', '-A']);
    const c = gitC(dir, ['commit', '--no-edit'], true);
    if (!c.ok) gitC(dir, ['commit', '-m', `auto-sync merge ${new Date().toISOString()} (kept both sides)`], true);
  }

  function syncOne(slug, token) {
    const dir = mountDir(slug);
    clearStaleLock(dir);

    // Finish an interrupted merge; never touch a hand-started rebase/cherry-pick.
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) resolveConflicts(dir, tsCompact());
    if (fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
        fs.existsSync(path.join(gitDir, 'rebase-apply')) ||
        fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
      say(`section ${slug}: a manual git operation is in progress — leaving it alone`);
      return;
    }

    const fetched = withAuthedRemote(dir, token, () => gitC(dir, ['fetch', '--quiet', 'origin'], true));
    if (!fetched.ok) { say(`section ${slug}: fetch failed — will retry`); return; }

    const branch = gitC(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
    if (!branch || branch === 'HEAD') return;

    // Commit local work first so a pull can never wedge on a dirty tree.
    const status = gitC(dir, ['status', '--porcelain']).out;
    if (status) {
      gitC(dir, ['add', '-A']);
      gitC(dir, ['commit', '-m', `auto-sync: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`], true);
    }

    const remoteHas = gitC(dir, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
    if (!remoteHas.ok) {
      // Brand-new annex with no upstream commits yet: publish ours if any.
      withAuthedRemote(dir, token, () => gitC(dir, ['push', '-u', 'origin', branch], true));
      return;
    }

    const ab = gitC(dir, ['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`]).out;
    const [ahead, behind] = (ab || '0\t0').split(/\s+/).map(Number);

    if (behind > 0) {
      const m = gitC(dir, ['merge', '--no-edit', `origin/${branch}`], true);
      if (!m.ok && fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
        resolveConflicts(dir, tsCompact());
        say(`section ${slug}: merged with overlapping edits — kept both sides`);
      } else if (!m.ok) {
        say(`section ${slug}: merge refused — will retry (${m.err.slice(0, 120)})`);
        return;
      }
    }

    const nowAhead = gitC(dir, ['rev-list', '--count', `origin/${branch}..${branch}`]).out;
    if (nowAhead && nowAhead !== '0') {
      const p = withAuthedRemote(dir, token, () => gitC(dir, ['push'], true));
      if (!p.ok) say(`section ${slug}: push failed — will retry (${p.err.slice(0, 120)})`);
    }
  }

  function removeMount(slug) {
    const dir = mountDir(slug);
    // Only ever remove a real mount (it must carry its own .git) — a plain
    // folder that happens to share a slug's name is the user's own data.
    if (!fs.existsSync(path.join(dir, '.git'))) { known.delete(slug); return; }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      say(`section ${slug}: access ended — removed from this machine`);
    } catch (e) {
      say(`section ${slug}: could not remove mount — ${e.message}`);
    }
    known.delete(slug);
  }

  // ── the reconcile tick — called by the watcher after each sync cycle ──

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      let auth;
      try {
        auth = await getAuth();
      } catch (_) {
        return; // no answer (offline / expired sign-in): touch nothing
      }
      if (!auth || !Array.isArray(auth.sections)) return;

      const granted = auth.sections.filter(
        (s) => s && typeof s.slug === 'string' && SLUG_RE.test(s.slug) && s.repoUrl
      );

      for (const s of granted) {
        try {
          addExclude(s.slug);          // invisible to the shared repo FIRST
          known.add(s.slug);
          if (ensureCloned(s.slug, s.repoUrl, auth.token)) syncOne(s.slug, auth.token);
        } catch (e) {
          say(`section ${s.slug}: sync error — ${e.message}`);
        }
      }

      // A successful answer that no longer lists a mount = revoked.
      const grantedSlugs = new Set(granted.map((s) => s.slug));
      for (const slug of [...known]) {
        if (!grantedSlugs.has(slug)) removeMount(slug);
      }

      writeManifest();
    } finally {
      ticking = false;
    }
  }

  return { tick, ownsPath };
}

module.exports = { create };
