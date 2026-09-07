# Fix playbook: PERMISSIONS

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

The brain folder, or its hidden `.git` folder, is read-only for the account running the app, so git can't write a save. Usually a file inside got owned by another account (a `sudo` command, a restore from backup), the folder sits somewhere macOS or Windows guards, or it lives in a cloud-synced location. The work is safe; git just can't record it yet.

## Check the evidence

```
ls -ld <brain> <brain>/.git
find <brain>/.git -not -user $(id -un) | head
find <brain> -not -perm -u+w -not -path '*/.git/objects/*' | head
touch <brain>/.git/write-test && rm <brain>/.git/write-test && echo "git folder writable"
echo <brain> | grep -iE "icloud|mobile documents|onedrive|dropbox|google drive|/Volumes/"
```

The raw error says "Permission denied", "insufficient permission", "read-only file system" or "operation not permitted". Files not owned by the person, or without the write bit, point at ownership. A failed `touch` with the ownership fine points at the system: on macOS, a GUI app needs permission to write inside Desktop, Documents or Downloads, and "operation not permitted" is that refusal; on Windows, Controlled Folder Access or a managed OneDrive folder does the same. A path in a cloud-synced location is its own cause. (Object files under `.git/objects` are meant to be read-only, which is why the third command skips them.)

## Fix it

1. Ownership: `sudo chown -R $(id -un) <brain>`. Say: "This gives your account back ownership of every file in the brain folder; nothing outside the folder changes." Then the write bit if needed: `chmod -R u+rwX <brain>`. Both act on the brain folder only.
2. macOS guarded folder: System Settings, Privacy & Security, Files and Folders (or Full Disk Access), switch the app on, then fully quit and reopen it. Windows: Windows Security, Virus & threat protection, Ransomware protection, and allow the app under Controlled Folder Access.
3. A cloud-synced location: the brain belongs in a plain folder such as `~/Projects`. Quit the app, `mv` the folder there, open the app, choose Settings, then "Run setup again", and pick the moved folder (the app uses an existing clone as it is).
4. A managed work computer where none of that is allowed: the person asks IT, "The brain sync app needs read and write access to the folder <brain> and its hidden .git folder for my account; it's currently refused with <the error, minus any file names>."

## Check it worked

The `touch` test prints "git folder writable", the tray icon goes green within a minute or two, and `git -C <brain> status --short` and `git -C <brain> log --oneline origin/<branch>..HEAD` come back clean once the app has synced.

## Never

- Never `chmod 777` anything, and never `chown` or `chmod` outside the brain folder.
- Never run the app or git with `sudo`.
- Never turn off Gatekeeper, System Integrity Protection, or a company's device management to get around this.
