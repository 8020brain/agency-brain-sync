# Changelog

What changed in each version of the Agency Brain app. You're reading the copy that ships inside the app, so it always matches the version you have installed. New versions install themselves automatically.

## 0.9.17 — 2026-06-10

- **This page.** The app now has a changelog, linked from the Command Centre footer as "What's new", so you can see what changed in each version without asking.

## 0.9.16 — 2026-06-10

- **Smarter status chips on dispatched agents.** The Command Centre now reads each working session's live status straight from Claude Code itself, instead of guessing from the conversation file. Three things get better: "working" no longer flickers to "ready" while Claude is quietly thinking, a question asked mid-task can no longer show a false "needs you", and "ready" appears within seconds of a task finishing instead of up to 40 seconds later. Works the same on Mac and Windows.

## 0.9.15 — 2026-06-10

- **Sync can no longer get permanently stuck.** If a team member edited a skill file, sync could quietly jam on that machine and stay jammed. Skills are now read-only for team roles: the edit is backed up safely, the file is restored, and the suggestion is sent to the team's scout as a skill flag instead. A sync that was already stuck clears itself on the next cycle. (Thanks to Peter Tyler for the report.)
- **The setup wizard shows who you're signed in as.** Your email, role, and app version now sit in the wizard footer, so if setup ever gets stuck, a single screenshot tells support everything they need.

## 0.9.14 — 2026-06-04

- **Steadier sign-in codes.** The "resend code" link now waits 60 seconds between sends, so duplicate codes can't pile up and confuse sign-in.

## 0.9.13 — 2026-06-04

- **Clearer skills view.** Each skill now shows its version number and its full description instead of a cut-off one.

## 0.9.12 — 2026-06-04

- **Setup finishes on more machines.** Installing your brain no longer fails on computers without developer build tools; that step is now optional instead of fatal.

## 0.9.11 — 2026-06-02

- **Setup can adopt an existing folder.** If you already have a copy of your agency brain on the machine, the wizard uses it instead of insisting on a fresh download. The wizard also gained a Back button.

## 0.9.10 — 2026-06-02

- **Add-scouts banner.** Owners see a banner with a link to add scout seats when their team is at its cap.

## 0.9.9 — 2026-06-02

- **Flag a skill is back for scouts.** Scouts can send skill feedback to the owner again, and the wording works for every role.

## 0.9.8 — 2026-06-02

- **Help got a proper home.** The Help tab is now a docs-style hub: getting set up, how it works, flagging a skill, and an FAQ, all in one place with consistent, readable type.

Earlier versions predate this changelog.
