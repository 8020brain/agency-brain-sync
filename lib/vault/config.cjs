'use strict';
/*
 * Security config for the Agency Brain vault.
 *
 * `.brain-security.json` lives at the root of the AGENCY'S OWN brain repo (not
 * this app repo). It is safe to commit: it holds the posture, the per-folder
 * sensitivity tiers, and which bundle object to use — but NEVER the vault URL,
 * bearer token, or encryption key. Those three live only in the gitignored
 * secrets file (see cli.cjs / secrets.cjs) so nothing that grants access ever
 * lands in git.
 *
 * The config is what actually drives behaviour; any UI (Command Centre presets,
 * a checkbox editor) is just a friendlier way to write this file.
 *
 * Default tiering comes from the folder-sensitivity map in
 * projects/agencybrain/security/. The confidential *text* is ~18% of the brain
 * (~14 MB), so only the "sensitive" tier is vaulted by default; internal IP and
 * public folders stay on the laptop.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = '.brain-security.json';
const CONFIG_VERSION = 1;

const POSTURES = ['local', 'cloud', 'vault'];

// The shipped default. An owner can tweak any of this (move a folder between
// tiers, change the posture) via a throwaway checkbox editor or by hand.
const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  // "local"  = plaintext in the synced repo, FileVault only (today's default)
  // "cloud"  = sensitive folders live in a Google Drive / Dropbox synced folder
  // "vault"  = sensitive folders move out of git into the agency's own encrypted R2
  posture: 'local',
  tiers: {
    // Vaulted when posture === 'vault'. Client-confidential.
    sensitive: ['context', 'customers', 'clients', 'data', 'auth', 'z-logs'],
    // Your own work, not client-confidential. Stays local by default.
    internal: ['projects', '.claude', 'tools'],
    // Public / low sensitivity. Always fine on the laptop.
    // (z-archive may hold OLD client data — review it, hence the note below.)
    public: ['research', 'content', 'images', 'testing', 'z-archive'],
  },
  // The single object name the encrypted bundle is stored under in R2.
  object: 'brain-vault.bin',
  // Claude Code (scouts) can scrub the plaintext working copy at session end.
  // Cowork cannot (no hooks), so this is best-effort there. See README.
  scrubOnExit: true,
  notes: 'z-archive may hold old client data — review it before deciding its tier.',
};

function deepMerge(base, over) {
  if (over == null) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function validate(config) {
  if (!POSTURES.includes(config.posture)) {
    throw new Error(`vault: unknown posture "${config.posture}" (expected one of ${POSTURES.join(', ')})`);
  }
  if (!config.tiers || !Array.isArray(config.tiers.sensitive)) {
    throw new Error('vault: config.tiers.sensitive must be an array of folder names');
  }
  return config;
}

// loadSecurityConfig(root) -> { config, exists, path }
// Missing file is not an error: it just means the shipped default (posture
// "local" — nothing to do). A malformed file IS an error (fail loud, don't
// silently drop the owner's security intent).
function loadSecurityConfig(root) {
  const p = path.join(root, CONFIG_FILENAME);
  if (!fs.existsSync(p)) {
    return { config: validate({ ...DEFAULT_CONFIG }), exists: false, path: p };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`vault: ${CONFIG_FILENAME} is not valid JSON — ${e.message}`);
  }
  const merged = deepMerge(DEFAULT_CONFIG, raw);
  return { config: validate(merged), exists: true, path: p };
}

function writeSecurityConfig(root, config) {
  const p = path.join(root, CONFIG_FILENAME);
  validate(config);
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
  return p;
}

// The folders whose text gets vaulted. For now that's exactly the "sensitive"
// tier; kept as a function so a future config can express per-file overrides.
function resolveSensitivePaths(config) {
  return [...(config.tiers.sensitive || [])];
}

module.exports = {
  DEFAULT_CONFIG,
  CONFIG_FILENAME,
  CONFIG_VERSION,
  POSTURES,
  loadSecurityConfig,
  writeSecurityConfig,
  resolveSensitivePaths,
  validate,
};
