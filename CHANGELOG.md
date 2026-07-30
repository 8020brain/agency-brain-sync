# Changelog

What changed in each version of the Agency Brain app. You're reading the copy that ships inside the app, so it always matches the version you have installed. New versions install themselves automatically.

## 1.1.14 — 2026-07-31

- **Updating from an older version can no longer leave the Command Centre unable to start.** If a window server left behind by a previous version was still holding the Command Centre's port when you updated, the new app couldn't start its own and showed "Could not start the Command Centre" until a restart of your computer. The app now clears the port itself, whatever version left the blockage behind, before starting fresh.

## 1.1.13 — 2026-07-31

- **The Command Centre window now always shows the brain you're on.** Switching brains, adding a new one, or quitting and relaunching could leave the window showing the previous brain's name, roster and stats even though the sync underneath had switched correctly. The window's background server is now checked against the brain you actually picked and replaced when it doesn't match, and the cached window title can no longer outlive a switch.
- **Organisations that already have the GitHub app connect instantly.** If the app was already installed on your organisation (typical when your agency's own brain lives there), GitHub showed a "Configure" page that never reported back, and setup waited forever. The app now links an existing install directly the moment your organisation name checks out, so that GitHub step disappears entirely in the common case.
- **Your brain knows who you are from the moment you join.** The private identity note (your name, role and team) is written automatically when a brain is set up, and existing brains write it the next time the Command Centre opens. Your role comes from the live team roster, a name you type always wins over the stored one, and the old "Tell your brain who you are" banner only appears if your login carried no name at all.
- **Invites show their code, and getting started starts with a prompt.** After adding a team member (or clicking Resend), the 6-character invite code is shown on screen, so a spam filter can never strand an invite; you can simply send the person the code yourself. And the Getting started tab has a "Copy the start prompt" button whose prompt works in both Claude Code and Cowork.

## 1.1.12 — 2026-07-30

- **Switching brains now shows the brain you switched to.** If you run more than one brain on your machine, switching had three rough edges, all found on the first real client-brain install this morning. Finishing setup for a new brain could leave the previous brain's Command Centre on screen, picking a brain from "Switch brain" looked like it did nothing because the window never refreshed, and the menu could show a brain under an old name or mark the wrong one as active. All three are fixed: the Command Centre now follows the brain you chose, immediately.
- **Client brains are labelled in words.** The Switch brain menu marked a client's brain with a small diamond symbol that meant nothing to anyone. It now says "(client brain)" next to the name.
- **Creating the GitHub organisation skips the payment page.** The create-an-organisation button now lands you straight on the free set-up form, instead of GitHub's plan page that pushes a $4 a month option this never needs. The setup screen also answers the two questions GitHub asks that stall people: "who does this organisation belong to" (your personal account is fine, and it doesn't affect handing a client brain over later) and the "Start collaborating" invite screen (skip it).

## 1.1.11 — 2026-07-30

- **The Connect GitHub step now checks your organisation before you go anywhere.** Setting up a brain used to end with one button that sent you to GitHub's "where do you want to install this?" list, and that list is where people got stuck: it gives no clue which rows are personal accounts (where GitHub won't let the app create anything) and which organisations already have the app (where nothing you click can finish the job). The step is now three ordered blocks: create a free organisation, tell the app its name, then connect. The app checks the name with GitHub while you're still in the app, and tells you in plain words if it's a personal account, misspelt, or doesn't exist yet. Once the name passes, the connect button takes you straight to that one organisation, so the confusing list never appears at all.
- **Each brain needs its own organisation, and the setup screen now says so upfront.** A client brain gets an organisation of its own, separate from your agency's and from every other client's. That's what makes handing the whole thing over to the client possible later, and GitHub won't put a second brain into an organisation that already has one.
- **The "still waiting" message stopped guessing.** If nothing happens after you approve on GitHub, the screen used to guess you'd picked a personal account, which was often wrong. It now names the organisation you gave it and the one thing that can still be in the way, which is that the app is already installed there.

## 1.1.10 — 2026-07-30

- **The Connect GitHub step now explains itself, and speaks up when you're stuck.** Creating a brain needs a GitHub organisation, and that's GitHub's rule, not ours: apps are only allowed to create repositories inside an organisation, never on a personal account. The setup screen now says so upfront, and if you've never needed an organisation before, there's a link that takes you straight to creating a free one, which takes about a minute. Best of all, if you connect and nothing happens for a bit, the screen now tells you the likely cause (the app landed on your personal account) and exactly how to fix it, instead of waiting silently forever.

