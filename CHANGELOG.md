# Changelog

## 0.9.16 — 2026-06-10

- **Command Centre: agent status now reads Claude Code's native session status.** The "working / needs you / ready" chip on dispatched agents is driven by the CLI's own busy/waiting/idle field in `~/.claude/sessions/<pid>.json` (matched by session id, Mac and Windows). `busy` means working (no more flapping between transcript writes, and a mid-answer question mark can't fake a "needs you"), `waiting` (blocked on a permission dialog) means needs you, and `idle` means the agent finished its turn (so "ready" shows seconds after a turn ends instead of up to 40s later). A turn that ends with a plain-text question is still caught by the existing question-mark check, which also remains the full fallback on older CLI versions that don't write the status field.

## 0.9.15 — 2026-06-10

- **Sync: skills are read-only for team roles.** A team member's edit to a protected path (a skill, `.claude/`, `.team-config/` config, `.github/`, `.gitignore`, root files) is now backed up to a sidecar under `.git/`, reverted, and (for skills) filed as a `flag-skill` note to their scout. This stops the silent sync wedge that happened when a held edit collided with an upstream change to the same file. Opens `.team-config/feedback/` for team push so flags actually reach scouts. Adds a merge safety net that clears any uncommitted blocker and retries the pull, so no single file can stall sync. (Reported by Peter Tyler.)
- **Onboarding: footer identity line.** The wizard footer now shows the signed-in email, role, and app version, so a stuck member can read it straight off a screenshot when they email for help.
