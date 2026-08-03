'use strict';
/*
 * Installs and registers the git credential helper (lib/git-credential-helper.js)
 * for every agency brain clone on this machine, so git run OUTSIDE the app
 * (terminal, Claude Code in Cursor) always gets a live installation token
 * instead of the stale keychain side-effect cache it depended on before
 * (The Digital Stride, 2026-07-23).
 *
 * Called from startWatcher() on every agency-mode start, so it self-heals:
 * a deleted bin script, a wiped .git/config, or a moved app all repair on the
 * next launch. Everything here is best-effort and must never block syncing.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HELPER_SRC = path.join(__dirname, 'git-credential-helper.js');

// Single-quote a string for the sh command line git runs `!`-helpers with.
// git-for-windows executes these through its bundled sh too, so the same
// quoting works on both platforms.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function helperConfigValue(exePath, helperPath, teamSlug) {
  // Forward slashes keep Windows paths unambiguous inside sh single quotes.
  const exe = process.platform === 'win32' ? exePath.replace(/\\/g, '/') : exePath;
  const helper = process.platform === 'win32' ? helperPath.replace(/\\/g, '/') : helperPath;
  return `!ELECTRON_RUN_AS_NODE=1 ${shQuote(exe)} ${shQuote(helper)} --team ${shQuote(teamSlug)}`;
}

// Copy the helper out of the app bundle (fs reads through asar) into
// <userData>/bin, where it survives app updates and has a stable path.
function installHelperScript(userData) {
  const binDir = path.join(userData, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, 'credential-helper.js');
  const src = fs.readFileSync(HELPER_SRC, 'utf8');
  let current = null;
  try { current = fs.readFileSync(dest, 'utf8'); } catch (_) { /* first install */ }
  if (current !== src) fs.writeFileSync(dest, src);
  try { fs.chmodSync(dest, 0o755); } catch (_) { /* not fatal */ }
  return dest;
}

// Repo-local registration, two entries: an EMPTY helper first (git's documented
// way to clear the inherited helper list, which is what stops osxkeychain /
// git-credential-manager ever being consulted for this repo), then ours.
function registerRepo(repoPath, value, env) {
  if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) return false;
  // env comes from the caller (main.js passes enrichedEnv()) so git resolves on
  // GUI-launched apps and on Windows machines running the app-managed MinGit —
  // a bare spawnSync here inherits Finder/Explorer's minimal PATH and fails
  // silently, leaving every out-of-app push on the machine's stale helper.
  const spawnOpts = env ? { env } : {};
  const desired = ['', value];
  const got = spawnSync('git', ['-C', repoPath, 'config', '--local', '--get-all', 'credential.helper'], { encoding: 'utf8', ...spawnOpts });
  const current = got.status === 0 ? (got.stdout || '').replace(/\n$/, '').split('\n') : [];
  if (JSON.stringify(current) === JSON.stringify(desired)) return true;
  spawnSync('git', ['-C', repoPath, 'config', '--local', '--unset-all', 'credential.helper'], spawnOpts);
  spawnSync('git', ['-C', repoPath, 'config', '--local', '--add', 'credential.helper', ''], spawnOpts);
  const add = spawnSync('git', ['-C', repoPath, 'config', '--local', '--add', 'credential.helper', value], spawnOpts);
  return add.status === 0;
}

// One-time macOS cleanup of the legacy frozen keychain entry. Only the
// x-access-token account (only ever an installation token) — a member's own
// PATs or personal credentials live under other account names and are never
// touched. With the empty-helper reset above the entry is unreachable for the
// brain repo anyway; this just stops it confusing anyone again.
function cleanupKeychain(userData) {
  if (process.platform !== 'darwin') return;
  const marker = path.join(userData, 'bin', '.keychain-cleaned');
  if (fs.existsSync(marker)) return;
  for (let i = 0; i < 5; i++) {
    const r = spawnSync('security', ['delete-internet-password', '-s', 'github.com', '-a', 'x-access-token'], { stdio: 'ignore' });
    if (r.status !== 0) break; // not found (or blocked): stop, never loop
  }
  try { fs.writeFileSync(marker, `${new Date().toISOString()}\n`); } catch (_) { /* retry next launch */ }
}

// opts: { userData, exePath, env }
function ensureCredentialHelper(config, opts) {
  try {
    if (!config || config.mode !== 'agency') return;
    const helperPath = installHelperScript(opts.userData);
    const profiles = [];
    if (config.brainPath && config.teamSlug) profiles.push({ brainPath: config.brainPath, teamSlug: config.teamSlug });
    for (const b of config.brains || []) {
      if (b && b.mode === 'agency' && b.brainPath && b.teamSlug) profiles.push(b);
    }
    const seen = new Set();
    for (const p of profiles) {
      if (seen.has(p.brainPath)) continue;
      seen.add(p.brainPath);
      registerRepo(p.brainPath, helperConfigValue(opts.exePath, helperPath, p.teamSlug), opts.env);
    }
    cleanupKeychain(opts.userData);
  } catch (err) {
    console.error('credential-helper install failed:', err.message);
  }
}

module.exports = { ensureCredentialHelper, installHelperScript, registerRepo, helperConfigValue, cleanupKeychain, shQuote };
