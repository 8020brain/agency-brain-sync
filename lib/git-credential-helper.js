#!/usr/bin/env node
'use strict';
/*
 * Agency Brain git credential helper.
 *
 * The app copies this file to <userData>/bin/credential-helper.js and registers
 * it repo-locally in each brain clone as:
 *
 *   credential.helper =            (empty — clears inherited helpers, so the
 *                                   OS keychain is never consulted for the repo)
 *   credential.helper = !ELECTRON_RUN_AS_NODE=1 '<app exe>' '<this file>' --team '<slug>'
 *
 * Git then invokes it for ANY git process touching the brain repo (terminal,
 * Claude Code in Cursor, an editor) with get/store/erase appended. On `get` it
 * answers with a fresh GitHub App installation token minted from the same API
 * endpoint the sync watcher uses, so out-of-app git always has live
 * credentials instead of the stale keychain side-effect cache it relied on
 * before (The Digital Stride, 2026-07-23). `store` and `erase` are no-ops:
 * tokens are never persisted by git again.
 *
 * Runs under ELECTRON_RUN_AS_NODE (the app binary as plain node). Only node
 * builtins — no electron, no dependencies. The token is written ONLY to
 * stdout (git's protocol) and a 0600 cache file next to this script; it must
 * never be logged or put in argv.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.BRAIN_SYNC_API_BASE || 'https://api.ads2ai.com';
const CUSHION_MS = 10 * 60 * 1000; // reuse a cached token until 10 min before expiry
const MINT_TIMEOUT_MS = 15000;

function fail(msg) {
  process.stderr.write(`Agency Brain: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let team = null;
  let op = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--team') team = argv[++i];
    else op = argv[i];
  }
  return { team, op };
}

function parseStdin() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { /* no stdin: attrs stay empty */ }
  const attrs = {};
  for (const line of raw.split('\n')) {
    if (!line) break; // blank line ends the attribute list
    const eq = line.indexOf('=');
    if (eq > 0) attrs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return attrs;
}

// bin/ sits inside the app's userData folder, next to config.json.
function loadProfile(team) {
  const configPath = path.join(__dirname, '..', 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return null; }
  if (cfg.teamSlug === team && cfg.memberToken) return { memberToken: cfg.memberToken };
  for (const b of cfg.brains || []) {
    if (b.teamSlug === team && b.memberToken) return { memberToken: b.memberToken };
  }
  return null;
}

function cachePath(team) {
  return path.join(__dirname, `token-cache-${team.replace(/[^a-z0-9-]/gi, '_')}.json`);
}

function readCache(team) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(team), 'utf8'));
    if (c && c.token && c.expiresAt) return { token: c.token, expiresAt: new Date(c.expiresAt).getTime() };
  } catch (_) { /* absent or unreadable: mint fresh */ }
  return null;
}

function writeCache(team, token, expiresAt) {
  const p = cachePath(team);
  try {
    fs.writeFileSync(p, JSON.stringify({ token, expiresAt }), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  } catch (_) { /* cache is an optimisation, never fatal */ }
}

function output(token) {
  process.stdout.write(`username=x-access-token\npassword=${token}\n`);
}

async function mint(team, memberToken) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINT_TIMEOUT_MS);
  try {
    const r = await fetch(`${API_BASE}/api/team-brain/git-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({ teamSlug: team, source: 'helper' }),
      signal: ctrl.signal,
    });
    if (r.status === 401) return { authExpired: true };
    if (!r.ok) return { error: `server returned ${r.status}` };
    const json = await r.json();
    if (!json.token || !json.expiresAt) return { error: 'server response missing token' };
    return { token: json.token, expiresAt: new Date(json.expiresAt).getTime() };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'request timed out' : (err.message || 'network error') };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { team, op } = parseArgs(process.argv.slice(2));
  if (op !== 'get') process.exit(0); // store + erase: deliberate no-ops
  const attrs = parseStdin();
  if (attrs.host && attrs.host !== 'github.com') process.exit(0);
  if (!team) fail('credential helper is misconfigured (no team). Reopen the Agency Brain app to repair it.');

  const cached = readCache(team);
  if (cached && cached.expiresAt - Date.now() > CUSHION_MS) {
    output(cached.token);
    process.exit(0);
  }

  const profile = loadProfile(team);
  if (!profile) fail('open the Agency Brain app and sign in again to restore GitHub access.');

  const minted = await mint(team, profile.memberToken);
  if (minted.token) {
    writeCache(team, minted.token, minted.expiresAt);
    output(minted.token);
    process.exit(0);
  }
  if (minted.authExpired) fail('open the Agency Brain app and sign in again to restore GitHub access.');
  // Network / server trouble: a cached token that hasn't actually expired yet
  // still works even inside the cushion window, so prefer it over failing.
  if (cached && cached.expiresAt - Date.now() > 0) {
    output(cached.token);
    process.exit(0);
  }
  fail(`can't reach api.ads2ai.com to refresh GitHub access (${minted.error}). Check your connection and try again.`);
}

main();
