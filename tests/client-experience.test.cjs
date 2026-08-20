#!/usr/bin/env node
/*
 * client-experience.test.cjs — guards the 1.1.26 client-brain and setup fixes.
 *
 * Five behaviours, each of which shipped broken or data-destroying at least
 * once, so each is pinned against the REAL code (lifted or booted), never a
 * re-implementation:
 *
 *   A) A team member's tick on the progression rail syncs up instead of being
 *      reverted (watcher pathBlockedForRole), while the rest of the dot-path
 *      wall stays standing — including .claude/faq/faq.json, which a team
 *      member reads but must never write.
 *   B) /api/client-faq serves the brain's own questions and degrades to
 *      "unavailable" on anything missing or malformed, never a 500 and never
 *      extra fields.
 *   C) /api/progression carries the brain kind, so the rail can tell a client
 *      brain from an agency one without another script's globals.
 *   D) The six-level rail renders NOTHING in a client brain, and still renders
 *      for an agency team member.
 *   E) write-business-context refuses to replace a file it did not create —
 *      the blind overwrite let the second joiner wipe the business context
 *      for everyone (Mike, 2026-08-20).
 *   F) The wizard's business-questions screen stays deleted: no orphaned
 *      element lookups (a missing id throws at load and kills the whole
 *      wizard), six steps, and the two builder-only surface cards ship hidden.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok   ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
function check(cond, name, detail) { cond ? ok(name) : bad(name, detail); }

// Lift a named function out of a source file so the test runs the shipped
// code, not a copy that can drift (same pattern as config-recovery.test.cjs).
function lift(src, name, file) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${file} no longer defines ${name}() — did it get renamed?`);
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`couldn't find the end of ${name}()`);
  return src.slice(start, end + 2);
}

// ---- A) watcher: what a team member's app may push ---------------------------
function watcherTests() {
  console.log('\nA) watcher path rules for the team role');
  const src = fs.readFileSync(path.join(ROOT, 'watcher', 'team-brain-sync.js'), 'utf8');
  const pathBlockedForRole = new Function(
    `${lift(src, 'pathBlockedForRole', 'team-brain-sync.js')}; return pathBlockedForRole;`
  )();

  // The fix itself: a tick on the Getting started rail lives in
  // .team-config/progression/<slug>.json, and blocking it meant every tick was
  // reverted by the next sync tick (Lucy Walker, 2026-08-19).
  check(!pathBlockedForRole('.team-config/progression/jo-acme.json', 'team'),
    'a team member\'s own progression tick syncs up');
  check(!pathBlockedForRole('.team-config/feedback/flag-123.json', 'team'),
    'the skill-feedback channel still syncs up');

  // The wall around the allowance: nothing else under the dot-paths opened up.
  check(pathBlockedForRole('.team-config/roles.json', 'team'),
    'team still cannot push the roster');
  check(pathBlockedForRole('.claude/faq/faq.json', 'team'),
    'team reads the client FAQ but can never push a change to it');
  check(pathBlockedForRole('.claude/skills/start/team-path.json', 'team'),
    'team cannot rewrite the path definitions');
  check(pathBlockedForRole('CLAUDE.md', 'team'),
    'root-level files stay blocked for team');
  check(!pathBlockedForRole('context/business/notes.md', 'team'),
    'ordinary content folders stay open for team');

  check(['owner', 'scout', 'head-scout', 'HEAD_SCOUT', 'agency']
    .every((r) => !pathBlockedForRole('.team-config/roles.json', r)),
    'owners, scouts (either spelling) and agency staff are never path-blocked');
}

// ---- server boot helpers (same shape as client-kind.test.cjs) -----------------
function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}
async function waitUp(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { await get(port, '/api/health'); return true; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  return false;
}
async function withServer(kind, port, fn) {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exp-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'command-centre', 'server.cjs')], {
    env: Object.assign({}, process.env, {
      CC_PORT: String(port), BRAIN_ROOT: brain, AGENCY_TEAM_KIND: kind,
      AGENCY_TEAM_SLUG: 'acme-corp-brain', AGENCY_MEMBER_ROLE: 'owner',
      AGENCY_MEMBER_EMAIL: 'jo@acme.example', AGENCY_VERSION: '0.0.0-test',
      AGENCY_MEMBER_TOKEN: '', AGENCY_API_BASE: 'http://127.0.0.1:1',
    }),
    stdio: 'ignore',
  });
  try {
    if (!(await waitUp(port))) { bad(`${kind} server started`); return; }
    await fn(brain);
  } finally {
    child.kill();
    fs.rmSync(brain, { recursive: true, force: true });
  }
}

// ---- B + C) the client FAQ endpoint, and kind on the progression payload ------
async function serverTests() {
  console.log('\nB) /api/client-faq serves the brain\'s own questions, or degrades');
  await withServer('client', 38961, async (brain) => {
    const faqDir = path.join(brain, '.claude', 'faq');
    const faqFile = path.join(faqDir, 'faq.json');
    const ask = async () => JSON.parse((await get(38961, '/api/client-faq')).body);

    // The server reads the file per request, so one boot covers every state.
    let d = await ask();
    check(d.available === false && Array.isArray(d.items) && d.items.length === 0,
      'no faq.json → unavailable, empty items, HTTP 200');

    fs.mkdirSync(faqDir, { recursive: true });
    fs.writeFileSync(faqFile, JSON.stringify({ items: [
      { q: 'How do I open my brain?', a: 'In the Claude desktop app.', category: 'Getting started' },
      { q: 'Who do I ask?', a: 'Your contact at the top of Help.' },
    ] }));
    d = await ask();
    check(d.available === true && d.items.length === 2, 'a real faq.json serves its items');
    check(d.items[1].category === 'Questions', 'a missing category defaults to "Questions"');
    check(d.items.every((i) => Object.keys(i).sort().join(',') === 'a,category,q'),
      'items carry q, a and category only — nothing else from the file leaks through');

    fs.writeFileSync(faqFile, JSON.stringify({ items: [
      null, { q: 'No answer here' }, { a: 'No question here' },
      { q: 'Kept', a: 'Yes', category: 'Getting started' },
    ] }));
    d = await ask();
    check(d.available === true && d.items.length === 1 && d.items[0].q === 'Kept',
      'rows missing a question or an answer are dropped, the rest survive');

    fs.writeFileSync(faqFile, '{ not json');
    d = await ask();
    check(d.available === false && d.items.length === 0,
      'malformed JSON degrades to unavailable, never a 500');

    fs.writeFileSync(faqFile, JSON.stringify({ items: [] }));
    d = await ask();
    check(d.available === false, 'an empty list reads as unavailable, so the Help pane shows its fallback');

    console.log('\nC) /api/progression carries the brain kind');
    const prog = JSON.parse((await get(38961, '/api/progression')).body);
    check(prog.kind === 'client', 'a client brain\'s payload says kind:client', JSON.stringify(prog.kind));
  });
  await withServer('agency', 38962, async () => {
    const prog = JSON.parse((await get(38962, '/api/progression')).body);
    check(prog.kind === 'agency', 'an agency brain\'s payload says kind:agency', JSON.stringify(prog.kind));
  });
}

// ---- D) the six-level rail takes itself off a client brain --------------------
// Runs the real progression.js with just the four core.js globals it uses
// stubbed, resolves its /api/progression fetch with a fixed payload, and reads
// what it wrote into #prog-self-root.
function railAfterLoad(payload) {
  const root = { innerHTML: 'UNTOUCHED', querySelectorAll: () => [] };
  let onReady = null;
  const ctx = {
    console, JSON, Object, Array, Math, String, Number, Promise, Error,
    document: { addEventListener: (evt, fn) => { if (evt === 'DOMContentLoaded') onReady = fn; } },
    setInterval: () => 0,
    $: (id) => (id === 'prog-self-root' ? root : null),
    esc: (s) => String(s), ago: () => '',
    api: () => Promise.resolve(payload),
  };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'command-centre', 'public', 'js', 'progression.js'), 'utf8'),
    ctx, { filename: 'progression.js' }
  );
  if (!onReady) throw new Error('progression.js no longer loads on DOMContentLoaded');
  return onReady().then(() => root.innerHTML);
}

async function railTests() {
  console.log('\nD) the self-report rail knows which kind of brain it is in');
  const self = { ticks: {}, score: 0 };
  const clientHtml = await railAfterLoad({ role: 'team', kind: 'client', levels: [], self });
  check(clientHtml === '', 'a client brain\'s team member gets no six-level rail',
    `rendered ${clientHtml.length} chars`);
  const agencyHtml = await railAfterLoad({ role: 'team', kind: 'agency', levels: [], self });
  check(agencyHtml.includes('prog-card'), 'an agency brain\'s team member still gets the rail');
}

// ---- E) write-business-context never replaces an existing file ----------------
function businessContextTests() {
  console.log('\nE) the business context is written once, never overwritten');
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('write-business-context'");
  check(start !== -1, 'main.js still registers write-business-context');
  if (start === -1) return;
  const end = src.indexOf('\n});', start);
  const call = src.slice(start, end + 4);
  let handler = null;
  // assertSafeTarget is identity here: path safety has its own owner, this test
  // is about the overwrite guard.
  new Function('ipcMain', 'fs', 'path', 'assertSafeTarget', call)(
    { handle: (_name, fn) => { handler = fn; } }, fs, path, (p) => p
  );
  check(typeof handler === 'function', 'the real handler was lifted');
  if (!handler) return;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-ctx-'));
  const target = path.join(dir, 'context', 'business', 'business-context.md');
  return (async () => {
    const first = await handler(null, { brainPath: dir, ctx: { name: 'Jo', business: 'Acme', sells: 'Widgets', serves: 'Trades' } });
    check(first.ok === true && fs.existsSync(target), 'the first joiner\'s answers are written');
    const second = await handler(null, { brainPath: dir, ctx: { name: 'Sam', business: 'Overwrite Co', sells: '', serves: '' } });
    check(second.ok === false && second.skipped === 'exists',
      'a second write is refused, and says why');
    check(fs.readFileSync(target, 'utf8').includes('Jo'),
      'the first joiner\'s context survives untouched');
    fs.rmSync(dir, { recursive: true, force: true });
  })();
}

// ---- F) the wizard's deleted screen stays deleted ------------------------------
function wizardTests() {
  console.log('\nF) wizard: six steps, no business screen, no orphaned lookups');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'wizard.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'wizard.js'), 'utf8');

  check(!html.includes('scene-business') && !html.includes('bizName'),
    'the four-questions screen is gone from the wizard');
  check(!js.includes('writeBusinessContext'),
    'nothing in the wizard calls the business-context write any more');
  check(html.includes('1 / 6') && /TOTAL = 6/.test(js),
    'the rail and the counter both say six steps');

  // A load-time getElementById(...).addEventListener on an id that no longer
  // exists throws and kills the whole wizard, which is exactly how a deleted
  // screen breaks setup. Every such lookup must resolve into wizard.html.
  const wired = [...js.matchAll(/document\.getElementById\('([^']+)'\)\.addEventListener/g)]
    .map((m) => m[1]);
  const missing = wired.filter((id) => !html.includes(`id="${id}"`));
  check(wired.length > 0 && missing.length === 0,
    'every load-time listener target still exists in wizard.html',
    missing.length ? `missing: ${missing.join(', ')}` : `checked ${wired.length}`);

  // Hidden-by-default is the safe direction: a team member must never see the
  // terminal and editor cards, so they only appear once a builder role is known.
  check(/id="surface-terminal"[^>]*hidden/.test(html) && /id="surface-editor"[^>]*hidden/.test(html),
    'the terminal and editor cards ship hidden until a builder role un-hides them');
}

(async () => {
  console.log('client-experience tests');
  watcherTests();
  await serverTests();
  await railTests();
  await businessContextTests();
  wizardTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
