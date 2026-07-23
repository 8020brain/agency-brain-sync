#!/usr/bin/env node
'use strict';
/*
 * SessionEnd hook (Claude Code / scouts): after a session finishes, push any
 * changes to the vault and remove the local plaintext, so the sensitive files
 * are not left sitting on disk between sessions.
 *
 * Wire it into the AGENCY BRAIN'S .claude/settings.json:
 *
 *   "hooks": {
 *     "SessionEnd": [
 *       { "hooks": [ { "type": "command",
 *         "command": "node '<app>/lib/vault/hooks/session-end-scrub.cjs'" } ] }
 *     ]
 *   }
 *
 * This clean scrub-after-every-session ONLY works in Claude Code, which has
 * hooks. Cowork has none, so there the plaintext lives on disk while a session
 * is open and FileVault is the at-rest cover for that transient copy — be
 * straight with agencies about that (see ../README.md).
 *
 * Order matters: push first (so this session's edits are saved), THEN scrub.
 * scrub only deletes files it can prove are in the vault, so a failed push means
 * nothing gets deleted. Best-effort, non-blocking, always exits 0.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let config = { posture: 'local', scrubOnExit: true };
try {
  const cfg = require(path.join(__dirname, '..', 'config.cjs'));
  config = cfg.loadSecurityConfig(root).config;
} catch (_) {}

if (config.posture !== 'vault' || config.scrubOnExit === false) process.exit(0);

const cli = path.join(__dirname, '..', 'cli.cjs');
function run(argsList) {
  return spawnSync(process.execPath, [cli, ...argsList, '--root', root], { encoding: 'utf8' });
}

const pushed = run(['push']);
if (pushed.status !== 0) {
  process.stdout.write(`[vault] push failed, NOT scrubbing (nothing deleted): ${(pushed.stderr || pushed.stdout || '').trim()}\n`);
  process.exit(0);
}
const scrubbed = run(['scrub']);
process.stdout.write(`[vault] ${(scrubbed.stdout || scrubbed.stderr || '').trim()}\n`);
process.exit(0);
