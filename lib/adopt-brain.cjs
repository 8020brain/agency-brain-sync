// The controlled "adopt your existing brain" write path (Phase 2 of
// adopt-existing-brain-spec.md). This is the ONE deliberate write operation that
// brings a member's existing brain under the app — done as an explicit,
// progress-shown step so the watcher only ever inherits a clean, in-sync,
// protected repo.
//
// Pure node (no electron) so it can be unit-tested with `node` and so all the
// git logic lives in one place. It takes a `log` callback for progress lines
// (main.js passes sendWizardLog; tests pass console.log).
//
// IT DOES NOT save config or start the watcher. The caller (the wizard renderer)
// persists config only AFTER this resolves — that's the single trigger that
// starts the watcher, so the watcher never races the first sync.
//
// Order (matches the spec):
//   1. Re-confirm state via inspectBrainFolder; abort on any block.
//   2. If `behind` (clean), fast-forward to origin first.
//   3. Protect: ensure .gitignore has the personal/ block + ignores secrets.
//   4. Set git identity if unset.
//   5. Commit anything pending (their changes + our .gitignore edits) as one
//      "Adopt into Agency Brain: <date>" commit.
//   6. Push if there's anything unpushed.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { inspectBrainFolder } = require('./inspect-brain.cjs');

// The personal-folder convention, mirroring agency-brain-template/.gitignore.
// Each member's personal/<self>/ stays local and never syncs.
const PERSONAL_BLOCK = [
  '',
  '# Personal folders — each member’s personal/<self>/ stays local, never synced.',
  '# Added by Agency Brain when this brain was adopted.',
  'personal/*/',
  '',
].join('\n');

// Belt-and-suspenders: brain-template already ignores .env, but if a brain
// somehow doesn't, make sure secrets never sync.
const SECRETS_BLOCK = [
  '',
  '# Secrets — never synced.',
  '.env',
  '.env.*',
  'credentials.json',
  '',
].join('\n');

function adoptBrain(folder, opts = {}) {
  const env = opts.env || process.env;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const memberEmail = opts.memberEmail || '';
  const memberName = opts.memberName || '';

  const git = (args) => {
    try {
      return { ok: true, out: execFileSync('git', ['-C', folder, ...args], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 50, env,
      }).trim() };
    } catch (e) {
      return { ok: false, err: ((e.stderr || e.message || '') + '').trim() };
    }
  };
  const gitOrThrow = (args, label) => {
    const r = git(args);
    if (!r.ok) throw new Error(`${label || ('git ' + args[0])} failed: ${r.err.slice(0, 300)}`);
    return r.out;
  };

  // 1. Re-confirm — defends against the state changing between inspect and adopt.
  log('Checking your brain is ready…');
  const state = inspectBrainFolder(folder, { env });
  if (!state.ok || state.block) {
    throw new Error(state.blockReason || 'This brain isn’t in a state I can safely adopt.');
  }
  const branch = state.branch || gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD']);

  // 2. behind (clean tree, guaranteed by the classifier) → fast-forward first,
  //    so the one adopt commit lands on top of GitHub's latest.
  if (state.state === 'behind') {
    log(`Getting GitHub’s latest (${state.behind} commit${state.behind === 1 ? '' : 's'})…`);
    gitOrThrow(['merge', '--ff-only', `origin/${branch}`], 'fast-forward');
  }

  // 3. Protect FIRST (before the commit, so the structure is in the adopt commit).
  const gitignore = path.join(folder, '.gitignore');
  if (!state.gitignoreHasPersonal) {
    log('Adding the personal-folder rule to .gitignore…');
    fs.appendFileSync(gitignore, PERSONAL_BLOCK);
  }
  if (!state.secretsIgnored) {
    log('Making sure secrets stay local…');
    fs.appendFileSync(gitignore, SECRETS_BLOCK);
  }

  // 4. Identity if unset (so the adopt commit has a proper author).
  const haveEmail = git(['config', 'user.email']);
  if (!(haveEmail.ok && haveEmail.out)) {
    if (memberEmail) gitOrThrow(['config', 'user.email', memberEmail], 'set git email');
    if (memberName) gitOrThrow(['config', 'user.name', memberName], 'set git name');
  }

  // 5. One deliberate commit of everything pending.
  const status = git(['status', '--porcelain']);
  let committed = false;
  if (status.ok && status.out.length) {
    log('Saving your current state as one commit…');
    gitOrThrow(['add', '-A'], 'stage');
    const date = new Date().toISOString().slice(0, 10);
    gitOrThrow(['commit', '-m', `Adopt into Agency Brain: ${date}`], 'commit');
    committed = true;
  }

  // 6. Push if there's anything GitHub doesn't have yet (the new commit, any
  //    pre-existing local commits, or a branch that was never pushed).
  let pushed = false;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) {
    log('Publishing this branch to your GitHub…');
    gitOrThrow(['push', '-u', 'origin', branch], 'push');
    pushed = true;
  } else {
    const ahead = git(['rev-list', '--count', `origin/${branch}..${branch}`]);
    if (ahead.ok && parseInt(ahead.out || '0', 10) > 0) {
      log('Pushing to your GitHub…');
      gitOrThrow(['push'], 'push');
      pushed = true;
    }
  }

  log('Done — your brain is adopted and in sync.');
  return { ok: true, branch, committed, pushed, fromState: state.state };
}

module.exports = { adoptBrain };
