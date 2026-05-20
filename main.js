// Agency Brain — main process.
// Tray app that supervises the sync watcher child process.
//
// v1.0.0-alpha.2 adds agency-mode support on top of the v0.2 personal sync:
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

const APP_NAME = 'Agency Brain';
const USER_DATA = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const LOG_FILE = path.join(USER_DATA, 'sync.log');
const ERR_FILE = path.join(USER_DATA, 'sync.err');
const STATE_FILE = path.join(USER_DATA, 'state.json');

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
const CC_SERVER = path.join(__dirname, 'command-centre', 'server.cjs');
let ccProcess = null;

let tray = null;
let setupWindow = null;
let watcherProcess = null;
let watcherState = 'stopped';
let lastEventLine = '';
let lastSyncTime = null;

// Pending invite token from deep-link, set before window opens
let pendingInviteToken = null;

// ---------- single instance ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Surface deep-link tokens from a 2nd-instance launch into pendingInviteToken
app.on('second-instance', (_event, argv) => {
  for (const arg of argv) {
    const token = parseInviteUrl(arg);
    if (token) {
      pendingInviteToken = token;
      showSetupWindow();
    }
  }
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

function applyWatcherState(payload) {
  if (!payload || typeof payload.state !== 'string') return;
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
    { type: 'separator' },
    { label: 'Set up...',                click: () => showSetupWindow() },
    { label: `Auto-start at login: ${getLoginItem() ? 'on' : 'off'}`, click: () => toggleLoginItem() },
    { type: 'separator' },
    { label: `About ${APP_NAME}`,        click: () => showAbout() },
    { label: `Quit ${APP_NAME}`,         click: () => { stopWatcher(); setTimeout(() => app.quit(), 200); } },
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
function toggleLoginItem() {
  const next = !getLoginItem();
  app.setLoginItemSettings({ openAtLogin: next, openAsHidden: true });
  updateTray();
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
  setupWindow = new BrowserWindow({
    width: 680,
    height: 800,
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
  // Merged wizard (Brain 3.0 design + real solo/agency wiring). The previous
  // 9-step setup.html stays in the repo as a fallback until the new wizard is
  // proven against real auth on both OSes.
  setupWindow.loadFile(path.join(__dirname, 'src', 'wizard.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });
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
    dialog.showErrorBox(APP_NAME, 'Could not start the Command Centre. See the log for details.');
    return { ok: false };
  }
  setupWindow.setSize(1280, 860);
  setupWindow.center();
  await setupWindow.loadURL(`http://127.0.0.1:${CC_PORT}/`);
  setupWindow.show();
  setupWindow.focus();
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
  const r = await fetch(`${API_BASE}/api/auth/request-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
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
    throw new Error('No repo URL configured for this team. Have your owner finish setup.');
  }
  // Make sure the target's parent exists
  fs.mkdirSync(path.dirname(targetFolder), { recursive: true });
  if (fs.existsSync(targetFolder)) {
    throw new Error(`${targetFolder} already exists. Pick another location.`);
  }
  await runGit(['clone', cloneUrl, targetFolder]);
  // Rewrite the remote URL back to the token-less form so we don't keep a
  // 1-hour token on disk; the watcher will mint fresh tokens on each sync.
  const cleanRemote = (repoUrl || tokenRepoUrl).startsWith('https://')
    ? (repoUrl || tokenRepoUrl)
    : `https://github.com/${(repoUrl || tokenRepoUrl).replace(/^.*github.com[:/]/, '')}`;
  await runGit(['-C', targetFolder, 'remote', 'set-url', 'origin', cleanRemote]);
  return { ok: true };
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
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
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
// instead of setup.html, so the shipping alpha (setup.html) is unaffected.
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
  const isWin = process.platform === 'win32';
  const specs = isWin
    ? [
        { key: 'git', label: 'Git', candidates: ['C:\\Program Files\\Git\\cmd\\git.exe'], varg: '--version' },
        { key: 'node', label: 'Node.js', candidates: [], varg: '--version' },
      ]
    : [
        { key: 'brew', label: 'Homebrew', candidates: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'], varg: '--version' },
        { key: 'git', label: 'Git', candidates: ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'], varg: '--version' },
        { key: 'node', label: 'Node.js', candidates: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'], varg: '--version' },
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
  if (fs.existsSync(dir)) {
    const base = path.basename(dir);
    if (!app.isPackaged && base.includes('sandbox')) {
      sendWizardLog('Sandbox exists — removing for a clean clone.');
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      throw new Error(`${dir} already exists. Pick another location.`);
    }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
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
    const base = path.basename(targetFolder);
    if (!app.isPackaged && base.includes('sandbox')) {
      sendWizardLog('Sandbox exists — removing for a clean clone.');
      fs.rmSync(targetFolder, { recursive: true, force: true });
    } else {
      throw new Error(`${targetFolder} already exists. Pick another location.`);
    }
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
  await new Promise((resolve, reject) => {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFile(npmBin, ['install'], { cwd: dir, env: enrichedEnv(), maxBuffer: 1024 * 1024 * 50 }, (err) => {
      if (err) reject(new Error(`npm install failed: ${(err.message || '').slice(0, 300)}`));
      else resolve();
    });
  });
  sendWizardLog('Dependencies installed.');
  return { ok: true };
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

  const config = loadConfig();
  if (!config || !config.brainPath || pendingInviteToken) {
    showSetupWindow();
  } else {
    startWatcher();
    if (!app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    }
  }
});

app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('before-quit', () => {
  if (watcherProcess) watcherProcess.kill('SIGINT');
  if (ccProcess) ccProcess.kill();
});
