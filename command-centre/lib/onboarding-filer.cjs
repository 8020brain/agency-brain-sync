'use strict';

// The deterministic onboarding filer.
//
// It takes ONE answered question and writes the answer into its destination
// file, under the section the question already named. It invents nothing: it
// only ever writes the reader's own words, a fixed label, and a source line.
//
// Two design choices, both deliberate:
//  1. It APPENDS a clearly-marked block under the right section rather than
//     trying to replace the `[bracketed placeholders]` in the TEMPLATE file.
//     Matching a question to an exact placeholder is guesswork; appending a
//     labelled block under a known heading is not. The conversational setup
//     skill still tidies placeholders when someone talks it through instead.
//  2. Every block is wrapped in `<!-- ob:<qid> -->` markers, so answering the
//     same question again UPDATES its own block in place. That is also how a
//     contradiction is detected: a new answer that differs from the one already
//     filed is reported back so the caller can note it.
//
// Pure and synchronous. No model calls, no network. Same inputs, same file.

const fs = require('fs');
const path = require('path');

// Turn "context/TEMPLATE-team-profile.md" into "Team Profile" for the # title
// of a file we have to create from scratch (destination file missing).
function titleFromPath(relFile) {
  const base = path.basename(relFile, '.md').replace(/^TEMPLATE-/, '');
  return base
    .split(/[-_]/)
    .map(function (w) { return w ? w[0].toUpperCase() + w.slice(1) : w; })
    .join(' ');
}

function isoDate(at) {
  // Date a human reads. Local zone on purpose (the person filing sees their own
  // day), not a UTC instant.
  const d = at ? new Date(at) : new Date();
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function blockFor(q, answer, byName, at) {
  const label = q.receipt || q.q;
  const who = byName || 'the team';
  return '<!-- ob:' + q.id + ' -->\n'
    + '**' + label + '**\n\n'
    + String(answer).trim() + '\n\n'
    + '_Answered by ' + who + ', ' + isoDate(at) + '_\n'
    + '<!-- /ob:' + q.id + ' -->';
}

// Pull the current answer text (between the answer label and the source line)
// out of an existing block, so we can tell a re-answer from a repeat.
function answerInsideBlock(block) {
  const m = block.match(/\*\*[^\n]*\*\*\n\n([\s\S]*?)\n\n_Answered by /);
  return m ? m[1].trim() : null;
}

// File one answer. Returns { file, section, action, contradiction }.
//   action: 'added' | 'updated' | 'unchanged'
//   contradiction: null | { was, now }
function fileAnswer(brainRoot, q, answer, byName, at) {
  if (!brainRoot) throw new Error('fileAnswer: brainRoot required');
  if (!q || !q.id || !q.dest || !q.dest.file || !q.dest.section) {
    throw new Error('fileAnswer: question missing id/dest');
  }
  const text = String(answer == null ? '' : answer).trim();
  if (!text) throw new Error('fileAnswer: empty answer, nothing to file');

  const abs = path.join(brainRoot, q.dest.file);
  const section = q.dest.section; // e.g. "## Team Members"
  const marker = '<!-- ob:' + q.id + ' -->';
  const endMarker = '<!-- /ob:' + q.id + ' -->';
  const block = blockFor(q, text, byName, at);

  let content = '';
  try { content = fs.readFileSync(abs, 'utf8'); } catch (e) { content = ''; }

  // Fresh file: title + section + block.
  if (!content.trim()) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const out = '# ' + titleFromPath(q.dest.file) + '\n\n' + section + '\n\n' + block + '\n';
    fs.writeFileSync(abs, out);
    return { file: q.dest.file, section: section, action: 'added', contradiction: null };
  }

  // Already answered before? Replace the block in place and flag a real change.
  const startIdx = content.indexOf(marker);
  if (startIdx !== -1) {
    const endIdx = content.indexOf(endMarker, startIdx);
    if (endIdx !== -1) {
      const oldBlock = content.slice(startIdx, endIdx + endMarker.length);
      const was = answerInsideBlock(oldBlock);
      if (was === text) {
        return { file: q.dest.file, section: section, action: 'unchanged', contradiction: null };
      }
      const next = content.slice(0, startIdx) + block + content.slice(endIdx + endMarker.length);
      fs.writeFileSync(abs, next);
      return {
        file: q.dest.file, section: section, action: 'updated',
        contradiction: (was && was !== text) ? { was: was, now: text } : null
      };
    }
  }

  // New answer. Append the block under its section heading if present, else add
  // the heading at the end and put the block under it.
  const lines = content.split('\n');
  const headingIdx = lines.findIndex(function (l) { return l.trim() === section.trim(); });

  if (headingIdx === -1) {
    const trimmed = content.replace(/\s+$/, '');
    fs.writeFileSync(abs, trimmed + '\n\n' + section + '\n\n' + block + '\n');
    return { file: q.dest.file, section: section, action: 'added', contradiction: null };
  }

  // Insert at the end of that section (just before the next `## ` heading, or
  // at end of file).
  let insertAt = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) { insertAt = i; break; }
  }
  // Trim trailing blank lines inside the section so spacing stays tidy.
  let tail = insertAt;
  while (tail > headingIdx + 1 && lines[tail - 1].trim() === '') tail--;
  const before = lines.slice(0, tail);
  const after = lines.slice(insertAt);
  const out = before.concat(['', block, '']).concat(after).join('\n');
  fs.writeFileSync(abs, out.replace(/\n{3,}/g, '\n\n'));
  return { file: q.dest.file, section: section, action: 'added', contradiction: null };
}

// Regenerate `.claude/context-setup-status.md` from a summary the caller builds
// off the onboarding status. Deterministic: same summary, same file. Contras is
// an array of { qid, label, was, now, by, at } noted for a human to settle.
function syncStatusDoc(brainRoot, summary) {
  const abs = path.join(brainRoot, '.claude', 'context-setup-status.md');
  const files = summary.files || []; // [{ label, done }]
  const done = files.filter(function (f) { return f.done; }).length;
  const contradictions = summary.contradictions || [];

  let out = '# Agency Brain Context Setup Status\n\n';
  out += 'Tracked by the Set up your brain board and the context-setup skill. Do not hand-edit; both keep it current.\n\n';
  out += '## Files\n\n';
  files.forEach(function (f) {
    out += '- [' + (f.done ? 'x' : ' ') + '] `' + f.label + '`\n';
  });
  out += '\n## Progress\n\n';
  out += '**Status:** ' + done + '/' + files.length + ' complete\n';
  out += '**Last updated:** ' + isoDate() + '\n\n';
  out += '## Notes\n\n';
  if (!contradictions.length) {
    out += '- No contradictions to settle.\n';
  } else {
    contradictions.forEach(function (c) {
      out += '- **To settle** (' + isoDate(c.at) + ', from ' + (c.by || 'someone') + '): '
        + (c.label || c.qid) + ' was "' + c.was + '", now "' + c.now + '". Which is right?\n';
    });
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, out);
  return abs;
}

module.exports = {
  fileAnswer: fileAnswer,
  syncStatusDoc: syncStatusDoc,
  _titleFromPath: titleFromPath,
  _blockFor: blockFor
};
