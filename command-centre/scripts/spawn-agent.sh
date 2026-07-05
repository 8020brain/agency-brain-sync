#!/usr/bin/env bash
#
# Phase 1 spawn helper for the Home Command Centre.
#
# Opens a new Terminal.app window at a grid slot, starts a tmux session,
# runs `claude --dangerously-skip-permissions` inside it with an initial
# prompt. Writes session metadata to tools/dashboard/data/active-agents.json
# so /api/agents can show it.
#
# Usage:
#   spawn-agent.sh \
#     --cwd /path/to/working/dir \
#     --prompt-file /tmp/prompt.txt \
#     --slot 1 \
#     [--session agentbrain-xxx] \
#     [--todo-text "the todo title for the UI"] \
#     [--project lisbon]
#
# Prints the session name on stdout. Diagnostics go to stderr.
#
# Working-directory choice (Phase 1 deviation from the build plan):
# the build plan said cwd = projects/<name>/. We pass cwd = BRAIN_ROOT
# instead so the brain's root CLAUDE.md auto-loads (skills, security
# rules, tone guide, etc.). The prompt itself names the project folder
# the agent should focus on. Caller controls cwd via --cwd anyway, so
# either model works.

set -euo pipefail

CWD=""
PROMPT_FILE=""
SLOT=1
SESSION=""
TODO_TEXT=""
PROJECT=""
CLAUDE_SESSION_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd)               CWD="$2"; shift 2;;
    --prompt-file)       PROMPT_FILE="$2"; shift 2;;
    --slot)              SLOT="$2"; shift 2;;
    --session)           SESSION="$2"; shift 2;;
    --todo-text)         TODO_TEXT="$2"; shift 2;;
    --project)           PROJECT="$2"; shift 2;;
    --claude-session-id) CLAUDE_SESSION_ID="$2"; shift 2;;
    *) echo "spawn-agent.sh: unknown arg '$1'" >&2; exit 2;;
  esac
done

[[ -n "$CWD" ]] || { echo "spawn-agent.sh: --cwd is required" >&2; exit 2; }
[[ -d "$CWD" ]] || { echo "spawn-agent.sh: cwd does not exist: $CWD" >&2; exit 2; }
[[ -n "$PROMPT_FILE" ]] || { echo "spawn-agent.sh: --prompt-file is required" >&2; exit 2; }
[[ -f "$PROMPT_FILE" ]] || { echo "spawn-agent.sh: prompt file does not exist: $PROMPT_FILE" >&2; exit 2; }

# Tools we depend on.
command -v tmux >/dev/null 2>&1 || { echo "spawn-agent.sh: tmux not found in PATH" >&2; exit 3; }
command -v osascript >/dev/null 2>&1 || { echo "spawn-agent.sh: osascript not found (macOS only)" >&2; exit 3; }
command -v claude >/dev/null 2>&1 || { echo "spawn-agent.sh: claude CLI not found in PATH" >&2; exit 3; }

# ---- Session name --------------------------------------------------------

