#!/usr/bin/env node
/**
 * Privacy regression: a client's private text must NEVER reach the server roster
 * (Neon → the Workbench AB tab / the portal Your Clients page) through a sync
 * stop reason.
 *
 *   node tests/stop-reason-privacy.test.cjs
 *
 * The 2026-08-18 field report: Poeppel Rechtsanwaelte (a client brain under
 * Conversion Traffic) ran their own .git/hooks/pre-commit scanner that refuses
 * any save carrying an email address. It refused one client note, and the git
 * error it printed carried a named individual's case-file path and a private
 * home address. The app's stop report stripped the git access token and NOTHING
 * else, so that text went straight up to Mike's database and the roster.
 *
 * The fix keeps the full detail LOCAL (the member's own tray + log) and lets
 * only a code-authored classification leave the machine. This test loads the
 * REAL watcher module (boot is guarded so require() starts nothing) and checks
 * its two pure gates:
 *   - explainCommitFailure() splits member (quotes git) from server (a category).
 *   - serverStopReason() is structurally blind to git's raw words (extra.detail).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// A real git repo so the module's boot-time guards (BRAIN_PATH set + .git present)
// pass on require, in PERSONAL mode so the agency-token check doesn't exit.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-privacy-'));
execSync('git init -q', { cwd: repo });
process.env.BRAIN_PATH = repo;
delete process.env.BRAIN_SYNC_MODE; // personal
delete process.env.STATE_FILE;

const { serverStopReason, explainCommitFailure, explainPushFailure, foreignPrecommitHook } =
  require('../watcher/team-brain-sync.js');
const { CODES, CODE_LIST, classifyPushFailure } = require('../watcher/cause-codes.js');

// The client's private text, exactly the shape that leaked: a named person, a
// case-file path, and a home address, printed by the customer's own scanner.
const SECRET = "E-MAIL !inbox/clients/mueller/briefing-telefonat-2026-08-13.md:76 (Hans Müller, Musterstraße 5, 10115 Berlin)";
const RAW = `BLOCKED by pre-commit: ${SECRET}\nSave aborted.`;

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok   ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
const leaks = (s) => typeof s === 'string' && (s.includes(SECRET) || s.includes('Musterstraße') || s.includes('Hans Müller'));

const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
function setForeignHook() { fs.writeFileSync(hookPath, '#!/bin/sh\necho blocked\nexit 1\n', { mode: 0o755 }); }
function clearHook() { try { fs.unlinkSync(hookPath); } catch (_) {} }

try {
  // ── foreignPrecommitHook: a hook we didn't install reads as foreign ──
  clearHook();
  if (foreignPrecommitHook() === false) ok('no hook → not foreign'); else bad('no hook should not read as foreign');
  setForeignHook();
  if (foreignPrecommitHook() === true) ok('a hook without our marker reads as foreign'); else bad('foreign hook not detected');
  fs.writeFileSync(hookPath, '#!/bin/sh\n# Agency Brain large-file guard\nexit 0\n', { mode: 0o755 });
  if (foreignPrecommitHook() === false) ok('our own large-file guard is not foreign'); else bad('own hook misread as foreign');

  // ── explainCommitFailure: member quotes git, server classifies only ──
  setForeignHook();
  const ex = explainCommitFailure(RAW);
  if (ex.member.includes(SECRET)) ok('member reason quotes git so the person can act on it'); else bad('member reason dropped the detail', ex.member);
  if (!leaks(ex.server)) ok('server reason (hook branch) carries no client text'); else bad('LEAK: server reason quoted the client text', ex.server);
  if (ex.server === "can't save: a check installed on this computer blocked the save") ok('server reason is the hook classification'); else bad('unexpected server reason', ex.server);

  // Fallback branch (commit refused, but no foreign hook file present).
  clearHook();
  const fb = explainCommitFailure(RAW);
  if (fb.member.includes(SECRET)) ok('fallback member reason quotes git'); else bad('fallback member reason dropped detail', fb.member);
  if (!leaks(fb.server)) ok('fallback server reason carries no client text'); else bad('LEAK: fallback server reason quoted the client text', fb.server);

  // Code-authored branches are identical member/server (no git text either way).
  const ident = explainCommitFailure('fatal: could not read Username: tell me who you are');
  if (ident.member === ident.server && !leaks(ident.server)) ok('identity branch is one safe sentence'); else bad('identity branch diverged unexpectedly', ident.server);

  // ── serverStopReason: the one string that may leave the machine ──
  // Not the loud/stabilised kind of stop → nothing is reported.
  if (serverStopReason(false, ex.member, { detail: RAW }) === null) ok('non-alarm stop reports nothing'); else bad('non-alarm stop reported something');

  // The real commit-hook path: reason quotes the client, detail IS the raw git
  // output, serverReason is the classification. Only the classification leaves.
  const sent = serverStopReason(true, ex.member, { stuck: true, detail: RAW, serverReason: ex.server });
  if (!leaks(sent)) ok('server stop reason carries no client text (commit-hook path)'); else bad('LEAK: client text reached the server stop reason', sent);
  if (sent === ex.server) ok('serverReason wins over the git-quoting reason'); else bad('serverReason not preferred', sent);

  // Even with NO serverReason, detail must never be appended (the old leak).
  const sent2 = serverStopReason(true, "can't push your changes up", { stuck: true, detail: RAW });
  if (!leaks(sent2)) ok('detail is never appended to the server reason'); else bad('LEAK: detail appended to server reason', sent2);
  if (sent2 === "can't push your changes up") ok('a fixed-sentence reason passes through unchanged'); else bad('fixed reason altered', sent2);

  // ── Cause codes (2026-09-08): the only vocabulary about a stop that leaves ──
  // Every classifier answer is a code on the list, and every code has a playbook
  // for "Help me fix this". A code cannot carry a client's text by construction.
  setForeignHook();
  const exc = explainCommitFailure(RAW);
  if (exc.code === 'FOREIGN_HOOK') ok('commit classifier: foreign hook → FOREIGN_HOOK'); else bad('commit classifier code', exc.code);
  if (explainCommitFailure('fatal: could not read Username: tell me who you are').code === 'NO_GIT_IDENT') ok('commit classifier: identity → NO_GIT_IDENT'); else bad('identity code wrong');
  clearHook();
  if (explainCommitFailure(RAW).code === 'UNKNOWN') ok('commit classifier: no hook, unrecognised → UNKNOWN'); else bad('fallback code wrong');

  // A push refused by GitHub's secret scanning prints the file and line it found,
  // which is exactly the kind of text that must stay on the machine.
  const PUSH_RAW = `remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Push cannot contain secrets\nremote:   locations: ${SECRET}\n! [remote rejected] main -> main (push declined due to repository rule violations)`;
  const px = explainPushFailure(PUSH_RAW);
  if (px.code === 'PUSH_PROTECTION') ok('push classifier: GH013 → PUSH_PROTECTION'); else bad('push classifier code', px.code);
  if (px.member.includes('GH013')) ok('push member reason quotes git for the person'); else bad('push member reason lost the detail', px.member);
  if (!leaks(px.server) && px.server === "can't push your changes up: " + CODES.PUSH_PROTECTION.label) ok('push server reason is the code label, no client text'); else bad('LEAK or wrong push server reason', px.server);
  const sentPush = serverStopReason(true, px.member, { stuck: true, detail: PUSH_RAW, serverReason: px.server, code: px.code });
  if (!leaks(sentPush)) ok('push stop reason carries no client text on the wire'); else bad('LEAK: push stop reason', sentPush);

  const fixtures = [
    ['error: RPC failed; HTTP 400 curl 22 The requested URL returned error: 400\nsend-pack: unexpected disconnect while reading sideband packet', 'PUSH_NETWORK'],
    ['! [rejected] main -> main (fetch first)\nerror: failed to push some refs', 'PUSH_REJECTED'],
    ["remote: error: File big.zip is 150.00 MB; this exceeds GitHub's file size limit of 100.00 MB", 'PUSH_TOO_BIG'],
    ['remote: Repository not found.\nfatal: repository \'https://github.com/x/y.git/\' not found', 'REPO_GONE'],
    ['remote: Permission to x/y.git denied to bot.\nfatal: unable to access: The requested URL returned error: 403', 'PUSH_FORBIDDEN'],
    ['remote: error: GH013: Repository rule violations found', 'PUSH_PROTECTION'],
    ['something nobody has seen before', 'UNKNOWN'],
  ];
  for (const [raw, want] of fixtures) {
    const got = classifyPushFailure(raw);
    if (got === want) ok(`push classifier: ${want}`); else bad(`push classifier: expected ${want}`, got);
  }
  const unknownCodes = [exc.code, px.code, ...fixtures.map(([r]) => classifyPushFailure(r))].filter((c) => !CODE_LIST.includes(c));
  if (!unknownCodes.length) ok('every classifier answer is on the code list'); else bad('classifier produced a code off the list', unknownCodes.join(','));
  const playbooksDir = path.join(__dirname, '..', 'watcher', 'playbooks');
  const missing = CODE_LIST.filter((c) => !fs.existsSync(path.join(playbooksDir, `${c}.md`)));
  if (!missing.length) ok(`every one of the ${CODE_LIST.length} codes has a playbook`); else bad('codes with no playbook', missing.join(','));
  for (const c of CODE_LIST) {
    const d = CODES[c];
    if (!d.label || typeof d.selfClears !== 'boolean' || !(d.alertAfterMin > 0) || !Array.isArray(d.steps) || !d.steps.length) { bad(`code ${c} is missing a field`); }
  }
  ok('every code carries label, selfClears, alertAfterMin and steps');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
