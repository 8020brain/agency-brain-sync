// local-identity.test.cjs — the CLAUDE.local.md writer.
//
// Guards the 2026-08-13 fix for Peter Empson's items 4/5: the identity file
// must take the NAME from the live roster (roles.json), not only the role, so a
// wrong stored name ("Rok Systems" on an agency seat) can't keep writing "You
// are the brain instance for Rok Systems"; and the article must agree with the
// role ("an owner", not "a owner").
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const li = require('../command-centre/lib/local-identity.cjs');

function tmpBrain(roles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ident-'));
  fs.mkdirSync(path.join(dir, '.team-config'), { recursive: true });
  if (roles) fs.writeFileSync(path.join(dir, '.team-config', 'roles.json'), JSON.stringify(roles));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Brain\n');
  return dir;
}
function body(dir) { return fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf8'); }

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ok -', name); }

console.log('local-identity:');

// nameFromRoster resolves the live name, case-insensitively, and is empty when absent.
ok('nameFromRoster returns the roster name for a matching email', () => {
  const dir = tmpBrain({ members: [{ email: 'petere@roksys.co.uk', name: 'Peter Empson', role: 'owner' }] });
  assert.strictEqual(li.nameFromRoster(dir, 'PeterE@Roksys.co.uk'), 'Peter Empson');
});
ok('nameFromRoster is empty when the email is not on the roster', () => {
  const dir = tmpBrain({ members: [{ email: 'other@x.com', name: 'Someone', role: 'team' }] });
  assert.strictEqual(li.nameFromRoster(dir, 'petere@roksys.co.uk'), '');
});
ok('nameFromRoster is empty when roles.json is missing', () => {
  const dir = tmpBrain(null);
  assert.strictEqual(li.nameFromRoster(dir, 'petere@roksys.co.uk'), '');
});

// The article agrees with the role (the "a owner" bug).
ok('owner writes "an owner"', () => {
  const dir = tmpBrain(null);
  li.writeLocalIdentity({ brainRoot: dir, name: 'Peter Empson', role: 'owner', teamKind: 'client', teamName: 'Rok Systems' });
  assert.ok(body(dir).includes('**Peter Empson**, an **owner** at'), body(dir));
});
ok('team writes "a team"', () => {
  const dir = tmpBrain(null);
  li.writeLocalIdentity({ brainRoot: dir, name: 'Team Member', role: 'team', teamKind: 'client', teamName: 'Rok Systems' });
  assert.ok(body(dir).includes('**Team Member**, a **team** at'), body(dir));
});
ok('agency writes "an agency"', () => {
  const dir = tmpBrain(null);
  li.writeLocalIdentity({ brainRoot: dir, name: 'Peter Empson', role: 'agency', teamKind: 'agency', teamName: 'Rok Systems' });
  assert.ok(body(dir).includes('an **agency** at'), body(dir));
});

// End to end: writing the roster-derived name never reproduces the company name.
ok('writing the roster name yields the person, not the stored company name', () => {
  const dir = tmpBrain({ members: [{ email: 'petere@roksys.co.uk', name: 'Peter Empson', role: 'owner' }] });
  const stored = 'Rok Systems'; // the wrong config snapshot
  const resolved = li.nameFromRoster(dir, 'petere@roksys.co.uk') || stored;
  li.writeLocalIdentity({ brainRoot: dir, name: resolved, role: 'owner', teamKind: 'client', teamName: 'Rok Systems' });
  const txt = body(dir);
  assert.ok(txt.includes('for **Peter Empson**,'), txt);
  assert.ok(!txt.includes('for **Rok Systems**,'), 'must not write the company name as the person');
});

console.log(`\n${passed} passed`);
