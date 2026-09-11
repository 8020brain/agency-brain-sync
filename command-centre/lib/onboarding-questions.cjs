'use strict';

const fs = require('fs');
const path = require('path');

// The onboarding board's question bank for an AGENCY brain.
//
// This IS the board's content. Every question carries its own destination
// (file + section heading) so filing is deterministic: the board never has to
// decide where an answer goes, because the question already knows. The order of
// topics is the order they unlock in; a topic opens once every question on the
// one before it is answered or passed.
//
// Source: the approved gateway wave + per-file question scripts in the brain's
// `agency-brain-context-setup` skill. Destinations map to the section headings
// that ship in `context/TEMPLATE-team-profile.md` and
// `context/TEMPLATE-business-overview.md`, plus the two optional files the skill
// creates (`context/brand-voice.md` and a first client folder).
//
// NOTE: final question wording is pending Mike's review of the question-waves
// walkthrough (projects/clientbrain/design/question-waves-walkthrough.html).
// When that's approved, update the `q`/`receipt` strings here and re-ship; the
// engine and destinations don't change.

const TOPICS = [
  {
    id: 'basics',
    title: 'The basics',
    kick: 'First things',
    sub: 'The essentials your brain builds everything else on.',
    thanks: "That's the basics down. Your brain knows what the agency is now.",
    optional: false,
    qs: [
      {
        id: 'basics-name',
        q: "What's the agency called, and what kind of clients do you mostly work for?",
        receipt: 'What the agency is called, and who it works for',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Company' }
      },
      {
        id: 'basics-team',
        q: 'Roughly how many people are on the team, and is it just you making the big calls or a few of you?',
        receipt: 'Team size, and who makes the big calls',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## The Team' }
      },
      {
        id: 'basics-sell',
        q: 'What does the agency sell? Retainers, projects, time by the hour, a mix?',
        receipt: 'What the agency sells',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Products & Pricing' }
      },
      {
        id: 'basics-clients',
        q: "How many active clients right now, and is one of them the obvious first one to set up in here?",
        receipt: 'Active client count, and the first one to set up',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Company' }
      }
    ]
  },
  {
    id: 'team',
    title: 'Your team',
    kick: 'Who does what',
    sub: 'This tells your brain who does what, so work goes to the right person.',
    thanks: "That's the team covered. Work will go to the right person now.",
    optional: false,
    qs: [
      {
        id: 'team-base',
        q: "Where's the team based? One city, several, or fully remote?",
        receipt: 'Where the team is based',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## The Team' }
      },
      {
        id: 'team-people',
        q: 'Walk me through each person on the team: name, role, one line on what they are strongest at, and their usual hours.',
        receipt: 'Who works here, and what each person is strongest at',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## Team Members' }
      },
      {
        id: 'team-comms',
        q: 'How does the team communicate day to day? Slack, Teams, ClickUp, something else?',
        receipt: 'How the team communicates',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## Communication Preferences' }
      },
      {
        id: 'team-cadence',
        q: "What's the regular meeting rhythm, and how do decisions get made, who has final say?",
        receipt: 'Meeting rhythm, and how decisions get made',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## How We Work' }
      },
      {
        id: 'team-strength',
        q: "What's the team strongest at as a unit, and what are you working on improving?",
        receipt: 'What the team is strongest at, and what it is improving',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## Strengths (as a team)' }
      },
      {
        id: 'team-values',
        q: 'What are the agency values? Three to five principles that guide how you work.',
        receipt: 'The agency values',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## Values' }
      }
    ]
  },
  {
    id: 'business',
    title: 'The business',
    kick: 'The numbers',
    sub: 'These keep answers, proposals and reports accurate.',
    thanks: "That's the business side saved. Your brain works from real numbers now.",
    optional: false,
    qs: [
      {
        id: 'biz-entity',
        q: "Legal entity name and the year the agency was founded? And any domains worth knowing about.",
        receipt: 'Legal name, year founded, and the domains',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Company' }
      },
      {
        id: 'biz-revenue',
        q: "What's the current revenue ballpark, monthly or annual, and the goal for the next 12 months?",
        receipt: 'Revenue ballpark, and the 12-month goal',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Revenue ([Current Month/Year])' }
      },
      {
        id: 'biz-products',
        q: 'Walk me through the main products or services: what each is, rough pricing, and customer count if you track it.',
        receipt: 'The main products and services, and their pricing',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Products & Pricing' }
      },
      {
        id: 'biz-priorities',
        q: 'What are the strategic priorities for this quarter or year? Three to five.',
        receipt: 'The strategic priorities',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Strategic Priorities' }
      },
      {
        id: 'biz-ops',
        q: 'What do the support cadence, content schedule and team capacity look like?',
        receipt: 'Support cadence, content schedule and capacity',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Operations' }
      },
      {
        id: 'biz-tech',
        q: "What's the tech stack? The main platforms and tools the agency runs on.",
        receipt: 'The tech stack',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Tech' }
      }
    ]
  },
  {
    id: 'voice',
    title: 'How you sound',
    kick: 'Your voice',
    sub: 'This is how everything written for you will sound. Optional, but it pays off fast.',
    thanks: "That's how you sound, saved. Everything drafted for you will sound like you.",
    optional: true,
    qs: [
      {
        id: 'voice-adjectives',
        q: "How would you describe the agency's voice in three words?",
        receipt: "The agency's voice in three words",
        dest: { file: 'context/brand-voice.md', section: '## Voice' }
      },
      {
        id: 'voice-banned',
        q: 'Any words or phrases the agency never uses? Corporate jargon, banned buzzwords?',
        receipt: 'Words the agency never uses',
        dest: { file: 'context/brand-voice.md', section: '## Words we avoid' }
      },
      {
        id: 'voice-signature',
        q: 'Any signature phrases the team uses a lot, or a line that sums the agency up?',
        receipt: 'Signature phrases, and the line that sums you up',
        dest: { file: 'context/brand-voice.md', section: '## Signature phrases' }
      },
      {
        id: 'voice-emails',
        q: 'How does the agency open and close client emails? Formal, casual, somewhere between?',
        receipt: 'How you open and close client emails',
        dest: { file: 'context/brand-voice.md', section: '## Email style' }
      }
    ]
  },
  {
    id: 'client',
    title: 'Your first client',
    kick: 'A worked example',
    sub: 'One client set up as a worked example, so the rest are quick to copy.',
    thanks: "That's your first client folder started. The rest copy from this one.",
    optional: true,
    qs: [
      {
        id: 'client-name',
        q: "Name of one client you'd like to set up first, and what do they do?",
        receipt: 'The first client, and what they do',
        dest: { file: 'clients/first-client/context.md', section: '## Overview' }
      },
      {
        id: 'client-contacts',
        q: 'Who are the key contacts on their side?',
        receipt: 'The key contacts on the client side',
        dest: { file: 'clients/first-client/context.md', section: '## Contacts' }
      },
      {
        id: 'client-work',
        q: 'What active campaigns or projects are running for them right now?',
        receipt: 'The active work running for them',
        dest: { file: 'clients/first-client/context.md', section: '## Active work' }
      },
      {
        id: 'client-kpis',
        q: 'What KPIs or goals matter most for that client?',
        receipt: 'The KPIs and goals that matter most',
        dest: { file: 'clients/first-client/context.md', section: '## Goals' }
      },
      {
        id: 'client-history',
        q: 'Any quirks or important history I should capture about them?',
        receipt: 'Quirks and important history',
        dest: { file: 'clients/first-client/context.md', section: '## History & quirks' }
      }
    ]
  }
];

