# Fix playbook: REPO_GONE

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

The repository the app expects isn't where it was on GitHub: renamed, moved to another organisation, made private to a group that doesn't include this computer's key, or deleted. This folder holds everything up to the last successful upload plus anything unsent, so nothing is lost as long as the folder is kept.

## Check the evidence

```
git -C <brain> remote -v
git -C <brain> ls-remote origin 2>&1 | head -5
git -C <brain> log --oneline -3
git -C <brain> log --oneline origin/<branch>..HEAD
```

The raw error says "repository not found" or "HTTP 404". GitHub returns that both for a repository that's gone and for one this key can no longer see, so the organisation admin has to say which. If `remote -v` shows a URL with `x-access-token:` in it, quote only the part after `@` when you write to anyone. The last command shows how much unsent work is waiting here.

## Fix it

1. Insurance first, since this folder may be the most complete copy right now: `mkdir -p ~/Desktop/brain-set-aside/$(date +%Y%m%d) && cp -Rp <brain> ~/Desktop/brain-set-aside/$(date +%Y%m%d)/`. Say: "I'm copying the whole brain folder to your Desktop before anything else, so a copy exists whatever turns out to have happened on GitHub."
2. The person asks whoever administers the GitHub organisation: "Was the repository <owner/name> renamed, transferred or deleted? The brain sync app on my computer can't find it (GitHub says 'repository not found'). If it was deleted, GitHub lets an organisation owner restore it within 90 days from Settings, then Deleted repositories."
3. Renamed or moved: the app needs the new address, which is set on the server rather than in this folder. The person sends the new URL in a reply to the email they received, or to whoever set this brain up for them, and it gets updated from there.
4. Restored or access re-granted: nothing to do here; the app resumes on its own.

## Check it worked

`git -C <brain> ls-remote origin` lists branches again, the tray icon goes green within a minute or two, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing once the waiting work has uploaded.

## Never

- Never change the remote URL by hand to a guessed new name.
- Never choose "Forget this brain" or "Run setup again" in the app while the repository is missing; a fresh download has nothing to download from.
- Never delete the folder or the Desktop copy.
