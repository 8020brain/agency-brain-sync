# Agency Brain app (agency-brain-sync)

The live menu-bar app + embedded Command Centre + sync engine. One product: "Agency Brain". This repo is PUBLIC (the auto-update feed reads its releases), so never commit secrets, member data, or internal URLs.

## Releasing

1. Bump the patch version in `package.json` (`npm version X.Y.Z --no-git-tag-version`).
2. **Add a CHANGELOG.md entry for that exact version — this is mandatory.** CI fails the build if `## <version>` is missing. Format: `## X.Y.Z — YYYY-MM-DD` then `- **Short bold lead.** Plain sentences.`
3. Commit as `vX.Y.Z: description`, tag `vX.Y.Z`, push with `--tags`. The tag triggers `.github/workflows/build.yml`: Mac + Windows builds, GitHub release, and installer mirror to the public downloads repo. Watch it go green.

## CHANGELOG.md is member-facing — write it for members, not developers

Members read it inside the app: the Command Centre footer's "What's new" link opens `/changelog`, which renders the CHANGELOG.md bundled into that build (`electron-builder.yml` files + asarUnpack). So every entry must read like explaining to a business owner who doesn't code: what was broken or missing for them, what's better now, in behaviour terms. No file names, no jargon, no em dashes in prose (the `## version — date` heading separator is structural and fine). One or two sentences per bullet. Credit member reports by name when one triggered the fix.

The page needs no separate publishing step. It ships inside each build, so updating the file before tagging IS the automation.

## Command Centre source of truth

`command-centre/lib/*` and `command-centre/scripts/*` are verbatim copies of the brain dashboard's files (`~/Projects/brain/tools/dashboard/`), and the same files also live in the members Workbench (`~/Projects/brain/tools/members/command-centre/`). A change to any copy must land in all three. See `command-centre/README.md`.
