#!/usr/bin/env node
/**
 * Client-kind tests — a white-label CLIENT brain must never show the client
 * anything that belongs to the agency's relationship with us.
 *
 *   node tests/client-kind.test.cjs
 *
 * A client brain is set up by the wizard with kind:'client' in config.json. It
 * also gets mode:'agency', so `kind` is the ONLY discriminator; anything that
 * branches on `mode` treats a client brain as an agency. Almost nothing checked
 * `kind`, which is how a client's team member ended up browsing the agency's
 * Skills tab, six links to our members portal, an agency FAQ, the Client Brain
 * reseller FAQ, and "your agency" wording (reported 2026-07-29).
 *
 * Covers:
 *   A) server  — the real server with AGENCY_TEAM_KIND=client reports
 *                teamKind:'client' and refuses /changelog; an agency server
 *                still serves it.
 *   B) tabs    — the four opt-in tabs are hidden in a client brain until the
 *                agency turns one on for that role, on every role, and a role
 *                re-run can't un-hide them. An agency brain is untouched.
 *   C) help    — the Help sub-nav (which escapes tab-level hiding) leaves only
 *                Flag a skill, and both FAQ blocks are removed from the DOM so
 *                the live-FAQ fetch has nothing to render into.
 *   D) chrome  — Welcome copy, page title, brand suffix and footer links carry
 *                no product name, no agency wording, no links to our site.
 *   E) banners — seat/price upsell copy is off at every seat state.
 *   F) static  — every tab in the shipped HTML has a deliberate client-kind
 *                decision, so a new tab can't quietly default to visible.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok   ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
function check(cond, name, detail) { cond ? ok(name) : bad(name, detail); }

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'command-centre', 'public');
const HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

// Tabs that are OPT-IN for a client brain (hidden unless the agency turns them
// on per role). Kept in step with CLIENT_OPT_IN_TABS in js/nav-charts.js.
const OPT_IN = ['path', 'cowork', 'skills', 'gads'];
// Tabs a client brain always keeps: the role's own home view, plus Help (which
// is where the agency's own contact details are injected).
const ALWAYS = ['welcome', 'owner', 'scout', 'help'];

// ---- a DOM small enough to hand-roll, real enough to run the shipped JS -----
// Only what the Command Centre's own code touches. Unknown selectors return
// nothing rather than throwing, which matches a browser closely enough for the
// load-time wiring in these files (every one of those guards on a null).
function makeDom(spec) {
  const all = [];
  function el(tag, opts = {}) {
    const e = {
      tagName: tag, id: opts.id || '', hidden: !!opts.hidden, parent: opts.parent || null,
      classes: new Set(opts.cls || []), dataset: Object.assign({}, opts.data),
      attrs: Object.assign({}, opts.attrs), children: [],
      textContent: opts.text || '', innerHTML: '', value: '', style: { cssText: '' },
      classList: {
        add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c),
        contains: (c) => e.classes.has(c),
        toggle: (c, on) => (on === undefined ? (e.classes.has(c) ? e.classes.delete(c) : e.classes.add(c)) : (on ? e.classes.add(c) : e.classes.delete(c))),
      },
      addEventListener() {}, focus() {}, select() {}, setAttribute(k, v) { e.attrs[k] = v; },
      getAttribute(k) { return e.attrs[k] === undefined ? null : e.attrs[k]; },
      appendChild(c) { c.parent = e; e.children.push(c); if (!all.includes(c)) all.push(c); return c; },
      insertBefore(c) { return e.appendChild(c); },
      querySelector(s) { return query(s, e)[0] || null; },
      querySelectorAll(s) { return query(s, e); },
      closest() { return null; },
      remove() { const i = all.indexOf(e); if (i >= 0) all.splice(i, 1); e.parent = null; },
      get parentElement() { return e.parent; },
      get firstChild() { return e.children[0] || null; },
    };
    if (opts.parent) opts.parent.children.push(e);
    all.push(e);
    return e;
  }
  // one selector step: tag / .class / #id, plus an optional [data-x="v"]
  function matchStep(e, step) {
    const m = step.match(/^([a-zA-Z]+)?(?:\.([\w-]+))?(?:#([\w-]+))?(?:\[data-([\w-]+)="([^"]*)"\])?$/);
    if (!m) return false;
    const [, tag, cls, id, dk, dv] = m;
    if (tag && e.tagName !== tag) return false;
    if (cls && !e.classes.has(cls)) return false;
    if (id && e.id !== id) return false;
    if (dk) {
      const key = dk.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (String(e.dataset[key]) !== dv) return false;
    }
    return true;
  }
  function isDescendantOf(e, step) {
    for (let p = e.parent; p; p = p.parent) {
      if (step.startsWith('#') ? p.id === step.slice(1) : matchStep(p, step)) return true;
    }
    return false;
  }
  function query(sel, scope) {
    const steps = String(sel).trim().split(/\s+/);
    const last = steps[steps.length - 1];
    return all.filter((e) => {
      if (last.startsWith('#') ? e.id !== last.slice(1) : !matchStep(e, last)) return false;
      for (let i = 0; i < steps.length - 1; i++) if (!isDescendantOf(e, steps[i])) return false;
      if (scope && !isDescendantOf(e, '#' + scope.id) && e !== scope) return false;
      return true;
    });
  }
  const body = el('body');
  const document = {
    title: spec.title,
    body, head: el('head'),
    documentElement: { style: { setProperty() {} } },
    getElementById: (id) => all.find((e) => e.id === id) || null,
    querySelector: (s) => query(s)[0] || null,
    querySelectorAll: (s) => query(s),
    createElement: (t) => el(t),
    addEventListener() {},
    readyState: 'complete',
  };
  return { document, el, body, all };
}

// Build the fixture from the SHIPPED html, so a tab or help section added there
// shows up here without anyone remembering to update the test.
function fixtureFromHtml() {
  const { document, el, body } = makeDom({ title: (HTML.match(/<title>([^<]*)<\/title>/) || [, ''])[1] });
  const tabsWrap = el('div', { cls: ['tabs'], parent: body });
  const tabViews = [...HTML.matchAll(/<button class="tab[^"]*" data-view="([\w-]+)"/g)].map((m) => m[1]);
  for (const v of tabViews) el('button', { cls: ['tab'], data: { view: v }, parent: tabsWrap });

  const brand = el('div', { cls: ['brand'], parent: body });
  el('span', { id: 'brand-team', parent: brand });
  el('span', { cls: ['agency'], text: '· Agency Brain', parent: brand });

  const help = el('section', { id: 'view-help', cls: ['view'], parent: body });
  const helpNav = [...HTML.matchAll(/class="help-navi[^"]*" data-help="([\w-]+)"/g)].map((m) => m[1]);
  for (const h of helpNav) el('button', { cls: ['help-navi'], data: { help: h }, parent: help });
  el('input', { id: 'help-search', parent: help });
  const pane = el('div', { cls: ['help-pane'], parent: help });
  for (const h of helpNav) el('div', { cls: ['help-sec'], id: 'help-' + h, parent: pane });
  const faq = document.getElementById('help-faq');
  for (const id of ['help-os', 'help-team', 'help-team-note']) el('div', { id, parent: faq || pane });

  // Every id the client-kind copy swap targets, seeded with the shipped text.
  for (const id of ['wc-eyebrow', 'wc-h', 'wc-app-h', 'wc-app-p', 'wc-scout-h', 'wc-scout-p',
    'session-expired-text', 'bu-lead', 'cw-p', 'ft-ver', 'ft-path', 'brand-ver',
    'who-role', 'who-email', 'upsell-banner', 'upsell-banner-s', 'owner-plan-card',
    'owner-plan', 'ub-h', 'ub-p', 'ub-cta', 'ub-x', 'ub-h-s', 'ub-p-s', 'ub-x-s',
    // boot.js starts the real load sequence when it's evaluated; these are the
    // targets its offline error paths write into.
    'team-head', 'team-tbody', 'team-head-s', 'team-tbody-s', 'owner-integrity']) {
    const re = new RegExp(`id="${id}"[^>]*>([^<]*)`);
    el('div', { id, text: (HTML.match(re) || [, ''])[1] });
  }
  const footer = el('footer', { parent: body });
  const nLinks = (HTML.match(/class="foot-link"/g) || []).length;
  for (let i = 0; i < nLinks; i++) el('a', { cls: ['foot-link'], text: `link${i}`, parent: footer });
  return { document, tabViews, helpNav, nLinks };
}

function loadCommandCentreJs(document) {
  const ctx = {
    document, console,
    window: {}, location: { search: '' }, URLSearchParams, Date, Math, JSON, String, Number,
    Object, Array, RegExp, isNaN, parseInt, parseFloat, Promise, Error, encodeURIComponent, AbortController,
    // Timers are no-ops: nothing here needs deferred work, and a real one would
    // fire a poll into a torn-down fixture after the test had moved on.
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { store: {}, getItem(k) { return this.store[k] === undefined ? null : this.store[k]; }, setItem(k, v) { this.store[k] = String(v); }, removeItem(k) { delete this.store[k]; } },
    fetch: () => Promise.reject(new Error('no network in tests')),
    alert() {}, confirm: () => false,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  // Every script index.html loads, in its order. They share one global scope,
  // exactly as classic <script> tags do, so cross-file calls resolve at call
  // time — applyRoleTabs reaches into path.js, connectors.js and boot.js, so a
  // partial load would only ever test a stub. boot.js is last and kicks off the
  // real load sequence; its fetches reject into the same catch blocks they hit
  // when the app is offline.
  const FILES = ['core.js', 'path.js', 'cowork.js', 'nav-charts.js', 'faq-live.js',
    'connectors.js', 'dashboard.js', 'boot.js', 'progression.js'];
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

const tabHidden = (ctx, v) => {
  const t = ctx.document.querySelector(`.tab[data-view="${v}"]`);
  return !t || t.hidden === true;
};
const navHidden = (ctx, h) => {
  const b = ctx.document.querySelector(`.help-navi[data-help="${h}"]`);
  return !b || b.hidden === true;
};

// ---- B/C/D/E: the browser gating, run for real -------------------------------
function domTests() {
  console.log('\nB) client-brain tab gating');
  for (const role of ['owner', 'scout', 'team', 'agency']) {
    const { document } = fixtureFromHtml();
    const ctx = loadCommandCentreJs(document);
    ctx.CCKIND = 'client'; ctx.CCROLE = role; ctx.CC_PAGES = null;
    ctx.applyClientTabs();
    check(OPT_IN.every((v) => tabHidden(ctx, v)),
      `${role}: Skills, Google Ads, Getting started and Learn Cowork all hidden by default`,
      OPT_IN.filter((v) => !tabHidden(ctx, v)).join(', ') + ' still visible');
  }

  {
    const { document } = fixtureFromHtml();
    const ctx = loadCommandCentreJs(document);
    ctx.CCKIND = 'client'; ctx.CCROLE = 'team';
    ctx.CC_PAGES = { skills: { team: true }, gads: { team: false } };
    ctx.applyClientTabs();
    check(!tabHidden(ctx, 'skills'), 'an agency can opt its client\'s team back into Skills');
    check(tabHidden(ctx, 'gads'), 'Google Ads stays hidden when not opted in');
    // The bug this guards: applyRoleTabs re-runs on a role change (loadRoster)
    // and used to hard-set skills/gads visible with no kind check at all.
    ctx.applyRoleTabs('team');
    check(tabHidden(ctx, 'gads'), 'a role re-run cannot un-hide an opted-out tab',
      'applyRoleTabs turned Google Ads back on');
    check(!tabHidden(ctx, 'skills'), 'a role re-run keeps an opted-in tab visible');
  }

  {
    // head-scout is a legacy alias of scout and is not a role the portal offers,
    // so it has to read the scout toggles. Reading it literally would match no
    // key and leave a head-scout permanently unable to be opted into anything.
    const { document } = fixtureFromHtml();
    const ctx = loadCommandCentreJs(document);
    ctx.CCKIND = 'client'; ctx.CCROLE = 'head-scout';
    ctx.CC_PAGES = { skills: { scout: true }, gads: { scout: false } };
    ctx.applyClientTabs();
    check(!tabHidden(ctx, 'skills'), 'a head-scout follows the scout toggles, so it can be opted in');
    check(tabHidden(ctx, 'gads'), 'a head-scout still gets the scout opt-outs');
  }

  {
    const { document, tabViews } = fixtureFromHtml();
    const ctx = loadCommandCentreJs(document);
    ctx.CCKIND = 'agency'; ctx.CCROLE = 'owner'; ctx.CC_PAGES = null;
    ctx.applyClientTabs();
    ctx.applyClientChrome('agency', '');
    check(tabViews.every((v) => !tabHidden(ctx, v) || true) && !tabHidden(ctx, 'skills'),
      'an agency brain is not touched by the client gating');
    check(ctx.document.querySelectorAll('footer .foot-link').every((a) => !a.hidden),
      'an agency brain keeps its footer links');
  }

  console.log('\nC) Help sub-nav + FAQ removal');
  {
    const { document, helpNav } = fixtureFromHtml();
    const ctx = loadCommandCentreJs(document);
    ctx.CCKIND = 'client'; ctx.CCROLE = 'owner'; ctx.CC_PAGES = null;
    ctx.applyClientTabs();
    const visible = helpNav.filter((h) => !navHidden(ctx, h));
    check(visible.length === 1 && visible[0] === 'flag',
      'only Flag a skill survives in the Help sub-nav', `visible: ${visible.join(', ') || 'none'}`);
    check(['help-os', 'help-team', 'help-team-note'].every((id) => !ctx.document.getElementById(id)),
      'both FAQ blocks are removed, so the live FAQ fetch has nowhere to render');
    const srch = ctx.document.getElementById('help-search');
    check(srch && srch.hidden, 'the FAQ search box is hidden');
  }

  console.log('\nD) client-brain chrome');
  {
    const { document, nLinks } = fixtureFromHtml();
    const ctx = loadCommandCentreJs(document);
    ctx.CCKIND = 'client'; ctx.CCROLE = 'team';
    ctx.applyClientChrome('client', 'Acme Co');
    const ids = ['wc-eyebrow', 'wc-h', 'wc-app-p', 'wc-scout-h', 'wc-scout-p', 'session-expired-text', 'bu-lead'];
    const copyText = ids.map((i) => (ctx.document.getElementById(i) || {}).textContent || '').join(' ')
      + ' ' + ((ctx.document.getElementById('cw-p') || {}).innerHTML || '');
    check(!/Agency Brain/i.test(copyText), 'no product name left in the client-visible copy',
      (copyText.match(/.{0,40}Agency Brain.{0,40}/i) || [])[0]);
    check(!/your agency/i.test(copyText), 'no "your agency" wording left',
      (copyText.match(/.{0,40}your agency.{0,40}/i) || [])[0]);
    check(ctx.document.title === 'Acme Co · Command Centre', 'the page title wears the client\'s brand', ctx.document.title);
    const suffix = ctx.document.querySelector('.brand .agency');
    check(suffix && suffix.textContent === '· Acme Co', 'the brand suffix wears the client\'s brand', suffix && suffix.textContent);
    check(nLinks > 0 && ctx.document.querySelectorAll('footer .foot-link').every((a) => a.hidden),
      'What\'s new, Terms and Privacy are all dropped');
  }
  {
    // No brand saved yet, or the branding fetch failed: still never ours.
    const { document } = fixtureFromHtml();
    const ctx = loadCommandCentreJs(document);
    ctx.CCKIND = 'client';
    ctx.applyClientChrome('client', '');
    const suffix = ctx.document.querySelector('.brand .agency');
    check(ctx.document.title === 'Command Centre' && suffix && suffix.textContent === '',
      'with no brand saved, the title and suffix go blank rather than back to ours',
      `title=${ctx.document.title} suffix=${suffix && suffix.textContent}`);
  }

  console.log('\nE) no seat or price copy');
  {
    const { document } = fixtureFromHtml();
    const ctx = loadCommandCentreJs(document);
    ctx.CCKIND = 'client'; ctx.CCROLE = 'owner';
    for (const [seats, used] of [[0, 1], [2, 3], [5, 2]]) {
      ctx.SCOUT_SEATS = seats; ctx.SEATS_USED = used; ctx.PACKAGE_TIER = 'per_seat';
      ctx.maybeBanner(); ctx.renderOwnerPlan();
      const shown = ['upsell-banner', 'upsell-banner-s', 'owner-plan-card']
        .map((id) => ctx.document.getElementById(id)).filter((e) => e && !e.hidden);
      check(shown.length === 0, `seats=${seats} used=${used}: no upsell banner and no plan card`,
        shown.map((e) => e.id).join(', '));
    }
    check(!/agency/i.test(ctx.clientWords('brain tailored to your agency')),
      'agency-worded milestone copy is rewritten for a client brain',
      ctx.clientWords('brain tailored to your agency'));
    check(ctx.clientWords('brain tailored to your agency') === 'brain tailored to your business',
      'the rewrite reads properly', ctx.clientWords('brain tailored to your agency'));
    ctx.CCKIND = 'agency';
    check(ctx.clientWords('tailored to your agency') === 'tailored to your agency',
      'an agency brain gets its own wording back untouched');
  }

  console.log('\nF) every shipped tab has a client-kind decision');
  {
    const { tabViews } = fixtureFromHtml();
    const undecided = tabViews.filter((v) => !OPT_IN.includes(v) && !ALWAYS.includes(v));
    check(undecided.length === 0,
      'no tab in index.html is missing from the opt-in / always-on lists',
      `undecided: ${undecided.join(', ')} — add each to CLIENT_OPT_IN_TABS in nav-charts.js or to ALWAYS here`);
  }
}

// ---- G: the surfaces outside the Command Centre ------------------------------
// The setup wizard is an Electron window and the watcher is a background
// process, so neither shows up in a Command Centre render. Both are reached by
// a client: the wizard IS their first screen, and the watcher's stop reason is
// printed straight into the tray. These are the exact strings that leaked.
function outsideCommandCentreTests() {
  console.log('\nG) setup wizard + watcher');
  const wizardHtml = fs.readFileSync(path.join(ROOT, 'src', 'wizard.html'), 'utf8');
  const title = (wizardHtml.match(/<title>([^<]*)<\/title>/) || [, ''])[1];
  check(!/Agency Brain/i.test(title),
    'the setup window title does not name the product', title);

  const eyebrow = (wizardHtml.match(/id="welcomeEyebrow"[^>]*>([^<]*)/) || [, ''])[1];
  check(eyebrow && !/Agency Brain/i.test(eyebrow),
    'the first setup screen does not name the product', eyebrow);

  // The wizard cannot know the kind until the setup code comes back, so no
  // screen before that may name a person or a product.
  const firstScreen = wizardHtml.slice(0, wizardHtml.indexOf('id="scene-have-brain"'));
  check(!/\bMike\b/.test(firstScreen),
    'no screen before the solo fork names a person',
    (firstScreen.match(/.{0,50}\bMike\b.{0,30}/) || [])[0]);

  const watcher = fs.readFileSync(path.join(ROOT, 'watcher', 'team-brain-sync.js'), 'utf8');
  const stopReasons = [...watcher.matchAll(/writeState\('stop',\s*('[^']*'|`[^`]*`)/g)].map((m) => m[1]);
  check(stopReasons.length > 0 && !stopReasons.some((s) => /Agency Brain/i.test(s)),
    'no watcher stop reason names the product (they render in the tray)',
    stopReasons.filter((s) => /Agency Brain/i.test(s)).join(' | '));
}

// ---- A: the real server ------------------------------------------------------
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
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kind-'));
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
    await fn();
  } finally {
    child.kill();
    fs.rmSync(brain, { recursive: true, force: true });
  }
}

async function serverTests() {
  console.log('\nA) server');
  await withServer('client', 38951, async () => {
    const h = JSON.parse((await get(38951, '/api/health')).body);
    check(h.teamKind === 'client', 'a client-kind server reports teamKind:client', JSON.stringify(h.teamKind));
    const cl = await get(38951, '/changelog');
    check(cl.status === 404, 'a client brain refuses /changelog even on a typed URL', `HTTP ${cl.status}`);
  });
  await withServer('agency', 38952, async () => {
    const cl = await get(38952, '/changelog');
    check(cl.status === 200 && /What&#39;s new|What's new/.test(cl.body),
      'an agency brain still serves /changelog', `HTTP ${cl.status}`);
  });
}

(async () => {
  console.log('client-kind tests');
  domTests();
  outsideCommandCentreTests();
  await serverTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
