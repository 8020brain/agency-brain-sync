# Fix playbook: REBASE_IN_PROGRESS

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

Someone (usually a Claude session or a command typed in a terminal) started a git rebase or cherry-pick in this folder and never finished it. The app never starts those itself, so it waits rather than guess. Abandoning the half-finished operation puts the folder back exactly as it was before it began; nothing that was saved is lost.

## Check the evidence

```
git -C <brain> status
ls -d <brain>/.git/rebase-merge <brain>/.git/rebase-apply <brain>/.git/CHERRY_PICK_HEAD 2>/dev/null
cat <brain>/.git/rebase-merge/head-name <brain>/.git/rebase-merge/orig-head 2>/dev/null
git -C <brain> status --short
git -C <brain> diff --name-only --diff-filter=U
```

Status says "rebase in progress" or "You are currently cherry-picking", which confirms the code. `head-name` is the branch being rebased and `orig-head` is the commit it sat on before the rebase started; aborting returns to exactly that. `status --short` shows edits made in the folder since; note them, because the next step protects them.

## Fix it

1. Write the backup ref (see the rules). If `orig-head` exists, keep that too: `git -C <brain> update-ref refs/backups/fix-orig-$(date +%Y%m%d-%H%M%S) $(cat <brain>/.git/rebase-merge/orig-head)`.
2. If `status --short` listed modified files, copy them to `~/Desktop/brain-set-aside/$(date +%Y%m%d)/<same folder path>/` first (`cp -p`, keeping the path). Say: "I'm keeping a copy of the files you changed while this was half-finished, so nothing can be undone by the next step."
3. Abandon the operation: `git -C <brain> rebase --abort` (for a cherry-pick, `git -C <brain> cherry-pick --abort`). Say: "This abandons the half-finished operation and restores the branch to exactly where it was before it started."
4. Confirm: `git -C <brain> status` shows the branch and no operation in progress, and `git -C <brain> log --oneline -3` starts with the `orig-head` commit. Compare the copies from step 2 with the folder (`diff`), and copy back any that differ.
5. If the abort says "No rebase in progress" while the directories are still there, they're stale leftovers: move them out, `mv <brain>/.git/rebase-merge ~/Desktop/brain-set-aside/$(date +%Y%m%d)/`, and check status again.

If the person wanted the rebase finished, explain that the app merges remote changes on its own and keeps both sides, so the rebase isn't needed.

## Check it worked

No rebase or cherry-pick directories remain, the tray icon goes green within a minute or two, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing once the app has pushed.

## Never

- Never `git rebase --continue` or `--skip`; that replays commits and changes history.
- Never `git reset --hard`.
- Never remove the rebase directories while `git status` still reports a rebase in progress.
- Never force-push.
