// Agency Brain — main process.
// Tray app that supervises the sync watcher child process.
//
// Agency-mode support sits on top of the original v0.2 personal sync:
//   - First-run wizard branches into personal or agency setup
//   - Agency mode talks to api.ads2ai.com for invite resolution and
//     GitHub App installation tokens (so team members never need a GitHub
//     account)
//   - agencybrain://join?token=... URL scheme deep-links an invite token
//     as a backup to the 6-character code paste flow in the wizard
//   - Watcher runs with mode-aware env so it can mint fresh tokens on the fly
//   - Watcher writes its state to a known file; this process polls and drives
//     the tray icon (running / paused / needs-attention)

const { app, Tray, Menu, BrowserWindow, dialog, shell, nativeImage, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const { inspectBrainFolder } = require('./lib/inspect-brain.cjs');
const { adoptBrain } = require('./lib/adopt-brain.cjs');
const { ensureCredentialHelper } = require('./lib/git-credential.cjs');
const { normaliseAccountName, isValidAccountName, classifyAccount } = require('./lib/github-account.cjs');

const USER_DATA = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
// Last known-good copy of config.json, rewritten on every successful save. Only
// ever read when the real file exists but won't parse — see readConfig().
const CONFIG_BACKUP_FILE = path.join(USER_DATA, 'config.backup.json');
// ClientBrain: a client brain shows the client's brand everywhere the app
// speaks (tray tooltip, dialogs, window titles), never ours. brandName lands
// in config.json at wizard setup when kind === 'client'; everyone else keeps
// the default. Read once at boot — a brand change lands on next app start.
// Live, not boot-frozen (2026-07-23): the Acme test wrote the brand config
// during the wizard, AFTER boot, so the tray menus kept saying the old name
// until a restart. saveConfig() recomputes this so the next tray refresh and
// any new window pick the brand up immediately. Neutral default is "Business
// Brain" (decisions.md 2026-07-23) — the packaged app/installer name is a
// SEPARATE, later change (kept as-is so existing installs are untouched).
let APP_NAME = computeAppName();
function computeAppName() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg && cfg.kind === 'client' && cfg.brandName) return String(cfg.brandName);
  } catch (e) { /* no config yet — fresh install */ }
  return 'Business Brain';
}
const LOG_FILE = path.join(USER_DATA, 'sync.log');
const ERR_FILE = path.join(USER_DATA, 'sync.err');
const STATE_FILE = path.join(USER_DATA, 'state.json');
const WINDOW_STATE_FILE = path.join(USER_DATA, 'window-state.json');

const ICON_ON  = path.join(__dirname, 'assets', 'brain-44.png');
const ICON_OFF = path.join(__dirname, 'assets', 'brain-44-off.png');
// Attention state: red variant. Asset not yet created; falls back to ICON_ON
// for now so the build still works. To create: tint brain-44.png red.
const ICON_ATTENTION = fs.existsSync(path.join(__dirname, 'assets', 'brain-44-attention.png'))
  ? path.join(__dirname, 'assets', 'brain-44-attention.png')
  : ICON_ON;
const WATCHER_PATH = path.join(__dirname, 'watcher', 'team-brain-sync.js');

// 8020api endpoints
const API_BASE = process.env.BRAIN_SYNC_API_BASE || 'https://api.ads2ai.com';

// Embedded Command Centre (member-safe HOME server, bundled in command-centre/).
// Runs as a child node process pointed at the member's brain; loaded into the
// app window after onboarding. Port deliberately != 3847 (Mike's live dashboard).
const CC_PORT = parseInt(process.env.CC_PORT || '38917', 10);
// Spawned as a real child node process (ELECTRON_RUN_AS_NODE), which has no
// asar fs patching — so it must read a real on-disk file. electron-builder.yml
// asarUnpacks command-centre/**/*, putting it at app.asar.unpacked/. In dev
// (__dirname has no app.asar) the replace is a no-op.
const CC_SERVER = path.join(__dirname, 'command-centre', 'server.cjs').replace('app.asar', 'app.asar.unpacked');
let ccProcess = null;

let tray = null;
let setupWindow = null;
let watcherProcess = null;
let watcherState = 'stopped';
// True only when the user picks "Quit" from the tray (or an update relaunch /
// E2E run). Everything else — Cmd-Q, red-X, Cmd-W — hides the window and keeps
// the tray process alive, so sync never silently stops.
let isQuitting = false;
// Auto-update state: the version that's downloaded and ready to install.
let updateInfo = null;
function ulog(line) { try { fs.appendFileSync(LOG_FILE, '[update] ' + line + '\n'); } catch {} }
let lastEventLine = '';
let lastSyncTime = null;

// Pending invite token from deep-link, set before window opens
let pendingInviteToken = null;

// ---------- single instance ----------
// Pass our version so a running (older) instance can decide to step aside when
// a freshly-installed build launches. Without this, a new build silently exits
// on the lock and the OLD instance keeps running (and keeps port 38917), so an
// update never takes effect until the user manually quits. See second-instance.
const MY_VERSION = require('./package.json').version;
const gotLock = app.requestSingleInstanceLock({ version: MY_VERSION });
if (!gotLock) {
  // Another instance already holds the lock. Launching us fired its
  // 'second-instance' handler with our version; if we're newer it quits and
  // relaunches the (now-upgraded) on-disk bundle. Either way, we exit.
  app.quit();
  process.exit(0);
}

// Compare two semver-ish strings ("0.8.8" > "0.8.7"). Core x.y.z only; any
// prerelease suffix (-alpha.3) is ignored for the newer-than test.
function isNewerVersion(a, b) {
  const core = (v) => String(v || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const av = core(a), bv = core(b);
  for (let i = 0; i < 3; i++) { if ((av[i] || 0) !== (bv[i] || 0)) return (av[i] || 0) > (bv[i] || 0); }
  return false;
}

// A second launch happened. If it's a NEWER build (the user installed an update
// over the top), the on-disk app bundle has already been replaced — so we step
// aside and relaunch, which boots the new code and claims the lock we release on
// quit. If it's the same/older version, just surface our window and pick up any
// deep-link token (the normal "app is already running" behaviour).
app.on('second-instance', (_event, argv, _cwd, additionalData) => {
  const incoming = additionalData && additionalData.version;
  if (incoming && isNewerVersion(incoming, MY_VERSION)) {
    try { fs.appendFileSync(LOG_FILE, `[upgrade] v${incoming} launched over running v${MY_VERSION} — stepping aside and relaunching\n`); } catch {}
    isQuitting = true;
    app.relaunch();
    app.quit(); // before-quit kills the watcher + CC server, freeing port 38917
    return;
  }
  for (const arg of argv) {
    const token = parseInviteUrl(arg);
    if (token) {
      pendingInviteToken = token;
      showSetupWindow();
    }
  }
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
  } else {
    // Re-launching an already-onboarded install should bring up the Command
    // Centre, not silently do nothing.
    routeToSurface();
  }
});

// macOS reopen: `open -a "Agency Brain"` while it's already running (or a dock
// click when the icon is showing) fires this. Bring the right surface forward
// instead of doing nothing.
app.on('activate', () => {
  // activate can fire before 'ready' on first launch; creating a window then
  // throws. whenReady already handles the first-launch open, so bail out early.
  if (!app.isReady()) return;
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  routeToSurface();
});

// The ONE rule for which surface opens: the Command Centre when we know which
// brain this machine looks after, the wizard only when we're confident there
// isn't one yet. An unreadable settings file is neither of those, so it gets its
// own honest message instead of silently showing setup to someone who has been
// running for weeks.
function routeToSurface() {
  const { config, state } = readConfig({ retries: 4 });
  if (state === 'unreadable') { showConfigUnreadable(); return; }
  if (config && config.brainPath) openCommandCentre();
  else showSetupWindow();
}

function showConfigUnreadable() {
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: APP_NAME,
    message: "I couldn't read this app's settings.",
    detail: `The small file that records which brain this computer looks after is there, but it wouldn't open just now. Your brain folder and everything in it are untouched, and nothing has been lost.\n\nTry again first — this is usually temporary. If it keeps happening, "Set up again" will get you running, and your work is safe on GitHub either way.`,
    buttons: ['Try again', 'Set up again', 'Open log'],
    defaultId: 0,
    cancelId: 0,
  });
  if (choice === 1) showSetupWindow();
  else if (choice === 2) shell.openPath(LOG_FILE);
  else routeToSurface();
}

// ---------- url scheme ----------
if (!app.isDefaultProtocolClient('agencybrain')) {
  app.setAsDefaultProtocolClient('agencybrain');
}
app.on('open-url', (event, url) => {
  event.preventDefault();
  const token = parseInviteUrl(url);
  if (token) {
    pendingInviteToken = token;
    showSetupWindow();
  }
});

function parseInviteUrl(s) {
  if (!s || typeof s !== 'string') return null;
  if (!s.startsWith('agencybrain://')) return null;
  try {
    const u = new URL(s);
    if (u.host !== 'join' && u.pathname !== '/join') return null;
    return u.searchParams.get('token');
  } catch {
    return null;
  }
}

// ---------- config ----------
// Reading config.json has THREE outcomes, and only one of them means "this is a
// new install": the file genuinely isn't there. A file that IS there but won't
// read or parse — a filesystem hiccup as a Mac wakes from sleep, a half-written
// file — used to collapse into the same `null` as "absent". Every routing
// decision is `cfg && cfg.brainPath ? CommandCentre : wizard`, so that one
// unlucky read dropped a fully onboarded member into the setup wizard with no
// message at all. (Reported 2026-07-29: a Mac slept overnight, the updater
// relaunched the app, and it came back showing setup screens. A full restart
// read the file cleanly and it started normally, which is the signature of a
// transient read rather than a corrupt file.)
//
// So: retry before believing a failure, fall back to the last known-good copy,
// and report "unreadable" separately so callers never mistake it for "new".
function clog(line) { try { fs.appendFileSync(LOG_FILE, '[config] ' + line + '\n'); } catch {} }
// Blocking, deliberately: readConfig must stay synchronous because loadConfig()
// is called from ~30 places that expect a plain return value, and making it
// async would ripple through the whole file. The cost is contained — a healthy
// read returns on the first attempt and never sleeps at all, so this only ever
// blocks on the failure path, where the alternative is showing someone the
// wrong screen.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// retries defaults to 0 so the hot callers (updateTray every 15s, the watcher,
// every IPC handler) stay exactly as cheap as they were. Only the routing
// decisions — the ones that can wrongly show the wizard — pay for retries.
function readConfig({ retries = 0, delayMs = 250 } = {}) {
  if (!fs.existsSync(CONFIG_FILE)) return { config: null, state: 'absent' };
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return { config: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), state: 'ok' };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) sleepSync(delayMs);
    }
  }
  // The file is there and we still can't read it. The backup is rewritten on
  // every successful save, so it holds the member's real settings as of their
  // last change — far better than treating them as a brand new install.
  try {
    const recovered = JSON.parse(fs.readFileSync(CONFIG_BACKUP_FILE, 'utf8'));
    if (retries > 0) clog('config.json unreadable (' + (lastErr && lastErr.message) + ') — recovered from backup');
    return { config: recovered, state: 'recovered' };
  } catch { /* no usable backup either */ }
  if (retries > 0) clog('config.json unreadable and no usable backup: ' + (lastErr && lastErr.message));
  return { config: null, state: 'unreadable' };
}
function loadConfig() {
  return readConfig().config;
}
// ---------- brain profiles (the switcher) ----------
// One machine can hold several brains (a scout's own agency brain + the client
// brains they service — the ClientBrain placement-B case). The top-level config
// keys stay the ACTIVE brain, exactly as every existing reader (watcher, CC,
// tray) expects, so old configs and old code paths keep working untouched.
// config.brains[] archives a profile per known brain; saveConfig maintains it
// on every write, and the tray's "Switch brain" swaps a profile into the top
// level. Only ONE brain is ever active/synced at a time (the app is
// single-instance by design); switching is the supported way to work across
// brains, not parallel watchers.
const BRAIN_PROFILE_KEYS = ['brainPath', 'mode', 'teamSlug', 'memberEmail', 'memberName', 'memberRole', 'memberToken', 'scoutSeats', 'packageTier', 'kind', 'brandName'];
function brainKey(p) { return (p && (p.teamSlug || p.brainPath)) || ''; }
function profileFromActive(cfg) {
  const p = {};
  for (const k of BRAIN_PROFILE_KEYS) if (cfg[k] !== undefined) p[k] = cfg[k];
  return p;
}
function upsertProfile(brains, profile) {
  const key = brainKey(profile);
  if (!key || !profile.brainPath) return brains;
  const next = brains.filter((b) => brainKey(b) !== key);
  next.push(profile);
  return next;
}

function saveConfig(c) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const prev = loadConfig();
  const merged = { ...c };
  let brains = Array.isArray(c.brains) ? c.brains.slice()
    : (prev && Array.isArray(prev.brains) ? prev.brains.slice() : []);
  // A new active brain arriving (different key) archives the old one first, so
  // setting up a second brain never clobbers the first. Same-key saves just
  // refresh that brain's stored profile (fresh token, role, brand).
  if (prev && prev.brainPath && brainKey(prev) && brainKey(prev) !== brainKey(merged)) {
    brains = upsertProfile(brains, profileFromActive(prev));
  }
  if (merged.brainPath && brainKey(merged)) {
    brains = upsertProfile(brains, profileFromActive(merged));
  }
  if (brains.length) merged.brains = brains;
  const json = JSON.stringify(merged, null, 2);
  // Write via temp file + rename. A plain writeFileSync truncates the real file
  // first, so anything that interrupts it (sleep, force quit, the updater
  // relaunching) leaves a half-written config.json — which readConfig() would
  // then have to recover from. rename() is atomic, so the file on disk is only
  // ever the whole old version or the whole new one.
  const tmp = CONFIG_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, CONFIG_FILE);
  try { fs.writeFileSync(CONFIG_BACKUP_FILE, json); } catch { /* best effort */ }
  APP_NAME = computeAppName();
  // The macOS app menu carries APP_NAME in its title and its Quit item, so a
  // client brand set during the wizard has to rebuild it, same as updateTray().
  applyAppMenu();
}

