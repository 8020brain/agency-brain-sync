// Which file actually holds a brain's instructions.
//
// Since August 2026 every brain ships its instructions in AGENTS.md, with a
// two-line CLAUDE.md beside it that does nothing but point at AGENTS.md (the
// pointer is what makes Claude Code load it; Codex reads AGENTS.md directly).
// Brains built before that carry a full CLAUDE.md and no AGENTS.md at all.
//
// So anything reading a brain's instructions for CONTENT has to resolve which
// of the two is the real file. Reading the pointer as if it held content is the
// bug this module exists to stop: the stub has no agency name, no placeholders
// and no rules in it, so a caller that reads it sees an empty, "already
// customised" brain and reports the opposite of the truth.
'use strict';
const fs = require('fs');
const path = require('path');

// The stub's first non-blank line is the @-import and nothing else.
function isPointerStub(text) {
  const first = String(text || '').split(/\r?\n/).find((l) => l.trim() !== '');
  return /^@AGENTS\.md$/.test((first || '').trim());
}

// Returns { file, name, text } for the file holding this brain's instructions,
// or null when neither file is there (or the only one present is a pointer with
// nothing to point at, which is a broken pair rather than a brain).
function readInstructions(brainRoot) {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(brainRoot, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    if (isPointerStub(text)) continue;
    return { file, name, text };
  }
  return null;
}

module.exports = { isPointerStub, readInstructions };
