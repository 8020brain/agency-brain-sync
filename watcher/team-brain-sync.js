#!/usr/bin/env node
// Brain Sync watcher.
// Watches a git folder and keeps it in sync with origin.
// Pulls every 60s. Commits and pushes 90s after the last local change.
//
// Conflict handling: recover-don't-stop, but NEVER lose data.
//   The 2026-04-24 data-loss incident taught us the rule: never rebase, never
//   reset --hard, never stash the working tree. The old watcher honoured that
//   by STOPping on every ambiguity — which is safe but leaves a non-technical
//   user staring at a red icon and a git word they don't understand. So the
//   watcher now auto-recovers from the two states real users actually hit
//   (local changes + remote moved, and diverged) using a plain MERGE that
//   keeps BOTH sides:
//     - clean merge            -> commit + push, invisible to the user.
//     - overlapping edit       -> keep OUR file as-is, write THEIR version to a
//                                 sidecar (foo__from-remote-<ts>.md), commit both.
//                                 Nothing is ever overwritten or discarded.
//   Before every merge it writes a backup ref (refs/backups/pre-merge-<ts>) so
//   the pre-merge HEAD is always recoverable. It still STOPs only on things a
//   human genuinely must handle (offline/fetch failure, a push the server
//   rejects, or a stray rebase/cherry-pick the user started by hand).
//
// Isolate-and-continue (not stop-the-world):
//   A single problem file no longer freezes ALL syncing. Instead it's HELD —
//   left in the working tree, excluded from this commit — while everything else
//   keeps flowing, and the held file is reported (state.held[]) for the tray.
//     - oversized (>= MAX_FILE_MB) -> added to .git/info/exclude (local-only,
//       never touches the synced .gitignore) and held.
//     - role violation (Team member touching a protected path) -> that path is
//       held; the member's allowed changes still commit and push.
//
// Large-file context: GitHub warns at 50 MB and hard-rejects any single file
// over 100 MB, so an un-held big file would wedge every push forever and bloat
// every teammate's clone. Holding it locally keeps the sync alive.
//
// Two modes, selected by BRAIN_SYNC_MODE env var:
//
//   personal   — uses the user's existing system git credentials, the same
//                way Brain Sync v0.2 worked. No API calls.
//
//   agency     — mints fresh GitHub App installation tokens from
//                api.ads2ai.com on each network git operation. Embeds the
//                token in the remote URL temporarily, then restores the
//                clean URL. Token never persists between operations.
//                Also reads .team-config/roles.json from the working tree
//                and HOLDS (does not push) paths outside the local member's
//                role allow-list.

const chokidar = require('chokidar');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = process.env.BRAIN_PATH;
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '90000', 10);
const PULL_INTERVAL_MS = parseInt(process.env.PULL_INTERVAL_MS || '60000', 10);
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50', 10);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const KEEP_BACKUPS = parseInt(process.env.KEEP_BACKUPS || '30', 10);
const MODE = process.env.BRAIN_SYNC_MODE || 'personal';
const API_BASE = process.env.AGENCY_API_BASE || 'https://api.ads2ai.com';
const MEMBER_TOKEN = process.env.AGENCY_MEMBER_TOKEN || '';
const TEAM_SLUG = process.env.AGENCY_TEAM_SLUG || '';
const MEMBER_EMAIL = (process.env.AGENCY_MEMBER_EMAIL || '').toLowerCase();
const MEMBER_ROLE_HINT = process.env.AGENCY_MEMBER_ROLE || 'team';
const STATE_FILE = process.env.STATE_FILE || '';

if (!REPO) {
  console.error('ERROR: set BRAIN_PATH to the absolute path of the brain folder.');
  process.exit(1);
}
if (!fs.existsSync(path.join(REPO, '.git'))) {
  console.error(`ERROR: ${REPO} is not a git repository.`);
  process.exit(1);
}
if (MODE === 'agency' && (!MEMBER_TOKEN || !TEAM_SLUG)) {
  console.error('ERROR: agency mode requires AGENCY_MEMBER_TOKEN + AGENCY_TEAM_SLUG.');
  process.exit(1);
}

