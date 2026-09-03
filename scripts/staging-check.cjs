#!/usr/bin/env node
// staging-check.cjs — the one command that stands between a commit and a release.
//
// Every tag push builds the installer and ships it to every agency through
// auto-update, so "test" and "ship to everyone" used to be the same action.
// This makes them two: run this on the release candidate, install the
// Staging-AB build it produces, click through what changed, and only then tag.
//
// What it does, in order:
//   1. Runs the full test suite (npm test), which includes the Command Centre
//      smoke test.
//   2. Builds the staging app (npm run build:staging:mac).
//   3. Verifies the built app's identity from the packaged files, because the
//      first staging build in Sept 2026 silently shared production's data
//      folder: bundle id, product name and channel must all be the staging ones.
//   4. Copies the dmg to the Desktop.
//   5. Writes dist/staging-check.json (version, commit, results). The
//      .githooks/pre-push hook refuses to push a v* tag unless that file
//      matches the tag's version and commit and says the tests passed.
//   6. Prints the click-through checklist.
//
// Order of a release: bump version → commit → `npm run staging` → install +
// click through → `git tag vX.Y.Z` → push. The staging build IS the release
// candidate at the exact commit that gets tagged.
//
// Run: npm run staging     (also installs the git hooks path on first run)

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const RESULT = path.join(DIST, 'staging-check.json');
const EXPECT = {
  bundleId: 'com.8020brain.agencybrain.staging',
  productName: 'Staging-AB',
  channel: 'staging',
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = sh('git rev-parse HEAD');
const dirty = sh('git status --porcelain --untracked-files=no') !== '';

function writeResult(extra) {
  fs.mkdirSync(DIST, { recursive: true });
  const out = { version, commit, dirty, checkedAt: new Date().toISOString(), ...extra };
  fs.writeFileSync(RESULT, JSON.stringify(out, null, 2) + '\n');
  return out;
}

function fail(reason) {
  writeResult({ ok: false, reason });
  console.error(`\n✗ Staging check FAILED: ${reason}`);
  console.error(`  Recorded in ${path.relative(ROOT, RESULT)}. No tag will push until this is green.`);
  process.exit(1);
}

function step(label, cmd, args) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) fail(`${label} failed (exit ${r.status})`);
}

// Make the pre-push hook live for this clone. Idempotent and silent.
try { sh('git config core.hooksPath .githooks'); } catch (e) { /* not fatal */ }

console.log(`Staging check for Agency Brain v${version} at ${commit.slice(0, 7)}${dirty ? ' (WORKING TREE HAS UNCOMMITTED CHANGES)' : ''}`);
if (dirty) {
  console.log('  The build will run, but the hook will not accept a check made on a dirty tree.');
  console.log('  Commit the release candidate first so the tag points at what you tested.');
}

step('Test suite', 'npm', ['test']);
step('Build Staging-AB', 'npm', ['run', 'build:staging:mac']);

// 3. Verify the built app is really the staging app.
console.log('\n▶ Verify the built app identity');
const appDir = fs.readdirSync(DIST)
  .map((d) => path.join(DIST, d))
  .filter((d) => fs.statSync(d).isDirectory())
  .map((d) => path.join(d, `${EXPECT.productName}.app`))
  .find((p) => fs.existsSync(p));
if (!appDir) fail(`no ${EXPECT.productName}.app found under dist/`);

let asar;
try { asar = require('@electron/asar'); } catch (e) { fail('@electron/asar is not installed (it ships with electron-builder; run npm install)'); }
let inner;
try {
  inner = JSON.parse(asar.extractFile(path.join(appDir, 'Contents', 'Resources', 'app.asar'), 'package.json').toString('utf8'));
} catch (e) { fail(`could not read package.json out of the packaged app: ${e.message}`); }
const bundleId = sh(`plutil -extract CFBundleIdentifier raw "${path.join(appDir, 'Contents', 'Info.plist')}"`);

const problems = [];
if (bundleId !== EXPECT.bundleId) problems.push(`bundle id is ${bundleId}, expected ${EXPECT.bundleId}`);
if (inner.productName !== EXPECT.productName) problems.push(`packaged productName is ${inner.productName}, expected ${EXPECT.productName} (this is what decides the data folder)`);
if (inner.channel !== EXPECT.channel) problems.push(`packaged channel is ${inner.channel}, expected ${EXPECT.channel} (auto-update would stay ON)`);
if (inner.version !== version) problems.push(`packaged version is ${inner.version}, expected ${version}`);
if (problems.length) fail(`built app is not a safe staging app: ${problems.join('; ')}`);
console.log(`  ok: ${bundleId}, productName ${inner.productName}, channel ${inner.channel}, v${inner.version}`);

// 4. dmg to the Desktop.
const dmg = path.join(DIST, `${EXPECT.productName}-${version}-arm64.dmg`);
if (!fs.existsSync(dmg)) fail(`expected ${path.basename(dmg)} in dist/ and it is not there`);
const desktopDmg = path.join(os.homedir(), 'Desktop', path.basename(dmg));
fs.copyFileSync(dmg, desktopDmg);

// 5. Record.
const result = writeResult({
  ok: true,
  testsPassed: true,
  app: path.relative(ROOT, appDir),
  dmg: desktopDmg,
  bundleId,
  productName: inner.productName,
  channel: inner.channel,
});

// 6. The human half.
console.log(`
✓ Staging check GREEN for v${version} at ${commit.slice(0, 7)}. Recorded in dist/staging-check.json.

${path.basename(desktopDmg)} is on your Desktop. Before tagging v${version}:
  1. Open the dmg and drag Staging-AB into Applications, replacing the old one.
  2. Launch it (the purple menu-bar brain). Sign in with your real email and pick
     the team "Mike Test Brain" (~/staging-test-brain). Never point it at a real brain.
  3. Click through what this release changed, then the Command Centre's eight views.
  4. Then tag and push: git tag v${version} && git push origin main --tags
     The pre-push hook checks the tag against this file${result.dirty ? ' (it will REFUSE: the tree was dirty)' : ''}.
`);
