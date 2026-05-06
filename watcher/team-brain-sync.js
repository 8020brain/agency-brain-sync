#!/usr/bin/env node
// Brain Sync watcher.
// Watches a git folder and keeps it in sync with origin.
// Pulls every minute. Commits and pushes 30s after the last local change.
//
// Two modes, selected by BRAIN_SYNC_MODE env var:
//
//   personal   — uses the user's existing system git credentials, the same
//                way Brain Sync v0.2 worked. No API calls.
//
//   agency     — mints fresh GitHub App installation tokens from
//                api.ads2ai.com on each git operation. Embeds the token
//                in the remote URL temporarily, then restores the clean
//                URL. Token never persists between operations.
//                Also reads .team-config/roles.json from the working tree
//                and refuses to push changes outside the local member's
//                allowed paths.

const chokidar = require('chokidar');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = process.env.BRAIN_PATH;
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '30000', 10);
const PULL_INTERVAL_MS = parseInt(process.env.PULL_INTERVAL_MS || '60000', 10);
const MODE = process.env.BRAIN_SYNC_MODE || 'personal';
const API_BASE = process.env.AGENCY_API_BASE || 'https://api.ads2ai.com';
const MEMBER_TOKEN = process.env.AGENCY_MEMBER_TOKEN || '';
const TEAM_SLUG = process.env.AGENCY_TEAM_SLUG || '';
const MEMBER_EMAIL = (process.env.AGENCY_MEMBER_EMAIL || '').toLowerCase();
const MEMBER_ROLE_HINT = process.env.AGENCY_MEMBER_ROLE || 'team';

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
  // Refresh ~10 minutes before expiry to avoid edge cases.
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
  // git remote set-url is atomic, so the brief presence of the token in
  // .git/config is bounded to the duration of the action.
  git(`remote set-url origin "${authed}"`);
  try {
    return await fn();
  } finally {
    git(`remote set-url origin "${original}"`);
  }
}

// ───── Role-based path filter ─────

const ROLE_RULES = {
  // Each role maps to an array of allowed write-path prefixes (relative to repo root).
  // null = full RW (no filter).
  owner: null,
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
    // team-role members write only to their own personal/<self>/ folder, but
    // personal/ is gitignored anyway, so practically: nothing reaches the
    // remote from a team member. We still allow CLAUDE.md / context updates
    // since collaborative editing is the point.
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
  if (norm === 'owner' || norm === 'head-scout') return null; // no filter
  if (norm === 'scout') return ROLE_RULES.scout;
  return ROLE_RULES.team;
}

function pathIsAllowed(relPath, allow) {
  if (allow === null) return true; // owner / head_scout
  return allow.some((prefix) => relPath === prefix || relPath.startsWith(prefix));
}

// ───── Sync ─────

async function commitAndPush() {
  if (syncing) return;
  syncing = true;
  try {
    const status = git('status --porcelain');
    if (!status) return;

    let toAdd = [];
    if (MODE === 'agency') {
      const role = currentRole();
      const allow = allowedPathsForRole(role);
      const lines = status.split('\n').filter(Boolean);
      const skipped = [];
      for (const line of lines) {
        // Porcelain format: "XY filename"; rename: "XY oldname -> newname"
        const file = line.slice(3).split(' -> ').pop();
        if (pathIsAllowed(file, allow)) toAdd.push(file);
        else skipped.push(file);
      }
      if (skipped.length) {
        console.log(`[${ts()}] role=${role} skipping ${skipped.length} path(s) outside allowed list:`);
        for (const f of skipped.slice(0, 10)) console.log(`    - ${f}`);
        if (skipped.length > 10) console.log(`    (and ${skipped.length - 10} more)`);
      }
      if (!toAdd.length) {
        console.log(`[${ts()}] nothing to push for role=${role}`);
        return;
      }
    }

    console.log(`[${ts()}] changes detected, syncing...`);

    if (MODE === 'agency') {
      // Stage only allowed paths
      for (const f of toAdd) {
        git(`add -- "${f.replace(/"/g, '\\"')}"`);
      }
    } else {
      git('add -A');
    }

    git(`commit -m "auto-sync: ${ts()}"`);

    const result = await withAuthenticatedRemote(() => git('push'));
    if (result === null) {
      console.log(`[${ts()}] push failed; will retry on next change or pull.`);
    } else {
      console.log(`[${ts()}] pushed.`);
    }
  } catch (err) {
    console.error(`[${ts()}] sync error: ${err.message}`);
  } finally {
    syncing = false;
  }
}

async function pullLatest() {
  if (syncing) return;
  syncing = true;
  try {
    const result = await withAuthenticatedRemote(() => git('pull --rebase --autostash'));
    if (result && !result.includes('Already up to date')) {
      console.log(`[${ts()}] pulled: ${result.split('\n')[0]}`);
    }
  } catch (err) {
    console.error(`[${ts()}] pull error: ${err.message}`);
  } finally {
    syncing = false;
  }
}

function scheduleSync() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => commitAndPush().catch(() => {}), DEBOUNCE_MS);
}

console.log(`[${ts()}] watching ${REPO}`);
console.log(`[${ts()}] mode=${MODE} debounce=${DEBOUNCE_MS / 1000}s pull-every=${PULL_INTERVAL_MS / 1000}s`);
if (MODE === 'agency') {
  console.log(`[${ts()}] team=${TEAM_SLUG} member=${MEMBER_EMAIL} role-hint=${MEMBER_ROLE_HINT}`);
}

chokidar.watch(REPO, {
  ignored: (p) => /(^|[\/\\])(\.git|node_modules|\.DS_Store|\.swp|~$)/.test(p),
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
}).on('all', (event, filepath) => {
  console.log(`[${ts()}]   ${event}: ${path.relative(REPO, filepath)}`);
  scheduleSync();
});

setInterval(() => pullLatest().catch(() => {}), PULL_INTERVAL_MS);
pullLatest().catch(() => {});

process.on('SIGINT', () => { console.log(`\n[${ts()}] stopped.`); process.exit(0); });
