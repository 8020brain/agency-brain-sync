/*
 * Ads portal local data source — serves the synced Google Ads CSVs to the
 * members portal (m.ads2ai.com) over loopback, speaking the SAME ?action=
 * protocol as the MCC Apps Script web app, so the portal's existing fetchers
 * (8020members src/features/ads/lib/data-fetcher.ts) work against it
 * unchanged. Read-only by design: every route is GET, nothing here writes.
 *
 * Repo layout served (same layout the portal's brain-source.ts reads over
 * the GitHub Contents API):
 *   <dataFolder>/map.json                   account map {folderKey: {cid, name, ...}}
 *   <dataFolder>/<folderKey>/data/<tab>.csv one CSV per portal tab
 *   <dataFolder>/_mcc/<name>.json           master-level files (dashboard, summary, ...)
 *
 * CORS: only the portal origin may read cross-origin. The OPTIONS preflight
 * answers Access-Control-Allow-Private-Network for Chromium's PNA check.
 * Safari blocks HTTPS→http://127.0.0.1 outright (mixed content, verified
 * 2026-07-22) — the portal detects that instantly and falls back.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PORTAL_ORIGINS = new Set(['https://m.ads2ai.com']);

// tab / master-file names must be single path-safe tokens (they become part
// of a filename under the data folder — this is the traversal control).
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// CSV parsing — ported from the portal's brain-source.ts so a CSV parsed here
// yields byte-for-byte the same rows the GitHub source produces client-side.
// ---------------------------------------------------------------------------

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function maybeNumber(val) {
  if (val === '') return val;
  if (/^\d{4}-\d{2}/.test(val)) return val; // date
  if (/^0\d/.test(val) && val.length > 1) return val; // leading zero (CIDs)
  const num = Number(val);
  if (!isNaN(num) && val !== '') return num;
  return val;
}

function parseCSV(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = maybeNumber(values[j] != null ? values[j] : '');
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Repo layout discovery + reads
// ---------------------------------------------------------------------------

/**
 * Find the folder holding map.json. "clients" is the layout every current
 * fetch pipeline writes; "data/ads" is where the consolidated ads-data plan
 * generates future layouts. Falls back to scanning top-level dirs so a scout
 * who renamed the folder still works.
 */
function findDataFolder(brainRoot) {
  const candidates = ['clients', path.join('data', 'ads')];
  for (const c of candidates) {
    if (fs.existsSync(path.join(brainRoot, c, 'map.json'))) return path.join(brainRoot, c);
  }
  let entries = [];
  try { entries = fs.readdirSync(brainRoot, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (fs.existsSync(path.join(brainRoot, e.name, 'map.json'))) return path.join(brainRoot, e.name);
  }
  return null;
}

function readMap(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'map.json'), 'utf8')); }
  catch { return null; }
}

const cidKey = (s) => String(s || '').replace(/-/g, '');

/** Resolve a CID (dashes or not) to its [folderKey, entry] in the map. */
function resolveAccount(map, cidRaw) {
  const want = cidKey(cidRaw);
  if (!want) return null;
  for (const [folderKey, entry] of Object.entries(map)) {
    if (cidKey(entry.cid) === want) return [folderKey, entry];
  }
  return null;
}

/** Newest CSV mtime in an account's data folder — the freshness signal. */
function latestUpdate(accountDataDir) {
  let newest = 0;
  let entries = [];
  try { entries = fs.readdirSync(accountDataDir); } catch { return null; }
  for (const f of entries) {
    if (!f.endsWith('.csv')) continue;
    try {
      const t = fs.statSync(path.join(accountDataDir, f)).mtimeMs;
      if (t > newest) newest = t;
    } catch { /* race with a sync — skip */ }
  }
  return newest ? new Date(newest).toISOString() : null;
}

