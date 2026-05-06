// Brain Sync — main process.
// Tray app that supervises the sync watcher child process.

const { app, Tray, Menu, BrowserWindow, dialog, shell, nativeImage, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const APP_NAME = 'Brain Sync';
const USER_DATA = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const LOG_FILE = path.join(USER_DATA, 'sync.log');
const ERR_FILE = path.join(USER_DATA, 'sync.err');

const ICON_ON  = path.join(__dirname, 'assets', 'brain-44.png');
const ICON_OFF = path.join(__dirname, 'assets', 'brain-44-off.png');
const WATCHER_PATH = path.join(__dirname, 'watcher', 'team-brain-sync.js');

let tray = null;
let setupWindow = null;
let watcherProcess = null;
let watcherState = 'stopped'; // stopped | running | paused | error
let lastEventLine = '';
let lastSyncTime = null;

// ---------- single instance ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
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
  if (watcherProcess) {
    return; // already running
  }
  const pathExtra = process.platform === 'win32'
    ? `${process.env.PATH || ''};C:\\Program Files\\Git\\cmd;C:\\Program Files (x86)\\Git\\cmd`
    : `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;

  const env = {
    ...process.env,
    BRAIN_PATH: config.brainPath,
    DEBOUNCE_MS: String(config.debounceMs || 30000),
    PULL_INTERVAL_MS: String(config.pullIntervalMs || 60000),
    PATH: pathExtra,
    // Use Electron's bundled node to run the script (members don't need
    // a separate Node install).
    ELECTRON_RUN_AS_NODE: '1',
  };

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
  watcherProcess.stderr.on('data', (chunk) => {
    errStream.write(chunk);
  });
  watcherProcess.on('exit', (code) => {
    logStream.end();
    errStream.end();
    watcherProcess = null;
    if (watcherState === 'paused') {
      // intentional stop, leave state
    } else if (code === 0) {
      watcherState = 'stopped';
    } else {
      watcherState = 'error';
      // auto-restart after 5 seconds, unless paused
      setTimeout(() => {
        if (watcherState === 'error') startWatcher();
      }, 5000);
    }
    updateTray();
  });

  watcherState = 'running';
  updateTray();
}

function stopWatcher() {
  if (!watcherProcess) return;
  watcherState = 'paused';
  watcherProcess.kill('SIGINT');
}

function restartWatcher() {
  if (watcherProcess) {
    watcherProcess.once('exit', () => startWatcher());
    watcherProcess.kill('SIGINT');
  } else {
    startWatcher();
  }
}

function parseWatcherOutput(text) {
  const lines = text.split('\n').filter(Boolean);
  for (const line of lines) {
    lastEventLine = line.replace(/^\[[^\]]+\]\s*/, '');
    if (line.includes('pushed.')) {
      lastSyncTime = new Date();
    }
  }
  updateTray();
}

// ---------- tray ----------
function makeTrayIcon(state) {
  const file = (state === 'running') ? ICON_ON : ICON_OFF;
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
    case 'paused':
      return 'Paused.';
    case 'error':
      return 'Error.  Restarting...';
    default:
      return 'Stopped.';
  }
}

function buildMenu() {
  const config = loadConfig();
  const folder = config && config.brainPath ? config.brainPath : '(not set)';
  const homeRel = folder.startsWith(app.getPath('home')) ? '~' + folder.slice(app.getPath('home').length) : folder;

  const items = [
    { label: APP_NAME, enabled: false },
    { label: statusLabel(), enabled: false },
    { type: 'separator' },
    { label: `Folder:  ${homeRel}`, enabled: false },
    { label: lastEventLine ? `Last:  ${lastEventLine}` : 'Last:  (no activity yet)', enabled: false },
    { type: 'separator' },
  ];

  if (watcherState === 'paused') {
    items.push({ label: 'Resume syncing', click: () => { watcherState = 'stopped'; startWatcher(); } });
  } else {
    items.push({ label: 'Pause syncing', click: () => stopWatcher(), enabled: watcherState === 'running' });
  }

  items.push(
    { type: 'separator' },
    { label: 'Open brain folder', click: () => { if (config && config.brainPath) shell.openPath(config.brainPath); }, enabled: !!(config && config.brainPath) },
    { label: 'Show log',          click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Change folder...',  click: () => showSetupWindow() },
    { label: `Auto-start at login: ${getLoginItem() ? 'on' : 'off'}`, click: () => toggleLoginItem() },
    { type: 'separator' },
    { label: 'About Brain Sync',  click: () => showAbout() },
    { label: 'Quit Brain Sync',   click: () => { stopWatcher(); setTimeout(() => app.quit(), 200); } },
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
function getLoginItem() {
  return app.getLoginItemSettings().openAtLogin;
}
function toggleLoginItem() {
  const next = !getLoginItem();
  app.setLoginItemSettings({ openAtLogin: next, openAsHidden: true });
  updateTray();
}

// ---------- setup window ----------
function showSetupWindow() {
  if (setupWindow) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 580,
    height: 600,
    resizable: true,
    minWidth: 480,
    minHeight: 520,
    minimizable: false,
    maximizable: false,
    title: APP_NAME,
    backgroundColor: '#fafaf8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  setupWindow.loadFile(path.join(__dirname, 'src', 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: APP_NAME,
    message: APP_NAME,
    detail: `Version 0.1.0\n\nKeeps your team brain folder in sync across the team. Runs quietly in the menu bar.\n\nLogs: ${LOG_FILE}`,
    buttons: ['OK'],
  });
}

// ---------- IPC from setup window ----------
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose your team brain folder',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const picked = result.filePaths[0];
  if (!fs.existsSync(path.join(picked, '.git'))) {
    dialog.showErrorBox('Not a git folder', `${picked} is not a git repository.\n\nThe team brain folder must be a clone from GitHub.`);
    return null;
  }
  return picked;
});

ipcMain.handle('save-config', async (_evt, config) => {
  saveConfig(config);
  // restart watcher with new config
  if (watcherProcess) {
    watcherProcess.once('exit', () => startWatcher());
    watcherProcess.kill('SIGINT');
  } else {
    startWatcher();
  }
  if (setupWindow) setupWindow.close();
  return true;
});

ipcMain.handle('get-config', () => loadConfig() || {});

// ---------- app lifecycle ----------
app.whenReady().then(() => {
  // Hide dock icon on Mac so we appear only in the menu bar.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  tray = new Tray(makeTrayIcon('stopped'));
  tray.setToolTip(APP_NAME);
  updateTray();

  // Periodic refresh so the "Last push: X ago" string ticks
  setInterval(updateTray, 15000);

  const config = loadConfig();
  if (!config || !config.brainPath) {
    showSetupWindow();
  } else {
    startWatcher();
    // Default to auto-start at login on first launch
    if (!app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    }
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit when the setup window closes; we live in the tray.
  e.preventDefault();
});

app.on('before-quit', () => {
  if (watcherProcess) {
    watcherProcess.kill('SIGINT');
  }
});
