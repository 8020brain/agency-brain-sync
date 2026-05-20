#!/usr/bin/env bash
#
# Kill a spawned agent: end its tmux session AND close the Terminal.app
# window that hosts it. Called by agents-tracker.killAgent (the /api/agents/
# :session/kill route + the undo toast).
#
# Usage: kill-agent.sh <session-name> [window-id]
#
# Primary window match is the id captured at spawn (robust). If it's missing
# (older agents), fall back to matching the tab's custom title to the session.
# Closing is best-effort; the tmux kill is the part that frees the slot.

set -uo pipefail

SESSION="${1:-}"
WIN_ID="${2:-}"
[[ -n "$SESSION" ]] || { echo "kill-agent.sh: session name required" >&2; exit 2; }
if [[ ! "$SESSION" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "kill-agent.sh: invalid session name: $SESSION" >&2
  exit 2
fi
WIN_ID=$(printf '%s' "$WIN_ID" | tr -dc '0-9')

# 1. End the tmux session (frees the grid slot + ends claude).
tmux kill-session -t "$SESSION" 2>/dev/null || true

# 2. Close the hosting Terminal window.
if command -v osascript >/dev/null 2>&1; then
  if [[ -n "$WIN_ID" ]]; then
    osascript <<APPLE 2>/dev/null || true
tell application "Terminal"
  try
    close (first window whose id is $WIN_ID) saving no
  end try
end tell
APPLE
  else
    osascript <<APPLE 2>/dev/null || true
tell application "Terminal"
  set toClose to {}
  repeat with w in windows
    repeat with t in tabs of w
      try
        if custom title of t is "$SESSION" then set end of toClose to id of w
      end try
    end repeat
  end repeat
  repeat with wid in toClose
    try
      close (every window whose id is wid) saving no
    end try
  end repeat
end tell
APPLE
  fi
fi

echo "$SESSION"
