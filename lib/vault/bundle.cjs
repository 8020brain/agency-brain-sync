'use strict';
/*
 * Bundling for the Agency Brain vault.
 *
 * The vault stores ONE blob, not a file per object, because the speed test
 * showed per-file fetches don't scale (~110 ms each). So we pack every
 * sensitive text file into a single gzipped manifest, which then gets
 * encrypted (crypto.cjs) and pushed as one object.
 *
 * What goes in: text files (markdown, json, csv, yaml, html, txt, ...) under a
 * size cap. What stays on the laptop: binaries and oversized media. Those are
 * NOT confidential text (the sensitive slice is ~14 MB of markdown, the bulk of
 * the brain is non-sensitive media), so they're left in place and reported so
 * the owner can see exactly what the vault does and does not cover.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MANIFEST_VERSION = 1;

// Default cap: a single file bigger than this is treated as media and left
// local. 5 MB comfortably clears any markdown/CSV while excluding video/audio.
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

// Text file extensions we vault. Everything else is treated as binary/media and
// left on disk (still reported).
const DEFAULT_TEXT_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.tsv',
  '.yaml', '.yml', '.html', '.htm', '.xml', '.js', '.cjs', '.mjs',
  '.ts', '.tsx', '.css', '.sql', '.env.example', '.gitignore', '.sh',
];

// Directory names never walked into, regardless of config.
const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules']);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function hasTextExtension(rel, textExtensions) {
  const lower = rel.toLowerCase();
  return textExtensions.some((ext) => lower.endsWith(ext));
}

// Cheap binary sniff for extensionless files: a NUL byte in the first 8 KB is a
// reliable "this is binary" signal for our purposes.
function looksBinary(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch (_) {
    return true; // unreadable -> don't try to vault it
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

/*
 * collectFiles(root, includePaths, opts)
 *   root         absolute brain root
 *   includePaths array of repo-relative folders/files to consider sensitive
 *   opts.maxFileBytes, opts.textExtensions
 *
 * Returns { files: [rel...], skipped: [{ rel, size, reason }], bytes }
 * `files` are the relative paths that will be vaulted; `skipped` records what
 * was deliberately left on disk and why.
 */
function collectFiles(root, includePaths, opts = {}) {
  const maxFileBytes = opts.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const textExtensions = opts.textExtensions || DEFAULT_TEXT_EXTENSIONS;
  const files = [];
  const skipped = [];
  let bytes = 0;
  const seen = new Set();

  function consider(absFile, rel) {
    if (seen.has(rel)) return;
    seen.add(rel);
    let st;
    try { st = fs.lstatSync(absFile); } catch (_) { return; }
    if (st.isSymbolicLink()) { skipped.push({ rel, size: 0, reason: 'symlink' }); return; }
    if (!st.isFile()) return;
    const isText = hasTextExtension(rel, textExtensions) || (path.extname(rel) === '' && !looksBinary(absFile));
    if (!isText) { skipped.push({ rel, size: st.size, reason: 'binary/media (stays local)' }); return; }
    if (st.size > maxFileBytes) { skipped.push({ rel, size: st.size, reason: 'over size cap (stays local)' }); return; }
    files.push(rel);
    bytes += st.size;
  }

  function walk(absDir, relDir) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) { continue; }
      const abs = path.join(absDir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(ent.name)) continue;
        walk(abs, rel);
      } else if (ent.isFile()) {
        consider(abs, rel);
      }
    }
  }

  for (const inc of includePaths) {
    const abs = path.join(root, inc);
    let st;
    try { st = fs.lstatSync(abs); } catch (_) { continue; } // configured path may not exist in this brain
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(abs, toPosix(inc));
    else if (st.isFile()) consider(abs, toPosix(inc));
  }

  files.sort();
  return { files, skipped, bytes };
}

// pack(root, relPaths) -> Buffer (gzipped manifest). base64 keeps it binary-safe;
// gzip claws the base64 overhead back on text.
function pack(root, relPaths) {
  const manifest = { v: MANIFEST_VERSION, createdAt: new Date().toISOString(), files: [] };
  for (const rel of relPaths) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    let data;
    try { data = fs.readFileSync(abs); } catch (_) { continue; }
    manifest.files.push({ p: rel, d: data.toString('base64') });
  }
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  return zlib.gzipSync(json, { level: 9 });
}

// unpack(gzBuffer, destRoot, opts) -> [rel...] written. Refuses any path that
// escapes destRoot (defence against a tampered manifest).
function unpack(gzBuffer, destRoot, opts = {}) {
  const json = zlib.gunzipSync(gzBuffer);
  const manifest = JSON.parse(json.toString('utf8'));
  if (!manifest || manifest.v !== MANIFEST_VERSION || !Array.isArray(manifest.files)) {
    throw new Error('vault: unrecognised bundle manifest');
  }
  const written = [];
  const rootResolved = path.resolve(destRoot);
  for (const f of manifest.files) {
    const rel = String(f.p || '');
    const abs = path.resolve(destRoot, rel.split('/').join(path.sep));
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
      throw new Error(`vault: bundle entry escapes the brain root: ${rel}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(f.d, 'base64'));
    written.push(rel);
    if (typeof opts.onFile === 'function') opts.onFile(rel);
  }
  return written;
}

// Read the file list out of a bundle without writing anything (used by status).
function listBundle(gzBuffer) {
  const manifest = JSON.parse(zlib.gunzipSync(gzBuffer).toString('utf8'));
  return { createdAt: manifest.createdAt, files: (manifest.files || []).map((f) => f.p) };
}

module.exports = {
  collectFiles, pack, unpack, listBundle,
  DEFAULT_MAX_FILE_BYTES, DEFAULT_TEXT_EXTENSIONS, MANIFEST_VERSION,
};
