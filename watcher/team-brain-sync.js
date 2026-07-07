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
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = process.env.BRAIN_PATH;
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '90000', 10);
const PULL_INTERVAL_MS = parseInt(process.env.PULL_INTERVAL_MS || '60000', 10);
// Hard ceiling on how long constant file churn can defer a commit. The 90s
// debounce resets on every change, so a brain that writes a file more often
// than that (live session logs, usage logs, caches) would reset it forever and
// never sync. Past this cap we flush regardless of ongoing churn.
const MAX_DEFER_MS = parseInt(process.env.MAX_DEFER_MS || '180000', 10);
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50', 10);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const KEEP_BACKUPS = parseInt(process.env.KEEP_BACKUPS || '30', 10);
// A .git/index.lock older than this is treated as abandoned and removed (a live
// git op holds it for well under a second). After this many consecutive wedged
// cycles we stabilise on a loud, actionable "stuck" state, then back off the
// retry cadence to STUCK_RETRY_MS instead of hammering every cycle.
const LOCK_STALE_MS = parseInt(process.env.LOCK_STALE_MS || '45000', 10);
const ESCALATE_AFTER = parseInt(process.env.ESCALATE_AFTER || '3', 10);
const STUCK_RETRY_MS = parseInt(process.env.STUCK_RETRY_MS || '300000', 10);
const MODE = process.env.BRAIN_SYNC_MODE || 'personal';
const API_BASE = process.env.AGENCY_API_BASE || 'https://api.ads2ai.com';
const MEMBER_TOKEN = process.env.AGENCY_MEMBER_TOKEN || '';
const TEAM_SLUG = process.env.AGENCY_TEAM_SLUG || '';
const MEMBER_EMAIL = (process.env.AGENCY_MEMBER_EMAIL || '').toLowerCase();
const MEMBER_ROLE_HINT = process.env.AGENCY_MEMBER_ROLE || 'team';
const APP_VERSION = process.env.AGENCY_APP_VERSION || '';
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
let oldestPendingAt = null; // when the current uncommitted batch first changed
let tokenCache = null; // { token, expiresAt: Date }
let stallStreak = 0;       // consecutive wedged sync cycles (no forward progress)
let stuckSince = null;     // set once we've stabilised as "stuck" (drives backoff + loud surfacing)
let lastStuckAttempt = 0;  // last time we re-tried while stuck (backoff clock)

function ts() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Compact timestamp for ref names and sidecar filenames: 20260529-143052.
function tsCompact() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
}

// All git runs go through spawnSync with an ARGUMENT ARRAY and NO shell, so a
// filename or roster name containing shell metacharacters ($(...), backticks,
// quotes, ;, |) is handed to git as literal data and can never be interpreted as
// a command. Callers pass each git argument as its own string — git('add', '--',
// file) — never as one interpolated command string. Before 2026-07 these used
// execSync(`git -C "${REPO}" ${cmd}`), which ran under /bin/sh and let a
// booby-trapped filename or a synced roles.json name execute arbitrary commands
// on every syncing machine. main.js's runGit() and lib/inspect-brain.cjs already
// use this array pattern.
function runGitRaw(args, captureStderr) {
  const r = spawnSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'ignore'],
    maxBuffer: 1024 * 1024 * 50,
  });
  const out = (r.stdout || '').toString().trim();
  const err = (r.stderr || (r.error && r.error.message) || '').toString().trim();
  return { ok: !r.error && r.status === 0, out, err };
}

function git(...args) {
  const r = runGitRaw(args, true);
  if (!r.ok) {
    console.error(`  git ${args[0]} -> ${r.err}`);
    return null;
  }
  return r.out;
}

// Read-only probe that never logs. Some reads (an unset config key) exit
// non-zero by design; we don't want those surfacing as errors in the log.
function gitProbe(...args) {
  const r = runGitRaw(args, false);
  return r.ok ? r.out : '';
}

// Run a git command that is EXPECTED to sometimes exit non-zero (a conflicting
// merge, a missing merge stage). Returns { ok, out, err } and never logs — the
// caller decides what a non-zero exit means.
function gitTry(...args) {
  return runGitRaw(args, true);
}

