// ============================================================================
// observability.cjs — agency-brain health for the Command Centre.
// Ported from the brain dashboard's observability lib (2026-05-21) so the
// agency app inherits the SAME compute. Observes the repo it's pointed at
// (BRAIN_ROOT = the member's agency brain): no elevated key, no cross-repo
// access. Missing files degrade to empty, never throw.
//
//   - maturity      ← SKILL.md `maturity:` frontmatter (default 'live')
//   - last improved ← one `git log` pass over .claude/skills
//   - runs          ← session index (omitted for an agency clone with none)
//   - open flags    ← .team-config/feedback/<skill>.md (written by /flag-skill)
//   - drift         ← current hash vs committed .team-config/skill-hashes.json
//   - automation    ← .claude/chores-state.json
//   - team table    ← .team-config/roles.json (server-generated cache; empty
//                     if not present — roster is server-authoritative)
//
// Cross-platform: every git call goes through execFileSync with an argument
// array (NO shell), so single quotes / pipes / % in format strings survive
// identically on macOS and Windows. Do not switch back to execSync with a
// string command — it silently empties git-derived data under cmd.exe.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BRAIN_ROOT = process.env.BRAIN_ROOT || process.cwd();

function safeGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

function daysBetween(isoDate, now = new Date()) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d)) return null;
  return Math.floor((now - d) / 86400000);
}

// ---- skills -----------------------------------------------------------------
function listSkillDirs(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir).filter(name => {
    if (name.startsWith('z') || name.startsWith('.')) return false;
    let st;
    try { st = fs.statSync(path.join(skillsDir, name)); } catch { return false; }
    return st.isDirectory();
  });
}

function parseFrontmatter(skillDir) {
  const md = path.join(skillDir, 'SKILL.md');
  const out = { maturity: 'live', description: '' };
  if (!fs.existsSync(md)) return out;
  let text = '';
  try { text = fs.readFileSync(md, 'utf8'); } catch { return out; }
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return out;
  const mMat = fm[1].match(/^maturity:\s*(draft|live|trusted)\s*$/m);
  if (mMat) out.maturity = mMat[1];
  const mDesc = fm[1].match(/^description:\s*(.+?)\s*$/m);
  if (mDesc) out.description = mDesc[1].replace(/^["']|["']$/g, '').slice(0, 500);
  return out;
}

// One git pass: most-recent commit (date + author) touching each skill folder.
// git log is reverse-chronological, so the first time we see a skill path that
// is its last-improved commit.
function gitLastImprovedMap(repoPath) {
  const map = {};
  const raw = safeGit(['log', '--no-merges', '--pretty=format:@@@%cs|%an', '--name-only', '--', '.claude/skills'], repoPath);
  if (!raw) return map;
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@@')) {
      const [date, ...rest] = line.slice(3).split('|');
      cur = { date, author: rest.join('|') };
    } else if (line.startsWith('.claude/skills/') && cur) {
      const m = line.match(/^\.claude\/skills\/([^/]+)\//);
      if (m && !map[m[1]]) map[m[1]] = cur; // first seen = most recent
    }
  }
  return map;
}

// ---- session index (runs) ---------------------------------------------------
function loadSessions(indexPath) {
  if (!indexPath || !fs.existsSync(indexPath)) return [];
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(indexPath, 'utf8'); } catch { return out; }
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    let s;
    try { s = JSON.parse(line); } catch { continue; }
    if (!s.date) continue;
    const skills = (s.skillsUsed || []).map(sk => (typeof sk === 'string' ? sk : (sk && sk.name) || '')).filter(Boolean);
    out.push({ date: s.date, skills });
  }
  return out;
}

function runCounts(sessions, sinceDays, now = new Date()) {
  const counts = {};
  for (const s of sessions) {
    if (sinceDays != null) {
      const age = daysBetween(s.date, now);
      if (age == null || age > sinceDays) continue;
    }
    for (const sk of s.skills) counts[sk] = (counts[sk] || 0) + 1;
  }
  return counts;
}

function activityPerDay(sessions, days, now = new Date()) {
  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    buckets[d.toISOString().slice(0, 10)] = 0;
  }
  for (const s of sessions) {
    if (s.date in buckets) buckets[s.date] += 1;
  }
  return Object.entries(buckets).map(([date, count]) => ({ date, count }));
}

