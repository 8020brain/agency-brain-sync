#!/usr/bin/env node
// Team brain sync. Watches a git folder and keeps it in sync with origin.
// Pulls every minute. Commits and pushes 30s after the last local change.

const chokidar = require('chokidar');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = process.env.BRAIN_PATH;
const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '30000', 10);
const PULL_INTERVAL_MS = parseInt(process.env.PULL_INTERVAL_MS || '60000', 10);

if (!REPO) {
  console.error('ERROR: set BRAIN_PATH to the absolute path of the team brain folder.');
  process.exit(1);
}
if (!fs.existsSync(path.join(REPO, '.git'))) {
  console.error(`ERROR: ${REPO} is not a git repository.`);
  process.exit(1);
}

let pendingTimer = null;
let syncing = false;

function git(cmd) {
  try {
    return execSync(`git -C "${REPO}" ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString().trim();
    console.error(`  git ${cmd} -> ${msg}`);
    return null;
  }
}

function ts() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function commitAndPush() {
  if (syncing) return;
  syncing = true;
  try {
    const status = git('status --porcelain');
    if (!status) { syncing = false; return; }
    console.log(`[${ts()}] changes detected, syncing...`);
    git('add -A');
    git(`commit -m "auto-sync: ${ts()}"`);
    const result = git('push');
    if (result === null) {
      console.log(`[${ts()}] push failed; will retry on next change or pull.`);
    } else {
      console.log(`[${ts()}] pushed.`);
    }
  } finally {
    syncing = false;
  }
}

function pullLatest() {
  if (syncing) return;
  syncing = true;
  try {
    const result = git('pull --rebase --autostash');
    if (result && !result.includes('Already up to date')) {
      console.log(`[${ts()}] pulled: ${result.split('\n')[0]}`);
    }
  } finally {
    syncing = false;
  }
}

function scheduleSync() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(commitAndPush, DEBOUNCE_MS);
}

console.log(`[${ts()}] watching ${REPO}`);
console.log(`[${ts()}] debounce ${DEBOUNCE_MS / 1000}s, pull every ${PULL_INTERVAL_MS / 1000}s`);

chokidar.watch(REPO, {
  ignored: (p) => /(^|[\/\\])(\.git|node_modules|\.DS_Store|\.swp|~$)/.test(p),
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
}).on('all', (event, filepath) => {
  console.log(`[${ts()}]   ${event}: ${path.relative(REPO, filepath)}`);
  scheduleSync();
});

setInterval(pullLatest, PULL_INTERVAL_MS);
pullLatest();

process.on('SIGINT', () => { console.log(`\n[${ts()}] stopped.`); process.exit(0); });
