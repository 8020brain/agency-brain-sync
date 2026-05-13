#!/usr/bin/env node
// Brain Sync watcher.
// Watches a git folder and keeps it in sync with origin.
// Pulls every 60s. Commits and pushes 90s after the last local change.
//
// Conflict handling: classify-don't-coerce. The watcher classifies repo
// state on every tick and STOPs on any ambiguity. Never stashes, never
// rebases the working tree, never resets. The 2026-04-24 data-loss
// incident is the reason; see projects/agencybrain/8020sync-build-log.md.
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
//                and STOPs (does not push) when changes touch paths outside
//                the local member's role allow-list.

const chokidar = require('chokidar');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = process.env.BRAIN_PATH;
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '90000', 10);
const PULL_INTERVAL_MS = parseInt(process.env.PULL_INTERVAL_MS || '60000', 10);
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

function git(cmd) {
  try {
    return execSync(`git -C "${REPO}" ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString().trim();
    console.error(`  git ${cmd} -> ${msg}`);
    return null;
  }
}

// ───── Observable state for the tray ─────

// Written atomically when state changes so main.js can poll/watch the file
// and update the tray icon (green/orange/red).
function writeState(state, reason) {
  if (!STATE_FILE) return;
  const payload = {
    state, // 'running' | 'pulling' | 'pushing' | 'stop'
    reason: reason || null,
    updatedAt: new Date().toISOString(),
    mode: MODE,
  };
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, STATE_FILE);
  } catch (_) { /* best-effort */ }
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

const ROLE_RULES = {
  owner: null, // no filter
  scout: [
    '.claude/',
    'context/',
    'clients/',
    'data/',
    'projects/',
    'todo/',
    'plans/',
    'templates/',
    'README.md',
    'CLAUDE.md',
  ],
  team: [
    'context/',
    'clients/',
    'data/',
    'projects/',
    'todo/',
    'plans/',
  ],
};

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

function allowedPathsForRole(role) {
  const norm = (role || '').toLowerCase().replace(/_/g, '-');
  if (norm === 'owner' || norm === 'head-scout') return null;
  if (norm === 'scout') return ROLE_RULES.scout;
  return ROLE_RULES.team;
}

function pathIsAllowed(relPath, allow) {
  if (allow === null) return true;
  return allow.some((prefix) => relPath === prefix || relPath.startsWith(prefix));
}

// ───── Mid-operation guard ─────

function midOperation() {
  const gitDir = path.join(REPO, '.git');
  if (fs.existsSync(path.join(gitDir, 'rebase-merge'))) return 'rebase';
  if (fs.existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebase';
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  return null;
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

  const branch = git('rev-parse --abbrev-ref HEAD');
  if (!branch) return { state: 'unknown' };

  const localSha = git(`rev-parse ${branch}`);
  const remoteSha = git(`rev-parse origin/${branch}`);
  if (!localSha || !remoteSha) return { state: 'unknown', branch };

  if (localSha === remoteSha) {
    return dirty
      ? { state: 'dirty_in_sync', branch, statusLines: status.split('\n').filter(Boolean) }
      : { state: 'clean_in_sync', branch };
  }

  const ab = git(`rev-list --left-right --count ${branch}...origin/${branch}`);
  if (!ab) return { state: 'unknown', branch };
  const [ahead, behind] = ab.split(/\s+/).map(Number);

  if (ahead === 0 && behind > 0) {
    return dirty
      ? { state: 'dirty_remote_ahead', branch, behind, statusLines: status.split('\n').filter(Boolean) }
      : { state: 'clean_remote_ahead', branch, behind };
  }
  if (ahead > 0 && behind === 0) {
    return { state: 'local_ahead', branch, ahead, dirty, statusLines: status.split('\n').filter(Boolean) };
  }
  if (ahead > 0 && behind > 0) {
    return { state: 'diverged', branch, ahead, behind, dirty };
  }
  return { state: 'unknown', branch };
}

// ───── Push lane ─────

async function pushChanges(s) {
  // s.statusLines come from porcelain output. Parse files we need to stage.
  // Format: "XY filename"; rename: "XY oldname -> newname"
  const files = (s.statusLines || []).map((line) => line.slice(3).split(' -> ').pop());

  if (MODE === 'agency') {
    const role = currentRole();
    const allow = allowedPathsForRole(role);
    const violations = files.filter((f) => !pathIsAllowed(f, allow));
    if (violations.length) {
      console.log(`[${ts()}] STOP: role=${role} cannot push protected path(s):`);
      for (const f of violations.slice(0, 10)) console.log(`    - ${f}`);
      if (violations.length > 10) console.log(`    (and ${violations.length - 10} more)`);
      console.log(`[${ts()}]   leaving changes in working tree; resolve the protected file(s) and the sync will resume`);
      writeState('stop', `role=${role} cannot push: ${violations[0]}${violations.length > 1 ? ` (+${violations.length - 1} more)` : ''}`);
      // Unstage anything that might already be staged so the user has a clean canvas
      git('reset HEAD');
      return;
    }
  }

  if (!files.length) {
    writeState('running', 'nothing to push');
    return;
  }

  writeState('pushing');
  git('add -A');
  const commitMsg = `auto-sync: ${ts()}`;
  const commitResult = git(`commit -m "${commitMsg}"`);
  if (commitResult === null) {
    console.log(`[${ts()}]   commit failed; unstaging`);
    git('reset HEAD');
    writeState('stop', 'commit failed');
    return;
  }
  console.log(`[${ts()}]   committed ${files.length} file(s)`);

  const pushResult = await withAuthenticatedRemote(() => git('push'));
  if (pushResult === null) {
    console.log(`[${ts()}]   push failed; will retry next tick`);
    writeState('stop', 'push failed');
  } else {
    console.log(`[${ts()}]   pushed.`);
    writeState('running');
  }
}

// ───── Main sync function ─────

async function doSync(trigger) {
  if (syncing) return;
  syncing = true;
  try {
    const mid = midOperation();
    if (mid) {
      console.log(`[${ts()}] STOP: mid-${mid} in progress; manual resolution needed`);
      writeState('stop', `mid-${mid}`);
      return;
    }

    writeState('pulling');
    const s = await classifyState();

    if (s.state === 'fetch_failed') {
      console.log(`[${ts()}] ${trigger}: fetch failed -- ${s.detail}`);
      writeState('stop', 'fetch failed');
      return;
    }
    if (s.state === 'clean_in_sync') {
      if (trigger !== 'interval') console.log(`[${ts()}] ${trigger}: clean, in sync`);
      writeState('running');
      return;
    }
    if (s.state === 'clean_remote_ahead') {
      console.log(`[${ts()}] ${trigger}: remote ahead by ${s.behind}; fast-forwarding`);
      const r = git(`merge --ff-only origin/${s.branch}`);
      if (r === null) {
        console.log(`[${ts()}]   ff-only failed`);
        writeState('stop', 'fast-forward failed');
      } else {
        console.log(`[${ts()}]   fast-forwarded`);
        writeState('running');
      }
      return;
    }
    if (s.state === 'dirty_remote_ahead') {
      console.log(`[${ts()}] STOP: ${trigger}: local changes AND remote moved (${s.behind} ahead); resolve manually`);
      writeState('stop', `local changes plus ${s.behind} new remote commit(s) — resolve manually`);
      return;
    }
    if (s.state === 'diverged') {
      console.log(`[${ts()}] STOP: ${trigger}: diverged (ahead ${s.ahead}, behind ${s.behind}); resolve manually`);
      writeState('stop', `diverged: ahead ${s.ahead}, behind ${s.behind}`);
      return;
    }
    if (s.state === 'dirty_in_sync' || s.state === 'local_ahead') {
      // Debounce owns push. Interval pushes only as a safety net when
      // no debounce timer is pending (chokidar miss, daemon just started
      // against a pre-existing dirty tree).
      if (trigger === 'interval' && pendingTimer !== null) {
        return;
      }
      console.log(`[${ts()}] ${trigger}: pushing changes`);
      await pushChanges(s);
      return;
    }
    console.log(`[${ts()}] ${trigger}: unrecognised state (${s.state}); skipping`);
    writeState('stop', `unknown state: ${s.state}`);
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

// ───── Boot ─────

console.log(`[${ts()}] watching ${REPO}`);
console.log(`[${ts()}] mode=${MODE} debounce=${DEBOUNCE_MS / 1000}s pull-every=${PULL_INTERVAL_MS / 1000}s`);
if (MODE === 'agency') {
  console.log(`[${ts()}] team=${TEAM_SLUG} member=${MEMBER_EMAIL} role-hint=${MEMBER_ROLE_HINT}`);
}
if (STATE_FILE) console.log(`[${ts()}] state file: ${STATE_FILE}`);
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