// Swap another stored brain into the active slot: archive-and-swap via
// saveConfig, then bounce the watcher + Command Centre so both come up
// against the new folder and identity. A profile with an expired sign-in
// token lands on the existing needsReconnect path (clear message, one click
// to sign in again) rather than failing silently.
function switchBrain(key) {
  const cfg = loadConfig();
  if (!cfg || !Array.isArray(cfg.brains)) return;
  if (brainKey(cfg) === key) return;
  const target = cfg.brains.find((b) => brainKey(b) === key);
  if (!target) return;
  const next = { ...cfg };
  for (const k of BRAIN_PROFILE_KEYS) delete next[k];
  Object.assign(next, target);
  saveConfig(next);
  if (ccProcess) { ccProcess.kill(); ccProcess = null; }
  if (watcherProcess) {
    watcherProcess.once('exit', () => startWatcher());
    watcherProcess.kill('SIGINT');
  } else {
    startWatcher();
  }
  updateTray();
  // Show the brain you just switched to. Bouncing the server without touching
  // the window left the OLD brain's Command Centre on screen, so switching
  // looked like it did nothing (Mike, first client-brain install, 2026-07-30).
  openCommandCentre();
}
function brainLabel(p) {
  const name = (p && p.kind === 'client' && p.brandName) ? p.brandName
    : (p && p.teamSlug) ? p.teamSlug
    : (p && p.brainPath) ? path.basename(p.brainPath) : '(unknown)';
  // Say "client brain" in words. The bare ◆ marker meant nothing to the first
  // person who met it (Mike: "I have no idea what that is").
  return p && p.kind === 'client' ? `${name} (client brain)` : name;
}

// Agency mode but the saved sign-in token is gone — e.g. config.json was cleared
// while troubleshooting (seen in the field, 2026-06-19). The watcher and the
// Command Centre both need that token, so syncing is paused until the member signs
// in again. Re-signing in (the wizard) re-mints the token, adopts the existing
// brain folder in place (no re-clone), and restarts the watcher. There is NO
// portal page that hands out this token — it only comes from signing in here.
function needsReconnect(config) {
  return !!(config && config.mode === 'agency' && config.brainPath && !config.memberToken);
}

// ---------- watcher lifecycle ----------
function startWatcher() {
  const config = loadConfig();
  if (!config || !config.brainPath) {
    watcherState = 'stopped';
    updateTray();
    return;
  }
  // Signed-out agency brain: don't spin a watcher that can only fail on the
  // missing token (the old behaviour error-looped silently every 5s). Surface a
  // clear, actionable "reconnect" state and a one-time notification instead.
  if (needsReconnect(config)) {
    if (watcherProcess) { try { watcherProcess.kill(); } catch (_) {} watcherProcess = null; }
    watcherState = 'attention';
    lastStopReason = 'You are signed out, so syncing is paused. Choose "Reconnect / sign in again".';
    if (!reconnectNotified) { reconnectNotified = true; notifyReconnect(); }
    signedOut = true;
    updateTray();
    return;
  }
  reconnectNotified = false;
  signedOut = false;
  if (watcherProcess) return;

  const pathExtra = process.platform === 'win32'
    ? `${process.env.PATH || ''};C:\\Program Files\\Git\\cmd;C:\\Program Files (x86)\\Git\\cmd`
    : `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;

  const env = {
    ...process.env,
    BRAIN_PATH: config.brainPath,
    DEBOUNCE_MS: String(config.debounceMs || 90000),
    PULL_INTERVAL_MS: String(config.pullIntervalMs || 60000),
    STATE_FILE,
    PATH: pathExtra,
    ELECTRON_RUN_AS_NODE: '1',
    // Phone-dispatch (Brain Inbox "Save & Start Session"): opt-in per machine
    // via the tray menu, default off, so in a team only the machines the owner
    // picks act on phone notes.
    BRAIN_DISPATCH: config.dispatchEnabled ? '1' : '0',
  };

  // Agency-mode: pass identity + a way to mint fresh tokens
  if (config.mode === 'agency') {
    // Register the git credential helper for every known brain clone, so git
    // outside the app (terminal, Claude Code) mints live tokens instead of
    // hitting the stale keychain cache. Self-heals on every start; never blocks.
    ensureCredentialHelper(config, { userData: USER_DATA, exePath: process.execPath });
    env.BRAIN_SYNC_MODE = 'agency';
    env.AGENCY_TEAM_SLUG = config.teamSlug || '';
    env.AGENCY_MEMBER_EMAIL = config.memberEmail || '';
    env.AGENCY_MEMBER_ROLE = config.memberRole || 'team';
    env.AGENCY_MEMBER_TOKEN = config.memberToken || '';
    env.AGENCY_API_BASE = API_BASE;
    env.AGENCY_APP_VERSION = app.getVersion();
  } else {
    env.BRAIN_SYNC_MODE = 'personal';
  }

  watcherProcess = spawn(process.execPath, [WATCHER_PATH], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const errStream = fs.createWriteStream(ERR_FILE, { flags: 'a' });

  watcherProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    logStream.write(text);
    parseWatcherOutput(text);
  });
  watcherProcess.stderr.on('data', (chunk) => errStream.write(chunk));
  watcherProcess.on('exit', (code) => {
    logStream.end();
    errStream.end();
    watcherProcess = null;
    if (watcherState === 'paused') {
      // intentional stop
    } else if (code === 0) {
      watcherState = 'stopped';
    } else {
      watcherState = 'error';
      setTimeout(() => { if (watcherState === 'error') startWatcher(); }, 5000);
    }
    updateTray();
  });

  watcherState = 'running';
  updateTray();
  startStateFileWatch();
}

function stopWatcher() {
  if (!watcherProcess) return;
  watcherState = 'paused';
  watcherProcess.kill('SIGINT');
  stopStateFileWatch();
}

function parseWatcherOutput(text) {
  const lines = text.split('\n').filter(Boolean);
  for (const line of lines) {
    lastEventLine = line.replace(/^\[[^\]]+\]\s*/, '');
    if (line.includes('pushed.')) lastSyncTime = new Date();
  }
  updateTray();
}

// ---------- state file (watcher → tray) ----------
// The watcher writes its current state to STATE_FILE as JSON whenever it
// transitions: { state: 'running' | 'pulling' | 'pushing' | 'stop',
// reason: '…', updatedAt: ISO }. We poll the file and translate into the
// tray's watcherState. The 'stop' watcher-state becomes 'attention' for
// the tray so users see a clear "needs your attention" signal.
let stateFileWatcher = null;
let lastStopReason = null;
// Fire the "stuck" desktop notification at most once per stuck episode; re-armed
// when the watcher reports sync has recovered.
let lastStuckNotified = false;
// Same idea for the "signed out, please reconnect" notification (agency mode with
// the token missing). One per episode; re-armed once a token is present again.
let reconnectNotified = false;
// True while this brain is signed out and syncing nothing. Drives the menu-bar
// title text, which is the only always-on signal: the notification fires once
// and is off entirely for anyone with macOS notifications disabled.
let signedOut = false;
// Runtime auth-expired flag, driven by the watcher (a 401 minting a git token):
// the stored token is still PRESENT but the server has rejected it as expired.
// Distinct from needsReconnect(config), which only catches a locally-MISSING
// token. Both funnel into the same "Reconnect / sign in again" surface. Reset
// when sync recovers (i.e. after the member signs in again).
let authExpired = false;
// Files the watcher parked locally (oversized, or a role the member can't push)
// while the rest of the brain keeps syncing. Surfaced as a calm menu line — NOT
// a red attention state, because syncing is still healthy.
let lastHeld = [];

// One desktop notification per stuck episode. The watcher has tried and failed
// to sync several times in a row and needs the user to act (usually: quit and
// reopen the app, which restarts sync cleanly). Re-armed once sync recovers.
function notifyStuck(reason) {
  try {
    if (!Notification.isSupported()) return;
    // The reason now carries its own fix wherever the watcher can identify one,
    // so don't bolt the old generic "quit and reopen" onto it. That advice sent
    // a scout in circles for a whole morning on a repo-level problem that
    // restarting could never fix (2026-07-31), and it buried the real cause.
    new Notification({
      title: `${APP_NAME} needs attention`,
      body: `${String(reason).replace(/\.\s*$/, '')}.\nClick the menu bar icon and choose "See what needs attention" for the full details.`,
    }).show();
  } catch (_) { /* notifications are best-effort */ }
}

// Signed-out agency brain: tell the member exactly what to do (sign in again),
// rather than letting the watcher fail silently in the background.
function notifyReconnect() {
  try {
    if (!Notification.isSupported()) return;
    new Notification({
      title: `${APP_NAME}: please sign in again`,
      body: `Your sign-in has expired or was cleared, so syncing is paused. Open ${APP_NAME} and choose "Reconnect / sign in again".`,
    }).show();
  } catch (_) { /* notifications are best-effort */ }
}

function applyWatcherState(payload) {
  if (!payload || typeof payload.state !== 'string') return;
  const heldNext = Array.isArray(payload.held) ? payload.held : [];
  const heldChanged =
    heldNext.length !== lastHeld.length ||
    heldNext.some((h, i) => !lastHeld[i] || lastHeld[i].file !== h.file);
  lastHeld = heldNext;
  const isAttention = payload.state === 'stop';
  if (isAttention) {
    lastStopReason = payload.reason || 'needs your attention';
    let changed = false;
    if (payload.authExpired) {
      // The watcher's git-token mint got a 401: the sign-in session is dead. Route
      // it into the same reconnect surface as a locally-missing token — a one-time
      // desktop prompt + the tray "Reconnect / sign in again…" item — so an expired
      // session can never fail silently in the background again.
      if (!authExpired) { authExpired = true; changed = true; }
      if (!reconnectNotified) { reconnectNotified = true; notifyReconnect(); }
      signedOut = true;
    } else if (payload.stuck && !lastStuckNotified) {
      // Only the stabilised "stuck" stop (repeated failures) nudges the user; a
      // one-off transient stop stays a quiet tray colour.
      lastStuckNotified = true;
      notifyStuck(lastStopReason);
    }
    if (watcherState !== 'attention') {
      watcherState = 'attention';
      changed = true;
    }
    if (changed) updateTray();
  } else if (watcherState === 'attention') {
    // Watcher reports it cleared the stop; resume normal display.
    lastStopReason = null;
    lastStuckNotified = false;
    authExpired = false;
    reconnectNotified = false;
    signedOut = false;
    watcherState = 'running';
    updateTray();
  } else if (heldChanged) {
    // State didn't transition, but the held-file list did — refresh the menu so
    // the review line appears/disappears without flipping the icon.
    updateTray();
  }
}

function readStateFile() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const json = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    applyWatcherState(json);
  } catch (_) { /* ignore parse-mid-write races */ }
}

function startStateFileWatch() {
  stopStateFileWatch();
  // Use polling watchFile: more reliable than fs.watch across save+rename.
  stateFileWatcher = fs.watchFile(STATE_FILE, { interval: 1000 }, () => readStateFile());
  readStateFile();
}

function stopStateFileWatch() {
  if (stateFileWatcher !== null) {
    fs.unwatchFile(STATE_FILE);
    stateFileWatcher = null;
  }
}

// ---------- tray ----------
function makeTrayIcon(state) {
  let file;
  if (state === 'attention') file = ICON_ATTENTION;
  else if (state === 'running') file = ICON_ON;
  else file = ICON_OFF;
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) console.error('Tray icon failed to load from', file);
  const targetSize = process.platform === 'darwin' ? 22 : 16;
  return img.resize({ width: targetSize, height: targetSize, quality: 'best' });
}

function statusLabel() {
  switch (watcherState) {
    case 'running':
      if (lastSyncTime) {
        const ago = Math.round((Date.now() - lastSyncTime.getTime()) / 1000);
        const human = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago / 60)} min ago` : `${Math.round(ago / 3600)} h ago`;
        return `Syncing.  Last push: ${human}`;
      }
      return 'Syncing.  No pushes yet.';
    case 'attention': return `Needs your attention: ${lastStopReason || 'see log'}`;
    case 'paused': return 'Paused.';
    case 'error':  return 'Error.  Restarting...';
    default:       return 'Stopped.';
  }
}

