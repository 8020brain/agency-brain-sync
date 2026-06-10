/**
 * Agents tracker for the Home Command Centre.
 *
 * State source: tools/dashboard/data/active-agents.json (written by
 * spawn-agent.sh on spawn). Each entry has { id, session, slot, cwd,
 * todoText, project, promptFile, spawnedAt }.
 *
 *   listAgents()              → reads active-agents.json, prunes any
 *                               entry whose tmux session has died,
 *                               augments each survivor with status.
 *                               Returns the augmented list.
 *
 *   getAgentStatus(agent)     → resolves the agent's JSONL under
 *                               ~/.claude/projects/<encoded-cwd>/, reads the
 *                               CLI's native busy/waiting/idle status from
 *                               ~/.claude/sessions/<pid>.json (matched by
 *                               sessionId), and falls back to the legacy
 *                               heuristics (`?` in the trailing 600 chars of
 *                               the last assistant text + jsonl mtime window)
 *                               when no native status exists.
 *                               { status: 'running' | 'idle' | 'needs-you',
 *                                 lastMsgAt, lastQuestion }
 *
 *   pickNextSlot()            → counts live agents, returns the next slot
 *                               number (1-based). Used by /api/spawn.
 *
 *   killAgent(session)        → tmux kill-session + drop from active-agents.json.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const BRAIN_ROOT = process.env.BRAIN_ROOT
  || path.resolve(__dirname, '..', '..', '..');

const AGENTS_FILE = path.join(__dirname, '..', 'data', 'active-agents.json');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// Fallback only — consulted when the CLI writes no native session status.
// "Running/working" = JSONL last touched within this many ms. Anything older
// reads as "ready" (waiting for you) unless flagged needs-you. claude can sit
// 30s+ between JSONL writes while thinking, so a tight window flaps badly;
// 40s keeps "working" steady through a normal turn.
const RUNNING_WINDOW_MS = 40 * 1000;

// Look at this many trailing chars of the last assistant text when
// detecting needs-you. Matches Fleet's old heuristic.
const NEEDS_YOU_TAIL = 600;

// ---- file IO -------------------------------------------------------------

function readAgentsFile() {
  try {
    const raw = fs.readFileSync(AGENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAgentsFile(agents) {
  fs.mkdirSync(path.dirname(AGENTS_FILE), { recursive: true });
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

// ---- tmux helpers --------------------------------------------------------

function tmuxHasSession(session) {
  try {
    execSync(`tmux has-session -t ${JSON.stringify(session)}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function tmuxKillSession(session) {
  try {
    execSync(`tmux kill-session -t ${JSON.stringify(session)}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// ---- platform-agnostic liveness ------------------------------------------
//
// macOS/Linux track liveness via the tmux session; Windows has no tmux, so
// spawn-agent.ps1 records the launcher process PID and we test that instead.
//   macOS/Linux : tmux session exists  == window open == alive
//   Windows      : launcher PID alive   == window open == alive
const IS_WIN = process.platform === 'win32';

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, cross-platform in Node
    return true;
  } catch (e) {
    // ESRCH = no such process (dead). EPERM = exists but not ours (alive).
    return !!(e && e.code === 'EPERM');
  }
}

function isAgentAlive(agent) {
  if (!agent) return false;
  if (IS_WIN) return isPidAlive(agent.pid);
  return agent.session ? tmuxHasSession(agent.session) : false;
}

function findAgent(session) {
  return readAgentsFile().find(a => a && a.session === session) || null;
}

// ---- JSONL discovery -----------------------------------------------------

function encodeCwd(cwd) {
  // Claude Code encodes a working dir into a folder name by replacing path
  // separators with "-". POSIX: leading "/" → leading "-". Windows also has
  // backslashes and a drive colon (C:\Users\… → C--Users-…). The exact
  // Windows scheme should be verified against an actual
  // ~/.claude/projects/<dir> name; status detection degrades gracefully to
  // "running" if the encoded dir isn't found.
  return cwd.replace(/[\\/:]/g, '-');
}

/**
 * Find the JSONL claude is writing for THIS agent.
 *
 * Tricky case: multiple claude sessions share the same cwd (e.g. the
 * brain root). They all land in ~/.claude/projects/<encoded-cwd>/, so
 * mtime alone isn't enough — the operator's own Claude Code session
 * keeps its jsonl warmer than the agent's.
 *
 * Resolution: filter by file BIRTH time, not mtime. Each spawn creates a
 * brand-new jsonl, so a file whose birthtime is >= spawnedAt belongs to
 * an agent we launched. Among those, pick the one with the latest
 * birthtime (handles concurrent spawns).
 *
 * Returns null if claude hasn't written its first message yet (file not
 * created), which we map to status='running' upstream.
 */
