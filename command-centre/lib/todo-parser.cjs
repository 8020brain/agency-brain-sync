/**
 * Todo parser for the Home Command Centre.
 *
 * Three readers, all pure (no side effects):
 *
 *   getProjectTodos(name)  → reads projects/<name>/todo.md, parses ## Active
 *                            checkbox lines, returns the first N as
 *                            [{ text, dispatchable: true }, ...].
 *   getMiscTodos()         → globs todo/*.md (not subdirs), parses YAML
 *                            frontmatter + body, returns
 *                            [{ title, created, due, source, project,
 *                               body, file }, ...]
 *   getProjectsList()      → globs projects/*\/, returns
 *                            [{ name, lastTouched, hasTodos, todoCount }, ...]
 *
 * Frontmatter parsing is hand-rolled (no external dep). Values are all
 * single-line strings; we don't need a real YAML engine here.
 *
 * Path resolution: BRAIN_ROOT comes from process.env.BRAIN_ROOT if set
 * (mirrors server.cjs), otherwise resolves to the repo root by walking
 * up from this file's dirname.
 */

const fs = require('fs');
const path = require('path');

const BRAIN_ROOT = process.env.BRAIN_ROOT
  || path.resolve(__dirname, '..', '..', '..');

const PROJECTS_DIR = path.join(BRAIN_ROOT, 'projects');
const TODO_DIR = path.join(BRAIN_ROOT, 'todo');

// How many ## Active items a project card surfaces by default.
// Project cards expand in place to show more; this controls the
// default-collapsed count.
const PROJECT_ACTIVE_DEFAULT = 3;

// Folders inside projects/ that are NOT projects (PROJECTS.md, CLAUDE.md
// are files at the same level; we filter by isDirectory below).
const PROJECT_DIR_DENY = new Set([
  'command-centre',  // the rebuild folder itself — not a project to dispatch into
]);

// ---- Frontmatter ---------------------------------------------------------

/**
 * Parse YAML frontmatter at the very top of a markdown file.
 * Returns { frontmatter: {...}, body: "..." }.
 * No frontmatter → { frontmatter: {}, body: full file }.
 *
 * Supports single-line key: value pairs only. Quoted values are unquoted.
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content };
  }
  const lines = content.split(/\r?\n/);
  // Find the closing --- (skip line 0 which is the opener).
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return { frontmatter: {}, body: content };

  const fm = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Strip surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[m[1]] = value;
  }
  const body = lines.slice(closeIdx + 1).join('\n').replace(/^\n+/, '');
  return { frontmatter: fm, body };
}

// ---- Project todos -------------------------------------------------------

/**
 * Read projects/<name>/todo.md and return the first N items from ## Active.
 * Items are markdown `- [ ]` lines (unchecked only; checked are filtered).
 * Returns [{ text, dispatchable: true }, ...].
 *
 * Missing file or no ## Active section → [].
 */
function getProjectTodos(name, limit = PROJECT_ACTIVE_DEFAULT) {
  return parseSectionTodos(name, 'Active', limit);
}

/**
 * Parse the unchecked `- [ ]` items under a named `## Section` heading.
 * Returns [{ text, dispatchable: true }, ...] up to `limit`.
 */
