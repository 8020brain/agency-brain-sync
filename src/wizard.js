// Agency Brain — merged onboarding wizard controller.
//
// Combines:
//   - Brain 3.0's screen logic (machine check, business Q&A, celebration)
//   - the real backend wiring from setup.html (OTP auth, team lookup, clone)
//   - a NEW solo branch: a member with no agency team clones the members brain
//     template via clone-solo-brain (GET /api/brain/auth-token).
//
// The ONLY change from Brain 3.0's renderer is the backend bridge: every
// Tauri invoke(...) is now a window.agencyBrain.* IPC call.

(function () {
  'use strict';
  const api = window.agencyBrain;

  // ---- state ----
  let mode = 'solo';            // 'solo' | 'agency'
  let authToken = '';
  let authEmail = '';
  let authName = '';
  let member = null;            // { memberType, productType, ... } from verify-code
  let teamInfo = null;          // agency: { memberToken, teamSlug, teamName, member }
  let homePath = '';
  let brainHome = '';
  let isSandbox = false;
  let chosenFolder = '';
  let demoMode = false;
  let adopted = false;          // adopt flow saved config itself; enterDone must not re-save
  let flipped = false;          // flip-to-agency saved+restarted itself; enterDone must not re-save
  let priorBrainPath = '';      // a personal brain this app already watched before this run (Path B notice)

  const DEMO_EMAIL = 'demo';
  const TOTAL = 7;

  // ---- rail ----
  const rail = document.getElementById('rail');
  for (let d = 0; d < TOTAL; d++) {
    const s = document.createElement('span');
    s.className = 'dot';
    rail.appendChild(s);
  }
  const dots = rail.querySelectorAll('.dot');

  function show(sceneId) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    const scene = document.getElementById(sceneId);
    scene.classList.add('active');
    const step = Number(scene.dataset.step || 1);
    dots.forEach((d, idx) => {
      d.classList.toggle('done', idx < step - 1);
      d.classList.toggle('active', idx === step - 1);
    });
    document.getElementById('stepCount').textContent = step + ' / ' + TOTAL;
    // Back button visibility (only the early auth scenes go backward cleanly).
    const back = document.getElementById('btn-back');
    const backMap = { 'scene-email': 'scene-welcome', 'scene-otp': 'scene-email', 'scene-team': 'scene-otp' };
    if (backMap[sceneId]) {
      back.classList.remove('hidden');
      back.onclick = () => show(backMap[sceneId]);
    } else {
      back.classList.add('hidden');
      back.onclick = null;
    }
  }

  // ---- helpers ----
  function errorIn(id, msg, info) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.classList.toggle('info', !!info);
    el.classList.remove('hidden');
  }
  function clearError(id) {
    const el = document.getElementById(id);
    el.textContent = '';
    el.classList.add('hidden');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function displayPath(p) {
    if (!p || !homePath) return p;
    return p.startsWith(homePath) ? '~' + p.slice(homePath.length) : p;
  }
  function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim()); }
  function isDemoEmail(s) { return (s || '').trim().toLowerCase() === DEMO_EMAIL; }

  // Plain-English error copy. Never expose stack traces or status codes.
  function friendlyError(err, context) {
    const msg = (err && err.message) || '';
    const net = /network|fetch|enotfound|econnrefused|getaddrinfo/i;
    if (context === 'otp') {
      if (/no valid code|expired|request a new/i.test(msg)) return "That code has expired or wasn't found. Send yourself a new one and try again.";
      if (/invalid code|didn'?t match/i.test(msg)) return "That code didn't match. Check the most recent email and try again.";
      if (/too many attempts/i.test(msg)) return "Too many tries. Send yourself a fresh code and start again.";
      if (net.test(msg)) return "I can't reach the server. Check your internet, then try again.";
      return "Something went wrong confirming your code. Try again in a moment.";
    }
    if (context === 'clone') {
      if (/already\s+exists/i.test(msg)) return "There's already a folder there. Pick a different folder, or move the existing one aside.";
      if (/permission|EACCES/i.test(msg)) return "I don't have permission to create the folder there. Pick a different location.";
      if (/not yet installed|github app|finish setup|409/i.test(msg)) return "Your agency isn't fully set up on GitHub yet. Ask your owner to finish the install, then try again.";
      if (/dev guard/i.test(msg)) return msg; // surface the dev guard verbatim to Mike
      if (net.test(msg)) return "I can't reach GitHub. Check your internet, then try again.";
      return "Something went wrong setting up your brain. Try again, or pick a different location.";
    }
    if (context === 'adopt') {
      // The precise block reasons from inspect/adopt are already plain English —
      // pass them straight through so the member sees exactly what to fix.
      if (/moved on|reconcile|diverged|in progress|isn’t in a state|own repo|shared template|connect/i.test(msg)) return msg;
      if (/permission|denied|403|forbidden|not have access|authentication/i.test(msg)) return "I couldn't push to your GitHub repo. Make sure this is a repo you own and your git is signed in to it, then try again. Your files weren't changed.";
      if (net.test(msg)) return "I can't reach GitHub. Check your internet, then try again. Your files weren't changed.";
      return "Something went wrong adopting your brain. Your files are untouched — have a look at the log, or try again.";
    }
    return "Something went wrong. Try again in a moment.";
  }

  // ====================================================================
  // 1 — welcome / invite-code paste (the primary agency path: the invite
  //     email tells people to open the app and paste their 6-char code).
  //     invite-resolve mints the member token and returns the team + identity
  //     in one call, so this replaces the whole email→OTP→team-pick flow for
  //     agency members. Email sign-in stays as the secondary / solo path.
  // ====================================================================
  const codeInput = document.getElementById('codeInput');
  const codeBtn = document.getElementById('btn-code');
  function normaliseCode(s) { return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
  codeInput.addEventListener('input', () => {
    codeBtn.disabled = normaliseCode(codeInput.value).length !== 6;
    clearError('err-code');
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !codeBtn.disabled) codeBtn.click(); });
  codeBtn.addEventListener('click', () => resolveCodeValue(normaliseCode(codeInput.value)));
  document.getElementById('link-email-signin').addEventListener('click', () => {
    show('scene-email');
    emailInput.focus();
  });

  function friendlyCodeError(err) {
    const msg = (err && err.message) || '';
    if (/not found|404/i.test(msg)) return "I couldn't find that code. Check your invite email and type it exactly, or ask whoever invited you to resend it.";
    if (/expired|410/i.test(msg)) return "That code has expired. Ask whoever invited you to send a fresh one.";
    if (/hasn'?t finished|github app|finish.*install|409/i.test(msg)) return "Your agency isn't fully set up on GitHub yet. Give it a few minutes, then try again.";
    if (/network|fetch|enotfound|econnrefused|getaddrinfo/i.test(msg)) return "I can't reach the server. Check your internet, then try again.";
    return "Something went wrong checking that code. Try again in a moment.";
  }

  // Resolves a pasted 6-char code OR a long deep-link token (invite-resolve
  // accepts both). On success we have everything the agency clone needs, so we
  // jump straight to the machine check.
  async function resolveCodeValue(value) {
    const v = String(value || '').trim();
    if (!v) return;
    clearError('err-code');
    codeBtn.disabled = true;
    const orig = codeBtn.textContent;
    codeBtn.textContent = 'Checking…';
    try {
      const res = await api.resolveInviteToken(v);
      const m = res.member || {};
      mode = 'agency';
      authToken = res.memberToken;
      authEmail = String(m.email || res.memberEmail || '').toLowerCase();
      authName = m.name || res.memberName || '';
      teamInfo = {
        memberToken: res.memberToken,
        teamSlug: res.teamSlug,
        teamName: res.teamName || res.teamSlug,
        repoUrl: res.repoUrl || '',
        scoutSeats: res.scoutSeats == null ? null : Number(res.scoutSeats),
        packageTier: res.packageTier || null,
        member: { email: authEmail, name: authName, role: m.role || res.memberRole || 'team' },
      };
      enterMachine();
    } catch (err) {
      errorIn('err-code', friendlyCodeError(err));
      codeBtn.disabled = false;
      codeBtn.textContent = orig;
    }
  }

  // ====================================================================
  // 2 — sign in (email -> OTP -> team picker / solo branch)
  // ====================================================================
  const emailInput = document.getElementById('emailInput');
  const sendCodeBtn = document.getElementById('btn-send-code');
  emailInput.addEventListener('input', () => {
    sendCodeBtn.disabled = !(isValidEmail(emailInput.value) || isDemoEmail(emailInput.value));
    clearError('err-email');
  });
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !sendCodeBtn.disabled) sendCodeBtn.click(); });
  sendCodeBtn.addEventListener('click', requestCode);

  async function requestCode() {
    const raw = emailInput.value.trim();
    demoMode = isDemoEmail(raw);
    document.getElementById('demoBanner').classList.toggle('hidden', !demoMode);
    authEmail = demoMode ? 'demo@agencybrain.test' : raw.toLowerCase();
    clearError('err-email');
    sendCodeBtn.disabled = true;
    const orig = sendCodeBtn.textContent;
    sendCodeBtn.textContent = 'Sending…';
    try {
      if (!demoMode) await api.requestOtpCode(authEmail);
      document.getElementById('otpEmailEcho').textContent = authEmail;
      otpBoxes.forEach((b) => { b.value = ''; });
      document.getElementById('otpGroup').classList.remove('pending');
      verifyBtn.disabled = true;
      show('scene-otp');
      otpBoxes[0].focus();
    } catch (err) {
      errorIn('err-email', friendlyError(err, 'otp'));
    } finally {
      sendCodeBtn.textContent = orig;
      sendCodeBtn.disabled = !(isValidEmail(emailInput.value) || isDemoEmail(emailInput.value));
    }
  }

  // OTP 6-box input (Brain 3.0 design) with paste + backspace handling.
  const otpGroup = document.getElementById('otpGroup');
  const otpBoxes = Array.from(otpGroup.querySelectorAll('.otp-box'));
  const verifyBtn = document.getElementById('btn-verify');
  function otpValue() { return otpBoxes.map((b) => b.value).join(''); }
  function refreshVerify() { verifyBtn.disabled = otpValue().length !== 6; }
  otpBoxes.forEach((box, idx) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
      if (box.value && otpBoxes[idx + 1]) otpBoxes[idx + 1].focus();
      clearError('err-otp');
      refreshVerify();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && otpBoxes[idx - 1]) otpBoxes[idx - 1].focus();
      if (e.key === 'Enter' && !verifyBtn.disabled) verifyBtn.click();
    });
    box.addEventListener('paste', (e) => {
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!digits) return;
      e.preventDefault();
      digits.split('').forEach((d, i) => { if (otpBoxes[i]) otpBoxes[i].value = d; });
      (otpBoxes[Math.min(digits.length, 5)]).focus();
      refreshVerify();
    });
  });
  verifyBtn.addEventListener('click', verifyCode);
  document.getElementById('btn-otp-back').addEventListener('click', () => { clearError('err-otp'); show('scene-email'); emailInput.focus(); });
  document.getElementById('link-resend').addEventListener('click', async () => {
    clearError('err-otp');
    try { if (!demoMode) await api.requestOtpCode(authEmail); errorIn('err-otp', 'A fresh code is on its way.', true); }
    catch (err) { errorIn('err-otp', friendlyError(err, 'otp')); }
  });

  async function verifyCode() {
    clearError('err-otp');
    verifyBtn.disabled = true;
    const orig = verifyBtn.textContent;
    verifyBtn.textContent = 'Confirming…';
    try {
      let teams;
      if (demoMode) {
        await new Promise((r) => setTimeout(r, 400));
        authToken = 'demo-token-not-real';
        authName = 'Anna Smith';
        member = { memberType: 'community' };
        teams = [{ slug: 'acme', name: 'Acme Digital', role: 'team' }];
      } else {
        const res = await api.verifyOtpCode(authEmail, otpValue());
        authToken = res.token;
        member = res.member || {};
        authName = member.name || '';
        if (member.email) authEmail = String(member.email).toLowerCase();
        const lookup = await api.listMyTeams(authToken);
        teams = (lookup && lookup.teams) || [];
      }
      routeAfterAuth(teams);
    } catch (err) {
      const ctx = /my-teams|look up your agency/i.test((err && err.message) || '') ? 'otp' : 'otp';
      errorIn('err-otp', friendlyError(err, ctx));
      verifyBtn.disabled = false;
    } finally {
      verifyBtn.textContent = orig;
    }
  }

  // The branch point: agency (1+ teams) vs solo (0 teams + A2AI member).
  function routeAfterAuth(teams) {
    if (teams.length > 1) { renderTeamPicker(teams); return; }
    if (teams.length === 1) { joinTeam(teams[0]); return; }
    // 0 teams — is this a solo A2AI member?
    const mt = (member && member.memberType) || '';
    if (/community|ota|script/i.test(mt) || demoMode) {
      mode = 'solo';
      // Demo always seeds a fresh demo folder, so it skips the fork. A real solo
      // member is first asked whether to adopt the brain they already have.
      if (demoMode) enterMachine();
      else show('scene-have-brain');
    } else {
      errorIn('err-otp',
        "This email isn't linked to a membership or an agency yet. If you just signed up or your owner just added you, give it a minute and try again, or check the exact address.");
      verifyBtn.disabled = false;
    }
  }

  function renderTeamPicker(teams) {
    const list = document.getElementById('teamList');
    list.innerHTML = '';
    teams.forEach((t) => {
      const btn = document.createElement('button');
      btn.className = 'team-option';
      btn.type = 'button';
      btn.innerHTML = `<span class="t-name">${escapeHtml(t.name || t.slug)}</span><span class="t-role">${escapeHtml(t.role || 'member')}</span>`;
      btn.addEventListener('click', () => { joinTeam(t); });
      list.appendChild(btn);
    });
    clearError('err-team');
    show('scene-team');
  }

  function selectTeam(team) {
    teamInfo = {
      memberToken: authToken,
      teamSlug: team.slug,
      teamName: team.name || team.slug,
      repoUrl: '',
      scoutSeats: team.scoutSeats == null ? null : Number(team.scoutSeats),
      packageTier: team.packageTier || null,
      member: { email: authEmail, name: authName, role: team.role || 'team' },
    };
    enterMachine();
  }

  // Phase 4 solo->team: if this app already runs a PERSONAL-mode brain, a team now
  // existing means the member self-upgraded (created the team + installed the App
  // at agency.ads2ai.com). Flip that brain into agency mode IN PLACE instead of
  // cloning a second copy. The flip validates the repo matches; on a mismatch
  // (a fresh Path-B repo elsewhere) or any failure it falls through to the normal
  // agency clone, which is the safe known-good path.
  async function joinTeam(team) {
    mode = 'agency';
    let cfg = null;
    try { cfg = await api.getConfig(); } catch (e) { cfg = null; }
    if (cfg && cfg.mode === 'personal' && cfg.brainPath && api.flipToAgency) {
      try {
        const res = await api.flipToAgency({ memberToken: authToken, teamSlug: team.slug });
        if (res && res.ok) {
          flipped = true; // the flip already saved config + restarted; enterDone must not re-save
          chosenFolder = cfg.brainPath;
          teamInfo = {
            memberToken: authToken, teamSlug: team.slug, teamName: team.name || team.slug,
            repoUrl: '', scoutSeats: team.scoutSeats == null ? null : Number(team.scoutSeats),
            packageTier: team.packageTier || null,
            member: { email: authEmail, name: authName, role: (res.role || team.role || 'owner') },
          };
          enterSurfaces();
          return;
        }
      } catch (e) { /* fall through to the normal clone */ }
    }
    selectTeam(team);
  }

  // ====================================================================
  // 3 — machine check
  // ====================================================================
  async function enterMachine() {
    show('scene-machine');
    const list = document.getElementById('checklist');
    const nextBtn = document.getElementById('btn-machine-next');
    nextBtn.disabled = true;
    try {
      const report = await api.detectMachine();
      list.innerHTML = '';
      let anyMissing = false;
      report.tools.forEach((t) => {
        if (!t.present) anyMissing = true;
        const row = document.createElement('div');
        row.className = 'check-row ' + (t.present ? 'ok' : 'missing');
        const detail = t.present && t.version ? `<span class="check-detail">${escapeHtml(t.version)}</span>` : '';
        row.innerHTML = `<span class="check-mark">${t.present ? '&#10003;' : '&#43;'}</span>
          <span class="check-label">${escapeHtml(t.label)}</span>${detail}
          <span class="check-status">${t.present ? 'installed' : 'not found'}</span>`;
        list.appendChild(row);
      });
      // Detection is a heads-up, never a gate — false negatives shouldn't trap
      // anyone, so Continue is always live. If something's missing, say so
      // plainly and let them proceed (they can install it and the watcher /
      // Claude pick it up).
      if (anyMissing) {
        const note = document.createElement('div');
        note.className = 'check-note';
        note.innerHTML = "Anything marked <em>not found</em>? Install it when you get a chance — you can carry on now either way. The check can also miss things that are installed.";
        list.appendChild(note);
      }
    } catch (e) {
      list.innerHTML = `<div class="check-row missing"><span class="check-mark">!</span><span class="check-label">Detection failed</span><span class="check-status">${escapeHtml(String(e))}</span></div>`;
    }
    nextBtn.disabled = false;
  }
  document.getElementById('btn-machine-next').addEventListener('click', enterClone);

  // ====================================================================
  // 2b/2c — adopt an existing brain (SOLO only). The fork after solo
  // detection: "I'm new" falls through to the normal clone path
  // (enterMachine -> cloneSoloBrain); "I already have one" inspects the brain
  // the member already has. Phase 1 is READ-ONLY: it only shows the folder's
  // state. The Adopt button's controlled first sync is Phase 2 — until then it
  // confirms inspection and stops short of any write.
  // ====================================================================
  let adoptFolder = '';
  let adoptReport = null;

  document.getElementById('btn-have-new').addEventListener('click', enterMachine);
  document.getElementById('btn-have-existing').addEventListener('click', enterAdopt);
  document.getElementById('btn-adopt-back').addEventListener('click', () => { clearError('err-adopt'); show('scene-have-brain'); });

  function enterAdopt() {
    adoptFolder = '';
    adoptReport = null;
    document.getElementById('adoptFolderPath').textContent = '… nothing picked yet';
    const readout = document.getElementById('adoptReadout');
    readout.classList.add('hidden');
    readout.innerHTML = '';
    clearError('err-adopt');
    const go = document.getElementById('btn-adopt-go');
    go.classList.add('hidden');
    go.disabled = true;
    show('scene-adopt');
  }

  document.getElementById('btn-adopt-pick').addEventListener('click', async () => {
    // requireGit: pick-folder rejects (with its own dialog) anything without a
    // .git, so we only ever inspect a real repo.
    const picked = await api.pickFolder({ requireGit: true });
    if (!picked) return;
    adoptFolder = picked;
    document.getElementById('adoptFolderPath').textContent = displayPath(picked);
    await runInspect();
  });

  async function runInspect() {
    clearError('err-adopt');
    const readout = document.getElementById('adoptReadout');
    const go = document.getElementById('btn-adopt-go');
    go.classList.add('hidden');
    go.disabled = true;
    readout.classList.remove('hidden', 'block');
    readout.innerHTML = '<div class="ar-rows"><div class="ar-row"><span class="ar-k">Checking…</span><span class="ar-v muted">reading your brain folder</span></div></div>';
    let r;
    try {
      r = await api.inspectBrainFolder(adoptFolder);
    } catch (_) {
      readout.classList.add('hidden');
      errorIn('err-adopt', "I couldn't inspect that folder. Pick the folder your brain lives in and try again.");
      return;
    }
    adoptReport = r;
    renderReadout(r);
  }

  // Map each inspect state to a badge label + plain-English headline, and
  // whether it's a green "ready to adopt" or an amber "resolve this first".
  const ADOPT_STATES = {
    clean_in_sync: { badge: 'Ready', headline: 'Clean, and in sync with GitHub.' },
    dirty:         { badge: 'Ready', headline: 'Has changes you haven’t saved to GitHub yet.' },
    ahead:         { badge: 'Ready', headline: 'Has commits that aren’t on GitHub yet.' },
    behind:        { badge: 'Ready', headline: 'GitHub has newer commits than this copy.' },
    diverged:      { badge: 'Resolve first', headline: 'This copy and GitHub have both moved on.' },
    mid_operation: { badge: 'Resolve first', headline: 'A git operation is in progress here.' },
    no_origin:     { badge: 'Connect GitHub', headline: 'Not connected to a GitHub repo yet.' },
    not_github:    { badge: 'Connect GitHub', headline: 'Its origin isn’t a GitHub repo.' },
    template_origin: { badge: 'Use your own repo', headline: 'This points at the shared template, not your repo.' },
    not_git:       { badge: 'Not a brain', headline: 'That folder isn’t a git repository.' },
    fetch_failed:  { badge: 'Can’t reach GitHub', headline: 'Couldn’t compare it with GitHub.' },
    error:         { badge: 'Error', headline: 'Something went wrong inspecting it.' },
    invalid:       { badge: 'Error', headline: 'No folder to inspect.' },
    unknown:       { badge: 'Unclear', headline: 'I couldn’t read its state cleanly.' },
  };

  // What the (Phase-2) adopt step will do for each non-blocked state. Shown as a
  // note so the member knows what "Adopt" means before they press it.
  function adoptIntentNote(r) {
    if (r.state === 'clean_in_sync') return 'Nothing to sync — I’ll just start watching this folder.';
    if (r.state === 'behind') return 'I’ll fast-forward to GitHub’s latest, then start watching.';
    if (r.state === 'dirty') return 'I’ll save your changes as one commit and push them to your GitHub, then start watching.';
    if (r.state === 'ahead') return 'I’ll push your local commits to GitHub, then start watching.';
    return '';
  }

  function shortRepo(url) {
    if (!url) return '—';
    return url.replace(/^git@github\.com:/i, '').replace(/^https?:\/\/[^/]*github\.com\//i, '').replace(/\.git$/i, '');
  }
  function yesNo(b) { return b ? 'yes' : 'no'; }

  function renderReadout(r) {
    const readout = document.getElementById('adoptReadout');
    const meta = ADOPT_STATES[r.state] || ADOPT_STATES.unknown;
    const blocked = !!r.block;
    readout.classList.toggle('block', blocked);

    const rows = [];
    rows.push(rowHtml('Folder', escapeHtml(displayPath(r.folder || adoptFolder))));
    if (r.origin && r.origin.present) rows.push(rowHtml('GitHub repo', escapeHtml(shortRepo(r.origin.url)), !r.origin.isGitHub));
    if (r.branch) rows.push(rowHtml('Branch', escapeHtml(r.branch)));
    if (typeof r.fileCount === 'number' && r.fileCount > 0) rows.push(rowHtml('Files tracked', String(r.fileCount)));
    if (r.origin && r.origin.isGitHub) {
      rows.push(rowHtml('Local changes', r.dirty ? 'unsaved changes present' : 'none'));
      rows.push(rowHtml('Vs GitHub', versusText(r)));
      rows.push(rowHtml('Secrets ignored (.env)', yesNo(r.secretsIgnored), !r.secretsIgnored));
      rows.push(rowHtml('Personal folder ignored', r.gitignoreHasPersonal ? 'yes' : 'no — I’ll add it'));
    }

    const note = blocked
      ? `<div class="ar-note">${escapeHtml(r.blockReason || 'Resolve this in your brain first, then come back.')}</div>`
      : (adoptIntentNote(r) ? `<div class="ar-note">${escapeHtml(adoptIntentNote(r))}</div>` : '');

    // "You don't have your own repo connected yet" blocks: rather than dead-end,
    // point them at the setup guide (the conversational Update prompt on the
    // members portal). The app can't run that AskUserQuestion conversation itself
    // — they run the prompt in Claude Code, then come back and pick the folder.
    const fixableByPrompt = ['no_origin', 'not_github', 'template_origin'].includes(r.state);
    const guide = fixableByPrompt
      ? `<div class="ar-note">Quickest fix: open your setup guide, copy the <strong>Update</strong> prompt, and run it in Claude Code in this folder. It gets your own GitHub repo connected for you, then come back here and pick the folder again. <span class="link" id="adopt-setup-guide">Open the setup guide</span></div>`
      : '';

    readout.innerHTML =
      `<div class="ar-head"><span class="ar-badge">${escapeHtml(meta.badge)}</span><span class="ar-headline">${escapeHtml(meta.headline)}</span></div>` +
      `<div class="ar-rows">${rows.join('')}</div>` +
      note + guide;
    readout.classList.remove('hidden');

    const gl = document.getElementById('adopt-setup-guide');
    if (gl) gl.addEventListener('click', () => api.openExternalUrl('https://m.ads2ai.com/install'));

    const go = document.getElementById('btn-adopt-go');
    if (blocked) {
      go.classList.add('hidden');
      go.disabled = true;
    } else {
      go.classList.remove('hidden');
      go.disabled = false;
    }
  }

  function rowHtml(k, v, warn) {
    const style = warn ? ' style="color:var(--warn)"' : '';
    return `<div class="ar-row"><span class="ar-k">${escapeHtml(k)}</span><span class="ar-v"${style}>${v}</span></div>`;
  }
  function versusText(r) {
    if (r.ahead > 0 && r.behind > 0) return `${r.ahead} ahead, ${r.behind} behind`;
    if (r.ahead > 0) return `${r.ahead} commit(s) ahead`;
    if (r.behind > 0) return `${r.behind} commit(s) behind`;
    return 'in sync';
  }

  // The controlled adopt: run the one careful write path (re-confirm, protect,
  // first sync), THEN persist config — which is what starts the watcher, so it
  // only ever inherits a clean, in-sync, protected repo. Order matters: never
  // saveConfig before adoptExistingBrain resolves.
  document.getElementById('btn-adopt-go').addEventListener('click', doAdopt);

  async function doAdopt() {
    if (!adoptReport || adoptReport.block) return;
    const btn = document.getElementById('btn-adopt-go');
    const back = document.getElementById('btn-adopt-back');
    clearError('err-adopt');
    btn.disabled = true;
    back.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Working…';
    const log = document.getElementById('adoptLog');
    if (log) log.textContent = '';
    try {
      await api.adoptExistingBrain({ folder: adoptFolder, memberEmail: authEmail, memberName: authName, memberToken: authToken, teamSlug: teamInfo && teamInfo.teamSlug });
      // Only NOW persist config — this is the single trigger that starts the
      // watcher (mode 'personal' = the member's own git creds).
      chosenFolder = adoptFolder;
      adopted = true;
      await api.saveConfig({ brainPath: adoptFolder, mode: 'personal', memberEmail: authEmail, memberName: authName });
      btn.textContent = 'Done';
      setTimeout(enterDone, 400);
    } catch (err) {
      errorIn('err-adopt', friendlyError(err, 'adopt'));
      btn.disabled = false;
      back.disabled = false;
      btn.textContent = orig === 'Working…' ? 'Adopt this brain' : orig;
    }
  }

  // ====================================================================
  // 4 — files / clone
  // ====================================================================
  async function enterClone() {
    show('scene-clone');
    const pickBtn = document.getElementById('btn-pick-folder');
    const note = document.getElementById('sandboxNote');
    if (!homePath) homePath = await api.getHomePath();
    const bh = await api.getBrainHome();
    brainHome = bh.brainHome; isSandbox = bh.isSandbox;
    if (isSandbox && brainHome) {
      // Dev/test run: default to the sandbox, but still allow changing it.
      chosenFolder = brainHome;
      note.textContent = '(sandbox — your real brain is never touched)';
    } else if (mode === 'agency') {
      chosenFolder = await api.getDefaultFolder();    // ~/agencybrain
      note.textContent = '';
    } else {
      chosenFolder = homePath + '/Projects/brain';     // canonical solo path
      note.textContent = '';
    }
    // The folder is ALWAYS changeable — there must always be a recovery path if
    // the default already exists or the member wants it elsewhere.
    pickBtn.classList.remove('hidden');
    document.getElementById('folderPath').textContent = displayPath(chosenFolder);
    document.getElementById('cloneLog').textContent = '';
    clearError('err-clone');
  }
  document.getElementById('btn-pick-folder').addEventListener('click', async () => {
    const picked = await api.pickFolder({});
    if (!picked) return;
    // Full freedom for everyone (incl. agency owners): the folder they pick or
    // create in the OS dialog is used exactly as chosen — any name, anywhere.
    chosenFolder = picked;
    document.getElementById('folderPath').textContent = displayPath(chosenFolder);
  });
  document.getElementById('btn-clone').addEventListener('click', doClone);

  async function doClone() {
    const btn = document.getElementById('btn-clone');
    clearError('err-clone');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Working…';
    document.getElementById('cloneLog').textContent = '';
    try {
      if (demoMode) {
        await api.seedDemoFolder(chosenFolder);
        await new Promise((r) => setTimeout(r, 600));
      } else if (mode === 'agency') {
        await api.cloneAgencyBrain({ memberToken: teamInfo.memberToken, teamSlug: teamInfo.teamSlug, repoUrl: teamInfo.repoUrl, targetFolder: chosenFolder });
        await api.configureIdentity({ brainPath: chosenFolder, memberEmail: authEmail, memberName: authName });
      } else {
        await api.cloneSoloBrain({ memberToken: authToken, targetFolder: chosenFolder });
        await api.configureIdentity({ brainPath: chosenFolder, memberEmail: authEmail, memberName: authName });
      }
      if (!demoMode) await api.runNpmInstall({ brainPath: chosenFolder });
      btn.textContent = 'Done';
      setTimeout(enterSurfaces, 500);
    } catch (err) {
      errorIn('err-clone', friendlyError(err, 'clone'));
      btn.disabled = false;
      btn.textContent = orig === 'Working…' ? 'Try again' : orig;
    }
  }

  // ====================================================================
  // 5 — surfaces / Claude desktop check
  // ====================================================================
  async function enterSurfaces() {
    show('scene-surfaces');
    const tag = document.getElementById('claudeTag');
    const body = document.getElementById('claudeBody');
    const dl = document.getElementById('link-download-claude');
    const recheck = document.getElementById('link-recheck-claude');
    tag.textContent = 'checking…';
    dl.classList.add('hidden'); recheck.classList.add('hidden');
    let d = {};
    try { d = await api.detectClaudeDesktop(); } catch (_) {}
    if (d && d.installed) {
      tag.textContent = 'installed';
      body.textContent = `Found on your computer (version ${d.version || 'detected'}). Inside it you can use Claude Code, or Cowork, a friendlier UI some people prefer.`;
    } else {
      tag.textContent = 'not found';
      body.textContent = "Not installed yet. It's the app called Claude (not 'Claude Code'). Free from Anthropic.";
      dl.classList.remove('hidden');
      recheck.classList.remove('hidden');
    }
  }
  document.getElementById('link-download-claude').addEventListener('click', () => api.openExternalUrl('https://claude.com/download'));
  document.getElementById('link-recheck-claude').addEventListener('click', enterSurfaces);
  document.getElementById('btn-surfaces-next').addEventListener('click', enterBusiness);

  // ====================================================================
  // 6 — business Q&A
  // ====================================================================
  const bizEls = ['bizName', 'bizBusiness', 'bizSell', 'bizServe'].map((id) => document.getElementById(id));
  function updatePreview() {
    const [n, b, s, srv] = bizEls.map((el) => el.value);
    document.getElementById('mdPreview').innerHTML =
      `<span class="h"># Business Context</span>\n\n` +
      `Name: <span class="v">${escapeHtml(n)}</span>\n` +
      `Business: <span class="v">${escapeHtml(b)}</span>\n\n` +
      `<span class="h">## What I do</span>\n` +
      `Sells: <span class="v">${escapeHtml(s)}</span>\n` +
      `Serves: <span class="v">${escapeHtml(srv)}</span>\n\n` +
      `<span style="color:#888">// written to context/business/business-context.md</span>`;
  }
  bizEls.forEach((el) => el.addEventListener('input', updatePreview));
  function enterBusiness() { show('scene-business'); updatePreview(); }
  document.getElementById('btn-business-skip').addEventListener('click', enterDone);
  document.getElementById('btn-business-next').addEventListener('click', async () => {
    const btn = document.getElementById('btn-business-next');
    clearError('err-business');
    btn.disabled = true;
    try {
      if (!demoMode) {
        await api.writeBusinessContext({
          brainPath: chosenFolder,
          ctx: { name: bizEls[0].value, business: bizEls[1].value, sells: bizEls[2].value, serves: bizEls[3].value },
        });
      }
      enterDone();
    } catch (err) {
      errorIn('err-business', 'Could not write your business context. You can add it later from inside your brain.');
    } finally {
      btn.disabled = false;
    }
  });

  // ====================================================================
  // 7 — done
  // ====================================================================
  async function enterDone() {
    show('scene-done');
    const who = authName || authEmail || '';
    const where = isSandbox ? chosenFolder : displayPath(chosenFolder);
    document.getElementById('doneSummary').innerHTML = `
      <div class="stat-line"><span class="k">Your brain</span><span class="v">${escapeHtml(where)}</span></div>
      <div class="stat-line"><span class="k">Signed in as</span><span class="v">${escapeHtml(who)}</span></div>
      <div class="stat-line"><span class="k">Mode</span><span class="v">${mode === 'agency' ? escapeHtml(teamInfo.teamName || 'Agency') : 'Solo'}</span></div>
      <div class="stat-line"><span class="k">Status</span><span class="v" style="color: var(--ok);">● Watching</span></div>
    `;
    // Path B (start fresh): the member had a personal brain, but this app now
    // watches the NEW agency folder and silently stops syncing the old one. Say so
    // plainly. NOT shown for the flip (same folder) or adopt (still personal), and
    // not when the new agency folder IS the old brain.
    const note = document.getElementById('doneNote');
    if (note) {
      const switchedAway = mode === 'agency' && !flipped && priorBrainPath && priorBrainPath !== chosenFolder;
      if (switchedAway) {
        note.textContent = 'Agency Brain now watches your new agency brain. Your old personal brain at '
          + displayPath(priorBrainPath) + ' is left exactly as it was, and is no longer synced by this app.';
        note.hidden = false;
      } else {
        note.hidden = true;
      }
    }
    if (demoMode) return;
    try {
      if (mode === 'agency') {
        // The flip path (joinTeam → flipToAgency) already saved the agency config
        // (preserving every personal-mode key) and restarted the watcher + CC, so
        // re-saving here would drop those keys and bounce the watcher a second time.
        if (!flipped) {
          await api.saveConfig({
            brainPath: chosenFolder, mode: 'agency', teamSlug: teamInfo.teamSlug,
            memberEmail: authEmail, memberRole: (teamInfo.member || {}).role, memberToken: authToken, memberName: authName,
            // Seat cap (+ package label) for the upgrade banner. Server is the
            // source of truth; this is the at-install snapshot. server.cjs
            // /api/health refreshes it live so an upgrade reflects without a
            // re-login.
            scoutSeats: teamInfo.scoutSeats, packageTier: teamInfo.packageTier,
          });
        }
        api.markInstallComplete({ memberToken: authToken, teamSlug: teamInfo.teamSlug }).catch(() => {});
      } else if (!adopted) {
        // SOLO: store the path so the Command Centre + tray know it. mode
        // 'personal' uses the member's own git creds. NOTE: solo sync to a
        // backup repo is a follow-up (the clone tracks the read-only members
        // template; pulling/pushing against it is wrong). See build-log.
        // The adopt path already saved config (which started the watcher) in
        // doAdopt, so skip it here — re-saving would needlessly restart the watcher.
        await api.saveConfig({
          brainPath: chosenFolder, mode: 'personal',
          memberEmail: authEmail, memberName: authName,
        });
      }
    } catch (err) { /* config save best-effort; summary already shown */ }
  }

  // Step 3 wires this to load the embedded Command Centre into this window.
  document.getElementById('btn-open-home').addEventListener('click', () => {
    if (api.openCommandCentre) api.openCommandCentre();
    else api.closeWizard();
  });
  document.getElementById('btn-close').addEventListener('click', () => api.closeWizard());

  // ---- progress log from main (clone / npm / adopt) ----
  // Route each line to the log in whichever scene is active (scene-clone's
  // cloneLog or scene-adopt's adoptLog), so adopt progress shows on the adopt
  // screen rather than the hidden clone screen.
  api.onWizardLog((line) => {
    const active = document.querySelector('.screen.active');
    const log = (active && active.querySelector('.log')) || document.getElementById('cloneLog');
    if (!log) return;
    log.textContent += (log.textContent ? '\n' : '') + line;
    log.scrollTop = log.scrollHeight;
  });

  // ---- boot ----
  (async function init() {
    homePath = await api.getHomePath();
    // Remember any personal brain this app already watches. If the member goes
    // Path B (start fresh) the app ends up watching the NEW agency folder and
    // silently stops syncing this one, so the done screen warns them about that.
    try {
      const prior = await api.getConfig();
      if (prior && prior.mode === 'personal' && prior.brainPath) priorBrainPath = prior.brainPath;
    } catch (_) { /* no prior config; brand-new install */ }
    show('scene-welcome');
    // Deep-link join (agencybrain://join?token=…): the long token resolves the
    // same way as a pasted code, so kick it off automatically.
    let pending = null;
    try { pending = await api.consumePendingInviteToken(); } catch (_) {}
    if (pending) resolveCodeValue(pending);
  })();
})();
