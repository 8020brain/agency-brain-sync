# Fix playbook: MERGE_STUCK

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

Every minute the app pulls your teammates' latest changes and merges them into this copy, and that merge has now failed several times running. Your work is safe. The usual causes are a conflict git can't settle, a local file the merge can't overwrite, a file that another program is holding open, or a check refusing the merge commit.

## Check the evidence

```
git -C <brain> fetch origin
git -C <brain> status
git -C <brain> log --oneline --left-right origin/<branch>...HEAD
ls <brain>/.git/MERGE_HEAD 2>/dev/null && echo "merge in progress"
git -C <brain> diff --name-only --diff-filter=U
git -C <brain> diff --name-only HEAD origin/<branch>
grep -c "large-file guard" <brain>/.git/hooks/pre-commit 2>/dev/null
```

The log tail in fix-me.md carries the merge's own words. "Your local changes to the following files would be overwritten by merge" names local edits that overlap files GitHub changed (compare `status --short` with the sixth command's list). `MERGE_HEAD` plus `--diff-filter=U` files means a merge is waiting on conflicts. "error: unable to unlink" or "Permission denied" means a program holds the file (Excel and Word leave `~$name` lock files) or the folder is read-only. A grep of `0` means a foreign check is refusing the merge commit; read the hook and fix the file it names first.

## Fix it

First ask the person to fully quit and reopen the app and wait five minutes. If it's still stuck:

1. Write the backup ref (see the rules).
2. Local edits overlap GitHub's changes: save them as a commit first, then merge. `git -C <brain> add -A && git -C <brain> commit -m "auto-sync: save local work before merge"`, then `git -C <brain> merge --no-edit origin/<branch>`. Say: "This saves your edits as they are, then folds in the team's changes; if the same file changed in both, git stops and asks."
3. Conflicts: keep both versions. Your version stays as the file; GitHub's becomes a sidecar named the way the app names them.

```
f="<conflicted file>"; ts=$(date +%Y%m%d-%H%M%S)
case "$f" in *.*) side="${f%.*}__from-remote-${ts}.${f##*.}";; *) side="${f}__from-remote-${ts}";; esac
git -C <brain> show ":3:$f" > "<brain>/$side"
git -C <brain> checkout --ours -- "$f"
git -C <brain> add -- "$f" "$side"
```

Then `git -C <brain> commit -m "auto-sync merge $(date +%Y%m%d-%H%M%S) (kept both sides, resolved by hand)"`. To take GitHub's version instead, save theirs first with `git -C <brain> show ":2:$f" > "<brain>/<name>__from-local-${ts}<ext>"`, then `checkout --theirs`.

4. A held-open file: close the program that has it open (Excel, Word, a PDF viewer), wait a minute, and the app retries. A `~$` lock file is that program's, not the person's; it vanishes when the document closes.
5. Permission or disk errors: those are their own causes (PERMISSIONS, DISK_FULL). Check `ls -ld <brain>` and `df -h <brain>`, and if either is the problem, say so and stop here; the person can choose Help me fix this again once the app has re-classified it.

## Check it worked

`git -C <brain> status` is clean on `<branch>` with no merge in progress, the tray icon goes green within a minute or two, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing once the push lands.

## Never

- Never `git reset --hard` or `git checkout -- .` to clear local edits; commit them or copy them to the set-aside folder.
- Never `git checkout --theirs` over a person's file without saving their version first.
- Never `git rebase`, `git pull --rebase`, `git stash` or `git push --force`.