function parseSectionTodos(name, section, limit = Infinity) {
  const file = path.join(PROJECTS_DIR, name, 'todo.md');
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  const heading = new RegExp('^##\\s+' + section + '\\s*$', 'i');
  let inSection = false;
  const items = [];
  for (const line of lines) {
    if (heading.test(line)) { inSection = true; continue; }
    if (inSection && /^#{1,2}\s+/.test(line)) break;
    if (!inSection) continue;
    const m = line.match(/^\s*-\s*\[\s\]\s*(.+?)\s*$/);
    if (!m) continue;
    items.push({ text: m[1], dispatchable: true });
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * Backlog count (## Backlog section). Used by the project card to show
 * "+N more in backlog". Returns total `- [ ]` count in ## Backlog only.
 */
function getProjectBacklogCount(name) {
  return parseSectionTodos(name, 'Backlog').length;
}

/**
 * First prose paragraph of projects/<name>/README.md (skips the H1 title
 * and any blank lines). Used by the expand-in-place project card view.
 * Returns '' if no README or no prose found.
 */
function getProjectDescription(name) {
  const file = path.join(PROJECTS_DIR, name, 'README.md');
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const para = [];
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    if (!started) {
      if (!t || t.startsWith('#')) continue; // skip blanks + headings
      started = true;
      para.push(t);
    } else {
      if (!t) break; // paragraph ends at the first blank line
      if (t.startsWith('#')) break;
      para.push(t);
    }
  }
  return para.join(' ');
}

/**
 * Full detail for the expand-in-place project card view:
 *   { name, activeTodos, backlogTodos, description, hasDecisions,
 *     hasBuildLog, hasReadme }
 */
function getProjectDetail(name) {
  const dir = path.join(PROJECTS_DIR, name);
  const exists = f => fs.existsSync(path.join(dir, f));
  return {
    name,
    activeTodos: parseSectionTodos(name, 'Active'),
    backlogTodos: parseSectionTodos(name, 'Backlog'),
    description: getProjectDescription(name),
    hasReadme: exists('README.md'),
    hasDecisions: exists('decisions.md'),
    hasBuildLog: exists('build-log.md'),
  };
}

// ---- Misc todos ----------------------------------------------------------

/**
 * Glob todo/*.md (not subdirs) and return parsed entries.
 *
 * Skipped:
 *  - todo/CLAUDE.md (project rules, not a todo)
 *  - files inside todo/not urgent/ or any subdir
 *  - files without ANY content (size 0)
 *
 * Sorted: due-soonest first (overdue earliest), then by frontmatter
 * `created` desc, then by mtime desc.
 */
function getMiscTodos() {
  if (!fs.existsSync(TODO_DIR)) return [];

  const entries = fs.readdirSync(TODO_DIR, { withFileTypes: true })
    .filter(e => e.isFile()
      && e.name.endsWith('.md')
      && e.name !== 'CLAUDE.md')
    .map(e => {
      const abs = path.join(TODO_DIR, e.name);
      const stat = fs.statSync(abs);
      if (stat.size === 0) return null;
      const content = fs.readFileSync(abs, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);

      // Title fallback chain: frontmatter.title → first H1 → file basename.
      let title = frontmatter.title;
      if (!title) {
        const h1 = body.match(/^#\s+(.+?)\s*$/m);
        title = h1 ? h1[1] : e.name.replace(/\.md$/, '');
      }

      return {
        title,
        created: frontmatter.created || null,
        due: frontmatter.due || null,
        source: frontmatter.source || null,
        assignee: frontmatter.assignee || null,
        project: frontmatter.project || null,
        body: body.trim(),
        file: e.name,
        mtime: stat.mtime.toISOString(),
      };
    })
    .filter(Boolean);

  // Sort: items with due dates first (soonest first), then by created desc.
  entries.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    const ac = a.created || a.mtime;
    const bc = b.created || b.mtime;
    return bc.localeCompare(ac);
  });

  return entries;
}

// ---- Projects list -------------------------------------------------------

/**
 * Walk projects/*\/ and return one entry per project folder.
 *
 * lastTouched = most recent mtime of any direct child file/folder inside
 * the project folder. This stays accurate across edits anywhere in the
 * project tree (vs the folder's own mtime, which only updates on
 * add/remove at the top level).
 *
 * Filters out: PROJECT_DIR_DENY (currently just command-centre).
 *
 * Sorted by lastTouched desc.
 */
function getProjectsList() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];

  const out = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !PROJECT_DIR_DENY.has(e.name))
    .map(e => {
      const dir = path.join(PROJECTS_DIR, e.name);
      let mostRecent = 0;
      try {
        const children = fs.readdirSync(dir, { withFileTypes: true });
        for (const c of children) {
          if (c.name.startsWith('.')) continue;
          try {
            const st = fs.statSync(path.join(dir, c.name));
            if (st.mtimeMs > mostRecent) mostRecent = st.mtimeMs;
          } catch { /* unreadable child, skip */ }
        }
      } catch { /* unreadable dir, skip */ }
      if (mostRecent === 0) {
        // Fall back to dir mtime if nothing readable inside.
        try { mostRecent = fs.statSync(dir).mtimeMs; } catch {}
      }

      const todos = getProjectTodos(e.name, 999); // count all, not limited to 3
      return {
        name: e.name,
        lastTouched: mostRecent ? new Date(mostRecent).toISOString() : null,
        hasTodos: todos.length > 0,
        todoCount: todos.length,
        backlogCount: getProjectBacklogCount(e.name),
      };
    });

  out.sort((a, b) => {
    if (!a.lastTouched && !b.lastTouched) return 0;
    if (!a.lastTouched) return 1;
    if (!b.lastTouched) return -1;
    return b.lastTouched.localeCompare(a.lastTouched);
  });

  return out;
}

module.exports = {
  parseFrontmatter,
  getProjectTodos,
  getProjectBacklogCount,
  getProjectDescription,
  getProjectDetail,
  getMiscTodos,
  getProjectsList,
  // Paths exported for tests / debugging.
  _paths: { BRAIN_ROOT, PROJECTS_DIR, TODO_DIR },
};