// A git process that dies mid-operation (notably a Cowork session, which can't
// complete its own git step — verified 2026-05-26) leaves `.git/index.lock`
// behind. While it sits there, EVERY add/commit/merge fails instantly ("Unable
// to create '.git/index.lock': File exists"), so the watcher retries forever and
// the clone wedges — the "behind N; merging" loop that never advances. git holds
// this lock for a fraction of a second, so one older than LOCK_STALE_MS is
// certainly abandoned and safe to remove. Returns true if it cleared one.
function clearStaleIndexLock() {
  const lock = path.join(REPO, '.git', 'index.lock');
  let st;
  try { st = fs.statSync(lock); } catch { return false; } // no lock present
  if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return false; // a live git op may hold it
  try {
    fs.unlinkSync(lock);
    console.log(`[${ts()}] cleared stale .git/index.lock (${Math.round((Date.now() - st.mtimeMs) / 1000)}s old)`);
    return true;
  } catch (_) { return false; }
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
    writeState('running', `${held.length} change${held.length > 1 ? 's' : ''} set aside`, { held });
  } else {
    writeState('running', null, { held: [] });
  }
}

// Forward progress this cycle — drop any stuck/stall bookkeeping.
function clearStall() { stallStreak = 0; stuckSince = null; }

// A cycle that couldn't complete a retryable git step (merge/commit/push). The
// first ESCALATE_AFTER are treated as transients (a race, a brief offline) and
// kept quiet. Past that the clone is genuinely wedged, so we STABILISE on a loud,
// actionable "stuck" stop (stuck:true → the tray shows "needs attention" and
// main.js fires a one-time desktop notification) and let doSync back off the
// retry cadence, instead of flickering pulling↔stop every cycle and burying the
// problem in a log nobody reads.
function stopStuck(reason, detail) {
  stallStreak += 1;
  const stuck = stallStreak >= ESCALATE_AFTER;
  if (stuck && !stuckSince) {
    stuckSince = Date.now();
    console.log(`[${ts()}] STUCK after ${stallStreak} attempts: ${reason}${detail ? ` — ${detail}` : ''}`);
  }
  writeState('stop', reason, { stuck, attempts: stallStreak, detail: detail || null });
}

// ───── Agency-mode auth ─────

