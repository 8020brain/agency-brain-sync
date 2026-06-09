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

const { app, Tray, Menu, BrowserWindow, dialog, shell, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const { inspectBrainFolder } = require('./lib/inspect-brain.cjs');
const { adoptBrain } = require('./lib/adopt-brain.cjs');

const APP_NAME = 'Agency Brain';
const USER_DATA = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
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
    const cfg = loadConfig();
    if (cfg && cfg.brainPath) openCommandCentre();
    else showSetupWindow();
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
  const cfg = loadConfig();
  if (cfg && cfg.brainPath) openCommandCentre();
  else showSetupWindow();
});

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
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}
function saveConfig(c) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

// ---------- watcher lifecycle ----------
function startWatcher() {
  const config = loadConfig();
  if (!config || !config.brainPath) {
    watcherState = 'stopped';
    updateTray();
    return;
  }
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
  };

  // Agency-mode: pass identity + a way to mint fresh tokens
  if (config.mode === 'agency') {
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
// Files the watcher parked locally (oversized, or a role the member can't push)
// while the rest of the brain keeps syncing. Surfaced as a calm menu line — NOT
// a red attention state, because syncing is still healthy.
let lastHeld = [];

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
    if (watcherState !== 'attention') {
      watcherState = 'attention';
      updateTray();
    }
  } else if (watcherState === 'attention') {
    // Watcher reports it cleared the stop; resume normal display.
    lastStopReason = null;
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
  const modeBadge = config && config.mode === 'agency'
    ? `Agency: ${config.teamSlug || 'unknown'} (${config.memberRole || 'team'})`
    : config && config.mode === 'personal' ? 'Personal sync' : '';

  const items = [
    { label: APP_NAME, enabled: false },
    { label: statusLabel(), enabled: false },
    ...(modeBadge ? [{ label: modeBadge, enabled: false }] : []),
    { type: 'separator' },
    { label: `Folder:  ${homeRel}`, enabled: false },
    { label: lastEventLine ? `Last:  ${lastEventLine}` : 'Last:  (no activity yet)', enabled: false },
    { type: 'separator' },
  ];

  if (lastHeld && lastHeld.length) {
    const first = lastHeld[0];
    const extra = lastHeld.length > 1 ? ` (+${lastHeld.length - 1} more)` : '';
    items.push({ label: `${lastHeld.length} file(s) held — kept local, still syncing the rest`, enabled: false });
    items.push({ label: `   • ${path.basename(first.file)}: ${first.why}${extra}`, enabled: false });
    items.push({ label: 'Open folder to review held file(s)', click: () => { if (config && config.brainPath) shell.openPath(config.brainPath); } });
    items.push({ type: 'separator' });
  }
  if (watcherState === 'attention') {
    items.push({ label: 'Open log to see what needs attention', click: () => shell.openPath(LOG_FILE) });
    items.push({ type: 'separator' });
  }
  if (watcherState === 'paused') {
    items.push({ label: 'Resume syncing', click: () => { watcherState = 'stopped'; startWatcher(); } });
  } else {
    items.push({ label: 'Pause syncing', click: () => stopWatcher(), enabled: watcherState === 'running' || watcherState === 'attention' });
  }

  items.push(
    { type: 'separator' },
    { label: 'Open Command Centre', click: () => openCommandCentre(), enabled: !!(config && config.brainPath) },
    { label: 'Open agency brain folder', click: () => { if (config && config.brainPath) shell.openPath(config.brainPath); }, enabled: !!(config && config.brainPath) },
    { label: 'Show log',                 click: () => shell.openPath(LOG_FILE) },
    { label: 'Check for updates…',       click: () => checkForUpdatesManually() },
    { type: 'separator' },
    // Phase 4: a solo (personal-mode) owner who's ready to bring teammates in
    // self-creates their team + installs the App at agency.ads2ai.com, then
    // connects this app to it (the wizard does OTP -> pick team -> flip-to-agency).
    ...(config && config.mode === 'personal'
      ? [{ label: 'Connect to my agency team…', click: () => showSetupWizard() }]
      : []),
    { label: 'Set up...',                click: () => showSetupWindow() },
    { label: `Auto-start at login: ${getLoginItem() ? 'on' : 'off'}`, click: () => toggleLoginItem() },
    { type: 'separator' },
    { label: `About ${APP_NAME}`,        click: () => showAbout() },
    { label: `Quit ${APP_NAME}`,         click: () => { isQuitting = true; stopWatcher(); setTimeout(() => app.quit(), 200); } },
  );

  return Menu.buildFromTemplate(items);
}

function updateTray() {
  if (!tray) return;
  tray.setImage(makeTrayIcon(watcherState));
  tray.setToolTip(`${APP_NAME} — ${statusLabel()}`);
  tray.setContextMenu(buildMenu());
}

