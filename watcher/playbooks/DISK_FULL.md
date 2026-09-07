# Fix playbook: DISK_FULL

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

The computer has run out of disk space, so git can't write a save. Nothing is lost, but nothing can be saved either until there's room. Freeing space is the whole fix, and none of it happens inside the brain folder.

## Check the evidence

```
df -h <brain>
du -sh ~/Downloads ~/.Trash 2>/dev/null
du -sh ~/* 2>/dev/null | sort -h | tail -8
```

The first line shows how full the disk holding the brain is (anything under a few hundred MB free confirms the code). The others show where the space has gone.

## Fix it

1. Empty the bin, clear Downloads, and remove the largest items from the third command's list that the person doesn't need. On macOS, System Settings, General, Storage shows the same picture; on Windows, Settings, System, Storage. Say what each candidate is before it goes.
2. Aim for several GB free, not just enough for one save.
3. The app retries every minute and resumes on its own.

## Check it worked

`df -h <brain>` shows free space, the tray icon goes green within a minute or two, and `git -C <brain> status --short` and `git -C <brain> log --oneline origin/<branch>..HEAD` come back clean once the app has synced.

## Never

- Never delete anything inside the brain folder or its `.git` folder to make room.
- Never run `git gc` or `git prune` on a full disk; a repack that fails half-way can damage the repository.
- Never move the brain to an external drive or a cloud-synced folder to make room; both fight git.
