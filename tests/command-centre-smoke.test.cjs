// Command Centre smoke test.
//
// Boots the embedded Command Centre server on a spare port with an empty temp
// BRAIN_ROOT and no member token (so it stays fully offline — /api/health only
// calls the API when a token + team are set), then checks it still serves the
// app shell, that every shipped nav view is present, that /api/health answers
// with JSON, and that a referenced static asset loads.
//
// This catches the biggest Command Centre regression classes before a release:
// the server won't boot, the shell is broken, a nav view was dropped/renamed,
// health broke, or static serving broke. Deeper click-through tests belong with
// each view's own feature (e.g. the onboarding board ships its own Playwright
// enforcement tests).
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Not 38917 (a running Agency Brain app) and not 3847 (Mike's Workbench).
const PORT = 38970;
const BASE = `http://127.0.0.1:${PORT}`;
// The shipped nav, in order. Keep in sync with command-centre/public/index.html.
const NAV = ['welcome', 'path', 'cowork', 'owner', 'scout', 'skills', 'gads', 'help'];

async function waitReady(ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Command Centre server did not become ready in time');
}

(async () => {
  const brainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-smoke-'));
  // A fresh brain has these; make them so the server never trips on a missing dir.
  fs.mkdirSync(path.join(brainRoot, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(brainRoot, 'todo'), { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'command-centre', 'server.cjs')], {
    env: { ...process.env, CC_PORT: String(PORT), BRAIN_ROOT: brainRoot, AGENCY_MEMBER_TOKEN: '', AGENCY_TEAM_SLUG: '' },
    stdio: 'ignore',
  });

  try {
    await waitReady();

    // 1. App shell serves, with every shipped nav view present.
    const shell = await fetch(BASE + '/');
    assert.strictEqual(shell.status, 200, 'GET / should be 200');
    const html = await shell.text();
    for (const view of NAV) {
      assert.ok(html.includes(`data-view="${view}"`), `nav view "${view}" is missing from index.html`);
    }

    // 2. Health answers with a JSON object (offline path — no network call).
    const health = await fetch(BASE + '/api/health');
    assert.strictEqual(health.status, 200, '/api/health should be 200');
    const body = await health.json(); // throws if not valid JSON
    assert.ok(body && typeof body === 'object', '/api/health should return a JSON object');

    // 3. A static asset the shell references actually loads. The shell uses
    // relative paths (css/base.css, js/core.js), so normalise to a leading slash.
    const ref = html.match(/(?:src|href)="\/?((?:js|css)\/[^"]+)"/);
    assert.ok(ref, 'index.html should reference a local js or css asset');
    const asset = await fetch(`${BASE}/${ref[1]}`);
    assert.strictEqual(asset.status, 200, `static asset ${ref[1]} should be 200`);

    console.log(`command-centre-smoke: ok (${NAV.length} nav views, health, static)`);
  } finally {
    server.kill();
    try { fs.rmSync(brainRoot, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
})().catch((e) => { console.error('command-centre-smoke FAILED:', e.message); process.exit(1); });
