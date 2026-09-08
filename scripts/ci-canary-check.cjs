#!/usr/bin/env node
// ci-canary-check.cjs — has the "Build and release" workflow gone GREEN on this
// exact commit? Exit 0 yes, 1 no. Used by .githooks/pre-push before a release
// tag goes up, and runnable by hand:
//
//   node scripts/ci-canary-check.cjs [sha]      (default: HEAD)
//
// Why: `npm run staging` builds on Mike's Mac, so it cannot see a change on
// GitHub's runners. On 2026-09-08 the macos-26 image updated overnight and
// electron-builder's signing keychain stopped unlocking; the v1.1.32 tag built
// Windows fine, failed the Mac leg twice, created no release, and the same code
// had to go out again as v1.1.33. The workflow now also runs on every push to
// main (no release step), so the commit that is about to be tagged has already
// been built and signed on the real runners. A green run for the commit on ANY
// ref counts (a previous tag's run proves the same thing).
const { execFileSync } = require('child_process');
// Full sha always: `gh run list --commit` matches nothing on a short one.
const sha = execFileSync('git', ['rev-parse', `${process.argv[2] || 'HEAD'}^{commit}`], { encoding: 'utf8' }).trim();
let runs;
try {
  runs = JSON.parse(execFileSync('gh', [
    'run', 'list', '--workflow=build.yml', '--commit', sha, '--limit', '10',
    '--json', 'status,conclusion,headBranch,databaseId,url',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch (e) {
  console.error(`✗ Could not ask GitHub about builds for ${sha.slice(0, 7)}: ${(e.stderr || e.message || '').toString().trim().split('\n')[0]}`);
  console.error('  gh must be installed and signed in (gh auth status).');
  process.exit(1);
}
const green = runs.find((r) => r.status === 'completed' && r.conclusion === 'success');
if (green) {
  console.log(`✓ CI built and signed ${sha.slice(0, 7)} successfully (${green.headBranch}, ${green.url}).`);
  process.exit(0);
}
const running = runs.find((r) => r.status !== 'completed');
if (running) {
  console.error(`✗ CI is still building ${sha.slice(0, 7)} (${running.status}): ${running.url}`);
  console.error('  Wait for it to go green (gh run watch), then tag.');
} else if (runs.length) {
  console.error(`✗ Every CI build of ${sha.slice(0, 7)} failed: ${runs[0].url}`);
  console.error('  Fix the build (or the runner) first. Tagging now would ship nothing.');
} else {
  console.error(`✗ CI has not built ${sha.slice(0, 7)} yet. Push main and wait for "Build and release" to go green (about 8 minutes), then tag.`);
}
process.exit(1);
