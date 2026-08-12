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
// Phone-dispatch: opt-in per machine (tray menu, default off). When on, each
// sync is followed by a read-only check of origin for !inbox/!dispatch-*.md
// notes captured from the phone, and a claude session is opened on each.
const DISPATCH_ENABLED = process.env.BRAIN_DISPATCH === '1';

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
// index.lock is not the only one. A commit takes THREE locks: the index, HEAD,
// and the branch ref. Only index.lock was ever cleared here, so a git killed
// part-way through a commit left HEAD.lock behind and every later commit failed
// with "cannot lock ref 'HEAD'" forever, with nothing to self-heal it. That is
// exactly what happened to a scout on 2026-07-31, who lost a morning to it and
// had to be talked through deleting a file by hand.
//
// Where the dead git came from matters too: until v1.1.15 the app refused the
// quit macOS sends at shutdown, so macOS force-killed it, mid-git, on every
// restart for ten weeks. That was the open question after v1.1.15 and this is
// the answer to it.
function staleGitLocks() {
  const branch = gitProbe('rev-parse', '--abbrev-ref', 'HEAD');
  const rels = ['index.lock', 'HEAD.lock', 'config.lock'];
  if (branch && branch !== 'HEAD') rels.push(path.join('refs', 'heads', `${branch}.lock`));
  return rels.map((r) => path.join(REPO, '.git', r));
}

function clearStaleIndexLock() {
  let cleared = false;
  for (const lock of staleGitLocks()) {
    let st;
    try { st = fs.statSync(lock); } catch { continue; } // not present
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) continue; // a live git op may hold it
    try {
      fs.unlinkSync(lock);
      console.log(`[${ts()}] cleared stale ${path.relative(REPO, lock)} (${Math.round((Date.now() - st.mtimeMs) / 1000)}s old)`);
      cleared = true;
    } catch (_) { /* best-effort */ }
  }
  return cleared;
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
  // Tell the server too, so a blocked member is visible to the agency without
  // anyone having to notice and email.
  //
  // Only alarm once a stop has actually STABILISED. stopStuck escalates after
  // ESCALATE_AFTER consecutive failures, and an expired sign-in alarms straight
  // away because only that person can fix it. Everything else (offline, a
  // failed fetch, a push race) retries itself within a minute or two, and
  // reporting those as blocked is how a red flag stops meaning anything. The
  // first live data on 2026-07-31 flagged two people red for a blip whose own
  // text said "will retry".
  const alarm = state === 'stop' && !!(extra && (extra.stuck || extra.authExpired));
  // The reason names the failed step in words a member can act on; git's own
  // words (extra.detail) are what tell the Workbench WHY. Append a scrubbed,
  // trimmed copy for the server report only — the tray keeps the clean reason.
  // Never send the raw string: a failed push can echo the authenticated remote
  // URL, and that access token must never leave this machine.
  let why = alarm ? (reason || null) : null;
  if (alarm && extra && extra.detail) {
    const scrubbed = String(extra.detail)
      .replace(/x-access-token:[^@\s]*@/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    if (scrubbed) why = `${why || 'stopped'} · ${scrubbed}`;
  }
  reportSyncState(alarm ? 'stop' : 'running', why);
}

// Only the BLOCKED edge is worth telling the server about: entering a stop, the
// reason changing while stopped, and recovering. A healthy cycle walks
// running -> pulling -> running -> pushing -> running, so reporting every hop
// would be up to four POSTs a minute per person (~700/min across the fleet) to
// say nothing anyone reads. A healthy brain now sends zero.
let lastReportedSync = null;
function reportSyncState(state, reason) {
  if (MODE !== 'agency' || !TEAM_SLUG || !MEMBER_TOKEN) return;
  const key = state === 'stop' ? `stop::${reason || ''}` : 'running::';
  if (key === lastReportedSync) return;
  lastReportedSync = key;
  state = state === 'stop' ? 'stop' : 'running';
  reason = state === 'stop' ? reason : null;
  // Fire and forget. This is telemetry: it must never delay or break a sync,
  // and the git-token heartbeat carries the same fields as a backstop if this
  // call is lost.
  fetch(`${API_BASE}/api/team-brain/sync-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MEMBER_TOKEN}` },
    body: JSON.stringify({ teamSlug: TEAM_SLUG, syncState: state, stopReason: reason || null }),
  }).catch(() => { lastReportedSync = null; }); // let the next change retry
}