function findJsonlForAgent(agent) {
  if (!agent.cwd) return null;
  const dir = path.join(CLAUDE_PROJECTS_DIR, encodeCwd(agent.cwd));
  if (!fs.existsSync(dir)) return null;

  const spawnedAtMs = agent.spawnedAt ? Date.parse(agent.spawnedAt) : 0;
  const GRACE_MS = 5000;

  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const abs = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    // Must be a jsonl CREATED after this agent spawned (within grace).
    // mtime alone is fooled by the operator's parallel Claude Code session.
    if (stat.birthtimeMs < spawnedAtMs - GRACE_MS) continue;
    if (!best || stat.birthtimeMs > best.birthtimeMs) {
      best = { path: abs, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs };
    }
  }
  return best;
}

// ---- Status detection ----------------------------------------------------

/**
 * Native status from Claude Code's own session registry. The CLI writes a
 * live { sessionId, status: 'busy' | 'waiting' | 'idle', updatedAt, ... } to
 * ~/.claude/sessions/<pid>.json (present since at least CLI 2.1.144, on both
 * macOS and Windows). Files are keyed by pid, which we don't reliably know
 * (on macOS the agent record holds a tmux session, not the claude pid), so
 * match on sessionId == the agent's jsonl basename instead. Stale files
 * outlive their process (and a --resume leaves the old pid's file behind
 * with the same sessionId), so the newest updatedAt wins.
 * Returns the status string, or null when nothing matches (older CLI).
 */
function nativeSessionStatus(sessionId) {
  if (!sessionId) return null;
  let names;
  try { names = fs.readdirSync(CLAUDE_SESSIONS_DIR); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, name), 'utf8'));
    } catch { continue; } // partial write or junk — skip
    if (!entry || entry.sessionId !== sessionId || typeof entry.status !== 'string') continue;
    if (!best || (entry.updatedAt || 0) > (best.updatedAt || 0)) best = entry;
  }
  return best ? best.status : null;
}

/**
 * Extract the last assistant text from a JSONL. Streams the tail of the
 * file rather than reading the whole thing. Returns { text, timestamp }
 * or null.
 */
function lastAssistantText(jsonlPath) {
  const stat = fs.statSync(jsonlPath);
  const READ_TAIL = 64 * 1024; // last 64KB is plenty for the last message.
  const start = Math.max(0, stat.size - READ_TAIL);
  const fd = fs.openSync(jsonlPath, 'r');
  const buf = Buffer.alloc(stat.size - start);
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const tail = buf.toString('utf8');
  const lines = tail.split('\n').filter(Boolean);

  // Walk lines in reverse, find the most recent assistant entry with text.
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.type !== 'assistant') continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    // Concatenate all text blocks for this message.
    const textBlocks = content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text);
    if (!textBlocks.length) continue;
    return {
      text: textBlocks.join('\n'),
      timestamp: entry.timestamp || null,
    };
  }
  return null;
}

/**
 * Status logic. The CLI's native session status leads, observed behaviour
 * (macOS + Windows, CLI 2.1.170):
 *   - 'busy'    → the turn is still running → 'running'. Authoritative: it
 *                 doesn't flap between jsonl writes the way the mtime window
 *                 does, and a mid-turn `?` can't fake a needs-you.
 *   - 'waiting' → blocked on a dialog (permission prompt etc) → 'needs-you'.
 *   - 'idle'    → at the input box. A turn that ENDS with a plain-text
 *                 question still registers as native 'idle', so idle falls
 *                 through to the `?` heuristic: needs-you if the last
 *                 assistant text has `?` in its trailing N chars AND no later
 *                 user message exists, else 'idle'.
 * No native status (older CLI) → the original heuristics: `?` check, then
 * jsonl mtime within RUNNING_WINDOW_MS → 'running', else 'idle'.
 *
 * Returns { status, lastMsgAt, lastQuestion }.
 */
