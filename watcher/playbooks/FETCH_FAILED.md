# Fix playbook: FETCH_FAILED

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

The app can't reach GitHub at all right now. Everything saved on this computer waits in the folder and uploads the moment the connection is back. If the person is online and this has lasted hours, a VPN, firewall or proxy is blocking github.com, or the computer's clock is wrong.

## Check the evidence

```
curl -sI https://github.com | head -1
curl -sI https://api.github.com | head -1
git -C <brain> ls-remote origin 2>&1 | head -3
git -C <brain> config --get http.proxy; env | grep -i proxy
date
```

No `200` from either curl means the computer can't reach GitHub; "Could not resolve host" is DNS or no connection, "Connection timed out" or "refused" is a firewall or proxy, and "SSL certificate problem" is a proxy inspecting traffic or a clock that's badly wrong. `ls-remote` working means the connection is back and the app clears itself on its next cycle. A `401` from `ls-remote` is an expired sign-in instead: the person chooses "Reconnect / sign in again" in the app's menu.

## Fix it

1. Reconnect to the internet, or come off the VPN once, and wait two minutes. If the app has marked itself stuck, ask the person to fully quit and reopen it.
2. A wrong clock: fix the date and time in system settings (turn on automatic time), then wait.
3. A company firewall or proxy: the person asks IT, "Please allow HTTPS to github.com and api.github.com from my machine; the brain sync tool needs both."
4. An inspecting proxy and an "SSL certificate problem": IT supplies their certificate file, and you point this folder at it with `git -C <brain> config http.sslCAInfo "<path to the certificate file>"`. Say: "This tells git in this folder to trust your company's certificate; nothing else changes and checking stays on."

## Check it worked

`git -C <brain> ls-remote origin` lists branches, the tray icon goes green within a minute or two, and `git -C <brain> log --oneline origin/<branch>..HEAD` prints nothing once the waiting work has uploaded.

## Never

- Never switch off certificate checking (`http.sslVerify false`).
- Never edit the hosts file or the proxy settings a company put in place.
- Never `git push` by hand.