function readTabCSV(dataDir, folderKey, tab) {
  const dir = path.join(dataDir, folderKey, 'data');
  let file = path.join(dir, tab + '.csv');
  // Legacy alias from the original 8-file layout (mcc-fetch wrote pTitle.csv).
  if (!fs.existsSync(file) && tab === 'productsRaw') file = path.join(dir, 'pTitle.csv');
  try { return parseCSV(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function readMaster(dataDir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, '_mcc', name + '.json'), 'utf8')); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Actions — mirror the Apps Script doGet actions the portal calls.
// ---------------------------------------------------------------------------

function actionClients(dataDir, map) {
  const clients = Object.entries(map).map(([folderKey, entry]) => ({
    cid: entry.cid,
    name: entry.name,
    // The CID doubles as the "sheet id" so per-account fetches resolve the
    // folder — same convention as the portal's brain-repo mode.
    sheetId: entry.cid,
    sheetUrl: entry.cid,
    initialized: true,
    status: 'active',
    businessMode: entry.businessMode,
    currency: entry.currency,
    // Additive freshness field (not in the Apps Script response; the portal
    // may ignore it). ISO timestamp of the newest CSV for this account.
    lastUpdated: latestUpdate(path.join(dataDir, folderKey, 'data')),
  }));
  // No scriptVersion on purpose: the portal compares scriptVersion against
  // REQUIRED_SCRIPT_VERSION to show the "script update available" banner,
  // which would be noise here. The brain-repo mode omits it the same way.
  return { clients };
}

function runAction(dataDir, map, params) {
  const action = params.get('action') || '';
  const tab = params.get('tab') || '';
  const cid = params.get('cid') || params.get('sheet') || '';

  switch (action) {
    case 'clients':
      return { code: 200, body: actionClients(dataDir, map) };

    case 'data': {
      if (!SAFE_NAME.test(tab)) return { code: 400, body: { error: 'bad tab' } };
      const hit = resolveAccount(map, cid);
      if (!hit) return { code: 200, body: [] };
      return { code: 200, body: readTabCSV(dataDir, hit[0], tab) };
    }

    case 'batch': {
      const tabs = (params.get('tabs') || '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!tabs.length || tabs.some((t) => !SAFE_NAME.test(t))) {
        return { code: 400, body: { error: 'bad tabs' } };
      }
      const hit = resolveAccount(map, cid);
      const out = {};
      for (const t of tabs) out[t] = hit ? readTabCSV(dataDir, hit[0], t) : [];
      return { code: 200, body: out };
    }

    case 'masterData': {
      if (!SAFE_NAME.test(tab)) return { code: 400, body: { error: 'bad tab' } };
      return { code: 200, body: readMaster(dataDir, 'masterData-' + tab) || [] };
    }

    case 'health':
      return { code: 200, body: readMaster(dataDir, 'health') || { status: 'ok' } };
    case 'dashboard':
      return { code: 200, body: readMaster(dataDir, 'dashboard') || [] };
    case 'alertSummary':
      return { code: 200, body: readMaster(dataDir, 'alertSummary') || {} };
    case 'triage':
      return { code: 200, body: readMaster(dataDir, 'triage') || [] };
    case 'summary':
      return { code: 200, body: readMaster(dataDir, 'summary') || [] };

    case 'allAccounts': {
      const stored = readMaster(dataDir, 'allAccounts');
      if (stored) return { code: 200, body: stored };
      // Fallback: every mapped account counts as configured; nothing to add.
      const cids = Object.values(map).map((e) => e.cid);
      return { code: 200, body: { all: [], settings: cids, ignored: [] } };
    }

    // Writes live in the sheet / the repo, never here — this surface is
    // read-only. Same graceful shape the portal's brain-repo mode returns.
    case 'saveConfig':
    case 'ignoreAccount':
    case 'addAccount':
      return { code: 200, body: { success: false } };

    // Single-account web-app action; no equivalent in repo mode.
    case 'account':
      return { code: 200, body: {} };

    default:
      return { code: 400, body: { error: 'unknown action: ' + action } };
  }
}

// ---------------------------------------------------------------------------
// HTTP handling (CORS + routing). Returns true when the request was handled.
// ---------------------------------------------------------------------------

function respond(res, code, body, cors) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  Object.assign(headers, cors);
  res.writeHead(code, headers);
  res.end(JSON.stringify(body));
}

/**
 * Handle /ads and /ads/ping. Called from server.cjs AFTER the Host allowlist
 * (which still applies — DNS rebinding stays shut) but BEFORE the write-origin
 * check (irrelevant here: this surface is GET/OPTIONS only).
 */
function handleAds(req, res, url, ctx) {
  const p = url.pathname;
  if (p !== '/ads' && p !== '/ads/ping') return false;

  const origin = req.headers.origin;
  const crossOrigin = !!origin && !origin.startsWith('http://127.0.0.1:') && !origin.startsWith('http://localhost:');
  if (crossOrigin && !PORTAL_ORIGINS.has(origin)) {
    respond(res, 403, { error: 'forbidden origin' }, {});
    return true;
  }
  const cors = crossOrigin
    ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' }
    : {};

  if (req.method === 'OPTIONS') {
    // Preflight (Chromium sends one for private-network requests). No body.
    res.writeHead(204, Object.assign({
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '86400',
    }, cors));
    res.end();
    return true;
  }
  if (req.method !== 'GET') {
    respond(res, 405, { error: 'method not allowed' }, cors);
    return true;
  }

  const dataDir = findDataFolder(ctx.brainRoot);

  if (p === '/ads/ping') {
    const map = dataDir ? readMap(dataDir) : null;
    const accounts = map ? Object.keys(map).length : 0;
    respond(res, 200, {
      ok: true,
      app: 'agency-brain',
      version: ctx.appVersion || '',
      // hasData is the portal's real switch signal: an app that answers ping
      // but has no synced CSVs (a sheet-method agency) must NOT be selected
      // as the data source — the portal falls through to proxy/sheet.
      hasData: accounts > 0,
      accounts,
      dataFolder: dataDir ? path.basename(dataDir) : null,
    }, cors);
    return true;
  }

  // No data folder / unreadable map → run the actions against an empty map so
  // every response keeps its normal shape ({clients: []}, [], {}). An {error}
  // body would make the portal's fetch layer retry 3× for a brain that simply
  // has no synced ads data; ping's hasData:false is the real "don't use me".
  const map = (dataDir && readMap(dataDir)) || {};
  const { code, body } = runAction(dataDir || ctx.brainRoot, map, url.searchParams);
  respond(res, code, body, cors);
  return true;
}

module.exports = { handleAds, parseCSV, findDataFolder };
