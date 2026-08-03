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

The page needs no separate publishing step. It ships inside each build, so updating the file before tagging IS the automation.

## Command Centre source of truth

`command-centre/lib/*` and `command-centre/scripts/*` are verbatim copies of the brain dashboard's files (`~/Projects/brain/tools/dashboard/`), and the same files also live in the members Workbench (`~/Projects/brain/tools/members/command-centre/`). A change to any copy must land in all three. See `command-centre/README.md`.
