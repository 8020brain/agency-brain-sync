// Preload — exposes a small, safe IPC surface to the setup window.

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // Config
  pickFolder: (opts) => ipcRenderer.invoke('pick-folder', opts || {}),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  getConfig: () => ipcRenderer.invoke('get-config'),

  // Onboarding wizard
  getHomePath: () => ipcRenderer.invoke('get-home-path'),
  peekPendingInviteToken: () => ipcRenderer.invoke('peek-pending-invite-token'),
  consumePendingInviteToken: () => ipcRenderer.invoke('consume-pending-invite-token'),
  resolveInviteToken: (token) => ipcRenderer.invoke('resolve-invite-token', token),
  cloneAgencyBrain: (args) => ipcRenderer.invoke('clone-agency-brain', args),
  configureIdentity: (args) => ipcRenderer.invoke('configure-identity', args),
  markInstallComplete: (args) => ipcRenderer.invoke('mark-install-complete', args),

  // OTP (alternative auth path, not used by the v1 wizard but kept for power users)
  requestOtpCode: (email) => ipcRenderer.invoke('request-otp-code', email),
  verifyOtpCode: (email, code) => ipcRenderer.invoke('verify-otp-code', email, code),

  // Claude desktop app detection / launch
  detectClaudeDesktop: () => ipcRenderer.invoke('detect-claude-desktop'),
  launchClaudeApp: () => ipcRenderer.invoke('launch-claude-app'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // Closing the wizard cleanly
  closeWizard: () => ipcRenderer.invoke('close-wizard'),

  // Demo-mode helper (only called when the user types the DEMO code in setup)
  seedDemoFolder: (target) => ipcRenderer.invoke('seed-demo-folder', target),
};

contextBridge.exposeInMainWorld('agencyBrain', api);
// Backwards-compat alias for the brief window where the old setup.html might
// still be cached or referenced. Safe to remove once everyone is on alpha.2+.
contextBridge.exposeInMainWorld('brainSync', api);
