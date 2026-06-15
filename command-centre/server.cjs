#!/usr/bin/env node
/*
 * Agency Brain — embedded Command Centre server (member-safe, HOME-only).
 *
 * A slim copy of the brain dashboard's HOME lens, bundled into the app and
 * pointed at the MEMBER's own cloned brain. Serves ONLY: projects, misc todos,
 * active sessions, and dispatch (open an external terminal running `claude`).
 * None of the Mike-only dashboard tabs ship here.
 *
 * Zero extra deps: Node's built-in http (the app already bundles Node via
 * Electron). The engine libs (todo-parser, agents-tracker, home-prefs) and the
 * spawn scripts are copied verbatim from tools/dashboard — they honour
 * process.env.BRAIN_ROOT and resolve runtime state (active-agents.json,
 * home-prefs.json) under command-centre/data/ via the lib/scripts sibling
 * layout, so no edits were needed.
 *
 * Env:
 *   BRAIN_ROOT  the member's cloned brain folder (projects/ + todo/ live here)
 *   CC_PORT     port to listen on (default 38917, never 3847 — that's Mike's)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PORT = parseInt(process.env.CC_PORT || '38917', 10);
const BRAIN_ROOT = process.env.BRAIN_ROOT || process.cwd();
// The libs read process.env.BRAIN_ROOT at require-time — make sure it's set.
process.env.BRAIN_ROOT = BRAIN_ROOT;

const todoParser = require('./lib/todo-parser.cjs');
const agentsTracker = require('./lib/agents-tracker.cjs');
const homePrefs = require('./lib/home-prefs.cjs');
const { getObservability } = require('./lib/observability.cjs');

// Identity for the header + version footer. main.js passes these from the
// member's config.json, which the app got from the server at OTP login
// (server-authoritative — there is no role file on the machine to read).
// Degrade to blanks if not provided.
const MEMBER_EMAIL = process.env.AGENCY_MEMBER_EMAIL || '';
const MEMBER_NAME = process.env.AGENCY_MEMBER_NAME || '';
const MEMBER_ROLE = process.env.AGENCY_MEMBER_ROLE || '';
const TEAM_SLUG = process.env.AGENCY_TEAM_SLUG || '';
const APP_VERSION = process.env.AGENCY_VERSION || '';
// Paid seat cap (+ package label) for the upgrade banner. At-install snapshot
// from config; /api/health refreshes it live from the server so an upgrade
// (or a clone whose config predates this field) reflects without a re-login.
const SCOUT_SEATS_ENV = Number(process.env.AGENCY_SCOUT_SEATS) || 0;
const PACKAGE_TIER_ENV = process.env.AGENCY_PACKAGE_TIER || '';
// The member's login token + API base — used to act AS the member for team
// management (live roster, add member). Never grants more than the member has.
const MEMBER_TOKEN = process.env.AGENCY_MEMBER_TOKEN || '';
const API_BASE = (process.env.AGENCY_API_BASE || 'https://api.ads2ai.com').replace(/\/+$/, '');
// Set when this server process started — a freshness marker so Mike can tell a
// reloaded preview really picked up new code (the version alone doesn't move
// between builds).
const SERVED_AT = new Date().toISOString();

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Call the 8020 API as the member (Bearer member_token). Retries transient
// failures (network error / 404 / 5xx) a couple of times with a short backoff,
// so a Replit cold-start on the first hit doesn't fail the whole operation.
async function apiCall(method, apiPath, body, retries) {
  if (retries == null) retries = 2;
  let r;
  try {
    r = await fetch(API_BASE + apiPath, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + MEMBER_TOKEN },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (netErr) {
    if (retries > 0) { await delay(1200); return apiCall(method, apiPath, body, retries - 1); }
    throw netErr;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (retries > 0 && (r.status === 404 || r.status >= 500)) { await delay(1200); return apiCall(method, apiPath, body, retries - 1); }
    const e = new Error(j.error || ('API ' + r.status)); e.statusCode = r.status; throw e;
  }
  return j;
}
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const PUBLIC = path.join(__dirname, 'public');

// Static assets served from public/ (css/, js/). The send() helper below only
// emits text/html or application/json, and Chromium refuses a stylesheet served
// as text/html, so these go out through their own typed handler (see the static
// route near the end of the request handler).
const STATIC_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function send(res, code, payload, asHtml) {
  const isStr = typeof payload === 'string';
  res.writeHead(code, {
    'Content-Type': asHtml || isStr ? 'text/html; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(isStr ? payload : JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

// Ported verbatim from tools/dashboard/server.cjs — the proven dispatch core.
function launchAgentSession({ prompt, todoText = null, project = null, cwd = BRAIN_ROOT }) {
  if (!fs.existsSync(cwd)) { const e = new Error('cwd does not exist: ' + cwd); e.statusCode = 400; throw e; }
  const promptFile = path.join(os.tmpdir(), `agentbrain-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');
  const slot = agentsTracker.pickNextSlot();
  const session = `agentbrain-${Math.random().toString(36).slice(2, 10)}`;
  let out;
  if (process.platform === 'win32') {
    const script = path.join(__dirname, 'scripts', 'spawn-agent.ps1');
    const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Cwd', cwd, '-PromptFile', promptFile, '-Slot', String(slot), '-Session', session];
    if (todoText) psArgs.push('-TodoText', todoText);
    if (project) psArgs.push('-Project', project);
    out = spawnSync('powershell.exe', psArgs, { encoding: 'utf8', timeout: 15000 });
  } else {
    const script = path.join(__dirname, 'scripts', 'spawn-agent.sh');
    const a = ['--cwd', cwd, '--prompt-file', promptFile, '--slot', String(slot), '--session', session];
    if (todoText) a.push('--todo-text', todoText);
    if (project) a.push('--project', project);
    out = spawnSync(script, a, { encoding: 'utf8', timeout: 8000 });
  }
  if (!out || out.status !== 0) {
    const e = new Error('spawn backend failed');
    e.statusCode = 500;
    e.stderr = (out && out.stderr) || (out && out.error && out.error.message) || '';
    throw e;
  }
  return { session: (out.stdout || '').trim() || session, slot, promptFile };
}

function buildPrompt(body) {
  const project = body.project ? String(body.project) : null;
  const todoText = body.todo ? String(body.todo) : null;
  const explicit = body.prompt ? String(body.prompt) : null;
  const todoFile = body.todoFile ? String(body.todoFile) : null;
  if (explicit) return { prompt: explicit, todoText, project };
  if (project) return { prompt: `Pick up this todo for the ${project} project: "${todoText}". The brain root is your working directory. Read projects/${project}/README.md, decisions.md, and build-log.md (if present) before starting.`, todoText, project };
  if (todoFile) return { prompt: `Pick up this todo. The full context is in todo/${todoFile} — read that file first, then action it. The brain root is your working directory.`, todoText, project };
  return { prompt: `Pick up this todo: "${todoText}".`, todoText, project };
}

// ===================================================================
// Google Ads connector setup (runs entirely on the member's own machine).
// Nothing here ever calls an 8020/ads2ai API, writes to the synced brain, or
// puts a credential into an LLM context. The app just turns pasted text into a
// local file + a config entry. The credential FILE FORMAT is isolated in
// writeCredentialFile() so it's a one-function swap to an ADC file if the
// laptop test shows the official server needs that instead of google-ads.yaml.
// ===================================================================
function detectTool(cmds, arg) {
  for (const c of cmds) {
    try {
      const r = spawnSync(c, [arg], { encoding: 'utf8', timeout: 6000 });
      if (r.status === 0 && (r.stdout || r.stderr)) return { present: true, version: (r.stdout || r.stderr).trim().split('\n')[0] };
    } catch {}
  }
  return { present: false, version: '' };
}
function detectGadsTools() {
  const isWin = process.platform === 'win32';
  const python = detectTool(isWin ? ['py', 'python'] : ['python3', 'python'], '--version');
  const pipx = detectTool(['pipx'], '--version');
  const m = (python.version || '').match(/(\d+)\.(\d+)/);
  python.ok = !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 11));
  return { platform: process.platform, python, pipx };
}
function claudeConfigPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}
function buildGadsYaml(f) {
  return [
    `developer_token: ${f.dev || ''}`,
    `client_id: ${f.cid || ''}`,
    `client_secret: ${f.csec || ''}`,
    `refresh_token: ${f.rt || ''}`,
    `login_customer_id: ${(f.mcc || '').replace(/-/g, '')}`,
    'use_proto_plus: True',
    '',
  ].join('\n');
}
// ISOLATED: where + how the credential file lands. Written INTO the brain folder
// (not ~) so Cowork — which is scoped to the folder the member authorises — can
// read it for direct Google Ads API use (scripts save big pulls straight to local
// CSVs, no context-window bloat). google-ads.yaml is gitignored in the template,
// so it never syncs to GitHub. Only this function changes if the laptop test says
// the server needs an ADC file instead.
function writeCredentialFile(yamlText) {
  const dest = path.join(BRAIN_ROOT, 'google-ads.yaml');
  fs.writeFileSync(dest, yamlText, { mode: 0o600 });
  return dest;
}
// Merge a google-ads MCP block into the Claude config without disturbing other servers.
function addGadsToClaudeConfig(envBlock) {
  const cfgPath = claudeConfigPath();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  if (!cfg || typeof cfg !== 'object') cfg = {};
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['google-ads'] = {
    command: 'pipx',
    args: ['run', '--spec', 'git+https://github.com/googleads/google-ads-mcp.git', 'google-ads-mcp'],
    env: envBlock,
  };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}
const GADS_VERIFY_PROMPT = "I've just connected Google Ads. There's a credentials file at the root of this brain folder, google-ads.yaml. It has a developer token, OAuth client ID and secret, a refresh token, and a login customer ID (the MCC). Confirm it works: list the Google Ads accounts I can access and tell me which manager account (MCC) they sit under. Use whatever's easiest. A Google Ads skill if this brain has one, the google-ads connector if it's loaded, or just read the file and call the Google Ads API directly (swap the refresh token for an access token, then listAccessibleCustomers). A short script is fine.";
// base64 of the field set — encoding for one clean paste, NOT encryption.
// Channel security (email/Slack/doc) is the Scout's choice.
function encodeGadsBlock(fields) { return 'AGENCY-BRAIN-GADS:' + Buffer.from(JSON.stringify(fields), 'utf8').toString('base64'); }
function decodeGadsBlock(block) { return JSON.parse(Buffer.from(String(block || '').trim().replace(/^AGENCY-BRAIN-GADS:/, ''), 'base64').toString('utf8')); }

// ---- Google Ads PROXY connector (the recommended path; engine in the brain at
// projects/sites/gads-proxy). The team proxy URL is a synced, committed file
// (data/gads-proxy.json) so a Scout sets it once and it reaches every team
// member's clone via the normal sync. The per-member gate token is NOT stored
// there — each member pastes their own, and we write it to a gitignored
// gads-proxy.yaml so the token never syncs to the shared agency repo.
const GADS_PROXY_CONFIG = path.join(BRAIN_ROOT, 'data', 'gads-proxy.json');
function readProxyConfig() {
  try { return JSON.parse(fs.readFileSync(GADS_PROXY_CONFIG, 'utf8')); } catch { return {}; }
}
function ensureGitignored(name) {
  const gi = path.join(BRAIN_ROOT, '.gitignore');
  let txt = '';
  try { txt = fs.readFileSync(gi, 'utf8'); } catch { /* no .gitignore yet */ }
  if (txt.split(/\r?\n/).some((l) => l.trim() === name)) return;
  fs.appendFileSync(gi, (txt && !txt.endsWith('\n') ? '\n' : '') + name + '\n');
}

