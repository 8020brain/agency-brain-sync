#!/usr/bin/env node
'use strict';
/*
 * Git credential helper tests — the helper script's protocol behaviour against
 * a throwaway local API server, and the installer's repo registration against
 * a throwaway git repo. No network, no Electron, real modules only.
 *
 *   node tests/git-credential.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const { registerRepo, helperConfigValue, shQuote } = require('../lib/git-credential.cjs');

const HELPER = path.join(__dirname, '..', 'lib', 'git-credential-helper.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Async spawn, NOT spawnSync: the throwaway API server runs in this process,
// and spawnSync would block the event loop so the server could never answer.
function runAsync(file, args, { stdin, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin || '');
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cred-test-'));
  // Layout mirrors userData: config.json at the root, helper in bin/.
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  const helperCopy = path.join(binDir, 'credential-helper.js');
  fs.copyFileSync(HELPER, helperCopy);
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    mode: 'agency', teamSlug: 'acme', memberToken: 'member-jwt-active',
    brains: [{ mode: 'agency', teamSlug: 'other-co', brainPath: '/x', memberToken: 'member-jwt-archived' }],
  }));

  // Throwaway API: mints for the active team, 401s for the archived one.
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      requests.push({ auth: req.headers.authorization, body: json });
      if (req.headers.authorization === 'Bearer member-jwt-archived') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired session' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: 'ghs_testtoken123', expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { BRAIN_SYNC_API_BASE: base };

  console.log('helper protocol:');
  const runCopy = (args, stdin) => runAsync(helperCopy, args, { stdin, env });

  let r = await runCopy(['--team', 'acme', 'store'], 'username=x\npassword=y\n\n');
  check('store is a no-op, exit 0', r.status === 0 && r.stdout === '' && r.stderr === '');

  r = await runCopy(['--team', 'acme', 'erase'], 'host=github.com\n\n');
  check('erase is a no-op, exit 0', r.status === 0 && r.stdout === '');

  r = await runCopy(['--team', 'acme', 'get'], 'protocol=https\nhost=gitlab.com\n\n');
  check('foreign host: silent exit 0', r.status === 0 && r.stdout === '');

  r = await runCopy(['--team', 'acme', 'get'], 'protocol=https\nhost=github.com\n\n');
  check('get mints and prints credentials', r.status === 0
    && r.stdout.includes('username=x-access-token') && r.stdout.includes('password=ghs_testtoken123'), r.stderr);
  check('mint carried the member token + source=helper',
    requests.length === 1 && requests[0].auth === 'Bearer member-jwt-active'
    && requests[0].body.source === 'helper' && requests[0].body.teamSlug === 'acme');

  const cacheFile = path.join(binDir, 'token-cache-acme.json');
  check('token cached 0600', fs.existsSync(cacheFile)
    && (fs.statSync(cacheFile).mode & 0o777) === 0o600);

  r = await runCopy(['--team', 'acme', 'get'], 'protocol=https\nhost=github.com\n\n');
  check('second get served from cache (no new mint)', r.status === 0
    && r.stdout.includes('password=ghs_testtoken123') && requests.length === 1);

  r = await runCopy(['--team', 'other-co', 'get'], 'protocol=https\nhost=github.com\n\n');
  check('archived profile resolved from brains[]', requests.length === 2
    && requests[1].auth === 'Bearer member-jwt-archived');
  check('401 gives sign-in message, exit 1', r.status === 1
    && r.stderr.includes('sign in again'), r.stderr);

  r = await runCopy(['--team', 'nobody', 'get'], 'protocol=https\nhost=github.com\n\n');
  check('unknown team gives sign-in message, exit 1', r.status === 1 && r.stderr.includes('sign in'));

  // Network down: kill the server; a live cached token must still be served.
  await new Promise((res) => server.close(res));
  const other = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  fs.writeFileSync(cacheFile, JSON.stringify({ token: other.token, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }));
  r = await runCopy(['--team', 'acme', 'get'], 'protocol=https\nhost=github.com\n\n');
  check('API down: falls back to still-live cached token', r.status === 0
    && r.stdout.includes('password=ghs_testtoken123'), r.stderr);
  fs.writeFileSync(cacheFile, JSON.stringify({ token: other.token, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  r = await runCopy(['--team', 'acme', 'get'], 'protocol=https\nhost=github.com\n\n');
  check('API down + expired cache: clear error, exit 1', r.status === 1
    && r.stderr.includes("can't reach"), r.stderr);

  console.log('installer:');
  check('shQuote escapes single quotes', shQuote("a'b") === `'a'\\''b'`);
  const value = helperConfigValue('/Applications/Agency Brain.app/Contents/MacOS/Agency Brain', helperCopy, 'acme');
  check('config value shape', value.startsWith('!ELECTRON_RUN_AS_NODE=1 ') && value.includes("--team 'acme'"));

  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
  check('registerRepo returns true', registerRepo(repo, value) === true);
  const got = spawnSync('git', ['-C', repo, 'config', '--local', '--get-all', 'credential.helper'], { encoding: 'utf8' });
  const entries = got.stdout.replace(/\n$/, '').split('\n');
  check('two entries: empty then helper', entries.length === 2 && entries[0] === '' && entries[1] === value, JSON.stringify(entries));
  check('registerRepo is idempotent', registerRepo(repo, value) === true
    && spawnSync('git', ['-C', repo, 'config', '--local', '--get-all', 'credential.helper'], { encoding: 'utf8' }).stdout.replace(/\n$/, '').split('\n').length === 2);
  check('registerRepo refuses a non-repo', registerRepo(path.join(tmp, 'nope'), value) === false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
