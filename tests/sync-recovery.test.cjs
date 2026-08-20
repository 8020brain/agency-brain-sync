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
 *      refusal wedging the whole brain the way it did for Poeppel Rechtsanwaelte.
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
function git(repo, args) { return sh(`git -C "${repo}" ${args}`, undefined); }
function gitTry(repo, args) { try { return git(repo, args); } catch { return null; } }

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
  // anyone since it shipped (Lucy Walker, 2026-08-19). Team is the ONLY role
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
