# Fix playbook: UNKNOWN

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

The app hit a problem it doesn't have a name for yet. The exact message is in fix-me.md, in the raw error and the log tail. Most often it's one of the known causes in wording the app didn't recognise, so the job is to read the message, decide which cause it really is, and follow that fix.

## Check the evidence

Read the raw error and the log tail first, then match them against this table. The fix column is the short form; each is safe, and none rewrites shared history.

| The error or log says | It really is | The fix, in short |
|---|---|---|
| `GH013`, "cannot contain secrets", "push protection" | a secret in an unsent commit | move the value out of the file, `git reset --soft origin/<branch>`, let the app recommit; rotate the key |
| "exceeds GitHub's file size limit", `GH001` | a file over 100 MB | `git reset --soft origin/<branch>`, move the file to the set-aside folder, add `/<path>` to `.git/info/exclude`, let the app recommit |
| "repository not found", `404` | the repository moved or access is gone | the GitHub organisation admin; renamed means the person sends the new URL in a reply to the email they received, or to whoever set this brain up for them |
| `403`, "permission ... denied", "protected branch", "pre-receive hook declined" | GitHub refusing writes, or a branch rule | the GitHub organisation admin re-grants the app's access or exempts the branch |
| "non-fast-forward", "fetch first", "Updates were rejected" | this copy and GitHub have diverged | `git merge --no-edit origin/<branch>`, keep both sides of any conflict (local stays, remote as `<name>__from-remote-<ts>`), commit |
| "RPC failed", `curl 56`, "unexpected disconnect", "early EOF" | a proxy or connection dropping a big upload | off VPN once; `http.postBuffer`; push older commits in chunks with `git push origin <sha>:refs/heads/<branch>` |
| "Could not resolve host", "Connection timed out", "SSL certificate problem" | offline or a firewall | reconnect, come off VPN, fix the clock, or IT allows github.com |
| `401`, "signed out", "token" | expired sign-in | the app's menu, "Reconnect / sign in again"; nothing on the command line |
| `index.lock`, "File exists" | another program holds git's lock | close Cowork and terminals; remove the lock only if over a minute old and `pgrep -fl git` is empty |
| "rebase in progress", "cherry-pick" | a half-finished manual operation | copy dirty files aside, `git rebase --abort` (or `cherry-pick --abort`) |
| "no space left", `ENOSPC` | a full disk | free space outside the brain |
| "Permission denied", "read-only file system", "operation not permitted" | ownership or a guarded folder | `sudo chown -R $(id -un) <brain>`; macOS Files and Folders permission; move out of iCloud or OneDrive |
| "gpg failed to sign", "signing failed" | commit signing on and failing | `git -C <brain> config commit.gpgsign false` |
| "tell me who you are", "empty ident" | no git name or email | `git -C <brain> config user.email` and `user.name`, repo-local |
| "bad object", "missing blob", "corrupt", "index file smaller" | damaged git data | full folder copy first, then repair or a fresh copy via the app's setup |

Nothing matching: diagnose from first principles, read-only.

```
git -C <brain> status
git -C <brain> fetch origin 2>&1 | tail -3
git -C <brain> log --oneline --left-right origin/<branch>...HEAD | head
git -C <brain> push --dry-run origin <branch> 2>&1 | tail -5
git -C <brain> fsck --no-dangling 2>&1 | head -5
cat <brain>/.git/hooks/pre-commit 2>/dev/null | head -20
df -h <brain>; ls -ld <brain> <brain>/.git
```

The dry-run push asks GitHub whether it would accept the upload without sending anything, so it reproduces most push refusals in full. A hook file that doesn't contain the words "large-file guard" is a check someone else installed and may be the cause; never bypass it.

## Fix it

Once the table or the dry run has named the cause, follow that row, keeping to the rules at the top: explain each change in one sentence, back up first, keep both sides, move rather than delete. If nothing names it, don't experiment; write down what you found in plain words and stop.

## Check it worked

The tray icon goes green within a minute or two, `git -C <brain> status --short` is clean and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing.

## Never

- Never try a fix from a row you haven't confirmed against the evidence.
- Never run `git reset --hard`, `git clean`, `git push --force` or `--no-verify` as an experiment.
- Never paste the raw error, the log or file contents into a reply. The person describes the symptom in their own words when they reply to the email they received, or contact whoever set this brain up for them.
