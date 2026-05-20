#!/usr/bin/env bash
#
# Bring a spawned agent's Terminal window to the front. Called by
# agents-tracker.focusAgent (the /api/agents/:session/focus route — fired
# when you click an agent chip on HOME).
#
# Usage: focus-agent.sh <session-name> [window-id]
#
# Primary match is the window id captured at spawn (robust). If it's missing
# (older agents), fall back to matching the tab's custom title to the session.

set -uo pipefail

SESSION="${1:-}"
WIN_ID="${2:-}"
[[ -n "$SESSION" ]] || { echo "focus-agent.sh: session name required" >&2; exit 2; }
if [[ ! "$SESSION" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "focus-agent.sh: invalid session name: $SESSION" >&2
  exit 2
fi
WIN_ID=$(printf '%s' "$WIN_ID" | tr -dc '0-9')

command -v osascript >/dev/null 2>&1 || { echo "focus-agent.sh: osascript not found" >&2; exit 3; }

if [[ -n "$WIN_ID" ]]; then
  osascript <<APPLE 2>/dev/null || true
tell application "Terminal"
  activate
  try
    set w to (first window whose id is $WIN_ID)
    set frontmost of w to true
    set index of w to 1
  end try
end tell
APPLE
else
  osascript <<APPLE 2>/dev/null || true
tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      try
        if custom title of t is "$SESSION" then
          set selected of t to true
          set frontmost of w to true
          set index of w to 1
        end if
      end try
    end repeat
  end repeat
end tell
APPLE
fi

echo "$SESSION"
