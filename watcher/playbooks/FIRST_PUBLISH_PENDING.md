# Fix playbook: FIRST_PUBLISH_PENDING

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

This brain's very first upload to GitHub hasn't landed yet: the repository exists but has no branches, and the app retries every minute. Nothing is wrong in the folder. It usually clears on its own; if it hasn't after hours, the push is being refused for a reason in the log, or the GitHub connection step of setup never completed.

## Check the evidence

```
git -C <brain> ls-remote --heads origin 2>&1
git -C <brain> log --oneline -3
git -C <brain> rev-parse --abbrev-ref HEAD
git -C <brain> remote -v
```

An empty result from the first command with no error confirms the code: the remote is empty. A `401` is an expired sign-in (the person chooses "Reconnect / sign in again" in the app's menu). A `403` or `404` means the app can't reach the repository at all, which is a permissions or missing-repository problem for the GitHub organisation admin, not this one. Local commits in the log mean there's something to upload. The log tail in fix-me.md carries the push's own words: "protected branch" or a ruleset means a rule on the default branch is refusing the very first push; a network error means the connection.

## Fix it

1. Wait two minutes. If the app has marked itself stuck, ask the person to fully quit and reopen it.
2. A rule refusing the push: the person asks the GitHub organisation admin, "The new repository <owner/name> has a branch rule or ruleset that's refusing the brain sync app's first upload to <branch>. Can you exempt the app or remove the rule for that branch?"
3. A network error: come off the VPN once and wait; if it keeps failing, the cause is the connection, and IT may need to allow github.com.
4. The setup never finished (the log says the server has no repository for this brain, or the repository can't be reached): run the setup flow again. In the app: Settings, then "Run setup again", choosing this same folder (the app uses an existing clone as it is) and completing the GitHub connection when asked. If that doesn't complete, the person replies to the email they received, or contacts whoever set this brain up for them.

## Check it worked

`git -C <brain> ls-remote --heads origin` lists `<branch>`, the tray icon goes green within a minute or two, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing.

## Never

- Never create the repository by hand on GitHub, and never change the remote URL.
- Never `git init` again, and never force-push.
- Never push by hand; let the app's retry show what's refusing it.