function buildMenu() {
  const config = loadConfig();
  const folder = config && config.brainPath ? config.brainPath : '(not set)';
  const homeRel = folder.startsWith(app.getPath('home')) ? '~' + folder.slice(app.getPath('home').length) : folder;
  // The wizard writes mode:'agency' even for a client brain, so kind is the only
  // discriminator here. Branching on mode alone put "Agency: acme-corp-brain"
  // in a client's menu bar, which named the relationship they're not meant to
  // see. A client brain shows the brain and the seat, with no "Agency:" label.
  const modeBadge = config && config.kind === 'client'
    ? `${config.teamSlug || 'unknown'} (${config.memberRole || 'team'})`
    : config && config.mode === 'agency'
      ? `Agency: ${config.teamSlug || 'unknown'} (${config.memberRole || 'team'})`
      : config && config.mode === 'personal' ? 'Personal sync' : '';

  // A client brain shows the client's brand as the menu headline even before
  // the next app restart re-derives APP_NAME from config.
  const headline = (config && config.kind === 'client' && config.brandName) ? config.brandName : APP_NAME;
  // Read-only status header: who this brain is, whether it's syncing, where it
  // lives, and what happened last.
  const items = [
    { label: headline, enabled: false },
    { label: statusLabel(), enabled: false },
    ...(modeBadge ? [{ label: modeBadge, enabled: false }] : []),
    { type: 'separator' },
    { label: `Folder:  ${homeRel}`, enabled: false },
    { label: lastEventLine ? `Last:  ${lastEventLine}` : 'Last:  (no activity yet)', enabled: false },
    { type: 'separator' },
  ];

  // ---- Urgent, only when something needs the user (top of the action list) ----

  // A downloaded update waiting to install — the most prominent action, so it
  // can't be missed. Reuses the tested relaunch flow (offers "Relaunch / Later").
  if (updateInfo && updateInfo.version) {
    items.push({ label: `Restart to install update v${updateInfo.version}`, click: () => checkForUpdatesManually() });
    items.push({ type: 'separator' });
  }

  // Signed-out OR session-expired agency brain: the one action that fixes it.
  if (needsReconnect(config) || authExpired) {
    items.push({ label: 'Reconnect / sign in again…', click: () => showSetupWizard('reconnect') });
    items.push({ type: 'separator' });
  }

  // Files kept local (not pushed) — surface which and let the user open the folder.
  if (lastHeld && lastHeld.length) {
    const first = lastHeld[0];
    const extra = lastHeld.length > 1 ? ` (+${lastHeld.length - 1} more)` : '';
    items.push({ label: `${lastHeld.length} file(s) held — kept local, still syncing the rest`, enabled: false });
    items.push({ label: `   • ${path.basename(first.file)}: ${first.why}${extra}`, enabled: false });
    items.push({ label: 'Open folder to review held file(s)', click: () => { if (config && config.brainPath) shell.openPath(config.brainPath); } });
    items.push({ type: 'separator' });
  }

  // Needs-attention state gets ONE log link, up top. In every other state the log
  // lives once in the housekeeping group below — never both (that was the old
  // "Open log…" / "Show log" duplicate).
  const logAtTop = watcherState === 'attention';
  if (logAtTop) {
    items.push({ label: 'See what needs attention', click: () => shell.openPath(LOG_FILE) });
    items.push({ type: 'separator' });
  }

  // ---- Primary actions ----
  items.push(
    { label: 'Open Command Centre', click: () => openCommandCentre(), enabled: !!(config && config.brainPath) },
    { label: 'Open brain folder', click: () => { if (config && config.brainPath) shell.openPath(config.brainPath); }, enabled: !!(config && config.brainPath) },
  );

  // ---- Brain switcher: only when this machine has more than one DISTINCT brain
  // FOLDER. Deduped by folder, so a brain re-tagged during testing (one folder
  // saved under several identities) never shows phantom/duplicate entries.
  // When one folder IS saved under several identities, keep the profile that
  // matches the ACTIVE config: keeping "first in the array" meant the menu
  // could show a stale identity for that folder, mark the active brain as
  // clickable, and change its label between openings as the array reordered
  // (all three seen on the first client-brain install, 2026-07-30). ----
  const activeKey = brainKey(config);
  const byFolder = new Map();
  for (const b of (config && Array.isArray(config.brains)) ? config.brains : []) {
    if (!b || !b.brainPath) continue;
    const existing = byFolder.get(b.brainPath);
    if (!existing || brainKey(b) === activeKey) byFolder.set(b.brainPath, b);
  }
  const realBrains = [...byFolder.values()];
  if (realBrains.length > 1) {
    items.push({ type: 'separator' });
    items.push({
      label: 'Switch brain',
      submenu: realBrains.map((b) => ({
        label: brainLabel(b) + (brainKey(b) === brainKey(config) ? '   ✓ active' : ''),
        enabled: brainKey(b) !== brainKey(config),
        click: () => switchBrain(brainKey(b)),
      })),
    });
  }

  // ---- Sync + housekeeping ----
  items.push({ type: 'separator' });
  if (watcherState === 'paused') {
    items.push({ label: 'Resume syncing', click: () => { watcherState = 'stopped'; startWatcher(); } });
  } else {
    items.push({ label: 'Pause syncing', click: () => stopWatcher(), enabled: watcherState === 'running' || watcherState === 'attention' });
  }
  if (!logAtTop) {
    items.push({ label: 'Show log', click: () => shell.openPath(LOG_FILE) });
  }
  items.push({ label: 'Check for updates…', click: () => checkForUpdatesManually() });

  // A solo (personal-mode) owner ready to bring teammates in — a first-class
  // upgrade action, not buried in Settings. Opens the setup wizard, which
  // creates the team (OTP -> name agency -> connect GitHub -> clone + seed) or,
  // if it already exists, signs in and flips this brain to agency mode.
  if (config && config.mode === 'personal') {
    items.push({ type: 'separator' });
    items.push({ label: 'Connect to my agency team…', click: () => showSetupWizard('create-agency') });
  }

  // Adding a SECOND brain from a setup code (an agency owner staging a client
  // brain, or anyone joining another team). Always visible: once a brain is set
  // up, the only way in used to be Settings -> "Run setup again…", which nobody
  // reads as code entry — so an owner handed a code had no visible option and
  // had to sign out of the Command Centre to find one (2026-07-28 beta report).
  // Wording deliberately matches the "I have a code" phrase used in the invite
  // emails and the setup instructions.
  if (config && config.brainPath) {
    items.push({ label: 'I have a code (add a brain)…', click: () => showSetupWizard('join-code') });
  }

  // ---- Settings: the on/off toggles + re-run setup, grouped in one home ----
  items.push({ type: 'separator' });
  items.push({
    label: 'Settings',
    submenu: [
      { label: `Start at login: ${getLoginItem() ? 'On' : 'Off'}`, click: () => toggleLoginItem() },
      { label: 'Run setup again…', click: () => showSetupWindow() },
    ],
  });

  // ---- App ----
  items.push(
    { type: 'separator' },
    { label: `About ${APP_NAME}`, click: () => showAbout() },
    { label: `Quit ${APP_NAME}`, click: () => { isQuitting = true; stopWatcher(); setTimeout(() => app.quit(), 200); } },
  );

  return Menu.buildFromTemplate(items);
}

// Hide the window and drop back to the menu bar, leaving sync running. Shared by
// the window close handler and the macOS Cmd-Q menu item so both behave alike.
function hideWindowToTray() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    saveWindowState();
    setupWindow.hide();
  }
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
}

// Cmd-Q must hide the window rather than stop syncing, but it USED to be caught
// in before-quit, which cannot tell a keypress apart from macOS asking every app
// to quit at shutdown or restart. So the app refused the system too and macOS put
// up "<app> failed to quit", blocking the shutdown until it force-killed us
// (reported by a client-brain tester on 2026-07-31; live since v0.8.12).
//
// Catch Cmd-Q at the menu instead. The app only owns a menu bar while a window is
// up (openCommandCentre calls app.dock.show(), which makes it a regular app), and
// that is exactly when Cmd-Q can be pressed. before-quit is then left free to mean
// what it says: a real quit, which shutdown is allowed to have.
//
// The Edit menu is not decoration. On macOS, copy/paste/select-all in web content
// only work if menu items own those accelerators, so dropping roles here would
// break text entry across the Command Centre.
function applyAppMenu() {
  // macOS only, deliberately. Windows keeps its default menu (and its Ctrl+Q)
  // untouched, so this change cannot regress a platform that can't be tested
  // from a Mac. Windows shutdown blocking is a separate fix, see before-quit.
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, click: () => showAbout() },
        { type: 'separator' },
        // role:'hide' otherwise labels itself from the BUNDLE name, so a client
        // brain read "About testy-cb" and "Hide Agency Brain" in the same menu.
        // Overriding the label keeps the client's brand consistent; the bundle
        // name is a separate, deliberately deferred change.
        { role: 'hide', label: `Hide ${APP_NAME}` }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        // Deliberately NOT role:'quit'. Hides and keeps syncing; the tray menu's
        // Quit is the way out.
        { label: `Close ${APP_NAME} Window`, accelerator: 'Command+Q', click: () => hideWindowToTray() },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

function updateTray() {
  if (!tray) return;
  // A downloaded-but-not-yet-installed update shows on the menu-bar icon itself:
  // the attention icon plus a tooltip saying an update is waiting, so someone who
  // never opens the Command Centre still sees it. Reads the same updateInfo the
  // relaunch toast uses.
  const pending = updateInfo && updateInfo.version;
  tray.setImage(makeTrayIcon(pending || watcherState === 'attention' ? 'attention' : watcherState));
  tray.setToolTip(pending
    ? `${APP_NAME} update ready (v${updateInfo.version}). Restart to install.`
    : `${APP_NAME} — ${statusLabel()}`);
  // Signed out means nothing is syncing, and until now that was effectively
  // invisible: the attention ICON was missing from assets/ so it silently fell
  // back to the healthy one, and the notification fires once (and never at all
  // for anyone with macOS notifications off). macOS can put real words next to
  // the icon, so use them. Cleared the moment sync is healthy again.
  if (process.platform === 'darwin' && typeof tray.setTitle === 'function') {
    tray.setTitle(signedOut ? ' Signed out' : '');
  }
  tray.setContextMenu(buildMenu());
}

// ---------- login item ----------
// Flip phone-dispatch for this machine and bounce the watcher so the child
// process picks up the new BRAIN_DISPATCH env. Kill directly (not
// stopWatcher(), which parks the state as 'paused' and won't restart).
// NOTE: the "Start sessions from your phone" tray toggle was removed 2026-07-24
// (undocumented, confusing) — the feature still runs off config.dispatchEnabled,
// so this handler is kept ready for a one-line re-add once it's properly explained.
function toggleDispatch() {
  const cfg = loadConfig();
  if (!cfg) return;
  cfg.dispatchEnabled = !cfg.dispatchEnabled;
  saveConfig(cfg);
  if (watcherProcess) {
    try { watcherProcess.kill('SIGINT'); } catch (_) {}
    watcherProcess = null;
    stopStateFileWatch();
  }
  watcherState = 'stopped';
  startWatcher();
  updateTray();
}

function getLoginItem() { return app.getLoginItemSettings().openAtLogin; }
// Windows has no openAsHidden; instead we tag the login-item command with
// --hidden and detect it in argv (see wasLaunchedAtLogin). macOS uses
// openAsHidden + wasOpenedAtLogin natively.
function loginItemArgs() { return process.platform === 'win32' ? ['--hidden'] : []; }
function toggleLoginItem() {
  const next = !getLoginItem();
  app.setLoginItemSettings({ openAtLogin: next, openAsHidden: true, args: loginItemArgs() });
  updateTray();
}
// True when THIS launch was the OS auto-starting us at login, so we should stay
// quietly in the tray. A user-initiated launch returns false → we open into the
// Command Centre (the daily work surface).
function wasLaunchedAtLogin() {
  if (process.platform === 'darwin') return !!app.getLoginItemSettings().wasOpenedAtLogin;
  return process.argv.includes('--hidden');
}

// ---------- window position memory ----------
// Persist the app window's bounds so reopening the Command Centre lands it
// where the user left it, on the screen they left it on, instead of always
// re-centering on the primary display.
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8')); } catch { return null; }
}
function saveWindowState() {
  try {
    if (!setupWindow || setupWindow.isDestroyed() || setupWindow.isMinimized()) return;
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(setupWindow.getBounds()));
  } catch {}
}
// Guard against bounds saved on a monitor that's since been unplugged: only
// reuse them if the rect still overlaps a connected display's work area.
function boundsAreVisible(b) {
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') return false;
  const { screen } = require('electron');
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + Math.min(b.width || 0, 200) > a.x &&
           b.y < a.y + a.height && b.y + 40 > a.y;
  });
}

// ---------- setup window ----------
function showSetupWindow() {
  // Reveal the Dock icon while the wizard is open so the user can Cmd-Tab
  // back to it after clicking on other windows. Hidden again when the
  // wizard closes so the app returns to menu-bar-only mode.
  if (process.platform === 'darwin' && app.dock) app.dock.show();

  if (setupWindow) {
    // The wizard and the Command Centre share this window. "Set up..." must
    // always land on the WIZARD — if the window is currently showing the
    // Command Centre (or anything else), load the wizard back into it.
    // Previously this branch just refocused whatever was showing, so with the
    // CC open the menu item was a silent no-op (2026-07-23 test finding).
    const cur = setupWindow.webContents.getURL() || '';
    if (!/wizard\.html/.test(cur)) {
      setupWindow.setMinimumSize(600, 640);
      setupWindow.setSize(680, 800);
      setupWindow.center();
      setupWindow.loadFile(path.join(__dirname, 'src', 'wizard.html'));
    }
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  const saved = loadWindowState();
  const useSaved = saved && boundsAreVisible(saved);
  setupWindow = new BrowserWindow({
    width: useSaved ? saved.width : 680,
    height: useSaved ? saved.height : 800,
    ...(useSaved ? { x: saved.x, y: saved.y } : {}),
    resizable: true,
    minWidth: 600,
    minHeight: 640,
    minimizable: true,
    maximizable: false,
    title: APP_NAME,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  // Remember where the user puts the window, so the next open restores it.
  setupWindow.on('moved', saveWindowState);
  setupWindow.on('resized', saveWindowState);
  // Merged wizard (Brain 3.0 design + real solo/agency wiring). The 9-step
  // setup.html it replaced was deleted 2026-07-29: nothing had loaded it for
  // months, but it still shipped inside every bundle carrying agency-facing
  // copy that a client brain must not contain.
  setupWindow.loadFile(path.join(__dirname, 'src', 'wizard.html'));
  // External links (e.g. the Command Centre's members-portal / Circle buttons)
  // open in the user's default browser, not inside the app window.
  setupWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Dev/debug: F12 (or Cmd+Opt+I) toggles DevTools so console + network errors
  // are visible when something misbehaves. No menu needed (this is a tray app).
  setupWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isInspect = input.key === 'F12' || (input.meta && input.alt && (input.key || '').toLowerCase() === 'i');
    if (isInspect) setupWindow.webContents.toggleDevTools();
  });
  // Closing the window (red-X / Cmd-W) hides it; the app keeps running in the
  // tray. Only an explicit tray "Quit" sets isQuitting and really exits.
  setupWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      saveWindowState();
      setupWindow.hide();
      if (process.platform === 'darwin' && app.dock) app.dock.hide();
    }
  });
  setupWindow.on('closed', () => {
    setupWindow = null;
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });
}