// ---------------------------------------------------------------------------
// CLIENT brain question bank. Same engine, but the questions ask the CLIENT
// about THEIR OWN business, in client-facing language ("your business", "your
// AI brain", never "the agency", no file names), and file into the client
// brain's own context files. Source: the approved gateway wave + per-file
// scripts in the `client-brain-context-setup` skill.
//
// NOTE: final wording is pending Mike's review of the question-waves walkthrough
// (same hold as the agency bank). Engine and destinations don't change when it lands.

const CLIENT_TOPICS = [
  {
    id: 'basics',
    title: 'The basics',
    kick: 'First things',
    sub: 'The essentials your AI brain builds everything else on.',
    optional: false,
    thanks: "That's the basics down. Your AI brain knows what the business is now.",
    qs: [
      { id: 'c-basics-name', q: "What's the company called, and what does it do, in a sentence or two?",
        receipt: 'What the business is called, and what it does',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Company' } },
      { id: 'c-basics-customers', q: 'Who buys from you? Paint me a quick picture of a typical customer.',
        receipt: 'Who buys from you, and what they look like',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Company' } },
      { id: 'c-basics-money', q: 'How does the money come in? One main thing you sell, or a few?',
        receipt: 'How the money comes in',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Products & Pricing' } },
      { id: 'c-basics-size', q: "Roughly how big is the business? Team size, and a revenue ballpark if you're comfortable sharing one.",
        receipt: 'How big the business is',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Revenue ([Current Month/Year])' } }
    ]
  },
  {
    id: 'business',
    title: 'Your business',
    kick: 'The numbers',
    sub: 'These keep answers, proposals and reports accurate.',
    optional: false,
    thanks: "That's the business side saved. Your AI brain works from real numbers now.",
    qs: [
      { id: 'c-biz-entity', q: 'Legal entity name and the year the business was founded? And any domains worth knowing about.',
        receipt: 'Legal name, year founded, and the domains',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Company' } },
      { id: 'c-biz-revenue', q: "What's the current revenue ballpark, monthly or annual, and the goal for the next 12 months?",
        receipt: 'Revenue ballpark, and the 12-month goal',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Revenue ([Current Month/Year])' } },
      { id: 'c-biz-products', q: 'Walk me through the main products or services: what each is, rough pricing, and customer count if you track it.',
        receipt: 'The main products and services, and their pricing',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Products & Pricing' } },
      { id: 'c-biz-priorities', q: 'What are the priorities for this quarter or year, and the biggest headache right now?',
        receipt: 'The priorities, and the biggest headache',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Strategic Priorities' } },
      { id: 'c-biz-year', q: 'Where do you want the business to be a year from now?',
        receipt: 'Where you want to be in a year',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Strategic Priorities' } },
      { id: 'c-biz-ops', q: 'What do the support cadence, content schedule and team capacity look like?',
        receipt: 'Support cadence, content schedule and capacity',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Operations' } },
      { id: 'c-biz-tech', q: "What's the tech stack? The main platforms and tools the business runs on.",
        receipt: 'The tech stack',
        dest: { file: 'context/TEMPLATE-business-overview.md', section: '## Tech' } }
    ]
  },
  {
    id: 'team',
    title: 'Your team',
    kick: 'Who does what',
    sub: 'This tells your AI brain who does what, so work goes to the right person.',
    optional: false,
    thanks: "That's the team covered. Work will go to the right person now.",
    qs: [
      { id: 'c-team-base', q: "Where's the team based? One city, several, or fully remote?",
        receipt: 'Where the team is based',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## The Team' } },
      { id: 'c-team-people', q: "Walk me through each person on the team: name, role, one line on what they're strongest at, and their usual hours.",
        receipt: 'Who works here, and what each person is strongest at',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## Team Members' } },
      { id: 'c-team-comms', q: 'How does the team communicate day to day? Slack, Teams, ClickUp, something else?',
        receipt: 'How the team communicates',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## Communication Preferences' } },
      { id: 'c-team-cadence', q: "What's the regular meeting rhythm, and how do decisions get made, who has final say?",
        receipt: 'Meeting rhythm, and how decisions get made',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## How We Work' } },
      { id: 'c-team-values', q: "What are the business's values? Three to five principles that guide how you work.",
        receipt: 'The business values',
        dest: { file: 'context/TEMPLATE-team-profile.md', section: '## Values' } }
    ]
  },
  {
    id: 'voice',
    title: 'How you sound',
    kick: 'Your voice',
    sub: 'This is how everything written for you will sound. Optional, but it pays off fast.',
    optional: true,
    thanks: "That's how you sound, saved. Everything drafted for you will sound like you.",
    qs: [
      { id: 'c-voice-adjectives', q: "How would you describe the business's voice in three words?",
        receipt: "The business's voice in three words",
        dest: { file: 'context/brand-voice.md', section: '## Voice' } },
      { id: 'c-voice-banned', q: 'Any words or phrases the business never uses? Corporate jargon, banned buzzwords?',
        receipt: 'Words the business never uses',
        dest: { file: 'context/brand-voice.md', section: '## Words we avoid' } },
      { id: 'c-voice-signature', q: 'Any signature phrases the team uses a lot, or a line that sums the business up?',
        receipt: 'Signature phrases, and the line that sums you up',
        dest: { file: 'context/brand-voice.md', section: '## Signature phrases' } },
      { id: 'c-voice-emails', q: 'How does the business open and close customer emails? Formal, casual, somewhere between?',
        receipt: 'How you open and close customer emails',
        dest: { file: 'context/brand-voice.md', section: '## Email style' } }
    ]
  },
  {
    id: 'customer',
    title: 'Your first customer',
    kick: 'A worked example',
    sub: 'One customer set up as a worked example, so the rest are quick to copy.',
    optional: true,
    thanks: "That's your first customer folder started. The rest copy from this one.",
    qs: [
      { id: 'c-cust-name', q: "Name of one customer you'd like to set up first, and what do they do?",
        receipt: 'The first customer, and what they do',
        dest: { file: 'clients/first-customer/context.md', section: '## Overview' } },
      { id: 'c-cust-contacts', q: 'Who are the key contacts on their side?',
        receipt: 'The key contacts',
        dest: { file: 'clients/first-customer/context.md', section: '## Contacts' } },
      { id: 'c-cust-work', q: 'What active projects or work are running for them right now?',
        receipt: 'The active work running for them',
        dest: { file: 'clients/first-customer/context.md', section: '## Active work' } },
      { id: 'c-cust-goals', q: 'What goals matter most for that customer?',
        receipt: 'The goals that matter most',
        dest: { file: 'clients/first-customer/context.md', section: '## Goals' } },
      { id: 'c-cust-history', q: 'Any quirks or important history worth capturing about them?',
        receipt: 'Quirks and important history',
        dest: { file: 'clients/first-customer/context.md', section: '## History & quirks' } }
    ]
  }
];

// Build a flat id->question lookup for a topics array (tags each with its topic).
function buildIndex(topics) {
  const byId = {};
  topics.forEach(function (t) { t.qs.forEach(function (q) { q.topic = t.id; byId[q.id] = q; }); });
  return byId;
}

const AGENCY = { TOPICS: TOPICS, BY_ID: buildIndex(TOPICS) };
const CLIENT = { TOPICS: CLIENT_TOPICS, BY_ID: buildIndex(CLIENT_TOPICS) };

// The bank for a brain kind. Agency is the default; only a 'client' brain gets
// the client bank.
function bankFor(kind) { return String(kind) === 'client' ? CLIENT : AGENCY; }

// ---------------------------------------------------------------------------
// Per-brain override. A brain can tailor its own question set with a file at
// `.team-config/onboarding/questions.json` in the repo. The agency scout edits
// it in Claude Code to reword, drop, add or pre-shape a client's questions
// before handover. Shape:
//
//   { "topics": [
//       { "id": "...", "title": "...", "kick": "...", "sub": "...",
//         "optional": false, "thanks": "...",
//         "qs": [ { "id": "...", "q": "...", "receipt": "...",
//                   "dest": { "file": "context/TEMPLATE-...md", "section": "## ..." } } ] }
//   ] }
//
// `dest` is plumbing: it says which context file + heading the answer files
// into, so an added question needs one. Any missing or invalid file falls back
// to the built-in bank, so a bad hand-edit can never break the board.

function validTopics(topics) {
  if (!Array.isArray(topics) || !topics.length) return false;
  return topics.every(function (t) {
    return t && typeof t.id === 'string' && Array.isArray(t.qs) && t.qs.length
      && t.qs.every(function (q) {
        return q && typeof q.id === 'string' && typeof q.q === 'string'
          && q.dest && typeof q.dest.file === 'string' && typeof q.dest.section === 'string';
      });
  });
}

function bankFromFile(brainRoot) {
  let raw;
  try { raw = fs.readFileSync(path.join(brainRoot, '.team-config', 'onboarding', 'questions.json'), 'utf8'); }
  catch (e) { return null; } // no override file — normal
  let topics;
  try { const j = JSON.parse(raw); topics = j && j.topics; } catch (e) { return null; }
  if (!validTopics(topics)) return null;
  topics.forEach(function (t) {
    t.optional = !!t.optional; t.kick = t.kick || ''; t.sub = t.sub || ''; t.thanks = t.thanks || '';
    t.qs.forEach(function (q) { q.receipt = q.receipt || q.q; });
  });
  return { TOPICS: topics, BY_ID: buildIndex(topics) };
}

// The effective bank for a brain: its own questions.json override if present
// and valid, otherwise the built-in bank for its kind.
function resolveBank(brainRoot, kind) {
  return (brainRoot && bankFromFile(brainRoot)) || bankFor(kind);
}

// The built-in bank for a kind, as the JSON shape the override file uses — a
// starting point for tailoring (write it to the file, then edit).
function defaultFileFor(kind) {
  const b = bankFor(kind);
  return { topics: b.TOPICS.map(function (t) {
    return { id: t.id, title: t.title, kick: t.kick, sub: t.sub, optional: !!t.optional, thanks: t.thanks,
      qs: t.qs.map(function (q) { return { id: q.id, q: q.q, receipt: q.receipt, dest: { file: q.dest.file, section: q.dest.section } }; }) };
  }) };
}

function allQuestionIds() { return Object.keys(AGENCY.BY_ID); }

module.exports = {
  bankFor: bankFor,
  resolveBank: resolveBank,
  defaultFileFor: defaultFileFor,
  // Back-compat: the bare exports are the AGENCY bank.
  TOPICS: AGENCY.TOPICS,
  BY_ID: AGENCY.BY_ID,
  CLIENT_TOPICS: CLIENT_TOPICS,
  allQuestionIds: allQuestionIds
};
