# Fix playbook: INDEX_LOCK

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

Git allows one operation at a time in a folder and marks it with a lock file, `.git/index.lock`. Another program (a Cowork session, a terminal, an editor's git panel, another sync tool) is holding it, or it crashed and left the file behind. The app removes a lock older than 45 seconds by itself, so if this persists, something keeps making a fresh one or the file can't be removed.

## Check the evidence

```
ls -la <brain>/.git/index.lock <brain>/.git/HEAD.lock <brain>/.git/config.lock 2>/dev/null
pgrep -fl git
pgrep -fli "claude|cowork|code|cursor"
echo <brain> | grep -iE "icloud|mobile documents|onedrive|dropbox|google drive"
```

The first line shows which lock exists, how old it is and who owns it. A lock over a minute old with no git process is stale. A git process means wait. A lock that's always fresh means something runs git in a loop: an editor with the folder open, or a cloud-sync tool on the folder (the last line prints the path if the brain sits in a cloud-synced location, which fights git constantly). A lock owned by a different user (often `root`, from a `sudo` command) is a permissions problem.

## Fix it

1. Ask the person to close Cowork, any terminal open in the brain folder, and any editor with the folder open, then wait a minute. The app clears a stale lock itself.
2. Only if the lock is older than a minute AND `pgrep -fl git` prints nothing: `rm <brain>/.git/index.lock` (same for `HEAD.lock` or `config.lock`). Say: "This lock file is git's busy marker, left behind by a program that has already stopped; removing it is the standard fix and touches none of your files." It isn't one of the person's files, so the set-aside rule doesn't apply.
3. Owned by another user: `sudo chown $(id -un) <brain>/.git/index.lock` is enough for the lock, but check the rest of `.git` too with `find <brain>/.git -not -user $(id -un) | head`; if more turns up, `sudo chown -R $(id -un) <brain>` on the brain folder only, explained first.
4. The brain lives in iCloud Drive, OneDrive, Dropbox or Google Drive: that's the root cause and it will keep happening. The brain belongs in a plain folder such as `~/Projects`. Moving it: quit the app, `mv` the folder to its new home, open the app, choose Settings, then "Run setup again", and pick the moved folder (the app uses an existing clone as it is).

## Check it worked

No lock file remains, the tray icon goes green within a minute or two, and `git -C <brain> status --short` and `git -C <brain> log --oneline origin/<branch>..HEAD` both come back clean once the app has synced.

## Never

- Never remove a lock younger than a minute, or while any git process is running; that can corrupt the index.
- Never kill a Cowork, Claude or editor process without the person's yes.
- Never `rm -rf .git` or anything else in `.git` beyond the lock file itself.
