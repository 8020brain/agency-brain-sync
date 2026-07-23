'use strict';
/*
 * Resolving the three vault secrets — WITHOUT ever printing them.
 *
 *   workerUrl  the owner's own Cloudflare Worker endpoint (not really secret,
 *              but kept out of git so the committed .brain-security.json never
 *              names a live endpoint)
 *   token      the bearer token the Worker checks (revoke = rotate this)
 *   key        the AES-256 key / passphrase used to encrypt the bundle
 *
 * These live ONLY in a gitignored secrets file or in env vars, never in the
 * committed config and never in this app repo. This module resolves them and
 * hands back the values for use in code; it deliberately exposes a `describe()`
 * that returns presence booleans only, so a caller can report state without a
 * secret ever reaching stdout / a session log.
 *
 * Resolution order (first hit wins, per field):
 *   1. explicit opts passed by the caller
 *   2. env vars: VAULT_WORKER_URL, VAULT_TOKEN, VAULT_KEY
 *   3. secrets file (JSON: { workerUrl, token, key }), searched at:
 *        - $VAULT_SECRETS_FILE
 *        - <brainRoot>/.vault/secret.json
 *        - ~/.brain-secrets/agency-vault.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function secretsFileCandidates(root) {
  const list = [];
  if (process.env.VAULT_SECRETS_FILE) list.push(process.env.VAULT_SECRETS_FILE);
  if (root) list.push(path.join(root, '.vault', 'secret.json'));
  list.push(path.join(os.homedir(), '.brain-secrets', 'agency-vault.json'));
  return list;
}

function readSecretsFile(root) {
  for (const p of secretsFileCandidates(root)) {
    try {
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { from: p, data: j };
      }
    } catch (_) { /* try next */ }
  }
  return { from: null, data: {} };
}

function resolveSecrets(root, opts = {}) {
  const file = readSecretsFile(root);
  const d = file.data || {};
  return {
    workerUrl: opts.workerUrl || process.env.VAULT_WORKER_URL || d.workerUrl || null,
    token: opts.token || process.env.VAULT_TOKEN || d.token || null,
    key: opts.key || process.env.VAULT_KEY || d.key || null,
    source: file.from,
  };
}

// Presence-only view, safe to print. NEVER returns the values themselves.
function describe(secrets) {
  return {
    workerUrl: secrets.workerUrl ? 'set' : 'missing',
    token: secrets.token ? 'set' : 'missing',
    key: secrets.key ? 'set' : 'missing',
    source: secrets.source || '(none found)',
  };
}

// Write a secrets file (used by `vault setup`). Defaults to <root>/.vault/secret.json.
function writeSecretsFile(root, data, target) {
  const p = target || path.join(root, '.vault', 'secret.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (_) {}
  return p;
}

module.exports = { resolveSecrets, describe, writeSecretsFile, secretsFileCandidates };
