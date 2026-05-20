/**
 * Home Command Centre preferences — manual ordering + project snoozes.
 *
 * Backed by tools/dashboard/data/home-prefs.json (gitignored runtime state):
 *
 *   {
 *     "projectOrder": ["lisbon", "agencybrain", ...],   // project names
 *     "todoOrder":    ["20260520-x.md", ...],           // todo filenames
 *     "snoozes":      { "sites": "2026-05-27T00:00:00.000Z", ... },   // by project name
 *     "todoSnoozes":  { "20260421-x.md": "2026-05-23T...", ... }      // by todo filename
 *   }
 *
 * A snooze value is the ISO datetime UNTIL which the item stays hidden.
 * Expired snoozes (project + todo) are pruned lazily on read.
 *
 *   getPrefs()                       → the full prefs object (with defaults).
 *   setOrder(kind, order)            → kind 'projects'|'todos'; persists.
 *   setSnooze(project, days)         → days>0 snoozes from now; days<=0 clears.
 *   setTodoSnooze(file, days)        → same, for a todo by filename.
 *   applyProjectPrefs(projects)      → { projects: ordered+unsnoozed,
 *                                        snoozed: [{name, until}] }
 *   applyTodoPrefs(todos)            → { todos: ordered+unsnoozed,
 *                                        snoozed: [{file, title, until}] }
 */

const fs = require('fs');
const path = require('path');

const PREFS_FILE = path.join(__dirname, '..', 'data', 'home-prefs.json');

const DEFAULTS = { projectOrder: [], todoOrder: [], snoozes: {}, todoSnoozes: {} };

function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
    return {
      projectOrder: Array.isArray(parsed.projectOrder) ? parsed.projectOrder : [],
      todoOrder: Array.isArray(parsed.todoOrder) ? parsed.todoOrder : [],
      snoozes: (parsed.snoozes && typeof parsed.snoozes === 'object') ? parsed.snoozes : {},
      todoSnoozes: (parsed.todoSnoozes && typeof parsed.todoSnoozes === 'object') ? parsed.todoSnoozes : {},
    };
  } catch {
    return { projectOrder: [], todoOrder: [], snoozes: {}, todoSnoozes: {} };
  }
}

function writeRaw(prefs) {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
}

/**
 * Read prefs, pruning any snooze whose until-date has passed. If pruning
 * changed anything, the cleaned prefs are written back.
 */
function getPrefs() {
  const prefs = readRaw();
  const now = Date.now();
  let changed = false;
  for (const bag of ['snoozes', 'todoSnoozes']) {
    for (const [key, until] of Object.entries(prefs[bag])) {
      const t = Date.parse(until);
      if (isNaN(t) || t <= now) {
        delete prefs[bag][key];
        changed = true;
      }
    }
  }
  if (changed) writeRaw(prefs);
  return prefs;
}

function setOrder(kind, order) {
  if (!Array.isArray(order)) throw new Error('order must be an array');
  const prefs = readRaw();
  if (kind === 'projects') prefs.projectOrder = order.map(String);
  else if (kind === 'todos') prefs.todoOrder = order.map(String);
  else throw new Error("kind must be 'projects' or 'todos'");
  writeRaw(prefs);
  return prefs;
}

function setSnoozeIn(bag, key, days) {
  const prefs = readRaw();
  const d = Number(days);
  if (!d || d <= 0) {
    delete prefs[bag][key];
  } else {
    const until = new Date(Date.now() + d * 24 * 3600 * 1000);
    prefs[bag][key] = until.toISOString();
  }
  writeRaw(prefs);
  return prefs;
}

function setSnooze(project, days) {
  if (!project) throw new Error('project is required');
  return setSnoozeIn('snoozes', project, days);
}

function setTodoSnooze(file, days) {
  if (!file) throw new Error('file is required');
  return setSnoozeIn('todoSnoozes', file, days);
}

/**
 * Order a list by a saved key-order array. Items present in `order` come
 * first in that sequence; everything else keeps its incoming order and is
 * appended. `keyOf` extracts the comparison key from each item.
 */
function orderBy(items, order, keyOf) {
  if (!order || !order.length) return items.slice();
  const rank = new Map(order.map((k, i) => [k, i]));
  const inOrder = [];
  const rest = [];
  for (const it of items) {
    if (rank.has(keyOf(it))) inOrder.push(it);
    else rest.push(it);
  }
  inOrder.sort((a, b) => rank.get(keyOf(a)) - rank.get(keyOf(b)));
  return inOrder.concat(rest);
}

/**
 * Filter out currently-snoozed projects and apply the manual order.
 * Returns { projects, snoozed }.
 */
function applyProjectPrefs(projects) {
  const prefs = getPrefs();
  const snoozedNames = new Set(Object.keys(prefs.snoozes));
  const visible = [];
  const snoozed = [];
  for (const p of projects) {
    if (snoozedNames.has(p.name)) {
      snoozed.push({ name: p.name, until: prefs.snoozes[p.name] });
    } else {
      visible.push(p);
    }
  }
  return {
    projects: orderBy(visible, prefs.projectOrder, p => p.name),
    snoozed,
  };
}

function applyTodoPrefs(todos) {
  const prefs = getPrefs();
  const snoozedKeys = new Set(Object.keys(prefs.todoSnoozes));
  const visible = [];
  const snoozed = [];
  for (const t of todos) {
    if (snoozedKeys.has(t.file)) {
      snoozed.push({ file: t.file, title: t.title, until: prefs.todoSnoozes[t.file] });
    } else {
      visible.push(t);
    }
  }
  return {
    todos: orderBy(visible, prefs.todoOrder, t => t.file),
    snoozed,
  };
}

module.exports = {
  getPrefs,
  setOrder,
  setSnooze,
  setTodoSnooze,
  applyProjectPrefs,
  applyTodoPrefs,
  _paths: { PREFS_FILE },
};