// What the git-token heartbeat should carry, so a member whose immediate report
// was lost still surfaces within the hour.
function currentSyncHealth() {
  if (!lastReportedSync) return {};
  const i = lastReportedSync.indexOf('::');
  return { syncState: lastReportedSync.slice(0, i), stopReason: lastReportedSync.slice(i + 2) || null };
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
    body: JSON.stringify({ teamSlug: TEAM_SLUG, appVersion: APP_VERSION, source: 'watcher', ...currentSyncHealth() }),
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
  // sections: role-scoped annex repos this member is entitled to (server-
  // authoritative, [] for everyone else). Ridden by section-sync below; the
  // minted token is scoped to cover exactly these repos plus the main one.
  return {
    token: json.token,
    expiresAt: new Date(json.expiresAt),
    sections: Array.isArray(json.sections) ? json.sections : [],
  };
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

// Office lock files (~$budget.xlsx) exist only while a document is open, and
// they delete themselves the moment it closes. Staging them means git is racing
// a file that is actively removing itself. Ignoring them in the file watcher is
// only half the job: `git add -A` would still stage them, so they need a git
// exclude too. Doing it in .git/info/exclude rather than .gitignore means every
// EXISTING brain self-heals on update, with no repo change and nothing for the
// member to do. (Datasauce, 2026-07-31: a scout lost a morning to a wedged
// commit with one of these churning in a client campaigns folder.)
function ensureOfficeLockExclude() {
  const p = path.join(REPO, '.git', 'info', 'exclude');
  let cur = '';
  try { cur = fs.readFileSync(p, 'utf8'); } catch (_) { /* may not exist yet */ }
  if (cur.split('\n').includes('~$*')) return;
  try {
    const sep = cur.length && !cur.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(p, `${sep}# Office lock files, transient by nature\n~$*\n`);
    console.log(`[${ts()}] excluded Office lock files (~$*) from this clone`);
  } catch (_) { /* best-effort */ }
}

// Any commit made OUTSIDE the app (a terminal, a Claude session in Cowork)
// skips the stageAndCommit hold below, and one too-big file baked into a local
// commit stops the whole brain pushing, permanently, while everything else
// still looks healthy. A standard git pre-commit hook closes that gap at the
// source, inside whatever tool runs the commit. Installed/refreshed at boot;
// a hook we didn't write is left alone (the pre-push healer still covers it).
const HOOK_MARKER = 'Agency Brain large-file guard';
function installPrecommitSizeHook() {
  try {
    const hooksDir = path.join(REPO, '.git', 'hooks');
    if (!fs.existsSync(hooksDir)) return;
    const hookPath = path.join(hooksDir, 'pre-commit');
    let cur = '';
    try { cur = fs.readFileSync(hookPath, 'utf8'); } catch (_) { /* none yet */ }
    if (cur && !cur.includes(HOOK_MARKER)) {
      console.log(`[${ts()}] a pre-commit hook we didn't install exists; leaving it alone`);
      return;
    }
    const script = `#!/bin/sh
# ${HOOK_MARKER} — installed automatically by the app; edits here are overwritten.
# GitHub rejects any push containing a file over 100 MB, and one such commit
# freezes syncing for this whole brain until it's unwound. Block it at commit time.
big=$(git diff --cached --name-only --diff-filter=AM -z | tr '\\0' '\\n' | while IFS= read -r f; do
  [ -n "$f" ] || continue
  sz=$(git cat-file -s ":$f" 2>/dev/null || echo 0)
  [ "$sz" -ge ${MAX_FILE_BYTES} ] && echo "  $f ($((sz / 1048576)) MB)"
done)
if [ -n "$big" ]; then
  echo "commit blocked: these files are ${MAX_FILE_MB} MB or bigger, and files this size stop the whole brain syncing:" >&2
  echo "$big" >&2
  echo "Keep them outside the brain folder, or take them out of this commit with: git reset -- '<file>'" >&2
  exit 1
fi
exit 0
`;
    if (cur !== script) {
      fs.writeFileSync(hookPath, script, { mode: 0o755 });
      fs.chmodSync(hookPath, 0o755);
      console.log(`[${ts()}] installed pre-commit large-file guard (${MAX_FILE_MB} MB)`);
    }
  } catch (e) {
    console.error(`[${ts()}] pre-commit hook install failed: ${e.message}`);
  }
}

// Every blob that exists only in the UNPUSHED commits, sized from git's object
// store rather than the worktree — the file may already be deleted from disk,
// but the commit still carries it and the push still fails. Feeds the pre-push
// self-heal in doSync.
function oversizedBlobsInRange(branch) {
  const list = gitProbe('rev-list', '--objects', `origin/${branch}..${branch}`);
  if (!list) return [];
  const r = spawnSync('git', ['-C', REPO, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize) %(rest)'], {
    encoding: 'utf8',
    input: list,
    maxBuffer: 1024 * 1024 * 50,
  });
  if (r.error || r.status !== 0) return [];
  const hits = [];
  const seen = new Set();
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\S+ blob (\d+) (.+)$/);
    if (m && Number(m[1]) >= MAX_FILE_BYTES && !seen.has(m[2])) {
      seen.add(m[2]);
      hits.push({ path: m[2], mb: Number(m[1]) / (1024 * 1024) });
    }
  }
  return hits;
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
// Turn git's own commit error into something a person can act on. The member
// sees this in the notification and the tray, so it has to name the cause AND
// the next move, in plain words. Anything unrecognised falls through to git's
// real message, which is still far better than "commit failed".
function explainCommitFailure(err) {
  const e = String(err || '');
  if (/index\.lock/i.test(e)) return "can't save: another program is holding your brain folder's git lock. Close Cowork and any open terminal, then it should clear on its own";
  if (/no space left|disk quota|ENOSPC/i.test(e)) return "can't save: this computer has run out of disk space";
  if (/gpg|signing failed|secret key not available/i.test(e)) return "can't save: git commit signing is switched on and failed. Turn it off with: git config --global commit.gpgsign false";
  if (/hook declined|pre-commit|hook.*failed|cannot run .*hook/i.test(e)) return "can't save: a git hook on this computer blocked the save";
  if (/tell me who you are|empty ident|user\.email/i.test(e)) return "can't save: git has no name or email set on this computer";
  if (/permission denied|insufficient permission|EACCES|read-only file system|operation not permitted/i.test(e)) return "can't save: this computer can't write to your brain folder (permissions)";
  if (/does not have a commit checked out|not a git repository|bad object|corrupt/i.test(e)) return "can't save: your brain folder's git data looks damaged, so it needs re-cloning";
  const first = e.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  return first ? `can't save your latest changes: ${first}` : "can't save your latest changes (git gave no reason)";
}

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
  // gitTry, not git: we need git's OWN stderr to tell the member what went
  // wrong. The old code called git(), which discards the error and returned the
  // bare string 'commit failed' — so the notification, the tray and the log all
  // said "can't save your latest changes" with no cause, and the only way to
  // find out was to email Mike and wait. (Chris at Datasauce, 2026-07-31, blocked
  // for a whole morning by exactly this.)
  let cr = gitTry('commit', '-m', commitMsg);
  if (!cr.ok) {
    // Most common cause: this clone has no git author identity, so its very
    // first commit fails. Self-heal the identity and retry once.
    ensureGitIdentity();
    cr = gitTry('commit', '-m', commitMsg);
  }
  if (!cr.ok) {
    const raw = (cr.err || '').trim();
    console.error(`[${ts()}]   commit failed — git said: ${raw || '(no output)'}`);
    git('reset', '-q', 'HEAD');
    return { committed: false, held, error: explainCommitFailure(raw), raw };
  }
  console.log(`[${ts()}]   committed ${staged.length} file(s)${held.length ? `, held ${held.length}` : ''}`);
  return { committed: true, held };
}

