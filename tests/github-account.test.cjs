#!/usr/bin/env node
/**
 * Organisation-name check tests — the setup wizard must rule on the name
 * BEFORE anyone is sent to GitHub.
 *
 *   node tests/github-account.test.cjs
 *
 * Why this exists: step 2 of the wizard used to be a single button that opened
 * GitHub's "where do you want to install this?" account list. That list gives
 * no sign of which row is a personal account (where GitHub will not let an app
 * create a repository) and which is an organisation that already has the app
 * (where the only offer is "Configure", which never reports back to us). So
 * people landed on a page where nothing they clicked could work. On 2026-07-30,
 * 16 of 50 agency teams and 2 of 6 client teams had never got past that screen.
 *
 * The fix checks the typed name against GitHub's public user endpoint first, so
 * the dead ends become a sentence on our own screen, and captures the numeric
 * account id so the connect button can deep-link to that ONE organisation.
 *
 * Covers:
 *   A) names   — what someone realistically types or pastes normalises to a
 *                bare account name, and GitHub's own name rules are enforced.
 *   B) ruling  — each GitHub response maps to a reason the wizard can state
 *                truthfully, and only an Organization is allowed through.
 *   C) wiring  — the wizard screen, its IPC surface, and the deep link are
 *                actually connected, and the old one-button flow is gone.
 */

const fs = require('fs');
const path = require('path');

const {
  normaliseAccountName,
  isValidAccountName,
  classifyAccount,
} = require('../lib/github-account.cjs');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok   ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
function check(cond, name, detail) { cond ? ok(name) : bad(name, detail); }

