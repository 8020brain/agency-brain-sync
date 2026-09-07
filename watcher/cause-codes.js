// Cause codes: the fixed, code-authored list of reasons a brain can stop
// syncing. This is the ONLY vocabulary that leaves a person's machine about a
// stop (alongside a code-authored sentence). A code cannot carry a client's
// private text, which is the whole point: on 2026-08-18 a customer's own
// security check printed a case-file path and a home address, and the old
// free-text report carried it into Neon and the Workbench. Codes make a stop
// diagnosable from the roster without ever shipping git's raw words.
//
// Three consumers read this list and must agree on it:
//   - watcher/team-brain-sync.js classifies each failure into a code here.
//   - main.js "Help me fix this" opens watcher/playbooks/<CODE>.md, one per
//     code (tests/stop-reason-privacy.test.cjs fails if one is missing).
//   - 8020api server/sync-causes.ts is the server's copy (allowlist, email
//     copy, self-clears flag). No import between the two repos, so a change
//     here is a change there too, same as isRealBlock / agIsRealBlock.
//
// selfClears: whether a fresh cycle can plausibly clear it without a person
//   (offline, a lock another program holds). The roster treats a self-clearing
//   stop as transient for its first hour; anything else is a real block at once.
// alertAfterMin: how long a LIVE block runs before the app asks the server to
//   email the person (Track B, spec 2026-09-08). 30 for the ones that never
//   clear themselves, 120 for the maybe-transient ones. A quit app or a
//   sleeping laptop never fires, because only a running app counts the clock.
// steps: the self-fix, in plain words, for the person. The server's alert email
//   and the playbooks both start from these.

const CODES = {
  FOREIGN_HOOK: {
    label: "a check installed on this computer blocked the save",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "A security or data-protection check on this computer (a git pre-commit hook the app did not install) refused the save because it flagged a file.",
      "The app never forces past a check like that, because it belongs to whoever set up this computer.",
      "Whoever installed it (you or your IT) needs to allow the brain folder, or clear the file it flagged. Your own brain can read the exact message and walk you through it: open the app and choose Help me fix this.",
    ],
  },
  SESSION_EXPIRED: {
    label: "your sign-in has expired, so syncing is paused",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "Open the app in your menu bar (Windows: the system tray, bottom right) and choose Reconnect / sign in again.",
      "Sign in with your email and the one-time code. Syncing resumes on its own straight after.",
    ],
  },
  SERVER_REFUSED: {
    label: "the server refused to give this machine a key for the brain",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "The app's own status line carries the exact reason the server gave (a seat that has been handed over, or a brain with no repository bound yet).",
      "Open the app and read it; if it names a step, that step is the fix. If it makes no sense for your situation, reply to this email.",
    ],
  },
  PUSH_PROTECTION: {
    label: "GitHub refused the upload because a file looks like it contains a secret",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "GitHub scans every upload for things that look like passwords or API keys, and it refused this one. Nothing is lost; the change is still on this computer.",
      "Open the app and choose Help me fix this. Your brain will find the file and the line GitHub flagged, help you move the secret out of the brain, and re-save the file so the upload goes through.",
    ],
  },
  PUSH_FORBIDDEN: {
    label: "GitHub refused this account permission to upload",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "GitHub is refusing this computer's key write access to the shared brain, or a repository rule is blocking the upload.",
      "Whoever administers your GitHub organisation needs to check that the Agency Brain app still has access to the brain's repository. If nothing changed on your side, reply to this email.",
    ],
  },
  REPO_GONE: {
    label: "the shared brain can't be found on GitHub",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "The repository the app expects is not where it was (renamed, moved or deleted on GitHub).",
      "Whoever administers your GitHub organisation can confirm what happened. If it was renamed, the app needs the new address: reply to this email and I'll sort it with you.",
    ],
  },
  PUSH_TOO_BIG: {
    label: "a file is too big for GitHub to accept",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "A file over GitHub's size limit got into a save made outside the app, and every upload since has been refused.",
      "Open the app and choose Help me fix this. Your brain will find the file, set it aside on this computer, and let the rest of your work upload.",
    ],
  },
  PUSH_REJECTED: {
    label: "can't push your changes up: this copy has drifted from the shared brain",
    selfClears: false, alertAfterMin: 120,
    steps: [
      "This copy and the shared brain have moved apart in a way the app's automatic merge could not settle.",
      "Fully quit the app and open it again first. If it is still stuck after a few minutes, open the app and choose Help me fix this; your brain will bring this copy back in line without losing your work.",
    ],
  },
  MERGE_STUCK: {
    label: "can't pull in the latest changes from the shared brain",
    selfClears: false, alertAfterMin: 120,
    steps: [
      "The app keeps failing to fold your teammates' latest changes into this copy.",
      "Fully quit the app and open it again first. If it is still stuck after a few minutes, open the app and choose Help me fix this.",
    ],
  },
  PUSH_NETWORK: {
    label: "can't push your changes up: the connection to GitHub keeps failing",
    selfClears: true, alertAfterMin: 120,
    steps: [
      "The upload keeps failing part-way. That is usually a VPN, a company proxy or a flaky connection, and it often clears on its own.",
      "If you are on a VPN or office network, try once off it. If it keeps failing for hours, open the app and choose Help me fix this.",
    ],
  },
  FETCH_FAILED: {
    label: "offline, or GitHub can't be reached",
    selfClears: true, alertAfterMin: 120,
    steps: [
      "The app cannot reach GitHub at all right now. Your work is saved on this computer and uploads the moment the connection is back.",
      "If you are online and this has lasted hours, a VPN or firewall may be blocking github.com; try once off it.",
    ],
  },
  INDEX_LOCK: {
    label: "another program is holding your brain folder's git lock",
    selfClears: true, alertAfterMin: 120,
    steps: [
      "Something else (a Cowork session or a terminal) is holding the brain folder's git lock, so the app cannot save.",
      "Close Cowork and any open terminal in the brain folder. The app clears a stale lock by itself within a minute.",
    ],
  },
  REBASE_IN_PROGRESS: {
    label: "a git operation started by hand was left half-finished in the brain folder",
    selfClears: false, alertAfterMin: 120,
    steps: [
      "A rebase or cherry-pick was started in the brain folder (by a Claude session or a terminal) and never finished, so the app is waiting.",
      "Open the app and choose Help me fix this. Your brain will finish or abandon it safely; nothing you saved is lost either way.",
    ],
  },
  FIRST_PUBLISH_PENDING: {
    label: "first publish pending (push failed, retrying)",
    selfClears: true, alertAfterMin: 120,
    steps: [
      "This brain's very first upload to GitHub has not landed yet. The app retries every minute.",
      "If it has been hours, open the app and choose Help me fix this.",
    ],
  },
  DISK_FULL: {
    label: "this computer has run out of disk space",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "The app cannot save because the disk is full.",
      "Free up some space (empty the bin, clear Downloads). Syncing resumes on its own.",
    ],
  },
  PERMISSIONS: {
    label: "this computer can't write to your brain folder (permissions)",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "The brain folder, or its hidden .git folder, is read-only for the account running the app.",
      "Open the app and choose Help me fix this; your brain will find which folder is locked and how to unlock it on this computer.",
    ],
  },
  GPG_SIGN: {
    label: "git commit signing is switched on and failed",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "Git on this computer is set to sign every save with a key, and the signing is failing.",
      "Open the app and choose Help me fix this; the one-line fix is to switch signing off for the brain folder.",
    ],
  },
  NO_GIT_IDENT: {
    label: "git has no name or email set on this computer",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "The app normally sets this itself. If you are seeing it, that did not work on this computer.",
      "Open the app and choose Help me fix this.",
    ],
  },
  REPO_CORRUPT: {
    label: "your brain folder's git data looks damaged, so it needs re-cloning",
    selfClears: false, alertAfterMin: 30,
    steps: [
      "The hidden git data under the brain folder is damaged (usually a disk problem or a copy interrupted half-way).",
      "Open the app and choose Help me fix this. Your brain will keep a copy of everything in the folder, then fetch a fresh copy of the shared brain and put your unsent work back.",
    ],
  },
  UNKNOWN: {
    label: "syncing stopped for a reason the app couldn't classify",
    selfClears: true, alertAfterMin: 120,
    steps: [
      "The app hit a problem it does not have a name for yet. The exact message is on this computer, in the app's log.",
      "Open the app and choose Help me fix this; your brain will read the message and work out what to do. If it can't, reply to this email.",
    ],
  },
};

