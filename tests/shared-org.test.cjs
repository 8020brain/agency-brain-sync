#!/usr/bin/env node
/**
 * Shared-organisation warning — the setup wizard says something when the GitHub
 * organisation someone named already holds another brain from the same agency.
 *
 *   node tests/shared-org.test.cjs
 *
 * Why this exists: putting several clients in one organisation WORKS, and the
 * brains stay separate, so nothing may refuse it (Mike, 2026-08-12). What it
 * costs is handover. The two-minute handover invites the brain's owner into the
 * ORGANISATION as an owner, and a GitHub organisation owner can read every
 * repository in it, so from a shared organisation that would hand them everyone
 * else's brain and removing your own account would cut you off from all of them
 * at once. Handover from a shared organisation is a repository transfer, which
 * is about an hour's work. Nobody discovers that at handover time on purpose,
 * so the wizard says it at the moment the organisation is chosen.
 *
 * Covers:
 *   A) wording  — what the panel says for one other brain, several, and for a
 *                 reader the server won't name them to.
 *   B) safety   — nothing to say stays nothing, and a withheld name stays out.
 *   C) wiring   — the check, the panel and both ways out are really connected,
 *                 and nothing in the path can refuse a setup.
 */

const fs = require('fs');
const path = require('path');

const { joinNames, describeSharedOrg } = require('../lib/shared-org.cjs');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok   ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
function check(cond, name, detail) { cond ? ok(name) : bad(name, detail); }

