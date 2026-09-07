// "Help me fix this": hand a stopped brain's LOCAL detail to the person's own
// Claude, acting as them, so real help is delivered without anything leaving
// the machine.
//
// Why this shape (spec: brain projects/agencybrain/planning/20260908-block-self-heal-and-alerts.md):
// since the 2026-09-06 privacy fix, git's raw words about a failed save or push
// live only in the tray state file and sync.log on the person's computer. That
// is right (a customer's own security check once printed a client's case-file
// path and home address, and the old report carried it into the database), but
// it also means nobody off the machine can read the real error. So the agent
// that reads it runs ON the machine, with exactly the person's permissions:
//   1. Claude Code in a Terminal window in the brain folder, if it's installed
//      (the same launch the phone-dispatch feature uses, without tmux so a
//      missing tmux can't stop a person getting help);
//   2. else the Claude desktop app, with the prompt on the clipboard for a
//      Cowork session with the brain folder connected (main.js handles that);
//   3. else the fix-me.md file itself, which reads as steps a person can follow.
// The playbook per cause code lives in watcher/playbooks/<CODE>.md.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn, execFileSync } = require('child_process');
const { CODES } = require('../watcher/cause-codes');

const LOG_TAIL_LINES = 60;

function tail(file, lines) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const arr = txt.split('\n');
    return arr.slice(Math.max(0, arr.length - lines)).join('\n').trim();
  } catch (_) { return ''; }
}

function fence(s) { return '```\n' + String(s || '').replace(/```/g, "'''") + '\n```'; }

// Build <userData>/fix-me.md from the tray's last stop payload (the state file
// the watcher writes: state, reason, code, detail, held, attempts, updatedAt),
// the sync log tail, a git status of the brain folder, and the playbook for the
// code. Returns the absolute path. Everything in it stays local.
function buildFixMe({ userData, logFile, brainPath, payload, appName, playbooksDir }) {
  const p = payload || {};
  const code = p.code && CODES[p.code] ? p.code : 'UNKNOWN';
  const def = CODES[code];
  let playbook = '';
  for (const name of [code, 'UNKNOWN']) {
    try { playbook = fs.readFileSync(path.join(playbooksDir, `${name}.md`), 'utf8'); break; } catch (_) { /* try the next */ }
  }
  let gitStatus = '(brain folder not set)';
  if (brainPath) {
    try {
      gitStatus = execFileSync('git', ['-C', brainPath, 'status', '--short', '-b'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || '(clean)';
    } catch (e) { gitStatus = `(git status failed: ${String(e && e.message || e).split('\n')[0]})`; }
  }
  const held = Array.isArray(p.held) && p.held.length
    ? p.held.map((h) => `- ${h.file}: ${h.why}`).join('\n')
    : '- (none)';
  const md = [
    `# Help me fix this: ${appName || 'the brain app'} has stopped syncing`,
    '',
    `Written ${new Date().toISOString()} by the app on this computer. Everything in this file stays here; nothing in it has been sent anywhere.`,
    '',
    `- Cause code: **${code}**`,
    `- In plain words: ${def.label}`,
    `- What the app's status line says: ${p.reason || '(none)'}`,
    `- Brain folder: ${brainPath || '(not set)'}`,
    `- Stopped since: ${p.updatedAt || '(unknown)'}${p.attempts ? ` after ${p.attempts} attempts` : ''}`,
    '',
    '## The exact error (from this computer only)',
    '',
    fence(p.detail || '(the app recorded no error text for this stop)'),
    '',
    '## Files the app has set aside',
    '',
    held,
    '',
    '## Brain folder status (`git status --short -b`)',
    '',
    fence(gitStatus),
    '',
    `## Last ${LOG_TAIL_LINES} lines of the sync log`,
    '',
    fence(tail(logFile, LOG_TAIL_LINES) || '(no log yet)'),
    '',
    `## Playbook: ${code}`,
    '',
    playbook || `(No playbook is bundled for ${code}. Diagnose from the evidence above, read-only first, and never bypass a check, force-push or delete files.)`,
    '',
  ].join('\n');
  fs.mkdirSync(userData, { recursive: true });
  const out = path.join(userData, 'fix-me.md');
  fs.writeFileSync(out, md, 'utf8');
  return out;
}

// The one prompt handed to the person's Claude, whichever door it goes through.
// `clientBrain` keeps the fallback neutral: a client brain is white-label and
// its person must never be pointed at the agency's supplier.
function fixPrompt(fixPath, { clientBrain } = {}) {
  const fallback = clientBrain
    ? 'tell me to reply to the email I received about this, or to contact whoever set this brain up for me, and stop'
    : 'tell me to reply to the email I received about this (or to write to hello@mikerhodes.com.au) and stop';
  return [
    `Read the file at ${fixPath} first, all of it.`,
    "It explains why this brain's syncing app has stopped, with the exact error from this computer and a playbook for this cause.",
    'Follow the playbook\'s rules section exactly, then walk me through the fix one step at a time: explain each command in one sentence before you run it and wait for my yes.',
    'Never run git with --no-verify, never force-push, never delete files from the brain folder, and never send the error text anywhere off this computer.',
    `If you can't fix it in a few steps, ${fallback}.`,
  ].join(' ');
}

function which(bin) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
      return out || null;
    }
    const out = spawnSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();
    return out || null;
  } catch (_) { return null; }
}

// Open a Claude Code session in the brain folder on the prompt. Returns true when
// a window was opened, false when Claude Code isn't installed or the launch
// failed (the caller then falls back to Cowork or the file).
function openClaudeCodeSession({ repoPath, prompt, title }) {
  if (!repoPath || !fs.existsSync(repoPath)) return false;
  const bin = which('claude');
  if (!bin) return false;
  const stamp = Date.now();
  const promptFile = path.join(os.tmpdir(), `fix-prompt-${stamp}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');
  try {
    if (process.platform === 'darwin') {
      // The prompt never rides through a shell-parsed string: a tiny launcher
      // reads it from the file, and only fixed tokens travel through AppleScript.
      const launcher = path.join(os.tmpdir(), `fix-launch-${stamp}.sh`);
      fs.writeFileSync(launcher, [
        '#!/bin/bash',
        `cd '${repoPath.replace(/'/g, "'\\''")}' || exit 1`,
        `exec '${bin}' --permission-mode auto "$(cat '${promptFile}')"`,
        '',
      ].join('\n'), { mode: 0o755 });
      const safeTitle = String(title || 'Help me fix this').replace(/["\\]/g, '').replace(/\n/g, ' ');
      const script = [
        'tell application "Terminal"',
        '  activate',
        `  set newTab to do script "'${launcher}'"`,
        '  delay 0.3',
        '  try',
        `    set custom title of newTab to "${safeTitle}"`,
        '  end try',
        'end tell',
      ].join('\n');
      const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
      return r.status === 0;
    }
    if (process.platform === 'win32') {
      const ps = `Set-Location -LiteralPath '${repoPath.replace(/'/g, "''")}'; & '${bin.replace(/'/g, "''")}' --permission-mode auto (Get-Content -Raw -LiteralPath '${promptFile.replace(/'/g, "''")}')`;
      const child = spawn('cmd.exe', ['/c', 'start', '', 'powershell', '-NoExit', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return true;
    }
  } catch (_) { /* fall back */ }
  return false;
}

module.exports = { buildFixMe, fixPrompt, openClaudeCodeSession, LOG_TAIL_LINES };
