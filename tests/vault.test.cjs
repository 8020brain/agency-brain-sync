#!/usr/bin/env node
'use strict';
/*
 * Vault engine tests — crypto, bundling, config tiering, and the full
 * push -> scrub -> pull cycle through an in-memory transport. No network, no
 * mocks of our own code, no Electron. Safe to run any time; tears itself down.
 *
 *   node tests/vault.test.cjs
 *
 * Matches the repo's test philosophy: exercise the REAL modules against
 * throwaway files in a temp dir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const crypto = require('../lib/vault/crypto.cjs');
const bundle = require('../lib/vault/bundle.cjs');
const cfg = require('../lib/vault/config.cjs');
const vault = require('../lib/vault/vault.cjs');
const { memoryTransport } = require('../lib/vault/transport.cjs');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok   ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
function eq(name, a, b) { (a === b) ? ok(name) : bad(name, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function throws(name, fn) { try { fn(); bad(name, 'did not throw'); } catch (_) { ok(name); } }
async function throwsAsync(name, fn) { try { await fn(); bad(name, 'did not throw'); } catch (_) { ok(name); } }

function mkbrain() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-vault-'));
  const w = (rel, content) => {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  return { root, w };
}

async function main() {
  // ---- crypto --------------------------------------------------------------
  {
    const key = crypto.generateKey();
    eq('generateKey is 64 hex chars', /^[0-9a-f]{64}$/.test(key), true);

    const plain = Buffer.from('client-confidential context \u{1F510} with unicode');
    const blob = crypto.encrypt(plain, key);
    eq('raw-key round trip', crypto.decrypt(blob, key).equals(plain), true);

    const pass1 = crypto.encrypt(plain, 'a human passphrase');
    eq('passphrase round trip', crypto.decrypt(pass1, 'a human passphrase').equals(plain), true);

    throws('wrong raw key fails', () => crypto.decrypt(blob, crypto.generateKey()));
    throws('wrong passphrase fails', () => crypto.decrypt(pass1, 'not the passphrase'));

    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff; // flip a ciphertext byte
    throws('tampered blob fails auth', () => crypto.decrypt(tampered, key));

    throws('non-vault blob rejected', () => crypto.decrypt(Buffer.from('not a vault blob at all'), key));
  }

  // ---- bundle --------------------------------------------------------------
  {
    const { root, w } = mkbrain();
    w('context/notes.md', '# secret notes\nclient stuff');
    w('customers/acme/facts.md', 'acme is a client');
    w('customers/acme/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])); // fake PNG (binary)
    w('data/big.md', Buffer.alloc(6 * 1024 * 1024, 0x61)); // 6 MB, over the 5 MB cap
    w('data/small.csv', 'a,b\n1,2');

    const { files, skipped } = bundle.collectFiles(root, ['context', 'customers', 'data']);
    eq('collect picks text files', files.includes('context/notes.md') && files.includes('customers/acme/facts.md') && files.includes('data/small.csv'), true);
    eq('collect skips binary', skipped.some((s) => s.rel === 'customers/acme/logo.png'), true);
    eq('collect skips oversized', skipped.some((s) => s.rel === 'data/big.md'), true);
    eq('binary not vaulted', files.includes('customers/acme/logo.png'), false);

    const packed = bundle.pack(root, files);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-vault-out-'));
    const written = bundle.unpack(packed, dest);
    eq('unpack writes every file', written.length, files.length);
    eq('unpack reproduces content', fs.readFileSync(path.join(dest, 'context', 'notes.md'), 'utf8'), '# secret notes\nclient stuff');

    // path-traversal defence
    const evilGz = zlib.gzipSync(Buffer.from(JSON.stringify({
      v: bundle.MANIFEST_VERSION,
      files: [{ p: '../escape.txt', d: Buffer.from('x').toString('base64') }],
    })));
    throws('unpack rejects path traversal', () => bundle.unpack(evilGz, dest));

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }

  // ---- config --------------------------------------------------------------
  {
    const { root, w } = mkbrain();
    const def = cfg.loadSecurityConfig(root);
    eq('default posture is local', def.config.posture, 'local');
    eq('default not marked existing', def.exists, false);
    eq('sensitive tier includes customers', cfg.resolveSensitivePaths(def.config).includes('customers'), true);

    w('.brain-security.json', JSON.stringify({ posture: 'vault', tiers: { sensitive: ['context', 'secretstuff'] } }));
    const custom = cfg.loadSecurityConfig(root);
    eq('custom posture read', custom.config.posture, 'vault');
    eq('custom sensitive tier read', cfg.resolveSensitivePaths(custom.config).join(','), 'context,secretstuff');
    eq('custom marked existing', custom.exists, true);

    w('.brain-security.json', JSON.stringify({ posture: 'nonsense' }));
    throws('bad posture rejected', () => cfg.loadSecurityConfig(root));

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---- full cycle through an in-memory transport ---------------------------
  {
    const { root, w } = mkbrain();
    w('.brain-security.json', JSON.stringify({ posture: 'vault' }));
    w('context/profile.md', 'confidential profile');
    w('customers/acme/facts.md', 'acme facts');
    w('customers/acme/photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0, 9, 9])); // binary, stays local
    w('research/public.md', 'not sensitive'); // not in sensitive tier

    const key = crypto.generateKey();
    const transport = memoryTransport();
    const opts = { secrets: { key }, transport };

    const pushed = await vault.push(root, opts);
    eq('push reports the two text files', pushed.files, 2);
    eq('push left the binary local', pushed.skipped.some((s) => s.rel === 'customers/acme/photo.jpg'), true);
    eq('blob is in the store', transport._store.has('brain-vault.bin'), true);

    // The store holds ciphertext, not plaintext.
    const stored = transport._store.get('brain-vault.bin');
    eq('stored blob is a vault envelope', stored.subarray(0, 4).toString(), 'BVLT');
    eq('stored blob does not contain plaintext', stored.toString('latin1').includes('confidential profile'), false);

    // scrub: removes only the vaulted plaintext, keeps local binary + public file.
    const scrubbed = await vault.scrub(root, opts);
    eq('scrub removed the two files', scrubbed.removed, 2);
    eq('vaulted plaintext gone from disk', fs.existsSync(path.join(root, 'context', 'profile.md')), false);
    eq('local binary untouched', fs.existsSync(path.join(root, 'customers', 'acme', 'photo.jpg')), true);
    eq('public file untouched', fs.existsSync(path.join(root, 'research', 'public.md')), true);

    // pull: restores the plaintext byte-for-byte.
    const pulled = await vault.pull(root, opts);
    eq('pull restored two files', pulled.files, 2);
    eq('restored content matches', fs.readFileSync(path.join(root, 'context', 'profile.md'), 'utf8'), 'confidential profile');
    eq('restored nested file matches', fs.readFileSync(path.join(root, 'customers', 'acme', 'facts.md'), 'utf8'), 'acme facts');

    // status reports the vault when it can probe it.
    const st = await vault.status(root, { secrets: { key, workerUrl: 'https://x', token: 'y' }, transport });
    eq('status posture', st.posture, 'vault');
    eq('status secrets presence only', st.secrets.key, 'set');
    eq('status vault file count', st.vault.files, 2);

    // scrub refuses when the vault is empty (no accidental deletion).
    const empty = memoryTransport();
    const refused = await vault.scrub(root, { secrets: { key }, transport: empty });
    eq('scrub refuses on empty vault', refused.refused, true);
    eq('files survive a refused scrub', fs.existsSync(path.join(root, 'context', 'profile.md')), true);

    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