// ---------- login item ----------
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
  // Merged wizard (Brain 3.0 design + real solo/agency wiring). The previous
  // 9-step setup.html stays in the repo as a fallback until the new wizard is
  // proven against real auth on both OSes.
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
function showSetupWizard() {
  showSetupWindow();
  if (setupWindow && !setupWindow.isDestroyed()) {
    // Resize back down to the wizard's footprint (openCommandCentre grows it to
    // >=1000 and bumps the minimum), then load the wizard. A CC-sized window
    // makes the wizard look stranded in a huge frame.
    // (resize before the new minimum so the smaller size is allowed)
    setupWindow.setMinimumSize(600, 640);
    const b = setupWindow.getBounds();
    if (b.width > 760) setupWindow.setSize(680, 800);
    setupWindow.loadFile(path.join(__dirname, 'src', 'wizard.html'));
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
    `Mode: ${cfg?.mode || 'not configured'}`,
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
      AGENCY_VERSION: require('./package.json').version,
      // The member's own login token + API base, so the Command Centre can do
      // team-management (live roster, add member) by acting AS the member —
      // never with more access than they have (agent-permissions principle).
      AGENCY_MEMBER_TOKEN: config.memberToken || '',
      AGENCY_API_BASE: API_BASE,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  ccProcess.stderr.on('data', (c) => fs.appendFileSync(LOG_FILE, '[cc] ' + c));
  ccProcess.on('exit', () => { ccProcess = null; });
}

async function ccHealthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${CC_PORT}/api/health`);
    return r.ok;
  } catch { return false; }
}

async function ensureCommandCentre() {
  if (!(await ccHealthy())) startCommandCentre();
  for (let i = 0; i < 40; i++) {
    if (await ccHealthy()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Load the Command Centre into the app window (the post-onboarding home).
async function openCommandCentre() {
  if (process.platform === 'darwin' && app.dock) app.dock.show();
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
  saveConfig(config);
  if (watcherProcess) {
    watcherProcess.once('exit', () => startWatcher());
    watcherProcess.kill('SIGINT');
  } else {
    startWatcher();
  }
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
ipcMain.handle('get-default-folder', () => path.join(os.homedir(), 'agencybrain'));

// Given a folder the user picked, return the brain folder to use: the picked
// folder itself if it's already named agencybrain, otherwise an agencybrain
// folder nested inside it. path.basename is separator-safe, so this works on
// Windows (backslashes) where the old `.endsWith('/agencybrain')` check failed
// and double-appended.
ipcMain.handle('resolve-target-folder', (_evt, picked) =>
  path.basename(picked) === 'agencybrain' ? picked : path.join(picked, 'agencybrain')
);

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
    if (!setupWindow || setupWindow.isDestroyed()) {
      showSetupWindow();
    } else {
      setupWindow.loadFile(path.join(__dirname, 'src', 'wizard.html'));
      setupWindow.show();
      setupWindow.focus();
    }
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
    return { ok: false, error: "Your team's GitHub App isn't installed yet. Finish the install at agency.ads2ai.com, then connect here." };
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
    return { ok: false, mismatch: true, error: "Your agency repo isn't linked yet. Finish connecting it at agency.ads2ai.com, then connect here." };
  }
  if (origin && normRepo(origin) !== normRepo(team.repoUrl)) {
    return {
      ok: false, mismatch: true, origin, repoUrl: team.repoUrl,
      error: `This folder syncs to ${origin}, but your agency repo is ${team.repoUrl}. If you started fresh, point Agency Brain at your new agency brain folder instead of flipping this one.`,
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
    ulog('downloaded v' + (info && info.version) + ' — surfacing banner');
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('update-downloaded', updateInfo);
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
    const c = dialog.showMessageBoxSync({ type: 'info', title: APP_NAME, message: `Version ${updateInfo.version} is ready to install.`, detail: 'Agency Brain will relaunch to finish updating.', buttons: ['Relaunch now', 'Later'], defaultId: 0, cancelId: 1 });
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
  return r.json(); // { teams: [{ slug, name, role }] }
});

ipcMain.handle('clone-agency-brain', async (_evt, args) => {
  const { memberToken, teamSlug, repoUrl } = args;
  // Normalise whatever the renderer sent into the OS-native form (collapses
  // mixed slashes that older renderer builds could produce).
  const targetFolder = path.normalize(args.targetFolder);
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
    throw new Error("Your agency's one-time setup isn't finished yet. The owner or a scout needs to create and connect your brain repo at agency.ads2ai.com first. Once that's done, sign in here again.");
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
  if (fs.existsSync(targetFolder)) {
    // An existing EMPTY folder is normal: the native picker creates the folder
    // when you select/make one. git clones cleanly into an empty dir. Only block
    // on real content (dotfiles don't count); clear an empty target first.
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
      fs.rmSync(targetFolder, { recursive: true, force: true });
    }
  }
  if (!adopted) {
    await runGit(['clone', cloneUrl, targetFolder]);
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
  const { brainPath, memberEmail, memberName } = args;
  if (memberName) await runGit(['-C', brainPath, 'config', 'user.name', memberName]);
  if (memberEmail) await runGit(['-C', brainPath, 'config', 'user.email', memberEmail]);
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
// Merged-app IPC (ADDITIVE — powers the new Brain 3.0-design wizard in
// src/wizard.html). Nothing here is called until main.js loads wizard.html
// instead of setup.html, so the shipping fallback (setup.html) is unaffected.
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
  return { tools };
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

  tray = new Tray(makeTrayIcon('stopped'));
  tray.setToolTip(APP_NAME);
  updateTray();
  setInterval(updateTray, 15000);

  // Configure the updater before anything calls openCommandCentre (which kicks
  // off a check), so that check uses the configured singleton and listeners.
  setupAutoUpdater();

  const config = loadConfig();
  if (!config || !config.brainPath || pendingInviteToken) {
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
    if (!wasLaunchedAtLogin()) openCommandCentre();
  }
});

app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('before-quit', (e) => {
  // Cmd-Q / app-level quit while running in the background must NOT kill the
  // tray process — it hides the window and keeps syncing. Only the tray "Quit"
  // (or an update relaunch / E2E) sets isQuitting and is allowed through.
  if (!isQuitting) {
    e.preventDefault();
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.hide();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    return;
  }
  if (watcherProcess) watcherProcess.kill('SIGINT');
  if (ccProcess) ccProcess.kill();
});