if [[ -z "$SESSION" ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    UUID=$(uuidgen | tr 'A-Z' 'a-z' | tr -d '-' | cut -c1-8)
  else
    UUID=$(date +%s | tail -c 9)
  fi
  SESSION="agentbrain-${UUID}"
fi

# tmux session names: alphanumeric, dash, underscore.
if [[ ! "$SESSION" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "spawn-agent.sh: session name has invalid chars: $SESSION" >&2
  exit 2
fi

# Optional pinned claude conversation id (claude --session-id). Lets the
# tracker map this window to its jsonl exactly instead of guessing by file
# birth time (which any other claude session starting in the same cwd at the
# same moment can steal). UUID-validated since it lands in the launcher.
SESSION_ID_ARGS=""
if [[ -n "$CLAUDE_SESSION_ID" ]]; then
  [[ "$CLAUDE_SESSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || { echo "spawn-agent.sh: bad --claude-session-id '$CLAUDE_SESSION_ID'" >&2; exit 2; }
  SESSION_ID_ARGS=" --session-id '$CLAUDE_SESSION_ID'"
fi

# ---- Grid position -------------------------------------------------------
#
# 8-tile grid: 4 columns × 2 rows, each window 1/8 of the main screen.
# Fill order: top row left→right (slots 1-4), then bottom row left→right
# (slots 5-8). A 9th+ agent wraps back to slot 1's position and overlaps.
#
# Override MAIN_SCREEN_W / MAIN_SCREEN_H (and GRID_COLS / GRID_ROWS) via env.
# Defaults match Mike's primary display (2560x1440).

MAIN_W=${MAIN_SCREEN_W:-2560}
MAIN_H=${MAIN_SCREEN_H:-1440}
GRID_COLS=${GRID_COLS:-4}
GRID_ROWS=${GRID_ROWS:-2}
TILE_W=$(( MAIN_W / GRID_COLS ))
TILE_H=$(( MAIN_H / GRID_ROWS ))

# Zero-based slot index, wrapping at COLS*ROWS (8). The original 1-based slot
# number is preserved in active-agents.json for smarter packing later.
IDX=$(( (SLOT - 1) % (GRID_COLS * GRID_ROWS) ))
COL=$(( IDX % GRID_COLS ))
ROW=$(( IDX / GRID_COLS ))
X=$(( COL * TILE_W ))
Y=$(( ROW * TILE_H ))
X2=$(( X + TILE_W ))
Y2=$(( Y + TILE_H ))

# ---- Active-agents.json registration ------------------------------------
#
# Pre-register the agent BEFORE spawning the Terminal so /api/agents polling
# sees it immediately. Shared with the Windows backend via register-agent.cjs
# so one place owns the JSON record shape. The tracker prunes entries whose
# session has died, so a failed spawn self-cleans on the next listAgents.

REGISTER="$(cd "$(dirname "$0")" && pwd)/register-agent.cjs"

node "$REGISTER" --session "$SESSION" --slot "$SLOT" --cwd "$CWD" \
  --todo "$TODO_TEXT" --project "$PROJECT" --prompt-file "$PROMPT_FILE" \
  --claude-session "$CLAUDE_SESSION_ID" >/dev/null

# ---- Build the launcher + Terminal command -------------------------------
#
# The prompt can contain double quotes, $, backticks, and newlines (a project
# dispatch prompt literally wraps the todo text in quotes). If the prompt rode
# inside the tmux command string it would be re-parsed by `sh -c` and break —
# the window would open, claude would get mangled args, and the session would
# exit instantly ("[Process completed]").
#
# So the prompt NEVER travels through a shell-parsed command string. Instead we
# write a tiny launcher script that reads it from the file via double-quoted
# command substitution (one safe argument, no re-parsing), and the only thing
# that travels through tmux + AppleScript is the launcher path + session name
# (both fixed, safe tokens). The claude binary is resolved to an absolute path
# so the tmux server's PATH can't matter.

CLAUDE_BIN="$(command -v claude)"

# BSD (macOS) mktemp needs the X's at the END of the template — a ".sh"
# suffix makes it fail ("mkstemp failed … File exists"). No extension is
# fine: the launcher runs via its shebang + chmod, not by name.
LAUNCHER="$(mktemp "${TMPDIR:-/tmp}/agentbrain-launch-XXXXXX")"
cat > "$LAUNCHER" <<LAUNCH
#!/bin/bash
cd '$CWD' || exit 1
# These all run inside the tmux session (we are its first command), so they
# apply to the current session — no -t needed.
#  - destroy-unattached: closing the window ends the session (so the tracker
#    prunes it instead of leaving a detached session lingering).
#  - status off: hide tmux's green status bar — claude has its own status
#    line, and the tmux one (session name + version) just confused things.
#  - mouse on + big history: the scroll wheel scrolls the pane's scrollback
#    (the text) instead of being turned into arrow keys that cycle prompt
#    history.
tmux set-option destroy-unattached on 2>/dev/null || true
tmux set-option status off 2>/dev/null || true
tmux set-option mouse on 2>/dev/null || true
tmux set-option history-limit 50000 2>/dev/null || true
exec '$CLAUDE_BIN' --dangerously-skip-permissions$SESSION_ID_ARGS "\$(cat '$PROMPT_FILE')"
LAUNCH
chmod +x "$LAUNCHER"

# This command contains only fixed tokens (session name + launcher path).
TERMINAL_CMD="tmux new-session -A -s '$SESSION' '$LAUNCHER'"

# Escape for AppleScript: backslashes and double quotes.
APPLE_CMD=$(printf '%s' "$TERMINAL_CMD" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')

# ---- Per-slot colour + title --------------------------------------------
#
# Each of the 8 slots gets a distinct dark background tint so agents are
# tellable apart at a glance (the practical stand-in for a "sprite" — a
# Terminal can't host real graphics, but a hue per tile reads instantly).
# Tints are dark enough that claude's TUI text stays legible. RGB is the
# AppleScript 16-bit scale (0-65535).
TINTS=(
  "3000, 6000, 14000"    # 1 blue
  "2000, 12000, 12000"   # 2 teal
  "3000, 12000, 5000"    # 3 green
  "15000, 10000, 2000"   # 4 amber
  "17000, 7000, 0"       # 5 orange (brand)
  "10000, 4000, 15000"   # 6 purple
  "16000, 4000, 6000"    # 7 magenta
  "9000, 9000, 12000"    # 8 slate
)
TINT="${TINTS[$IDX]}"

# Window title: "slot · label" with the todo text sanitised (drop quotes /
# backslashes, collapse whitespace, truncate) so it can't break AppleScript.
TITLE_LABEL=$(printf '%s' "${TODO_TEXT:-$SESSION}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-44)
TITLE="${SLOT}: ${TITLE_LABEL}"
APPLE_TITLE=$(printf '%s' "$TITLE" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')

# ---- Launch Terminal -----------------------------------------------------
#
# osascript returns the new window's id. We store it on the agent record so
# focus/kill act on the exact window — title matching is fragile now that the
# title is a human label rather than the session id.

WIN_ID=$(osascript <<APPLE_EOF
tell application "Terminal"
  activate
  set newTab to do script "$APPLE_CMD"
  delay 0.3
  set newWin to window 1
  set bounds of newWin to {$X, $Y, $X2, $Y2}
  try
    set custom title of newTab to "$APPLE_TITLE"
  end try
  try
    set background color of newTab to {$TINT}
    set normal text color of newTab to {58000, 58000, 58000}
    set bold text color of newTab to {65535, 65535, 65535}
  end try
  return id of newWin
end tell
APPLE_EOF
)
WIN_ID=$(printf '%s' "$WIN_ID" | tr -dc '0-9')

# Record the window id on the agent (separate write — it isn't known until
# the window exists).
if [[ -n "$WIN_ID" ]]; then
  node "$REGISTER" --session "$SESSION" --window-id "$WIN_ID" >/dev/null
fi

echo "$SESSION"
