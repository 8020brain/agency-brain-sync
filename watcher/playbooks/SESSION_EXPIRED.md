# Fix playbook: SESSION_EXPIRED

## Rules for this session

You're reading this because the app that keeps this brain folder in sync with GitHub has stopped, and the person you're helping chose "Help me fix this" in its menu. You are acting as that person, with exactly their permissions and nothing more. The file you're reading, fix-me.md, carries the brain folder path, the cause code, the app's own reason, git's raw error, the last 60 lines of the app's log and a `git status --short`. Read all of it before you run anything. In the commands below, `<brain>` is that folder path, and `<branch>` is whatever `git -C <brain> rev-parse --abbrev-ref HEAD` prints (usually `main`).

- Never run `git commit --no-verify`, and never bypass, edit, disable or delete a git hook.
- Never run `git push --force` (or `--force-with-lease`), and never rewrite history that has already reached GitHub.
- Never delete one of the person's files from the brain folder. Move it to `~/Desktop/brain-set-aside/<today's date>/` instead, keeping its folder path, and tell the person where it went.
- Before any change to the repository, run `git -C <brain> update-ref refs/backups/fix-$(date +%Y%m%d-%H%M%S) HEAD` so every commit stays reachable whatever happens next.
- Read-only commands first. Before each change, explain it in one sentence and wait for a yes.
- The app keeps retrying on its own: every minute normally, every five minutes once it has marked itself stuck. After a fix, wait a minute or two and check the tray icon rather than pushing by hand. Fully quitting and reopening the app resets the five-minute wait.
- If anything in the evidence contradicts this playbook, stop and say so.
- If you can't fix it in a few steps, tell the person to reply to the email they received about this, or to contact whoever set this brain up for them, and stop.
- Never send the raw error text, the log or any file contents anywhere off this computer. They can carry private client text.
- The commands are written for the macOS and Linux shell. On Windows, run them in Git Bash or translate the shell parts; the git commands are the same everywhere.

## What this means

The app signs this computer in with a short-lived key it renews from the server, and that sign-in has expired or been cleared. Nothing is wrong with the folder or with GitHub. Syncing is paused until the person signs in again, and everything they've saved since is waiting safely in the folder.

## Check the evidence

The log tail in fix-me.md says the key request was refused with a 401, or that the app is signed out. The only commands worth running are read-only ones that show the person what's waiting:

```
git -C <brain> status --short
git -C <brain> log --oneline origin/<branch>..HEAD
```

If the log tail instead shows a 403 or 409 from the server, that's a different cause (the server refused this machine for a stated reason, which the app's status line carries), and the sign-in step below won't clear it; say so and stop.

## Fix it

Nothing on the command line. The person opens the app from the menu bar (Windows: the system tray, bottom right), chooses "Reconnect / sign in again", enters their email and the one-time code that arrives. Say: "The fix is one tap in the app's menu; there's nothing to type in a terminal."

## Check it worked

Within a minute or two the tray icon goes green, the log shows normal sync cycles again, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing once the waiting work has uploaded.

## Never

- Never type a GitHub password or a personal access token into a git prompt; there's no password to give, and the app supplies its own key once signed in.
- Never change `credential.helper` in the folder's git config.
- Never `git push` by hand.
