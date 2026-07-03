# Changelog

What changed in each version of the Agency Brain app. You're reading the copy that ships inside the app, so it always matches the version you have installed. New versions install themselves automatically.

## 0.9.33 — 2026-07-04

- **You can now create your agency right inside the app.** Before this, a member who bought Agency Brain but had no team yet hit a dead end: the setup wizard could only join an existing agency, and the old website that used to create one was retired. Now the wizard has a "Name your agency" step. Sign in with your email, name your agency, connect your GitHub, and the app creates and fills your agency brain for you, end to end. The tray item "Connect to my agency team…" and the Command Centre's add-member nudge both take you straight there, and solo members setting up fresh will see a link for it too.

## 0.9.32 — 2026-07-02

- **Fixes syncing that could get stuck offline and never come back.** In a rare case, the app could get a dead login pass frozen into its connection to GitHub, and then every attempt to sync would fail with "offline", retrying forever, even after restarting the app. This update makes the app clear out any stale pass and fetch a fresh one on every sync, so a connection that got wedged this way heals itself automatically the first time it runs. If your syncing has been sitting on "offline or fetch failed" and a restart didn't help, updating to this version brings it back on its own. (Thanks to Damien at Beacon for the detailed report.)

## 0.9.31 — 2026-07-02

- **See where your team is, right from the Command Centre.** Team members get a new "Where you are" panel on their Getting Started tab. They tick off, for themselves, how far along they feel on the six levels of getting the most from the brain. It's their own read, never a measurement and never watched. Owners and scouts see those self-reports gathered together on their dashboard, so it's easy to spot who might want a hand as people get going. Owners and scouts track their own progress over on the members portal, so nobody has to tick the same thing in two places.
- **You can tell when an update is ready.** When a new version has downloaded and is waiting to install, the app now shows a quiet marker in the Command Centre header and on the menu-bar icon, so an update no longer slips in without you noticing it was there.

## 0.9.30 — 2026-07-02

- **Setup pointers now send you to the right place.** A few in-app messages and help notes still said to finish setup "at agency.ads2ai.com", but setup moved into the app itself, so those were a dead end. They now point you to the app's own setup wizard. Nothing changes in how setup works; the words just match where it actually happens now.

## 0.9.29 — 2026-07-01

- **The Getting Started path reads properly now.** The guided path in the Command Centre had cramped rows and tiny markers that were hard to make out. It now matches the Scout Path on the members portal: a clear number for each track, easy-to-read "Prompt / Read / Do / Quiz" tags, bigger arrows that show a step opens, and roomier steps, so it's obvious what each step is and how to expand it.

## 0.9.28 — 2026-07-01

- **Setting up your brain can no longer wipe the folder you picked.** When you chose an empty folder and the download then failed (a dropped connection, or Git not being installed yet), the app had already cleared that folder first, so it looked like your brain had been deleted. Now the app checks Git is installed before it touches anything, downloads into a temporary spot, and only moves your brain into place once the download has fully succeeded. A failed setup leaves your folder exactly as it was, with a plain-English message about what to fix (for example, how to install Git on Windows).

## 0.9.27 — 2026-06-23

- **Groundwork for signed Windows installs.** Behind the scenes, this gets the app ready to recognise our upcoming signed Windows builds, which help Windows trust the app and reduce "unknown publisher" warnings. Nothing changes in how the app works today. This release just makes sure the next update installs smoothly for everyone.

## 0.9.26 — 2026-06-19

- **The "Start here" skill cards actually open now.** On the Skills page, the cards across the top looked clickable (they even highlight on hover) but clicking them did nothing. Now clicking a card opens that skill's details below, the same as picking it from the list on the left.
- **Skill descriptions are written for people now.** The "What it is" panel used to show a thin one-liner aimed at the AI. It now shows each skill's plain-English intro, so you get a real sense of what a skill does. (Where a skill has no human intro yet, it falls back to the short description.)
- **The "Start here" cards no longer push one-time setup skills.** First-run setup steps (like the agency join/onboarding skill) were showing as the most prominent cards for team members, even though that's a once-ever, terminal-only step that just sends people in circles. They're filtered out, so the cards are skills you can actually use day to day.

## 0.9.25 — 2026-06-19

- **Setting up the Google Ads proxy yourself is now one click.** The Google Ads page used to point you at a file path to go read if you wanted to run the setup by hand. Now there's a "Copy the setup commands" button right there: click it, paste the block into a terminal in your brain folder (or hand the whole thing to Claude), and you're done. The easy way (just ask your brain "set up the Google Ads proxy") is unchanged.

## 0.9.24 — 2026-06-19

- **A "Reconnect" button when you get signed out.** If your saved sign-in ever gets cleared (it can happen while troubleshooting), syncing used to stop quietly and the app couldn't see your team, with no obvious way back. Now the app spots this straight away, tells you what happened, and puts a clear "Reconnect / sign in again" option at the top of the menu (and opens it for you on launch). Signing back in with your email code brings your team and syncing right back, using your existing brain folder, with nothing re-downloaded. (Thanks to Jonti at WHO Digital for the report.)

## 0.9.23 — 2026-06-19

- **A clearer message when your GitHub install isn't finished.** If you're an owner and you open the app before the Agency Brain GitHub App is installed on your repo, the app used to say "ask your owner to finish the install" — but you ARE the owner, so that was a dead end with nothing you could do. Now it tells you exactly what's left: install the App on your repo (with the link right there), then come back and try again. Team members still get pointed to their owner, now with what the owner actually needs to do. (Thanks to Ionut for the report.)

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
