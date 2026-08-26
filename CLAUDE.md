# Agency Brain app (agency-brain-sync)

The live menu-bar app + embedded Command Centre + sync engine. One product: "Agency Brain". This repo is PUBLIC (the auto-update feed reads its releases), so never commit secrets, member data, or internal URLs.

## Releasing

**Batch work — releases are expensive for members.** Every release makes every member's app prompt for an update, so a release is a deliberate event, not a side effect of finishing a change. Do NOT bump the version, tag, or treat each edit as shippable. Accumulate related work in main (plain commits, no version bump), and only cut a version when Mike says ship (or a genuine standalone fix warrants it and he agrees). One release then covers the whole batch with one changelog entry. (Added 2026-06-10 after two same-afternoon bumps, v0.9.18 + v0.9.19, while Mike was still mid-editing the very content they shipped. Mike: "keep the releases minimal".)

**HARD CEILING: one release per day, and only Mike can grant an exception — each time, explicitly.** An exception he grants for one release authorises THAT release only; it is never a licence to propose another the same day, and Claude never proposes a same-day follow-up release to ship scope Claude chose to leave out of the one that just went. Left-out work waits for tomorrow, full stop. If Mike is annoyed that something missed a release, the answer is to own the scoping mistake and put the work on tomorrow's release, NOT to offer another cut today; his frustration is not authorisation. When a release is being cut, roll in everything ready and relevant so nothing is left dangling. (Added 2026-07-30: Mike authorised a second same-day release, v1.1.12, and within the hour Claude proposed a third to carry two features it had deliberately deferred. Bursts of releases in one day is the exact failure that created the one-per-day rule; a member lost his evening to a mid-setup deploy burst on 2026-07-29. Mike: "Why the fuck would you start to overwrite that now?")

1. Bump the patch version in `package.json` (`npm version X.Y.Z --no-git-tag-version`).
2. **Add a CHANGELOG.md entry for that exact version — this is mandatory.** CI fails the build if `## <version>` is missing. Format: `## X.Y.Z — YYYY-MM-DD` then `- **Short bold lead.** Plain sentences.`
3. Commit as `vX.Y.Z: description`, tag `vX.Y.Z`, push with `--tags`. The tag triggers `.github/workflows/build.yml`: Mac + Windows builds, GitHub release, and installer mirror to the public downloads repo. Watch it go green.

## CHANGELOG.md is member-facing — write it for members, not developers

Members read it inside the app: the Command Centre footer's "What's new" link opens `/changelog`, which renders the CHANGELOG.md bundled into that build (`electron-builder.yml` files + asarUnpack). So every entry must read like explaining to a business owner who doesn't code: what was broken or missing for them, what's better now, in behaviour terms. No file names, no jargon, no em dashes in prose (the `## version — date` heading separator is structural and fine). One or two sentences per bullet.

**Never name a member, an agency, or what they were doing.** No "thanks to X at Y", no "reported by", no "X asked for this". Every agency reads this file, so a name next to a version number tells everyone else something about that customer's setup, their problems, or their account, and they never agreed to that. The rule used to say to credit reporters by name, which is how eleven such lines ended up shipped and had to be stripped out on 2026-07-29 (Mike: "you don't want Chris thinking that we're telling information about his story in a file that can be read by anyone"). Thank people privately, in the reply to them. If a thank-you ever does belong here, it is a bare thank-you with no name and no explanation of why.

**The no-names rule covers CODE COMMENTS and tests, not just the changelog.** This repo is public and the `command-centre/public/` files ship readable inside every build, so a client or member name anywhere in the tree is the same leak. Cite incidents as "client field report, YYYY-MM-DD" and keep the identity in the brain's private docs. (2026-08-20: eight comments crediting a client by name were committed and had to be scrubbed the same day; the name survives in that day's git history.)

The page needs no separate publishing step. It ships inside each build, so updating the file before tagging IS the automation.

## The watcher shares one git index with a human. Never stage-then-unstage.

`watcher/team-brain-sync.js` runs `git` in a folder a person is also working in.
That makes one rule absolute: **decide what to stage, then stage only that.** Never
`git add -A` and then reset the paths you did not want.

