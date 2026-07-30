// Preload — exposes a small, safe IPC surface to the setup window.

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // Config
  pickFolder: (opts) => ipcRenderer.invoke('pick-folder', opts || {}),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  getConfig: () => ipcRenderer.invoke('get-config'),

  // Onboarding wizard
  getHomePath: () => ipcRenderer.invoke('get-home-path'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getDefaultFolder: (folderSlug) => ipcRenderer.invoke('get-default-folder', folderSlug),
  resolveTargetFolder: (picked, folderSlug) => ipcRenderer.invoke('resolve-target-folder', picked, folderSlug),
  peekPendingInviteToken: () => ipcRenderer.invoke('peek-pending-invite-token'),
  consumePendingInviteToken: () => ipcRenderer.invoke('consume-pending-invite-token'),
  resolveInviteToken: (token) => ipcRenderer.invoke('resolve-invite-token', token),
  cloneAgencyBrain: (args) => ipcRenderer.invoke('clone-agency-brain', args),
  // ClientBrain: the client brain's white-label record (brand name, colours).
  // Args: { memberToken, teamSlug }. Wizard stores brandName in config.
  fetchClientConfig: (args) => ipcRenderer.invoke('fetch-client-config', args),
  // Adopt flow (Phase 1): read-only inspection of a brain folder the member
  // already has, so the wizard can show its state before anything is written.
  inspectBrainFolder: (folder) => ipcRenderer.invoke('inspect-brain-folder', folder),
  // Adopt flow (Phase 2): the controlled first sync that brings an existing
  // brain under the app. Resolves before any config is saved / watcher started.
  adoptExistingBrain: (args) => ipcRenderer.invoke('adopt-existing-brain', args),
  configureIdentity: (args) => ipcRenderer.invoke('configure-identity', args),
  markInstallComplete: (args) => ipcRenderer.invoke('mark-install-complete', args),
  getInstallStatus: (teamSlug) => ipcRenderer.invoke('get-install-status', teamSlug),
  // Finish setup once GitHub is connected: the server creates the brain repo
  // (or adopts the right existing one) and tells us plainly when it can't.
  ensureBrainRepo: (token, teamSlug) => ipcRenderer.invoke('ensure-brain-repo', token, teamSlug),
  // Verify a GitHub organisation name before sending anyone to GitHub. Returns
  // { ok, reason, login, id, type } — see the handler in main.js.
  lookupGithubAccount: (login) => ipcRenderer.invoke('github-account-lookup', login),
  setTeamRepoUrl: (token, teamSlug, repoUrl) => ipcRenderer.invoke('set-team-repo-url', token, teamSlug, repoUrl),

  // Email + OTP first-run: enter email -> request code -> verify -> look up
  // which agency the email belongs to -> clone. The primary onboarding path.
  requestOtpCode: (email) => ipcRenderer.invoke('request-otp-code', email),
  verifyOtpCode: (email, code) => ipcRenderer.invoke('verify-otp-code', email, code),
  listMyTeams: (token) => ipcRenderer.invoke('list-my-teams', token),
  // Create the agency team in-app (member with no team yet): the "Name your
  // agency" wizard scene. Owner flow only — server derives the slug from name.
  createTeam: (token, name) => ipcRenderer.invoke('create-team', token, name),

  // Claude desktop app detection / launch
  detectClaudeDesktop: () => ipcRenderer.invoke('detect-claude-desktop'),
  launchClaudeApp: () => ipcRenderer.invoke('launch-claude-app'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // Closing the wizard cleanly
  closeWizard: () => ipcRenderer.invoke('close-wizard'),

  // Demo-mode helper (only called when the user types the DEMO code in setup)
  seedDemoFolder: (target) => ipcRenderer.invoke('seed-demo-folder', target),

  // ---- Merged-app surface (wizard renderer; Brain 3.0 ported screens) ----
  // Electron equivalents of Brain 3.0's Tauri commands.
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
  // Phase 4 solo->team: flip an existing personal-mode brain into agency mode in
  // place (no re-clone) once the member has self-created their team + installed
  // the GitHub App in the app's setup wizard. Args: { memberToken, teamSlug }.
  flipToAgency: (args) => ipcRenderer.invoke('flip-to-agency', args),
  // Auto-update: ask if a build is already downloaded + waiting, subscribe to
  // the "downloaded" event, and trigger the relaunch-and-install.
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  onUpdateDownloaded: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('update-downloaded', handler);
    return () => ipcRenderer.removeListener('update-downloaded', handler);
  },
  installUpdate: () => ipcRenderer.invoke('install-update'),
  // Cancel the 5-minute auto-install countdown; the update then installs on
  // the next natural quit/restart instead.
  delayUpdate: () => ipcRenderer.invoke('delay-update'),
  // Progress events from clone/npm steps. Returns an unsubscribe fn. This is
  // the Electron equivalent of Brain 3.0's listen("clone-log").
  onWizardLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('wizard-log', handler);
    return () => ipcRenderer.removeListener('wizard-log', handler);
  },
};

contextBridge.exposeInMainWorld('agencyBrain', api);
// Backwards-compat alias from the old setup renderer. That file is gone, but
// the alias is free and removing it is a separate, riskier change.
contextBridge.exposeInMainWorld('brainSync', api);