## 1.1.9 — 2026-07-29

- **A brain you deploy to a client now looks like theirs the whole way through, not just in its colours.** The app has always known the difference between your own brain and one you've set up for a client, but too much of what it showed on screen ignored that. On a client's machine the Skills tab and the Google Ads tab were switched on for everyone, so your client's staff could browse the full skill list and a page of links into a portal that isn't theirs. Both are now off on a client brain unless you turn them on, and you choose that per role on the Your Clients page. Skills had no such switch at all before, so there was no way to hide it even by hand.
- **The Help tab no longer opens a door into our side of things.** Hiding a tab didn't hide the menu inside Help, so a client could still reach setup pages, update instructions and two sets of frequently asked questions written for agencies, one of which explains the whole arrangement you have with us. A client brain's Help tab is now your own contact details and the flag-a-skill form, nothing else.
- **No prices, no seats, no mention of us anywhere a client can see.** The add-more-seats banners and the plan card are gone from a client brain. So are the version line, the What's new, Terms and Privacy links in the footer, and the release notes page behind them. The welcome page, the page title and the menu bar no longer name this product or assume the person reading is an agency, and neither does the setup screen your client sees first. Even the first entry in the brain's own history, and the note the app writes about who's using it, stay neutral inside your client's files.
- **Sections, if you have them.** Extra folders can be shared with only the people entitled to them, kept apart from the main brain.
- **Your Command Centre help now includes the Client Brain questions**, so what you need to answer for a client is in the app rather than only on the web.

## 1.1.8 — 2026-07-29

- **Your plan card shows your Scout seats, and no longer quotes a price that isn't yours.** Scout seats moved to €150 a year each (minimum two) on 28 July, and the old Owner + 2, + 5 and + 10 packages went away. The plan card hadn't caught up, so it was still showing the old package price next to your name. For some agencies that was hundreds of euros away from what they actually pay, and for anyone who bought seats after the change it showed an internal code word instead of a plan. It now simply says how many Scout seats you hold, and leaves the money to your invoice, which is the only place it was ever right. Your seat bar and everything else on the card are unchanged.
- **The nudge to add Scouts no longer promises the wrong thing.** If you have no Scout seats yet, the card used to say that buying two would lift your free Team limit from 5 to 10. That's out of date and short of the truth: paying for any Scout seat at all makes your Team members unlimited. It says that now, along with the real €150 a seat price.
- **Running out of seats now tells you what more seats cost.** The old message offered you a coupon toward the next package up, which no longer exists. It now says seats are €150 a year each and you can add as many as you like, and emails me to put them on your next invoice.


## 1.1.7 — 2026-07-28

- **Setup now creates your brain on your organisation, whatever else is already in there.** If you connected GitHub to your business organisation and that organisation already had other repositories in it, setup quietly gave up: it only ever created your brain when it could see an empty organisation. The screen sat on "creating your brain" and then told you that you'd probably picked a personal account, which wasn't true and sent you looking for a problem you didn't have. Setup now creates your brain on any organisation it's allowed to, no matter how much work is already sitting there, and you don't have to change any GitHub settings to make it happen.
- **When setup really can't continue, it tells you the actual reason.** The old screen made one guess and showed it to everybody. It now says what's genuinely in the way: that the account you chose is a personal one and GitHub won't let apps create repositories there, or that the install wasn't given permission to create repositories on your organisation, along with what to do about it. If you'd rather use a repository you already have, there's now a list of them to pick from.
- **"Check now" actually retries.** It used to re-read the same answer. It now asks again from scratch, so once you've fixed whatever was in the way, one click picks it up.


## 1.1.6 — 2026-07-28

- **Read the invite email before you send it.** Adding someone to a brain sends them an email, and until now you had no way of seeing what it said. There's a "Show the email they'll get" link under the add-member form that shows you exactly who it comes from, where replies go, the subject, and the full text. It's the real email, not a mock-up, so what you read is what lands.
- **Invites into a client brain now come from the client's brand, not from me.** A client's staff were getting an email from "Mike Rhodes" that talked about Agency Brain and was signed off by me, which meant nothing to people who've never heard of me. Those invites now arrive from the client's own brand name, describe the brain as theirs, and are signed by whoever at your agency sent it. Replies come to you, not to me. Invites to your own agency team are unchanged.

## 1.1.5 — 2026-07-28

