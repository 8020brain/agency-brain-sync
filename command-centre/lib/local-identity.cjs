// CLAUDE.local.md — the per-person, never-synced file that tells THIS
// machine's Claude who it's working with. Written automatically: at JOIN by
// main.js (configure-identity), and self-healed at Command Centre start for
// brains from before this existed. It was previously left to a manual
// "Tell your brain who you are" click in the Command Centre, which meant a
// brand-new member's first Claude session had no local identity at all and
// filled the gap from whatever global instructions lived on the machine
// (Peter's owner-role confusion, 2026-07-30; the manual step retired by Mike,
// 2026-07-31).
'use strict';
const fs = require('fs');
const path = require('path');
const { readInstructions } = require('./instructions.cjs');

const IDENTITY_POINTER = 'Read CLAUDE.local.md in this folder if it exists, and treat it as part of your instructions. It is a local file (never synced) that tells you who is using this copy of the brain.';

function hasLocalIdentity(brainRoot) {
  return fs.existsSync(path.join(brainRoot, 'CLAUDE.local.md'));
}

// Role of record for an email, from the synced roster. config.json's snapshot
// is taken at login and goes stale the moment the role changes server-side
// (the old code wrote that snapshot, with an owner default on top — the
// second half of Peter's report). Resolve from roles.json wherever possible.
function roleFromRoster(brainRoot, email) {
  try {
    const roles = JSON.parse(fs.readFileSync(path.join(brainRoot, '.team-config', 'roles.json'), 'utf8'));
    const m = (roles.members || []).find((x) => String(x.email || '').toLowerCase() === String(email || '').toLowerCase().trim());
    return ((m && m.role) || '').toLowerCase();
  } catch (e) { return ''; }
}

// Name of record for an email, from the synced roster — same reason as the
// role above. config.json's memberName snapshot is whatever was typed when the
// seat was staged, and with nothing refreshing it a wrong name was
// uncorrectable (Peter Empson's agency seat stored the brand "Rok Systems", so
// every write said "You are the brain instance for Rok Systems", 2026-08-13).
// roles.json carries the live name, so callers prefer it over the snapshot.
function nameFromRoster(brainRoot, email) {
  try {
    const roles = JSON.parse(fs.readFileSync(path.join(brainRoot, '.team-config', 'roles.json'), 'utf8'));
    const m = (roles.members || []).find((x) => String(x.email || '').toLowerCase() === String(email || '').toLowerCase().trim());
    return ((m && m.name) || '').trim();
  } catch (e) { return ''; }
}

function teamNameFromRoster(brainRoot) {
  try {
    const roles = JSON.parse(fs.readFileSync(path.join(brainRoot, '.team-config', 'roles.json'), 'utf8'));
    return roles.team_name || '';
  } catch (e) { return ''; }
}

function ensureGitignored(brainRoot, name) {
  const gi = path.join(brainRoot, '.gitignore');
  let txt = '';
  try { txt = fs.readFileSync(gi, 'utf8'); } catch (e) { /* no .gitignore yet */ }
  if (txt.split(/\r?\n/).some((l) => l.trim() === name)) return;
  fs.appendFileSync(gi, (txt && !txt.endsWith('\n') ? '\n' : '') + name + '\n');
}

// Point the shared instruction file at the local file, once. Idempotent + safe:
// it's the same line for everyone and is meant to sync. In a converted brain
// that file is AGENTS.md and the CLAUDE.md beside it is a two-line pointer, so
// resolve which is which: splicing a line into the pointer would leave the rule
// in the one file that is supposed to hold nothing but the @-import.
function ensureIdentityPointer(brainRoot) {
  const found = readInstructions(brainRoot);
  if (!found) return; // no instruction file → nothing to point from
  if (found.text.includes('CLAUDE.local.md')) return; // already points at it
  const lines = found.text.split('\n');
  let at = 0; // after the first top-level heading, else the very top
  for (let i = 0; i < lines.length; i++) { if (/^#\s/.test(lines[i])) { at = i + 1; break; } }
  lines.splice(at, 0, '', IDENTITY_POINTER);
  fs.writeFileSync(found.file, lines.join('\n'));
}

function writeLocalIdentity({ brainRoot, name, role, teamKind, teamName }) {
  const who = String(name || '').trim();
  if (!who) return null;
  const r = String(role || 'team').toLowerCase();
  const agency = String(teamName || '').trim()
    || (teamKind === 'client' ? 'your business' : 'your agency');
  // A client brain is white-label: this file lands in the CLIENT's repo, where
  // naming the product would tell them who their agency buys from.
  const instance = teamKind === 'client' ? 'brain instance' : 'Agency Brain instance';
  const article = /^[aeiou]/i.test(r) ? 'an' : 'a';
  const body = '# CLAUDE.local.md — local identity (per-person, never synced)\n\n'
    + `You are the ${instance} for **${who}**, ${article} **${r}** at **${agency}**.\n\n`
    + 'This file is local to this machine and is never synced to the team.\n';
  ensureIdentityPointer(brainRoot);
  ensureGitignored(brainRoot, 'CLAUDE.local.md');
  fs.writeFileSync(path.join(brainRoot, 'CLAUDE.local.md'), body);
  return { name: who, role: r, agency };
}

module.exports = { IDENTITY_POINTER, hasLocalIdentity, roleFromRoster, nameFromRoster, teamNameFromRoster, writeLocalIdentity };
