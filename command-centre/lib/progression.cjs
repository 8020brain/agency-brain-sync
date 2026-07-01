'use strict';
// ============================================================================
// progression.cjs — team self-report progression for the Command Centre.
//
// Team members tick where they feel they are on the six trust-spine levels.
// This is SELF-DECLARED, never measured and never inferred from what anyone
// does. Each member writes ONLY their own file at
//   .team-config/progression/<slug>.json
// which the agency-brain gitignore lets sync team-wide (the same channel as
// .team-config/roles.json and .team-config/feedback/). Because each person only
// ever touches their own file, there are no merge conflicts. The owner/scout
// clone receives every member's file through the normal sync, and rollup()
// aggregates them locally — no elevated key, no cross-repo access, nothing
// routed to Mike's infrastructure. Same "local compute, shared via the repo"
// model as observability.cjs. Missing files degrade to empty, never throw.
//
// Owners and scouts do NOT self-report here: they track their own progression on
// the members-portal "Where You Are" rail (they have portal access; team members
// don't). In the Command Centre they only ever VIEW the team rollup. That split
// is enforced in server.cjs (POST /api/progression/toggle is team-only).
// ============================================================================

const fs = require('fs');
const path = require('path');

// Bundled wording — the canonical trust-spine, copied verbatim from the brain's
// projects/sites/8020members/trust-spine-locked.json (locked 2026-06-25, the same
// source the members-portal rail reads). Shipped inside the app so every agency
// renders identical labels regardless of what their own cloned brain contains.
// Step ids are L<level>.<index> — stable, derived by position, safe to persist.
const LEVELS = [
  { level: 1, name: 'Basic Tasks', blurb: 'using AI for real work', steps: [
    { id: 'L1.1', label: 'How AI can help you', note: "A quick primer on what today's AI really is, and how much it can take off your plate. Start here." },
    { id: 'L1.2', label: 'Install your brain', note: "Get it set up. It's yours." },
    { id: 'L1.3', label: 'Complete one real task', note: 'Use the brain on actual work - ideally a recurring task.' },
    { id: 'L1.4', label: 'Use it for something most days', note: 'Make it your default tool, not a one-off.' },
  ] },
  { level: 2, name: 'Context', blurb: 'the brain knows you', steps: [
    { id: 'L2.1', label: 'Install a voice tool', note: "Voice is 4x faster & adds richer context to AI. You don't need to format, just talk." },
    { id: 'L2.2', label: 'Tell it about you', note: 'Explain who you are - the more it knows the more it can help.' },
    { id: 'L2.3', label: 'Tell it about your business', note: 'Explain what you sell and how you add value.' },
    { id: 'L2.4', label: 'Tell it about your customers', note: 'Explain who you serve & why they buy.' },
  ] },
  { level: 3, name: 'Skills', blurb: 'tools you invoke', steps: [
    { id: 'L3.1', label: 'Use a skill', note: "Run one of the brain's skills on real work." },
    { id: 'L3.2', label: 'Edit a skill', note: 'Adapt a skill so it runs your way: your voice, your steps, your data.' },
    { id: 'L3.3', label: 'Build a skill', note: 'Create your own skill by doing a task, iterating, then creating the skill.' },
    { id: 'L3.4', label: 'Get inspired', note: 'See what others are building, take ideas, then build your own version.' },
  ] },
  { level: 4, name: 'Systems', blurb: 'the brain becomes your operating system', steps: [
    { id: 'L4.1', label: 'Join the pieces together', note: 'Wire skills, context, connections and data together so it can help with more complex tasks.' },
    { id: 'L4.2', label: 'Observe what your AI does', note: 'See what AI does (& where it goes wrong) builds trust in the system.' },
    { id: 'L4.3', label: 'Build the system that does the work', note: 'You stop running each task & instead create a system of work.' },
    { id: 'L4.4', label: 'Create feedback loops & logs', note: 'Logging everything enables you to reverse course. Tight feedback loops enable you to move faster.' },
  ] },
  { level: 5, name: 'Runs Without You', blurb: 'it runs on its own, hands off', steps: [
    { id: 'L5.1', label: 'Tasks run on a schedule', note: 'Tasks can run in the background on a schedule, even when your computer is off.' },
    { id: 'L5.2', label: 'Reactive to events & data', note: 'These can be manually triggered by you, occur at a set time/date, or based on a change in data.' },
    { id: 'L5.3', label: 'Set guardrails, thresholds & limits', note: 'Define the acceptable limits for different types of task/data.' },
    { id: 'L5.4', label: 'Get alerts as needed', note: 'Know when performance drifts out of those limits. Build trust and verify the system is running correctly.' },
  ] },
  { level: 6, name: 'Self-Improving', blurb: 'the frontier, still mostly ahead of us', steps: [
    { id: 'L6.1', label: 'Build evaluation criteria', note: "What are you scoring work against? Defining 'done' is hard but vital at this stage." },
    { id: 'L6.2', label: 'Self-scoring tasks', note: 'To self-improve, AI must first be able to judge itself against the definition of done.' },
    { id: 'L6.3', label: 'Systems that grow. Automatically', note: 'A system that not only improves the work, but fixes the system that created that work without input.' },
    { id: 'L6.4', label: 'Strategic direction stays human', note: 'Your goal is to set the direction & new goals over time, to steer the ship.' },
  ] },
];

