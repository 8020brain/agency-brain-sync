#!/usr/bin/env node
'use strict';
/*
 * SessionStart hook (Claude Code / scouts): pull the encrypted vault bundle and
 * restore the sensitive files before the session reads anything.
 *
 * Wire it into the AGENCY BRAIN'S .claude/settings.json:
 *
 *   "hooks": {
 *     "SessionStart": [
 *       { "hooks": [ { "type": "command",
 *         "command": "node '<app>/lib/vault/hooks/session-start-pull.cjs'" } ] }
 *     ]
 *   }
 *
 * ("<app>" = wherever the Agency Brain app installed its resources, or a copy of
 * lib/vault/ inside the brain.)
 *
 * It is deliberately best-effort and NON-BLOCKING: any failure exits 0 with a
 * short note, so a vault hiccup never stops a session. The safe failure mode is
 * "missing context," not "leaked data" — the plaintext genuinely isn't on disk
 * until a successful pull.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let posture = 'local';
try {
  const cfg = require(path.join(__dirname, '..', 'config.cjs'));
  posture = cfg.loadSecurityConfig(root).config.posture;
} catch (_) { /* no config = local = nothing to do */ }

if (posture !== 'vault') process.exit(0);

const cli = path.join(__dirname, '..', 'cli.cjs');
const r = spawnSync(process.execPath, [cli, 'pull', '--root', root], { encoding: 'utf8' });
if (r.status === 0) {
  process.stdout.write(`[vault] ${(r.stdout || '').trim()}\n`);
} else {
  process.stdout.write(`[vault] pull skipped: ${(r.stderr || r.stdout || 'unknown error').trim()}\n`);
}
process.exit(0);
