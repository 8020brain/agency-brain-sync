#!/usr/bin/env node
/**
 * Settings-file recovery tests — run the REAL readConfig/saveConfig source from
 * main.js against throwaway temp dirs. No mocks of the functions themselves: the
 * source text is lifted straight out of main.js and evaluated with fs/path and a
 * few constants injected, so a regression in main.js fails this test.
 *
 *   node tests/config-recovery.test.cjs
 *
 * Why this exists (reported 2026-07-29): a Mac slept overnight, the updater
 * relaunched the app, and it came back showing the setup wizard on a machine
 * that had been syncing for days. Every routing decision in main.js is
 * "cfg && cfg.brainPath ? Command Centre : wizard", and loadConfig() collapsed
 * EVERY failure — missing file, unreadable file, half-written file — into the
 * same null. So one unlucky read of config.json presented an onboarded member
 * with a fresh install, silently.
 *
 * Covers:
 *   A) The three read outcomes stay distinct — absent (really new) vs ok vs
 *      unreadable. Only 'absent' may ever route to the wizard.
 *   B) A corrupt config.json recovers from the backup instead of reading as new.
 *   C) saveConfig is atomic — an interrupted write can never leave a truncated
 *      config.json, because the real file is only ever replaced by rename.
 *   D) A brain folder that reappears mid-check is not declared missing.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');

// Lift named top-level functions out of main.js by source text. Top-level
// function declarations in this file end with a closing brace at column 0.
function extract(name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `main.js no longer defines ${name}() — did it get renamed?`);
  // Keep the `async` keyword if there is one, or the lifted copy loses its
  // awaits and the whole harness fails to parse.
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const end = src.indexOf('\n}', start);
  assert.ok(end !== -1, `couldn't find the end of ${name}()`);
  return src.slice(start, end + 2);
}

const NAMES = ['sleepSync', 'readConfig', 'loadConfig', 'saveConfig',
  'brainKey', 'profileFromActive', 'upsertProfile', 'brainFolderReallyMissing',
  'brainLabel', 'forgetBrain'];

// The dialog stub forgetBrain() talks to. `answer` is the button index the
// "person" clicks: 0 = Forget it, 1 = Cancel.
const dialogStub = { answer: 0, showMessageBox: async () => ({ response: dialogStub.answer }) };

function loadRealFns(dir) {
  const CONFIG_FILE = path.join(dir, 'config.json');
  const CONFIG_BACKUP_FILE = path.join(dir, 'config.backup.json');
  const LOG_FILE = path.join(dir, 'sync.log');
  const body = `
    ${NAMES.map(extract).join('\n')}
    return { ${NAMES.join(', ')}, CONFIG_FILE, CONFIG_BACKUP_FILE };
  `;
  // Injected: the module-scope names the lifted functions close over.
  const make = new Function('fs', 'path', 'CONFIG_FILE', 'CONFIG_BACKUP_FILE',
    'LOG_FILE', 'clog', 'computeAppName', 'applyAppMenu', 'BRAIN_PROFILE_KEYS', 'USER_DATA', 'APP_NAME',
    'dialog', 'updateTray', body);
  return make(fs, path, CONFIG_FILE, CONFIG_BACKUP_FILE, LOG_FILE,
    () => {}, () => 'Business Brain', () => {},
    ['brainPath', 'mode', 'teamSlug', 'memberEmail', 'memberName', 'memberRole',
      'memberToken', 'scoutSeats', 'packageTier', 'kind', 'brandName'],
    dir, 'Business Brain', dialogStub, () => {});
}

let passed = 0;
const queue = [];
function check(label, fn) { queue.push({ label, fn }); }

async function run() {
  console.log('config recovery');
  for (const { label, fn } of queue) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-config-'));
    try {
      await fn(loadRealFns(dir), dir);
      console.log(`  ok  ${label}`);
      passed++;
    } catch (e) {
      console.error(`  FAIL  ${label}\n        ${e.message}`);
      process.exitCode = 1;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\n${passed}/${queue.length} passed${process.exitCode ? ' — SOME FAILED' : ''}`);
}

// A) The three outcomes stay distinct.
check('no config.json at all reads as "absent" (a genuinely new install)', (api) => {
  const r = api.readConfig();
  assert.strictEqual(r.state, 'absent');
  assert.strictEqual(r.config, null);
});

check('a good config.json reads as "ok" and returns the settings', (api) => {
  api.saveConfig({ brainPath: '/tmp/some-brain', mode: 'agency', teamSlug: 'acme' });
  const r = api.readConfig();
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.config.brainPath, '/tmp/some-brain');
});

check('a truncated config.json with no backup reads as "unreadable", NOT absent', (api) => {
  fs.writeFileSync(api.CONFIG_FILE, '{ "brainPath": "/tmp/some-b');   // half-written
  fs.rmSync(api.CONFIG_BACKUP_FILE, { force: true });
  const r = api.readConfig();
  assert.strictEqual(r.state, 'unreadable',
    'a half-written config must never look like a fresh install');
  assert.strictEqual(r.config, null);
});

// B) Recovery from the backup.
check('a truncated config.json recovers the real settings from the backup', (api) => {
  api.saveConfig({ brainPath: '/tmp/real-brain', mode: 'agency', memberToken: 'tok' });
  fs.writeFileSync(api.CONFIG_FILE, '{ "brainPa');                    // corrupt it
  const r = api.readConfig();
  assert.strictEqual(r.state, 'recovered');
  assert.strictEqual(r.config.brainPath, '/tmp/real-brain');
  assert.strictEqual(r.config.memberToken, 'tok');
});

check('routing rule: only "absent" may send an onboarded member to the wizard', (api) => {
  api.saveConfig({ brainPath: '/tmp/real-brain', mode: 'agency' });
  fs.writeFileSync(api.CONFIG_FILE, 'not json at all');
  const { config, state } = api.readConfig({ retries: 1, delayMs: 1 });
  const wouldShowWizard = state !== 'unreadable' && !(config && config.brainPath);
  assert.strictEqual(wouldShowWizard, false,
    'an unreadable/recovered config must not route to setup');
});

// C) Atomic write.
check('saveConfig replaces config.json atomically (no .tmp left behind)', (api, dir) => {
  api.saveConfig({ brainPath: '/tmp/a', mode: 'personal' });
  api.saveConfig({ brainPath: '/tmp/b', mode: 'personal' });
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'temp file should be renamed away, not left');
  assert.strictEqual(JSON.parse(fs.readFileSync(api.CONFIG_FILE, 'utf8')).brainPath, '/tmp/b');
});

check('config.json is always complete JSON after a save', (api) => {
  api.saveConfig({ brainPath: '/tmp/x', mode: 'agency', teamSlug: 'acme', memberToken: 't' });
  const raw = fs.readFileSync(api.CONFIG_FILE, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.ok(raw.trim().endsWith('}'), 'file should end with a closing brace, not mid-write');
});

check('saving a second brain keeps the first in the brains list', (api) => {
  api.saveConfig({ brainPath: '/tmp/one', mode: 'agency', teamSlug: 'one' });
  api.saveConfig({ brainPath: '/tmp/two', mode: 'agency', teamSlug: 'two' });
  const cfg = api.readConfig().config;
  const slugs = (cfg.brains || []).map((b) => b.teamSlug).sort();
  assert.deepStrictEqual(slugs, ['one', 'two'], 'archiving a brain must not drop the other');
});

// E) Forgetting a brain (2026-08-19). An owner's first setup adopted his
// personal brain as a solo brain; the agency he created afterwards became the
// active one, and the solo entry stayed listed under Switch brain with no way
// to remove it. forgetBrain() drops the bookmark only, never the active brain,
// never anything on disk outside config.json.
check('forgetting a non-active brain removes it and keeps the active one', async (api) => {
  api.saveConfig({ brainPath: '/tmp/personal-brain', mode: 'personal' });
  api.saveConfig({ brainPath: '/tmp/agency-brain', mode: 'agency', teamSlug: 'evolution-digital', memberToken: 't' });
  assert.strictEqual(api.loadConfig().brains.length, 2);
  dialogStub.answer = 0;
  await api.forgetBrain('/tmp/personal-brain');   // a personal profile's key is its path
  const cfg = api.loadConfig();
  assert.strictEqual(cfg.brainPath, '/tmp/agency-brain', 'the active brain is untouched');
  assert.strictEqual(cfg.teamSlug, 'evolution-digital');
  assert.deepStrictEqual(cfg.brains.map((b) => b.brainPath), ['/tmp/agency-brain']);
});

check('forgetting removes every profile saved for that folder, not just one identity', async (api) => {
  api.saveConfig({ brainPath: '/tmp/client', mode: 'agency', teamSlug: 'client-a', memberToken: 't' });
  api.saveConfig({ brainPath: '/tmp/client', mode: 'agency', teamSlug: 'client-a-renamed', memberToken: 't' });
  api.saveConfig({ brainPath: '/tmp/agency-brain', mode: 'agency', teamSlug: 'acme', memberToken: 't' });
  assert.strictEqual(api.loadConfig().brains.length, 3);
  dialogStub.answer = 0;
  await api.forgetBrain('client-a');
  const cfg = api.loadConfig();
  assert.deepStrictEqual(cfg.brains.map((b) => b.teamSlug), ['acme']);
});

check('cancelling the dialog changes nothing', async (api) => {
  api.saveConfig({ brainPath: '/tmp/personal-brain', mode: 'personal' });
  api.saveConfig({ brainPath: '/tmp/agency-brain', mode: 'agency', teamSlug: 'acme', memberToken: 't' });
  dialogStub.answer = 1;
  await api.forgetBrain('/tmp/personal-brain');
  assert.strictEqual(api.loadConfig().brains.length, 2);
});

check('the active brain can never be forgotten', async (api) => {
  api.saveConfig({ brainPath: '/tmp/personal-brain', mode: 'personal' });
  api.saveConfig({ brainPath: '/tmp/agency-brain', mode: 'agency', teamSlug: 'acme', memberToken: 't' });
  dialogStub.answer = 0;
  await api.forgetBrain('acme');
  const cfg = api.loadConfig();
  assert.strictEqual(cfg.brainPath, '/tmp/agency-brain');
  assert.strictEqual(cfg.brains.length, 2);
});

// D) The brain-folder check.
check('an existing brain folder is never reported missing', async (api, dir) => {
  assert.strictEqual(await api.brainFolderReallyMissing(dir), false);
});

check('a folder that appears on a later check is not declared missing', async (api, dir) => {
  const late = path.join(dir, 'late-brain');
  const t = setTimeout(() => fs.mkdirSync(late), 250);   // "volume finishes mounting"
  try {
    assert.strictEqual(await api.brainFolderReallyMissing(late), false,
      'a single stat must not be enough to send someone back into setup');
  } finally { clearTimeout(t); }
});

check('a folder that truly is gone still reports missing', async (api, dir) => {
  assert.strictEqual(await api.brainFolderReallyMissing(path.join(dir, 'never')), true);
});

// The retry must not freeze the app: brainFolderReallyMissing is async so the
// event loop keeps turning while it waits. If it ever goes back to a blocking
// sleep, this timer can't fire and the test fails.
check('waiting for the folder does not block the event loop', async (api, dir) => {
  let ticked = false;
  const t = setInterval(() => { ticked = true; }, 50);
  try {
    await api.brainFolderReallyMissing(path.join(dir, 'never'));
    assert.ok(ticked, 'a timer should have fired while the check was waiting');
  } finally { clearInterval(t); }
});

run();