const ROOT = path.join(__dirname, '..');
const WIZ_JS = fs.readFileSync(path.join(ROOT, 'src', 'wizard.js'), 'utf8');
const WIZ_HTML = fs.readFileSync(path.join(ROOT, 'src', 'wizard.html'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

// ---------------------------------------------------------------- A) names ---
console.log('\nA) what people type normalises to a bare account name');

for (const [input, want] of [
  ['acme-client-co', 'acme-client-co'],
  ['  acme-client-co  ', 'acme-client-co'],
  ['@acme-client-co', 'acme-client-co'],
  ['https://github.com/acme-client-co', 'acme-client-co'],
  ['https://www.github.com/acme-client-co', 'acme-client-co'],
  ['http://github.com/acme-client-co/business-brain', 'acme-client-co'],
  ['github.com/acme-client-co', 'github.com'],   // no scheme: first path part wins
  ['', ''],
  [null, ''],
  [undefined, ''],
]) {
  const got = normaliseAccountName(input);
  check(got === want, `${JSON.stringify(input)} -> ${JSON.stringify(want)}`, `got ${JSON.stringify(got)}`);
}

console.log("\nA) GitHub's own name rules are enforced before we call out");
for (const good of ['a', 'acme', 'acme-client-co', 'A1', '8020brain', 'a'.repeat(39)]) {
  check(isValidAccountName(good), `accepts ${good.length > 20 ? `${good.length} chars` : good}`);
}
for (const bad_ of ['', '-acme', 'acme-', 'acme--co', 'acme co', 'acme.co', 'acme/co', 'a'.repeat(40)]) {
  check(!isValidAccountName(bad_), `rejects ${JSON.stringify(bad_)}`);
}

// --------------------------------------------------------------- B) ruling ---
console.log('\nB) every GitHub answer maps to a reason the wizard can state');

const org = classifyAccount(200, { login: 'Acme-Client-Co', id: 308240756, type: 'Organization' }, 'acme-client-co');
check(org.ok === true, 'an organisation is allowed through');
check(org.reason === 'org', 'organisation reason is "org"', org.reason);
check(org.id === 308240756, 'the numeric id comes back (needed for the deep link)', String(org.id));
check(org.login === 'Acme-Client-Co', "GitHub's own capitalisation is preserved", org.login);

const person = classifyAccount(200, { login: 'mikerhodesideas', id: 148161769, type: 'User' }, 'mikerhodesideas');
check(person.ok === false, 'a personal account is refused');
check(person.reason === 'personal-account', 'personal account is named as such', person.reason);

const missing = classifyAccount(404, { message: 'Not Found' }, 'nope-not-real');
check(missing.ok === false && missing.reason === 'not-found', 'a name GitHub has never heard of is "not-found"', missing.reason);

for (const status of [403, 429]) {
  const r = classifyAccount(status, {}, 'acme');
  check(r.ok === false && r.reason === 'rate-limited', `HTTP ${status} is reported as rate-limited`, r.reason);
}

const broken = classifyAccount(500, null, 'acme');
check(broken.ok === false && broken.reason === 'lookup-failed', 'a server error is "lookup-failed"', broken.reason);
check(/HTTP 500/.test(broken.detail || ''), 'the failure detail names the status', broken.detail);

// A body we can't read must never be mistaken for an organisation.
const empty = classifyAccount(200, null, 'acme');
check(empty.ok === false && empty.reason === 'personal-account', 'an unreadable body is not treated as an organisation', empty.reason);

// --------------------------------------------------------------- C) wiring ---
console.log('\nC) the screen, the IPC surface and the deep link are connected');

check(/ipcMain\.handle\('github-account-lookup'/.test(MAIN), 'main.js handles github-account-lookup');
check(/require\('\.\/lib\/github-account\.cjs'\)/.test(MAIN), 'main.js uses the shared helpers');
check(/api\.github\.com\/users\//.test(MAIN), 'the lookup hits the public users endpoint (no token needed)');
check(/lookupGithubAccount:.*'github-account-lookup'/.test(PRELOAD), 'preload exposes lookupGithubAccount');
check(/api\.lookupGithubAccount\(/.test(WIZ_JS), 'the wizard calls it');

for (const id of ['btn-create-org', 'orgNameInput', 'btn-check-org', 'org-check-status', 'org-step-3']) {
  check(WIZ_HTML.includes(`id="${id}"`), `the screen has #${id}`);
}
check(/id="org-step-1"[\s\S]*id="org-step-2"[\s\S]*id="org-step-3"/.test(WIZ_HTML),
  'the three blocks appear in the order they have to happen');
check(/<div class="org-step locked" id="org-step-3">/.test(WIZ_HTML),
  'connecting starts locked, so nobody reaches GitHub before the name is checked');
check(/id="btn-connect-org" type="button" disabled/.test(WIZ_HTML),
  'the connect button starts disabled');

// The deep link is the part that removes GitHub's ambiguous account list.
check(/installations\/new\/permissions/.test(WIZ_JS), 'connect deep-links to a single account');
check(/suggested_target_id=\$\{encodeURIComponent\(verifiedOrg\.id\)\}/.test(WIZ_JS),
  'the deep link carries the verified account id');
check(/state=\$\{encodeURIComponent\(connectOrgSlug\)\}/.test(WIZ_JS),
  'the deep link still carries the team slug, or the install can never be linked back');
check(/lockConnectStep\(\)/.test(WIZ_JS) && /unlockConnectStep\(/.test(WIZ_JS),
  'the connect step is locked and unlocked explicitly');

// Editing the name must invalidate a previous pass, or someone could check a
// good org, retype a bad one, and still be deep-linked to the good one.
const inputHandler = WIZ_JS.match(/orgInput\.addEventListener\('input'[\s\S]{0,800}?\}\);/);
check(!!inputHandler && /lockConnectStep\(\)/.test(inputHandler[0]),
  're-typing the name re-locks the connect step');

// The old flow's dead ends must be gone, not just bypassed.
check(!/id="link-create-org"/.test(WIZ_HTML), 'the old "create one on GitHub" footnote link is gone');
check(!/id="connect-org-orghelp"/.test(WIZ_HTML), 'the old organisation-help paragraph is gone');
check(!/the app most likely got installed on a personal account/.test(WIZ_HTML),
  'the stall hint no longer guesses at a personal account');
check(/id="connect-org-stall-msg"/.test(WIZ_HTML), 'the stall hint is filled in from what we actually know');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