// ---- flags ------------------------------------------------------------------
function readFlags(repoPath) {
  const dir = path.join(repoPath, '.team-config', 'feedback');
  const perSkill = {};
  const entries = [];
  if (!fs.existsSync(dir)) return { perSkill, total: 0, entries };
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const skill = f.replace(/\.md$/, '');
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const n = (text.match(/^flagged_at:/gm) || []).length;
    if (n > 0) { perSkill[skill] = n; total += n; }
    // Parse each frontmatter-delimited flag block into a renderable entry.
    const re = /---\n([\s\S]*?)\n---\n([\s\S]*?)(?=\n---\n|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const fm = m[1];
      const get = (k) => { const mm = fm.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')); return mm ? mm[1].trim() : ''; };
      entries.push({ skill, flaggedBy: get('flagged_by'), client: get('client'), flaggedAt: get('flagged_at'), body: (m[2] || '').trim() });
    }
  }
  entries.sort((a, b) => (b.flaggedAt || '').localeCompare(a.flaggedAt || ''));
  return { perSkill, total, entries };
}

// ---- drift (needs a committed baseline) -------------------------------------
function hashSkill(skillDir) {
  const h = crypto.createHash('sha256');
  const walk = (dir, base) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    let files = [];
    for (const e of entries) {
      if (['node_modules', '.cache', '__pycache__', '.git'].includes(e.name) || e.name === '.DS_Store') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...walk(full, base));
      else if (e.isFile()) files.push(path.relative(base, full));
    }
    return files.sort();
  };
  for (const rel of walk(skillDir, skillDir)) {
    h.update(rel); h.update('\0');
    try { h.update(fs.readFileSync(path.join(skillDir, rel))); } catch {}
    h.update('\0');
  }
  return h.digest('hex');
}

