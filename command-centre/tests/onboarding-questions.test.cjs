'use strict';

// Tests for the per-brain question override (resolveBank). A brain can tailor
// its questions with .team-config/onboarding/questions.json; a missing or
// invalid file must fall back to the built-in bank so the board never breaks.
// Runnable standalone: node command-centre/tests/onboarding-questions.test.cjs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const q = require('../lib/onboarding-questions.cjs');

function tmpBrain() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ob-q-')); }
function writeOverride(root, obj) {
  const dir = path.join(root, '.team-config', 'onboarding');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(obj));
}

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ok - ' + name); }

ok('no override file → built-in bank for the kind', function () {
  const root = tmpBrain();
  assert.deepStrictEqual(q.resolveBank(root, 'agency').TOPICS, q.bankFor('agency').TOPICS);
  assert.deepStrictEqual(q.resolveBank(root, 'client').TOPICS, q.bankFor('client').TOPICS);
});

ok('a valid override replaces the bank and indexes its questions', function () {
  const root = tmpBrain();
  writeOverride(root, { topics: [
    { id: 'basics', title: 'The basics', qs: [
      { id: 'suburbs', q: 'What suburbs do you serve?', receipt: 'Suburbs served',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Company' } }
    ] }
  ] });
  const bank = q.resolveBank(root, 'client');
  assert.strictEqual(bank.TOPICS.length, 1);
  assert.strictEqual(bank.TOPICS[0].qs[0].q, 'What suburbs do you serve?');
  assert.ok(bank.BY_ID.suburbs, 'the new question is indexed by id');
  assert.strictEqual(bank.BY_ID.suburbs.topic, 'basics', 'topic tagged');
});

ok('an invalid override (missing dest) falls back to the built-in bank', function () {
  const root = tmpBrain();
  writeOverride(root, { topics: [ { id: 't', title: 'T', qs: [ { id: 'x', q: 'No dest here' } ] } ] });
  assert.deepStrictEqual(q.resolveBank(root, 'client').TOPICS, q.bankFor('client').TOPICS);
});

ok('malformed JSON falls back, never throws', function () {
  const root = tmpBrain();
  const dir = path.join(root, '.team-config', 'onboarding');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'questions.json'), '{ not json');
  assert.deepStrictEqual(q.resolveBank(root, 'agency').TOPICS, q.bankFor('agency').TOPICS);
});

ok('defaultFileFor emits the override shape, round-trips through resolveBank', function () {
  const root = tmpBrain();
  const seed = q.defaultFileFor('client');
  assert.ok(Array.isArray(seed.topics) && seed.topics.length, 'has topics');
  assert.ok(seed.topics[0].qs[0].dest.file, 'carries dest');
  writeOverride(root, seed);
  // Seeding the default then resolving yields the same questions as the built-in.
  const ids = (b) => b.TOPICS.reduce((a, t) => a.concat(t.qs.map((x) => x.id)), []);
  assert.deepStrictEqual(ids(q.resolveBank(root, 'client')), ids(q.bankFor('client')));
});

console.log('\nonboarding-questions: ' + passed + ' passed');