// Open the setup WIZARD specifically. showSetupWindow early-returns when a window
// already exists, and after onboarding that window is showing the Command Centre
// (openCommandCentre loaded the CC URL into it). So a bare showSetupWindow() from
// the tray would just re-focus the Command Centre, never the wizard, which is
// the entry point a personal-mode owner needs for the solo->team flip. Force the
// wizard file back into the shared window so "Connect to my agency team…" always
// lands on the sign-in flow.
function showSetupWizard(intent) {
  // A reconnect re-mints the member token; the Command Centre freezes the token
  // at spawn, so kill it here so it comes back with the fresh one after re-auth.
  if (intent === 'reconnect' && ccProcess) { try { ccProcess.kill(); } catch (_) {} ccProcess = null; }
  showSetupWindow();
  if (setupWindow && !setupWindow.isDestroyed()) {
    // Resize back down to the wizard's footprint (openCommandCentre grows it to
    // >=1000 and bumps the minimum), then load the wizard. A CC-sized window
    // makes the wizard look stranded in a huge frame.
    // (resize before the new minimum so the smaller size is allowed)
    setupWindow.setMinimumSize(600, 640);
    const b = setupWindow.getBounds();
    if (b.width > 760) setupWindow.setSize(680, 800);
    // intent rides the query string ('create-agency' = a member with no team yet
    // goes straight to naming their agency after sign-in).
    setupWindow.loadFile(path.join(__dirname, 'src', 'wizard.html'), intent ? { query: { intent } } : undefined);
    setupWindow.show();
    setupWindow.focus();
  }
}

function showAbout() {
  const cfg = loadConfig();
  const detail = [
    `Version ${require('./package.json').version}`,
    '',
    'Keeps your brain folder in sync with GitHub. Runs quietly in the menu bar.',
    '',
    // A client brain is stored as mode:'agency' (kind is what makes it a client
    // brain), so printing the raw mode here told the client whose app this
    // really is. They're on a team either way, so say that.
    `Mode: ${cfg?.kind === 'client' ? 'team' : (cfg?.mode || 'not configured')}`,
    cfg?.teamSlug ? `Team: ${cfg.teamSlug}` : null,
    `Logs: ${LOG_FILE}`,
  ].filter(Boolean).join('\n');
  dialog.showMessageBox({ type: 'info', title: APP_NAME, message: APP_NAME, detail, buttons: ['OK'] });
}

// ---------- embedded Command Centre ----------
function startCommandCentre() {
  if (ccProcess) return;
  const config = loadConfig();
  if (!config || !config.brainPath) return;
  ccProcess = spawn(process.execPath, [CC_SERVER], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BRAIN_ROOT: config.brainPath,
      CC_PORT: String(CC_PORT),
      // Identity for the Command Centre header + version footer. Sourced from
      // config.json (which the app got from the server at OTP login).
      AGENCY_MEMBER_EMAIL: config.memberEmail || '',
      AGENCY_MEMBER_NAME: config.memberName || '',
      AGENCY_MEMBER_ROLE: config.memberRole || '',
      AGENCY_TEAM_SLUG: config.teamSlug || '',
      // Paid seat cap (+ package label) for the upgrade banner. Snapshot from
      // the my-teams response at install; server.cjs /api/health refreshes it
      // live. Blank/0 means "not set" (banner stays hidden).
      AGENCY_SCOUT_SEATS: config.scoutSeats == null ? '' : String(config.scoutSeats),
      AGENCY_PACKAGE_TIER: config.packageTier || '',
      // ClientBrain: 'client' brains brand the CC from the white-label record
      // (served live by /api/branding, cached for offline). Default 'agency'.
      AGENCY_TEAM_KIND: config.kind || 'agency',
      AGENCY_BRAND_NAME: config.brandName || '',
      AGENCY_VERSION: require('./package.json').version,
      // The member's own login token + API base, so the Command Centre can do
      // team-management (live roster, add member) by acting AS the member —
      // never with more access than they have (agent-permissions principle).
      AGENCY_MEMBER_TOKEN: config.memberToken || '',
      AGENCY_API_BASE: API_BASE,
      // The app is the authority on "signed out"; the Command Centre used to
      // infer it from a 401, which it can only get if a token EXISTS. With no
      // token stored there was nothing to reject, so the banner stayed hidden
      // while syncing was stopped. Tell it outright instead of re-deriving.
      AGENCY_NEEDS_RECONNECT: needsReconnect(config) ? '1' : '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  ccProcess.stderr.on('data', (c) => fs.appendFileSync(LOG_FILE, '[cc] ' + c));
  ccProcess.on('exit', () => { ccProcess = null; });
}

// Liveness alone is not health. The server's brain identity is baked into its
// env at spawn, so after a switch the OLD server — still dying from kill(), or
// orphaned entirely by a force-quit — answers on the port and used to pass this
// check, which is exactly how the window kept showing the previous brain
// (Peter, three ways, 2026-07-30). Healthy = answering AND serving the brain
// config.json currently points at.
async function ccHealthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${CC_PORT}/api/health`);
    if (!r.ok) return false;
    const h = await r.json().catch(() => null);
    if (!h) return false;
    const cfg = loadConfig();
    if (!cfg || !cfg.brainPath) return true;
    return h.brainRoot === cfg.brainPath && String(h.teamSlug || '') === String(cfg.teamSlug || '');
  } catch { return false; }
}

// Anything answering at all — even the wrong brain's server. Distinct from
// ccHealthy so the respawn path can tell "port still held" from "port free".
async function ccAnswering() {
  try { await fetch(`http://127.0.0.1:${CC_PORT}/api/health`); return true; }
  catch { return false; }
}

