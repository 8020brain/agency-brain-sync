# Fix playbook: PUSH_NETWORK

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

The upload to GitHub starts but fails part-way, again and again. That's usually a VPN, a company proxy, or a connection that drops on bigger transfers, and it often clears by itself. Nothing is lost; the work is saved in this folder and the app keeps trying.

## Check the evidence

```
curl -sI https://github.com | head -1
git -C <brain> ls-remote origin 2>&1 | head -3
git -C <brain> config --get http.proxy; git -C <brain> config --global --get http.proxy; env | grep -i proxy
git -C <brain> log --oneline origin/<branch>..HEAD | wc -l
git -C <brain> rev-list --objects origin/<branch>..HEAD | git -C <brain> cat-file --batch-check='%(objectsize) %(rest)' | sort -rn | head -5
```

A `200` from curl and a working `ls-remote` mean small requests get through, so the size of the upload is what fails; the raw error says "RPC failed", "HTTP 400/408/5xx", "curl 22" or "curl 56", "unexpected disconnect while reading sideband packet" or "early EOF". A proxy in the third line's output is the likely culprit. The last two lines say how many commits are waiting and which objects in them are largest (sizes in bytes).

## Fix it

1. Off the VPN or office network once, then wait two minutes. If the app has marked itself stuck, ask the person to fully quit and reopen it so it retries straight away.
2. A proxy that's required: two repo-local settings that make uploads friendlier to proxies. Say: "These change how git sends this folder's uploads, nothing else on the computer." `git -C <brain> config http.postBuffer 524288000` and `git -C <brain> config http.version HTTP/1.1`. Then wait for the next retry.
3. Still failing: push in chunks, oldest first. Say: "This uploads only the first part of the waiting history; nothing is skipped or rewritten, and the app pushes the rest." List the waiting commits with `git -C <brain> log --oneline --reverse origin/<branch>..HEAD`, pick one a few commits up from the bottom, and run:

```
git -C <brain> push origin <that sha>:refs/heads/<branch>
```

Repeat with a later sha until the app's own push lands. If git asks for a username or password, press Ctrl+C and type nothing; the app's key isn't available to a hand push yet, so the person chooses "Reconnect / sign in again" in the app's menu and you wait for the app instead.
4. A single object over 100 MB in the last command's output is a different cause (a file too big for GitHub); set it aside as for PUSH_TOO_BIG and say so.
5. A company network that never lets a large upload through: the person asks IT, "The brain sync tool on my machine can't upload to github.com through the proxy; uploads fail part-way with <the error line, minus any file names>. Can github.com be allowed directly, or the upload size or time limit raised?"

## Check it worked

The tray icon goes green within a minute or two and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing.

## Never

- Never `git push --force`.
- Never remove or edit a proxy setting a company put in place; ask IT instead.
- Never switch off certificate checking (`http.sslVerify false`), whatever an error message suggests.
