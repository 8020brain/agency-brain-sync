# Fix playbook: PUSH_FORBIDDEN

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

GitHub knows who this computer is but won't let it write to the shared brain's repository. Either the app's access to the repository was removed or narrowed on GitHub, or a rule on the branch (branch protection, a ruleset) blocks direct uploads. Nothing on this computer is wrong, and the work is safe here until access is back.

## Check the evidence

```
git -C <brain> remote -v
git -C <brain> ls-remote origin 2>&1 | head -5
git -C <brain> log --oneline origin/<branch>..HEAD
```

If `remote -v` shows a URL with `x-access-token:` in it, that's a temporary key the app embeds during a push; never copy that line anywhere, and quote the URL without the part before `@` when you write to anyone. Then read the results:

- `ls-remote` succeeds: reading still works, so writing is what's blocked. The raw error says "permission to <repo> denied", "write access to repository not granted" or "403".
- `ls-remote` fails with 403 or 404: the app's access to the repository is gone entirely (GitHub hides a private repository from anyone without access, so a 404 can mean the same thing).
- `ls-remote` fails with 401: the sign-in key has expired. That's a different cause: the person opens the app's menu and chooses "Reconnect / sign in again", and nothing below applies.
- The raw error says "protected branch", "pre-receive hook declined" or names a ruleset: a rule on `<branch>` refuses direct pushes.

## Fix it

There's nothing to run on the command line. The fix is with whoever administers the GitHub organisation that holds the repository, and the person sends them one of these:

1. Access removed: "The brain sync app on my computer can no longer write to the repository <owner/name>. Under the organisation's Settings, then GitHub Apps, can you check that the sync app is still installed, that its repository access includes <owner/name> ('All repositories', or that one selected), and that nothing about the repository changed recently?"
2. A branch rule: "A branch protection rule or ruleset on <branch> in <owner/name> is blocking the sync app's uploads (the error says <'protected branch' or 'pre-receive hook declined'>). The app needs to push to <branch> directly, so can you exempt the app from that rule, or remove it for that branch?"
3. Nothing changed on their side that they know of: the person replies to the email they received, or contacts whoever set this brain up for them, and says so.

## Check it worked

Once the admin has made the change, `git -C <brain> ls-remote origin` succeeds, the tray icon goes green within a minute or two, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing.

## Never

- Never create a personal access token and put it in the remote URL or a credential helper; the app manages its own key, and a personal key would give the sync more than the person's own access.
- Never push to a different branch to get around a rule, and never change the remote URL.
- Never force-push.