Staging a path and taking it back puts the person's work in the index for a moment,
and undoing it races anything else touching that index. When `.nosync` was first
built that way the suite was red about a third of the time and the failure mode
destroyed work someone had staged deliberately. Five separate patches each closed
one window and opened another; the only fix was to stop staging those paths at all.

Three things that follow, each with a test that fails if you break it:

- **The marker file itself must always stage** (`isNoSynced` exempts it by basename),
  or the choice never reaches the rest of the team and their apps keep syncing the
  folder.
- **`isNoSynced` starts its walk at the path itself, not its parent.** `git status`
  collapses a wholly-untracked directory to one `newthing/` entry, so the marked
  directory is often the entry rather than an ancestor of it.
- **The staging decision asks for untracked files individually (`-uall`).** Without
  it a marker deeper inside a new folder is invisible and the marked work is pushed.

Role rules and the marker are separate decisions and neither consults the other. A
protected path is still reverted for a role that cannot push it, marker or no marker.

## Command Centre source of truth

`command-centre/lib/*` and `command-centre/scripts/*` are verbatim copies of the brain dashboard's files (`~/Projects/brain/tools/dashboard/`), and the same files also live in the members Workbench (`~/Projects/brain/tools/members/command-centre/`). A change to any copy must land in all three. See `command-centre/README.md`.

## Client brains: the rules that keep the white-label safe

A client brain runs with `kind:'client'` in config.json but ALSO `mode:'agency'`, so `kind` is the ONLY discriminator; anything branching on `mode` treats a client brain as an agency. Guarded by `tests/client-kind.test.cjs` (tabs, Help nav, copy, server) and `tests/client-experience.test.cjs` (sync rules, client FAQ, the rail, the wizard). Every rule below was earned on 2026-08-19/20; the fuller story lives in the brain at `projects/clientbrain/build-log.md` and `decisions.md`.

- **Client-facing wording changes ONLY through the override maps**, `CLIENT_TEXT` / `CLIENT_HTML` in `command-centre/public/js/core.js` (applied by `applyClientChrome`). Editing index.html alone leaves agency copy on a client's screen; "your client context", "how the agency does things" and "The Scout improves it" all reached every client that way. To swap a new element: give it an id, add it to a map, seed the id in the client-kind test fixture. The copy test greps the swapped output for "Agency Brain", "your agency", "the agency", "Scout", "your client" and "Skills tab".
- **Never tell anyone to type `/start` in Cowork, in any copy.** Repo skills aren't registered as slash commands there (2026-07-30), so it silently does nothing; only Claude Code runs `/start`. Hand out a paste-able prompt that names `.claude/skills/start/SKILL.md` explicitly.
- **Tab defaults: Getting started and Learn Cowork are ON for a client unless the agency switches them off; everything else is explicit opt-in; `CLIENT_NEVER_TABS` (Google Ads, Skills) can never show.** The reasoning is load-bearing: hidden-by-default was right while the opt-in list carried agency content a wrong guess would leak. The only opt-ins left are the client's own onboarding, where a blank tab bar is the worse outcome. **If a tab carrying agency content is ever added back to `CLIENT_OPT_IN_TABS`, its default flips back to off.** The portal's Customize panel (8020members, client-brain page) must display the same defaults, and a coupled default ships app first, portal second, never the reverse.
- **Three different things make a client pane "hidden", and a default-pane picker must respect all three:** hidden by role (`applyRoleTabs`), hidden by kind (`applyClientTabs`), and emptied by a node MOVE (the Cowork course and the Skills browser are single nodes relocated into the Help pane, leaving their original home an empty shell). The Help tab once opened blank for every client because the landing section was chosen before the client rules removed it and the fallback pane was one of those shells. Anything picking a default pane checks the pane has content, not just that its nav button is visible (`landOnFirstVisibleHelpSection`).
- **A path the sync rules block is REVERTED, not merely refused.** `pathBlockedForRole` → `stageAndCommit` → `revertProtectedEdit` (`git checkout HEAD -- <path>`, or an unlink when no HEAD version exists), so a NEW file written by a role that can't push it is silently DELETED about a minute later. That is how the progression panel destroyed every tick anyone ever made, for weeks, with no error. Per-person state a team member writes goes in `personal/` (gitignored, never syncs, which is why the guided-path ticks never had this bug) or gets an explicit allowance in `pathBlockedForRole` plus a test in `sync-recovery.test.cjs` section H.
