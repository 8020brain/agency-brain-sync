'use strict';
/*
 * The vault engine: push / pull / status / scrub.
 *
 * Life cycle of the sensitive slice of an agency brain:
 *   push   collect the sensitive text -> pack (gzip) -> encrypt (client-side)
 *          -> upload ONE blob to the owner's R2 via their Worker.
 *   scrub  delete the local plaintext of exactly the files that are in the
 *          vault (proven safe), leaving only the encrypted blob at rest.
 *   pull   download the blob -> decrypt in memory -> write the plaintext files
 *          back for the session. Run at session start.
 *
 * Between sessions: only the encrypted blob exists (in the owner's own cloud),
 * plus the non-sensitive media that always stayed on the laptop. Revoke by
 * rotating the Worker token; the blob then can't be fetched or decrypted by a
 * departed teammate.
 *
 * Every function takes an injectable `transport` so the whole cycle is testable
 * offline. When omitted, the HTTP Worker transport is built from the secrets.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('./crypto.cjs');
const bundle = require('./bundle.cjs');
const cfg = require('./config.cjs');
const secretsMod = require('./secrets.cjs');
const { httpTransport } = require('./transport.cjs');

function resolveTransport(secrets, opts) {
  if (opts && opts.transport) return opts.transport;
  return httpTransport({ workerUrl: secrets.workerUrl, token: secrets.token });
}

function load(root, opts = {}) {
  const { config } = cfg.loadSecurityConfig(root);
  const secrets = secretsMod.resolveSecrets(root, opts.secrets || {});
  return { config, secrets };
}

// push: bundle + encrypt + upload. Optionally scrub the local plaintext after a
// verified upload (opts.scrub).
async function push(root, opts = {}) {
  const { config, secrets } = load(root, opts);
  if (!secrets.key) throw new Error('vault: no encryption key — run `vault setup` first');
  const include = cfg.resolveSensitivePaths(config);
  const { files, skipped, bytes } = bundle.collectFiles(root, include);
  const packed = bundle.pack(root, files);
  const blob = crypto.encrypt(packed, secrets.key);
  const transport = resolveTransport(secrets, opts);
  await transport.put(config.object, blob);

  const result = { files: files.length, sourceBytes: bytes, blobBytes: blob.length, skipped, scrubbed: 0 };
  if (opts.scrub) {
    const removed = removeLocal(root, files);
    result.scrubbed = removed.length;
  }
  return result;
}

// pull: download + decrypt + write files back. Safe to call when the vault is
// empty (returns { empty: true }).
async function pull(root, opts = {}) {
  const { config, secrets } = load(root, opts);
  if (!secrets.key) throw new Error('vault: no encryption key — run `vault setup` first');
  const transport = resolveTransport(secrets, opts);
  const blob = await transport.get(config.object);
  if (!blob) return { empty: true, files: 0 };
  const packed = crypto.decrypt(blob, secrets.key);
  const written = bundle.unpack(packed, root);
  const meta = bundle.listBundle(packed);
  return { empty: false, files: written.length, createdAt: meta.createdAt };
}

// scrub: delete the local plaintext of exactly the files currently in the vault.
// It fetches the vault first and only removes files that are provably stored, so
// it can never delete something that isn't safely backed up. No blob => refuses.
async function scrub(root, opts = {}) {
  const { config, secrets } = load(root, opts);
  if (!secrets.key) throw new Error('vault: no encryption key — run `vault setup` first');
  const transport = resolveTransport(secrets, opts);
  const blob = await transport.get(config.object);
  if (!blob) return { refused: true, reason: 'vault is empty — nothing is safely stored, so nothing was deleted', removed: 0 };
  const packed = crypto.decrypt(blob, secrets.key); // also proves the key is right
  const { files } = bundle.listBundle(packed);
  const removed = removeLocal(root, files);
  pruneEmptyDirs(root, cfg.resolveSensitivePaths(config));
  return { refused: false, removed: removed.length };
}

// status: a full, secret-free picture of where things stand.
async function status(root, opts = {}) {
  const { config, exists } = cfg.loadSecurityConfig(root);
  const secrets = secretsMod.resolveSecrets(root, (opts.secrets || {}));
  const include = cfg.resolveSensitivePaths(config);
  const local = bundle.collectFiles(root, include);
  const out = {
    posture: config.posture,
    configExists: exists,
    object: config.object,
    sensitiveFolders: include,
    localSensitiveFiles: local.files.length,
    localSensitiveBytes: local.bytes,
    skippedLocal: local.skipped.length,
    secrets: secretsMod.describe(secrets),
    vault: null,
  };
  // Only probe the vault if we have the means to (and weren't told to skip it).
  if (!opts.offline && secrets.workerUrl && secrets.token && secrets.key) {
    try {
      const transport = resolveTransport(secrets, opts);
      const blob = await transport.get(config.object);
      if (!blob) {
        out.vault = { exists: false };
      } else {
        const packed = crypto.decrypt(blob, secrets.key);
        const meta = bundle.listBundle(packed);
        out.vault = { exists: true, files: meta.files.length, createdAt: meta.createdAt, blobBytes: blob.length };
      }
    } catch (e) {
      out.vault = { error: e.message };
    }
  }
  return out;
}

// ---- local filesystem helpers -------------------------------------------

function removeLocal(root, relFiles) {
  const removed = [];
  for (const rel of relFiles) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    try {
      if (fs.existsSync(abs)) { fs.unlinkSync(abs); removed.push(rel); }
    } catch (_) { /* leave it; report count only */ }
  }
  return removed;
}

// Remove directories left empty after a scrub, but never the sensitive-tier
// roots themselves and never the brain root.
function pruneEmptyDirs(root, tierRoots) {
  const rootsAbs = new Set(tierRoots.map((t) => path.join(root, t.split('/').join(path.sep))));
  function walkPrune(absDir) {
    let entries;
    try { entries = fs.readdirSync(absDir); } catch (_) { return; }
    for (const name of entries) {
      const abs = path.join(absDir, name);
      let st;
      try { st = fs.lstatSync(abs); } catch (_) { continue; }
      if (st.isDirectory()) walkPrune(abs);
    }
    try {
      if (fs.readdirSync(absDir).length === 0 && absDir !== root && !rootsAbs.has(absDir)) {
        fs.rmdirSync(absDir);
      }
    } catch (_) {}
  }
  for (const t of tierRoots) {
    const abs = path.join(root, t.split('/').join(path.sep));
    if (fs.existsSync(abs)) walkPrune(abs);
  }
}

module.exports = { push, pull, scrub, status, removeLocal, pruneEmptyDirs };
