# Changelog

## 0.9.15 — 2026-06-10

- **Sync: skills are read-only for team roles.** A team member's edit to a protected path (a skill, `.claude/`, `.team-config/` config, `.github/`, `.gitignore`, root files) is now backed up to a sidecar under `.git/`, reverted, and (for skills) filed as a `flag-skill` note to their scout. This stops the silent sync wedge that happened when a held edit collided with an upstream change to the same file. Opens `.team-config/feedback/` for team push so flags actually reach scouts. Adds a merge safety net that clears any uncommitted blocker and retries the pull, so no single file can stall sync. (Reported by Peter Tyler.)
- **Onboarding: footer identity line.** The wizard footer now shows the signed-in email, role, and app version, so a stuck member can read it straight off a screenshot when they email for help.
