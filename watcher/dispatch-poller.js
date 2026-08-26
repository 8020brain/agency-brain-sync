// Phone-dispatch poller (graduated from the standalone prototype that lived in
// the brain at projects/member-inbox/dispatch-poller/).
//
// You dictate a note on your phone (Brain Inbox, 8020brain.com/i) and tap
// "Save & Start Session". The note lands in your brain repo as
// `!inbox/!dispatch-*.md`. The sync watcher already fetches origin every 60s;
// after each sync this module reads the fetched `origin/<branch>` ref (never
// the working tree, so a dirty or diverged checkout can't hide a note) and
// opens a visible session on each new note in a Terminal window.
//
// The session runs Claude Code where it's installed, and ChatGPT's `codex`
// CLI where it isn't, so a brain on a machine that only has one of the two
// still dispatches. Set `dispatchProvider` to "claude" or "codex" in the app's
// config.json to force one instead of taking whichever is there.
//
// Rules carried over from the prototype:
//   - READ ONLY. This module never fetches, never pushes. The watcher owns git;
//     the spawned session owns the note (it deletes it when actioned).
//   - Handled notes are recorded in `.git/dispatch-state.json` (local to this
//     machine, never synced) so nothing double-fires.
//   - Normal inbox processing ignores `!`-prefixed files, so a dispatch note is
//     invisible to inboxy until a session is spawned on it.
//
// macOS only for now (Terminal.app + tmux + AppleScript — the same proven
// launch as the Command Centre's dispatch). Windows logs a friendly note.
// Opt-in per machine via the tray menu, default OFF: in a team every machine
// syncs the same repo, and without the opt-in one phone note would open a
// session on every teammate's computer at once.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const INBOX_PATH = '!inbox'; // the phone app's default capture folder
const DISPATCH_PREFIX = `${INBOX_PATH}/!dispatch-`;

