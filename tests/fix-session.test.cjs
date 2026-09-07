#!/usr/bin/env node
/**
 * "Help me fix this" (lib/fix-session.cjs): the file handed to the person's own
 * Claude carries the cause code, the app's reason, git's raw detail (LOCAL only,
 * this file never leaves the machine), the held files, the log tail and the
 * playbook for the code; an unknown code falls back to the UNKNOWN playbook; the
 * prompt for a client brain never names the agency's supplier.
 *
 *   node tests/fix-session.test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { buildFixMe, fixPrompt } = require('../lib/fix-session.cjs');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok   ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-fix-'));
const brain = path.join(root, 'brain');
const userData = path.join(root, 'userData');
const playbooks = path.join(root, 'playbooks');
try {
  fs.mkdirSync(brain); fs.mkdirSync(playbooks);
  execSync('git init -q', { cwd: brain });
  fs.writeFileSync(path.join(brain, 'note.md'), 'hello\n');
  fs.writeFileSync(path.join(playbooks, 'FOREIGN_HOOK.md'), '# Playbook FOREIGN_HOOK\nread-only first\n');
  fs.writeFileSync(path.join(playbooks, 'UNKNOWN.md'), '# Playbook UNKNOWN\ndiagnose from the evidence\n');
  const logFile = path.join(root, 'sync.log');
  fs.writeFileSync(logFile, Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');

  const RAW = 'BLOCKED by pre-commit: E-MAIL clients/mueller.md:76 (private text)';
  const out = buildFixMe({
    userData, logFile, brainPath: brain, appName: 'Test Brain', playbooksDir: playbooks,
    payload: { state: 'stop', reason: "can't save: a check installed on this computer blocked the save", code: 'FOREIGN_HOOK', detail: RAW, attempts: 4, updatedAt: '2026-09-08T00:00:00.000Z', held: [{ file: 'x.md', why: 'set aside' }] },
  });
  const md = fs.readFileSync(out, 'utf8');
  if (out === path.join(userData, 'fix-me.md')) ok('writes <userData>/fix-me.md'); else bad('wrong path', out);
  if (md.includes('**FOREIGN_HOOK**')) ok('carries the cause code'); else bad('code missing');
  if (md.includes(RAW)) ok('carries git\'s raw detail for the local agent'); else bad('raw detail missing');
  if (md.includes('- x.md: set aside')) ok('lists held files'); else bad('held files missing');
  if (md.includes('line 80') && !md.includes('line 20\n')) ok('log tail is the last 60 lines'); else bad('log tail wrong');
  if (md.includes('?? note.md')) ok('git status of the brain folder'); else bad('git status missing', md.slice(md.indexOf('Brain folder status'), md.indexOf('Brain folder status') + 200));
  if (md.includes('# Playbook FOREIGN_HOOK')) ok('includes the playbook for the code'); else bad('playbook missing');

  const md2 = fs.readFileSync(buildFixMe({ userData, logFile, brainPath: brain, appName: 'T', playbooksDir: playbooks, payload: { state: 'stop', reason: 'x', code: 'NOT_A_CODE' } }), 'utf8');
  if (md2.includes('**UNKNOWN**') && md2.includes('# Playbook UNKNOWN')) ok('an off-list code falls back to UNKNOWN and its playbook'); else bad('fallback wrong');
  const md3 = fs.readFileSync(buildFixMe({ userData, logFile, brainPath: brain, appName: 'T', playbooksDir: playbooks, payload: { state: 'stop', reason: 'x', code: 'DISK_FULL' } }), 'utf8');
  if (md3.includes('**DISK_FULL**') && md3.includes('# Playbook UNKNOWN')) ok('a code with no playbook file borrows the UNKNOWN playbook'); else bad('missing-playbook fallback wrong');

  const p1 = fixPrompt('/x/fix-me.md', { clientBrain: false });
  const p2 = fixPrompt('/x/fix-me.md', { clientBrain: true });
  if (p1.includes('/x/fix-me.md') && p1.includes('--no-verify')) ok('prompt names the file and the guardrails'); else bad('prompt shape');
  if (!/mikerhodes|Agency Brain/i.test(p2)) ok('client-brain prompt never names the supplier'); else bad('client-brain prompt leaks the supplier', p2);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