// PIDs LISTENING on the Command Centre port. Last resort only: servers older
// than 1.1.13 have no /api/shutdown, so an orphan from before an update can't
// be ASKED to leave — it must be terminated, or the new server EADDRINUSEs and
// the Command Centre is dead until a reboot (Mike's machine, first 1.1.13
// update, 2026-07-31: a 1.1.12 orphan from switch-testing held the port).
function pidsOnCcPort() {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === CC_PORT) pids.add(Number(m[2]));
      }
      return [...pids];
    }
    const out = execSync(`lsof -nP -tiTCP:${CC_PORT} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) { return []; } // lsof exits non-zero when nothing is listening
}

async function ensureCommandCentre() {
  if (!(await ccHealthy())) {
    // Clear the port before spawning: kill our own child if we have one, ask
    // any other holder (an orphan we never owned) to exit via /api/shutdown,
    // then WAIT until the port actually frees. Spawning without the wait was
    // the switch-brain race: the dying server answered the health probe, the
    // fresh spawn was skipped, and the old brain stayed on screen.
    if (ccProcess) { try { ccProcess.kill(); } catch (e) { /* already gone */ } ccProcess = null; }
    try { await fetch(`http://127.0.0.1:${CC_PORT}/api/shutdown`, { method: 'POST' }); } catch (e) { /* nothing listening */ }
    for (let i = 0; i < 20 && await ccAnswering(); i++) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (await ccAnswering()) {
      // Still held: a pre-1.1.13 server that doesn't understand the shutdown
      // request. Confirm the holder really is a Command Centre server (its
      // /api/health has our shape) — never blind-kill a stranger's process —
      // then terminate it by PID and wait for the port to free.
      let isCc = false;
      try {
        const h = await (await fetch(`http://127.0.0.1:${CC_PORT}/api/health`)).json();
        isCc = !!(h && typeof h === 'object' && 'brainRoot' in h);
      } catch (e) { /* stopped answering after all */ }
      if (isCc) {
        for (const pid of pidsOnCcPort()) {
          try { process.kill(pid); clog('evicted stale Command Centre server (pid ' + pid + ')'); }
          catch (e) { /* already gone */ }
        }
        for (let i = 0; i < 20 && await ccAnswering(); i++) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }
    startCommandCentre();
  }
  for (let i = 0; i < 40; i++) {
    if (await ccHealthy()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// "Missing" is a big claim — it sends the member back into setup — so don't make
// it on the strength of one stat call. A folder on a drive that hasn't finished
// mounting after a wake, or on a volume that's a moment behind, reads as absent
// and then reappears. Check a few times before believing it. Async on purpose:
// the caller is already async, so waiting here costs nothing and never freezes
// the app the way a blocking retry would.
async function brainFolderReallyMissing(p) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (fs.existsSync(p)) return false;
    if (attempt < 4) await new Promise((r) => setTimeout(r, 200));
  }
  clog('brain folder still not there after 5 checks: ' + p);
  return true;
}

// Load the Command Centre into the app window (the post-onboarding home).
async function openCommandCentre() {
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  // Self-heal (2026-07-23 test finding): if the configured brain folder has
  // been deleted out from under us, every Command Centre surface breaks one
  // card at a time (raw ENOENT on identity, empty Skills, "no guided path").
  // Route back into setup instead, with a plain-English explanation.
  const cfg = loadConfig();
  if (cfg && cfg.brainPath && await brainFolderReallyMissing(cfg.brainPath)) {
    const missingOpts = {
      type: 'warning',
      title: APP_NAME,
      message: 'Your brain folder is missing.',
      detail: `The folder this brain lives in (${cfg.brainPath}) is no longer on this computer — it may have been moved or deleted. Let's set it up again; your work is safe on GitHub and will download fresh.`,
      buttons: ['Open setup'],
    };
    if (setupWindow) dialog.showMessageBoxSync(setupWindow, missingOpts);
    else dialog.showMessageBoxSync(missingOpts);
    showSetupWindow();
    return { ok: false };
  }
  const ok = await ensureCommandCentre();
  if (!setupWindow) showSetupWindow();
  if (!ok) {
    const choice = dialog.showMessageBoxSync(setupWindow, {
      type: 'error',
      title: APP_NAME,
      message: 'Could not start the Command Centre.',
      detail: `The background server didn't respond. The details are in the log:\n${LOG_FILE}`,
      buttons: ['Open log', 'OK'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) shell.openPath(LOG_FILE);
    return { ok: false };
  }
  // The wizard and the Command Centre share one window. The wizard is small
  // (680 wide), so restoring its saved bounds would open the Command Centre
  // cramped. Restore saved bounds only when they're already Command-Centre-sized
  // (>= 1000 wide); otherwise open at a roomy default and center. Once the user
  // resizes the CC, that larger state is what gets remembered.
  const saved = loadWindowState();
  setupWindow.setMinimumSize(1000, 700);
  if (saved && boundsAreVisible(saved) && saved.width >= 1000) {
    setupWindow.setBounds(saved);
  } else {
    setupWindow.setSize(1400, 1000);
    setupWindow.center();
  }
  await setupWindow.loadURL(`http://127.0.0.1:${CC_PORT}/`);
  setupWindow.show();
  setupWindow.focus();
  quietUpdateCheck(); // opening the app re-checks for a new version on the spot
  return { ok: true };
}

// Gated end-to-end self-test. No effect unless AB_E2E is set. Proves the REAL
// main + preload + renderer + embedded CC connect, headless:
//   AB_E2E=wizard          → load wizard.html, screenshot, report active scene
//   AB_E2E=cc BRAIN_ROOT=…  → seed config, openCommandCentre, screenshot
async function runE2E(mode) {
  const out = path.join(os.tmpdir(), 'ab-e2e');
  fs.mkdirSync(out, { recursive: true });
  try {
    if (mode === 'cc') {
      saveConfig({ brainPath: process.env.BRAIN_ROOT || path.join(os.homedir(), 'Projects', 'brain-sandbox'), mode: 'personal' });
      await openCommandCentre();
      await new Promise((r) => setTimeout(r, 2500));
      fs.writeFileSync(path.join(out, 'cc.png'), (await setupWindow.webContents.capturePage()).toPNG());
      console.error('AB_E2E_OK cc');
    } else {
      showSetupWindow();
      await new Promise((r) => setTimeout(r, 1600));
      fs.writeFileSync(path.join(out, 'wizard.png'), (await setupWindow.webContents.capturePage()).toPNG());
      const scene = await setupWindow.webContents.executeJavaScript("(document.querySelector('.screen.active')||{}).id");
      const hasApi = await setupWindow.webContents.executeJavaScript("!!(window.agencyBrain && window.agencyBrain.detectMachine)");
      console.error('AB_E2E_OK wizard scene=' + scene + ' bridge=' + hasApi);
    }
  } catch (e) {
    console.error('AB_E2E_ERR ' + (e && e.stack || e));
  }
  isQuitting = true;
  app.quit();
}

// ---------- IPC handlers ----------
ipcMain.handle('get-config', () => loadConfig() || {});

ipcMain.handle('save-config', async (_evt, config) => {
  const prevKey = brainKey(loadConfig());
  saveConfig(config);
  // If this save changed the ACTIVE brain (the add-a-brain wizard finishing is
  // the main case), the running Command Centre is still the old brain's: its
  // folder, identity and branding are baked into its env at spawn. Bounce it
  // exactly like switchBrain does, or "Open Command Centre" straight after
  // setup reuses the healthy old server and shows the previous brain (Mike hit
  // this on the first real client-brain install, 2026-07-30). The next open
  // starts it fresh against the new brain.
  if (ccProcess && brainKey(loadConfig()) !== prevKey) {
    ccProcess.kill();
    ccProcess = null;
  }
  if (watcherProcess) {
    watcherProcess.once('exit', () => startWatcher());
    watcherProcess.kill('SIGINT');
  } else {
    startWatcher();
  }
  updateTray(); // the Switch-brain list gains the new brain right away
  return true;
});

ipcMain.handle('pick-folder', async (_evt, opts) => {
  const requireGit = !!(opts && opts.requireGit);
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose folder',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const picked = result.filePaths[0];
  if (requireGit && !fs.existsSync(path.join(picked, '.git'))) {
    dialog.showErrorBox('Not a git folder', `${picked} is not a git repository.\n\nThe brain folder must be a clone from GitHub.`);
    return null;
  }
  return picked;
});

ipcMain.handle('get-home-path', () => os.homedir());

// App version for the wizard footer (a support diagnostic: lets a member read
// back which version they're on off a screenshot).
ipcMain.handle('get-app-version', () => app.getVersion());

// Default brain folder, OS-correct. path.join uses the right separator (\ on
// Windows, / on macOS), so this no longer produces the mixed-slash path that
// broke folder creation on Windows.
// folderSlug (optional, 2026-07-23): a client brain's folder is named for
// THEIR brain (brand slug, e.g. 'acme-corp-brain', or 'business-brain'),
// never for our product. Agencies pass nothing and keep 'agencybrain'.
ipcMain.handle('get-default-folder', (_evt, folderSlug) => path.join(os.homedir(), folderSlug || 'agencybrain'));

// Given a folder the user picked, return the brain folder to use: the picked
// folder itself if it's already named for the brain, otherwise a brain folder
// nested inside it. path.basename is separator-safe, so this works on
// Windows (backslashes) where the old `.endsWith('/agencybrain')` check failed
// and double-appended.
ipcMain.handle('resolve-target-folder', (_evt, picked, folderSlug) => {
  const name = folderSlug || 'agencybrain';
  return path.basename(picked) === name ? picked : path.join(picked, name);
});

// ---------- Claude desktop app detection ----------
ipcMain.handle('detect-claude-desktop', async () => {
  try {
    if (process.platform === 'darwin') {
      const appPath = '/Applications/Claude.app';
      if (!fs.existsSync(appPath)) return { installed: false };
      const plist = path.join(appPath, 'Contents', 'Info.plist');
      const version = await new Promise((resolve) => {
        execFile('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist], (err, stdout) => {
          if (err) resolve(null); else resolve(stdout.trim());
        });
      });
      return { installed: true, version: version || 'unknown' };
    }
    if (process.platform === 'win32') {
      // Best-effort: query the registry. If anything goes wrong, report not installed
      // so the user sees the "install it" flow and can Skip if they have it.
      const version = await new Promise((resolve) => {
        execFile('reg', ['query', 'HKCU\\Software\\Anthropic\\Claude', '/v', 'DisplayVersion'], (err, stdout) => {
          if (err) return resolve(null);
          const m = stdout.match(/DisplayVersion\s+REG_SZ\s+(\S+)/);
          resolve(m ? m[1] : null);
        });
      });
      return version ? { installed: true, version } : { installed: false };
    }
    return { installed: false };
  } catch (_) {
    return { installed: false };
  }
});

ipcMain.handle('launch-claude-app', async () => {
  if (process.platform === 'darwin') {
    execFile('open', ['-a', 'Claude']);
  } else if (process.platform === 'win32') {
    // Try the registered uri scheme as the most reliable launch path on Windows
    shell.openExternal('claude://');
  } else {
    shell.openExternal('https://claude.com/download');
  }
  return { ok: true };
});

ipcMain.handle('open-external-url', async (_evt, url) => {
  if (typeof url !== 'string') return { ok: false };
  // Only allow http(s) for safety
  if (!/^https?:\/\//.test(url)) return { ok: false };
  shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('close-wizard', () => {
  if (setupWindow) setupWindow.close();
  return { ok: true };
});

ipcMain.handle('open-command-centre', () => openCommandCentre());

// Sign out: clear the member token + team identity, stop syncing, and return to
// the setup wizard. The tray process keeps running (this is not a quit).
ipcMain.handle('sign-out', () => {
  try {
    const cfg = loadConfig() || {};
    delete cfg.memberToken;
    delete cfg.teamSlug;
    delete cfg.memberEmail;
    delete cfg.memberName;
    delete cfg.memberRole;
    saveConfig(cfg);
    stopWatcher();
    if (ccProcess) { ccProcess.kill(); ccProcess = null; }
    if (process.platform === 'darwin' && app.dock) app.dock.show();
    // Reopen the wizard in RECONNECT mode, not first-time setup: a signed-out
    // member still has their brain folder on disk, so they should re-auth with
    // their email and get straight back in, never the invite-code welcome.
    showSetupWizard('reconnect');
    updateTray();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Flip an existing PERSONAL-mode brain into AGENCY mode IN PLACE — the Phase 4
// solo->team upgrade for Path A (the member's own brain repo became the agency
// repo). No re-clone: the same folder stays; we switch the sync mode, add the
// team identity, then restart the watcher AND the Command Centre so both pick up
// agency mode (the CC froze MEMBER_TOKEN/TEAM_SLUG as consts at require time, so
// it must respawn before its team-management endpoints unlock). We act AS the
// member with their own token (agent-permissions principle), never an admin key.
//
// Args: { memberToken, teamSlug }. The token comes from a fresh OTP sign-in in
// the wizard, because a personal-mode config holds no token.
ipcMain.handle('flip-to-agency', async (_evt, args) => {
  const memberToken = args && args.memberToken;
  const teamSlug = args && args.teamSlug;
  if (!memberToken || !teamSlug) return { ok: false, error: 'Missing member token or team.' };

  const config = loadConfig();
  if (!config || !config.brainPath) {
    return { ok: false, error: 'No brain folder is set up yet — finish personal setup first.' };
  }
  if (config.mode === 'agency') {
    return { ok: false, error: 'This app is already connected to an agency team.' };
  }

  // Read the team's live details AS the member: repo, the member's role, seats.
  let summary;
  try {
    const r = await fetch(`${API_BASE}/api/team-brain/team-summary?team=${encodeURIComponent(teamSlug)}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      return { ok: false, error: b.error || `Couldn't read your team (HTTP ${r.status}).` };
    }
    summary = await r.json();
  } catch (e) {
    return { ok: false, error: `Couldn't read your team: ${e.message}` };
  }
  const team = summary.team || {};
  const requester = summary.requester || {};
  if (!team.installed) {
    return { ok: false, error: "Your team's GitHub App isn't installed yet. Finish the one-time GitHub setup in the app's setup wizard, then connect here." };
  }

  // In-place flip only applies when THIS folder's origin IS the agency repo
  // (Path A). If origin is a different repo (e.g. Path B made a fresh agency repo
  // elsewhere), do NOT hijack this folder's remote — tell them to point the app
  // at the agency brain folder instead.
  let origin = '';
  try {
    origin = String(await runGit(['-C', config.brainPath, 'remote', 'get-url', 'origin'])).trim();
  } catch (e) { origin = ''; }
  const normRepo = (u) => String(u || '').trim().toLowerCase()
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^https:\/\/x-access-token:[^@]*@/, 'https://')
    .replace(/\.git$/, '').replace(/\/$/, '');
  // Never flip in place without a CONFIRMED agency repo. If the team's repo isn't
  // linked yet (repoUrl null even though installed), fall through to the safe clone
  // path rather than converting whatever this folder currently tracks (e.g. a solo
  // members-template clone) into agency mode against the wrong remote.
  if (!team.repoUrl) {
    return { ok: false, mismatch: true, error: "Your agency repo isn't linked yet. Finish the one-time GitHub setup in the app's setup wizard, then connect here." };
  }
  if (origin && normRepo(origin) !== normRepo(team.repoUrl)) {
    return {
      ok: false, mismatch: true, origin, repoUrl: team.repoUrl,
      error: `This folder syncs to ${origin}, but your team repo is ${team.repoUrl}. If you started fresh, point ${APP_NAME} at your new brain folder instead of flipping this one.`,
    };
  }

  // Seed .team-config/roles.json from the live roster if missing (watcher reads
  // it for role-based push filtering). Best-effort; mirrors clone-agency-brain.
  try {
    const rolesPath = path.join(config.brainPath, '.team-config', 'roles.json');
    if (!fs.existsSync(rolesPath)) {
      const roles = {
        team_slug: team.slug || teamSlug,
        team_name: team.name || teamSlug,
        members: (summary.members || []).map((m) => ({ email: m.email, name: m.name, role: m.role })),
      };
      fs.mkdirSync(path.dirname(rolesPath), { recursive: true });
      fs.writeFileSync(rolesPath, JSON.stringify(roles, null, 2) + '\n');
    }
  } catch (e) { /* best-effort: watcher falls back to the role hint */ }

  // Rewrite config to agency mode, keeping the SAME brainPath. saveConfig is the
  // single trigger that restarts the watcher, so we write it LAST and preserve
  // every existing key (whole-object overwrite), adding the agency identity.
  const next = {
    ...config,
    mode: 'agency',
    teamSlug,
    memberToken,
    memberEmail: requester.email || config.memberEmail || '',
    memberRole: requester.role || 'owner',
    scoutSeats: team.scoutSeats != null ? team.scoutSeats : (config.scoutSeats != null ? config.scoutSeats : null),
    packageTier: team.packageTier || config.packageTier || '',
  };
  saveConfig(next);

  // Restart the watcher in agency mode (same folder, no re-clone) via the
  // save-config pattern: one-shot exit -> startWatcher, then SIGINT the current.
  if (watcherProcess) {
    watcherProcess.once('exit', () => startWatcher());
    watcherProcess.kill('SIGINT');
  } else {
    startWatcher();
  }
  // Respawn the Command Centre so it serves the agency identity (unlocks add-teammate).
  if (ccProcess) { ccProcess.kill(); ccProcess = null; }
  updateTray();
  return { ok: true, teamSlug, role: next.memberRole };
});

// ---------- agency brain migrations ("brain updates") ----------
// There is deliberately NO auto-fetcher here. Brain updates are NOT just "pull
// in new files": an agency that has edited a skill locally needs those changes
// merged by hand, carefully, which is exactly what the sync engine's own
// keep-both-sides conflict handling is built to avoid doing blindly. So updates
// go through the Update page (m.ads2ai.com/agency-brain/update), where a person
// applies them deliberately, never through an automatic write into the shared
// repo. (A half-built auto-fetcher lived here until 2026-07; it errored on its
// first line every run and never actually ran, and it was removed rather than
// "fixed" so the auto-pull behaviour can't be switched on by accident. Mike's
// call: automatic pulling of updates is unsafe and unwanted.)

// Ensures .team-config/roles.json exists in the watched agency brain. That file
// is the team roster the watcher reads for role-based push filtering and that
// the setup/update prompts (Step 0) check for. It is normally written at
// clone/flip time, but only best-effort and only into the exact folder the app
// set up — so an old app version, a manual clone, or a file that got removed
// could leave it absent, which used to dead-stop the install prompt at Step 0.
// Re-seed it from the LIVE roster on startup so it can never stay missing; the
// watcher then commits + pushes it like any other edit (owners/scouts aren't
// blocked from .team-config/). No-ops the moment the file is present.
async function ensureAgencyRolesSeeded() {
  try {
    const config = loadConfig();
    if (!config || config.mode !== 'agency' || !config.brainPath || !config.memberToken) return;
    if (!fs.existsSync(config.brainPath)) return;
    const rolesPath = path.join(config.brainPath, '.team-config', 'roles.json');
    if (fs.existsSync(rolesPath)) return;
    const teamSlug = config.teamSlug || '';
    if (!teamSlug) return;
    const r = await fetch(`${API_BASE}/api/team-brain/team-summary?team=${encodeURIComponent(teamSlug)}`, {
      headers: { Authorization: `Bearer ${config.memberToken}` },
    });
    if (!r.ok) return;
    const sum = await r.json();
    const roles = {
      team_slug: (sum.team && sum.team.slug) || teamSlug,
      team_name: (sum.team && sum.team.name) || teamSlug,
      members: ((sum.members) || []).map((m) => ({ email: m.email, name: m.name, role: m.role })),
    };
    fs.mkdirSync(path.dirname(rolesPath), { recursive: true });
    fs.writeFileSync(rolesPath, JSON.stringify(roles, null, 2) + '\n');
    ulog('seeded missing .team-config/roles.json from live roster');
  } catch (_) { /* best-effort — next startup retries */ }
}

// ---------- auto-update (electron-updater) ----------
// Polls the public agency-brain-sync GitHub releases (the publish target in
// electron-builder.yml), downloads a newer signed+notarised build in the
// background, and tells the Command Centre window when one is ready so it can
// show the "Relaunch to update" banner. quitAndInstall swaps it in. Only runs
// in the packaged app (the node preview + `electron .` dev have no app-update.yml).
function setupAutoUpdater() {
  if (!app.isPackaged) { ulog('not packaged — auto-update disabled'); return; }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { ulog('electron-updater unavailable: ' + e.message); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Windows ships unsigned (by decision). electron-updater verifies the
  // downloaded installer's Authenticode signature against publisherName and
  // aborts when it's absent ("not signed by the application owner"), so
  // update-downloaded never fired. verifyUpdateCodeSignature is a FUNCTION you
  // override (returning null = pass), NOT a boolean — setting it false is
  // ignored and the check still runs. Override it to skip on Windows; the
  // sha512 in latest.yml still guarantees download integrity.
  if (process.platform === 'win32') {
    autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
  }
  autoUpdater.logger = { info: ulog, warn: ulog, error: ulog, debug: () => {} };
  autoUpdater.on('update-available', (i) => ulog('update available: v' + (i && i.version)));
  autoUpdater.on('update-not-available', () => ulog('up to date'));
  autoUpdater.on('error', (e) => ulog('error: ' + ((e && e.message) || e)));
  autoUpdater.on('before-quit-for-update', () => { isQuitting = true; });
  autoUpdater.on('update-downloaded', (info) => {
    updateInfo = { version: info && info.version };
    ulog('downloaded v' + (info && info.version) + ' — surfacing banner, auto-install in 5 min');
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('update-downloaded', updateInfo);
    scheduleAutoInstall();
    updateTray();
  });
  // Check shortly after launch, then every 30 minutes (was 6h — too slow).
  // openCommandCentre also fires a check, so opening the app re-checks on the
  // spot and the interval just covers the idle case.
  setTimeout(quietUpdateCheck, 10000);
  setInterval(quietUpdateCheck, 30 * 60 * 1000);
}

// Quiet background update check (no dialogs) — used by the timers and on every
// Command Centre open. Throttled to once a minute so repeated opens don't trip
// GitHub's request limit. The configured autoUpdater singleton fires
// update-downloaded → the relaunch toast when a build is ready.
let lastUpdateCheckAt = 0;
function quietUpdateCheck() {
  if (!app.isPackaged) return;
  const now = Date.now();
  if (now - lastUpdateCheckAt < 60000) return;
  lastUpdateCheckAt = now;
  try { require('electron-updater').autoUpdater.checkForUpdates().catch((e) => ulog('check failed: ' + e.message)); }
  catch (e) { ulog('updater unavailable: ' + e.message); }
}

// Manual "Check for updates" from the tray menu. Unlike the silent background
// check, this always tells the user what happened (up to date / downloading /
// error) — which is how an otherwise-invisible update failure (e.g. on
// Windows) becomes a readable message instead of nothing.
async function checkForUpdatesManually() {
  // The user explicitly asked, so bring the app — and every dialog below — to
  // the foreground. The app runs dock-hidden (menu-bar only), so a parentless
  // dialog otherwise opens BEHIND the frontmost window and only the dock bounces.
  // steal:true is the macOS way to activate from a background/accessory app; the
  // option is ignored on other platforms. The background "update downloaded"
  // toast deliberately does NOT do this — unsolicited events shouldn't steal focus.
  app.focus({ steal: true });
  if (!app.isPackaged) {
    dialog.showMessageBox({ type: 'info', title: APP_NAME, message: 'Updates run only in the installed app.', detail: "You're running an unpackaged dev build.", buttons: ['OK'] });
    return;
  }
  // Already downloaded and waiting? Offer the relaunch now.
  if (updateInfo && updateInfo.version) {
    const c = dialog.showMessageBoxSync({ type: 'info', title: APP_NAME, message: `Version ${updateInfo.version} is ready to install.`, detail: `${APP_NAME} will relaunch to finish updating.`, buttons: ['Relaunch now', 'Later'], defaultId: 0, cancelId: 1 });
    if (c === 0) {
      isQuitting = true;
      try { require('electron-updater').autoUpdater.quitAndInstall(); }
      catch (e) { ulog('manual install failed: ' + e.message); isQuitting = false; dialog.showErrorBox(APP_NAME, 'Could not start the update: ' + e.message); }
    }
    return;
  }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { dialog.showErrorBox(APP_NAME, 'Updater unavailable: ' + e.message); return; }
  try {
    ulog('manual check requested');
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo && r.updateInfo.version;
    if (latest && isNewerVersion(latest, MY_VERSION)) {
      // autoDownload is on, so it's already downloading; 'update-downloaded'
      // will show the relaunch toast when it's ready.
      dialog.showMessageBox({ type: 'info', title: APP_NAME, message: `Downloading version ${latest}…`, detail: "Keep working — you'll be offered a relaunch when it's ready.", buttons: ['OK'] });
    } else {
      dialog.showMessageBox({ type: 'info', title: APP_NAME, message: "You're up to date.", detail: `Version ${MY_VERSION} is the latest.`, buttons: ['OK'] });
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    ulog('manual check failed: ' + msg);
    dialog.showErrorBox(APP_NAME, 'Could not check for updates:\n\n' + msg);
  }
}

// The app lives in the menu bar and is almost never quit, so
// autoInstallOnAppQuit alone means downloaded updates wait forever. Five
// minutes after a download finishes we relaunch to install it ourselves.
// The Command Centre toast shows a "Later" link (delay-update) that cancels
// the timer; the update then installs on the next natural quit/restart.
// Terminal Claude sessions are separate processes — the relaunch doesn't
// touch them.
let autoInstallTimer = null;
function scheduleAutoInstall() {
  if (autoInstallTimer) clearTimeout(autoInstallTimer);
  autoInstallTimer = setTimeout(() => {
    ulog('auto-installing downloaded update');
    isQuitting = true;
    try { require('electron-updater').autoUpdater.quitAndInstall(); }
    catch (e) { ulog('auto-install failed: ' + e.message); isQuitting = false; }
  }, 5 * 60 * 1000);
}
ipcMain.handle('delay-update', () => {
  if (autoInstallTimer) { clearTimeout(autoInstallTimer); autoInstallTimer = null; }
  ulog('auto-install delayed by user — will install on next quit');
  return { ok: true };
});

ipcMain.handle('get-update-state', () => updateInfo);
ipcMain.handle('install-update', () => {
  try {
    isQuitting = true;
    require('electron-updater').autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (e) {
    ulog('install failed: ' + e.message);
    isQuitting = false;
    return { ok: false, error: e.message };
  }
});

// Demo-mode helper: create a placeholder folder at the path the user picked
// so Cowork has something real to attach to during walkthroughs. Only seeds
// if the folder is missing or empty; never overwrites existing content.
ipcMain.handle('seed-demo-folder', async (_evt, targetFolder) => {
  try {
    if (!targetFolder || typeof targetFolder !== 'string') {
      return { ok: false, error: 'no target folder' };
    }
    fs.mkdirSync(targetFolder, { recursive: true });
    const existing = fs.readdirSync(targetFolder).filter((f) => !f.startsWith('.'));
    if (existing.length > 0) {
      return { ok: true, seeded: false, note: 'folder not empty; left alone' };
    }
    const readme = `# Welcome to your agency brain\n\nThis folder is shared with everyone on your agency's team. When you make a change, everyone else's copy updates within about a minute. When they make a change, yours updates.\n\n## First time? Try this in Cowork\n\n> What's in this folder? Give me a brief overview of what's here.\n\nThat'll confirm Cowork can see your team's brain. Once Claude answers, you're set.\n\n## What lives where\n\n- \`clients/\` — one folder per client, with notes, decisions, and call recordings\n- \`context/\` — team-wide context, conventions, and templates\n- \`projects/\` — active work with deadlines\n\n## A note on instructions\n\nCowork automatically reads the \`CLAUDE.md\` file in this folder, so Claude always knows your team's conventions without you having to explain them. Your scouts can update \`CLAUDE.md\` to teach Claude new things; everyone on the team picks up the change within about a minute.\n\n> Demo content: this folder was seeded by Agency Brain in demo mode. Replace these files when your real agency brain is set up.\n`;
    const claudeMd = `# Claude instructions\n\nWhen working in this folder, you have access to your team's shared brain. The most useful places to start:\n\n- \`clients/\` — one folder per client, with notes, decisions, and call recordings\n- \`context/\` — team-wide context, conventions, and templates\n- \`projects/\` — active work with deadlines\n\nIf you're not sure where something belongs, ask in your team's Cowork session.\n`;
    const clientNotes = `# Example client notes\n\nUse this as a template for new clients.\n\n- Onboarded: [date]\n- Main contact: [name]\n- Services: [list]\n- Open work: [...]\n\n## Recent activity\n\n_Add notes here. Anyone on your team will see them within a minute._\n`;
    const contextWelcome = `# Team context\n\nThings every Claude session should know about how this team works.\n\n- Brand voice\n- Tools we use day to day\n- Conventions for naming, commit messages, communication\n`;
    const marker = `Seeded by Agency Brain demo mode at ${new Date().toISOString()}.\nReplace this folder when your real agency brain ships.\n`;

    fs.writeFileSync(path.join(targetFolder, 'README.md'), readme);
    fs.writeFileSync(path.join(targetFolder, 'CLAUDE.md'), claudeMd);
    fs.mkdirSync(path.join(targetFolder, 'clients', 'example-client'), { recursive: true });
    fs.writeFileSync(path.join(targetFolder, 'clients', 'example-client', 'notes.md'), clientNotes);
    fs.mkdirSync(path.join(targetFolder, 'context'), { recursive: true });
    fs.writeFileSync(path.join(targetFolder, 'context', 'welcome.md'), contextWelcome);
    fs.writeFileSync(path.join(targetFolder, '.agency-brain-demo-seed'), marker);
    return { ok: true, seeded: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('peek-pending-invite-token', () => pendingInviteToken);

ipcMain.handle('consume-pending-invite-token', () => {
  const t = pendingInviteToken;
  pendingInviteToken = null;
  return t;
});

ipcMain.handle('resolve-invite-token', async (_evt, token) => {
  const r = await fetch(`${API_BASE}/api/team-brain/invite-resolve?token=${encodeURIComponent(token)}`);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  return r.json();
});

ipcMain.handle('request-otp-code', async (_evt, email) => {
  // `app: true` tells the backend this is the agency app, not the members
  // portal, so Team-role members (portal-excluded) can still get a login code.
  const r = await fetch(`${API_BASE}/api/auth/request-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, app: true }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
});

ipcMain.handle('verify-otp-code', async (_evt, email, code) => {
  const r = await fetch(`${API_BASE}/api/auth/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  const json = await r.json();
  return { token: json.token, member: json.member };
});

// Look up which agency/agencies this signed-in email belongs to. The OTP JWT
// from verify-otp-code carries the email claim, and the backend resolves it to
// the caller's teams — the same lookup the portal uses. Drives the email+OTP
// first-run: 0 teams = not linked yet, 1 = auto-select, >1 = picker.
ipcMain.handle('list-my-teams', async (_evt, token) => {
  const r = await fetch(`${API_BASE}/api/team-brain/my-teams`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json(); // { teams: [{ slug, name, role, kind }] }
});

// ClientBrain: fetch the client brain's white-label record (brand name,
// colours, page visibility). The wizard reads brandName from it at setup so
// the tray/dialog layer brands from config; the Command Centre re-fetches it
// live at boot for the rest.
ipcMain.handle('fetch-client-config', async (_evt, args) => {
  const { memberToken, teamSlug } = args || {};
  const r = await fetch(`${API_BASE}/api/team-brain/client-config?team=${encodeURIComponent(teamSlug || '')}`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `client-config fetch failed (HTTP ${r.status})`);
  }
  return r.json(); // { config: {...}, updatedAt }
});

// Create a new agency team for the signed-in member — the in-app replacement for
// the retired agency.ads2ai.com/create-agency wizard. Owner flow only: the caller
// becomes the active owner, the server derives a unique slug from the name and
// stamps the free Solo tier (a matching paid Stripe package bumps tier + seats
// server-side). The wizard then hands straight into the existing
// connect-org -> install App -> clone -> seed pipeline.
ipcMain.handle('create-team', async (_evt, token, name) => {
  const r = await fetch(`${API_BASE}/api/team-brain/create-team`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json(); // { team: { id, slug, name }, member: { id, role } }
});

// Poll the backend for whether the GitHub App install has landed and the brain
// repo exists yet — used by the wizard's "connect your GitHub org" step to know
// when Phase 1 has created the repo. Public GET, no auth (returns only booleans
// + the repo URL).
ipcMain.handle('get-install-status', async (_evt, teamSlug) => {
  const r = await fetch(`${API_BASE}/api/team-brain/install-status?team=${encodeURIComponent(teamSlug)}`);
  if (!r.ok) throw new Error(`install-status failed (HTTP ${r.status})`);
  return r.json();
});

// Link an installation that ALREADY exists on the named org to this team.
// GitHub only redirects (and stamps the team row) when an installation is
// newly created; an org that already has the app shows "Configure" and reports
// nothing, which left the wizard polling forever. The server asks GitHub
// directly and finishes the link + repo resolution itself.
ipcMain.handle('adopt-org-installation', async (_evt, args) => {
  const { memberToken, teamSlug, org } = args || {};
  const r = await fetch(`${API_BASE}/api/team-brain/adopt-org-installation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberToken}` },
    body: JSON.stringify({ teamSlug, org }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `adopt-org-installation failed (HTTP ${r.status})`);
  }
  return r.json(); // { adopted, installed, repoUrl } | { adopted: false, reason }
});

// Check a GitHub account name BEFORE anyone is sent to GitHub's install picker.
// This is a public, unauthenticated endpoint, so it works before any install
// exists and needs no token (rate limit is 60/hour per IP, far beyond what one
// setup run uses). It answers the two questions that were sending people into a
// dead end: does this name exist at all, and is it an organisation rather than a
// personal account. It also returns the numeric account id, which lets the
// connect button deep-link to that ONE organisation so GitHub's ambiguous
// account list never appears.
ipcMain.handle('github-account-lookup', async (_evt, login) => {
  const name = normaliseAccountName(login);
  if (!isValidAccountName(name)) return { ok: false, reason: 'invalid-name', login: name };
  try {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agency-brain-sync' },
    });
    const body = await r.json().catch(() => null);
    return classifyAccount(r.status, body, name);
  } catch (err) {
    return { ok: false, reason: 'offline', login: name, detail: err && err.message };
  }
});

// Ask the server to finish the GitHub side: create the brain repo in the org
// we're installed on, or adopt the right existing one. Replaces the old
// "wait and hope the redirect did it" loop, which stranded any owner whose org
// already had repos in it (Gerrards, 2026-07-28).
// Returns { blocked:false, repoUrl } or { blocked:true, reason, repos }.
ipcMain.handle('ensure-brain-repo', async (_evt, token, teamSlug) => {
  const r = await fetch(`${API_BASE}/api/team-brain/ensure-brain-repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ teamSlug }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
});

// The owner picked one of their existing repos to be the brain.
ipcMain.handle('set-team-repo-url', async (_evt, token, teamSlug, repoUrl) => {
  const r = await fetch(`${API_BASE}/api/team-brain/update-team`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ teamSlug, repoUrl }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
});

// Seed a freshly-created EMPTY agency repo from the agency-brain-template.
// The API install-callback (Phase 1, AGENCY_AUTO_CREATE_REPO) makes the org repo
// EMPTY; this fills it on first clone. Clones the private template with a brokered
// read token, drops the template's history, copies its files over the (empty)
// target, then commits + pushes to the owner's repo using the token still embedded
// in `origin`. Returns true if it seeded, false if the repo already had content
// (the normal already-bootstrapped path). Throws loudly if the template can't be
// reached — better a clear error than a silently-empty brain.
async function seedAgencyBrainIfEmpty(targetFolder, memberToken, teamKind) {
  // An empty repo has no commits, so rev-parse HEAD fails (unborn branch).
  let isEmpty = false;
  try {
    await runGit(['-C', targetFolder, 'rev-parse', 'HEAD']);
  } catch (e) {
    isEmpty = true;
  }
  if (!isEmpty) return false;

  sendWizardLog('Fresh repo — setting it up from the template…');

  // Short-lived read token for the PRIVATE template. ClientBrain deployments
  // (teamKind === 'client') seed from client-brain-template; the server owns
  // the repo mapping, we just say which flavour.
  const repoFlavour = teamKind === 'client' ? 'client' : 'agency';
  const r = await fetch(`${API_BASE}/api/brain/auth-token?repo=${repoFlavour}`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `couldn't get the template (HTTP ${r.status})`);
  }
  const { token: tmplToken, repo: tmplRepo } = await r.json();
  const tmplSlug = tmplRepo || '8020brain/agency-brain-template';
  const tmplUrl = `https://x-access-token:${tmplToken}@github.com/${tmplSlug}.git`;

  // Clone the template shallow, drop its .git, copy its files onto the empty
  // target (whose own .git still points at the owner's repo, token in origin).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-tmpl-'));
  try {
    await runGit(['clone', '--depth', '1', tmplUrl, tmpDir]);
    fs.rmSync(path.join(tmpDir, '.git'), { recursive: true, force: true });
    fs.cpSync(tmpDir, targetFolder, { recursive: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Commit the seed (inline identity so it doesn't depend on git global config,
  // which the wizard's configure-identity step sets separately) and push it as
  // the repo's first content on main.
  await runGit(['-C', targetFolder, 'add', '-A']);
  // The seed commit's author lands in the repo's git history for good. In a
  // client brain that repo belongs to the client, so the author stays neutral
  // rather than naming the product their agency bought.
  const seedAuthor = teamKind === 'client'
    ? ['-c', 'user.email=setup@brain.local', '-c', 'user.name=Brain Setup']
    : ['-c', 'user.email=app@agencybrain', '-c', 'user.name=Agency Brain'];
  await runGit([
    '-C', targetFolder,
    ...seedAuthor,
    'commit', '-m', 'Set up your brain from template',
  ]);
  await runGit(['-C', targetFolder, 'branch', '-M', 'main']);
  sendWizardLog('Publishing your brain to GitHub…');
  await runGit(['-C', targetFolder, 'push', '-u', 'origin', 'main']);
  sendWizardLog('Brain created and published.');
  return true;
}

ipcMain.handle('clone-agency-brain', async (_evt, args) => {
  const { memberToken, teamSlug, repoUrl, teamKind } = args;
  // Normalise whatever the renderer sent into the OS-native form (collapses
  // mixed slashes that older renderer builds could produce).
  const targetFolder = path.normalize(args.targetFolder);
  // Pre-flight before anything destructive: git must be present. A missing git
  // otherwise only fails AFTER we've cleared an empty target folder.
  await ensureGitAvailable();
  // Mint a fresh installation token to embed in the clone URL.
  const tok = await fetch(`${API_BASE}/api/team-brain/git-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`,
    },
    body: JSON.stringify({ teamSlug }),
  });
  if (!tok.ok) {
    const body = await tok.json().catch(() => ({}));
    throw new Error(body.error || `git-token mint failed (HTTP ${tok.status})`);
  }
  const { token, repoUrl: tokenRepoUrl } = await tok.json();
  const cloneUrl = (repoUrl || tokenRepoUrl || '').replace(
    /^https:\/\//,
    `https://x-access-token:${token}@`
  );
  if (!cloneUrl.startsWith('https://x-access-token:')) {
    throw new Error(`Your brain's one-time setup isn't finished yet. The owner or a scout needs to finish setting it up in the ${APP_NAME} app first. Once that's done, sign in here again.`);
  }
  // Make sure the target's parent exists
  fs.mkdirSync(path.dirname(targetFolder), { recursive: true });
  // Normalise a git remote to "owner/repo" (lowercased) so we can tell whether an
  // existing folder is already a clone of THIS agency's repo, regardless of
  // https/ssh/token form or a trailing .git.
  const repoKey = (u) => {
    const m = String(u || '').replace(/\.git$/i, '').match(/github\.com[:/]+([^/]+\/[^/]+?)\/?$/i);
    return m ? m[1].toLowerCase() : '';
  };
  const wantRepo = repoKey(repoUrl || tokenRepoUrl);
  let adopted = false;
  let existedEmpty = false;
  if (fs.existsSync(targetFolder)) {
    // An existing EMPTY folder is normal: the native picker creates the folder
    // when you select/make one. git clones cleanly into an empty dir. Only block
    // on real content (dotfiles don't count).
    const realContent = fs.readdirSync(targetFolder).filter((f) => !f.startsWith('.'));
    if (realContent.length) {
      // The owner often already has their brain cloned locally (e.g.
      // ~/Projects/brain — the solo brain they turned into the agency brain). If
      // this folder is already a git clone of THIS agency's repo, adopt it in
      // place: no re-clone, nothing moved, local work preserved. Any unrelated
      // content still blocks — we never write into a folder that isn't this brain.
      let existingRepo = '';
      try {
        existingRepo = repoKey(String(await runGit(['-C', targetFolder, 'remote', 'get-url', 'origin'])).trim());
      } catch (e) { /* not a git repo */ }
      if (existingRepo && wantRepo && existingRepo === wantRepo) {
        adopted = true;
        sendWizardLog('Your brain is already in this folder — using it as-is, no re-clone.');
      } else {
        throw new Error(`${targetFolder} already exists and isn't empty. Pick an empty folder or a new location.`);
      }
    } else {
      // Empty target. Do NOT clear it yet — clone to a sibling temp first and
      // only swap it in once the clone succeeds, so a mid-transfer failure never
      // leaves the person with a deleted folder and no brain.
      existedEmpty = true;
    }
  }
  if (!adopted) {
    if (existedEmpty) {
      const tmpClone = path.join(path.dirname(targetFolder), '.ab-clone-' + process.pid + '-' + Date.now());
      try {
        await runGit(['clone', cloneUrl, tmpClone]);
      } catch (e) {
        try { fs.rmSync(tmpClone, { recursive: true, force: true }); } catch { /* nothing cloned */ }
        throw e; // target folder is left untouched
      }
      // Clone landed — now it's safe to replace the empty target (same
      // filesystem, so rename is atomic and can't half-copy).
      fs.rmSync(targetFolder, { recursive: true, force: true });
      fs.renameSync(tmpClone, targetFolder);
    } else {
      await runGit(['clone', cloneUrl, targetFolder]);
    }
    // If Phase 1 (the API install-callback) created this org repo EMPTY, fill it
    // from the template now (agency-brain-template, or client-brain-template for
    // a ClientBrain deployment) — while the push token is still in the
    // freshly-cloned origin. A repo that already has content is left untouched.
    await seedAgencyBrainIfEmpty(targetFolder, memberToken, teamKind);
  }
  // Rewrite the remote URL back to the token-less form so we don't keep a
  // 1-hour token on disk; the watcher will mint fresh tokens on each sync.
  const cleanRemote = (repoUrl || tokenRepoUrl).startsWith('https://')
    ? (repoUrl || tokenRepoUrl)
    : `https://github.com/${(repoUrl || tokenRepoUrl).replace(/^.*github.com[:/]/, '')}`;
  await runGit(['-C', targetFolder, 'remote', 'set-url', 'origin', cleanRemote]);
  // Seed .team-config/roles.json from the live roster if the repo doesn't ship
  // one. The watcher reads it to resolve each member's role for push filtering;
  // without it, role resolution falls back to a hint. Teams created via the raw
  // admin API skip the agency-create CLI's seeding step, so seeding at clone
  // time (rather than at provision time) covers every path. Best-effort — a
  // failure here never fails the clone.
  try {
    const rolesPath = path.join(targetFolder, '.team-config', 'roles.json');
    if (!fs.existsSync(rolesPath)) {
      const sumRes = await fetch(`${API_BASE}/api/team-brain/team-summary?team=${encodeURIComponent(teamSlug)}`, {
        headers: { Authorization: `Bearer ${memberToken}` },
      });
      if (sumRes.ok) {
        const sum = await sumRes.json();
        const roles = {
          team_slug: (sum.team && sum.team.slug) || teamSlug,
          team_name: (sum.team && sum.team.name) || teamSlug,
          members: (sum.members || []).map((m) => ({ email: m.email, name: m.name, role: m.role })),
        };
        fs.mkdirSync(path.dirname(rolesPath), { recursive: true });
        fs.writeFileSync(rolesPath, JSON.stringify(roles, null, 2) + '\n');
      }
    }
  } catch (e) { /* best-effort: the watcher falls back to the role hint */ }
  return { ok: true };
});

// Read-only inspection of an existing brain folder (adopt flow, Phase 1). Never
// writes: it reports origin/GitHub status, fetch + ahead/behind, file count,
// gitignore conventions, and a state classification so the wizard can decide
// whether the brain is safe to adopt. enrichedEnv() gives git a real PATH when
// the app is launched from Finder. Errors degrade to a blocked result, never a
// thrown IPC.
ipcMain.handle('inspect-brain-folder', async (_evt, folder) => {
  try {
    return inspectBrainFolder(path.normalize(String(folder || '')), { env: enrichedEnv() });
  } catch (e) {
    return { ok: false, state: 'error', block: true,
      blockReason: 'I couldn’t inspect that folder: ' + ((e && e.message) || e) };
  }
});

// Controlled adopt (adopt flow, Phase 2). The single careful write path: it
// re-confirms state, protects the brain (gitignore), and runs one deliberate
// first sync, streaming progress via wizard-log. It does NOT save config or
// start the watcher — the renderer persists config only after this resolves,
// which is what starts the watcher (so it inherits a clean, in-sync repo).
ipcMain.handle('adopt-existing-brain', async (_evt, args) => {
  const folder = path.normalize(String((args && args.folder) || ''));
  const result = await adoptBrain(folder, {
    memberEmail: (args && args.memberEmail) || '',
    memberName: (args && args.memberName) || '',
    env: enrichedEnv(),
    log: sendWizardLog,
  });
  // #879: record the brain-adoption — the headline funnel event tracked nowhere
  // before (brain hardening plan §9). The adopt itself is the signal (this is the
  // solo path; teamSlug is usually absent, which the endpoint allows). Needs the
  // member_token JWT. Fire-and-forget — a metric, never a gate, never blocks the
  // adopt.
  const memberToken = args && args.memberToken;
  if (memberToken) {
    fetch(`${API_BASE}/api/team-brain/record-adoption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({ teamSlug: (args && args.teamSlug) || undefined, fromState: result && result.fromState }),
    }).then((r) => { if (!r.ok) console.warn('[brain-sync] record-adoption returned', r.status); })
      .catch((e) => console.warn('[brain-sync] record-adoption failed', e.message));
  }
  return result;
});

ipcMain.handle('configure-identity', async (_evt, args) => {
  const { brainPath, memberEmail, memberName, teamKind } = args;
  if (memberName) await runGit(['-C', brainPath, 'config', 'user.name', memberName]);
  if (memberEmail) await runGit(['-C', brainPath, 'config', 'user.email', memberEmail]);
  // Write CLAUDE.local.md AT JOIN (teamed brains only — the wizard passes
  // teamKind on that path). Leaving it to be "worked out in-session" meant a
  // new member's first Claude session had no local identity and inherited
  // whatever the machine's global instructions claimed — Peter's test alias
  // opened as owner (2026-07-30). Role comes from the roles.json seeded just
  // above in clone-agency-brain, so it's the live roster role, not a snapshot.
  if (teamKind) {
    try {
      const li = require('./command-centre/lib/local-identity.cjs');
      if (!li.hasLocalIdentity(brainPath)) {
        li.writeLocalIdentity({
          brainRoot: brainPath,
          name: memberName,
          role: li.roleFromRoster(brainPath, memberEmail) || 'team',
          teamKind,
          teamName: li.teamNameFromRoster(brainPath),
        });
      }
    } catch (e) { clog('join-time identity write failed: ' + e.message); }
  }
  return { ok: true };
});

ipcMain.handle('mark-install-complete', async (_evt, args) => {
  const { memberToken, teamSlug } = args;
  // Enable launch-at-login the moment first-run setup completes. Without this,
  // openAtLogin was only set on a later boot-WITH-config, so a user who
  // finished setup and rebooted before relaunching lost sync silently — the
  // exact silent-drift failure this product exists to prevent. openAsHidden is
  // macOS-only; on Windows the same call writes the registry Run key.
  if (!app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: loginItemArgs() });
  }
  const r = await fetch(`${API_BASE}/api/team-brain/install-complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`,
    },
    body: JSON.stringify({ teamSlug, platform: process.platform }),
  });
  // Don't throw on failure — this is a metric, not a gate.
  if (!r.ok) console.warn('[brain-sync] install-complete returned', r.status);
  return { ok: r.ok };
});

// ===================================================================
// Merged-app IPC (powers the Brain 3.0-design wizard in src/wizard.html, the
// only setup renderer there is since setup.html was deleted 2026-07-29).
// These are the Electron equivalents of Brain 3.0's Tauri commands.
// ===================================================================

// GUI apps launched from Finder/Explorer inherit a minimal PATH that omits
// Homebrew/Node/Git. Prepend the usual locations so shelled tools resolve —
// same trick the watcher uses for its child process.
function enrichedEnv() {
  const pathExtra = process.platform === 'win32'
    ? `${process.env.PATH || ''};C:\\Program Files\\Git\\cmd;C:\\Program Files (x86)\\Git\\cmd`
    : `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
  return { ...process.env, PATH: pathExtra };
}

// Push a progress line to the wizard renderer (the new screens listen for it).
function sendWizardLog(line) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.webContents.send('wizard-log', String(line));
  }
}

function realBrainPath() { return path.join(os.homedir(), 'Projects', 'brain'); }

// Sandbox-aware brain home. A BRAIN_HOME override lets tests run against a
// throwaway dir so onboarding never clones over a real brain. Mirrors Brain
// 3.0's Rust brain_home()/real_brain().
function resolvedBrainHome() {
  const env = (process.env.BRAIN_HOME || '').trim();
  return env || path.join(os.homedir(), 'Projects', 'brain-sandbox');
}

// Dev-only guard: never let an UNPACKAGED (dev) run write over Mike's real
// brain at ~/Projects/brain unless BRAIN_HOME explicitly points there. A
// packaged member build legitimately uses ~/Projects/brain on the member's own
// machine, so the guard is dev-only (keyed on app.isPackaged === false).
function assertSafeTarget(dir) {
  const real = path.resolve(realBrainPath());
  if (!app.isPackaged
      && path.resolve(dir) === real
      && path.resolve(process.env.BRAIN_HOME || '') !== real) {
    throw new Error('Dev guard: refusing to write to ~/Projects/brain. Set BRAIN_HOME to a sandbox dir.');
  }
  return dir;
}

function whichTool(bin) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [bin], { env: enrichedEnv() }).toString().trim();
    return out.split(/\r?\n/)[0] || null;
  } catch { return null; }
}
function toolVersion(toolPath, arg) {
  try {
    return (execFileSync(toolPath, [arg], { env: enrichedEnv() }).toString().split(/\r?\n/)[0] || '').trim();
  } catch { return ''; }
}

// detect_machine — same result shape as the Rust command:
// { tools: [{ key, label, present, version, path }] }
function detectMachine() {
  // What a member actually needs now (Cowork dispatch model, 2026-05-25): Git
  // (the sync watcher clones/commits/pushes) and the Claude desktop app (where
  // they do the work, in their brain folder). Node + the Claude CLI are NOT
  // required — the app runs on Electron's bundled node and dispatch is Cowork,
  // not a terminal. Checking for Node here only produced scary false negatives
  // ("Node.js — will install", which nothing then installed), so it's dropped.
  const isWin = process.platform === 'win32';
  const specs = isWin
    ? [
        { key: 'git', label: 'Git', candidates: ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'], varg: '--version' },
      ]
    : [
        { key: 'git', label: 'Git', candidates: ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'], varg: '--version' },
      ];
  const tools = specs.map((s) => {
    const p = whichTool(s.key) || s.candidates.find((c) => fs.existsSync(c)) || null;
    return p
      ? { key: s.key, label: s.label, present: true, version: toolVersion(p, s.varg), path: p }
      : { key: s.key, label: s.label, present: false, version: '', path: '' };
  });
  const claudePaths = isWin
    ? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'Claude.exe'),
       path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'Claude.exe')]
    : ['/Applications/Claude.app', '/Applications/Cowork.app'];
  const claude = claudePaths.find((p) => p && fs.existsSync(p));
  tools.push({ key: 'cowork', label: 'Claude desktop app', present: !!claude, version: '', path: claude || '' });
  // The platform rides along so the screen can give the right install
  // instructions for a missing Git (a Windows download vs macOS's developer
  // tools prompt) without the renderer having to guess from the user agent.
  return { tools, platform: process.platform };
}

ipcMain.handle('detect-machine', () => detectMachine());

// Where the brain should land + whether this is a throwaway sandbox run.
// Sandbox ONLY when BRAIN_HOME is set (explicit test override) or when running
// unpackaged from source (dev/dry-run, so we never clobber a real brain). A
// packaged member build returns isSandbox:false + no forced path, so the wizard
// uses the real per-mode default (solo: ~/Projects/brain, agency: ~/agencybrain)
// and lets the member change it.
ipcMain.handle('get-brain-home', () => {
  const env = (process.env.BRAIN_HOME || '').trim();
  if (env) return { brainHome: env, isSandbox: true };
  if (!app.isPackaged) return { brainHome: path.join(os.homedir(), 'Projects', 'brain-sandbox'), isSandbox: true };
  return { brainHome: '', isSandbox: false };
});

// Generic clone into a target folder. Used by the SOLO path (members brain
// template) and by sandbox tests. The agency path keeps its own
// clone-agency-brain handler (which mints a team token). repoUrl may already
// carry credentials (x-access-token@) for private repos.
ipcMain.handle('clone-into', async (_evt, args) => {
  const dir = assertSafeTarget(path.normalize(args.targetFolder));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) {
    // Empty target is normal (the picker creates the folder); only block real
    // content. Dev sandboxes are always cleared.
    const realContent = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    const isDevSandbox = !app.isPackaged && path.basename(dir).includes('sandbox');
    if (realContent.length && !isDevSandbox) {
      throw new Error(`${dir} already exists and isn't empty. Pick an empty folder or a new location.`);
    }
    if (isDevSandbox) sendWizardLog('Sandbox exists — removing for a clean clone.');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  sendWizardLog('Cloning your brain…');
  await runGit(['clone', '--depth', '1', args.repoUrl, dir]);
  sendWizardLog('Clone complete.');
  return { ok: true, brainPath: dir };
});

// SOLO path: a member with no agency team clones the shared members brain
// template. Uses the already-deployed GET /api/brain/auth-token (gated to
// memberType community/ota), then clones with the x-access-token credential —
// the same mechanism as clone-agency-brain, just a GET + the template repo.
// No new backend is required (confirmed in 8020api: server/brain.ts:147-210).
ipcMain.handle('clone-solo-brain', async (_evt, args) => {
  const { memberToken } = args;
  const targetFolder = assertSafeTarget(path.normalize(args.targetFolder));
  const r = await fetch(`${API_BASE}/api/brain/auth-token`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `brain auth-token failed (HTTP ${r.status})`);
  }
  const { token, repo } = await r.json();
  const slug = repo || '8020brain/brain-template';
  const cleanRemote = `https://github.com/${slug}.git`;
  const cloneUrl = `https://x-access-token:${token}@github.com/${slug}.git`;
  fs.mkdirSync(path.dirname(targetFolder), { recursive: true });
  if (fs.existsSync(targetFolder)) {
    // The native folder picker CREATES the folder when you select or make one,
    // so an empty target is the normal case, not an error. git clones cleanly
    // into an empty dir. Only block when the folder holds real content (dotfiles
    // like .DS_Store don't count). Empty folders (and dev sandboxes) get cleared
    // so the clone lands on a pristine target.
    const realContent = fs.readdirSync(targetFolder).filter((f) => !f.startsWith('.'));
    const isDevSandbox = !app.isPackaged && path.basename(targetFolder).includes('sandbox');
    if (realContent.length && !isDevSandbox) {
      throw new Error(`${targetFolder} already exists and isn't empty. Pick an empty folder or a new location.`);
    }
    if (isDevSandbox) sendWizardLog('Sandbox exists — removing for a clean clone.');
    fs.rmSync(targetFolder, { recursive: true, force: true });
  }
  sendWizardLog('Cloning your brain…');
  await runGit(['clone', cloneUrl, targetFolder]);
  // Scrub the short-lived token from the remote so it never persists on disk;
  // the watcher mints a fresh one per network op (same as the agency path).
  await runGit(['-C', targetFolder, 'remote', 'set-url', 'origin', cleanRemote]);
  sendWizardLog('Clone complete.');
  return { ok: true, brainPath: targetFolder };
});

ipcMain.handle('run-npm-install', async (_evt, args) => {
  const dir = path.normalize(args.brainPath);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    sendWizardLog('No package.json — skipping npm install.');
    return { ok: true, skipped: true };
  }
  sendWizardLog('Installing dependencies (npm install)…');
  try {
    await new Promise((resolve, reject) => {
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      execFile(npmBin, ['install'], { cwd: dir, env: enrichedEnv(), maxBuffer: 1024 * 1024 * 50 }, (err) => {
        if (err) reject(new Error(`npm install failed: ${(err.message || '').slice(0, 300)}`));
        else resolve();
      });
    });
    sendWizardLog('Dependencies installed.');
    return { ok: true };
  } catch (err) {
    // Non-fatal: the brain is fully usable without these. Only two optional
    // skills need a native dep (better-sqlite3), and they can install build
    // tools on demand. A non-developer Mac often lacks Xcode command-line
    // tools (or has a Node version with no prebuilt binary), so a failed
    // compile here must NOT abort the whole setup the way it used to.
    sendWizardLog("Some optional dependencies didn't install, and that's fine. Your brain still works. A couple of advanced tools may ask for Apple's command-line tools the first time you use them. Continuing setup.");
    return { ok: true, warned: true, warning: (err && err.message ? err.message.slice(0, 300) : 'npm install failed') };
  }
});

ipcMain.handle('write-business-context', async (_evt, args) => {
  const dir = assertSafeTarget(path.normalize(args.brainPath));
  const ctx = args.ctx || {};
  const bizDir = path.join(dir, 'context', 'business');
  fs.mkdirSync(bizDir, { recursive: true });
  const body =
    `# Business Context\n\n` +
    `- **Name:** ${ctx.name || ''}\n` +
    `- **Business:** ${ctx.business || ''}\n` +
    `- **What I sell:** ${ctx.sells || ''}\n` +
    `- **Who I serve:** ${ctx.serves || ''}\n`;
  const target = path.join(bizDir, 'business-context.md');
  fs.writeFileSync(target, body);
  return { ok: true, path: target };
});

function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { env: enrichedEnv(), maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toString().trim();
        reject(new Error(`git ${args[0]} failed: ${msg.slice(0, 300)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Pre-flight: confirm git is installed and runnable BEFORE we touch the target
// folder. On Windows git is a separate install; a missing git otherwise only
// surfaces after we've already cleared an empty target, which reads to the person
// as "it deleted my brain." Fail here, loudly, with a plain-English fix.
async function ensureGitAvailable() {
  try {
    await runGit(['--version']);
  } catch (e) {
    throw new Error(
      process.platform === 'win32'
        ? `Git isn't installed yet. Install it from https://git-scm.com/download/win (keep the default options), then fully quit and reopen ${APP_NAME} and try again.`
        : `Git isn't available. Open Terminal and run \`git --version\` — if it offers to install the command line developer tools, accept, then reopen ${APP_NAME} and try again.`
    );
  }
}

// ---------- app lifecycle ----------
app.whenReady().then(() => {
  if (process.env.AB_E2E) {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    runE2E(process.env.AB_E2E);
    return;
  }
  // Capture deep-link from initial launch argv (Windows + Linux pattern;
  // macOS uses the open-url event which is registered above).
  for (const arg of process.argv.slice(1)) {
    const token = parseInviteUrl(arg);
    if (token) pendingInviteToken = token;
  }

  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  applyAppMenu();

  tray = new Tray(makeTrayIcon('stopped'));
  tray.setToolTip(APP_NAME);
  updateTray();
  setInterval(updateTray, 15000);

  // Configure the updater before anything calls openCommandCentre (which kicks
  // off a check), so that check uses the configured singleton and listeners.
  setupAutoUpdater();
  setTimeout(ensureAgencyRolesSeeded, 15 * 1000);
  setInterval(ensureAgencyRolesSeeded, 30 * 60 * 1000);

  // Boot is the one read that MUST be patient: on a machine that just woke, or
  // that the updater has this second relaunched, a first read can fail for
  // reasons that have nothing to do with the member's setup.
  const { config, state: configState } = readConfig({ retries: 4 });
  if (configState === 'unreadable') {
    showConfigUnreadable();
  } else if (!config || !config.brainPath || pendingInviteToken) {
    showSetupWindow();
  } else if (process.env.AB_FORCE_WIZARD === '1') {
    // QA seam (off by default; never set in a real install): an already-onboarded
    // personal-mode app normally boots into the Command Centre, which buries the
    // solo->team flip entry point. This opens straight to the wizard so the flip
    // can be exercised without hunting for the (possibly notch-hidden) tray item.
    startWatcher();
    showSetupWizard();
  } else {
    startWatcher();
    if (!app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: loginItemArgs() });
    }
    // The Command Centre is the daily work surface, so a user-initiated launch
    // opens into it rather than vanishing into the menu bar. A hidden login
    // auto-start stays in the tray — don't pop a window in someone's face on boot.
    // If they're signed out (token wiped), open the wizard so they can reconnect,
    // not the Command Centre (which can't load their team without a token).
    if (!wasLaunchedAtLogin()) {
      if (needsReconnect(config)) showSetupWizard('reconnect');
      else openCommandCentre();
    }
  }
});

app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('before-quit', (e) => {
  // On macOS every quit reaching here is a real one: the tray "Quit", an update
  // relaunch, E2E, or the system asking at shutdown, restart or log out. Cmd-Q
  // is caught by the app menu instead (applyAppMenu), so nothing needs refusing
  // and the Mac is never blocked from shutting down.
  //
  // Windows/Linux keep the old guard: their default menu still owns Ctrl+Q, so
  // letting quits through would silently stop someone's sync. Their shutdown
  // path needs the same treatment, but that wants a Windows machine to verify
  // and is deliberately left for a follow-up.
  if (process.platform !== 'darwin' && !isQuitting) {
    e.preventDefault();
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.hide();
    return;
  }
  // Load-bearing, despite looking redundant. Electron closes every window after
  // this handler, and the window 'close' handler refuses while isQuitting is
  // false, which aborts the quit we just allowed and puts the bug back one step
  // further down. Verified: with this line removed, a shutdown request logs
  // "window close REFUSED" and the app survives.
  isQuitting = true;
  if (watcherProcess) watcherProcess.kill('SIGINT');
  if (ccProcess) ccProcess.kill();
});
