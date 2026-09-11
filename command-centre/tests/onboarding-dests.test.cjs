'use strict';

// The certainty guard Mike asked for (2026-09-11): people spend real time
// answering these questions, so every answer MUST land in the right context
// file, under a real heading. This asserts every question's destination section
// is an actual heading that ships in the template file — so a typo'd or renamed
// dest can never send an answer into a stray, wrong section.
//
// The valid headings are the contract. If a template's headings change, update
// this list in the same change, on purpose. Files the filer creates fresh
// (brand-voice.md, clients/.../context.md) have no pre-existing headings, so
// they're not constrained here.

const assert = require('assert');
const q = require('../lib/onboarding-questions.cjs');

// The headings that ship in the two TEMPLATE- context files (identical in the
// agency and client templates).
const VALID = {
  'context/TEMPLATE-business-overview.md': [
    '## Company', '## Revenue ([Current Month/Year])', '## Products & Pricing',
    '## Philosophy', '## Strategic Priorities', '## Operations', '## Tech'
  ],
  'context/TEMPLATE-team-profile.md': [
    '## The Team', '## Team Members', '## How We Work', '## Strengths (as a team)',
    '## Areas for Improvement', '## Skills & Expertise', '## Values', '## Communication Preferences'
  ]
};

let checked = 0, passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ok - ' + name); }

['agency', 'client'].forEach(function (kind) {
  ok(kind + ' questions all target a real heading in a real file', function () {
    q.bankFor(kind).TOPICS.forEach(function (t) {
      t.qs.forEach(function (qq) {
        assert.ok(qq.dest && qq.dest.file && qq.dest.section, kind + ' ' + qq.id + ': missing dest');
        if (VALID[qq.dest.file]) {
          checked++;
          assert.ok(VALID[qq.dest.file].includes(qq.dest.section),
            kind + ' ' + qq.id + ': section "' + qq.dest.section + '" is not a real heading in ' + qq.dest.file
            + ' (valid: ' + VALID[qq.dest.file].join(' | ') + ')');
        }
      });
    });
  });
});

ok('every question id is unique within its bank', function () {
  ['agency', 'client'].forEach(function (kind) {
    const seen = {};
    q.bankFor(kind).TOPICS.forEach(function (t) {
      t.qs.forEach(function (qq) { assert.ok(!seen[qq.id], 'duplicate id ' + qq.id + ' in ' + kind); seen[qq.id] = 1; });
    });
  });
});

console.log('\nonboarding-dests: ' + passed + ' passed (' + checked + ' template-file destinations checked)');
