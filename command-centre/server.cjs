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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), true);
    }
    if (req.method === 'GET' && p === '/api/health') {
      return send(res, 200, {
        ok: true, brainRoot: BRAIN_ROOT,
        memberEmail: MEMBER_EMAIL, memberName: MEMBER_NAME, memberRole: MEMBER_ROLE, teamSlug: TEAM_SLUG, version: APP_VERSION, servedAt: SERVED_AT,
      });
    }
    if (req.method === 'GET' && p === '/api/observability') {
      return send(res, 200, getObservability({ repoPath: BRAIN_ROOT, includeTeam: true }));
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
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[command-centre] listening on http://127.0.0.1:${PORT} (brain: ${BRAIN_ROOT})`);
});
