# The vault Worker — deploy to your own Cloudflare (one-time)

This is the small piece that turns an R2 bucket into an authenticated store your
brain can push to and pull from. **It runs on your own Cloudflare account.** We
never host it and never hold your token or your key. The Worker only ever sees
encrypted blobs; all encryption and decryption happens on your machine.

You'll need a (free) Cloudflare account and Node. R2 has a generous free tier;
14 MB of encrypted context sits far inside it.

## Steps

1. **Install Wrangler** (Cloudflare's CLI) if you don't have it:
   ```
   npm install -g wrangler
   wrangler login
   ```

2. **Create your R2 bucket:**
   ```
   wrangler r2 bucket create agency-brain-vault
   ```

3. **Copy the config** and deploy:
   ```
   cp wrangler.toml.example wrangler.toml
   wrangler deploy
   ```
   Wrangler prints your Worker URL, e.g. `https://agency-brain-vault.<you>.workers.dev`.

4. **Set your gate token** (a long random string you choose — this is what the
   brain sends, and what you rotate to revoke access):
   ```
   wrangler secret put VAULT_TOKEN
   ```
   Paste a strong random value when prompted. Generate one with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

5. **Point your brain at it:**
   ```
   node ../cli.cjs setup --worker-url https://agency-brain-vault.<you>.workers.dev --token <your-gate-token>
   ```
   That generates your encryption key, saves all three values to a gitignored
   secrets file, flips `.brain-security.json` to `posture: vault`, and runs a
   round-trip self-check.

## Revoking access

To cut off a departed teammate (or after a lost laptop), rotate the gate token:
```
wrangler secret put VAULT_TOKEN     # set a new value
```
Anyone with the old token can no longer fetch or store the blob. For a full
reset, also rotate the encryption key (`node ../cli.cjs setup ...` generates a
new one) and re-`push`; old copies then can't be decrypted.

## What this does NOT do

It doesn't encrypt anything (your machine does that), and it can't read your
context (it only holds ciphertext). It's an authenticated doorway to your own
storage — nothing more.
