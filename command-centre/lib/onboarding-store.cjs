'use strict';

// Storage for the onboarding board. Everything lives in the SYNCED repo, under
// `.team-config/onboarding/`, so passing a question to a teammate is just a
// change to a shared file their app picks up within a minute. No server, no DB.
//
//   answers.jsonl  append-only log of every event (answer, pass). The history.
//   status.json    the current picture the board renders from.
//
// status.json shape:
//   {
//     drafts:      { <qid>: { text, by, byEmail, at } },  // typed, not submitted
//     answers:     { <qid>: { text, by, byEmail, at } },  // submitted + filed
//     assignments: { <qid>: <email> },   // only set once a question is passed
//     skipped:     { <topicId>: { by, byEmail, at } },
//     updated:     <iso>
//   }
//
// Two phases on purpose: a person types answers (drafts, autosaved on blur so
// nothing is lost and a collapsed row can be re-opened to edit), then clicks
// "Submit my answers" on the card, which finalises the drafts into answers and
// files them into the context files. Passing a question is immediate.
//
// A question with no assignment belongs to the owner by default (the board
// decides that, not the store). The store just records facts.

const fs = require('fs');
const path = require('path');

function dir(brainRoot) { return path.join(brainRoot, '.team-config', 'onboarding'); }
function statusPath(brainRoot) { return path.join(dir(brainRoot), 'status.json'); }
function logPath(brainRoot) { return path.join(dir(brainRoot), 'answers.jsonl'); }

function ensureDir(brainRoot) { fs.mkdirSync(dir(brainRoot), { recursive: true }); }

function read(brainRoot) {
  try {
    const raw = fs.readFileSync(statusPath(brainRoot), 'utf8');
    const j = JSON.parse(raw);
    return {
      drafts: j.drafts || {},
      answers: j.answers || {},
      assignments: j.assignments || {},
      skipped: j.skipped || {},
      updated: j.updated || null
    };
  } catch (e) {
    return { drafts: {}, answers: {}, assignments: {}, skipped: {}, updated: null };
  }
}

function write(brainRoot, state) {
  ensureDir(brainRoot);
  state.updated = new Date().toISOString();
  fs.writeFileSync(statusPath(brainRoot), JSON.stringify(state, null, 2) + '\n');
  return state;
}

// Append one event to the log. Kept separate from status so the log is a true
// append-only history even if status.json is ever rebuilt from it.
function logEvent(brainRoot, event) {
  ensureDir(brainRoot);
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, event));
  fs.appendFileSync(logPath(brainRoot), line + '\n');
}

// Save (or clear) a draft as the person types and moves on. Not logged to the
// history — that would spam the log on every blur; only submits/passes are.
function recordDraft(brainRoot, qid, text, by, byEmail) {
  const state = read(brainRoot);
  const t = String(text == null ? '' : text).trim();
  if (!t) delete state.drafts[qid];
  else state.drafts[qid] = { text: t, by: by || '', byEmail: byEmail || '', at: new Date().toISOString() };
  write(brainRoot, state);
  return state;
}

// Finalise one answer (the "Save my context" step). Takes the text explicitly
// (the board sends the current answers with the save, so a just-typed last
// answer can't be missed), clears any draft, and logs it. The caller files it
// into its destination file separately.
function recordFinalAnswer(brainRoot, qid, text, by, byEmail) {
  const state = read(brainRoot);
  const t = String(text == null ? '' : text).trim();
  if (!t) return { state: state, text: null };
  state.answers[qid] = { text: t, by: by || '', byEmail: byEmail || '', at: new Date().toISOString() };
  delete state.drafts[qid];
  write(brainRoot, state);
  logEvent(brainRoot, { type: 'answer', qid: qid, by: by, byEmail: byEmail });
  return { state: state, text: t };
}

function recordPass(brainRoot, qid, toEmail, by, byEmail) {
  const state = read(brainRoot);
  state.assignments[qid] = toEmail;
  delete state.drafts[qid]; // a passed question leaves this person's list; drop the stale draft
  write(brainRoot, state);
  logEvent(brainRoot, { type: 'pass', qid: qid, to: toEmail, by: by, byEmail: byEmail });
  return state;
}

// Take a passed question back (un-assign it), so it returns to the owner's list
// and can be answered or passed to someone else.
function recordReclaim(brainRoot, qid, by, byEmail) {
  const state = read(brainRoot);
  delete state.assignments[qid];
  write(brainRoot, state);
  logEvent(brainRoot, { type: 'reclaim', qid: qid, by: by, byEmail: byEmail });
  return state;
}

// Skip (or un-skip) an optional topic. Global: it's the agency deciding this
// section doesn't apply, not a per-person choice.
function recordSkip(brainRoot, topicId, skip, by, byEmail) {
  const state = read(brainRoot);
  if (skip) state.skipped[topicId] = { by: by || '', byEmail: byEmail || '', at: new Date().toISOString() };
  else delete state.skipped[topicId];
  write(brainRoot, state);
  logEvent(brainRoot, { type: skip ? 'skip' : 'unskip', topicId: topicId, by: by, byEmail: byEmail });
  return state;
}

module.exports = {
  read: read,
  write: write,
  logEvent: logEvent,
  recordDraft: recordDraft,
  recordFinalAnswer: recordFinalAnswer,
  recordPass: recordPass,
  recordReclaim: recordReclaim,
  recordSkip: recordSkip,
  _dir: dir
};