- **"I have a code" is now in the menu, so you can add a second brain without signing out.** Once you had one brain set up on your machine, there was no visible way to enter a new setup code. The only route was "Run setup again..." tucked inside Settings, which nobody reads as code entry, so staging a client brain meant signing out of the Command Centre and back in again to find the option. The menu now carries "I have a code (add a brain)..." at all times, and it opens straight to the code box with the cursor already in it.
- **Setting up a client brain no longer picks up a brain you already have.** If you installed on a GitHub organisation that already held a brain, setup treated that existing repository as the new one, so a client brain could end up pointing at your agency's own brain instead of getting its own. Setup now checks whether a repository already belongs to another brain and creates a separate one rather than taking it over. The setup screen also asks you to pick the client's own organisation, so their brain stays cleanly theirs.
- **The setup screens no longer say "agency" when you're setting up a client.** Creating a brain for a client showed "Let's create your agency brain" and asked "Which agency?", which is the wrong language for a client's business and confusing if their own person ever runs the setup. Those screens now use the client's brand name and neutral wording.


## 1.1.4 — 2026-07-25

- **A tidier menu when you click the Agency Brain icon in your menu bar.** The menu had grown cluttered and its order didn't make much sense, so it's been cleaned up. Things are now grouped the way you'd expect: your brain's status at the top, then the everyday actions (Open Command Centre, open your brain folder), then syncing, the log, and updates, then a new "Settings" item that gathers the on/off options like "Start at login" in one place, and finally About and Quit. Two menu items that both opened the same log file have been merged into one. If you have more than one brain on your machine, the "Switch brain" list no longer shows duplicate entries for the same folder. A "Start sessions from your phone" toggle that was never properly explained has been removed for now, and will come back once there's a clear guide for it. Nothing about how the app syncs your work has changed, this update is only about making the menu easier to read.

## 1.1.3 — 2026-07-24

- **Dress your Command Centre in your own agency's brand.** Owners and scouts can now pick your agency's colours and font on the new "Your Brand" page in the members portal (m.ads2ai.com/agency-brain/branding), and every seat on your team sees the new look the next time their Command Centre loads. Choose from twelve ready-made colours or enter your exact brand colour, with an instant preview on the page. Nothing to configure in the app itself.

## 1.1.2 — 2026-07-24

- **Your client's brand now sticks between visits.** Before, every refresh of a client brain's Command Centre showed the stock orange colours and font for a moment before the client's own brand loaded in. The app now remembers the brand on the machine and paints it before the page appears, so a refresh looks right from the first instant. The very first visit on a new machine still loads the brand once, and everything after that is instant.
- **Buttons hover in your brand colour.** The solid filled buttons used to flash the old orange when you hovered over them, even on a fully re-branded brain. Hovering now shows a slightly darker shade of your brand colour instead, so the whole page stays on brand.
- **A clearer message when your brain's repo can't be found.** If setup can't find your brain's GitHub repo (say it was removed, or a previous setup never finished creating it), the app now says exactly that and what to do next, instead of the generic "something went wrong".

## 1.1.0 — 2026-07-24

- **Git now works everywhere on your machine, not just inside the app.** Before this, only the app's own syncing had reliable access to your brain's GitHub repo. Anything else that used git, like Claude working in Cursor or a command run in Terminal, borrowed an old saved credential that expired an hour after it was saved, and on some machines it could never be replaced. When that happened you'd see baffling GitHub permission errors and a macOS "enter your login keychain password" pop-up that looked like a password problem but wasn't. The app now supplies every git command on your machine with a fresh credential directly, so those failures and that pop-up are gone for good.
- **Clear messages when something does need you.** If git can't get access because you're signed out of the app, it now says so in plain words: open the Agency Brain app and sign in again. If your internet or our server is unreachable, it tells you that instead of failing mysteriously.
- **One-time cleanup.** On first run after this update, the app removes the old stuck credential from your Mac's keychain so it can never confuse git (or you) again. It only touches the app's own entry, never your personal passwords.

