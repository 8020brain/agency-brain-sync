#!/usr/bin/env node
/**
 * AGENTS.md tests: the instruction file moved, the safety rules must not.
 *
 *   node tests/agents-md.test.cjs
 *
 * Since August 2026 a brain keeps its instructions in AGENTS.md and leaves a
 * two-line CLAUDE.md beside it that only points at AGENTS.md. Brains from
 * before that carry a full CLAUDE.md and no AGENTS.md. Three things have to
 * hold across both shapes, and none of them is obvious from reading the code:
 *
 *   A) The team write filter still blocks the new provider folders. `.codex/`
 *      and `.agents/` are covered today only because pathBlockedForRole denies
 *      every root dotpath. That is the right rule, but it is incidental
 *      coverage, and a future refactor that swaps the deny model for a named
 *      list would hand every team member write access to another assistant's
 *      hooks and skills without a single test going red.
 *   B) A folder holding only AGENTS.md still reads as a brain. Miss this and
 *      the wizard treats a converted brain as an empty repo and seeds the
 *      template over the top of it.
 *   C) Nothing ever reads the pointer stub as if it held content. The stub has
 *      no agency name and no placeholders in it, so a caller that reads it sees
 *      a brain that looks finished and reports the opposite of the truth.
 */

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readInstructions, isPointerStub } = require('../command-centre/lib/instructions.cjs');

const POINTER = '@AGENTS.md\n\nRead AGENTS.md in this folder and follow it. All instructions for this brain live there.\n';

// Lift a named top-level function out of a source file rather than importing it
// (main.js pulls in Electron; the watcher runs a sync loop on load). Same trick
// as claude-detection.test.cjs and sync-recovery.test.cjs section H.
function lift(file, name) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  assert.ok(m, `${file} no longer defines ${name}(), did it get renamed?`);
  // eslint-disable-next-line no-new-func
  return new Function('fs', 'path', `${m[0]}\nreturn ${name};`)(fs, path);
}

let passed = 0;
const queue = [];
function check(label, fn) { queue.push({ label, fn }); }

function tmpBrain(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-agents-'));
  build(root);
  return root;
}

// ---- A) the team write filter ---------------------------------------------

const pathBlockedForRole = lift('watcher/team-brain-sync.js', 'pathBlockedForRole');

const filterCases = [
  ['.codex/config.toml', 'team', true, "a team member can't write Codex config"],
  ['.codex/hooks.json', 'team', true, "a team member can't write Codex hooks"],
  ['.agents/skills/x/SKILL.md', 'team', true, "a team member can't write an .agents skill"],
  ['AGENTS.md', 'team', true, 'the root instruction file stays read-only for a team member'],
  ['CLAUDE.md', 'team', true, 'the root pointer stays read-only for a team member'],
  ['.codex/hooks.json', 'owner', false, 'an owner writes Codex hooks'],
  ['.agents/skills/x/SKILL.md', 'scout', false, 'a scout writes an .agents skill'],
  ['AGENTS.md', 'scout', false, 'a scout owns the root instruction file'],
  ['.team-config/feedback/skill.md', 'team', false, 'a team member can still file a skill flag'],
  ['context/business/notes.md', 'team', false, 'content folders stay writable'],
];
for (const [rel, role, want, label] of filterCases) {
  check(`A: ${label}`, () => {
    assert.strictEqual(pathBlockedForRole(rel, role), want,
      `${rel} as ${role} → blocked=${pathBlockedForRole(rel, role)}, expected ${want}`);
  });
}

// ---- B) brain detection ----------------------------------------------------

const folderHoldsBrain = lift('main.js', 'folderHoldsBrain');

check('B: a folder holding only AGENTS.md is a brain', () => {
  const root = tmpBrain((d) => fs.writeFileSync(path.join(d, 'AGENTS.md'), '# Brain\n'));
  try { assert.strictEqual(folderHoldsBrain(root), true); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('B: a converted brain (AGENTS.md + pointer + .claude) is a brain', () => {
  const root = tmpBrain((d) => {
    fs.writeFileSync(path.join(d, 'AGENTS.md'), '# Brain\n');
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), POINTER);
    fs.mkdirSync(path.join(d, '.claude'));
  });
  try { assert.strictEqual(folderHoldsBrain(root), true); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('B: an older brain with only CLAUDE.md is still a brain', () => {
  const root = tmpBrain((d) => fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# Brain\n'));
  try { assert.strictEqual(folderHoldsBrain(root), true); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('B: an empty folder is not a brain', () => {
  const root = tmpBrain(() => {});
  try { assert.strictEqual(folderHoldsBrain(root), false); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- C) the pointer is never read as content -------------------------------

check('C: the pointer stub is recognised whatever follows it', () => {
  assert.strictEqual(isPointerStub(POINTER), true);
  assert.strictEqual(isPointerStub('\n\n@AGENTS.md\n'), true, 'leading blank lines still a pointer');
  assert.strictEqual(isPointerStub('# My agency\n\n@AGENTS.md\n'), false, 'a real file that imports is not a pointer');
  assert.strictEqual(isPointerStub(''), false);
});

check('C: a converted brain resolves to AGENTS.md, never the pointer', () => {
  const root = tmpBrain((d) => {
    fs.writeFileSync(path.join(d, 'AGENTS.md'), '# {{ AGENCY NAME }}\n');
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), POINTER);
  });
  try {
    const found = readInstructions(root);
    assert.ok(found, 'expected an instruction file');
    assert.strictEqual(found.name, 'AGENTS.md');
    assert.ok(found.text.includes('{{ AGENCY NAME }}'), 'expected the real content, got the pointer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('C: an older brain resolves to CLAUDE.md', () => {
  const root = tmpBrain((d) => fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# {{ AGENCY NAME }}\n'));
  try {
    const found = readInstructions(root);
    assert.ok(found && found.name === 'CLAUDE.md', 'expected CLAUDE.md, got ' + JSON.stringify(found && found.name));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A pointer with nothing to point at is a broken pair, not a brain full of
// rules. Returning it would let a caller read "no placeholders here" off a file
// that never had any.
check('C: a lone pointer resolves to nothing', () => {
  const root = tmpBrain((d) => fs.writeFileSync(path.join(d, 'CLAUDE.md'), POINTER));
  try { assert.strictEqual(readInstructions(root), null); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('C: neither file present resolves to nothing', () => {
  const root = tmpBrain(() => {});
  try { assert.strictEqual(readInstructions(root), null); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log('agents.md (instruction file + provider paths)');
let failed = 0;
for (const { label, fn } of queue) {
  try { fn(); console.log(`  ok  ${label}`); passed++; }
  catch (e) { console.error(`  FAIL  ${label}\n        ${e.message}`); failed++; process.exitCode = 1; }
}
console.log(`\n${passed}/${queue.length} passed${failed ? ', SOME FAILED' : ''}`);