let pendingTimer = null;
let syncing = false;
let tokenCache = null; // { token, expiresAt: Date }

function ts() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Compact timestamp for ref names and sidecar filenames: 20260529-143052.
function tsCompact() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
}

function git(cmd) {
  try {
    return execSync(`git -C "${REPO}" ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString().trim();
    console.error(`  git ${cmd} -> ${msg}`);
    return null;
  }
}

// Read-only probe that never logs. Some reads (an unset config key) exit
// non-zero by design; we don't want those surfacing as errors in the log.
function gitProbe(cmd) {
  try {
    return execSync(`git -C "${REPO}" ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Run a git command that is EXPECTED to sometimes exit non-zero (a conflicting
// merge, a missing merge stage). Returns { ok, out } and never logs — the
// caller decides what a non-zero exit means.
function gitTry(cmd) {
  try {
    const out = execSync(`git -C "${REPO}" ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: (err.stdout || '').toString().trim(), err: (err.stderr || err.message || '').toString().trim() };
  }
}

// ───── Observable state for the tray ─────

// Written atomically when state changes so main.js can poll/watch the file
// and update the tray icon (green/orange/red). `extra` carries optional
// fields the tray reads but the icon ignores — notably held: [{file, why}]
// for files parked locally while the rest of the brain keeps syncing.
function writeState(state, reason, extra) {
  if (!STATE_FILE) return;
  const payload = {
    state, // 'running' | 'pulling' | 'pushing' | 'stop'
    reason: reason || null,
    updatedAt: new Date().toISOString(),
    mode: MODE,
  };
  if (extra && typeof extra === 'object') Object.assign(payload, extra);
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, STATE_FILE);
  } catch (_) { /* best-effort */ }
}

// Held files keep the tray GREEN (still syncing) but surface a review line.
// An empty list clears it.
function reportRunning(held) {
  if (held && held.length) {
    writeState('running', `${held.length} file(s) held — review`, { held });
  } else {
    writeState('running', null, { held: [] });
  }
}

// ───── Agency-mode auth ─────

async function mintGitToken() {
  const r = await fetch(`${API_BASE}/api/team-brain/git-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MEMBER_TOKEN}`,
    },
    body: JSON.stringify({ teamSlug: TEAM_SLUG }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`git-token mint HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const json = await r.json();
  return { token: json.token, expiresAt: new Date(json.expiresAt) };
}

// Tell the server this member just pushed content they authored. Distinct from
// the git-token heartbeat (which fires on every pull and only proves the app is
// running): this is the honest "actually contributing" signal. Best-effort and
// non-blocking — if it fails the heartbeat still covers connection status.
async function reportContribution() {
  if (MODE !== 'agency') return;
  try {
    await fetch(`${API_BASE}/api/team-brain/contributed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEMBER_TOKEN}` },
      body: JSON.stringify({ teamSlug: TEAM_SLUG }),
    });
  } catch (_) { /* best-effort */ }
}

async function getGitToken() {
  const cushion = 10 * 60 * 1000;
  if (!tokenCache || tokenCache.expiresAt.getTime() - Date.now() < cushion) {
    tokenCache = await mintGitToken();
    console.log(`[${ts()}] minted git token (expires ${tokenCache.expiresAt.toISOString()})`);
  }
  return tokenCache.token;
}

async function withAuthenticatedRemote(fn) {
  if (MODE !== 'agency') return fn();
  const token = await getGitToken();
  const original = git('remote get-url origin');
  if (!original) throw new Error('no origin remote configured');
  const authed = original.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  git(`remote set-url origin "${authed}"`);
  try {
    return await fn();
  } finally {
    git(`remote set-url origin "${original}"`);
  }
}

// ───── Role-based path filter ─────

// Write rules by role (a DENY model, so new folders Just Work):
//   Owners + Scouts — NO filter. They write anywhere: root CLAUDE.md, .claude/,
//     and brand-new top-level folders that then sync to the whole team. Scouts
//     are the builders and need the run of the brain.
//   Team — may write into ANY content folder, including folders a scout creates
//     later (an allow-list would lock them out of those), but NOT root-level files
//     and NOT root dotpaths (.claude/, .team-config/, .github/, .gitignore, …).
//     That keeps skills, role definitions, CI and root config owner/scout-only.

function loadRolesMap() {
  const p = path.join(REPO, '.team-config', 'roles.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`  roles.json parse error: ${err.message}`);
    return null;
  }
}

function currentRole() {
  if (MODE !== 'agency') return null;
  const map = loadRolesMap();
  if (!map || !Array.isArray(map.members)) return MEMBER_ROLE_HINT;
  const me = map.members.find((m) => (m.email || '').toLowerCase() === MEMBER_EMAIL);
  return me?.role || MEMBER_ROLE_HINT;
}

// True when this role must NOT push relPath. Owners + scouts: never. Team: blocked
// from root-level files (no "/") and root dotpaths (".claude/", ".team-config/",
// ".github/", ".gitignore", …); any other path — every content folder, new ones
// included — is allowed.
function pathBlockedForRole(relPath, role) {
  const norm = (role || '').toLowerCase().replace(/_/g, '-');
  if (norm === 'owner' || norm === 'head-scout' || norm === 'scout') return false;
  return relPath.startsWith('.') || !relPath.includes('/');
}

// ───── Large-file guard ─────

// GitHub hard-rejects any single file over 100 MB, so an un-held big file would
// make every push fail forever (the commit is already local), and a sub-100 MB
// binary pushes fine then bloats every teammate's clone for good. So size each
// to-be-staged file and HOLD anything at/over the limit (see stageAndCommit).
function oversizedFiles(files) {
  const hits = [];
  for (const rel of files) {
    try {
      const sz = fs.statSync(path.join(REPO, rel)).size;
      if (sz >= MAX_FILE_BYTES) hits.push({ rel, mb: sz / (1024 * 1024) });
    } catch (_) { /* deletion or rename-from: nothing on disk to size */ }
  }
  return hits;
}

// Park a path in the repo's LOCAL exclude (.git/info/exclude) so it stops
// showing up as a pending change every tick. This file is per-clone and is
// never committed or synced, unlike .gitignore — so holding a member's big
// local file never mutates the shared brain.
function addToLocalExclude(rel) {
  const p = path.join(REPO, '.git', 'info', 'exclude');
  let cur = '';
  try { cur = fs.readFileSync(p, 'utf8'); } catch (_) { /* file may not exist yet */ }
  const line = `/${rel}`;
  if (cur.split('\n').includes(line)) return;
  const sep = cur.length && !cur.endsWith('\n') ? '\n' : '';
  try { fs.appendFileSync(p, `${sep}${line}\n`); } catch (_) { /* best-effort */ }
}

// ───── Backup refs (recoverability) ─────

// Snapshot HEAD before any merge so the pre-merge state is always recoverable
// (git update-ref is instant and free). Old backups are pruned to KEEP_BACKUPS.
function backupRef(tag) {
  const name = `refs/backups/${tag}-${tsCompact()}`;
  git(`update-ref ${name} HEAD`);
  const out = gitProbe('for-each-ref --sort=-creatordate --format=%(refname) refs/backups/');
  const refs = out.split('\n').filter(Boolean);
  for (const stale of refs.slice(KEEP_BACKUPS)) git(`update-ref -d ${stale}`);
  return name;
}

// ───── Mid-operation guard ─────

function midOperation() {
  const gitDir = path.join(REPO, '.git');
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (fs.existsSync(path.join(gitDir, 'rebase-merge'))) return 'rebase';
  if (fs.existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebase';
  if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  return null;
}

// ───── Conflict resolution: keep both sides ─────

// Build a sidecar name next to the original: report.md -> report__from-remote-<ts>.md
function sidecarName(rel, stamp) {
  const dir = path.dirname(rel);
  const base = path.basename(rel);
  const dot = base.lastIndexOf('.');
  const tag = `__from-remote-${stamp}`;
  const renamed = dot > 0 ? base.slice(0, dot) + tag + base.slice(dot) : base + tag;
  return dir === '.' ? renamed : path.join(dir, renamed);
}

// Resolve an in-progress conflicted merge WITHOUT losing data: for each
// unmerged path, keep OUR version as the live file and write THEIR version to a
// sidecar, then commit. Returns the list of conflicts (each {file, sidecar}).
function resolveConflictsAndCommit(stamp) {
  const unmerged = gitProbe('diff --name-only --diff-filter=U').split('\n').filter(Boolean);
  const conflicts = [];
  for (const f of unmerged) {
    const theirs = gitTry(`show ":3:${f}"`); // stage 3 = remote/their side
    try {
      if (theirs.ok) {
        const sc = sidecarName(f, stamp);
        const scAbs = path.join(REPO, sc);
        fs.mkdirSync(path.dirname(scAbs), { recursive: true });
        fs.writeFileSync(scAbs, theirs.out.endsWith('\n') ? theirs.out : `${theirs.out}\n`);
        git(`add -- "${sc}"`);
        conflicts.push({ file: f, sidecar: sc });
      }
      // Keep our clean version as the live file. If ours doesn't exist for this
      // path (e.g. deleted-by-us / modified-by-them), fall back to theirs so the
      // file isn't lost — the sidecar already preserved the other side either way.
      const ours = git(`checkout --ours -- "${f}"`);
      if (ours === null) git(`checkout --theirs -- "${f}"`);
      git(`add -- "${f}"`);
    } catch (_) {
      git(`add -- "${f}"`); // last resort: whatever's on disk, so the merge can finish
    }
  }
  // Stage everything the merge auto-resolved too, then commit the merge.
  git('add -A');
  let r = git('commit --no-edit');
  if (r === null) r = git(`commit -m "auto-sync merge ${ts()} (kept both sides where edits overlapped)"`);
  return conflicts;
}

// Pull remote changes via a plain MERGE (never rebase/reset). Snapshots a
// backup ref first. Returns { merged, conflicts, error }.
function mergeWithSidecars(branch) {
  backupRef('pre-merge');
  const stamp = tsCompact();
  const m = gitTry(`merge --no-edit origin/${branch}`);
  if (m.ok && midOperation() !== 'merge') {
    return { merged: true, conflicts: [] }; // clean merge
  }
  if (midOperation() !== 'merge') {
    // Merge refused without entering a merge (shouldn't happen — we commit
    // local work first — but never leave a half state). Report for a human.
    return { merged: false, conflicts: [], error: m.err || 'merge refused' };
  }
  const conflicts = resolveConflictsAndCommit(stamp);
  return { merged: true, conflicts };
}

// ───── Commit lane (isolate-and-continue) ─────

// Stage and commit local work. Files the member's role can't push, or that are
// oversized, are HELD (left uncommitted, reported) rather than freezing the
// whole sync. Returns { committed, held: [{file, why}], error }.
function stageAndCommit(s) {
  // s.statusLines come from porcelain output. Parse the files to consider.
  // Format: "XY filename" (2 status cols + 1 space, then path); rename: "XY old -> new".
  // git() .trim()s the whole status blob, which strips the leading space off the
  // FIRST line when its index column is blank (" M path" -> "M path"). A fixed
  // slice(3) then eats the first path char ("context/..." -> "ontext/..."), which
  // also mis-classifies an allowed personal file as a protected violation. Strip
  // the status field (1-2 cols, tolerating that trim) plus its single space instead.
  const files = (s.statusLines || []).map((line) =>
    line.replace(/^[ MADRCU!?]{1,2} /, '').split(' -> ').pop()
  );
  if (!files.length) return { committed: false, held: [] };

  git('add -A');
  const held = [];

  if (MODE === 'agency') {
    const role = currentRole();
    for (const f of files) {
      if (pathBlockedForRole(f, role)) {
        git(`reset -q HEAD -- "${f}"`);
        held.push({ file: f, why: `needs an owner or scout to push (you're ${role})` });
      }
    }
  }

  // Hold oversized files among what's still staged: park in local exclude so
  // they stop reappearing, and leave them on disk untouched.
  const stagedNow = gitProbe('diff --cached --name-only').split('\n').filter(Boolean);
  for (const hit of oversizedFiles(stagedNow)) {
    git(`reset -q HEAD -- "${hit.rel}"`);
    addToLocalExclude(hit.rel);
    held.push({ file: hit.rel, why: `${Math.round(hit.mb)} MB — too big to sync, kept on this machine only` });
  }

  for (const h of held) console.log(`[${ts()}]   held: ${h.file} — ${h.why}`);

  const staged = gitProbe('diff --cached --name-only').split('\n').filter(Boolean);
  if (!staged.length) {
    return { committed: false, held }; // everything was held
  }

  const commitMsg = `auto-sync: ${ts()}`;
  let commitResult = git(`commit -m "${commitMsg}"`);
  if (commitResult === null) {
    // Most common cause: this clone has no git author identity, so its very
    // first commit fails. Self-heal the identity and retry once.
    ensureGitIdentity();
    commitResult = git(`commit -m "${commitMsg}"`);
  }
  if (commitResult === null) {
    git('reset -q HEAD');
    return { committed: false, held, error: 'commit failed' };
  }
  console.log(`[${ts()}]   committed ${staged.length} file(s)${held.length ? `, held ${held.length}` : ''}`);
  return { committed: true, held };
}

// ───── Repo state classifier ─────

async function classifyState() {
  let fetchResult;
  try {
    fetchResult = await withAuthenticatedRemote(() => git('fetch --quiet origin'));
  } catch (err) {
    return { state: 'fetch_failed', detail: err.message };
  }
  if (fetchResult === null) return { state: 'fetch_failed', detail: 'see git error above' };

  const status = git('status --porcelain');
  if (status === null) return { state: 'unknown' };
  const dirty = status.length > 0;
  const statusLines = status.split('\n').filter(Boolean);

  const branch = git('rev-parse --abbrev-ref HEAD');
  if (!branch) return { state: 'unknown' };

  const localSha = git(`rev-parse ${branch}`);
  const remoteSha = git(`rev-parse origin/${branch}`);
  if (!localSha || !remoteSha) return { state: 'unknown', branch };

  if (localSha === remoteSha) {
    return dirty
      ? { state: 'dirty_in_sync', branch, statusLines }
      : { state: 'clean_in_sync', branch };
  }

  const ab = git(`rev-list --left-right --count ${branch}...origin/${branch}`);
  if (!ab) return { state: 'unknown', branch };
  const [ahead, behind] = ab.split(/\s+/).map(Number);

  if (ahead === 0 && behind > 0) {
    return dirty
      ? { state: 'dirty_remote_ahead', branch, behind, statusLines }
      : { state: 'clean_remote_ahead', branch, behind };
  }
  if (ahead > 0 && behind === 0) {
    return { state: 'local_ahead', branch, ahead, dirty, statusLines };
  }
  if (ahead > 0 && behind > 0) {
    return { state: 'diverged', branch, ahead, behind, dirty, statusLines };
  }
  return { state: 'unknown', branch };
}

// ───── Main sync function ─────

async function doSync(trigger) {
  if (syncing) return;
  syncing = true;
  try {
    // 0. Finish any merge we left mid-flight (e.g. crash during a previous
    //    auto-merge). Resolving keeps both sides, so it's safe to complete
    //    rather than STOP. A stray rebase/cherry-pick is the user's own manual
    //    operation — we never start those, so leave it for them.
    const mid = midOperation();
    if (mid === 'merge') {
      console.log(`[${ts()}] completing interrupted merge`);
      resolveConflictsAndCommit(tsCompact());
    } else if (mid) {
      console.log(`[${ts()}] STOP: mid-${mid} in progress (started by hand); finish it and sync resumes`);
      writeState('stop', `a ${mid} is in progress — finish it in a terminal and sync resumes`);
      return;
    }

    writeState('pulling');
    const s = await classifyState();

    if (s.state === 'fetch_failed') {
      console.log(`[${ts()}] ${trigger}: fetch failed -- ${s.detail}`);
      writeState('stop', 'offline or fetch failed — will retry');
      return;
    }
    if (s.state === 'clean_in_sync') {
      if (trigger !== 'interval') console.log(`[${ts()}] ${trigger}: clean, in sync`);
      reportRunning([]);
      return;
    }
    if (s.state === 'clean_remote_ahead') {
      console.log(`[${ts()}] ${trigger}: remote ahead by ${s.behind}; fast-forwarding`);
      const r = git(`merge --ff-only origin/${s.branch}`);
      if (r === null) {
        // Shouldn't happen (no local commits), but if it does, a real merge
        // handles it without losing anything.
        const res = mergeWithSidecars(s.branch);
        if (!res.merged) { writeState('stop', res.error || 'fast-forward failed'); return; }
        reportRunning(res.conflicts.map((c) => ({ file: c.file, why: `overlapping edit — kept both, see ${path.basename(c.sidecar)}` })));
      } else {
        console.log(`[${ts()}]   fast-forwarded`);
        reportRunning([]);
      }
      return;
    }
    if (s.state === 'unknown') {
      console.log(`[${ts()}] ${trigger}: unrecognised git state; skipping this tick`);
      writeState('stop', 'unrecognised git state');
      return;
    }

    const behind = s.state === 'dirty_remote_ahead' || s.state === 'diverged';

    // Debounce owns pushes for purely-local changes. The interval only acts as a
    // safety net when no debounce is pending — but if we're BEHIND, act now so
    // remote work lands promptly.
    if (trigger === 'interval' && pendingTimer !== null && !behind) {
      syncing = false;
      return;
    }

    // 1. Commit local work first (isolate-and-continue). This collapses
    //    dirty_remote_ahead into a clean "behind" merge and removes the old
    //    "local changes AND remote moved" dead-end entirely.
    let held = [];
    let didContribute = false; // committed content THIS member authored this cycle
    const hasLocalEdits = s.state === 'dirty_in_sync' || s.state === 'dirty_remote_ahead' || (s.state === 'diverged' && s.dirty);
    if (hasLocalEdits) {
      const r = stageAndCommit(s);
      held = r.held || [];
      didContribute = r.committed === true;
      if (r.error) {
        console.log(`[${ts()}]   ${r.error}`);
        writeState('stop', r.error);
        return;
      }
    }

    // 2. Merge remote in if we're behind (auto, keeps both sides, backup ref).
    if (behind) {
      writeState('pulling');
      console.log(`[${ts()}] ${trigger}: remote moved (behind ${s.behind}); merging`);
      const res = mergeWithSidecars(s.branch);
      if (!res.merged) {
        writeState('stop', res.error || 'merge failed');
        return;
      }
      if (res.conflicts.length) {
        console.log(`[${ts()}]   merged with ${res.conflicts.length} overlapping file(s); kept both sides`);
        held = held.concat(res.conflicts.map((c) => ({ file: c.file, why: `overlapping edit — kept both, see ${path.basename(c.sidecar)}` })));
      } else {
        console.log(`[${ts()}]   merged cleanly`);
      }
    }

    // 3. Push (skip the network round-trip when there's genuinely nothing new).
    const ahead = git(`rev-list --count origin/${s.branch}..${s.branch}`);
    if (ahead === '0' || ahead === null) {
      reportRunning(held);
      return;
    }
    writeState('pushing');
    const pushResult = await withAuthenticatedRemote(() => git('push'));
    if (pushResult === null) {
      // Most often a race: someone pushed between our fetch and our push. Next
      // tick re-classifies as behind and auto-merges, so this self-heals.
      console.log(`[${ts()}]   push failed; will retry next tick`);
      writeState('stop', 'push failed — will retry');
      return;
    }
    console.log(`[${ts()}]   pushed.`);
    if (didContribute) reportContribution().catch(() => {});
    reportRunning(held);
  } catch (err) {
    console.error(`[${ts()}] sync error: ${err.message}`);
    writeState('stop', `error: ${err.message}`);
  } finally {
    syncing = false;
  }
}

function scheduleDebouncedSync() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    doSync('debounce').catch(() => {});
  }, DEBOUNCE_MS);
}

// ───── Git identity self-heal ─────

// Without a git author identity, `git commit` fails ("Author identity unknown")
// and the watcher loops on "commit failed" forever — token auth and pull both
// work, but nothing ever pushes, and the only sign is a log line no member
// reads. The wizard sets identity once at clone time (main.js configure-identity),
// so a repo cloned before that step existed, or where it didn't take, stays
// silently broken. Self-heal on every boot: if the repo has no user.email, set
// it from the member identity. (2026-05-25: the agtest Windows clone hit exactly
// this — onboarded before the identity step, every push blocked on commit.)
function ensureGitIdentity() {
  if (gitProbe('config user.email')) return; // already has an identity
  if (!MEMBER_EMAIL) {
    console.error(`[${ts()}] WARNING: no git identity and no member email to set one — commits will fail until 'git config user.email' is set`);
    return;
  }
  let name = MEMBER_EMAIL;
  const map = loadRolesMap();
  const me = map && Array.isArray(map.members)
    ? map.members.find((m) => (m.email || '').toLowerCase() === MEMBER_EMAIL)
    : null;
  if (me && me.name) name = me.name;
  git(`config user.email "${MEMBER_EMAIL}"`);
  git(`config user.name "${name}"`);
  console.log(`[${ts()}] set git identity: ${name} <${MEMBER_EMAIL}> (was unset)`);
}

// ───── Boot ─────

console.log(`[${ts()}] watching ${REPO}`);
console.log(`[${ts()}] mode=${MODE} debounce=${DEBOUNCE_MS / 1000}s pull-every=${PULL_INTERVAL_MS / 1000}s max-file=${MAX_FILE_MB}MB`);
if (MODE === 'agency') {
  console.log(`[${ts()}] team=${TEAM_SLUG} member=${MEMBER_EMAIL} role-hint=${MEMBER_ROLE_HINT}`);
}
if (STATE_FILE) console.log(`[${ts()}] state file: ${STATE_FILE}`);
ensureGitIdentity();
writeState('running', 'starting up');

chokidar.watch(REPO, {
  ignored: (p) => /(^|[\/\\])(\.git|node_modules|\.DS_Store|\.swp|~$)/.test(p),
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
}).on('all', (event, filepath) => {
  console.log(`[${ts()}]   ${event}: ${path.relative(REPO, filepath)}`);
  scheduleDebouncedSync();
});

setInterval(() => doSync('interval').catch(() => {}), PULL_INTERVAL_MS);
doSync('startup').catch(() => {});

process.on('SIGINT', () => { console.log(`\n[${ts()}] stopped.`); writeState('stop', 'sigint'); process.exit(0); });
process.on('SIGTERM', () => { console.log(`\n[${ts()}] stopped.`); writeState('stop', 'sigterm'); process.exit(0); });
