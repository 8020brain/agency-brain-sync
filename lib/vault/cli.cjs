#!/usr/bin/env node
'use strict';
/*
 * vault CLI — the command surface an owner (or a Claude session on their behalf)
 * uses to run the vault. Also the thing the session-start hook / Cowork
 * instruction call.
 *
 *   node cli.cjs setup  --worker-url <url> --token <token> [--secrets-file <p>]
 *   node cli.cjs push   [--scrub]
 *   node cli.cjs pull
 *   node cli.cjs scrub
 *   node cli.cjs status [--offline]
 *
 * Common flags:  --root <brainDir> (or $BRAIN_ROOT, else cwd),  --json
 *
 * SECRETS: this never prints a token or key value. `status` shows presence only
 * (set / missing). `setup` reports where the key was saved, never the key.
 */

const fs = require('fs');
const path = require('path');
const vault = require('./vault.cjs');
const cfg = require('./config.cjs');
const crypto = require('./crypto.cjs');
const secretsMod = require('./secrets.cjs');
const { httpTransport } = require('./transport.cjs');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function resolveRoot(args) {
  return path.resolve(args.root || process.env.BRAIN_ROOT || process.cwd());
}

function out(args, human, obj) {
  if (args.json) console.log(JSON.stringify(obj));
  else console.log(human);
}

function ensureGitignored(root, entry) {
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch (_) {}
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.includes(entry)) return false;
  const add = (text && !text.endsWith('\n') ? '\n' : '') + `${entry}\n`;
  fs.appendFileSync(gi, (text ? '' : '') + add);
  return true;
}

async function cmdSetup(root, args) {
  const workerUrl = args['worker-url'] || process.env.VAULT_WORKER_URL;
  const token = args.token || process.env.VAULT_TOKEN;
  if (!workerUrl || !token) {
    const guide = [
      'vault setup — stand up your own encrypted vault (one-time).',
      '',
      'Your vault lives on YOUR OWN Cloudflare account. We never host it or hold your keys.',
      '',
      '1. Deploy the Worker + R2 bucket from lib/vault/worker/ (see its README).',
      '   That gives you a Worker URL and you choose a bearer token (the "gate token").',
      '2. Re-run:  node cli.cjs setup --worker-url <your-worker-url> --token <your-gate-token>',
      '   That generates an encryption key, saves all three to your gitignored secrets file,',
      '   writes .brain-security.json (posture: vault), and runs a round-trip self-check.',
      '',
      'To revoke a teammate later: rotate the gate token on the Worker.',
    ].join('\n');
    out(args, guide, { ok: false, needs: ['worker-url', 'token'] });
    return;
  }

  const key = crypto.generateKey();
  const secretsFile = secretsMod.writeSecretsFile(root, { workerUrl, token, key }, args['secrets-file']);

  // Write / update the security config to posture: vault.
  const { config } = cfg.loadSecurityConfig(root);
  config.posture = 'vault';
  const configPath = cfg.writeSecurityConfig(root, config);

  // Keep the secrets out of git.
  ensureGitignored(root, '.vault/');

  // Round-trip self-check against the real Worker (probe object, then delete it).
  let selfCheck = 'skipped';
  try {
    const transport = httpTransport({ workerUrl, token });
    const probeName = `.vault-selfcheck-${Date.now()}`;
    const sample = crypto.encrypt(Buffer.from('vault self-check'), key);
    await transport.put(probeName, sample);
    const back = await transport.get(probeName);
    const rt = back && crypto.decrypt(back, key).toString() === 'vault self-check';
    await transport.del(probeName);
    selfCheck = rt ? 'passed' : 'FAILED (round-trip mismatch)';
  } catch (e) {
    selfCheck = `FAILED (${e.message})`;
  }

  const human = [
    'Vault configured.',
    `  secrets saved to: ${secretsFile}  (gitignored — key value NOT shown)`,
    `  config written:   ${configPath}  (posture: vault)`,
    `  worker round-trip self-check: ${selfCheck}`,
    '',
    'Next: `node cli.cjs push` to upload your sensitive context, then `node cli.cjs scrub`',
    'to remove the local plaintext. At session start, `node cli.cjs pull` restores it.',
  ].join('\n');
  out(args, human, { ok: true, secretsFile, configPath, selfCheck });
}

async function cmdPush(root, args) {
  const r = await vault.push(root, { scrub: !!args.scrub });
  const human = [
    `Pushed ${r.files} sensitive files (${(r.sourceBytes / 1024 / 1024).toFixed(2)} MB) to the vault`,
    `  encrypted blob: ${(r.blobBytes / 1024 / 1024).toFixed(2)} MB`,
    r.skipped.length ? `  left local (media/oversized): ${r.skipped.length} files` : '  nothing skipped',
    args.scrub ? `  scrubbed local plaintext: ${r.scrubbed} files` : '',
  ].filter(Boolean).join('\n');
  out(args, human, { ok: true, ...r, skipped: r.skipped.length });
}

async function cmdPull(root, args) {
  const r = await vault.pull(root, {});
  const human = r.empty
    ? 'Vault is empty — nothing to pull.'
    : `Pulled ${r.files} files from the vault (bundle created ${r.createdAt}).`;
  out(args, human, { ok: true, ...r });
}

async function cmdScrub(root, args) {
  const r = await vault.scrub(root, {});
  const human = r.refused
    ? `Scrub refused: ${r.reason}`
    : `Scrubbed ${r.removed} local plaintext files (still safe in the vault).`;
  out(args, human, { ok: !r.refused, ...r });
}

async function cmdStatus(root, args) {
  const s = await vault.status(root, { offline: !!args.offline });
  const lines = [
    `posture:            ${s.posture}`,
    `.brain-security:    ${s.configExists ? 'present' : 'default (not written)'}`,
    `sensitive folders:  ${s.sensitiveFolders.join(', ')}`,
    `local sensitive:    ${s.localSensitiveFiles} files, ${(s.localSensitiveBytes / 1024 / 1024).toFixed(2)} MB`,
    `left local (media): ${s.skippedLocal} files`,
    `secrets:            workerUrl=${s.secrets.workerUrl}  token=${s.secrets.token}  key=${s.secrets.key}`,
    `secrets source:     ${s.secrets.source}`,
  ];
  if (s.vault === null) lines.push('vault:              not probed (offline or secrets missing)');
  else if (s.vault.error) lines.push(`vault:              error — ${s.vault.error}`);
  else if (!s.vault.exists) lines.push('vault:              empty (nothing pushed yet)');
  else lines.push(`vault:              ${s.vault.files} files, ${(s.vault.blobBytes / 1024 / 1024).toFixed(2)} MB, created ${s.vault.createdAt}`);
  out(args, lines.join('\n'), s);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];
  const root = resolveRoot(args);

  const commands = {
    setup: cmdSetup, push: cmdPush, pull: cmdPull, scrub: cmdScrub, status: cmdStatus,
  };
  if (!command || !commands[command]) {
    console.log('usage: vault <setup|push|pull|scrub|status> [--root <dir>] [--json]');
    process.exit(command ? 1 : 0);
  }
  try {
    await commands[command](root, args);
  } catch (e) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: e.message }));
    else console.error(String(e.message || e));
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { parseArgs };