const ROOT = path.join(__dirname, '..');
const WIZ_JS = fs.readFileSync(path.join(ROOT, 'src', 'wizard.js'), 'utf8');
const WIZ_HTML = fs.readFileSync(path.join(ROOT, 'src', 'wizard.html'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

const CARTER = { slug: 'carter-homes', name: 'Carter Homes' };
const DUNN = { slug: 'dunn-motors', name: 'Dunn Motors' };

// -------------------------------------------------------------- A) wording ---
console.log('\nA) what the panel says');

check(joinNames(['A']) === 'A', 'one name is just the name');
check(joinNames(['A', 'B']) === 'A and B', 'two names read as prose');
check(joinNames(['A', 'B', 'C']) === 'A, B and C', 'three names read as prose');

const one = describeSharedOrg({ org: 'acme-marketing', count: 1, clients: [CARTER] }, 'before');
check(one.heading === 'acme-marketing already holds another AI brain.',
  'one other brain: the heading names the organisation', one.heading);
check(one.body[0].startsWith('That one belongs to Carter Homes.'),
  'one other brain: it says whose', one.body[0]);
check(/stay separate/.test(one.body[0]), 'it says the brains stay separate');
check(/repository they haven't been added to/.test(one.body[0]),
  'it says why they stay separate, rather than asking to be believed');

const two = describeSharedOrg({ org: 'acme-marketing', count: 2, clients: [CARTER, DUNN] }, 'before');
check(two.heading === 'acme-marketing already holds 2 other AI brains.',
  'several: the heading counts them', two.heading);
check(two.body[0].startsWith('They belong to Carter Homes and Dunn Motors.'),
  'several: it names them all', two.body[0]);

check(/two minutes/.test(one.body[1]) && /transferring the repository/.test(one.body[1]),
  'the cost is stated as handover: two minutes becomes a repository transfer');
check(/organisation owner can read every repository/.test(one.body[1]),
  'it gives the reason, which is what an organisation owner can read');

check(/free/.test(one.body[2]) && /no limit/.test(one.body[2]),
  'before the brain exists: a new organisation is offered as free and unlimited', one.body[2]);
const after = describeSharedOrg({ org: 'acme-marketing', count: 1, clients: [CARTER] }, 'after');
check(/nothing to do now/.test(after.body[2]) && !/no limit/.test(after.body[2]),
  'after the brain exists: it stops offering a choice that has passed', after.body[2]);

// The claim GitHub does not make. Nothing in the wording may invent a cap.
check(!/\b(limit of|maximum of|up to \d+) organisation/i.test(JSON.stringify(one)),
  'it never claims GitHub caps how many organisations you can have');

// --------------------------------------------------------------- B) safety ---
console.log('\nB) nothing to say, and nothing to leak');

check(describeSharedOrg(null, 'before') === null, 'no finding means no panel');
check(describeSharedOrg({ org: 'acme-marketing', count: 0, clients: [] }, 'before') === null,
  'a finding of zero means no panel');

// Whoever runs a client brain's setup holds the CLIENT owner's token, so the
// server sends the count with no names. The panel must not invent any.
const unnamed = describeSharedOrg({ org: 'acme-marketing', count: 2, clients: [] }, 'before');
check(unnamed.heading === 'acme-marketing already holds 2 other AI brains.',
  'names withheld: the count still lands', unnamed.heading);
check(!/belong to/.test(unnamed.body[0]),
  'names withheld: it does not pretend to name anyone', unnamed.body[0]);
check(unnamed.body[0].startsWith('You can put this brain there too'),
  'names withheld: it still opens with the permission, not an apology', unnamed.body[0]);

// --------------------------------------------------------------- C) wiring ---
console.log('\nC) the check, the panel and both ways out are connected');

check(/require\('\.\/lib\/shared-org\.cjs'\)/.test(MAIN), 'main.js uses the shared wording');
check(/ipcMain\.handle\('check-org-brains'/.test(MAIN), 'main.js handles check-org-brains');
check(/api\/team-brain\/org-brain-check/.test(MAIN), 'it calls the side-effect-free server check');
check(/checkOrgBrains:.*'check-org-brains'/.test(PRELOAD), 'preload exposes checkOrgBrains');
check(/api\.checkOrgBrains\(/.test(WIZ_JS), 'the wizard asks before anyone is sent to GitHub');

// A warning that breaks a setup would be worse than no warning at all.
check((MAIN.match(/return \{ sharedOrg: null \};/g) || []).length >= 3,
  'every failure in the check resolves to "nothing to say"');
check(/catch \(e\) \{ \/\* a warning that breaks setup is worse than no warning \*\/ \}/.test(WIZ_JS),
  'the wizard swallows a failed check rather than stalling on it');

check(/id="shared-org-warning"/.test(WIZ_HTML), 'the panel exists');
check(/id="btn-shared-org-continue"/.test(WIZ_HTML), 'there is a "use it anyway" button');
check(/id="btn-shared-org-new"/.test(WIZ_HTML), 'there is a "make a new one" button');
check(/onPickAnother: resetOrgNameEntry/.test(WIZ_JS),
  '"make a new one" goes back to an empty box rather than a dead end');
check(/function resetOrgNameEntry/.test(WIZ_JS) && /input\.focus\(\)/.test(WIZ_JS),
  'that path puts the cursor back in the name box');

// Three ways a brain can land in a shared org (name check adopts an existing
// install, the poll adopts one, the poll ensures the repo). All three must warn.
const guarded = (WIZ_JS.match(/proceedAfterSharedOrg\(/g) || []).length;
check(guarded >= 4, 'all three success paths route through the acknowledgement', `found ${guarded - 1} call sites`);
check(/sharedOrgAcked/.test(WIZ_JS), 'a user warned before GitHub is not warned again on the way back');

// The wizard used to tell client setups that GitHub would refuse a second brain
// in one organisation. It does not refuse, and saying so contradicts the panel.
// Comments are stripped first, because the comment explaining the old wording
// quotes it (and a source comment is not something anyone reads on screen).
const WIZ_COPY = WIZ_JS.replace(/^\s*\/\/.*$/gm, '');
check(!/will not put a second brain/.test(WIZ_COPY),
  'the wizard no longer claims GitHub refuses a second brain in one organisation');

// --------------------------------------------------------------------------
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
