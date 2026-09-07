# Fix playbooks

One markdown file per cause code in `watcher/cause-codes.js`. When a person's brain stops syncing and they choose "Help me fix this" in the app's menu, the app writes a local `fix-me.md` and opens the person's own Claude on it (Claude Code in a terminal in the brain folder, or the Claude desktop app in Cowork mode with the brain folder connected) with the prompt "read fix-me.md and walk me through it". The playbook is the part of that file that tells the agent what to do.

Each playbook is written FOR THAT CLAUDE, acting as the person, with exactly the person's permissions. It has to let a competent agent confirm the cause from the local evidence and fix it with the person, step by step, without doing anything destructive and without anything leaving the computer.

## The contract with fix-me.md

`main.js` assembles `fix-me.md` in this order:

1. The cause code.
2. The app's plain-English reason (the `label` and `steps` from `cause-codes.js`, or the server's sentence).
3. Git's raw error, local only, never sent anywhere.
4. The last 60 lines of the app's `sync.log`.
5. `git status --short` of the brain folder, and the folder's path.
6. The playbook for that code, `watcher/playbooks/<CODE>.md`, verbatim.

So a playbook can assume the agent has all five pieces of evidence above it, and it refers to them as "the raw error in fix-me.md" and "the log tail". It writes `<brain>` for the folder path and `<branch>` for the branch, and tells the agent where to get both. It never assumes any other playbook is readable on the person's machine (the app ships them inside its bundle), which is why UNKNOWN.md carries its own table of the other causes.

## The guardrail header every file must carry

Every playbook opens with `# Fix playbook: <CODE>` followed by a section titled `## Rules for this session`. That section is byte-identical in all twenty files. It's the safety contract: never `--no-verify`, never force-push or rewrite shared history, never delete the person's files (move them to `~/Desktop/brain-set-aside/<date>/`), back up with a `refs/backups/fix-<timestamp>` ref before any change, read-only commands first and a yes before each change, let the app do the pushing, stop if the evidence contradicts the playbook, hand off to the email the person received, or to whoever set the brain up for them, when a few steps don't fix it, and never send the raw error anywhere. To change the rules, change them in every file in the same commit.

After the rules, every file has these sections in this order and nothing else: `## What this means`, `## Check the evidence`, `## Fix it`, `## Check it worked`, `## Never`.

## Tests

`tests/stop-reason-privacy.test.cjs` fails if any code in `CODE_LIST` has no `watcher/playbooks/<CODE>.md`. Adding a code to `cause-codes.js` therefore means writing its playbook in the same commit, and the server's copy in `8020api/server/sync-causes.ts` in the same change.

## Style

Plain English, written to one person as "you", full sentences with a subject and a verb, contractions, no em dashes anywhere (a comma or a full stop instead), no header deeper than `##`, every command in a fenced block, and each file under about 120 lines. The product is "the app" and the folder is "the brain"; a client brain is white-label and shows its own brand, so the app's name never appears in a playbook. Never "we", "us" or "our". No person's name or email address appears anywhere: the handoff is always "reply to the email you received, or contact whoever set this brain up for you".
