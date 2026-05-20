# Embedded Command Centre (member-safe)

The post-onboarding home of Agency Brain. A slim, **HOME-only** copy of the
brain dashboard's Command Centre, bundled into the app and pointed at the
member's own cloned brain. Ships the projects / todos / active-sessions /
dispatch lens — **none** of the Mike-only dashboard tabs (members, renewals,
tokens, ads, portal, 8020skill).

## How it runs

The Electron main process (`../main.js`) spawns `server.cjs` as a child node
process (via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`) with:

- `BRAIN_ROOT` = the member's cloned brain folder (so the engine reads THEIR
  `projects/` and `todo/`)
- `CC_PORT` = 38917 (deliberately not 3847 — that's Mike's live dashboard)

Then it loads `http://127.0.0.1:38917/` into the app window. Dispatch (`[▷]`)
opens an external terminal running `claude` in the brain folder — the proven
cross-platform spawn (Mac Terminal+tmux / Windows `wt`+PowerShell).

## What's bundled

| File | Origin | Notes |
|---|---|---|
| `lib/todo-parser.cjs` | brain `tools/dashboard/lib/` | honours `process.env.BRAIN_ROOT` |
| `lib/agents-tracker.cjs` | same | honours `BRAIN_ROOT`; state in `data/active-agents.json` |
| `lib/home-prefs.cjs` | same | order/snooze prefs in `data/home-prefs.json` |
| `scripts/spawn-agent.sh` / `.ps1` | same | per-OS dispatch backends |
| `scripts/focus-agent.sh`, `kill-agent.sh`, `register-agent.cjs` | same | session control |
| `server.cjs` | NEW (slim, Node http) | HOME routes only; ports `launchAgentSession` |
| `public/index.html` | NEW | member-safe HOME UI |

## Keeping it in sync (IMPORTANT)

`lib/*` and `scripts/*` are **verbatim copies** of the brain dashboard's
Command Centre engine. They were copied because the engine is member-safe and
member-agnostic, but the brain dashboard itself is Mike-only and never ships.
If the brain's `tools/dashboard/{lib,scripts}` get bug-fixed, re-copy them here
(the sibling `lib/`+`scripts/`+`data/` layout means no edits are needed — they
resolve their runtime state relative to themselves and read `BRAIN_ROOT` from
the env). `server.cjs` and `public/index.html` are the app's own slim versions,
not copies — maintain them here.
