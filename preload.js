// Preload — exposes a small, safe IPC surface to the setup window.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brainSync', {
  // Existing
  pickFolder: (opts) => ipcRenderer.invoke('pick-folder', opts || {}),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  getConfig: () => ipcRenderer.invoke('get-config'),

  // New for V1 agency-mode wizard
  getHomePath: () => ipcRenderer.invoke('get-home-path'),
  peekPendingInviteToken: () => ipcRenderer.invoke('peek-pending-invite-token'),
  consumePendingInviteToken: () => ipcRenderer.invoke('consume-pending-invite-token'),
  resolveInviteToken: (token) => ipcRenderer.invoke('resolve-invite-token', token),
  requestOtpCode: (email) => ipcRenderer.invoke('request-otp-code', email),
  verifyOtpCode: (email, code) => ipcRenderer.invoke('verify-otp-code', email, code),
  cloneAgencyBrain: (args) => ipcRenderer.invoke('clone-agency-brain', args),
  configureIdentity: (args) => ipcRenderer.invoke('configure-identity', args),
  markInstallComplete: (args) => ipcRenderer.invoke('mark-install-complete', args),
});