function readBaseline(repoPath) {
  const f = path.join(repoPath, '.team-config', 'skill-hashes.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// ---- automation health (chores) ---------------------------------------------
function automationHealth(repoPath) {
  const f = path.join(repoPath, '.claude', 'chores-state.json');
  if (!fs.existsSync(f)) return null;
  let state;
  try { state = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  const now = Date.now();
  const tasks = Object.entries(state.tasks || {}).map(([id, t]) => {
    const lastRun = t.lastRun ? new Date(t.lastRun).getTime() : null;
    const minsAgo = lastRun ? Math.floor((now - lastRun) / 60000) : null;
    return {
      id,
      label: t.label || id,
      cadence: t.cron ? `cron ${t.cron}` : (t.cadenceMinutes ? `every ${t.cadenceMinutes}m` : '—'),
      enabled: t.enabled !== false,
      lastRun: t.lastRun || null,
      minsAgo,
      lastResult: (t.lastResult || '').slice(0, 80),
      failCount: t.failCount || 0,
    };
  });
  const failing = tasks.filter(t => t.failCount > 0).length;
  return { total: tasks.length, enabled: tasks.filter(t => t.enabled).length, failing, tasks };
}

// ---- team table (roles.json = server-generated cache; empty if absent) ------
function teamTable(repoPath) {
  const f = path.join(repoPath, '.team-config', 'roles.json');
  if (!fs.existsSync(f)) return null;
  let roles;
  try { roles = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  const members = (roles.members || []).map(m => {
    const log = safeGit(['log', '--author=' + m.email, '-1', '--pretty=format:%cs|%s'], repoPath);
    let lastActive = null, lastThing = '';
    if (log) {
      const [date, ...rest] = log.split('|');
      lastActive = date;
      lastThing = rest.join('|').slice(0, 80);
    }
    return { name: m.name || m.email, email: m.email, role: m.role || 'team', lastActive, lastThing };
  });
  const roleOrder = { owner: 0, scout: 1, team: 2 };
  members.sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9));
  return { teamName: roles.team_name || roles.team_slug || 'Team', members };
}

// Anchor for "improvements": only count work done since this brain was set up
// on THIS machine, so a member never sees the template's / owner's pre-clone
// history as if it were their own. Priority: an explicit .claude/dashboard-since
// marker (ISO date), else the moment this clone was created (.git birth time).
// Returns a ms timestamp, or null to count everything (no anchor available).
function improvementsSince(repoPath) {
  try {
    const marker = path.join(repoPath, '.claude', 'dashboard-since');
    if (fs.existsSync(marker)) {
      const d = new Date(fs.readFileSync(marker, 'utf8').trim());
      if (!isNaN(d.getTime())) return d.getTime();
    }
  } catch {}
  try {
    const st = fs.statSync(path.join(repoPath, '.git'));
    if (st.birthtimeMs && st.birthtimeMs > 0) return st.birthtimeMs;
  } catch {}
  return null;
}

// Curated "Start here" set for new members: an ordered list of skill names in
// .claude/featured-skills.json. Returns the ones that actually exist, in order,
// with their description for display. Absent/invalid file → empty (the view
// just shows the full alphabetical list).
function readFeatured(repoPath, skills) {
  try {
    const f = path.join(repoPath, '.claude', 'featured-skills.json');
    if (!fs.existsSync(f)) return [];
    const names = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(names)) return [];
    const byName = {};
    for (const s of skills) byName[s.name] = s;
    return names
      .map(n => byName[n])
      .filter(Boolean)
      .map(s => ({ name: s.name, description: s.description || '', maturity: s.maturity }));
  } catch { return []; }
}

// ---- main -------------------------------------------------------------------
function getObservability(opts = {}) {
  const repoPath = opts.repoPath || BRAIN_ROOT;
  const includeTeam = opts.includeTeam !== false; // default true for the agency app
  const now = new Date();
  const skillsDir = path.join(repoPath, '.claude', 'skills');

  const names = listSkillDirs(skillsDir);
  const lastImproved = gitLastImprovedMap(repoPath);
  const sessions = loadSessions(opts.sessionIndexPath);
  const runs7d = runCounts(sessions, 7, now);
  const runs30d = runCounts(sessions, 30, now);
  const flags = readFlags(repoPath);
  const baseline = readBaseline(repoPath);
  const sinceTs = improvementsSince(repoPath);

  const skills = names.map(name => {
    const skillDir = path.join(skillsDir, name);
    const { maturity, description } = parseFrontmatter(skillDir);
    const gi = lastImproved[name] || null;
    const daysStale = gi ? daysBetween(gi.date, now) : null;
    let drift = null;
    if (baseline && baseline.skills && baseline.skills[name] != null) {
      drift = baseline.skills[name] !== hashSkill(skillDir);
    }
    return {
      name,
      maturity: (baseline && baseline.maturity && baseline.maturity[name]) || maturity,
      description,
      lastImproved: gi ? gi.date : null,
      lastImprovedBy: gi ? gi.author : null,
      daysStale,
      runs7d: runs7d[name] || 0,
      runs30d: runs30d[name] || 0,
      flags: flags.perSkill[name] || 0,
      drift,
    };
  });

  const maturityDist = { draft: 0, live: 0, trusted: 0 };
  for (const s of skills) maturityDist[s.maturity] = (maturityDist[s.maturity] || 0) + 1;

  const hasRuns = sessions.length > 0;
  const recentlyImproved = skills
    .filter(s => s.daysStale != null && s.daysStale <= 30
      && (sinceTs == null || new Date(s.lastImproved + 'T00:00:00Z').getTime() >= sinceTs))
    .sort((a, b) => (a.daysStale - b.daysStale))
    .slice(0, 12);
  const stale = skills
    .filter(s => s.daysStale != null && s.daysStale > 90)
    .sort((a, b) => b.daysStale - a.daysStale)
    .slice(0, 12);
  const topUsed = hasRuns
    ? [...skills].filter(s => s.runs30d > 0).sort((a, b) => b.runs30d - a.runs30d).slice(0, 12)
    : [];

  // improvements per ISO week, last 6 weeks (from the last-improved map)
  const weekBuckets = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i * 7);
    weekBuckets[d.toISOString().slice(0, 10)] = 0;
  }
  const weekKeys = Object.keys(weekBuckets).map(k => new Date(k + 'T00:00:00Z').getTime());
  for (const s of skills) {
    if (!s.lastImproved) continue;
    const t = new Date(s.lastImproved + 'T00:00:00Z').getTime();
    if (sinceTs != null && t < sinceTs) continue; // ignore pre-clone history
    for (let i = weekKeys.length - 1; i >= 0; i--) {
      if (t >= weekKeys[i]) { weekBuckets[Object.keys(weekBuckets)[i]]++; break; }
    }
  }
  const improvementsPerWeek = Object.entries(weekBuckets).map(([weekStart, count]) => ({ weekStart, count }));

  return {
    repoPath,
    generatedAt: now.toISOString(),
    summary: {
      totalSkills: skills.length,
      maturityDist,
      openFlags: flags.total,
      improved30d: recentlyImproved.length,
      runs7d: Object.values(runs7d).reduce((a, b) => a + b, 0),
      hasRuns,
      hasDrift: !!baseline,
      driftCount: skills.filter(s => s.drift === true).length,
    },
    skills,
    featured: readFeatured(repoPath, skills),
    recentlyImproved,
    stale,
    topUsed,
    flagEntries: flags.entries || [],
    activityPerDay: hasRuns ? activityPerDay(sessions, 14, now) : [],
    improvementsPerWeek,
    automation: automationHealth(repoPath),
    team: includeTeam ? teamTable(repoPath) : null,
  };
}

module.exports = { getObservability, BRAIN_ROOT };
