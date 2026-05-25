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
    if (teams.length === 1) { mode = 'agency'; selectTeam(teams[0]); return; }
    // 0 teams — is this a solo A2AI member?
    const mt = (member && member.memberType) || '';
    if (/community|ota|script/i.test(mt) || demoMode) {
      mode = 'solo';
      enterMachine();
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
      btn.addEventListener('click', () => { mode = 'agency'; selectTeam(t); });
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
    if (demoMode) return;
    try {
      if (mode === 'agency') {
        await api.saveConfig({
          brainPath: chosenFolder, mode: 'agency', teamSlug: teamInfo.teamSlug,
          memberEmail: authEmail, memberRole: (teamInfo.member || {}).role, memberToken: authToken, memberName: authName,
          // Seat cap (+ package label) for the upgrade banner. Server is the
          // source of truth; this is the at-install snapshot. server.cjs
          // /api/health refreshes it live so an upgrade reflects without a
          // re-login.
          scoutSeats: teamInfo.scoutSeats, packageTier: teamInfo.packageTier,
        });
        api.markInstallComplete({ memberToken: authToken, teamSlug: teamInfo.teamSlug }).catch(() => {});
      } else {
        // SOLO: store the path so the Command Centre + tray know it. mode
        // 'personal' uses the member's own git creds. NOTE: solo sync to a
        // backup repo is a follow-up (the clone tracks the read-only members
        // template; pulling/pushing against it is wrong). See build-log.
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

  // ---- progress log from main (clone / npm) ----
  api.onWizardLog((line) => {
    const log = document.getElementById('cloneLog');
    log.textContent += (log.textContent ? '\n' : '') + line;
    log.scrollTop = log.scrollHeight;
  });

  // ---- boot ----
  (async function init() {
    homePath = await api.getHomePath();
    show('scene-welcome');
    // Deep-link join (agencybrain://join?token=…): the long token resolves the
    // same way as a pasted code, so kick it off automatically.
    let pending = null;
    try { pending = await api.consumePendingInviteToken(); } catch (_) {}
    if (pending) resolveCodeValue(pending);
  })();
})();