async function mintGitToken() {
  const r = await fetch(`${API_BASE}/api/team-brain/git-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MEMBER_TOKEN}`,
    },
    body: JSON.stringify({ teamSlug: TEAM_SLUG, appVersion: APP_VERSION }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const err = new Error(`git-token mint HTTP ${r.status}: ${body.slice(0, 200)}`);
    // A 401 here means the member's sign-in session (member_token) has expired or
    // been invalidated server-side. The token is still stored locally, so this
    // request is the ONLY place the app learns it's dead — tag it so doSync raises
    // a loud, specific "sign in again" state instead of a silent generic error.
    if (r.status === 401) err.authExpired = true;
    throw err;
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

// Strip any embedded credential (x-access-token:<token>@, or any userinfo@) from
// an https git URL so we always inject a FRESH token into a CLEAN base URL.
// Without this the clone can wedge forever with no way to recover: if a prior op
// was killed between set-url(authed) and the restore below, or an old clone was
// set up with the token left in origin, the "clean" URL we read back already
// carries a (now-expired) token. Re-embedding on top of it produces a malformed
// double-auth URL (https://x-access-token:NEW@x-access-token:OLD@github.com/…)
// that git rejects with "Invalid username or token", so every fetch fails and
// the watcher loops on fetch_failed — a restart doesn't help, because nothing
// ever removed the stale token. Looping the replace also collapses a
// double-embed back to clean. (2026-07-02: a reinstalled agency clone was stuck
// exactly this way — a dead ghs_ token frozen in origin, sync dead-looping.)
function cleanRemoteUrl(url) {
  let prev;
  let u = url;
  do {
    prev = u;
    u = u.replace(/^(https:\/\/)[^@/]*@/i, '$1');
  } while (u !== prev);
  return u;
}

async function withAuthenticatedRemote(fn) {
  if (MODE !== 'agency') return fn();
  const token = await getGitToken();
  const current = git('remote', 'get-url', 'origin');
  if (!current) throw new Error('no origin remote configured');
  // Always work from the token-less base, never from whatever was on disk — a
  // stale token in `current` would otherwise double-embed and wedge us.
  const clean = cleanRemoteUrl(current);
  const authed = clean.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  git('remote', 'set-url', 'origin', authed);
  try {
    return await fn();
  } finally {
    // Restore the CLEAN base, not `current`: this actively heals a URL that had
    // a stale token frozen into it, on the very first sync after the update.
    git('remote', 'set-url', 'origin', clean);
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

// True when this role must NOT push relPath. Owners + scouts: never. The
// 'agency' role (ClientBrain: agency staff inside a client's brain) gets
// scout-level write access. Team: blocked from root-level files (no "/") and
// root dotpaths (".claude/", ".team-config/", ".github/", ".gitignore", …);
// any other path — every content folder, new ones included — is allowed.
function pathBlockedForRole(relPath, role) {
  const norm = (role || '').toLowerCase().replace(/_/g, '-');
  if (norm === 'owner' || norm === 'head-scout' || norm === 'scout' || norm === 'agency') return false;
  // Team's one allowed upward channel: skill feedback. flag-skill writes here,
  // and the whole point is that a flag reaches the scout, so let it sync up.
  if (relPath.startsWith('.team-config/feedback/')) return false;
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
  git('update-ref', name, 'HEAD');
  const out = gitProbe('for-each-ref', '--sort=-creatordate', '--format=%(refname)', 'refs/backups/');
  const refs = out.split('\n').filter(Boolean);
  for (const stale of refs.slice(KEEP_BACKUPS)) git('update-ref', '-d', stale);
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
  const unmerged = gitProbe('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  const conflicts = [];
  for (const f of unmerged) {
    const theirs = gitTry('show', `:3:${f}`); // stage 3 = remote/their side
    try {
      if (theirs.ok) {
        const sc = sidecarName(f, stamp);
        const scAbs = path.join(REPO, sc);
        fs.mkdirSync(path.dirname(scAbs), { recursive: true });
        fs.writeFileSync(scAbs, theirs.out.endsWith('\n') ? theirs.out : `${theirs.out}\n`);
        git('add', '--', sc);
        conflicts.push({ file: f, sidecar: sc });
      }
      // Keep our clean version as the live file. If ours doesn't exist for this
      // path (e.g. deleted-by-us / modified-by-them), fall back to theirs so the
      // file isn't lost — the sidecar already preserved the other side either way.
      const ours = git('checkout', '--ours', '--', f);
      if (ours === null) git('checkout', '--theirs', '--', f);
      git('add', '--', f);
    } catch (_) {
      git('add', '--', f); // last resort: whatever's on disk, so the merge can finish
    }
  }
  // Stage everything the merge auto-resolved too, then commit the merge.
  git('add', '-A');
  let r = git('commit', '--no-edit');
  if (r === null) r = git('commit', '-m', `auto-sync merge ${ts()} (kept both sides where edits overlapped)`);
  return conflicts;
}

// Pull remote changes via a plain MERGE (never rebase/reset). Snapshots a
// backup ref first. Returns { merged, conflicts, error }.
function mergeWithSidecars(branch) {
  backupRef('pre-merge');
  const stamp = tsCompact();
  let m = gitTry('merge', '--no-edit', `origin/${branch}`);

  // Safety net: a merge can refuse before it even starts when an uncommitted
  // local change (a held big file, or a race) sits on a path the merge must
  // update. Left alone that wedges sync forever. Back each blocker up to a
  // sidecar, restore it, and retry the merge once so the pull always proceeds.
  if (!m.ok && midOperation() !== 'merge') {
    const blockers = parseMergeBlockers(m.err);
    if (blockers.length) {
      for (const b of blockers) { backupHeldEdit(b); revertProtectedEdit(b); }
      m = gitTry('merge', '--no-edit', `origin/${branch}`);
    }
  }

  if (m.ok && midOperation() !== 'merge') {
    return { merged: true, conflicts: [] }; // clean merge
  }
  if (midOperation() !== 'merge') {
    // Merge refused without entering a merge and the safety net couldn't clear
    // it — never leave a half state, so report it for a human.
    return { merged: false, conflicts: [], error: m.err || 'merge refused' };
  }
  const conflicts = resolveConflictsAndCommit(stamp);
  return { merged: true, conflicts };
}

// ───── Read-only enforcement for team roles ─────
//
// A team member's edit to a protected path (a skill, .claude/, root config) can
// never be pushed. Leaving it uncommitted is what wedges sync: an upstream
// change to the same file can't fast-forward over the local edit. So instead of
// holding it, we make protected paths genuinely read-only — back the member's
// version up to a recoverable sidecar (under .git/, so it never syncs and never
// reappears as a change), restore the file to its committed state, and, for a
// skill, file a flag so the change still reaches the scout who owns it.

function heldEditsDir() {
  return path.join(REPO, '.git', 'agencybrain-held');
}

// Copy the current working-tree version of relPath to a timestamped sidecar.
// Returns the absolute sidecar path, or null if there's nothing on disk to save
// (e.g. the member deleted the file).
function backupHeldEdit(relPath) {
  const src = path.join(REPO, relPath);
  if (!fs.existsSync(src)) return null;
  const dest = path.join(heldEditsDir(), `${relPath}.${tsCompact()}`);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return dest;
  } catch (_) {
    return null;
  }
}

// Discard a protected-path change: restore the committed version (a modified or
// deleted file) or drop it entirely (a newly-created file). Touches both the
// index and the working tree, so nothing is left to block the next pull.
function revertProtectedEdit(relPath) {
  const r = gitTry('checkout', 'HEAD', '--', relPath);
  if (!r.ok) {
    // No version in HEAD => the member created this file. Unstage and remove it.
    git('reset', '-q', 'HEAD', '--', relPath);
    try { fs.unlinkSync(path.join(REPO, relPath)); } catch (_) { /* already gone */ }
  }
}

// The skill folder name if relPath is inside .claude/skills/<name>/, else null.
function skillNameFor(relPath) {
  const m = relPath.match(/^\.claude\/skills\/([^/]+)\//);
  return m ? m[1] : null;
}

// File a flag-skill note so the member's change reaches their scout. Best-effort:
// if the helper script isn't present (older brain) we skip — the sidecar still
// holds their work. The note lands in .team-config/feedback/<skill>.md, which a
// team role is now allowed to push (see pathBlockedForRole).
function fileSkillFlag(skill, relPath, sidecar, diff) {
  const script = path.join(REPO, '.claude', 'skills', 'flag-skill', 'scripts', 'log-flag.cjs');
  if (!fs.existsSync(script)) return false;
  const wanted = [
    'A team member edited this skill locally. Skills are managed by scouts, so the edit was set aside, but here is what they wanted to change.',
    sidecar ? `Their version is saved at: ${path.relative(REPO, sidecar)}` : null,
    diff ? `\nTheir change:\n${diff.slice(0, 4000)}` : null,
  ].filter(Boolean).join('\n');
  try {
    const r = spawnSync('node', [
      script,
      '--skill', skill,
      '--wrong', `${relPath} was edited on a team member's machine; their role can't apply skill changes`,
      '--wanted', wanted,
      '--by', MEMBER_EMAIL || 'team-member',
      '--repo', REPO,
    ], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

// Pull the offending paths out of git's "your local changes / untracked working
// tree files would be overwritten by merge" refusal (git lists each one
// tab-indented), so the safety net can clear just those and retry the pull.
function parseMergeBlockers(errText) {
  if (!errText) return [];
  const files = [];
  for (const line of errText.split('\n')) {
    const m = line.match(/^\t(.+?)\s*$/);
    if (m) files.push(m[1]);
  }
  return files;
}

// ───── Commit lane (isolate-and-continue) ─────

// Stage and commit local work. Oversized files are HELD (kept locally, reported).
// Files the member's role can't push are made read-only: backed up, reverted,
// and (for skills) flagged to the scout, so they can never wedge the next pull.
// Returns { committed, held: [{file, why}], error }.
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

  git('add', '-A');
  const held = [];

  if (MODE === 'agency') {
    const role = currentRole();
    for (const f of files) {
      if (!pathBlockedForRole(f, role)) continue;
      // Protected path edited by a role that can't push it. Make it genuinely
      // read-only: save the member's version, file a flag if it's a skill, then
      // restore the file so it can never wedge the next pull.
      const diff = gitProbe('diff', 'HEAD', '--', f);
      const sidecar = backupHeldEdit(f);
      const skill = skillNameFor(f);
      const flagged = skill ? fileSkillFlag(skill, f, sidecar, diff) : false;
      revertProtectedEdit(f);
      const why = skill
        ? `skills are set by your scouts, so this change wasn't kept. I saved your version${flagged ? ' and sent it to your scout.' : '.'}`
        : `this file is managed by your owners and scouts, so the change wasn't kept. I saved your version.`;
      held.push({ file: f, why });
    }
  }

  // Hold oversized files among what's still staged: park in local exclude so
  // they stop reappearing, and leave them on disk untouched.
  const stagedNow = gitProbe('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  for (const hit of oversizedFiles(stagedNow)) {
    git('reset', '-q', 'HEAD', '--', hit.rel);
    addToLocalExclude(hit.rel);
    held.push({ file: hit.rel, why: `${Math.round(hit.mb)} MB — too big to sync, kept on this machine only` });
  }

  for (const h of held) console.log(`[${ts()}]   held: ${h.file} — ${h.why}`);

  const staged = gitProbe('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (!staged.length) {
    return { committed: false, held }; // everything was held
  }

  const commitMsg = `auto-sync: ${ts()}`;
  let commitResult = git('commit', '-m', commitMsg);
  if (commitResult === null) {
    // Most common cause: this clone has no git author identity, so its very
    // first commit fails. Self-heal the identity and retry once.
    ensureGitIdentity();
    commitResult = git('commit', '-m', commitMsg);
  }
  if (commitResult === null) {
    git('reset', '-q', 'HEAD');
    return { committed: false, held, error: 'commit failed' };
  }
  console.log(`[${ts()}]   committed ${staged.length} file(s)${held.length ? `, held ${held.length}` : ''}`);
  return { committed: true, held };
}

// ───── Repo state classifier ─────

async function classifyState() {
  let fetchResult;
  try {
    fetchResult = await withAuthenticatedRemote(() => git('fetch', '--quiet', 'origin'));
  } catch (err) {
    // An expired sign-in surfaces HERE first (the git-token mint 401s inside
    // withAuthenticatedRemote). Don't bury it as a generic "offline / fetch
    // failed" — re-throw so doSync raises the loud "Reconnect / sign in again"
    // state. Without this the pull path silently mislabels an expired session as
    // offline, which is the exact silent failure this fixes.
    if (err && err.authExpired) throw err;
    return { state: 'fetch_failed', detail: err.message };
  }
  if (fetchResult === null) return { state: 'fetch_failed', detail: 'see git error above' };

  const status = git('status', '--porcelain');
  if (status === null) return { state: 'unknown' };
  const dirty = status.length > 0;
  const statusLines = status.split('\n').filter(Boolean);

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch) return { state: 'unknown' };

  const localSha = git('rev-parse', branch);
  const remoteSha = git('rev-parse', `origin/${branch}`);
  if (!localSha || !remoteSha) return { state: 'unknown', branch };

  if (localSha === remoteSha) {
    return dirty
      ? { state: 'dirty_in_sync', branch, statusLines }
      : { state: 'clean_in_sync', branch };
  }

  const ab = git('rev-list', '--left-right', '--count', `${branch}...origin/${branch}`);
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
    // A stale index.lock from a session that died mid-git (often Cowork) blocks
    // every commit/merge; clear it before anything else so it can't wedge sync.
    clearStaleIndexLock();

    // While stabilised as stuck, don't hammer: let the interval re-attempt only
    // every STUCK_RETRY_MS. A local edit (debounce) or remote movement still
    // gets an immediate try via its own trigger.
    if (stuckSince && trigger === 'interval' && (Date.now() - lastStuckAttempt) < STUCK_RETRY_MS) {
      syncing = false;
      return;
    }
    if (stuckSince) lastStuckAttempt = Date.now();

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
      oldestPendingAt = null;
      clearStall();
      reportRunning([]);
      return;
    }
    if (s.state === 'clean_remote_ahead') {
      console.log(`[${ts()}] ${trigger}: remote ahead by ${s.behind}; fast-forwarding`);
      const r = git('merge', '--ff-only', `origin/${s.branch}`);
      if (r === null) {
        // Shouldn't happen (no local commits), but if it does, a real merge
        // handles it without losing anything.
        const res = mergeWithSidecars(s.branch);
        if (!res.merged) { stopStuck('can\'t pull in the latest changes', res.error || 'fast-forward failed'); return; }
        clearStall();
        reportRunning(res.conflicts.map((c) => ({ file: c.file, why: `overlapping edit — kept both, see ${path.basename(c.sidecar)}` })));
      } else {
        console.log(`[${ts()}]   fast-forwarded`);
        clearStall();
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
    // remote work lands promptly. Crucially, only skip while the pending batch
    // is still YOUNGER than the defer cap: under constant churn the debounce
    // never fires, so once the batch is older than the cap the interval must
    // force the flush rather than skip forever.
    if (trigger === 'interval' && pendingTimer !== null && !behind
        && oldestPendingAt !== null && (Date.now() - oldestPendingAt) < MAX_DEFER_MS) {
      syncing = false;
      return;
    }
    // From here we're flushing whatever's pending; reset the defer clock so
    // edits during/after this sync start a fresh window.
    oldestPendingAt = null;

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
        stopStuck('can\'t save your latest changes', r.error);
        return;
      }
    }

    // 2. Merge remote in if we're behind (auto, keeps both sides, backup ref).
    if (behind) {
      writeState('pulling');
      console.log(`[${ts()}] ${trigger}: remote moved (behind ${s.behind}); merging`);
      const res = mergeWithSidecars(s.branch);
      if (!res.merged) {
        stopStuck('can\'t pull in the latest changes', res.error || 'merge failed');
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
    const ahead = git('rev-list', '--count', `origin/${s.branch}..${s.branch}`);
    if (ahead === '0' || ahead === null) {
      clearStall();
      reportRunning(held);
      return;
    }
    writeState('pushing');
    const pushResult = await withAuthenticatedRemote(() => git('push'));
    if (pushResult === null) {
      // Most often a race: someone pushed between our fetch and our push. Next
      // tick re-classifies as behind and auto-merges, so this self-heals. Only a
      // persistent failure (ESCALATE_AFTER in a row) stabilises as stuck.
      console.log(`[${ts()}]   push failed; will retry next tick`);
      stopStuck('can\'t push your changes up', 'push failed — usually a brief race or offline');
      return;
    }
    console.log(`[${ts()}]   pushed.`);
    clearStall();
    if (didContribute) reportContribution().catch(() => {});
    reportRunning(held);
  } catch (err) {
    console.error(`[${ts()}] sync error: ${err.message}`);
    if (err && err.authExpired) {
      // Distinct from a generic sync error: the session is dead and only signing
      // in again fixes it. Flag it so main.js prompts the member (desktop
      // notification + tray "Reconnect / sign in again…") instead of failing mutely.
      writeState('stop', 'Your sign-in has expired — open Agency Brain and choose "Reconnect / sign in again"', { authExpired: true });
    } else {
      writeState('stop', `error: ${err.message}`);
    }
  } finally {
    syncing = false;
  }
}

function scheduleDebouncedSync() {
  if (oldestPendingAt === null) oldestPendingAt = Date.now();
  if (pendingTimer) clearTimeout(pendingTimer);
  // If this batch has been deferred past the cap, stop resetting and flush now.
  // Without this, churn faster than DEBOUNCE_MS resets the timer forever and
  // nothing ever commits (2026-05-29 dogfood: live brain churned every few
  // seconds, the 90s debounce never fired, the interval kept skipping).
  if (Date.now() - oldestPendingAt >= MAX_DEFER_MS) {
    pendingTimer = null;
    doSync('debounce').catch(() => {});
    return;
  }
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
  if (gitProbe('config', 'user.email')) return; // already has an identity
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
  git('config', 'user.email', MEMBER_EMAIL);
  git('config', 'user.name', name);
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
