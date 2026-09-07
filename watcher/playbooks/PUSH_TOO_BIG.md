# Fix playbook: PUSH_TOO_BIG

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

A file bigger than GitHub accepts (100 MB per file) got into a save, usually one made outside the app, and GitHub refuses every upload that carries it. The app normally holds files over 50 MB back before this can happen, so this one slipped in another way. Everything is safe on this computer, and the fix is to set the big file aside so the rest of the work can upload.

## Check the evidence

```
git -C <brain> fetch origin
git -C <brain> log --oneline origin/<branch>..HEAD
git -C <brain> rev-list --objects origin/<branch>..HEAD | git -C <brain> cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | awk '$1=="blob" && $3 > 50*1024*1024 {printf "%d MB  %s\n", $3/1048576, $4}' | sort -rn
cat <brain>/.git/info/exclude
```

The third command lists every file over 50 MB inside the unsent commits, with its path. The raw error names the same file ("exceeds GitHub's file size limit of 100.00 MB"). An error about the pack ("pack exceeds maximum allowed size") means the whole upload is over 2 GB; the same recipe applied to the largest files fixes it. `.git/info/exclude` shows what the app already holds locally (one `/<path>` line each).

## Fix it

1. Write the backup ref (see the rules).
2. Unwind only the unsent commits: `git -C <brain> reset --soft origin/<branch>`. Say: "This keeps every change from your unsent commits in the folder and staged; it only forgets the commit wrappers GitHub refused."
3. Set the big file aside. Say: "The file goes to your Desktop untouched; it just won't live in the shared brain, which can't take files this size."

```
mkdir -p ~/Desktop/brain-set-aside/$(date +%Y%m%d)/"<folder part of the path>"
git -C <brain> rm --cached -q -- "<file>"
mv <brain>/"<file>" ~/Desktop/brain-set-aside/$(date +%Y%m%d)/"<file>"
echo "/<file>" >> <brain>/.git/info/exclude
```

The exclude line is local to this computer and means a copy that comes back later never re-enters a save. If the person wants the file to stay in the folder for their own use, skip the `mv` and keep the other three lines.

4. Let the app make the next commit itself (within about two minutes), or run `git -C <brain> commit -m "auto-sync: set aside oversized file"`.

## Check it worked

Within a minute or two the tray icon goes green, `git -C <brain> status --short` is clean and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing.

## Never

- Never force-push, and never `filter-branch` or `filter-repo` history that has reached GitHub.
- Never delete the file; it goes to the set-aside folder.
- Never edit the shared `.gitignore` to hide it (that changes everyone's brain); `.git/info/exclude` is the local place.
- Never switch the repository to Git LFS on your own. That's a change for every person on the shared brain and needs its owner's decision.
