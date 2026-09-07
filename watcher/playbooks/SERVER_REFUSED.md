# Fix playbook: SERVER_REFUSED

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

Each sync, the app asks the server for a short-lived key to the shared brain, and the server said no for a reason it stated in a sentence: this seat has been handed to someone else, this brain has no repository bound to it yet, or this account no longer covers it. Nothing on this computer is broken. Whatever the person has saved waits safely in the folder.

## Check the evidence

The app's reason line in fix-me.md is the server's own sentence, and the app's status line (in its menu) shows the same words. Read it out to the person and explain it in plain terms. The only useful commands are read-only:

```
git -C <brain> status --short
git -C <brain> log --oneline origin/<branch>..HEAD
```

If the reason line says nothing about a seat, a repository or the account, and the log tail shows a 401 instead of a 403 or 409, this is really an expired sign-in: the person chooses "Reconnect / sign in again" in the app's menu.

## Fix it

Nothing on the command line. The fixes live on the portal (m.ads2ai.com) or with the person who set the brain up:

1. The seat was handed over, or this person is no longer on the team: whoever manages the team on the portal's Your Team page decides. If the person believes that's a mistake, they say so to that manager, or reply to the email they received, or contact whoever set this brain up for them.
2. No repository is bound to this brain yet: the GitHub connection step of setup never finished. Whoever set the brain up completes it: in the app, Settings, then "Run setup again", choosing this same folder (the app uses an existing clone as it is), and connecting GitHub when asked.
3. The sentence makes no sense for the person's situation: they reply to the email they received, or contact whoever set this brain up for them.

## Check it worked

Once the portal or the setup step is done, the tray icon goes green within a minute or two and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing after the waiting work has uploaded.

## Never

- Never `git push` by hand or add credentials to the folder to get around the server's answer; the server's decision is the access decision.
- Never change the remote URL.
- Never run setup again and pick a different folder; that would leave this folder and its unsent work behind.
