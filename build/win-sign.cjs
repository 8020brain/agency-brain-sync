'use strict';
// Windows code-signing hook for electron-builder (wired as `win.sign` in
// electron-builder.yml). electron-builder calls this once for each Windows
// executable it produces (the app .exe, the NSIS Setup, the uninstaller).
// Signing happens HERE, before electron-builder computes the latest.yml /
// .blockmap hashes, so the auto-update integrity check matches the signed bytes.
//
// Cloud signing via SSL.com eSigner CodeSignTool — no local certificate or USB
// token. CodeSignTool and the four credentials are provided by CI
// (.github/workflows/build.yml, Windows leg ONLY):
//   CODE_SIGN_TOOL_DIR          folder containing CodeSignTool.bat (set in CI)
//   WINDOWS_SIGN_USER           eSigner username
//   WINDOWS_SIGN_PASSWORD       SSL.com account password
//   WINDOWS_SIGN_TOTP_SECRET    eSigner TOTP secret (base32)
//   WINDOWS_SIGN_CREDENTIAL_ID  eSigner credential id (optional — CodeSignTool
//                               auto-detects when the account has one credential)
//
// We sign into a temp dir and copy the result back over the original file.
// Signing to a separate dir (instead of omitting -output_dir_path) avoids
// CodeSignTool's interactive "overwrite the input file?" confirmation, which
// would hang the headless CI build.

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function sign(configuration) {
  const filePath = String(configuration.path);
  const fileName = path.basename(filePath);

  const user = process.env.WINDOWS_SIGN_USER;
  const password = process.env.WINDOWS_SIGN_PASSWORD;
  const totp = process.env.WINDOWS_SIGN_TOTP_SECRET;
  const credentialId = process.env.WINDOWS_SIGN_CREDENTIAL_ID;
  const toolDir = process.env.CODE_SIGN_TOOL_DIR;

  // Fail LOUD rather than silently produce an unsigned build. The whole reason
  // this hook exists is so a signed release can never quietly regress to
  // unsigned (a local `build:win` without these env vars will hit this too).
  const missing = [];
  if (!user) missing.push('WINDOWS_SIGN_USER');
  if (!password) missing.push('WINDOWS_SIGN_PASSWORD');
  if (!totp) missing.push('WINDOWS_SIGN_TOTP_SECRET');
  if (!toolDir) missing.push('CODE_SIGN_TOOL_DIR');
  if (missing.length) {
    throw new Error(
      `[win-sign] cannot sign ${fileName} — missing: ${missing.join(', ')}. ` +
      'Windows signing must run in CI with the eSigner secrets set.'
    );
  }

  const bat = path.join(toolDir, 'CodeSignTool.bat');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-sign-'));

  // Credentials come from trusted CI secrets and are double-quoted for cmd.exe.
  // They must not contain a literal double-quote (eSigner credentials don't);
  // if one ever does, regenerate it rather than escaping here.
  const q = (v) => `"${String(v)}"`;
  const args = [
    `"${bat}" sign`,
    `-username=${q(user)}`,
    `-password=${q(password)}`,
    `-totp_secret=${q(totp)}`,
    credentialId ? `-credential_id=${q(credentialId)}` : '',
    `-input_file_path=${q(filePath)}`,
    `-output_dir_path=${q(outDir)}`,
  ].filter(Boolean);

  console.log(`[win-sign] signing ${fileName} via CodeSignTool…`);
  // execSync runs through cmd.exe on Windows (which executes the .bat). The
  // command string holds the password, so it is NOT logged here; CodeSignTool's
  // own (credential-free) output is inherited, and GitHub masks the secrets.
  execSync(args.join(' '), { cwd: toolDir, stdio: 'inherit' });

  const signed = path.join(outDir, fileName);
  if (!fs.existsSync(signed)) {
    throw new Error(`[win-sign] CodeSignTool produced no signed file for ${fileName}`);
  }
  fs.copyFileSync(signed, filePath);
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(`[win-sign] ✓ signed ${fileName}`);
}

module.exports = sign;
module.exports.default = sign;
