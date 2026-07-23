'use strict';
/*
 * Client-side encryption for the Agency Brain vault.
 *
 * The whole point of the vault is that the agency's sensitive context is
 * encrypted BEFORE it ever leaves the laptop, and the key never leaves the
 * laptop either. The Cloudflare Worker + R2 bucket that store the blob only
 * ever see ciphertext. Decryption happens here, on the machine, in memory.
 *
 * Cipher: AES-256-GCM (authenticated — a tampered blob fails to decrypt rather
 * than returning garbage). Built entirely on Node's `crypto`, no dependency.
 *
 * Envelope layout (one self-describing binary blob):
 *
 *   offset  bytes  field
 *   0       4      magic  "BVLT"  (Brain VauLT)
 *   4       1      version (0x01)
 *   5       1      flags   (bit0 = key was derived from a passphrase via scrypt)
 *   6       1      saltLen (0 when a raw 32-byte key was supplied)
 *   7       N      salt    (present only when bit0 is set)
 *   7+N     12     iv / nonce
 *   19+N    16     GCM auth tag
 *   35+N    ...    ciphertext
 *
 * A "secret" here is EITHER a 64-hex-character raw key (32 bytes, the machine
 * default) OR a human passphrase (anything else) that gets stretched with
 * scrypt against a per-blob random salt. Both are supported so an owner can
 * choose a generated key (stronger, stored in their secrets file) or a
 * passphrase they can remember.
 */

const crypto = require('crypto');

const MAGIC = Buffer.from('BVLT', 'ascii');
const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_SALT_LEN = 16;

// A 64-char hex string is treated as a raw key; anything else is a passphrase.
function looksLikeRawKey(secret) {
  return typeof secret === 'string' && /^[0-9a-fA-F]{64}$/.test(secret.trim());
}

// Resolve a secret + optional salt into a 32-byte key. When the secret is a raw
// hex key there is no salt (returns null salt). When it is a passphrase, derive
// with scrypt; a salt is generated when encrypting and passed back in when
// decrypting.
function resolveKey(secret, salt) {
  if (secret == null || secret === '') {
    throw new Error('vault: no encryption secret supplied');
  }
  if (looksLikeRawKey(secret)) {
    return { key: Buffer.from(secret.trim(), 'hex'), salt: null, derived: false };
  }
  const useSalt = salt || crypto.randomBytes(SCRYPT_SALT_LEN);
  const key = crypto.scryptSync(Buffer.from(String(secret), 'utf8'), useSalt, KEY_LEN);
  return { key, salt: useSalt, derived: true };
}

// Generate a fresh raw key as a 64-char hex string. This is what `vault setup`
// hands the owner to store in their secrets file.
function generateKey() {
  return crypto.randomBytes(KEY_LEN).toString('hex');
}

// encrypt(Buffer, secret) -> Buffer (the envelope).
function encrypt(plaintext, secret) {
  if (!Buffer.isBuffer(plaintext)) plaintext = Buffer.from(plaintext);
  const { key, salt, derived } = resolveKey(secret);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const flags = derived ? 0x01 : 0x00;
  const saltBuf = derived ? salt : Buffer.alloc(0);
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([VERSION, flags, saltBuf.length]),
    saltBuf,
  ]);
  return Buffer.concat([header, iv, tag, ciphertext]);
}

// decrypt(Buffer envelope, secret) -> Buffer plaintext. Throws on a bad key,
// tamper, or a malformed envelope.
function decrypt(envelope, secret) {
  if (!Buffer.isBuffer(envelope)) envelope = Buffer.from(envelope);
  if (envelope.length < MAGIC.length + 3 + IV_LEN + TAG_LEN) {
    throw new Error('vault: blob is too short to be a valid vault envelope');
  }
  if (!envelope.subarray(0, 4).equals(MAGIC)) {
    throw new Error('vault: blob is not a vault envelope (bad magic)');
  }
  const version = envelope[4];
  if (version !== VERSION) {
    throw new Error(`vault: unsupported envelope version ${version}`);
  }
  const flags = envelope[5];
  const saltLen = envelope[6];
  let off = 7;
  const salt = saltLen ? envelope.subarray(off, off + saltLen) : null;
  off += saltLen;
  const iv = envelope.subarray(off, off + IV_LEN);
  off += IV_LEN;
  const tag = envelope.subarray(off, off + TAG_LEN);
  off += TAG_LEN;
  const ciphertext = envelope.subarray(off);

  const derived = (flags & 0x01) === 0x01;
  if (derived && !salt) throw new Error('vault: envelope claims a derived key but carries no salt');
  const { key } = resolveKey(secret, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    // GCM final() throws when the tag doesn't verify: wrong key OR tampered blob.
    throw new Error('vault: could not decrypt (wrong key, or the blob was tampered with)');
  }
}

module.exports = { encrypt, decrypt, generateKey, looksLikeRawKey, MAGIC, VERSION };
