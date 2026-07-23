# Agency Brain — context-at-rest security

Agency Brain puts your whole business on every team member's laptop as plain
text files: all your context, all your clients, and all your clients' data.
That is fast and simple, and for a solo person it is usually fine. For an agency
holding client data it is an exposure, and clients are starting to ask three
questions: what is your data policy, where does the data live, and how is access
controlled.

This feature gives you a real answer to those three questions, and lets you pick
how cautious you want to be. It is your tradeoff to make, not ours to force.

## The three postures

You choose one in `.brain-security.json` (the `posture` field). The default is
`local`.

1. **Local (today's default).** Plain text files in the synced repo on each
   laptop. Fastest and simplest. Turn on full-disk encryption (FileVault on Mac,
   BitLocker on Windows) and that is your at-rest protection. Fine for a solo
   person who is not holding client data.

2. **Cloud folder (Google Drive or Dropbox).** Your sensitive folders live in a
   Drive-synced folder that still looks like a normal folder to Cowork and Claude
   Code. The data lives in your Google Workspace, so you get login, two-factor,
   and revoke-on-departure for free, and your answer to "where does the data
   live" becomes "our Google Workspace." The cost is speed: the first time anyone
   reads a file that Drive is holding online-only, it takes about 1.6 seconds to
   fetch, and that first-touch lag is felt more on a shared brain because every
   teammate's edit arrives online-only for the next reader. Best for bulky or
   rarely-changed files, or a solo user who values zero setup over speed.

3. **Own vault (Cloudflare).** Your sensitive folders move out of the git repo
   entirely and live as one encrypted blob in your own Cloudflare R2 bucket,
   pulled at the start of a session and scrubbed at the end. This is the fastest
   cold read (about 0.1 seconds per file, and with the session-start bundle that
   collapses to one short wait), it is encrypted, and you revoke access by
   rotating a token. The cost is a one-time setup on your own Cloudflare account.

**The promise for the vault option: the vault is always yours.** It lives on your
own Cloudflare account, holding your own data, reached only with your own
credentials. We never host your data and never hold your keys. This is the same
principle the whole product runs on: an agent never gets more access than the
person, and the brain is your company's asset, never ours to hold.

## The data-policy answer you can give a client

- **Local + FileVault:** "Our brain is stored on company laptops with full-disk
  encryption. If a laptop is lost, the disk is unreadable without the login."
- **Cloud folder:** "Your data lives in our Google Workspace, protected by our
  Google login and two-factor, and access is removed when someone leaves."
- **Own vault:** "Your data is encrypted before it leaves any laptop and stored
  in our own private cloud. Only our authenticated app can fetch it, we can cut
  off access instantly by rotating a token, and it is not sitting in plain text
  on anyone's machine between sessions."

## Turn on full-disk encryption regardless of posture

Whichever posture you pick, turn on full-disk encryption on every machine. It is
the safety net for any transient copy on disk. On Mac: System Settings, Privacy
and Security, FileVault, turn it on. On Windows: BitLocker.

## Setting up the vault

The vault is the deeper option. Full walkthrough is in `worker/README.md`.

1. Deploy the small Worker in `worker/` to your own Cloudflare account. It fronts
   your own R2 bucket and checks a bearer token. It only ever sees encrypted
   blobs.
2. Run `node cli.cjs setup --worker-url <your-worker-url> --token <your-gate-token>`.
   That generates your encryption key, saves the three values (Worker URL, token,
   key) to a gitignored secrets file, flips `.brain-security.json` to
   `posture: vault`, and runs a round-trip self-check.
3. Run `node cli.cjs push` to upload your sensitive context, then
   `node cli.cjs scrub` to remove the local plain-text copies.

From then on: a session pulls at the start and scrubs at the end (see "Wiring"
below).

## The commands

Run from your brain folder, or pass `--root <brain>`.

| Command | What it does |
|---|---|
| `setup` | One-time: generate the key, save secrets, write the config, self-check. |
| `push` | Bundle the sensitive text, encrypt it, upload one blob to your vault. Add `--scrub` to remove the local plain text in the same step. |
| `pull` | Download the blob, decrypt it in memory, write the files back for the session. |
| `scrub` | Delete the local plain text of exactly the files that are in the vault. It fetches the vault first and only deletes what is provably stored, so it can never delete something that is not safely backed up. |
| `status` | Show the posture, what is sensitive locally, whether secrets are set (presence only, never the values), and what is in the vault. |

Add `--json` to any command for machine-readable output (the hooks use this).

## The security model

- **Encryption happens on your machine, not in the cloud.** The bundle is
  encrypted with AES-256-GCM before it is uploaded, and decrypted in memory after
  it is downloaded. The Worker and R2 only ever hold ciphertext.
- **The key never leaves your machine.** It lives in your gitignored secrets file
  (or an environment variable), never in the committed config, never in this app
  repo, never in the vault.
- **Only the sensitive text is vaulted.** The confidential slice of a brain is
  about 14 MB of markdown and other text. Binaries and oversized media are not
  confidential, so they stay on the laptop (and are reported by `status` so you
  can see exactly what is and is not covered). Move any sensitive binary yourself
  if you want it out of reach.
- **Revoke by rotating the token.** Rotate the Worker's bearer token and any old
  copy can no longer fetch or store the blob. For a full reset, rotate the
  encryption key as well and re-push; old copies then cannot be decrypted.

## Sensitivity tiering (the default, and how to change it)

The default tiers come from the folder-sensitivity map. Only the `sensitive`
tier is vaulted.

- **Sensitive (vaulted):** `context`, `customers`, `clients`, `data`, `auth`,
  `z-logs`.
- **Internal (stays local):** `projects`, `.claude`, `tools`.
- **Public (stays local):** `research`, `content`, `images`, `testing`,
  `z-archive`. Note that `z-archive` can hold old client data, so review it.

To change what is vaulted, edit the `tiers.sensitive` array in
`.brain-security.json`. A friendly checkbox editor and Command Centre presets are
the planned next step; the config file is what actually drives behaviour.

## Wiring a session to pull and scrub automatically

- **Claude Code (scouts):** wire the two hooks in `hooks/` into your brain's
  `.claude/settings.json` (a `SessionStart` hook that runs `pull`, and a
  `SessionEnd` hook that pushes then scrubs). This gives you the clean cycle:
  files restored at the start, saved and removed at the end.
- **Cowork (team and owners):** Cowork has no hooks, so add an instruction to
  your brain's `CLAUDE.md` telling the session to run `pull` at the start. This
  is best-effort, and the failure mode is safe: if the session does not pull, it
  is missing context, not leaking data, because the plain text genuinely is not
  on disk.

## The one thing to be straight about (Cowork)

In Cowork there are no hooks, so while a session is actively working, the files it
pulled are plain text on disk, and we cannot reliably wipe them afterwards. So in
Cowork the vault's promise is: the encrypted source of truth lives in your own
cloud, it is revocable, it is out of your git repo, and full-disk encryption
covers the transient working copy. It is not "plain text never touches the disk."
The clean scrub-after-every-session only works in Claude Code, which has hooks.
Tell your clients the real thing.

## Known limits in this version

- **One shared vault key.** Everyone on the team uses the same encryption key in
  this version. Cutting off a departed teammate is done by rotating the Worker
  token (which stops them fetching the blob) and, for a full reset, rotating the
  key and re-pushing. Per-person keys are a planned improvement.
- **Sensitive binaries stay local.** Only text is vaulted. If you keep sensitive
  non-text files, move them yourself or rely on full-disk encryption for them.
