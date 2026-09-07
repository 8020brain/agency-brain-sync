# Fix playbook: NO_GIT_IDENT

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

Git refuses to make a save until it knows whose name and email to record, and neither is set on this computer. The app normally writes both into the brain folder's own git config itself, so if you're seeing this, that didn't work here (most often because the folder's config file couldn't be written).

## Check the evidence

```
git -C <brain> config --show-origin --get user.email
git -C <brain> config --show-origin --get user.name
ls -l <brain>/.git/config
```

Both empty confirms the code; the raw error says "Please tell me who you are" or "empty ident name". If `.git/config` isn't writable by the person, the real cause is permissions (fix that first, following the ownership steps: `sudo chown $(id -un) <brain>/.git/config`, explained).

## Fix it

1. Ask the person which email they signed into the app with, and how they'd like their name to appear. Then, repo-local only:

```
git -C <brain> config user.email "<their email>"
git -C <brain> config user.name "<their name>"
```

Say: "This records your name and email on saves made in this brain folder only, which is what git needs before it will save anything."

## Check it worked

Both `config --get` commands print the values, the tray icon goes green within a minute or two, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing once the app has pushed.

## Never

- Never use `--global` unless the person asks.
- Never use anyone else's name or email, and never invent one.
