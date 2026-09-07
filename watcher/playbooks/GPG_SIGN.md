# Fix playbook: GPG_SIGN

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

Git on this computer is set to sign every save with a personal key, and the signing is failing, so no save can be made. The app runs in the background with no window to ask for a passphrase in, which is why signing so often fails here even when it works in a terminal. The one-line fix is to switch signing off for the brain folder only.

## Check the evidence

```
git -C <brain> config --show-origin --get commit.gpgsign
git -C <brain> config --show-origin --get gpg.format
git -C <brain> config --show-origin --get user.signingkey
git -C <brain> config --show-origin --get gpg.program
```

`commit.gpgsign` set to `true` (the `--show-origin` column says which config file set it, usually the global one) confirms the code. The raw error says "gpg failed to sign the data", "signing failed: No secret key", "No pinentry" or "ssh-keygen: signing failed".

## Fix it

1. `git -C <brain> config commit.gpgsign false`. Say: "This switches signing off for this brain folder only; your other repositories keep signing exactly as before." The setting lands in the folder's own `.git/config` and overrides the global one.
2. If the person wants their saves in the brain signed anyway, that's a conversation about their key agent and passphrase caching, and it's theirs to have with their own tooling; the app can't type a passphrase. Leave signing off until that's sorted.

## Check it worked

`git -C <brain> config --get commit.gpgsign` prints `false`, the tray icon goes green within a minute or two, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing once the app has pushed.

## Never

- Never use `--global` unless the person asks for signing off everywhere.
- Never delete, export or move their signing keys.
- Never edit their global git config or their gpg or ssh agent setup without being asked.
