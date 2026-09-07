# Fix playbook: REPO_CORRUPT

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

The hidden git data under the brain folder is damaged, usually after a full disk, a crash, or a copy interrupted half-way. The files the person sees are almost always fine; it's git's own bookkeeping that's broken. The recovery keeps a complete copy of everything first, fetches a fresh copy of the shared brain, and puts any unsent work back.

## Check the evidence

```
git -C <brain> fsck --no-dangling 2>&1 | head -20
git -C <brain> status 2>&1 | head -5
git -C <brain> log --oneline origin/<branch>..HEAD 2>&1
git -C <brain> remote get-url origin
df -h <brain>
```

"missing blob", "missing tree", "bad object", "corrupt loose object" or "index file smaller than expected" from fsck confirms the code. A `status` that works and an fsck that only mentions dangling objects means the repository is fine, and this isn't the cause; say so and stop. A full disk in the last line is likely what caused it, and must be fixed first. The third command, if it still works, shows unsent commits; note them. If the remote URL contains `x-access-token:`, never copy it anywhere.

## Fix it

1. Complete copy first, before anything else. Say: "I'm copying the whole brain folder to your Desktop, including the damaged git data and any unsent work, so nothing can be lost by the next steps."

```
mkdir -p ~/Desktop/brain-set-aside/$(date +%Y%m%d)
cp -Rp <brain> ~/Desktop/brain-set-aside/$(date +%Y%m%d)/brain-damaged
```

2. Only the index damaged ("index file smaller than expected", "bad index file"): the gentle repair. `mv <brain>/.git/index ~/Desktop/brain-set-aside/$(date +%Y%m%d)/index-damaged && git -C <brain> reset`. Say: "This rebuilds git's list of tracked files from the last save; your files themselves aren't touched." Then run fsck again; clean means done.
3. Missing objects: try `git -C <brain> fetch origin`, which re-downloads any object the shared brain still has, then fsck again. Clean means done.
4. Still damaged: a fresh copy through the app, which holds the sign-in. Ask the person to fully quit the app. Then `mv <brain> <brain>-damaged`. Open the app: it notices the folder is missing, offers "Open setup", and downloads a fresh copy; choose the same location when it asks where the brain should live. (For a personal brain using the computer's own GitHub credentials, `git clone "$(git -C <brain>-damaged remote get-url origin)" <brain>` does the same by hand.)
5. Put unsent work back. Compare the damaged copy with the fresh one:

```
diff -rq <brain>-damaged <brain> -x .git | grep -v "^Only in <brain>:"
```

For each file listed, check which is newer (`ls -l` both) and copy the damaged copy's version into the fresh folder when it's newer or exists only there. Also look in `<brain>-damaged/.git/agencybrain-held/` for edits the app set aside earlier and copy any the person wants. The app commits what you copy in within a couple of minutes.
6. Move `<brain>-damaged` into the set-aside folder once the person is happy, and leave it there for a few weeks.

## Check it worked

`git -C <brain> fsck --no-dangling` prints nothing, the tray icon goes green within a minute or two, and `git -C <brain> status --short` and `git -C <brain> log --oneline origin/<branch>..HEAD` come back clean once the app has synced.

## Never

- Never `git gc`, `git prune` or `git repack` on a damaged repository before the complete copy exists.
- Never `rm -rf .git`, and never clone over the top of the existing folder.
- Never delete the damaged copy in this session.
