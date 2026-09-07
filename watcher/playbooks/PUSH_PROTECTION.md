# Fix playbook: PUSH_PROTECTION

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

GitHub scans every upload for things that look like passwords or API keys, and it refused this one (its error code is GH013). Nothing is lost: the change is saved on this computer in a commit the app made, and GitHub simply won't take that commit. The secret has to come out of the brain, and then the unsent commits get redone without it.

## Check the evidence

```
git -C <brain> fetch origin
git -C <brain> log --oneline origin/<branch>..HEAD
```

That's the list of unsent commits. The raw error in fix-me.md names each secret with a `commit:` line and a `path: <file>:<line>` line. Confirm each one, and check whether it's still in the working copy:

```
git -C <brain> show <sha>:"<file>" | sed -n '<line>p'
grep -n "<first 8 characters of the value>" <brain>/"<file>"
grep -rln "<first 8 characters>" <brain> --exclude-dir=.git
```

If any `commit:` the error names is NOT in the `origin/<branch>..HEAD` list, stop: that secret reached GitHub earlier and this playbook can't help. The person rotates the key, then replies to the email they received, or contacts whoever set this brain up for them.

## Fix it

1. Write the backup ref (see the rules).
2. Move the secret out. Open the file, cut the value into the person's password manager (or a file outside the brain, or one listed in `.gitignore`), and replace it in the file with a placeholder such as `<stored in 1Password>`. Say: "I'll replace the key on line <n> of <file> with a placeholder; the value itself goes in your password manager." Do the same for every flagged spot and every copy the grep found.
3. Rewrite only the unsent commits: `git -C <brain> reset --soft origin/<branch>`. Say: "This keeps every change from your unsent commits in the folder and staged; it only forgets the commit wrappers GitHub refused." Nothing that already reached GitHub is touched.
4. Let the app make the next commit itself (it does within about two minutes), or run `git -C <brain> commit -m "auto-sync: remove secret"` yourself. The app's own hook runs as normal.
5. If the value is a real live key, tell the person to revoke it and issue a new one with the service it belongs to. It has sat in a commit on this disk and GitHub has seen it, so treat it as exposed.

## Check it worked

Within a minute or two the tray icon goes green and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing. Confirm the value is gone from the history that gets shared: `git -C <brain> log -S"<first 8 characters>" --oneline HEAD` prints nothing. The backup ref written at step 1 still holds the old commit on this computer only; it is never pushed, and the app trims old backup refs itself.

## Never

- Never force-push, and never `git rebase -i`, `filter-branch` or `filter-repo` on commits that have reached GitHub.
- Never use the "unblock" link GitHub prints in the error without the person confirming with whoever owns the GitHub organisation that it's a false positive. Moving the value out is always the safer path.
- Never put the secret in a commit message, a sidecar file or the set-aside folder in plain text.
- Never push while the value is still in any unsent commit.
