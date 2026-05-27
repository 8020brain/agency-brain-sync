// Preload — exposes a small, safe IPC surface to the setup window.

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // Config
  pickFolder: (opts) => ipcRenderer.invoke('pick-folder', opts || {}),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  getConfig: () => ipcRenderer.invoke('get-config'),

  // Onboarding wizard
  getHomePath: () => ipcRenderer.invoke('get-home-path'),
  getDefaultFolder: () => ipcRenderer.invoke('get-default-folder'),
  resolveTargetFolder: (picked) => ipcRenderer.invoke('resolve-target-folder', picked),
  peekPendingInviteToken: () => ipcRenderer.invoke('peek-pending-invite-token'),
  consumePendingInviteToken: () => ipcRenderer.invoke('consume-pending-invite-token'),
  resolveInviteToken: (token) => ipcRenderer.invoke('resolve-invite-token', token),
  cloneAgencyBrain: (args) => ipcRenderer.invoke('clone-agency-brain', args),
  // Adopt flow (Phase 1): read-only inspection of a brain folder the member
  // already has, so the wizard can show its state before anything is written.
  inspectBrainFolder: (folder) => ipcRenderer.invoke('inspect-brain-folder', folder),
  // Adopt flow (Phase 2): the controlled first sync that brings an existing
  // brain under the app. Resolves before any config is saved / watcher started.
  adoptExistingBrain: (args) => ipcRenderer.invoke('adopt-existing-brain', args),
  configureIdentity: (args) => ipcRenderer.invoke('configure-identity', args),
  markInstallComplete: (args) => ipcRenderer.invoke('mark-install-complete', args),

  // Email + OTP first-run: enter email -> request code -> verify -> look up
  // which agency the email belongs to -> clone. The primary onboarding path.
  requestOtpCode: (email) => ipcRenderer.invoke('request-otp-code', email),
  verifyOtpCode: (email, code) => ipcRenderer.invoke('verify-otp-code', email, code),
  listMyTeams: (token) => ipcRenderer.invoke('list-my-teams', token),

  // Claude desktop app detection / launch
  detectClaudeDesktop: () => ipcRenderer.invoke('detect-claude-desktop'),
  launchClaudeApp: () => ipcRenderer.invoke('launch-claude-app'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // Closing the wizard cleanly
  closeWizard: () => ipcRenderer.invoke('close-wizard'),

  // Demo-mode helper (only called when the user types the DEMO code in setup)
  seedDemoFolder: (target) => ipcRenderer.invoke('seed-demo-folder', target),

  // ---- Merged-app surface (new wizard renderer; Brain 3.0 ported screens) ----
  // Electron equivalents of Brain 3.0's Tauri commands. Additive — the old
  // setup.html never calls these.
  detectMachine: () => ipcRenderer.invoke('detect-machine'),
  getBrainHome: () => ipcRenderer.invoke('get-brain-home'),
  cloneInto: (args) => ipcRenderer.invoke('clone-into', args),
  cloneSoloBrain: (args) => ipcRenderer.invoke('clone-solo-brain', args),
  runNpmInstall: (args) => ipcRenderer.invoke('run-npm-install', args),
  writeBusinessContext: (args) => ipcRenderer.invoke('write-business-context', args),
  // Loads the embedded Command Centre into the app window (post-onboarding home).
  openCommandCentre: () => ipcRenderer.invoke('open-command-centre'),
  // Sign out: clears the member token + team identity, stops the watcher, and
  // returns to the setup wizard. The tray process keeps running.
  signOut: () => ipcRenderer.invoke('sign-out'),
  // Auto-update: ask if a build is already downloaded + waiting, subscribe to
  // the "downloaded" event, and trigger the relaunch-and-install.
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  onUpdateDownloaded: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('update-downloaded', handler);
    return () => ipcRenderer.removeListener('update-downloaded', handler);
  },
  installUpdate: () => ipcRenderer.invoke('install-update'),
  // Progress events from clone/npm steps. Returns an unsubscribe fn. This is
  // the Electron equivalent of Brain 3.0's listen("clone-log").
  onWizardLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('wizard-log', handler);
    return () => ipcRenderer.removeListener('wizard-log', handler);
  },
};

contextBridge.exposeInMainWorld('agencyBrain', api);
// Backwards-compat alias for the brief window where the old setup.html might
// still be cached or referenced. Safe to remove once everyone is on alpha.2+.
contextBridge.exposeInMainWorld('brainSync', api);