function getAgentStatus(agent, jsonlOverride) {
  // listAgents passes a pre-assigned jsonl (greedy, by spawn order) so that
  // multiple agents sharing one cwd don't all resolve to the newest file.
  // Direct callers can omit it and fall back to the single-best guess.
  const jsonl = jsonlOverride || findJsonlForAgent(agent);
  if (!jsonl) {
    return { status: 'running', lastMsgAt: null, lastQuestion: null, jsonl: null };
  }

  const native = nativeSessionStatus(path.basename(jsonl.path, '.jsonl'));

  let lastAsst = null;
  try { lastAsst = lastAssistantText(jsonl.path); } catch {}

  let needsYou = false;
  let question = null;
  if (lastAsst && lastAsst.text) {
    const tail = lastAsst.text.slice(-NEEDS_YOU_TAIL);
    if (tail.includes('?')) {
      // Check whether a user reply has happened AFTER this assistant message.
      // Cheap proxy: re-scan trailing lines for the most recent message type.
      const lastType = lastEntryType(jsonl.path);
      if (lastType === 'assistant') {
        needsYou = true;
        question = tail;
      }
    }
  }

  let status;
  if (native === 'busy') status = 'running';
  else if (native === 'waiting') status = 'needs-you';
  else if (needsYou) status = 'needs-you';
  else if (native === 'idle') status = 'idle';
  else if ((Date.now() - jsonl.mtimeMs) < RUNNING_WINDOW_MS) status = 'running';
  else status = 'idle';

  return {
    status,
    lastMsgAt: lastAsst ? lastAsst.timestamp : new Date(jsonl.mtimeMs).toISOString(),
    lastQuestion: status === 'needs-you' ? question : null,
    jsonl: jsonl.path,
  };
}

/**
 * Cheap "what type was the last entry in the JSONL".
 */
function lastEntryType(jsonlPath) {
  const stat = fs.statSync(jsonlPath);
  const start = Math.max(0, stat.size - 8 * 1024);
  const fd = fs.openSync(jsonlPath, 'r');
  const buf = Buffer.alloc(stat.size - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); }
  finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === 'assistant' || e.type === 'user') return e.type;
    } catch {}
  }
  return null;
}

/**
 * Greedily map each agent to its own JSONL.
 *
 * Why this exists: with the 8-tile grid, up to 8 agents run concurrently in
 * the SAME cwd (the brain root), so they all land in one
 * ~/.claude/projects/<encoded-cwd>/ folder. Picking "newest jsonl" per agent
 * (findJsonlForAgent) would make every older agent resolve to the newest
 * agent's conversation — wrong status, wrong question.
 *
 * Instead: within each cwd, sort agents by spawn time (oldest first) and the
 * cwd's jsonls by birth time (oldest first), then hand each agent the earliest
 * still-unclaimed jsonl born at/after it spawned. Sequential spawns map
 * 1:1 to sequential conversation files.
 *
 * Returns { session → { path, mtimeMs, birthtimeMs } }.
 */
