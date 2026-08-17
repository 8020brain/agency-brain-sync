#!/usr/bin/env node
/**
 * Section-sync tests — run the real section-sync module against throwaway
 * local git repos (bare origins + working clones). No mocks, no network, no
 * Electron: getAuth is a stub returning local repo paths, which the module
 * treats exactly like remote URLs (token embedding only applies to https).
 *
 *   node tests/section-sync.test.cjs
 *
 * Covers:
 *   A) grant     — mount appears, is excluded from the shared repo BEFORE it
 *                  can leak (git status of the main repo never sees it).
 *   B) round-trip— a file written into the mount pushes to the annex origin;
 *                  a teammate's push arrives into the mount.
 *   C) conflict  — overlapping edits keep OUR file and write a
 *                  __from-remote sidecar. Nothing lost.
 *   D) safety    — an invalid slug mounts nothing; a name-collision folder is
 *                  never clobbered; a failed getAuth (offline) touches nothing.
 *   E) revoke    — a successful answer without the section removes the mount.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { create } = require(path.join(__dirname, '..', 'watcher', 'section-sync.js'));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok   ${name}`); }
function bad(name, detail) { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
function check(cond, name, detail) { cond ? ok(name) : bad(name, detail); }

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function git(repo, args) { return sh(`git -C "${repo}" ${args}`); }
function gitTry(repo, args) { try { return git(repo, args); } catch { return null; } }

function seedBare(root, name, seedFile) {
  const bare = path.join(root, `${name}.git`);
  sh(`git init --bare --initial-branch=main "${bare}"`);
  const work = path.join(root, `${name}-seed`);
  sh(`git clone "${bare}" "${work}"`);
  git(work, 'config user.email seed@test.local');
  git(work, 'config user.name Seed');
  fs.writeFileSync(path.join(work, seedFile), 'seed\n');
  git(work, 'add -A');
  git(work, 'commit -m seed');
  git(work, 'push -u origin main');
  return bare;
}

function originHasPath(originBare, relPath) {
  return (gitTry(originBare, 'ls-tree -r --name-only main') || '').split('\n').includes(relPath);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-section-'));
  console.log(`fixtures in ${root}`);

  // The "shared" brain repo (main), plus the leadership annex origin.
  const mainOrigin = seedBare(root, 'main-origin', 'README.md');
  const annexOrigin = seedBare(root, 'annex-origin', 'salaries.md');

  const app = path.join(root, 'app');
  sh(`git clone "${mainOrigin}" "${app}"`);
  git(app, 'config user.email leader@test.local');
  git(app, 'config user.name Leader');

  // A teammate's clone of the annex, for remote-side pushes.
  const mate = path.join(root, 'mate');
  sh(`git clone "${annexOrigin}" "${mate}"`);
  git(mate, 'config user.email mate@test.local');
  git(mate, 'config user.name Mate');

  let auth = { token: null, sections: [{ slug: 'leadership', repoUrl: annexOrigin }] };
  let authFails = false;
  const sync = create({
    repoPath: app,
    getAuth: async () => {
      if (authFails) throw new Error('offline');
      return auth;
    },
    log: (m) => console.log(`    [section-sync] ${m}`),
  });

  // ── A) grant ──
  await sync.tick();
  const mount = path.join(app, 'leadership');
  check(fs.existsSync(path.join(mount, 'salaries.md')), 'A1: granted section mounts and clones');
  const exclude = fs.readFileSync(path.join(app, '.git', 'info', 'exclude'), 'utf8');
  check(exclude.split('\n').includes('/leadership/'), 'A2: mount excluded from the shared repo');
  const mainStatus = git(app, 'status --porcelain');
  check(!/leadership/.test(mainStatus), 'A3: main repo status never sees the mount', mainStatus);
  check(sync.ownsPath(path.join(mount, 'salaries.md')), 'A4: ownsPath covers mounted files');

  // ── B) round-trip ──
  fs.writeFileSync(path.join(mount, 'margins.md'), 'leadership only\n');
  await sync.tick();
  check(originHasPath(annexOrigin, 'margins.md'), 'B1: local edit in the mount pushes to the annex origin');

  git(mate, 'pull');
  fs.writeFileSync(path.join(mate, 'strategy.md'), 'from the other leader\n');
  git(mate, 'add -A');
  git(mate, 'commit -m strategy');
  git(mate, 'push');
  await sync.tick();
  check(fs.existsSync(path.join(mount, 'strategy.md')), 'B2: a teammate\'s push arrives into the mount');

  // ── C) conflict keeps both sides ──
  git(mate, 'pull');
  fs.writeFileSync(path.join(mate, 'salaries.md'), 'their version\n');
  git(mate, 'add -A'); git(mate, 'commit -m theirs'); git(mate, 'push');
  fs.writeFileSync(path.join(mount, 'salaries.md'), 'our version\n');
  await sync.tick();
  const live = fs.readFileSync(path.join(mount, 'salaries.md'), 'utf8');
  check(live === 'our version\n', 'C1: our version stays live after a conflicting merge', JSON.stringify(live));
  const sidecars = fs.readdirSync(mount).filter((f) => f.includes('__from-remote-'));
  check(sidecars.length === 1, 'C2: their version lands in a sidecar', sidecars.join(','));
  if (sidecars.length === 1) {
    const sc = fs.readFileSync(path.join(mount, sidecars[0]), 'utf8');
    check(sc === 'their version\n', 'C3: sidecar holds the remote side', JSON.stringify(sc));
  }

  // ── C-bin) a BINARY conflict is preserved byte-for-byte (finding F8) ──
  // The old sidecar path decoded the remote blob as utf8 and trimmed it, which
  // turned any non-text file into U+FFFD garbage and ate leading/trailing
  // whitespace. These bytes carry a null (forces git to treat it as binary),
  // high bytes (would become U+FFFD), and a leading/trailing whitespace byte
  // (would be trimmed). The sidecar must equal them exactly.
  git(mate, 'pull');
  const bin = Buffer.from([0x0a, 0x00, 0x89, 0xff, 0x50, 0x4e, 0x47, 0x1a, 0xfe, 0x20]);
  fs.writeFileSync(path.join(mate, 'logo.png'), bin);
  git(mate, 'add -A'); git(mate, 'commit -m theirspng'); git(mate, 'push');
  fs.writeFileSync(path.join(mount, 'logo.png'), Buffer.from([0x00, 0x01, 0x02]));
  await sync.tick();
  const binSidecars = fs.readdirSync(mount).filter((f) => f.includes('__from-remote-') && f.includes('logo'));
  check(binSidecars.length === 1, 'C4: binary conflict lands in a sidecar', binSidecars.join(','));
  if (binSidecars.length === 1) {
    const scBin = fs.readFileSync(path.join(mount, binSidecars[0])); // Buffer — no encoding
    check(Buffer.compare(scBin, bin) === 0, 'C5: binary sidecar is byte-for-byte the remote side', scBin.toString('hex'));
  }

  // ── D) safety ──
  auth = { token: null, sections: [{ slug: '../evil', repoUrl: annexOrigin }, { slug: 'leadership', repoUrl: annexOrigin }] };
  await sync.tick();
  check(!fs.existsSync(path.join(root, 'evil')) && !fs.existsSync(path.join(app, '..', 'evil')),
    'D1: an invalid slug mounts nothing');

  const collide = path.join(app, 'finance');
  fs.mkdirSync(collide);
  fs.writeFileSync(path.join(collide, 'mine.md'), 'user file\n');
  auth = { token: null, sections: [{ slug: 'finance', repoUrl: annexOrigin }, { slug: 'leadership', repoUrl: annexOrigin }] };
  await sync.tick();
  check(fs.readFileSync(path.join(collide, 'mine.md'), 'utf8') === 'user file\n'
    && !fs.existsSync(path.join(collide, '.git')),
    'D2: a name-collision folder is never clobbered');
  auth = { token: null, sections: [{ slug: 'leadership', repoUrl: annexOrigin }] };
  await sync.tick();
  check(fs.existsSync(path.join(collide, 'mine.md')), 'D3: revoking a never-mounted collision leaves the user folder alone');

  authFails = true;
  await sync.tick();
  check(fs.existsSync(path.join(mount, '.git')), 'D4: offline (getAuth throws) touches nothing');
  authFails = false;

  // ── E) revoke ──
  auth = { token: null, sections: [] };
  await sync.tick();
  check(!fs.existsSync(mount), 'E1: a successful answer without the section removes the mount');
  const mainStatusAfter = git(app, 'status --porcelain');
  check(!/leadership/.test(mainStatusAfter), 'E2: main repo stays clean after removal', mainStatusAfter);

  // restart persistence: a fresh instance still knows nothing is mounted
  const sync2 = create({ repoPath: app, getAuth: async () => auth, log: () => {} });
  check(!sync2.ownsPath(path.join(mount, 'x')), 'E3: manifest reflects the removal across restarts');

  // ── F) revoke never deletes unpushed work (Q2) ──
  // A mount with a local commit that never reached the annex, and no
  // origin/<branch> ref at all (its first push never landed, or the ref was
  // lost). The old code read the failed "am I ahead?" probe as "0 ahead" and
  // erased the folder; the work existed on no other machine.
  auth = { token: null, sections: [{ slug: 'leadership', repoUrl: annexOrigin }] };
  await sync.tick();
  check(fs.existsSync(path.join(mount, '.git')), 'F0: re-granted section mounts again');
  git(mount, 'config user.email leader@test.local');
  git(mount, 'config user.name Leader');
  fs.writeFileSync(path.join(mount, 'only-here.md'), 'exists nowhere else\n');
  git(mount, 'add -A'); git(mount, 'commit -q -m unpushed');
  gitTry(mount, 'update-ref -d refs/remotes/origin/main');
  gitTry(mount, 'update-ref -d refs/remotes/origin/HEAD');
  auth = { token: null, sections: [] };
  await sync.tick();
  const aside = fs.readdirSync(app).filter((f) => /^leadership\.removed-/.test(f));
  check(!fs.existsSync(mount) && aside.length === 1, 'F1: an unpushed mount is renamed aside, not deleted', aside.join(','));
  if (aside.length === 1) {
    const asideDir = path.join(app, aside[0]);
    check(fs.readFileSync(path.join(asideDir, 'only-here.md'), 'utf8') === 'exists nowhere else\n', 'F2: the unpushed commit survives in the aside copy');
    check(!/removed-/.test(git(app, 'status --porcelain')), 'F3: the aside copy is excluded from the shared repo', git(app, 'status --porcelain'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
