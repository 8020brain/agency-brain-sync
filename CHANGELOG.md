# Changelog

What changed in each version of the Agency Brain app. You're reading the copy that ships inside the app, so it always matches the version you have installed. New versions install themselves automatically.

## 0.9.22 — 2026-06-18

- **Your team config heals itself.** Every agency brain keeps a small file listing who's on your team, and the setup steps need it. In a few setups it never got created, which could stop Claude part-way through saying it couldn't find it. The app now writes that file for you automatically on startup whenever it's missing, fills it from your live team list, and syncs it to everyone, so setup no longer gets stuck on this. (Thanks to Mathieu at Uptimize for the report.)

## 0.9.21 — 2026-06-16

- **Sync recovers itself from a leftover lock.** If a session was interrupted while saving (this can happen in Cowork), it could leave behind a tiny lock file that quietly jammed every sync afterwards, so your brain slipped further and further behind without saying why. The app now clears that leftover lock on its own and catches up. (Thanks again to Peter Tyler for the report.)
- **When sync really is stuck, it now tells you.** If something blocks syncing for several tries in a row, the app stops trying quietly: the menu-bar icon turns to "needs attention" with a plain reason, and you get a notification suggesting you quit and reopen. No more watching a number climb with no explanation.
- **The FAQ keeps itself up to date.** The Help tab now fetches the latest questions and answers when it opens, so new answers appear for everyone the moment they're published, without waiting for an app update. If you're offline, the copy built into the app shows instead.
- **Learn Cowork.** The Command Centre has a new standalone Cowork course tab, so anyone can get up to speed on working with the brain through Cowork.
- **Tidy up your home view.** The "Add Scouts" prompt can now be dismissed for a week, with a "Show dismissed cards" link to bring hidden cards back.

## 0.9.20 — 2026-06-10

- **Getting started tab.** The Command Centre now has a guided map of your first weeks with the brain: the Team path for team members and the new Scout path for scouts and owners, with tick-boxes, per-step detail, and copy buttons that hand each exercise straight to Claude. Scouts and owners get a switcher to preview what their team sees. Progress is private to each person and shared with /start, so a step done in either place shows as done in both.
- **Updates now install themselves.** The app used to download a new version and then wait for a restart that never came, because it lives in the menu bar. Now an update installs itself five minutes after downloading; a small note appears first with a "Later" link if mid-anything (later = it installs on your next restart). Your Claude sessions are separate programs and aren't touched.
- **Brain updates arrive on their own.** When we publish an update to how the brain itself works (new conventions, new instructions), the app now fetches it into your brain's `docs/migrations/` folder automatically, your scout's next Claude session offers to apply it, and a banner in the Command Centre shows anything still pending with a copy-ready prompt. Team members never see any of this.
- **Todos can belong to people.** The Command Centre's todo list now understands the new `assignee:` field, so each person's tasks can be shown as theirs (ships with template 2026.06.13).

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
