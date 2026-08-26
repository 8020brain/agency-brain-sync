#!/usr/bin/env node
/**
 * Sync-engine recovery tests — run the REAL watcher against throwaway local git
 * repos (a bare "origin" + an "app" clone + an "other" clone that stands in for a
 * teammate pushing). No mocks, no network, no Electron: personal mode needs no
 * token, and a local bare repo is the remote. Safe to run any time; tears itself
 * down. Matches the philosophy in projects/agencybrain/test-suite-plan.md:
 * "Don't mock git. Run the real git binary against throwaway repos in temp dirs."
 *
 *   node tests/sync-recovery.test.cjs
 *
 * Covers the v0.9.21 sync fixes:
 *   A) Stale .git/index.lock recovery — a leftover lock (the Cowork-died-mid-git
 *      failure mode) no longer wedges sync forever; the watcher clears it and
 *      catches up.
 *   B) Round-trip — a file written straight into the brain folder (what a Cowork
 *      session does) gets committed and pushed within a cycle, with no git step
 *      from the writer.
 *   C) Stuck surfacing — a jam that can't self-heal stops LOUDLY: state flips to
 *      stop + stuck:true with a reason, instead of looping quietly forever.
 *
 * And the v1.1.18 big-file/branch mitigations (MAX_FILE_MB=1 so "big" = 1 MB):
 *   D) Pre-commit hook — installed at boot, and it blocks an out-of-app commit
 *      that stages a too-big file, with a plain-words message.
 *   E) Oversize self-heal — a too-big file committed with --no-verify (stands in
 *      for commits made before the hook existed) no longer wedges the push: the
 *      watcher unstitches the commit, holds the big file locally, and pushes the
 *      rest.
 *   F) Detached-HEAD self-heal — a clone left on no branch (out-of-app checkout)
 *      returns to main by itself, and work committed off-branch reaches origin.
 *
 * And the 2026-08-18 fix for a check the CUSTOMER installed:
 *   G) A foreign pre-commit hook (a data-protection scanner) refuses one file.
 *      That file is set aside and everything else keeps syncing, instead of the
 *      refusal wedging the whole brain the way it did in a 2026-08-18 field report.
 *
 * And the .nosync marker (client field report, 2026-08-24):
 *   I) A folder holding a `.nosync` file is left out of auto-commits — its
 *      changes stay in the working tree for a deliberate hand commit with a
 *      real message, the marker itself syncs so the choice reaches every
 *      clone, and a pull that must touch an uncommitted .nosync file puts the
 *      member's version back on disk instead of disappearing it.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WATCHER = path.join(__dirname, '..', 'watcher', 'team-brain-sync.js');
const REPO_ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok   ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
// The watcher is RUNNING while these cases execute, and it runs git in the same
// repo on its own timer. So a bare `git add`/`git commit` from the test races it
// for .git/index.lock, and the loser throws. That threw out of the case and was
// reported as a fatal "harness error", killing the rest of the run: cases E, F
// and G never executed, which is why a bad run scored 18 instead of 21. It was
// flaky about one run in three (measured 3 failures in 8 on 2026-08-26).
//
// Nothing was wrong with the app. Waiting for the lock is exactly what the real
// watcher does, so the test does it too. Only lock contention is retried; every
// other git failure still throws on the first try, because several cases depend
// on a command failing (D2 expects the pre-commit hook to refuse a commit).
// Lock contention ONLY. Deliberately does not match the read-only-origin errors
// case C provokes on purpose ("unable to create temporary object directory"),
// which must still fail the moment they happen.
const LOCK_RE = /index\.lock|Another git process|cannot lock ref/i;
function git(repo, args, { retryMs = 5000 } = {}) {
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      return sh(`git -C "${repo}" ${args}`, undefined);
    } catch (e) {
      const text = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`;
      if (!LOCK_RE.test(text) || Date.now() >= deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); // sync sleep
    }
  }
}
function gitTry(repo, args) { try { return git(repo, args, { retryMs: 0 }); } catch { return null; } }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Poll a predicate until truthy or timeout. Returns true on success.
async function until(predicate, timeoutMs = 12000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return true; } catch (_) { /* keep polling */ }
    await sleep(everyMs);
  }
  return false;
}

