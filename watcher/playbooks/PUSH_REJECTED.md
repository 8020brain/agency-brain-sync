# Fix playbook: PUSH_REJECTED

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

This copy of the brain and the shared copy on GitHub have moved apart, and the app's automatic merge couldn't settle it after several tries. The app's merge keeps both sides: when the same file changed in both places, your version stays and the other version is written beside it as `<name>__from-remote-<timestamp>`. Your work is safe in this folder. The fix is to finish that merge by hand the same way.

## Check the evidence

```
git -C <brain> fetch origin
git -C <brain> status
git -C <brain> log --oneline --left-right origin/<branch>...HEAD
ls <brain>/.git/MERGE_HEAD 2>/dev/null && echo "merge in progress"
git -C <brain> diff --name-only --diff-filter=U
grep -c "large-file guard" <brain>/.git/hooks/pre-commit 2>/dev/null
```

In the left-right log, `<` lines are commits only on GitHub and `>` lines are only here; both present confirms the split. `MERGE_HEAD` plus files from the `--diff-filter=U` line means a merge stopped on conflicts in those files. The raw error says "non-fast-forward", "fetch first" or "Updates were rejected". If the grep prints `0`, a foreign check is refusing the merge commit itself, and that is the real cause: read the hook, find the file it names in the log, and fix that file first.

## Fix it

First ask the person to fully quit and reopen the app, then wait five minutes; it merges on its own in most cases. If it's still stuck:

1. Write the backup ref (see the rules).
2. With no merge in progress: `git -C <brain> merge --no-edit origin/<branch>`. Say: "This folds GitHub's commits into this copy; if the same file changed in both places, git stops and asks." A clean merge is finished; the app pushes it.
3. With conflicts (now, or already in progress), keep both versions of each conflicted file. Your version stays as the file; GitHub's version becomes a sidecar:

```
f="<conflicted file>"; ts=$(date +%Y%m%d-%H%M%S)
case "$f" in *.*) side="${f%.*}__from-remote-${ts}.${f##*.}";; *) side="${f}__from-remote-${ts}";; esac
git -C <brain> show ":3:$f" > "<brain>/$side"
git -C <brain> checkout --ours -- "$f"
git -C <brain> add -- "$f" "$side"
```

Say: "Your version of <file> stays; the teammate's version sits next to it as <sidecar> so nothing is lost, and you can fold the two together later." If the person would rather take GitHub's version, save theirs first (`git -C <brain> show ":2:$f" > "<brain>/<name>__from-local-${ts}<ext>"`), then `git -C <brain> checkout --theirs -- "$f"` and add both. A file git reports as deleted on one side only: keep it with `git -C <brain> add -- "$f"` after checking the person wants it.

4. Finish: `git -C <brain> commit -m "auto-sync merge $(date +%Y%m%d-%H%M%S) (kept both sides, resolved by hand)"`. The app pushes within a minute or two.

## Check it worked

`git -C <brain> status` shows a clean tree on `<branch>` with no merge in progress, the tray icon goes green, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing once the push lands. Any `__from-remote-` sidecars are the person's to read and fold in later.

## Never

- Never `git reset --hard` without the backup ref, and never as a shortcut to "match GitHub"; that throws away the local commits.
- Never `git checkout --theirs` over a person's file without saving their version first.
- Never `git rebase`, `git pull --rebase` or `git push --force`.
- Never `git stash`; the app's convention is commits and sidecars, which can't be forgotten.
