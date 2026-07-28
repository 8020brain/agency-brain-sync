# Embedded Command Centre (member-safe)

The post-onboarding home of Agency Brain. Bundled into the app and pointed at
the member's own cloned brain.

**What it actually ships (the nav in `public/index.html`, and nothing else):**
`welcome`, `path` (Getting started / scout path), `cowork` (Learn Cowork
course), `owner` + `scout` (team roster, seats, invites), `skills` (browser),
`gads` (Google Ads connector), `help` (FAQ / flag a skill).

**It is an onboarding, team-admin and help surface. It has NO task list and NO
click-to-dispatch.** That is the **Workbench** (`tools/dashboard`, port 3847),
a separate Mike-only product which was renamed FROM "Command Centre" precisely
to keep these two apart. Do not describe this surface as somewhere you click a
task to fire off work, in docs or in any email to an agency.

The engine in `lib/` and `scripts/` was ported verbatim from the brain
dashboard, so `server.cjs` still carries `/api/spawn`, `/api/projects` and
`/api/misc-todos`. **No shipped JS calls any of them** — they are dead weight
from the port, not evidence of a feature. Check the nav before believing a
route exists in the UI.

It deliberately ships **none** of the Mike-only dashboard tabs (members, renewals,
tokens, ads, portal, 8020skill).

## How it runs

The Electron main process (`../main.js`) spawns `server.cjs` as a child node
process (via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`) with:

- `BRAIN_ROOT` = the member's cloned brain folder (so the engine reads THEIR
  `projects/` and `todo/`)
- `CC_PORT` = 38917 (deliberately not 3847, which is Mike's live dashboard)

Then it loads `http://127.0.0.1:38917/` into the app window.

The ported `launchAgentSession()` (external terminal running `claude`; Mac
Terminal+tmux / Windows `wt`+PowerShell) is still present in `server.cjs`, but
the only caller is the Smart Start button. There is no `[▷]` task dispatch in
this UI — see the note above.

## What's bundled

| File | Origin | Notes |
|---|---|---|
| `lib/todo-parser.cjs` | brain `tools/dashboard/lib/` | honours `process.env.BRAIN_ROOT` |
| `lib/agents-tracker.cjs` | same | honours `BRAIN_ROOT`; state in `data/active-agents.json` |
| `lib/home-prefs.cjs` | same | order/snooze prefs in `data/home-prefs.json` |
| `lib/observability.cjs` | NEW | serves `/api/observability` (skill usage, feedback) |
| `scripts/spawn-agent.sh` / `.ps1` | same | per-OS dispatch backends |
| `scripts/focus-agent.sh`, `kill-agent.sh`, `register-agent.cjs` | same | session control |
| `server.cjs` | NEW (slim, Node http) | HOME + observability + Google Ads + team-management + flag-skill + identity + team-path + brain-updates routes; ports `launchAgentSession` |
| `public/index.html` | NEW | thin member-safe shell |
| `public/js/*.js` | NEW | renderers: `boot.js`, `core.js`, `nav-charts.js`, `path.js`, `dashboard.js`, `connectors.js`, `faq-live.js`, `cowork.js` |
| `public/css/base.css`, `views.css` | NEW | tokens + type scale; per-view styles |

## Keeping it in sync (IMPORTANT)

`lib/*` and `scripts/*` are **verbatim copies** of the brain dashboard's
Command Centre engine. They were copied because the engine is member-safe and
member-agnostic, but the brain dashboard itself is Mike-only and never ships.
If the brain's `tools/dashboard/{lib,scripts}` get bug-fixed, re-copy them here
(the sibling `lib/`+`scripts/`+`data/` layout means no edits are needed; they
resolve their runtime state relative to themselves and read `BRAIN_ROOT` from
the env). `server.cjs` and `public/index.html` are the app's own slim versions,
not copies, so maintain them here.

## CSS layout

`public/index.html` is a thin shell. Styles live in `public/css/base.css`
(tokens + shared components) and `public/css/views.css` (per-view styles);
renderers live in `public/js/*.js`. Edit those, not a giant inline block.

## Typography: use the type scale, do NOT hand-pick font sizes

`base.css :root` defines a **type scale** (`--fs-2xs` ... `--fs-hero`). Reading
content (the Help tab: Get set up, How it works, Flag a skill, FAQ) must size
text from this scale, never a hand-picked px value:

| var | px | use |
|---|---|---|
| `--fs-2xs` | 12 | eyebrows, tiny uppercase labels, badges |
| `--fs-xs` | 13 | captions, mono paths, secondary meta |
| `--fs-sm` | 15 | secondary body, resource/link rows, notes |
| `--fs-base` | 16 | body copy (default reading size) |
| `--fs-md` | 18 | lead paragraphs, FAQ answers, step/item titles |
| `--fs-lg` | 19 | list/item titles (e.g. FAQ questions) |
| `--fs-xl` | 21 | sub-section headings |
| `--fs-2xl` | 23 | page-section headings |
| `--fs-hero` | 34 | hero headings |

Rule of thumb: **never set reading text below `--fs-sm` (15px), and use the
accent colour (`--accent`) for section sub-headings.** The dashboard, roster
tables and KPIs are data-dense surfaces and deliberately keep their own tighter
sizes; the scale is for the content/help pages, where readability beats density.

Repeated failure point (2026-06-02): the content pages kept shipping at 11-14px
and read too small. The scale exists so that stops happening, so reach for a `--fs-*`
token, don't invent a number.