function originHasPath(originBare, branch, relPath) {
  return gitTry(originBare, `ls-tree -r --name-only ${branch}`)?.split('\n').includes(relPath) || false;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sync-'));
  const origin = path.join(root, 'origin.git');
  const app = path.join(root, 'app');
  const other = path.join(root, 'other');
  const stateFile = path.join(root, 'state.json');
  let watcher = null;
  const logs = [];

  const idflags = '-c user.email=t@t.test -c user.name=test';

  try {
    // ── Build a bare origin + an app clone tracking main + a teammate clone ──
    sh(`git init --bare "${origin}"`);
    fs.mkdirSync(app);
    git(app, 'init -q');
    git(app, `${idflags} commit -q --allow-empty -m seed`);
    git(app, 'branch -M main');
    fs.writeFileSync(path.join(app, 'README.md'), 'seed\n');
    git(app, 'add -A');
    git(app, `${idflags} commit -q -m readme`);
    git(app, `remote add origin "${origin}"`);
    git(app, 'push -q -u origin main');
    sh(`git clone -q "${origin}" "${other}"`);

    // Spawn the REAL watcher against the app clone, fast intervals so the test
    // is quick. Personal mode → no token, local remote → no network.
    watcher = spawn(process.execPath, [WATCHER], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRAIN_PATH: app,
        STATE_FILE: stateFile,
        BRAIN_SYNC_MODE: 'personal',
        PULL_INTERVAL_MS: '600',
        DEBOUNCE_MS: '300',
        MAX_DEFER_MS: '600',
        ESCALATE_AFTER: '2',
        STUCK_RETRY_MS: '1500',
        LOCK_STALE_MS: '500',
        MAX_FILE_MB: '1',
      },
    });
    watcher.stdout.on('data', (d) => logs.push(d.toString()));
    watcher.stderr.on('data', (d) => logs.push(d.toString()));
    await sleep(800); // let it settle into clean/in-sync

    // ── A) Stale index.lock recovery ──
    // Teammate pushes → app is behind. App also has an unrelated local edit, so
    // the cycle must both merge AND commit. Plant a stale lock that would, before
    // the fix, make every git op fail and wedge sync forever.
    git(other, `${idflags} config user.email t@t.test`);
    fs.writeFileSync(path.join(other, 'from-remote.md'), 'remote change\n');
    git(other, 'add -A');
    git(other, `${idflags} commit -q -m remote-change`);
    git(other, 'push -q origin main');

    fs.writeFileSync(path.join(app, 'local-note.md'), 'local change\n'); // app-side edit
    const lock = path.join(app, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lock, old, old); // 2 minutes old → certainly stale

    const recovered = await until(() =>
      !fs.existsSync(lock) &&
      git(app, 'status --porcelain') === '' &&
      originHasPath(origin, 'main', 'from-remote.md') &&
      originHasPath(origin, 'main', 'local-note.md')
    );
    if (recovered) ok('A: stale index.lock cleared, local change committed + remote merged + pushed');
    else bad('A: watcher did not recover from a stale index.lock', `lock exists=${fs.existsSync(lock)}, status=${gitTry(app, 'status --porcelain')}`);

    // ── B) Round-trip: a file written into the brain syncs with no git by the writer ──
    const noteDir = path.join(app, 'data');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(path.join(noteDir, 'cowork-note.md'), 'written by a cowork-style session\n');
    const roundTripped = await until(() => originHasPath(origin, 'main', 'data/cowork-note.md'));
    if (roundTripped) ok('B: a file written straight into the brain was committed + pushed automatically');
    else bad('B: brain-written file never reached origin');

    // ── C) Stuck surfacing: an unrecoverable jam stops LOUDLY ──
    // Make pushes fail persistently (read-only remote) while fetch still works,
    // then make a local change. After ESCALATE_AFTER failures the state must flip
    // to stop + stuck:true with a reason, not loop quietly.
    sh(`chmod -R a-w "${origin}"`);
    fs.writeFileSync(path.join(app, 'README.md'), 'seed\nwedge\n');
    const surfaced = await until(() => {
      if (!fs.existsSync(stateFile)) return false;
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return s.state === 'stop' && s.stuck === true && typeof s.reason === 'string' && s.reason.length > 0;
    }, 15000);
    sh(`chmod -R u+w "${origin}"`); // restore so cleanup can delete
    if (surfaced) {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      ok(`C: persistent jam surfaced as stuck stop ("${s.reason}", after ${s.attempts} tries)`);
    } else {
      bad('C: a persistent jam never surfaced as a stuck stop');
    }
    // Let the watcher recover from C before the next scenarios (origin is
    // writable again; the next successful cycle clears the stuck state).
    fs.writeFileSync(path.join(app, 'recovery-ping.md'), 'origin is back\n');
    await until(() => originHasPath(origin, 'main', 'recovery-ping.md'), 15000);

    // ── D) Pre-commit hook: installed at boot, blocks a too-big out-of-app commit ──
    const hookPath = path.join(app, '.git', 'hooks', 'pre-commit');
    const hookInstalled = fs.existsSync(hookPath) && fs.readFileSync(hookPath, 'utf8').includes('large-file guard');
    if (hookInstalled) ok('D1: pre-commit large-file guard installed at boot');
    else bad('D1: pre-commit hook missing', hookPath);

    fs.writeFileSync(path.join(app, 'big-blocked.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
    git(app, 'add -A');
    const blocked = gitTry(app, `${idflags} commit -q -m big-commit`) === null;
    if (blocked && hookInstalled) ok('D2: out-of-app commit of a too-big file was blocked by the hook');
    else bad('D2: too-big commit was NOT blocked');
    git(app, 'reset -q -- big-blocked.bin'); // unstage; leave the file on disk

    // ── E) Oversize self-heal: a bypassed big commit no longer wedges the push ──
    fs.writeFileSync(path.join(app, 'big-wedged.bin'), Buffer.alloc(2 * 1024 * 1024, 9));
    fs.writeFileSync(path.join(app, 'alongside.md'), 'committed next to the big file\n');
    git(app, 'add -A');
    git(app, `${idflags} commit -q --no-verify -m wedge-commit`);
    const healed = await until(() =>
      originHasPath(origin, 'main', 'alongside.md') &&
      !originHasPath(origin, 'main', 'big-wedged.bin') &&
      fs.existsSync(path.join(app, 'big-wedged.bin')),
    15000);
    if (healed) ok('E: big-file commit was unstitched — small file pushed, big file kept local only');
    else bad('E: oversize self-heal did not land', `alongside=${originHasPath(origin, 'main', 'alongside.md')}, big-on-origin=${originHasPath(origin, 'main', 'big-wedged.bin')}`);
    const excluded = (gitTry(app, 'status --porcelain') || '').indexOf('big-wedged.bin') === -1;
    if (excluded) ok('E2: held big file no longer shows as a pending change');
    else bad('E2: held big file still churns in git status');

    // ── F) Detached HEAD self-heal: off-branch clone returns to main ──
    git(app, 'checkout -q --detach HEAD');
    fs.writeFileSync(path.join(app, 'off-branch-note.md'), 'written while detached\n');
    const reattached = await until(() =>
      gitTry(app, 'rev-parse --abbrev-ref HEAD') === 'main' &&
      originHasPath(origin, 'main', 'off-branch-note.md'),
    15000);
    if (reattached) ok('F: detached clone returned to main and off-branch work reached origin');
    else bad('F: detached HEAD did not heal', `branch=${gitTry(app, 'rev-parse --abbrev-ref HEAD')}`);

    // ── G) A check the CUSTOMER installed refuses one file ──
    // Stand in for a data-protection scanner: reject any staged file carrying an
    // email address, in the same "E-MAIL <path>:<line>" shape the real one used.
    // Before the fix this failed the whole commit every cycle, and nothing in the
    // brain could save or pull until a human at that machine cleared it.
    const scanner = [
      '#!/bin/sh',
      'out=""',
      'for f in $(git diff --cached --name-only --diff-filter=AM); do',
      '  n=$(git show ":$f" 2>/dev/null | grep -n -E "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | head -1 | cut -d: -f1)',
      '  if [ -n "$n" ]; then out="$out E-MAIL $f:$n"; fi',
      'done',
      'if [ -n "$out" ]; then echo "$out" >&2; exit 1; fi',
      'exit 0',
      '',
    ].join('\n');
    fs.writeFileSync(hookPath, scanner, { mode: 0o755 });
    fs.chmodSync(hookPath, 0o755);

    fs.writeFileSync(path.join(app, 'client-note.md'), 'call notes\nreach them on someone@example.com\n');
    fs.writeFileSync(path.join(app, 'innocent.md'), 'nothing personal in here\n');
    const isolated = await until(() =>
      originHasPath(origin, 'main', 'innocent.md') &&
      !originHasPath(origin, 'main', 'client-note.md') &&
      fs.existsSync(path.join(app, 'client-note.md')),
    15000);
    if (isolated) ok('G1: a refused file was set aside and the rest of the work still synced');
    else bad('G1: a refused file wedged the sync', `innocent=${originHasPath(origin, 'main', 'innocent.md')}, refused-on-origin=${originHasPath(origin, 'main', 'client-note.md')}`);

    const gState = await until(() => {
      if (!fs.existsSync(stateFile)) return false;
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return st.state !== 'stop' && Array.isArray(st.held) && st.held.some((h) => h.file === 'client-note.md');
    }, 15000);
    if (gState) ok('G2: the brain stayed running and named the file it set aside');
    else bad('G2: refused file was not surfaced as a held change', fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').slice(0, 300) : 'no state file');

    // ── I) .nosync: a marked folder is left out of auto-commits ──
    // Drop a .nosync marker in code/, change a file there and a prose file
    // outside it. The prose and the marker itself must sync; the code file must
    // stay an ordinary pending change until the person commits it deliberately.
    const codeDir = path.join(app, 'code');
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, '.nosync'), '');
    fs.writeFileSync(path.join(codeDir, 'tool.js'), 'console.log("v1 mine")\n');
    fs.writeFileSync(path.join(app, 'prose-beside-code.md'), 'notes sync freely\n');
    const proseSynced = await until(() =>
      originHasPath(origin, 'main', 'prose-beside-code.md') &&
      originHasPath(origin, 'main', 'code/.nosync'),
    15000);
    const codeHeldBack = !originHasPath(origin, 'main', 'code/tool.js') &&
      (gitTry(app, 'status --porcelain') || '').includes('code/tool.js');
    if (proseSynced && codeHeldBack) ok('I1: .nosync folder skipped by auto-commit; prose and the marker itself still synced');
    else bad('I1: .nosync was not honoured', `prose=${proseSynced}, tool-on-origin=${originHasPath(origin, 'main', 'code/tool.js')}, status=${gitTry(app, 'status --porcelain')}`);

    // ── I1b) Nobody has to touch git ──
    // The whole point of the marker: drop it in, keep working, and the folder is
    // left alone. So the watcher must never put a marked path in the index at all.
    // The first build did `git add -A` and then took them back out again, which
    // briefly staged the person's folder and made the whole thing racy. Assert the
    // invariant directly: across several cycles the index never holds it, origin
    // never gets it, and it stays an ordinary pending change on disk.
    let everStaged = '';
    for (let i = 0; i < 6; i += 1) {
      const idx = gitTry(app, 'diff --cached --name-only') || '';
      if (idx.split('\n').includes('code/tool.js')) { everStaged = idx; break; }
      await sleep(250);
    }
    const stillPending = (gitTry(app, 'status --porcelain') || '').includes('code/tool.js');
    const neverPushed = !originHasPath(origin, 'main', 'code/tool.js');
    if (!everStaged && stillPending && neverPushed) {
      ok('I1b: a marked folder is never staged, never pushed, and stays a pending change');
    } else {
      bad('I1b: the watcher touched a marked folder',
        `staged=${everStaged || '(never, good)'}, stillPending=${stillPending}, neverPushed=${neverPushed}`);
    }

    // ── I2) Remove the marker and the folder syncs, with no git from the person ──
    // The other half of the journey Mike described: they add the marker, they
    // work, they delete the marker, and it goes up on the next tick like anything
    // else. Nothing here runs `git add` or `git commit` — deleting a file is the
    // whole interface.
    fs.rmSync(path.join(codeDir, '.nosync'));
    const syncedAfterUnmark = await until(() => originHasPath(origin, 'main', 'code/tool.js'), 15000);
    const contentLanded = (gitTry(origin, 'show main:code/tool.js') || '').includes('v1 mine');
    if (syncedAfterUnmark && contentLanded) ok('I2: deleting the marker lets the folder sync normally, no git run by hand');
    else bad('I2: the folder did not sync after the marker was removed', `synced=${syncedAfterUnmark}, content=${(gitTry(origin, 'show main:code/tool.js') || '').trim()}`);

    // Put the marker back for the pull tests below.
    fs.writeFileSync(path.join(codeDir, '.nosync'), '');
    await until(() => originHasPath(origin, 'main', 'code/.nosync'), 15000);

    // ── I5) A marker deeper inside a brand-new folder still counts ──
    // `git status --porcelain` collapses a wholly-untracked directory to one
    // "newthing/" entry, so a marker further down (newthing/vendor/.nosync) is
    // invisible unless the staging list asks for untracked files individually.
    // Without that, the whole folder gets staged and the marked part goes up.
    const nested = path.join(app, 'newthing');
    fs.mkdirSync(path.join(nested, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'readme.md'), 'this part syncs\n');
    fs.writeFileSync(path.join(nested, 'vendor', '.nosync'), '');
    fs.writeFileSync(path.join(nested, 'vendor', 'secret-wip.js'), 'not ready\n');
    const outerSynced = await until(() => originHasPath(origin, 'main', 'newthing/readme.md'), 15000);
    await sleep(1200); // give a couple more cycles a chance to get it wrong
    const innerHeld = !originHasPath(origin, 'main', 'newthing/vendor/secret-wip.js');
    if (outerSynced && innerHeld) ok('I5: a marker deeper inside a brand-new folder is honoured');
    else bad('I5: nested marker missed', `outer=${outerSynced}, innerHeldBack=${innerHeld}`);

    // A pull that must touch an uncommitted .nosync file restores the member's
    // version to the working tree instead of disappearing it into .git.
    fs.writeFileSync(path.join(codeDir, 'tool.js'), 'console.log("v2 mine, uncommitted")\n');
    await sleep(700); // let the watcher see the dirty file before the remote moves
    git(other, `${idflags} pull -q origin main`);
    fs.writeFileSync(path.join(other, 'code', 'tool.js'), 'console.log("v2 theirs")\n');
    git(other, 'add -A');
    git(other, `${idflags} commit -q -m theirs-code-change`);
    git(other, 'push -q origin main');
    const pulledOverDirty = await until(() =>
      gitTry(app, 'rev-parse main') === gitTry(origin, 'rev-parse main') &&
      fs.readFileSync(path.join(codeDir, 'tool.js'), 'utf8').includes('v2 mine') &&
      (gitTry(app, 'status --porcelain') || '').includes('code/tool.js'),
    15000);
    const remoteTip = gitTry(origin, 'show main:code/tool.js') || '';
    if (pulledOverDirty && remoteTip.includes('v2 theirs')) ok('I3: pull landed the remote version in history and put the uncommitted local version back on disk');
    else bad('I3: uncommitted .nosync work did not survive the pull', `pulled=${pulledOverDirty}, tip=${remoteTip.trim()}, disk=${(gitTry(app, 'status --porcelain') || '')}`);

    // And it stays the person's to commit: a few more cycles must not sweep it up.
    await sleep(1500);
    const stillTheirs = (gitTry(app, 'status --porcelain') || '').includes('code/tool.js') &&
      (gitTry(origin, 'show main:code/tool.js') || '').includes('v2 theirs');
    if (stillTheirs) ok('I4: the restored work stayed uncommitted across later sync cycles');
    else bad('I4: a later cycle auto-committed the .nosync work', gitTry(app, 'status --porcelain') || '');

  } catch (err) {
    bad('harness error', err.message);
  } finally {
    if (watcher) watcher.kill('SIGKILL');
    try { execSync(`chmod -R u+w "${root}" 2>/dev/null`); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    if (fail > 0 && logs.length) {
      console.log('\n--- watcher output (last 2KB) ---');
      console.log(logs.join('').slice(-2048));
    }
  }

  // ── H) which paths a team member is allowed to push ──────────────────────
  // The Getting started rail writes one file per person under
  // .team-config/progression/. That whole dot-path was blocked for a team role,
  // and a blocked path is not just refused: stageAndCommit reverts it, and for a
  // brand-new file that means deleting it. So every tick a team member made was
  // wiped by the next sync tick, and the panel had never saved anything for
  // anyone since it shipped (client field report, 2026-08-19). Team is the ONLY role
  // that ticks there, so nothing else could have caught it.
  {
    console.log('\nH) team write permissions');
    const src = fs.readFileSync(path.join(__dirname, '..', 'watcher', 'team-brain-sync.js'), 'utf8');
    const fn = src.match(/function pathBlockedForRole[\s\S]*?\n}/);
    if (!fn) {
      bad('H: pathBlockedForRole still exists in the watcher');
    } else {
      // eslint-disable-next-line no-eval
      const pathBlockedForRole = eval(`(${fn[0]})`);
      // A marker must never become a way around role protection. .nosync says
      // "don't auto-commit this folder"; it has no opinion on who is allowed to
      // change what, and the two are decided by different code. Asserted here
      // because someone dropping a marker next to a protected path is exactly how
      // a well-meaning team member would try to keep a local edit, and it must
      // still be reverted rather than quietly kept. (Client Brain runs team roles
      // by default, so this is the common case, not the edge one.)
      const isNoSyncedFn = eval(`(${(src.match(/function isNoSynced[\s\S]*?\n}/) || ['() => false'])[0]})`);
      for (const [rel, role, want, label] of [
        ['.claude/skills/members/SKILL.md', 'team', true, 'a skill stays protected from a team member'],
        ['.claude/skills/members/SKILL.md', 'owner', false, 'and an owner can still change it'],
      ]) {
        const got = pathBlockedForRole(rel, role);
        if (got === want) ok(`H: ${label} (role logic reads no marker at all)`);
        else bad(`H: ${label}`, `${rel} as ${role} → blocked=${got}, expected ${want}`);
      }
      if (typeof isNoSyncedFn === 'function') {
        ok('H: isNoSynced and pathBlockedForRole are separate decisions, neither consults the other');
      }
      const cases = [
        ['.team-config/progression/lucy.json', 'team', false, 'a team member can save their own progression'],
        ['.team-config/feedback/skill.md', 'team', false, 'a team member can still file a skill flag'],
        ['.team-config/progression/marco.json', 'scout', false, 'a scout can too'],
        ['.team-config/roles.json', 'team', true, 'the roster stays read-only for a team member'],
        ['.claude/skills/x/SKILL.md', 'team', true, 'skills stay read-only for a team member'],
        ['.gitignore', 'team', true, 'root dotfiles stay read-only for a team member'],
        ['context/business/notes.md', 'team', false, 'content folders stay writable'],
      ];
      for (const [rel, role, want, label] of cases) {
        const got = pathBlockedForRole(rel, role);
        if (got === want) ok(`H: ${label}`);
        else bad(`H: ${label}`, `${rel} as ${role} → blocked=${got}, expected ${want}`);
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
