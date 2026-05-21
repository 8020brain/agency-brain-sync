# Agency Brain

Agency Brain is the small background app that keeps an agency's shared brain folder in sync across every team member's machine. It lives in the menu bar (Mac) or system tray (Windows), watches a local folder for changes, and uses a GitHub App to push and pull on the user's behalf. Team members never need a GitHub account.

You install it once, paste a 6-character invite code from your agency, and forget about it. When you (or Claude in Cowork) edit a file, the change lands on GitHub within about a minute. When a teammate edits something, it lands on your machine within another minute.

## Are you a team member trying to install this?

Your agency sent you an invite email with a 6-character code. Follow the steps below.

### Download

Go to the [latest release page](https://github.com/8020brain/agency-brain-sync/releases/latest) and pick the right file:

| Platform | File |
|---|---|
| Mac Apple Silicon (M1+) | `Agency Brain-X.Y.Z-arm64.dmg` |
| Mac Intel | `Agency Brain-X.Y.Z.dmg` |
| Windows 10/11 | `Agency-Brain-Setup-X.Y.Z.exe` |

### Install (Mac)

1. Double-click the downloaded `.dmg`.
2. Drag **Agency Brain** to the **Applications** folder.
3. Eject the DMG.
4. Open Applications and double-click **Agency Brain**.

**You will see a warning** because Agency Brain isn't signed by Apple yet:

> *"Agency Brain" cannot be opened because Apple cannot check it for malicious software.*

This is a one-time hurdle. Click **Done** on the warning, then:

5. Open **System Settings → Privacy & Security**.
6. Scroll down. You'll see a line that says *"Agency Brain was blocked from use because it is not from an identified developer"* with an **Open Anyway** button. Click it.
7. Authenticate with Touch ID or your password.
8. Go back to Applications and double-click Agency Brain. macOS asks one more time if you really want to open it. Click **Open**.

After that, Agency Brain is permanently authorised. Future launches don't prompt.

The brain icon appears in the menu bar at the top of your screen. The setup wizard opens automatically on first launch.

### Install (Windows)

1. Run the `Agency-Brain-Setup-X.Y.Z.exe` file you downloaded.
2. Windows SmartScreen will warn you the app isn't recognised. Click **More info**, then **Run anyway**. This is a one-time hurdle.
3. Step through the installer (defaults are fine).
4. The brain icon appears in your system tray near the clock. You may need to click the small up-arrow to see hidden icons.

### Connect to your team

1. Click the brain icon in the menu bar (Mac) or system tray (Windows).
2. The setup wizard window opens.
3. Find the 6-character code in your invite email (it looks like `BR4-7XK`).
4. Paste it into the wizard and click **Continue**.
5. Follow the wizard's three remaining steps.

That's all you need. If you get stuck, ask your scout, or email `mike@ads2ai.com` with a screenshot.

### Why the security warning?

The Mac and Windows warnings appear because Agency Brain isn't code-signed yet. Code signing requires a paid developer account from Apple ($99/yr) and from Microsoft (more involved). We're delaying that step until the v1 release. Once signed, the warnings go away entirely.

The warning does NOT mean the app is unsafe; it means macOS or Windows hasn't been told who's responsible for it. The source code is in this public repository if you want to verify what the app does.

## Are you a maintainer / developer?

This repo is the Electron app source. The watcher engine is `watcher/team-brain-sync.js` (Node + chokidar + git via child_process). The Electron main process is `main.js`. The first-run wizard renderer is `src/setup.html`. The preload bridge is `preload.js`.

### Architecture, briefly

- Watcher: classifies repo state on every tick (5 states + STOPs); never stashes, never rebases the working tree. Push lane and pull lane are separated (debounce owns push; interval owns pull and only pushes as a safety net when no debounce is pending). Role-aware: when the repo has a `.team-config/roles.json` and the local member's role is `team`, the watcher STOPs on attempts to push protected paths (`.claude/`, `.team-config/`, `skills/`, `agents/`, `hooks/`).
- Wizard: five scenes (paste code → connecting → pick folder → Claude desktop check → connected). Demo mode (code `DEMO01`) seeds a placeholder folder so the flow can be walked end-to-end without the backend. State emission via a `STATE_FILE` env var lets the tray icon reflect a third "needs attention" state when the watcher reports STOP.
- Auth: agency mode mints fresh GitHub App installation tokens from `api.ads2ai.com/api/team-brain/git-token` on each git operation. Token is embedded in the remote URL for the duration of the op and stripped afterwards. Team members never authenticate to GitHub directly.

### Build from source

You need Node 20+ and a recent npm.

```
git clone https://github.com/8020brain/agency-brain-sync.git
cd agency-brain-sync
npm install
npm start                # run the app from source (Electron in dev)
```

To build local installers:

```
npm run build:mac        # Mac arm64 + Intel DMG
npm run build:win        # Windows NSIS installer
npm run build:all        # both, in one pass
```

Output lands in `dist/`. Binaries are unsigned (`identity: null` on Mac, no signing cert on Windows). Click through Gatekeeper / SmartScreen once on first launch.

To cut a release:

```
# Bump the patch in package.json first (e.g. 0.8.2 → 0.8.3)
git add package.json && git commit -m "v0.8.3: ..." && git push
npm run build:all
gh release create v0.8.3 \
  -R 8020brain/agency-brain-sync \
  --title "Agency Brain v0.8.3" \
  --notes "..." \
  "dist/Agency Brain-0.8.3-arm64.dmg" \
  "dist/Agency Brain-0.8.3.dmg" \
  "dist/Agency-Brain-Setup-0.8.3.exe"
```

The release assets are downloadable from `https://github.com/8020brain/agency-brain-sync/releases/latest` once the repo is public.

### Latest release

The latest installer is always at [releases/latest](https://github.com/8020brain/agency-brain-sync/releases/latest). Three files per release:

| Platform | File |
|---|---|
| Mac Apple Silicon (M1+) | `Agency Brain-X.Y.Z-arm64.dmg` |
| Mac Intel | `Agency Brain-X.Y.Z.dmg` |
| Windows 10/11 | `Agency-Brain-Setup-X.Y.Z.exe` |

### Related code

| Where | What |
|---|---|
| `mikerhodesideas/8020api` | The API that mints invite codes, resolves them, and mints GitHub App installation tokens for the watcher. Endpoints live in `server/team-brain.ts`. |
| `mikerhodesideas/agency-brain-portal` | The web portal at agency.ads2ai.com. Owners and scouts add team members, send invites, monitor sync state. |
| `8020brain/agency-brain-template` | Template repo every new agency clones. Defines the folder layout, ships starter `CLAUDE.md`, and ships the `agency: true` skill set. |

### Reporting an issue

Email `mike@ads2ai.com` with a short description and a log snippet if relevant. The log lives at `~/Library/Logs/Agency Brain/sync.log` on Mac and `%APPDATA%\Agency Brain\sync.log` on Windows.

## License

UNLICENSED. Internal use within 8020brain.
