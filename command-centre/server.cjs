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
      return send(res, 200, { ok: true, brainRoot: BRAIN_ROOT });
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
