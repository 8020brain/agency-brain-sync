# Brain Sync

Brain Sync is a small app that lives in your menu bar (Mac) or system tray (Windows). It watches your team brain folder for changes, commits them to git, and pushes them to GitHub. The whole thing runs in the background, and you never need to open a terminal.

You install it once, point it at a folder, and forget about it. When you (or Claude in Cowork) edit a file, the change lands on GitHub within about 60 seconds.

This is alpha software (v0.2.x). It works on Mac and Windows, but you'll see a security warning on first launch because the app isn't code-signed yet. You click through the warning once and it doesn't come back.

## What you need before you start

- A Mac (Apple Silicon or Intel, macOS 12 or newer) or Windows 10/11.
- A GitHub account with access to the team brain repo you want to keep in sync.
- Git installed. Mac usually has it; you can check by running `git --version` in Terminal. On Windows, install Git for Windows from `git-scm.com` if you don't already have it. During the Windows installer, leave "Git from the command line and also from 3rd-party software" selected.
- About 200 MB of free disk space.

## Install

Download the right installer from the [latest release](https://github.com/8020brain/brain-sync/releases/latest):

| Platform | File | Notes |
|---|---|---|
| Mac (Apple Silicon: M1, M2, M3, M4) | `Brain.Sync-X.Y.Z-arm64.dmg` | Most modern Macs. |
| Mac (Intel) | `Brain.Sync-X.Y.Z.dmg` | Older Macs from before 2020. |
| Windows | `Brain-Sync-Setup-X.Y.Z.exe` | Windows 10/11. |

### Mac

1. Open the DMG you downloaded.
2. Drag Brain Sync to your Applications folder.
3. Eject the DMG.
4. Open Applications, right-click Brain Sync, and choose "Open". Click "Open" on the macOS Gatekeeper warning. (This is a one-time bypass for unsigned apps; future launches don't ask.)
5. The brain icon appears in your menu bar at the top of the screen.

### Windows

1. Run the `Brain-Sync-Setup-X.Y.Z.exe` file you downloaded.
2. Windows SmartScreen will warn you that the app isn't recognised. Click "More info", then "Run anyway". (You only see this once.)
3. Step through the installer.
4. The brain icon appears in your system tray. (Look near the clock; you might need to click the small arrow to see hidden icons.)

## First-time setup

You need a folder to watch. This must be a git repository that's already cloned to your machine and connected to a remote on GitHub.

If you haven't cloned your team brain yet, do that first. Open a terminal:

```
git clone https://github.com/<your-org>/<your-team-brain>.git ~/team-brain
```

On Windows you might prefer to clone into Documents:

```
cd %USERPROFILE%\Documents
git clone https://github.com/<your-org>/<your-team-brain>.git team-brain
```

Once you have the folder, click the brain icon in the menu bar / tray. Pick "Change folder" from the menu, and select the folder you just cloned. The icon should turn orange, which means Brain Sync is watching and ready to push.

## Daily use

The icon colour tells you what's going on:

- **Orange brain**: watching and syncing.
- **Grey brain**: paused, or no folder configured.

The menu has the following options:

- **Status**: shows the watched folder and when the watcher last did something.
- **Pause / Resume**: stop or restart the watcher temporarily.
- **Open brain folder**: opens the folder in Finder (Mac) or Explorer (Windows).
- **Show log**: opens the log file, which is useful if something isn't working.
- **Change folder**: pick a different folder to watch.
- **Auto-start at login**: toggle whether Brain Sync starts when you log in.
- **About**: shows the current version.
- **Quit**: stops the watcher and closes the app.

When you (or Claude in Cowork) edits a file in the watched folder, Brain Sync waits a few seconds for things to settle, then commits and pushes. Check your GitHub repo a minute later and you should see the commit.

## If something breaks

**The icon stays grey and won't turn orange.** The folder you picked needs to be a git repository. Open a terminal, `cd` into the folder, and run `git status`. If that errors, the folder isn't initialised as a git repo yet, or you picked the wrong folder.

**The icon is orange but commits aren't showing up on GitHub.** Click "Show log" in the menu and look for git authentication errors. The most common cause is that GitHub credentials aren't cached yet. Open a terminal, `cd` into the folder, and run `git push` once manually. After that caches your credentials, Brain Sync's pushes will start working.

**Cowork edits never appear on GitHub.** Confirm Cowork is attached to the same folder Brain Sync is watching. The Brain Sync menu shows the watched path; copy it from there and paste it into Cowork to be sure they match.

**Windows: the icon is there but nothing is happening.** Check that Git for Windows is installed by running `git --version` in a fresh terminal. If the command isn't recognised, reinstall Git for Windows and pick "Git from the command line and also from 3rd-party software" during setup.

**You see "git not found" or similar errors in the log.** Same as above; the watcher relies on `git` being on your system PATH.

## Testing this for Mike

If Mike has asked you to test Brain Sync on Mac or Windows, here's what's useful to send back:

- A screenshot of the menu bar / system tray showing the brain icon after install.
- A screenshot or link showing a commit that Brain Sync pushed to GitHub.
- Anything weird that happened: error messages, freezes, the icon disappearing, Cowork edits not landing, or any step in this README that didn't quite work as written.

Email `mike@mikerhodes.com.au` with the above. Rough notes are fine; you don't need to format anything.

## Updating Brain Sync

Until auto-update ships, you check the [releases page](https://github.com/8020brain/brain-sync/releases/latest) every so often. If there's a newer version, download the installer and run it; it replaces the older install.

After auto-update lands, Brain Sync will fetch new versions on its own.

## For developers

If you want to modify the app or run it from source, you'll need Node 20+:

```
npm install
npm start
```

To build local installers:

```
npm run build:mac
npm run build:win
```

Continuous integration handles the real builds. Pushing a `vX.Y.Z` tag triggers GitHub Actions to build Mac and Windows installers and publish them as a GitHub Release. The workflow is at `.github/workflows/build.yml`.

The watcher engine is `watcher/team-brain-sync.js`. The Electron main process is `main.js`, and the first-run settings window is `src/setup.html`.

## License

UNLICENSED. Internal use within 8020brain.
