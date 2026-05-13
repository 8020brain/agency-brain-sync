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
const { spawn, execFile } = require('child_process');

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
    width: 620,
    height: 760,
    resizable: true,
    minWidth: 520,
    minHeight: 600,
    minimizable: true,
    maximizable: false,
    title: APP_NAME,
    backgroundColor: '#fafaf8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  setupWindow.loadFile(path.join(__dirname, 'src', 'setup.html'));
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

ipcMain.handle('clone-agency-brain', async (_evt, args) => {
  const { memberToken, teamSlug, repoUrl, targetFolder } = args;
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

function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { env: process.env, maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
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
app.on('before-quit', () => { if (watcherProcess) watcherProcess.kill('SIGINT'); });