- **Setup can no longer strand you on a screen that can't succeed.** If the app can't confirm your GitHub setup yet, it now takes you to the guided "Connect GitHub" screen instead of the manual folder screen with a confusing error. The guided screen checks again on its own and moves you forward the moment things are ready.
- **"Set up..." in the menu always opens setup now.** Previously, if the Command Centre was open, clicking "Set up..." silently did nothing.
- **If your brain folder goes missing, the app helps instead of breaking.** Deleting or moving the folder used to leave every Command Centre card erroring; now the app explains what happened and reopens setup. Your work is always safe on GitHub.
- **Client brands now apply fully and immediately.** The brand font is honoured (it was saved but ignored), page show/hide choices per role are honoured, agency help contacts show at the top of the client's Help tab, brand names appear in the menus without needing a restart, and a client's brain folder is named for their brain (like acme-corp-brain), never for our product.
- **The app's neutral name is now Business Brain.** Menus that aren't showing a client brand say Business Brain instead of Agency Brain. Nothing changes about where the app is installed or how updates arrive.
- **A business owner in a client brain sees the right Getting Started.** If their agency turns the Getting Started page on for them, the owner of a client business now gets the everyday path ("Your first weeks with the brain"), not the technical Scout path, and none of the agency-flavoured wording that came with it. Agency brains are unchanged.

## 1.0.6 — 2026-07-22

- **Your synced ads data now feeds the Ads portal straight from this app.** When the app is running and your daily ads fetch saves client data into the brain, the Ads portal (m.ads2ai.com/ads) reads your accounts and reports directly from this computer. There is no Google Sheet in the path and your data never touches anyone else's servers. If your agency uses the script and Sheet method, nothing changes for you. One note on browsers: this works in Brave, Chrome, Edge and Firefox; Safari doesn't allow web pages to talk to local apps, so use one of the others for the Ads portal.

## 1.0.5 — 2026-07-21

- **The Google Ads page now tells the whole data story.** The setup card gained a fourth step: once your vault works, ask your brain to "set up the daily ads data fetch" and each client's data lands in their folder every morning, syncs to your whole team, and feeds the Ads portal directly with no Google Sheet to maintain. It also points at the portal's team access switch so your entire team can use the reports.

## 1.0.4 — 2026-07-21

- **The Google Ads page now points you at the Ads portal.** Team members get a card explaining the ready-made reports waiting for them at m.ads2ai.com/ads (budgets, search terms, account health and more) with nothing to set up on their side, plus a note to ask their Scout if their login isn't recognised yet. Owners and scouts get an "Open the Ads portal" link at the top of the page and a card explaining how to switch on team access so the whole agency can use it.

## 1.0.3 — 2026-07-20

- **Start a Claude session from your phone.** Dictate a note into the Brain Inbox on your phone (8020brain.com/i) and tap "Save & Start Session". Within about a minute, your Mac opens a Terminal window with Claude already working on that note, exactly as if you'd dispatched it from the Command Centre. Turn it on from the menu-bar icon with "Start sessions from your phone". It stays off unless you switch it on, so on a team only the computers you choose respond to phone notes. This first version is Mac only, and the machine needs the Claude command-line tool and tmux installed; if a note arrives and they're missing, the app tells you in the log instead of failing silently.

## 1.0.2 — 2026-07-08

- **Signing back in is one step now, not the whole setup again.** If your session expires or you sign out, "Reconnect / sign in again" takes you straight to entering your email and a code, and then puts you right back to work. Before, it walked you through the entire first-time setup (invite code, GitHub, choosing a folder) even though nothing had actually changed. Your brain folder, your team, and your role are all kept exactly as they were.

## 1.0.1 — 2026-07-07

- **The app now tells you when your sign-in has expired, instead of stopping sync without a word.** Your sign-in refreshes roughly once a month. Before, if it lapsed, the app kept running and looked normal while it stopped syncing in the background, and nothing on screen told you. Now, the moment it happens, you get a desktop notification, the menu-bar icon switches to its needs-attention state with a "Reconnect / sign in again" option, and the Command Centre shows a banner across the top. Signing in once clears it, and syncing carries on from where it left off.

## 1.0.0 — 2026-07-06