const DIR_REL = ['.team-config', 'progression'];
const STEP_LEVEL = {}; // id -> level number (also the set of valid step ids)
let TOTAL_STEPS = 0;
for (const lv of LEVELS) for (const s of lv.steps) { STEP_LEVEL[s.id] = lv.level; TOTAL_STEPS++; }

// Match the team-usage slug convention (slugified email local-part), so a
// person's progression file lines up with the rest of their synced footprint.
function slugFor(email, name) {
  const base = String(email || '').split('@')[0] || String(name || '') || 'member';
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'member';
}

function fileFor(repoPath, slug) {
  return path.join(repoPath, ...DIR_REL, slug + '.json');
}

function readOne(repoPath, slug) {
  try { return JSON.parse(fs.readFileSync(fileFor(repoPath, slug), 'utf8')); } catch { return null; }
}

// Score = ticked steps × 0.25 (24 steps → 6.0 max), matching the members-portal
// computeLevelScore model. A level is "complete" when all four of its steps are
// ticked (that's when its pie wedge fills over on the portal).
function score(ticks) {
  const t = ticks || {};
  let ticked = 0;
  const perLevel = {};
  for (const lv of LEVELS) {
    let done = 0;
    for (const s of lv.steps) if (t[s.id]) { done++; ticked++; }
    perLevel[lv.level] = { done, total: lv.steps.length, complete: done === lv.steps.length };
  }
  return { ticked, total: TOTAL_STEPS, score: Math.round(ticked * 0.25 * 100) / 100, perLevel };
}

// This person's own self-report (their editable view). An absent file just means
// they haven't ticked anything yet — an empty read, not level 0 by decree.
function readSelf(repoPath, email, name) {
  const slug = slugFor(email, name);
  const rec = readOne(repoPath, slug) || {};
  const ticks = rec.ticks || {};
  return { slug, email: rec.email || email || '', name: rec.name || name || '', ticks, updated: rec.updated || null, ...score(ticks) };
}

function toggle(repoPath, email, name, stepId) {
  if (!STEP_LEVEL[stepId]) throw new Error('Unknown step.');
  const slug = slugFor(email, name);
  const file = fileFor(repoPath, slug);
  const rec = readOne(repoPath, slug) || {};
  rec.email = rec.email || email || '';
  if (name) rec.name = name;
  rec.ticks = rec.ticks || {};
  if (rec.ticks[stepId]) delete rec.ticks[stepId];
  else rec.ticks[stepId] = new Date().toISOString().slice(0, 10);
  rec.updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
  return { slug, email: rec.email, name: rec.name || '', ticks: rec.ticks, updated: rec.updated, ...score(rec.ticks) };
}

// The owner/scout rollup: every team member's self-report, joined to the roster
// for name + role (role is server-authoritative, from roles.json). Only people
// who have actually self-reported appear — a missing file is "not reported yet",
// never a fabricated level 0.
function rollup(repoPath) {
  const dir = path.join(repoPath, ...DIR_REL);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const roles = {};
  try {
    const r = JSON.parse(fs.readFileSync(path.join(repoPath, '.team-config', 'roles.json'), 'utf8'));
    for (const m of (r.members || [])) if (m.email) roles[m.email.toLowerCase()] = m;
  } catch { /* no roster on disk — fall back to the stored name */ }
  const out = [];
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const email = String(rec.email || '').toLowerCase();
    const r = roles[email] || {};
    out.push({
      name: r.name || rec.name || rec.email || f.replace(/\.json$/, ''),
      email: rec.email || '',
      role: (r.role || 'team'),
      updated: rec.updated || null,
      ...score(rec.ticks || {}),
    });
  }
  out.sort((a, b) => (b.score - a.score) || String(b.updated || '').localeCompare(String(a.updated || '')));
  return out;
}

module.exports = { LEVELS, readSelf, toggle, rollup, slugFor, score };
