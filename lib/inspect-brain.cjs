// Read-only inspection of an existing brain folder for the "adopt your existing
// brain" flow (Phase 1 of adopt-existing-brain-spec.md).
//
// Pure node — no electron — so it can be unit-tested directly with `node` and
// reused by both main.js's `inspect-brain-folder` IPC and the Phase-2 adopt
// step's re-confirm check.
//
// IT NEVER WRITES ANYTHING. The only network/ref-touching command is
// `git fetch --quiet origin`, which updates remote-tracking refs only (read-only
// with respect to the working tree) — the same probe the watcher's
// classifyState() runs every tick. No add, commit, checkout, reset, or config.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// origin URL is a GitHub repo? Accepts both https and ssh remote forms.
function isGitHubRemote(url) {
  return /^git@github\.com:/i.test(url) || /^https?:\/\/[^/]*github\.com\//i.test(url);
}

// origin points at one of the shared 8020brain templates (read-only to members).
// A solo member who runs the brain via /brain-update often has origin set to the
// template they cloned — adopting that would try to push to Mike's template (it
// would fail on permissions, but we block it cleanly and explain instead).
function isTemplateRemote(url) {
  return /github\.com[:/]8020brain\/(brain-template|agency-brain-template|team-brain-template)(\.git)?\/?$/i.test(url);
}

function midOperation(repo) {
  const g = path.join(repo, '.git');
  if (fs.existsSync(path.join(g, 'rebase-merge'))) return 'rebase';
  if (fs.existsSync(path.join(g, 'rebase-apply'))) return 'rebase';
  if (fs.existsSync(path.join(g, 'MERGE_HEAD'))) return 'merge';
  if (fs.existsSync(path.join(g, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  return null;
}

// Non-comment, non-blank lines of .gitignore (trimmed). Empty array if none.
function gitignoreLines(repo) {
  try {
    return fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')
      .split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}
// The personal/<self>/ convention (agency template uses `personal/*/`). A solo
// member's brain-template typically lacks this — Phase 2 appends it.
function hasPersonalConvention(lines) {
  return lines.some((l) => /^personal\//.test(l));
}
// Secrets ignored? brain-template uses `**/.env`; agency template uses `.env`.
function secretsAreIgnored(lines) {
  return lines.some((l) => /(^|\/)\.env(\b|$)/.test(l));
}

// inspectBrainFolder(folder, { env }) -> a plain, JSON-serialisable report.
// `env` lets the caller pass an enriched PATH (a GUI app launched from Finder
// has a minimal PATH that omits git); defaults to process.env for node tests.
function inspectBrainFolder(folder, opts = {}) {
  const env = opts.env || process.env;
  const git = (args) => {
    try {
      return execFileSync('git', ['-C', folder, ...args], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024 * 50, env,
      }).trim();
    } catch { return null; }
  };

  if (!folder || typeof folder !== 'string') {
    return { ok: false, state: 'invalid', block: true, blockReason: 'No folder was selected.' };
  }
  if (!fs.existsSync(path.join(folder, '.git'))) {
    return { ok: false, folder, state: 'not_git', block: true,
      blockReason: 'That folder is not a git repository, so it can’t be your brain. Pick the folder that has your brain in it.' };
  }

  const ig = gitignoreLines(folder);
  const result = {
    ok: true,
    folder,
    block: false,
    blockReason: null,
    state: 'unknown',
    origin: { present: false, url: null, isGitHub: false },
    branch: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    fileCount: 0,
    gitignoreHasPersonal: hasPersonalConvention(ig),
    secretsIgnored: secretsAreIgnored(ig),
  };

  // Rough size signal — tracked file count.
  const tracked = git(['ls-files']);
  result.fileCount = tracked ? tracked.split('\n').filter(Boolean).length : 0;

  // Don't touch someone's half-finished git operation.
  const mid = midOperation(folder);
  if (mid) {
    result.state = 'mid_operation';
    result.block = true;
    result.blockReason = `There’s a git ${mid} in progress in this folder. Finish or abort it in your brain first, then come back.`;
    return result;
  }

  // Must be connected to a GitHub origin — that's what the app syncs.
  const originUrl = git(['remote', 'get-url', 'origin']);
  if (!originUrl) {
    result.state = 'no_origin';
    result.block = true;
    result.blockReason = 'This brain isn’t connected to GitHub yet (no “origin” remote). Connect it to your own GitHub repo first, then come back.';
    return result;
  }
  result.origin.present = true;
  result.origin.url = originUrl;
  result.origin.isGitHub = isGitHubRemote(originUrl);
  if (!result.origin.isGitHub) {
    result.state = 'not_github';
    result.block = true;
    result.blockReason = 'This brain’s “origin” isn’t a GitHub repo. The app syncs to GitHub, so point origin at your own GitHub repo first.';
    return result;
  }
  if (isTemplateRemote(originUrl)) {
    result.state = 'template_origin';
    result.block = true;
    result.blockReason = 'This brain points at the shared 8020brain template, not your own GitHub repo. The app syncs to a repo you own — point “origin” at your own repo first, then come back.';
    return result;
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  result.branch = branch || null;

  const status = git(['status', '--porcelain']);
  result.dirty = !!(status && status.length);

  // fetch (remote-tracking refs only — never the working tree) to compare.
  const fetched = git(['fetch', '--quiet', 'origin']);
  if (fetched === null) {
    result.state = 'fetch_failed';
    result.block = true;
    result.blockReason = 'I couldn’t reach GitHub to compare this brain with your repo. Check your internet (and that you can access the repo), then try again.';
    return result;
  }

  // ahead/behind vs origin/<branch>.
  let ahead = 0, behind = 0, haveUpstream = false;
  if (branch) {
    const remoteSha = git(['rev-parse', `origin/${branch}`]);
    if (remoteSha) {
      haveUpstream = true;
      const ab = git(['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`]);
      if (ab) {
        const [a, b] = ab.split(/\s+/).map((n) => parseInt(n, 10) || 0);
        ahead = a; behind = b;
      }
    }
  }
  result.ahead = ahead;
  result.behind = behind;

  // Classify. Blocks are states a human must resolve in their brain first;
  // everything else is something the Phase-2 controlled sync can safely do.
  if (!haveUpstream) {
    // Local branch with no matching origin/<branch> — unpushed branch. Phase 2
    // pushes it (sets upstream); not a block.
    result.state = 'ahead';
    return result;
  }
  if (ahead > 0 && behind > 0) {
    result.state = 'diverged';
    result.block = true;
    result.blockReason = `This brain and your GitHub repo have both moved on (${ahead} local, ${behind} remote). Reconcile them in your brain first, then come back.`;
    return result;
  }
  if (result.dirty && behind > 0) {
    result.state = 'diverged';
    result.block = true;
    result.blockReason = `You have unsaved local changes AND GitHub has ${behind} newer commit(s). Reconcile them in your brain first, then come back.`;
    return result;
  }
  if (behind > 0) { result.state = 'behind'; return result; }   // clean → ff in Phase 2
  if (result.dirty) { result.state = 'dirty'; return result; }  // → commit+push in Phase 2
  if (ahead > 0) { result.state = 'ahead'; return result; }     // → push in Phase 2
  result.state = 'clean_in_sync';                               // → nothing to do
  return result;
}

module.exports = { inspectBrainFolder, isGitHubRemote, isTemplateRemote };
