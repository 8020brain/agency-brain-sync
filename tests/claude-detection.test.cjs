#!/usr/bin/env node
/**
 * Windows Claude Desktop detection tests — run the REAL findClaudeWindows() source
 * from main.js against throwaway temp dirs that mimic each install layout. The
 * source text is lifted straight out of main.js (same trick as
 * config-recovery.test.cjs), so a regression there fails this test without pulling
 * in Electron.
 *
 *   node tests/claude-detection.test.cjs
 *
 * Why this exists (Mike, LWJ client brain, 2026-08-13): step 2 of the setup
 * wizard ("Checking what you've got", v1.1.24) reported "Claude desktop app: not
 * found" on Windows machines that had the app and used it daily. The old check
 * looked at two hardcoded exe paths and missed the packagings Claude actually
 * ships in — the MSIX/Store app-execution alias in WindowsApps, and the Squirrel
 * versioned app-<ver> subfolder — so a member read "not found", believed it, and
 * told her client to download an app she'd had for weeks.
 */

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');

// Lift the named top-level function out of main.js by source text (its body ends
// with a closing brace at column 0).
function extract(name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `main.js no longer defines ${name}() — did it get renamed?`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const end = src.indexOf('\n}', start);
  assert.ok(end !== -1, `couldn't find the end of ${name}()`);
  return src.slice(start, end + 2);
}
const make = new Function('fs', 'path', `${extract('findClaudeWindows')}\nreturn findClaudeWindows;`);
const findClaudeWindows = make(fs, path);

// Point the env the function reads at a throwaway root, run it, restore the env.
function withEnv({ local, roaming, programFiles }, fn) {
  const saved = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    ProgramFiles: process.env.ProgramFiles,
    pf86: process.env['ProgramFiles(x86)'],
  };
  process.env.LOCALAPPDATA = local || '';
  process.env.APPDATA = roaming || '';
  process.env.ProgramFiles = programFiles || '';
  delete process.env['ProgramFiles(x86)'];
  try { return fn(); }
  finally {
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
    process.env.APPDATA = saved.APPDATA;
    process.env.ProgramFiles = saved.ProgramFiles;
    if (saved.pf86 === undefined) delete process.env['ProgramFiles(x86)'];
    else process.env['ProgramFiles(x86)'] = saved.pf86;
  }
}

function touch(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

let passed = 0;
const queue = [];
function check(label, fn) { queue.push({ label, fn }); }

// Each case builds a fresh Local/Roaming/ProgramFiles tree, so signals never bleed
// between tests (the detector checks in priority order).
function fixture(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-claude-'));
  const dirs = {
    local: path.join(root, 'Local'),
    roaming: path.join(root, 'Roaming'),
    programFiles: path.join(root, 'ProgramFiles'),
  };
  mkdir(dirs.local); mkdir(dirs.roaming); mkdir(dirs.programFiles);
  build(dirs);
  return { root, dirs };
}

// The reported bug: an MSIX/Store install (WindowsApps alias) must read installed.
check('MSIX WindowsApps alias is detected', () => {
  const { root, dirs } = fixture((d) => touch(path.join(d.local, 'Microsoft', 'WindowsApps', 'Claude.exe')));
  try {
    const r = withEnv(dirs, () => findClaudeWindows());
    assert.ok(r && /WindowsApps/i.test(r.path), 'expected a WindowsApps hit, got ' + JSON.stringify(r));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('MSIX package data folder is detected', () => {
  const { root, dirs } = fixture((d) => mkdir(path.join(d.local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache')));
  try {
    const r = withEnv(dirs, () => findClaudeWindows());
    assert.ok(r && /Packages[\\/]Claude_/i.test(r.path), 'expected a Packages hit, got ' + JSON.stringify(r));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('Squirrel versioned app-<ver> exe is detected and its version parsed', () => {
  const { root, dirs } = fixture((d) => {
    touch(path.join(d.local, 'AnthropicClaude', 'app-0.9.0', 'claude.exe'));
    touch(path.join(d.local, 'AnthropicClaude', 'app-1.2.3', 'claude.exe'));
    touch(path.join(d.local, 'AnthropicClaude', 'Update.exe'));
  });
  try {
    const r = withEnv(dirs, () => findClaudeWindows());
    assert.ok(r, 'expected a hit');
    assert.strictEqual(r.version, '1.2.3', 'expected the newest app-<ver>, got ' + JSON.stringify(r));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('Squirrel install with only Update.exe still reads installed', () => {
  const { root, dirs } = fixture((d) => touch(path.join(d.local, 'AnthropicClaude', 'Update.exe')));
  try {
    const r = withEnv(dirs, () => findClaudeWindows());
    assert.ok(r && /AnthropicClaude/i.test(r.path), 'expected an AnthropicClaude hit, got ' + JSON.stringify(r));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('plain per-user Programs\\claude exe is detected', () => {
  const { root, dirs } = fixture((d) => touch(path.join(d.local, 'Programs', 'claude', 'Claude.exe')));
  try {
    const r = withEnv(dirs, () => findClaudeWindows());
    assert.ok(r && /Programs/i.test(r.path), 'expected a Programs hit, got ' + JSON.stringify(r));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('roaming config file is a last-resort signal', () => {
  const { root, dirs } = fixture((d) => touch(path.join(d.roaming, 'Claude', 'claude_desktop_config.json')));
  try {
    const r = withEnv(dirs, () => findClaudeWindows());
    assert.ok(r && /Roaming[\\/]Claude/i.test(r.path), 'expected a roaming hit, got ' + JSON.stringify(r));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('nothing installed returns null (no false positive)', () => {
  const { root, dirs } = fixture(() => {});
  try {
    const r = withEnv(dirs, () => findClaudeWindows());
    assert.strictEqual(r, null, 'expected null on an empty machine, got ' + JSON.stringify(r));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A bare roaming Claude folder with NO config file must not count — that lingers
// after uninstall and would resurrect the false-positive direction.
check('an empty roaming Claude folder alone is not enough', () => {
  const { root, dirs } = fixture((d) => mkdir(path.join(d.roaming, 'Claude')));
  try {
    const r = withEnv(dirs, () => findClaudeWindows());
    assert.strictEqual(r, null, 'expected null for a config-less roaming folder, got ' + JSON.stringify(r));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log('claude detection (windows)');
let failed = 0;
for (const { label, fn } of queue) {
  try { fn(); console.log(`  ok  ${label}`); passed++; }
  catch (e) { console.error(`  FAIL  ${label}\n        ${e.message}`); failed++; process.exitCode = 1; }
}
console.log(`\n${passed}/${queue.length} passed${failed ? ' — SOME FAILED' : ''}`);