const CODE_LIST = Object.keys(CODES);

function isCode(c) { return typeof c === 'string' && Object.prototype.hasOwnProperty.call(CODES, c); }

// Classify git's own words from a FAILED PUSH. The raw text stays on this
// machine; only `code` and `server` (a fixed sentence) ever go up. Order
// matters: GitHub's secret-scanning refusal also says "rejected", and a too-big
// file also produces an HTTP error, so the specific causes come first.
function classifyPushFailure(stderr) {
  const e = String(stderr || '');
  if (/GH013|cannot contain secrets|secret scanning|push protection|repository rule violations/i.test(e)) return 'PUSH_PROTECTION';
  if (/GH001|exceeds GitHub'?s file size limit|file size limit of|pack exceeds maximum allowed size/i.test(e)) return 'PUSH_TOO_BIG';
  if (/repository not found|Repository .* not found|HTTP 404|remote: Not Found/i.test(e)) return 'REPO_GONE';
  if (/403|permission to .* denied|write access to repository not granted|pre-receive hook declined|protected branch|Permission denied/i.test(e)) return 'PUSH_FORBIDDEN';
  if (/non-fast-forward|fetch first|Updates were rejected|failed to push some refs/i.test(e)) return 'PUSH_REJECTED';
  if (/RPC failed|HTTP [45]\d\d|curl \d+|unexpected disconnect|Could not resolve host|Connection (timed out|refused|reset)|early EOF|remote end hung up|SSL|TLS|proxy|network is unreachable/i.test(e)) return 'PUSH_NETWORK';
  return 'UNKNOWN';
}

module.exports = { CODES, CODE_LIST, isCode, classifyPushFailure };