// ───── Branch self-heal ─────

// Out-of-app git (a Claude session, a terminal `git checkout <sha>`) can leave
// the clone on no branch at all. Everything then LOOKS alive — fetch works,
// merges work — but `git push` fails identically forever ("not currently on a
// branch"): a permanent, silent wedge. Heal it: save any work in progress as a
// commit, keep whatever was committed off-branch reachable via a backup ref,
// return to the repo's real branch, and fold the off-branch work back in with
// the usual keep-both-sides merge.
function defaultBranch() {
  const ref = gitProbe('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  const m = ref.match(/^origin\/(.+)$/);
  if (m) return m[1];
  return gitTry('rev-parse', '--verify', '--quiet', 'refs/heads/main').ok ? 'main' : 'master';
}

function healDetachedHead() {
  if (gitProbe('rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD') return true; // on a branch
  const branch = defaultBranch();
  console.log(`[${ts()}] not on a branch (detached HEAD); returning to ${branch}`);
  if (gitProbe('status', '--porcelain')) {
    git('add', '-A');
    gitTry('commit', '-m', `auto-sync: work saved while off-branch ${ts()}`);
  }
  const before = gitProbe('rev-parse', 'HEAD');
  const backup = backupRef('detached');
  const co = gitTry('checkout', branch);
  if (!co.ok) {
    stopStuck('your brain folder is off its main branch and couldn\'t be put back', co.err);
    return false;
  }
  // If the off-branch state held anything the branch doesn't, merge it back in.
  if (before && !gitTry('merge-base', '--is-ancestor', before, branch).ok) {
    const m = gitTry('merge', '--no-edit', before);
    if (!m.ok && midOperation() === 'merge') {
      resolveConflictsAndCommit(tsCompact());
    } else if (!m.ok) {
      // Refused outright; the backup ref keeps the off-branch work reachable.
      stopStuck('work made off the main branch couldn\'t be folded back in', m.err);
      return false;
    }
    console.log(`[${ts()}]   folded off-branch work back into ${branch} (backup: ${backup})`);
  }
  return true; // the cycle's own push outcome decides whether the stall clears
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
  if (localSha && !remoteSha) {
    // No origin/<branch> after a successful fetch. If the remote has no
    // branches AT ALL, this is a stranded first publish: setup seeded and
    // committed, the very first push died, and the retry adopted the folder
    // without pushing. Every tick used to park this as "unrecognised git
    // state" forever while the portal said Live (2026-08-13 review, flow
    // finding B2). Name the state so doSync can finish the publish.
    const heads = await withAuthenticatedRemote(() => git('ls-remote', '--heads', 'origin')).catch(() => null);
    if (heads !== null && String(heads).trim() === '') {
      return { state: 'unpublished_first_commit', branch };
    }
    return { state: 'unknown', branch };
  }
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

    // Out-of-app git can leave the clone off its branch, where every push
    // fails forever with everything else looking healthy. Put it back first.
    if (!healDetachedHead()) return;

    writeState('pulling');
    const s = await classifyState();

    if (s.state === 'fetch_failed') {
      console.log(`[${ts()}] ${trigger}: fetch failed -- ${s.detail}`);
      writeState('stop', 'offline or fetch failed, will retry');
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
    if (s.state === 'unpublished_first_commit') {
      // Finish the publish the setup run never completed: push the local
      // commits up as the remote's first branch. Self-heals brains already
      // stranded in the field, not just future installs.
      console.log(`[${ts()}] ${trigger}: remote has no branches but local has commits; publishing first commit`);
      const pushed = await withAuthenticatedRemote(() => git('push', '-u', 'origin', s.branch)).catch(() => null);
      if (pushed === null) {
        console.log(`[${ts()}]   first publish failed; will retry next tick`);
        writeState('stop', 'first publish pending (push failed, retrying)');
      } else {
        console.log(`[${ts()}]   first publish landed`);
        writeState('ok', 'first publish landed');
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
        // r.error now names the actual cause; r.raw carries git's own words for
        // the log and the state file.
        stopStuck(r.error, r.raw || null);
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

    // 2b. Self-heal the big-file wedge. A commit made OUTSIDE the app (a
    //     terminal, a Claude session — the app's own commits hold big files
    //     BEFORE committing) can bake in a file GitHub rejects, and then EVERY
    //     push fails forever while everything else looks healthy (the
    //     Recognition stall, 2026-08-01→04). Unstitch those commits (worktree
    //     untouched, backup ref kept), set the big files aside with the usual
    //     hold, recommit the rest, and let the push that follows land.
    const bigs = oversizedBlobsInRange(s.branch);
    if (bigs.length) {
      console.log(`[${ts()}]   unpushed commits carry ${bigs.length} file(s) too big to sync; setting aside and recommitting`);
      backupRef('oversize');
      const rr = gitTry('reset', '--mixed', `origin/${s.branch}`);
      if (!rr.ok) {
        stopStuck('can\'t set aside a file that\'s too big to sync', rr.err);
        return;
      }
      for (const b of bigs) {
        if (fs.existsSync(path.join(REPO, b.path))) addToLocalExclude(b.path);
        held.push({ file: b.path, why: `${Math.round(b.mb)} MB — too big to sync, kept on this machine only` });
      }
      const st = git('status', '--porcelain');
      const lines = (st || '').split('\n').filter(Boolean);
      if (lines.length) {
        const rc = stageAndCommit({ statusLines: lines });
        held = held.concat(rc.held || []);
        if (rc.error) { stopStuck(rc.error, rc.raw || null); return; }
        didContribute = didContribute || rc.committed === true;
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
    // Raw call rather than git(): a failed push should keep git's own words,
    // which are the only thing that can say WHY a push keeps failing. Luke's
    // Recognition brain reported "can't push your changes up" for three days
    // (2026-08-01 to 04) and nothing anywhere carried the underlying error.
    const pushR = await withAuthenticatedRemote(() => runGitRaw(['push'], true));
    if (!pushR.ok) {
      // Most often a race: someone pushed between our fetch and our push. Next
      // tick re-classifies as behind and auto-merges, so this self-heals. Only a
      // persistent failure (ESCALATE_AFTER in a row) stabilises as stuck.
      console.error(`  git push -> ${pushR.err}`);
      console.log(`[${ts()}]   push failed; will retry next tick`);
      stopStuck('can\'t push your changes up', pushR.err || 'push failed, usually a brief race or offline');
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
      // This reason is rendered straight into the tray status line and tooltip,
      // which are otherwise branded from the app's own name. Naming the product
      // here was the one string that put "Agency Brain" in a client's menu bar.
      writeState('stop', 'Your sign-in has expired. Open the app in your menu bar and choose "Reconnect / sign in again"', { authExpired: true });
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
ensureOfficeLockExclude();
installPrecommitSizeHook();
writeState('running', 'starting up');

// Role-scoped section mounts (the leadership annex): reconciled after each
// sync cycle by watcher/section-sync.js. The server's git-token answer names
// which sections THIS member gets ([] for everyone else); granted mounts are
// excluded from the shared repo, cloned, and synced with the same scoped
// token. Agency mode only — personal brains have no token broker.
let sectionSync = null;
if (MODE === 'agency') {
  try {
    sectionSync = require('./section-sync').create({
      repoPath: REPO,
      getAuth: async () => {
        const token = await getGitToken();
        return { token, sections: (tokenCache && tokenCache.sections) || [] };
      },
      log: (m) => console.log(`[${ts()}] ${m}`),
    });
  } catch (e) {
    console.error(`[${ts()}] section-sync failed to start: ${e.message}`);
  }
}

chokidar.watch(REPO, {
  // Section mounts are their own repos on their own cadence — keep the main
  // watcher's debounce off them.
  // `~$` used to sit here unescaped, where $ is the end-of-string anchor, so it
  // matched a path ENDING in a tilde and never once matched what it was written
  // for: Word/Excel/PowerPoint lock files (~$budget.xlsx). Those churn into
  // existence and vanish while a document is open, so every agency has been
  // syncing them and racing git against files that delete themselves.
  ignored: (p) => /(^|[\/\\])(\.git|node_modules|\.DS_Store|\.swp|~\$)/.test(p)
    || (sectionSync !== null && sectionSync.ownsPath(p)),
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
}).on('all', (event, filepath) => {
  console.log(`[${ts()}]   ${event}: ${path.relative(REPO, filepath)}`);
  scheduleDebouncedSync();
});

// Phone-dispatch poller rides the sync cadence: notes only ever arrive from
// origin, and doSync just fetched it, so checking right after costs one
// ls-tree. The poller never touches git's network side (agency-mode fetches
// need the app's token plumbing, which doSync owns).
let dispatchPoller = null;
if (DISPATCH_ENABLED) {
  try {
    dispatchPoller = require('./dispatch-poller').create({ repoPath: REPO, log: (m) => console.log(`[${ts()}] ${m}`) });
    console.log(`[${ts()}] phone-dispatch: ON — watching origin for !dispatch- notes`);
  } catch (e) {
    console.error(`[${ts()}] phone-dispatch failed to start: ${e.message}`);
  }
}
const afterSync = () => {
  if (sectionSync) sectionSync.tick().catch((e) => console.error(`[${ts()}] section tick error: ${e.message}`));
  if (dispatchPoller) { try { dispatchPoller.check(); } catch (e) { console.error(`[${ts()}] dispatch check error: ${e.message}`); } }
};

setInterval(() => doSync('interval').then(afterSync).catch(() => {}), PULL_INTERVAL_MS);
doSync('startup').then(afterSync).catch(() => {});

process.on('SIGINT', () => { console.log(`\n[${ts()}] stopped.`); writeState('stop', 'sigint'); process.exit(0); });
process.on('SIGTERM', () => { console.log(`\n[${ts()}] stopped.`); writeState('stop', 'sigterm'); process.exit(0); });
