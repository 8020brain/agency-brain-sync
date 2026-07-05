#!/usr/bin/env node
/**
 * Shared agent registration for the Home Command Centre.
 *
 * Upserts a single agent record in tools/dashboard/data/active-agents.json,
 * keyed by session. Called by BOTH spawn backends (spawn-agent.sh on macOS,
 * spawn-agent.ps1 on Windows) so the JSON-writing logic lives in exactly one
 * place and neither shell has to hand-roll JSON.
 *
 * Idempotent and merge-only: a record is created on first call (stamping
 * spawnedAt), and later calls update just the fields they pass — so a second
 * call carrying only --window-id (macOS) or --pid (Windows) augments the
 * existing record without clobbering it.
 *
 * Usage:
 *   register-agent.cjs --session agentbrain-xxx \
 *     [--slot N] [--cwd DIR] [--todo "text"] [--project name] \
 *     [--prompt-file PATH] [--window-id N] [--pid N] [--agents-file PATH]
 *
 * Only --session is required.
 */

const fs = require('fs');
const path = require('path');

// Every flag we accept takes a value, so the token after a flag is ALWAYS its
// value — even if that value itself starts with "--" (e.g. a todo title). This
// avoids mis-parsing arbitrary todo text. Also supports --key=value.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    out[key] = (i + 1 < argv.length) ? argv[++i] : '';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const session = args.session;
if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
  console.error('register-agent.cjs: --session is required and must be [a-zA-Z0-9_-]+');
  process.exit(2);
}

const AGENTS_FILE = args['agents-file']
  || path.join(__dirname, '..', 'data', 'active-agents.json');

function readAgents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const agents = readAgents();
let rec = agents.find(a => a && a.session === session);
if (!rec) {
  rec = { id: session, session, spawnedAt: new Date().toISOString() };
  agents.push(rec);
}

// Merge only the fields that were actually passed.
if ('slot' in args) rec.slot = parseInt(args.slot, 10);
if ('cwd' in args) rec.cwd = args.cwd;
if ('todo' in args) rec.todoText = args.todo || null;
if ('project' in args) rec.project = args.project || null;
if ('prompt-file' in args) rec.promptFile = args['prompt-file'];
// Pinned claude conversation id (claude --session-id): the jsonl basename is
// known up front, so the tracker resolves this agent's file exactly instead
// of guessing by birth time. Absent (old spawns) = greedy fallback.
if ('claude-session' in args && args['claude-session']) rec.claudeSession = args['claude-session'];
if ('window-id' in args && args['window-id']) rec.windowId = parseInt(args['window-id'], 10);
if ('pid' in args && args.pid) rec.pid = parseInt(args.pid, 10);

fs.mkdirSync(path.dirname(AGENTS_FILE), { recursive: true });
fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));

process.stdout.write(session + '\n');