// ---- Per-person local identity (CLAUDE.local.md) -------------------------
// Tells THIS person's Claude who it's working with, written by the app from the
// login identity (no typing). The file is git-ignored so it never syncs; the
// shared CLAUDE.md just points at it (the one synced part, same line for
// everyone). Drives the Welcome-view "set up your identity" nudge.
const IDENTITY_POINTER = 'Read CLAUDE.local.md in this folder if it exists, and treat it as part of your instructions. It is a local file (never synced) that tells you who is using this copy of the brain.';
function hasLocalIdentity() {
  return fs.existsSync(path.join(BRAIN_ROOT, 'CLAUDE.local.md'));
}
function agencyName() {
  try {
    const roles = JSON.parse(fs.readFileSync(path.join(BRAIN_ROOT, '.team-config', 'roles.json'), 'utf8'));
    if (roles.team_name) return roles.team_name;
  } catch { /* no roster on disk */ }
  if (TEAM_SLUG) return TEAM_SLUG.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return 'your agency';
}
// Point the shared CLAUDE.md at the local file, once. Idempotent + safe: it's
// the same line for everyone and is meant to sync.
function ensureIdentityPointer() {
  const cm = path.join(BRAIN_ROOT, 'CLAUDE.md');
  let txt;
  try { txt = fs.readFileSync(cm, 'utf8'); } catch { return; } // no CLAUDE.md → nothing to point from
  if (txt.includes('CLAUDE.local.md')) return; // already points at it
  const lines = txt.split('\n');
  let at = 0; // after the first top-level heading, else the very top
  for (let i = 0; i < lines.length; i++) { if (/^#\s/.test(lines[i])) { at = i + 1; break; } }
  lines.splice(at, 0, '', IDENTITY_POINTER);
  fs.writeFileSync(cm, lines.join('\n'));
}
function writeLocalIdentity() {
  const role = (MEMBER_ROLE || 'owner').toLowerCase();
  const agency = agencyName();
  const body = '# CLAUDE.local.md — local identity (per-person, never synced)\n\n'
    + `You are the Agency Brain instance for **${MEMBER_NAME}**, a **${role}** at **${agency}**.\n\n`
    + 'This file is local to this machine and is never synced to the team.\n';
  ensureIdentityPointer();
  ensureGitignored('CLAUDE.local.md');
  fs.writeFileSync(path.join(BRAIN_ROOT, 'CLAUDE.local.md'), body);
  return { name: MEMBER_NAME, role, agency };
}

// ---- Changelog page -------------------------------------------------------
//
// GET /changelog renders the repo-root CHANGELOG.md that ships INSIDE the app
// (electron-builder `files` + `asarUnpack`), so the page always matches the
// installed version with no network call and no separate publish step. Linked
// from the Command Centre footer ("What's new"). CI refuses to build a release
// whose version has no changelog section (see .github/workflows/build.yml),
// which is what keeps this page honest.
const CHANGELOG_PATH = path.join(__dirname, '..', 'CHANGELOG.md');

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Minimal markdown for the changelog's actual shape (## version headings,
// "- " bullets, **bold**, `code`, [text](url)) — not a general renderer.
// External links open in the default browser via the app's window-open handler.
function mdInline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderChangelogPage() {
  let md = '';
  try { md = fs.readFileSync(CHANGELOG_PATH, 'utf8'); } catch { /* falls through to the empty state */ }
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (/^# /.test(line)) continue; // the page supplies its own title
    const h = line.match(/^## (\S+)(.*)$/);
    if (h) {
      closeList();
      const when = h[2].replace(/^[\s—-]+/, '').trim();
      const isCurrent = APP_VERSION && h[1] === APP_VERSION;
      out.push(`<h2>v${escapeHtml(h[1])}<span class="cl-when">${escapeHtml(when)}</span>${isCurrent ? '<span class="cl-badge">your version</span>' : ''}</h2>`);
      continue;
    }
    const b = line.match(/^- (.*)$/);
    if (b) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${mdInline(escapeHtml(b[1]))}</li>`);
      continue;
    }
    if (line.trim()) { closeList(); out.push(`<p>${mdInline(escapeHtml(line))}</p>`); }
  }
  closeList();
  if (!out.length) out.push('<p>No changelog available in this build.</p>');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>What's new · Agency Brain</title>
<link rel="stylesheet" href="/css/base.css">
<style>
  .cl-wrap{max-width:880px;margin:0 auto;padding:28px 40px 64px;}
  .cl-back{display:inline-block;font-size:13px;font-weight:600;color:var(--muted);text-decoration:none;margin-bottom:18px;}
  .cl-back:hover{color:var(--accent);}
  .cl-wrap h1{font-size:var(--fs-hero);font-weight:800;margin:0 0 6px;}
  .cl-intro{font-size:var(--fs-sm);color:var(--muted);margin:0 0 30px;}
  .cl-wrap h2{font-size:var(--fs-xl);font-weight:800;margin:34px 0 10px;padding-left:11px;border-left:3px solid var(--accent);}
  .cl-when{font-size:var(--fs-xs);font-weight:500;color:var(--muted);margin-left:10px;}
  .cl-badge{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);background:var(--accent-soft);border-radius:2px;padding:2px 8px;margin-left:10px;vertical-align:2px;}
  .cl-wrap ul{margin:0;padding-left:22px;}
  .cl-wrap li{font-size:var(--fs-base);margin:0 0 10px;}
  .cl-wrap p{font-size:var(--fs-base);}
  .cl-wrap code{font-family:ui-monospace,Menlo,monospace;font-size:.92em;background:var(--draft-bg);border-radius:2px;padding:1px 5px;}
</style></head>
<body><div class="cl-wrap">
<a class="cl-back" href="/">&larr; Back to the Command Centre</a>
<h1>What's new</h1>
${out.join('\n')}
</div></body></html>`;
}

const GADS_PROXY_VERIFY_PROMPT = "I've just connected our Google Ads proxy. There's a gads-proxy.yaml at the root of this brain with the proxy URL and a gate token. Confirm it works: use the gads-proxy skill to run a small query (list a few campaigns for one of our accounts) and show me the rows. Never print the token.";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), true);
    }
    if (req.method === 'GET' && p === '/changelog') {
      return send(res, 200, renderChangelogPage(), true);
    }
    if (req.method === 'GET' && p === '/api/health') {
      // Start from the at-install snapshot (fast, local), then best-effort
      // refresh the seat cap live from the server so an upgrade — or a clone
      // whose config predates this field — lights the banner without a
      // re-login. A short timeout + try/catch keeps the header instant when
      // offline / signed out / the API is cold.
      let scoutSeats = SCOUT_SEATS_ENV;
      let packageTier = PACKAGE_TIER_ENV;
      // memberRole is server-authoritative: config.json is set at login and goes
      // stale if the role changes, so prefer the live value. Falls back to the
      // config snapshot when offline / signed out / the API is cold.
      let memberRole = MEMBER_ROLE;
      if (MEMBER_TOKEN && TEAM_SLUG) {
        try {
          const r = await fetch(API_BASE + '/api/team-brain/my-teams', {
            headers: { Authorization: 'Bearer ' + MEMBER_TOKEN },
            signal: AbortSignal.timeout(2500),
          });
          if (r.ok) {
            const j = await r.json();
            const t = (j.teams || []).find((x) => x.slug === TEAM_SLUG);
            if (t) {
              if (t.scoutSeats != null) scoutSeats = Number(t.scoutSeats) || 0;
              if (t.packageTier) packageTier = t.packageTier;
              if (t.role) memberRole = t.role;
            }
          }
        } catch (e) { /* offline / slow / signed out — keep the snapshot */ }
      }
      // A solo / personal-mode brain has no team, so no server-assigned role.
      // The person who set up their own brain is its owner — present the Owner
      // view rather than a bare "No role" state. Agency members always carry a
      // real role (owner/scout/team) from the roster refresh above, so this only
      // affects the no-team case. View-only: real permissions stay enforced.
      if (!memberRole && !TEAM_SLUG) memberRole = 'owner';
      return send(res, 200, {
        ok: true, brainRoot: BRAIN_ROOT,
        memberEmail: MEMBER_EMAIL, memberName: MEMBER_NAME, memberRole, teamSlug: TEAM_SLUG, version: APP_VERSION, servedAt: SERVED_AT,
        scoutSeats, packageTier,
        hasLocalIdentity: hasLocalIdentity(),
      });
    }
    if (req.method === 'GET' && p === '/api/observability') {
      return send(res, 200, getObservability({ repoPath: BRAIN_ROOT, includeTeam: true }));
    }
    // ---- Guided paths (the /start skill; Getting started + Learn Cowork tabs) ----
    // Definitions are the synced JSONs inside the start skill (single source
    // of truth, shared with Cowork's /start): team-path.json for team members,
    // scout-path.json for scouts/owners, and cowork-path.json (the standalone
    // Learn Cowork course, its own tab). Progress lives in the member's
    // personal/ folder, which never syncs — the same files the /start skill
    // writes, so ticking a step in either surface shows up in both.
    if (req.method === 'GET' && p === '/api/team-path') {
      const readJson = (rel) => {
        try { return JSON.parse(fs.readFileSync(path.join(BRAIN_ROOT, rel), 'utf8')); } catch { return null; }
      };
      const paths = {};
      for (const key of ['team', 'scout', 'cowork']) {
        const def = readJson(`.claude/skills/start/${key}-path.json`);
        if (!def) continue;
        const progress = readJson(`personal/${key}-path-progress.json`) || { steps: {} };
        paths[key] = { def, progress };
      }
      if (!Object.keys(paths).length) return send(res, 200, { available: false });
      return send(res, 200, { available: true, role: MEMBER_ROLE || '', paths });
    }
    // ---- Brain updates (docs/migrations/) --------------------------------
    // Pending = a docs/migrations/NNNN-*.md with no applied/NNNN.done (or
    // .skipped) marker. Team role always gets an empty list — applying brain
    // updates is scout/owner work and the banner must never show for team.
    if (req.method === 'GET' && p === '/api/brain-updates') {
      const role = (MEMBER_ROLE || '').toLowerCase();
      if (role === 'team') return send(res, 200, { pending: [] });
      const migDir = path.join(BRAIN_ROOT, 'docs', 'migrations');
      const pending = [];
      try {
        for (const f of fs.readdirSync(migDir).sort()) {
          if (!/^\d{4}-.*\.md$/.test(f)) continue;
          const id = f.slice(0, 4);
          if (fs.existsSync(path.join(migDir, 'applied', id + '.done'))) continue;
          if (fs.existsSync(path.join(migDir, 'applied', id + '.skipped'))) continue;
          let title = f;
          try {
            const m = fs.readFileSync(path.join(migDir, f), 'utf8').match(/^title:\s*(.+)$/m);
            if (m) title = m[1].trim();
          } catch { /* unreadable — show the filename */ }
          pending.push({ id, file: 'docs/migrations/' + f, title });
        }
      } catch { /* no migrations folder — nothing pending */ }
      return send(res, 200, { pending });
    }
    if (req.method === 'POST' && p === '/api/team-path/toggle') {
      const b = await readBody(req);
      const id = String(b.id || '').trim();
      const key = ['scout', 'cowork'].includes(b.path) ? b.path : 'team';
      if (!id) return send(res, 400, { error: 'Missing step id.' });
      const file = path.join(BRAIN_ROOT, 'personal', `${key}-path-progress.json`);
      let progress = { started: new Date().toISOString().slice(0, 10), steps: {} };
      try { progress = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
      if (!progress.steps) progress.steps = {};
      if (progress.steps[id]) delete progress.steps[id];
      else progress.steps[id] = new Date().toISOString().slice(0, 10);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(progress, null, 2) + '\n');
      return send(res, 200, { ok: true, path: key, progress });
    }
    // ---- Google Ads connector setup (all local; see the helpers above) ----
    if (req.method === 'GET' && p === '/api/gads/detect') {
      return send(res, 200, detectGadsTools());
    }
    // Scout: turn entered credentials into a shareable block. Stays on this
    // machine until the Scout chooses to share it (doc/email/Slack).
    if (req.method === 'POST' && p === '/api/gads/encode') {
      const b = await readBody(req);
      return send(res, 200, { block: encodeGadsBlock({
        dev: b.dev || '', cid: b.cid || '', csec: b.csec || '', rt: b.rt || '',
        mcc: (b.mcc || '').replace(/-/g, ''), project: b.project || '',
      }) });
    }
    // Member: decode the pasted block, write google-ads.yaml + the Claude config
    // block, and hand back the verify prompt for the clipboard.
    if (req.method === 'POST' && p === '/api/gads/install') {
      const b = await readBody(req);
      let f;
      try { f = decodeGadsBlock(b.block); } catch { return send(res, 400, { error: "That code doesn't look right — check you pasted the whole block your Scout sent." }); }
      if (!f.dev || !f.rt) return send(res, 400, { error: 'That block is missing credentials. Ask your Scout to regenerate it.' });
      const yamlPath = writeCredentialFile(buildGadsYaml(f));
      const configPath = addGadsToClaudeConfig({
        GOOGLE_PROJECT_ID: f.project || '',
        GOOGLE_ADS_DEVELOPER_TOKEN: f.dev || '',
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: f.mcc || '',
        // The yaml now lives in the brain folder (so Cowork can read it for the
        // API). The MCP's OAuth bits live in that file, so point it at the new
        // location rather than the google-ads default (~/google-ads.yaml).
        GOOGLE_ADS_CONFIGURATION_FILE_PATH: yamlPath,
      });
      return send(res, 200, { ok: true, yamlPath, configPath, verifyPrompt: GADS_VERIFY_PROMPT });
    }
    // ---- Google Ads PROXY: read config (synced URL), Scout sets URL, team connects ----
    if (req.method === 'GET' && p === '/api/gads-proxy/config') {
      const cfg = readProxyConfig();
      return send(res, 200, { configured: !!cfg.url, url: cfg.url || '', role: MEMBER_ROLE });
    }
    // Scout/Owner sets the team's proxy URL once. Written to a synced file so it
    // propagates to every team member. Role is enforced server-side here.
    if (req.method === 'POST' && p === '/api/gads-proxy/set-url') {
      const role = (MEMBER_ROLE || '').toLowerCase();
      if (!['owner', 'scout', 'head-scout'].includes(role)) {
        return send(res, 403, { error: 'Only an Owner or Scout can set the proxy URL.' });
      }
      const b = await readBody(req);
      const url = String(b.url || '').trim().replace(/\/+$/, '');
      if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(url)) {
        return send(res, 400, { error: 'Enter a valid https URL, e.g. https://gads-proxy.your-subdomain.workers.dev' });
      }
      fs.mkdirSync(path.dirname(GADS_PROXY_CONFIG), { recursive: true });
      fs.writeFileSync(GADS_PROXY_CONFIG, JSON.stringify({ url }, null, 2) + '\n');
      return send(res, 200, { ok: true, url });
    }
    // Team member pastes their gate token; we combine it with the synced URL and
    // write a gitignored gads-proxy.yaml the gads-proxy skill reads at runtime.
    if (req.method === 'POST' && p === '/api/gads-proxy/connect') {
      const cfg = readProxyConfig();
      if (!cfg.url) return send(res, 400, { error: 'No proxy URL is set for your team yet. Ask your Scout to set it on their Google Ads page.' });
      const b = await readBody(req);
      const secret = String(b.secret || '').trim();
      if (!secret) return send(res, 400, { error: 'Paste the gate token your Scout sent you.' });
      ensureGitignored('gads-proxy.yaml');
      const dest = path.join(BRAIN_ROOT, 'gads-proxy.yaml');
      fs.writeFileSync(dest, `url: ${cfg.url}\nsecret: ${secret}\n`, { mode: 0o600 });
      return send(res, 200, { ok: true, yamlPath: dest, url: cfg.url, verifyPrompt: GADS_PROXY_VERIFY_PROMPT });
    }
    // Write THIS person's local identity (the Welcome-view "set up your identity"
    // button). The app already knows who they are from login, so this is one click:
    // it writes CLAUDE.local.md locally (git-ignored) and points the shared
    // CLAUDE.md at it. No typing, no email, nothing to commit per-person.
    if (req.method === 'POST' && p === '/api/write-identity') {
      if (!MEMBER_NAME) return send(res, 400, { error: "I don't know your name yet. Sign in again, then reopen the Command Centre." });
      try {
        return send(res, 200, { ok: true, ...writeLocalIdentity() });
      } catch (e) {
        return send(res, 500, { error: 'Could not write the identity file: ' + e.message });
      }
    }
    // Live team roster from the server (the source of truth), acting as the member.
    if (req.method === 'GET' && p === '/api/team-roster') {
      if (!MEMBER_TOKEN || !TEAM_SLUG) return send(res, 200, { unavailable: true, reason: 'not signed in to a team' });
      try {
        return send(res, 200, await apiCall('GET', '/api/team-brain/team-summary?team=' + encodeURIComponent(TEAM_SLUG)));
      } catch (err) {
        return send(res, 200, { unavailable: true, reason: err.message });
      }
    }
    // Add a member: create the roster row, generate an invite, email it. Owner/scout only (enforced server-side).
    if (req.method === 'POST' && p === '/api/team-invite') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const role = ['scout', 'team', 'owner'].includes(String(body.role || '').toLowerCase()) ? String(body.role).toLowerCase() : 'team';
      if (!email || !name) return send(res, 400, { error: 'name and email are required' });
      if (!MEMBER_TOKEN || !TEAM_SLUG) return send(res, 400, { error: 'not signed in to a team' });
      const memberSlug = (slugify(name) + '-' + slugify(email.split('@')[0])).slice(0, 50) || ('m' + Date.now().toString(36));
      // Warm the (Replit) API first so the first real call doesn't cold-start 404.
      await apiCall('GET', '/api/team-dashboard/version', null, 1).catch(() => {});
      const steps = [
        ['add-member', { teamSlug: TEAM_SLUG, memberSlug, name, email, role }],
        ['invite-token', { teamSlug: TEAM_SLUG, memberEmail: email, memberName: name, memberRole: role }],
        ['send-invite', { teamSlug: TEAM_SLUG, memberEmail: email }],
      ];
      try {
        for (const [step, payload] of steps) {
          try { await apiCall('POST', '/api/team-brain/' + step, payload); }
          catch (e) { e.message = step + ': ' + e.message; throw e; }
        }
        return send(res, 200, { ok: true, email });
      } catch (err) {
        return send(res, err.statusCode || 500, { error: err.message });
      }
    }
    // Edit a member's name and/or role. Owner/scout only (enforced server-side).
    if (req.method === 'POST' && p === '/api/team-member-update') {
      const body = await readBody(req);
      const memberSlug = String(body.memberSlug || '').trim();
      if (!memberSlug) return send(res, 400, { error: 'memberSlug is required' });
      if (!MEMBER_TOKEN || !TEAM_SLUG) return send(res, 400, { error: 'not signed in to a team' });
      const payload = { teamSlug: TEAM_SLUG, memberSlug };
      if (body.name != null) payload.name = String(body.name).trim();
      if (body.role != null) payload.role = String(body.role).toLowerCase();
      try {
        await apiCall('GET', '/api/team-dashboard/version', null, 1).catch(() => {});
        return send(res, 200, await apiCall('POST', '/api/team-brain/update-member', payload));
      } catch (err) {
        return send(res, err.statusCode || 500, { error: err.message });
      }
    }
    // Remove a member (deletes roster row + revokes access). Owner/scout only.
    if (req.method === 'POST' && p === '/api/team-member-remove') {
      const body = await readBody(req);
      const memberSlug = String(body.memberSlug || '').trim();
      if (!memberSlug) return send(res, 400, { error: 'memberSlug is required' });
      if (!MEMBER_TOKEN || !TEAM_SLUG) return send(res, 400, { error: 'not signed in to a team' });
      try {
        await apiCall('GET', '/api/team-dashboard/version', null, 1).catch(() => {});
        return send(res, 200, await apiCall('POST', '/api/team-brain/remove-member', { teamSlug: TEAM_SLUG, memberSlug }));
      } catch (err) {
        return send(res, err.statusCode || 500, { error: err.message });
      }
    }
    // Resend an existing member's invite (regenerate token + email it). Drives the
    // owner verdict + roster Nudge / scout get-people-going Resend buttons. Owner/
    // scout only (enforced server-side by invite-token). Name/role preserve the
    // member's record so a re-issued invite never downgrades a scout to team.
    if (req.method === 'POST' && p === '/api/team-resend-invite') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const role = ['scout', 'team', 'owner'].includes(String(body.role || '').toLowerCase()) ? String(body.role).toLowerCase() : 'team';
      if (!email) return send(res, 400, { error: 'email is required' });
      if (!MEMBER_TOKEN || !TEAM_SLUG) return send(res, 400, { error: 'not signed in to a team' });
      try {
        await apiCall('GET', '/api/team-dashboard/version', null, 1).catch(() => {});
        await apiCall('POST', '/api/team-brain/invite-token', { teamSlug: TEAM_SLUG, memberEmail: email, memberName: name, memberRole: role });
        await apiCall('POST', '/api/team-brain/send-invite', { teamSlug: TEAM_SLUG, memberEmail: email });
        return send(res, 200, { ok: true, email });
      } catch (err) {
        return send(res, err.statusCode || 500, { error: err.message });
      }
    }
    // Flag a skill from the web form. Writes the SAME structured feedback file
    // the /flag-skill skill produces (.team-config/feedback/<skill>.md), so the
    // dashboard's flag counts + Open feedback pick it up identically. Local
    // write, no API call — feedback lives in the member's own brain.
    if (req.method === 'POST' && p === '/api/flag-skill') {
      const body = await readBody(req);
      const skillRaw = String(body.skill || '').trim();
      const skill = skillRaw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
      const client = String(body.client || '').trim();
      const wrong = String(body.wrong || '').trim();
      const wanted = String(body.wanted || '').trim();
      if (!skill) return send(res, 400, { error: 'pick a skill to flag' });
      if (!wrong && !wanted) return send(res, 400, { error: 'tell us what went wrong or what you wanted instead' });
      try {
        const dir = path.join(BRAIN_ROOT, '.team-config', 'feedback');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, skill + '.md');
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const off = -now.getTimezoneOffset();
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
        let entry = `---\nflagged_at: ${stamp}\nflagged_by: ${MEMBER_EMAIL || 'unknown'}\nskill: ${skill}\n`;
        if (client) entry += `client: ${client}\n`;
        entry += `---\n\n`;
        if (wrong) entry += `## What went wrong\n${wrong}\n\n`;
        if (wanted) entry += `## What I wanted instead\n${wanted}\n\n`;
        const prefix = (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) ? '\n' : '';
        fs.appendFileSync(file, prefix + entry);
        return send(res, 200, { ok: true, skill });
      } catch (err) {
        return send(res, err.statusCode || 500, { error: err.message });
      }
    }
    if (req.method === 'GET' && p === '/api/projects') {
      const all = todoParser.getProjectsList().map((pr) => ({ ...pr, activeTodos: todoParser.getProjectTodos(pr.name) }));
      const { projects, snoozed } = homePrefs.applyProjectPrefs(all);
      return send(res, 200, { projects, snoozed, generated: new Date().toISOString() });
    }
    if (req.method === 'GET' && p === '/api/misc-todos') {
      const { todos, snoozed } = homePrefs.applyTodoPrefs(todoParser.getMiscTodos());
      return send(res, 200, { todos, snoozed, generated: new Date().toISOString() });
    }
    if (req.method === 'GET' && p === '/api/agents') {
      return send(res, 200, { agents: agentsTracker.listAgents(), generated: new Date().toISOString() });
    }
    if (req.method === 'POST' && p === '/api/spawn') {
      const body = await readBody(req);
      if (!body.todo && !body.prompt) return send(res, 400, { error: 'either "todo" or "prompt" is required' });
      const { prompt, todoText, project } = buildPrompt(body);
      const cwd = body.cwd ? String(body.cwd) : BRAIN_ROOT;
      try {
        const r = launchAgentSession({ prompt, todoText, project, cwd });
        return send(res, 200, { agent_id: r.session, session: r.session, slot: r.slot });
      } catch (err) {
        return send(res, err.statusCode || 500, { error: err.message, stderr: err.stderr });
      }
    }
    // Smart Start — adaptive "where do I begin?" first-run. state: has the
    // member already done it (does projects/getting-started exist)? run:
    // dispatch a Claude session with the bundled discovery prompt; it reads the
    // business context, runs the conversation, and writes the starter project +
    // todos that then show up on this home screen.
    if (req.method === 'GET' && p === '/api/smart-start/state') {
      const done = fs.existsSync(path.join(BRAIN_ROOT, 'projects', 'getting-started'));
      return send(res, 200, { done });
    }
    if (req.method === 'POST' && p === '/api/smart-start/run') {
      try {
        const prompt = fs.readFileSync(path.join(__dirname, 'smart-start-prompt.md'), 'utf8');
        const r = launchAgentSession({ prompt, project: 'getting-started', todoText: 'Smart Start — where do I begin?', cwd: BRAIN_ROOT });
        return send(res, 200, { ok: true, session: r.session });
      } catch (err) {
        return send(res, err.statusCode || 500, { error: err.message, stderr: err.stderr });
      }
    }
    let m;
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/kill$/))) {
      return send(res, 200, { session: m[1], killed: agentsTracker.killAgent(m[1]) });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/focus$/))) {
      return send(res, 200, { session: m[1], focused: agentsTracker.focusAgent(m[1]) });
    }
    // Static assets (css/, js/, fonts, images) from public/. GET-only, read-only.
    // Runs after every /api/* route and after the special-cased '/' + '/index.html'
    // document route, so it never shadows an endpoint or hijacks the document load.
    // The path.relative check is the real traversal control: it rejects anything
    // that escapes PUBLIC, including encoded-slash '..%2f' forms (new URL leaves
    // those in url.pathname). url.pathname is already decoded + dot-collapsed by
    // new URL, so we never double-decode it.
    if (req.method === 'GET') {
      const rel = p.replace(/^\/+/, '');
      if (rel && !rel.includes('\0')) {
        const resolved = path.resolve(PUBLIC, rel);
        const relCheck = path.relative(PUBLIC, resolved);
        const insidePublic = relCheck && !relCheck.startsWith('..') && !path.isAbsolute(relCheck);
        if (insidePublic && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          const ext = path.extname(resolved).toLowerCase();
          res.writeHead(200, { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
          return res.end(fs.readFileSync(resolved));
        }
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[command-centre] listening on http://127.0.0.1:${PORT} (brain: ${BRAIN_ROOT})`);
});