function assignJsonls(agents) {
  const byCwd = new Map();
  for (const a of agents) {
    if (!a.cwd) continue;
    if (!byCwd.has(a.cwd)) byCwd.set(a.cwd, []);
    byCwd.get(a.cwd).push(a);
  }

  const assignment = {};
  const GRACE_MS = 5000;

  for (const [cwd, group] of byCwd) {
    const dir = path.join(CLAUDE_PROJECTS_DIR, encodeCwd(cwd));
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter(n => n.endsWith('.jsonl'))
        .map(n => {
          const abs = path.join(dir, n);
          try {
            const st = fs.statSync(abs);
            return { path: abs, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => a.birthtimeMs - b.birthtimeMs); // oldest first
    } catch { /* dir not created yet */ }

    const sortedAgents = group.slice().sort((a, b) =>
      (Date.parse(a.spawnedAt) || 0) - (Date.parse(b.spawnedAt) || 0));

    const claimed = new Set();
    for (const a of sortedAgents) {
      const spawnedAtMs = a.spawnedAt ? Date.parse(a.spawnedAt) : 0;
      const match = files.find(f => !claimed.has(f.path) && f.birthtimeMs >= spawnedAtMs - GRACE_MS);
      if (match) { claimed.add(match.path); assignment[a.session] = match; }
    }
  }
  return assignment;
}

// ---- Public API ----------------------------------------------------------

/**
 * Read active-agents.json, drop entries whose tmux session has died,
 * write the pruned list back, and augment each survivor with status.
 * JSONLs are assigned greedily across all live agents so concurrent agents
 * in the same cwd each get their own conversation.
 */
function listAgents() {
  const all = readAgentsFile();
  const alive = all.filter(a => a && a.session && isAgentAlive(a));
  if (alive.length !== all.length) {
    writeAgentsFile(alive);
  }
  const assignment = assignJsonls(alive);
  return alive.map(a => ({
    ...a,
    ...getAgentStatus(a, assignment[a.session]),
  }));
}

/**
 * Bring an agent's Terminal window to the front via focus-agent.sh.
 * Returns true if the session exists.
 */
function focusAgent(session) {
  const agent = findAgent(session);
  if (!isAgentAlive(agent)) return false;
  if (IS_WIN) {
    // Per-tab focus isn't reliably scriptable for Windows Terminal in v1
    // (the launcher PID lives inside WindowsTerminal.exe, which owns the
    // window). No-op; use the taskbar / Alt-Tab. Return true so the API
    // doesn't surface this as a failure.
    return true;
  }
  const script = path.join(__dirname, '..', 'scripts', 'focus-agent.sh');
  const winId = agent && agent.windowId ? String(agent.windowId) : '';
  try {
    execSync(`${JSON.stringify(script)} ${JSON.stringify(session)} ${JSON.stringify(winId)}`, {
      stdio: 'ignore', timeout: 6000,
    });
  } catch { /* best-effort */ }
  return true;
}

/**
 * Rename an agent's display label (stored in active-agents.json). The chip
 * shows `label` in preference to the original todoText. Returns true if the
 * agent was found.
 */
function renameAgent(session, label) {
  const all = readAgentsFile();
  let found = false;
  for (const a of all) {
    if (a.session === session) { a.label = String(label || '').slice(0, 120) || null; found = true; }
  }
  if (found) writeAgentsFile(all);
  return found;
}

/**
 * Pick the lowest unused slot (1-based). Used by /api/spawn before calling
 * spawn-agent.sh.
 */
function pickNextSlot() {
  const all = readAgentsFile().filter(a => a && a.session && isAgentAlive(a));
  const used = new Set(all.map(a => a.slot));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/**
 * Kill an agent: end the tmux session AND close its Terminal window (via
 * kill-agent.sh), then drop it from active-agents.json.
 * Returns true if the tmux session existed before the kill.
 */
function killAgent(session) {
  const agent = findAgent(session);
  const existed = isAgentAlive(agent);

  if (IS_WIN) {
    // No tmux: kill the launcher PID and its child tree (claude), which also
    // closes the hosting Windows Terminal tab. Then clear its pidfile.
    const pid = agent && agent.pid;
    if (pid) {
      try { execSync(`taskkill /PID ${parseInt(pid, 10)} /T /F`, { stdio: 'ignore' }); } catch { /* best-effort */ }
    }
    try {
      const pf = path.join(os.tmpdir(), `agentbrain-${session}.pid`);
      if (fs.existsSync(pf)) fs.unlinkSync(pf);
    } catch { /* best-effort */ }
  } else {
    const script = path.join(__dirname, '..', 'scripts', 'kill-agent.sh');
    const winId = agent && agent.windowId ? String(agent.windowId) : '';
    try {
      execSync(`${JSON.stringify(script)} ${JSON.stringify(session)} ${JSON.stringify(winId)}`, {
        stdio: 'ignore',
        timeout: 8000,
      });
    } catch {
      // Fall back to a bare tmux kill if the script failed for any reason.
      tmuxKillSession(session);
    }
  }

  const all = readAgentsFile();
  const filtered = all.filter(a => a.session !== session);
  if (filtered.length !== all.length) writeAgentsFile(filtered);
  return existed;
}

module.exports = {
  listAgents,
  pickNextSlot,
  killAgent,
  focusAgent,
  renameAgent,
  getAgentStatus,
  // Exposed for tests / debugging.
  _internals: {
    readAgentsFile,
    writeAgentsFile,
    tmuxHasSession,
    findJsonlForAgent,
    assignJsonls,
    lastAssistantText,
    encodeCwd,
  },
};