function create({ repoPath, log }) {
  const say = typeof log === 'function' ? log : () => {};
  const statePath = path.join(repoPath, '.git', 'dispatch-state.json');
  let warnedPlatform = false;
  let warnedBins = false;

  // Same no-shell argument-array pattern as the watcher's git calls: filenames
  // are handed to git as literal data, never parsed by a shell.
  function git(args) {
    const r = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
    if (r.status !== 0) throw new Error((r.stderr || 'git failed').trim().split('\n')[0]);
    return r.stdout;
  }

  function onPath(bin) {
    return spawnSync('bash', ['-lc', `command -v ${bin} >/dev/null 2>&1`]).status === 0;
  }

  function which(bin) {
    return spawnSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();
  }

  // Claude Code first, ChatGPT's codex CLI as the fallback. dispatchProvider in
  // the app's config.json (passed down as BRAIN_DISPATCH_PROVIDER) pins one, in
  // which case a missing binary means no session rather than a silent swap to
  // the other assistant. Returns null when nothing usable is installed.
  function resolveProvider() {
    const forced = (process.env.BRAIN_DISPATCH_PROVIDER || '').trim().toLowerCase();
    const order = forced === 'codex' ? ['codex'] : forced === 'claude' ? ['claude'] : ['claude', 'codex'];
    for (const name of order) {
      const bin = which(name);
      if (bin) return { name, bin };
    }
    return null;
  }

  function loadState() {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { done: [] }; }
  }
  function saveState(s) {
    try { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); } catch (e) {
      say(`dispatch: could not save state: ${e.message}`);
    }
  }

  // The watcher syncs whatever branch is checked out, so the poller follows it
  // the same way rather than assuming main.
  function currentBranch() {
    try { return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { return 'main'; }
  }

  function listDispatchNotes(branch) {
    let out = '';
    try { out = git(['ls-tree', '-r', '--name-only', `origin/${branch}`]); }
    catch (e) { say(`dispatch: ls-tree failed: ${e.message}`); return []; }
    return out.split('\n').map((s) => s.trim())
      .filter((p) => p.startsWith(DISPATCH_PREFIX) && p.endsWith('.md'));
  }

  function readNote(branch, repoRelPath) {
    try { return git(['show', `origin/${branch}:${repoRelPath}`]); }
    catch { return null; }
  }

  function spawnSession(repoRelPath, noteText, provider) {
    const label = (noteText.split('\n').find((l) => l.trim()) || repoRelPath).trim().slice(0, 44);
    const prompt = [
      'A note was captured from your phone (Brain Inbox) and flagged to start a session now.',
      'Your working directory is your brain. The note:',
      '',
      noteText.trim(),
      '',
      "Action it the way the inboxy skill would: work out what it's asking for and do it.",
      `If the file \`${repoRelPath}\` exists in your working directory, delete it once you've actioned it.`,
      'When the task is complete, end with a one-line summary. If you are blocked or need a decision, say so and stop.',
    ].join('\n');

    const stamp = Date.now();
    const promptFile = path.join(os.tmpdir(), `dispatch-prompt-${stamp}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');

    const session = `phone-${String(stamp).slice(-6)}`;

    // codex exec is one-shot rather than a conversation: approval is pinned to
    // `never`, so the sandbox is what lets it action the note, stdin is closed
    // or it waits forever on "Reading additional input from stdin", and a zero
    // exit says nothing about whether it did the work, hence judging it on the
    // last message and holding the window open so the person can read it.
    const lastMsg = path.join(os.tmpdir(), `dispatch-out-${stamp}.txt`);
    const runLines = provider.name === 'codex' ? [
      `'${provider.bin}' exec --sandbox workspace-write --output-last-message '${lastMsg}' "$(cat '${promptFile}')" < /dev/null`,
      `if [ ! -s '${lastMsg}' ]; then echo; echo \"Codex ended without saying anything, so the note probably wasn't actioned. It's still in your inbox folder.\"; fi`,
      "echo; read -r -p 'Press Enter to close this window. ' _",
    ] : [
      `exec '${provider.bin}' --permission-mode auto "$(cat '${promptFile}')"`,
    ];

    // The prompt can contain quotes/newlines, so it never rides through a
    // shell-parsed command string: a tiny launcher reads it from the file via
    // double-quoted command substitution; only fixed tokens (session name +
    // launcher path) travel through AppleScript.
    const launcher = path.join(os.tmpdir(), `dispatch-launch-${stamp}.sh`);
    fs.writeFileSync(launcher, [
      '#!/bin/bash',
      `cd '${repoPath}' || exit 1`,
      'tmux set-option destroy-unattached on 2>/dev/null || true',
      'tmux set-option status off 2>/dev/null || true',
      'tmux set-option mouse on 2>/dev/null || true',
      'tmux set-option history-limit 50000 2>/dev/null || true',
      ...runLines,
      '',
    ].join('\n'), { mode: 0o755 });

    const terminalCmd = `tmux new-session -A -s '${session}' '${launcher}'`;
    const appleCmd = terminalCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const title = `phone: ${label}`.replace(/["\\]/g, '').replace(/\n/g, ' ');
    const script = [
      'tell application "Terminal"',
      '  activate',
      `  set newTab to do script "${appleCmd}"`,
      '  delay 0.3',
      '  try',
      `    set custom title of newTab to "${title}"`,
      '  end try',
      'end tell',
    ].join('\n');

    const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
    if (r.status !== 0) {
      say(`dispatch: spawn failed for ${repoRelPath}: ${(r.stderr || 'unknown error').trim().split('\n').pop()}`);
      return false;
    }
    say(`dispatch: opened ${provider.name} session ${session} for ${repoRelPath}`);
    return true;
  }

  // Called by the watcher after each sync. Cheap when there is nothing to do
  // (one git ls-tree against the already-fetched ref).
  function check() {
    if (process.platform !== 'darwin') {
      if (!warnedPlatform) {
        warnedPlatform = true;
        say('dispatch: phone-dispatch sessions are macOS-only for now — skipping');
      }
      return;
    }
    const branch = currentBranch();
    const notes = listDispatchNotes(branch);
    if (!notes.length) return;
    const state = loadState();
    state.done = (state.done || []).filter((p) => notes.includes(p)); // forget notes that are gone
    const fresh = notes.filter((p) => !state.done.includes(p));
    if (!fresh.length) return;

    const provider = resolveProvider();
    if (!onPath('tmux') || !provider || !onPath('osascript')) {
      if (!warnedBins) {
        warnedBins = true;
        say('dispatch: a phone note is waiting but tmux and/or an assistant CLI (claude or codex) are not installed: install them, or turn phone sessions off in the menu');
      }
      return; // leave the note unhandled so it fires once the tools exist
    }

    for (const p of fresh) {
      const text = readNote(branch, p);
      if (text == null) { say(`dispatch: could not read ${p}`); continue; }
      say(`dispatch: phone note found: ${p}`);
      spawnSession(p, text, provider);
      state.done.push(p); // record regardless so a broken note can't loop
      saveState(state);
    }
  }

  return { check };
}

module.exports = { create };
