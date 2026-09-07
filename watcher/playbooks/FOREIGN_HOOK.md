# Fix playbook: FOREIGN_HOOK

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

A check that someone installed on this computer refused to save one of your files. It's a git pre-commit hook the app didn't install, most often a secret scanner or a data-protection tool, and the app never forces past a check like that because it belongs to whoever set up this computer. Everything you've written is still in the folder; it just hasn't reached the shared brain yet.

## Check the evidence

```
git -C <brain> status --short
cat <brain>/.git/hooks/pre-commit
grep -c "large-file guard" <brain>/.git/hooks/pre-commit
```

The status list is the work waiting to be saved. The hook file is the check itself: read it to learn what it looks for (a pattern, or a tool it calls such as gitleaks, talisman, pre-commit or a company script). The grep prints `0` for a hook the app didn't install, which confirms this code. If it prints `1` or more, the hook is the app's own size guard and this isn't a foreign check: look for a file over 50 MB instead (`find <brain> -size +50M -not -path '*/.git/*'`) and set it aside as described under Fix it, step 4.

Now run the check by hand against the waiting files to get the exact file and line. Staging is what the app does every cycle anyway, and `git reset -q` undoes it.

```
git -C <brain> add -A
git -C <brain> hook run pre-commit
git -C <brain> reset -q
```

(`git hook run` needs git 2.36 or newer; on older git run `cd <brain> && .git/hooks/pre-commit`.) Its output names the file and the rule. It should match the raw error in fix-me.md.

## Fix it

1. Read the flagged line together: `sed -n '<line>p' <brain>/<file>`. Decide whether that content belongs in a shared brain at all. Usually it doesn't: a password, an API key, an ID number, a client's personal details.
2. If it shouldn't be there, edit the file so the check passes. Say: "I'll take the flagged line out of <file> and put it in your password manager (or a note outside the brain); the rest of the file stays as it is." Then re-run the three staging commands above to confirm the check passes.
3. If the content does belong and the check is being over-cautious, the fix sits with whoever installed the check, never with the hook file. If the person installed the tool themselves, help them add an allow rule in that tool's own configuration (its documentation says where), then re-run the check. If IT installed it, the person writes to IT: "The pre-commit check on my machine (the file `.git/hooks/pre-commit` in <brain>) is refusing a save of <file> at line <n> under the rule <quote the rule>. Can you allow this path, or tell me how the file should be written so it passes?"
4. If the check prints no file at all, or it seems to refuse everything, find the culprit one file at a time. For each waiting file: `git -C <brain> reset -q && git -C <brain> add -- "<file>" && git -C <brain> hook run pre-commit`. The one that fails is the file to fix, or to move to `~/Desktop/brain-set-aside/$(date +%Y%m%d)/<same folder path>/` if the person prefers, so the rest can sync.

## Check it worked

The staging test above passes with everything staged. Run `git -C <brain> reset -q` and leave the commit to the app. Within a minute or two the tray icon goes green, `git -C <brain> status --short` empties, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing once the push has landed.

## Never

- Never `git commit --no-verify`, and never delete, rename, `chmod -x` or edit `.git/hooks/pre-commit`.
- Never point `core.hooksPath` somewhere else to skip the check.
- Never paste the hook's output or the flagged line into anything online, including a search engine.
