'use strict';

// Tests for the deterministic onboarding filer. Runnable standalone:
//   node command-centre/tests/onboarding-filer.test.cjs
// Guards: answers land under the named section, a re-answer updates in place and
// reports a contradiction, a repeat is a no-op, and filing never invents text.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const filer = require('../lib/onboarding-filer.cjs');

function tmpBrain() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ob-filer-'));
}

const Q_TEAM = {
  id: 'team-people',
  receipt: 'Who works here, and what each person is strongest at',
  q: 'Walk me through each person on the team.',
  dest: { file: 'context/TEMPLATE-team-profile.md', section: '## Team Members' }
};

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ok - ' + name); }

// 1. Fresh file gets title + section + block, and the answer text is verbatim.
ok('creates a missing file with the answer under its section', function () {
  const root = tmpBrain();
  const r = filer.fileAnswer(root, Q_TEAM, 'Deb runs sales, Tom runs delivery.', 'Deb', '2026-09-10');
  assert.strictEqual(r.action, 'added');
  const txt = fs.readFileSync(path.join(root, Q_TEAM.dest.file), 'utf8');
  assert.ok(txt.startsWith('# Team Profile'), 'has derived title');
  assert.ok(txt.includes('## Team Members'), 'has the section');
  assert.ok(txt.includes('Deb runs sales, Tom runs delivery.'), 'answer verbatim');
  assert.ok(txt.includes('_Answered by Deb, 2026-09-10_'), 'source line');
  assert.ok(txt.includes('<!-- ob:team-people -->'), 'marked block');
});

// 2. Appending under an EXISTING section keeps the heading and other content.
ok('appends under an existing section without touching other content', function () {
  const root = tmpBrain();
  const rel = path.join(root, 'context');
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, 'TEMPLATE-team-profile.md'),
    '# Team Profile\n\n## The Team\n\n[who you are]\n\n## Team Members\n\n[people]\n\n## Values\n\n[values]\n');
  const r = filer.fileAnswer(root, Q_TEAM, 'Just Deb for now.', 'Deb', '2026-09-10');
  assert.strictEqual(r.action, 'added');
  const txt = fs.readFileSync(path.join(rel, 'TEMPLATE-team-profile.md'), 'utf8');
  assert.ok(txt.includes('## The Team'), 'earlier section survives');
  assert.ok(txt.includes('## Values'), 'later section survives');
  assert.ok(txt.includes('[values]'), 'later placeholder untouched');
  // The block sits between Team Members and Values.
  assert.ok(txt.indexOf('Just Deb for now.') > txt.indexOf('## Team Members'), 'under its heading');
  assert.ok(txt.indexOf('Just Deb for now.') < txt.indexOf('## Values'), 'before the next heading');
});

// 3. Re-answering the SAME question updates in place and flags a contradiction.
ok('a changed re-answer updates in place and reports a contradiction', function () {
  const root = tmpBrain();
  filer.fileAnswer(root, Q_TEAM, 'Six people.', 'Deb', '2026-09-10');
  const r = filer.fileAnswer(root, Q_TEAM, 'Actually eight people.', 'Deb', '2026-09-11');
  assert.strictEqual(r.action, 'updated');
  assert.ok(r.contradiction, 'reports a contradiction');
  assert.strictEqual(r.contradiction.was, 'Six people.');
  assert.strictEqual(r.contradiction.now, 'Actually eight people.');
  const txt = fs.readFileSync(path.join(root, Q_TEAM.dest.file), 'utf8');
  assert.ok(txt.includes('Actually eight people.'), 'new answer present');
  assert.ok(!txt.includes('Six people.'), 'old answer replaced, not duplicated');
  // Exactly one block for this question.
  assert.strictEqual((txt.match(/<!-- ob:team-people -->/g) || []).length, 1, 'no duplicate block');
});

// 4. Re-filing the identical answer is a no-op.
ok('an identical re-answer is unchanged', function () {
  const root = tmpBrain();
  filer.fileAnswer(root, Q_TEAM, 'Six people.', 'Deb', '2026-09-10');
  const r = filer.fileAnswer(root, Q_TEAM, '  Six people.  ', 'Deb', '2026-09-12');
  assert.strictEqual(r.action, 'unchanged');
  assert.strictEqual(r.contradiction, null);
});

// 5. Empty answers are refused (the board never files a blank).
ok('refuses an empty answer', function () {
  const root = tmpBrain();
  assert.throws(function () { filer.fileAnswer(root, Q_TEAM, '   ', 'Deb'); }, /empty answer/);
});

// 6. The status doc renders deterministically with contradictions listed.
ok('syncStatusDoc writes progress and notes', function () {
  const root = tmpBrain();
  const abs = filer.syncStatusDoc(root, {
    files: [
      { label: 'context/team-profile.md', done: true },
      { label: 'context/business-overview.md', done: false }
    ],
    contradictions: [
      { qid: 'team-people', label: 'Team size', was: 'Six', now: 'Eight', by: 'Deb', at: '2026-09-11' }
    ]
  });
  const txt = fs.readFileSync(abs, 'utf8');
  assert.ok(txt.includes('**Status:** 1/2 complete'), 'progress line');
  assert.ok(txt.includes('[x] `context/team-profile.md`'), 'done ticked');
  assert.ok(txt.includes('[ ] `context/business-overview.md`'), 'undone unticked');
  assert.ok(txt.includes('was "Six", now "Eight"'), 'contradiction noted');
});

console.log('\nonboarding-filer: ' + passed + ' passed');