- **Agency Brain is out of beta: welcome to version 1.0.** Nothing changes in how you use the app day to day.
- **Updates now arrive from a new home.** Under the hood, the app fetches its automatic updates from our public downloads library (the same place the website's download buttons use). You don't need to do anything, but installing this version matters: it's the one that switches your app over, and future updates will only appear once you're on 1.0 or later.

## 0.9.39 — 2026-07-06

- **Help has a new Updates page (owners and scouts).** It explains the two kinds of updates in plain words: the app keeps itself current automatically, while your agency's brain updates monthly with one pasted prompt from the members portal update page (m.ads2ai.com/agency-brain/update). The page walks the routine step by step, covers what an update can and can't touch (your clients, context, and customisations are off-limits), and points at the run-once prompt that turns future updates into a one-line yes at the start of a Claude Code session. Team members don't see it; updates reach them through the normal sync.

## 0.9.38 — 2026-07-06

- Groundwork for the Updates page above; the finished version ships in 0.9.39.

## 0.9.37 — 2026-07-06

- **Role previews show the right Getting started path.** Flipping the view-as preview to Team now shows the team path ("Your first weeks with the brain") instead of the Scout path. Real team members always got the right path; only the preview was wrong.

## 0.9.36 — 2026-07-06

- **The Google Ads page reads like a setup guide instead of a wall of text.** A three-step "How it works" sits up top, the two things to actually do sit below it, and the share-the-credentials-file fallback is tucked away until you want it. The copy now tells the true story: the vault (a small Cloudflare Worker) is the only thing that connects to Google Ads. A team member saves their gate token once, then just asks for data in Cowork, like "pull last month's search terms for Acme and save them as a CSV".
- **Learn Cowork now looks like the Getting started tab** (chevrons to open each step, type chips, tick-offs) **and moved into the Help page for owners and scouts.** It's optional reading for scouts, so it no longer takes a tab across the top; team members, who work in Cowork, keep the Learn Cowork tab.
- **Owners see why they're looking at the Scout path.** A short note at the top of Getting started explains that every agency needs one builder, and points at the switcher to preview the much shorter team path.
- The MCC field placeholder no longer suggests every login customer ID starts with a 5.

## 0.9.35 — 2026-07-04

- **"Tell your brain who you are" no longer dead-ends when your login has no name.** For some members, signing in doesn't bring a name back with it, and the one-click identity setup would fail with "sign in again", which could never fix it. Now, if the app doesn't know your name, the banner simply asks you to type it, and one click finishes the job.

## 0.9.34 — 2026-07-04

- **The "Add Scouts" button goes to the upgrade page's new home.** The last pages on the old agency.ads2ai.com site (upgrade, help, and the claim and join landing pages) moved to ads2ai.com/agency-brain. The old addresses redirect, so nothing breaks on older versions; this update just points the button at the new address directly.

## 0.9.33 — 2026-07-04

- **You can now create your agency right inside the app.** Before this, a member who bought Agency Brain but had no team yet hit a dead end: the setup wizard could only join an existing agency, and the old website that used to create one was retired. Now the wizard has a "Name your agency" step. Sign in with your email, name your agency, connect your GitHub, and the app creates and fills your agency brain for you, end to end. The tray item "Connect to my agency team…" and the Command Centre's add-member nudge both take you straight there, and solo members setting up fresh will see a link for it too.

## 0.9.32 — 2026-07-02

- **Fixes syncing that could get stuck offline and never come back.** In a rare case, the app could get a dead login pass frozen into its connection to GitHub, and then every attempt to sync would fail with "offline", retrying forever, even after restarting the app. This update makes the app clear out any stale pass and fetch a fresh one on every sync, so a connection that got wedged this way heals itself automatically the first time it runs. If your syncing has been sitting on "offline or fetch failed" and a restart didn't help, updating to this version brings it back on its own.

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

- **A "Reconnect" button when you get signed out.** If your saved sign-in ever gets cleared (it can happen while troubleshooting), syncing used to stop quietly and the app couldn't see your team, with no obvious way back. Now the app spots this straight away, tells you what happened, and puts a clear "Reconnect / sign in again" option at the top of the menu (and opens it for you on launch). Signing back in with your email code brings your team and syncing right back, using your existing brain folder, with nothing re-downloaded.

## 0.9.23 — 2026-06-19

- **A clearer message when your GitHub install isn't finished.** If you're an owner and you open the app before the Agency Brain GitHub App is installed on your repo, the app used to say "ask your owner to finish the install" — but you ARE the owner, so that was a dead end with nothing you could do. Now it tells you exactly what's left: install the App on your repo (with the link right there), then come back and try again. Team members still get pointed to their owner, now with what the owner actually needs to do.

## 0.9.22 — 2026-06-18

- **Your team config heals itself.** Every agency brain keeps a small file listing who's on your team, and the setup steps need it. In a few setups it never got created, which could stop Claude part-way through saying it couldn't find it. The app now writes that file for you automatically on startup whenever it's missing, fills it from your live team list, and syncs it to everyone, so setup no longer gets stuck on this.

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

- **Sync can no longer get permanently stuck.** If a team member edited a skill file, sync could quietly jam on that machine and stay jammed. Skills are now read-only for team roles: the edit is backed up safely, the file is restored, and the suggestion is sent to the team's scout as a skill flag instead. A sync that was already stuck clears itself on the next cycle.
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
