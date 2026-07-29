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
  let appVersion = '';          // app version string for the footer (fetched on boot)
  let soloConfirmed = false;    // true once routeAfterAuth confirms a solo member (footer role)
  let adopted = false;          // adopt flow saved config itself; enterDone must not re-save
  let flipped = false;          // flip-to-agency saved+restarted itself; enterDone must not re-save
  let reconnectMode = false;    // reconnect intent: quick re-auth of an existing agency brain (no re-setup)
  let priorBrainPath = '';      // a personal brain this app already watched before this run (Path B notice)
  // Launch intent from the query string. 'create-agency' means this run came from
  // "Connect to my agency team…" (tray / Command Centre nudge), so a signed-in
  // A2AI member with no team goes straight to naming their agency instead of the
  // solo fork.
  const launchIntent = new URLSearchParams(window.location.search).get('intent') || '';

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

  let machineBackTarget = 'scene-have-brain'; // where Back returns from scene-machine; set by enterMachine
  let createTeamBackTarget = 'scene-otp';     // where Back returns from scene-create-team; set by enterCreateTeam
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
    // Back button visibility. The early auth scenes AND the brain-setup scenes
    // step backward cleanly, so a member who picked "set one up" when they
    // already have a brain is never dead-ended on the folder screen.
    const back = document.getElementById('btn-back');
    const backMap = {
      'scene-email': 'scene-welcome',
      'scene-otp': 'scene-email',
      'scene-team': 'scene-otp',
      'scene-have-brain': 'scene-otp',
      'scene-create-team': createTeamBackTarget,
      'scene-machine': machineBackTarget,
      'scene-clone': 'scene-machine',
    };
    if (backMap[sceneId]) {
      back.classList.remove('hidden');
      back.onclick = () => show(backMap[sceneId]);
    } else {
      back.classList.add('hidden');
      back.onclick = null;
    }
    // Reconnect starts on the email scene; there's nowhere useful to go back to.
    if (reconnectMode && sceneId === 'scene-email') { back.classList.add('hidden'); back.onclick = null; }
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

  // ---- footer identity (support diagnostic) ----
  // Persistent footer line: which email the app is signed in as, the role, and
  // the app version. Each piece appears only once it's known, so before sign-in
  // it shows just the version. Role comes from the resolved team for agency
  // members, 'personal' once a solo member is confirmed.
  const footerIdentity = document.getElementById('footerIdentity');
  function footerRole() {
    if (teamInfo && teamInfo.member && teamInfo.member.role) return teamInfo.member.role;
    if (soloConfirmed) return 'personal';
    return '';
  }
  function renderFooterIdentity() {
    const parts = [];
    if (authEmail) parts.push(`<span class="fi-email">${escapeHtml(authEmail)}</span>`);
    const role = footerRole();
    if (role) parts.push(`<span class="fi-role">${escapeHtml(role)}</span>`);
    if (appVersion) parts.push(`<span class="fi-ver">v${escapeHtml(appVersion)}</span>`);
    footerIdentity.innerHTML = parts.join('<span class="fi-sep">&middot;</span>');
  }

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
      if (/not yet installed|github app|finish setup|409/i.test(msg)) {
        // Role-aware: an owner hitting this IS the person who has to act, so never
        // tell them to "ask your owner" (the dead-end Ionut hit, 2026-06-19).
        const role = (teamInfo && teamInfo.member && teamInfo.member.role) || '';
        // The install URL MUST carry ?state=<team-slug>. A bare app URL comes
        // back from GitHub with no team tag, producing the "Install incomplete:
        // didn't receive both the installation_id and the team slug" dead-end.
        const slug = (teamInfo && teamInfo.teamSlug) || '';
        const installUrl = slug
          ? `github.com/apps/agency-brain-sync/installations/new?state=${encodeURIComponent(slug)}`
          : 'github.com/apps/agency-brain-sync';
        if (role === 'owner') return `Almost there — you still need to install the GitHub App that keeps your brain in sync. Open ${installUrl}, click Install, choose your business organisation (not your personal account), then come back and click "Set up my brain" again.`;
        return "Your team isn't fully set up yet — your owner still needs to install the GitHub App on the repo. Once they've done that, come back and click \"Set up my brain\" again.";
      }
      if (/repository not found|could not read from remote repository/i.test(msg)) {
        // The server said this brain's repo exists, but GitHub can't find it — it
        // was deleted, or an install callback never finished creating it. We can't
        // recreate it from the clone step (that's the GitHub-install step's job),
        // so say so plainly instead of falling through to the catch-all below.
        // (2026-07-24: Mike hit the generic "something went wrong" cloning a
        // deleted client repo whose server install record was still stale.)
        return "I couldn't find your brain's GitHub repo — it looks like it was removed, or setup didn't finish creating it. Try \"Set up my brain\" again; if it keeps failing, whoever set up your brain needs to finish the GitHub install.";
      }
      if (/dev guard/i.test(msg)) return msg; // surface the dev guard verbatim to Mike
      if (net.test(msg)) return "I can't reach GitHub. Check your internet, then try again.";
      return "Something went wrong setting up your brain. Try again, or pick a different location.";
    }
    if (context === 'create-team') {
      if (/slug already exists|already exists/i.test(msg)) return "An agency with that name already exists. Try a slightly different name.";
      if (/leave the owner fields blank/i.test(msg)) return msg;
      if (net.test(msg)) return "I can't reach the server. Check your internet, then try again.";
      return "Something went wrong creating your agency. Try again in a moment.";
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
        kind: res.kind || 'agency',
        member: { email: authEmail, name: authName, role: m.role || res.memberRole || 'team' },
      };
      renderFooterIdentity();
      // ClientBrain: a client brain's OWNER arriving by invite code is the
      // first-time setup path — their repo doesn't exist yet, so route them
      // through connect-org (GitHub App install on the client's org creates +
      // seeds it), the same pipeline a self-created agency owner uses.
      const inviteRole = (teamInfo.member.role || 'team').toLowerCase();
      if (teamInfo.kind === 'client' && inviteRole === 'owner' && !teamInfo.repoUrl) {
        try {
          const st = await api.getInstallStatus(teamInfo.teamSlug);
          if (!st || !st.repoUrl || !st.installed) { enterConnectOrg(); return; }
          teamInfo.repoUrl = st.repoUrl;
        } catch (e) {
          // With no repoUrl the clone screen can never succeed, so a status
          // hiccup must NOT fall through to it (2026-07-23 test: Mike was
          // stranded on the manual clone screen). Connect-org is safe either
          // way — its 4s poll self-corrects once status answers.
          console.error('[wizard] install-status failed on invite path:', e && e.message);
          enterConnectOrg();
          return;
        }
      }
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
    renderFooterIdentity();
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
  const resendLink = document.getElementById('link-resend');
  let resendCooldown = false;
  resendLink.addEventListener('click', async () => {
    if (resendCooldown) return;
    clearError('err-otp');
    try {
      if (!demoMode) await api.requestOtpCode(authEmail);
      errorIn('err-otp', 'A fresh code is on its way.', true);
      // 60s cooldown so impatient re-clicks don't fire more login emails.
      // The server also dedups within 90s; this is the visible nudge.
      resendCooldown = true;
      const orig = resendLink.textContent;
      resendLink.style.opacity = '0.5';
      resendLink.style.pointerEvents = 'none';
      let left = 60;
      resendLink.textContent = `Resend in ${left}s`;
      const id = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(id);
          resendCooldown = false;
          resendLink.style.opacity = '';
          resendLink.style.pointerEvents = '';
          resendLink.textContent = orig;
        } else {
          resendLink.textContent = `Resend in ${left}s`;
        }
      }, 1000);
    } catch (err) { errorIn('err-otp', friendlyError(err, 'otp')); }
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
      renderFooterIdentity();
      if (reconnectMode) { await reconnectFinalize(teams); return; }
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
      soloConfirmed = true;
      renderFooterIdentity();
      // Demo always seeds a fresh demo folder, so it skips the fork. A real solo
      // member is first asked whether to adopt the brain they already have —
      // unless they launched via "Connect to my agency team…", which means they
      // want an agency and don't have one yet, so go straight to creating it.
      if (demoMode) enterMachine();
      else if (launchIntent === 'create-agency') enterCreateTeam();
      else show('scene-have-brain');
    } else {
      errorIn('err-otp',
        "This email isn't linked to a membership or an agency yet. If you just signed up or your owner just added you, give it a minute and try again, or check the exact address.");
      verifyBtn.disabled = false;
    }
  }

  // Reconnect: re-attach the existing on-disk agency brain with a fresh token —
  // no invite code, no GitHub, no re-clone. Keeps the folder + team; refreshes
  // only the token + identity, then restarts sync (save-config bounces the
  // watcher). Falls back to the normal flow if there's no folder/team to reuse.
  async function reconnectFinalize(teams) {
    let prior = {};
    try { prior = (await api.getConfig()) || {}; } catch (_) { prior = {}; }
    if (!prior.brainPath) { routeAfterAuth(teams); return; }
    const list = teams || [];
    let team = prior.teamSlug ? list.find((t) => t.slug === prior.teamSlug) : null;
    if (!team && prior.teamSlug) team = { slug: prior.teamSlug, name: prior.teamName || prior.teamSlug, role: prior.memberRole };
    if (!team && list.length === 1) team = list[0];
    if (!team) { routeAfterAuth(teams); return; }
    try {
      await api.saveConfig({
        ...prior, mode: 'agency', brainPath: prior.brainPath, teamSlug: team.slug,
        memberToken: authToken, memberEmail: authEmail, memberName: authName || prior.memberName,
        memberRole: team.role || prior.memberRole,
        scoutSeats: team.scoutSeats != null ? Number(team.scoutSeats) : (prior.scoutSeats != null ? prior.scoutSeats : null),
        packageTier: team.packageTier || prior.packageTier || null,
        kind: team.kind || prior.kind || 'agency',
      });
    } catch (e) { errorIn('err-otp', friendlyError(e, 'otp')); verifyBtn.disabled = false; return; }
    mode = 'agency';
    chosenFolder = prior.brainPath;
    flipped = true; // config saved above — enterDone must not re-save
    teamInfo = {
      memberToken: authToken, teamSlug: team.slug, teamName: team.name || team.slug,
      member: { email: authEmail, name: authName, role: team.role || prior.memberRole },
      kind: team.kind || prior.kind || 'agency',
      scoutSeats: team.scoutSeats != null ? Number(team.scoutSeats) : prior.scoutSeats,
      packageTier: team.packageTier || prior.packageTier || null,
    };
    enterDone();
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

  async function selectTeam(team) {
    teamInfo = {
      memberToken: authToken,
      teamSlug: team.slug,
      teamName: team.name || team.slug,
      repoUrl: '',
      scoutSeats: team.scoutSeats == null ? null : Number(team.scoutSeats),
      packageTier: team.packageTier || null,
      kind: team.kind || 'agency',
      member: { email: authEmail, name: authName, role: team.role || 'team' },
    };
    renderFooterIdentity();
    // An owner whose agency repo isn't created yet connects their GitHub org
    // first; the app then creates + seeds the brain there. Everyone else — and
    // owners already set up — go straight on (a not-ready repo for a scout shows
    // as the "owner still finishing" message at clone time).
    const role = (team.role || 'team').toLowerCase();
    if (role === 'owner' || role === 'head_scout' || role === 'head-scout') {
      try {
        const st = await api.getInstallStatus(team.slug);
        // Route to connect-org whenever the GitHub App isn't linked yet, not
        // only when the repo is missing. An owner whose team carries a repo_url
        // but no install (e.g. a migrated beta team) would otherwise skip the
        // install step, fail the clone, and get sent to a bare app URL with no
        // team tag — the "Install incomplete: didn't receive both the
        // installation_id and the team slug" dead-end.
        if (!st || !st.repoUrl || !st.installed) { enterConnectOrg(); return; }
        teamInfo.repoUrl = st.repoUrl;
      } catch (e) {
        // Same rule as the invite path (2026-07-23): an owner with no known
        // repoUrl must never fall through to the doomed clone screen on a
        // status hiccup. Connect-org self-corrects: its poll routes an
        // already-installed owner straight on within one tick.
        console.error('[wizard] install-status failed on sign-in path:', e && e.message);
        enterConnectOrg();
        return;
      }
    }
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
          renderFooterIdentity();
          enterSurfaces();
          return;
        }
      } catch (e) { /* fall through to the normal clone */ }
    }
    selectTeam(team);
  }

  // ====================================================================
  // 2.4 — create the agency in-app (signed-in member with no team yet).
  // The replacement for the retired agency.ads2ai.com/create-agency wizard:
  // name the agency -> POST create-team (owner flow, free Solo tier; a paid
  // package bumps it server-side) -> straight into the existing
  // connect-org -> install GitHub App -> clone -> seed pipeline.
  // ====================================================================
  let createTeamBound = false;

  function enterCreateTeam() {
    const cur = document.querySelector('.screen.active');
    if (cur && cur.id && cur.id !== 'scene-create-team') createTeamBackTarget = cur.id;
    const input = document.getElementById('agencyNameInput');
    const btn = document.getElementById('btn-create-team');
    if (!createTeamBound) {
      createTeamBound = true;
      input.addEventListener('input', () => {
        btn.disabled = input.value.trim().length < 2;
        clearError('err-create-team');
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) doCreateTeam(); });
      btn.addEventListener('click', doCreateTeam);
    }
    clearError('err-create-team');
    btn.disabled = input.value.trim().length < 2;
    show('scene-create-team');
    input.focus();
  }

  async function doCreateTeam() {
    const input = document.getElementById('agencyNameInput');
    const btn = document.getElementById('btn-create-team');
    const name = input.value.trim();
    if (name.length < 2) return;
    clearError('err-create-team');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Creating…';
    try {
      const res = await api.createTeam(authToken, name);
      const team = (res && res.team) || {};
      if (!team.slug) throw new Error('The server did not return your new agency.');
      mode = 'agency';
      teamInfo = {
        memberToken: authToken,
        teamSlug: team.slug,
        teamName: team.name || name,
        repoUrl: '',
        scoutSeats: null,   // at-create snapshot unknown; server refreshes it live post-install
        packageTier: null,
        member: { email: authEmail, name: authName, role: (res.member && res.member.role) || 'owner' },
      };
      renderFooterIdentity();
      enterConnectOrg();
    } catch (err) {
      errorIn('err-create-team', friendlyError(err, 'create-team'));
      btn.disabled = false;
    } finally {
      btn.textContent = orig;
    }
  }

  // ====================================================================
  // 2.5 — connect GitHub org (agency owner whose brain repo isn't created yet)
  // ====================================================================
  let connectOrgPoll = null;
  let connectOrgBound = false;
  let connectOrgSlug = '';

  function stopConnectOrgPoll() {
    if (connectOrgPoll) { clearInterval(connectOrgPoll); connectOrgPoll = null; }
  }

  let connectOrgEnsureInFlight = false;  // one ensure call at a time
  let connectOrgEnsureDone = false;      // stop re-asking once the server has ruled

  function showConnectOrgRecovery(res) {
    const wrap = document.getElementById('connect-org-recovery');
    const msg = document.getElementById('connect-org-recovery-msg');
    const picker = document.getElementById('connect-org-picker');
    const select = document.getElementById('connect-org-repo-select');
    const statusEl = document.getElementById('connect-org-status');
    if (statusEl) statusEl.textContent = '';
    if (!wrap || !msg) return;

    const where = res.accountLogin ? `“${res.accountLogin}”` : 'the account you picked';
    // Every message below states something the server actually established.
    // The old screen guessed "you probably used a personal account" for every
    // stall, which was wrong and sent people off to make an org they already had.
    let text;
    if (res.reason === 'personal-account') {
      text = `GitHub is connected to ${where}, which is a personal account. GitHub doesn't let apps create repositories on a personal account, only on an organisation. Creating a free organisation at github.com/account/organizations/new takes a minute, then click the connect button again and pick it.`;
    } else if (res.reason === 'no-admin') {
      text = `GitHub is connected to the ${where} organisation, but the install wasn't given permission to create repositories there. Someone with owner access on that organisation needs to approve the install, then click the connect button again.`;
    } else if (res.reason === 'create-failed') {
      text = `GitHub is connected to ${where}, but it refused to create the brain: ${res.detail || 'no reason given'}. Try again in a moment, and if it keeps happening send me this message.`;
    } else {
      text = `I couldn't reach that GitHub install to finish setting things up${res.detail ? ` (${res.detail})` : ''}. Try the connect button again.`;
    }
    msg.textContent = text;

    const repos = Array.isArray(res.repos) ? res.repos : [];
    if (picker && select && repos.length) {
      select.innerHTML = '';
      for (const r of repos) {
        const opt = document.createElement('option');
        opt.value = r.cloneUrl;
        opt.textContent = r.fullName;
        select.appendChild(opt);
      }
      picker.classList.remove('hidden');
    } else if (picker) {
      picker.classList.add('hidden');
    }
    wrap.classList.remove('hidden');
  }

  function hideConnectOrgRecovery() {
    const wrap = document.getElementById('connect-org-recovery');
    if (wrap) wrap.classList.add('hidden');
  }

  async function connectOrgCheckOnce() {
    if (!connectOrgSlug) return;
    try {
      const st = await api.getInstallStatus(connectOrgSlug);
      // Only advance once the App install has actually landed. Requiring
      // st.installed (not just st.repoUrl) matters for a team that already
      // carries a repo_url but no install: without it, the first poll tick
      // would fire immediately and bounce back to the clone, which fails
      // because the App still isn't installed.
      if (st && st.installed && st.repoUrl) {
        stopConnectOrgPoll();
        if (teamInfo) teamInfo.repoUrl = st.repoUrl;
        enterMachine();
        return;
      }
      // Installed, but no brain yet. Don't sit here hoping the GitHub redirect
      // did the job — ask the server to finish it. It creates the repo on any
      // org we can administer, however many repos that org already holds.
      // (Before this, an owner who did everything right but left "All
      // repositories" ticked on a non-empty org waited forever: Gerrards,
      // 2026-07-28.)
      if (st && st.installed && !connectOrgEnsureDone && !connectOrgEnsureInFlight) {
        connectOrgEnsureInFlight = true;
        const el = document.getElementById('connect-org-status');
        if (el) el.textContent = 'Connected to GitHub — creating your brain…';
        try {
          const res = await api.ensureBrainRepo(authToken, connectOrgSlug);
          if (res && !res.blocked && res.repoUrl) {
            stopConnectOrgPoll();
            if (teamInfo) teamInfo.repoUrl = res.repoUrl;
            enterMachine();
            return;
          }
          if (res && res.blocked) {
            connectOrgEnsureDone = true;
            stopConnectOrgPoll();
            showConnectOrgRecovery(res);
          }
        } catch (e) {
          // Transient (offline, API restart): let the poll try again.
          const el2 = document.getElementById('connect-org-status');
          if (el2) el2.textContent = 'Connected to GitHub — creating your brain…';
        } finally {
          connectOrgEnsureInFlight = false;
        }
      }
    } catch (e) { /* keep waiting; the next tick retries */ }
  }

  function connectOrgStartWaiting() {
    const recheckBtn = document.getElementById('btn-connect-recheck');
    const statusEl = document.getElementById('connect-org-status');
    if (recheckBtn) recheckBtn.classList.remove('hidden');
    if (statusEl) statusEl.textContent = 'Waiting for GitHub… pick your business organisation and approve. This updates on its own once you finish.';
    stopConnectOrgPoll();
    hideConnectOrgRecovery();
    // A fresh attempt gets a fresh ruling from the server.
    connectOrgEnsureDone = false;
    connectOrgEnsureInFlight = false;
    connectOrgPoll = setInterval(connectOrgCheckOnce, 4000);
  }

  function enterConnectOrg() {
    connectOrgSlug = (teamInfo && teamInfo.teamSlug) || '';
    // ClientBrain: this same screen serves an agency owner and a client brain,
    // so nothing on it may say "agency" when the brain being created is a
    // client's — they should never see our product's internal words on their
    // own infrastructure (2026-07-28 beta report). Named for the client's own
    // brand, which teamName already carries.
    const isClient = !!(teamInfo && teamInfo.kind === 'client');
    const brandName = (teamInfo && teamInfo.teamName) || '';
    const titleEl = document.getElementById('connect-org-title');
    const ledeEl = document.getElementById('connect-org-lede');
    const noteEl = document.getElementById('connect-org-note');
    if (isClient) {
      if (titleEl) titleEl.textContent = brandName ? `Let's create the ${brandName} brain.` : "Let's create the client brain.";
      if (ledeEl) {
        ledeEl.innerHTML = 'This brain lives in a private repository on the client\'s own GitHub organisation, so it belongs to them from day one. '
          + 'Click below, then on GitHub <strong>choose the client\'s organisation</strong> (not your personal account, and not the org your own brain lives in) and approve. '
          + 'I\'ll create their brain there and pull it down for you.';
      }
      // The trap seen in testing: picking an org that already holds another brain.
      if (noteEl) noteEl.textContent = 'Use a separate organisation from your own brain. If the client doesn\'t have one yet, creating a free GitHub organisation for them takes a minute and keeps their brain cleanly theirs.';
    } else {
      if (titleEl) titleEl.textContent = "Let's create your agency brain.";
      if (ledeEl) {
        ledeEl.innerHTML = 'Your brain lives in a private repository on your business\'s GitHub organisation, so it stays yours and survives staff changes. '
          + 'Click below, then on GitHub <strong>choose your business organisation</strong> (not your personal account) and approve. '
          + 'I\'ll create your brain there and pull it down for you.';
      }
      if (noteEl) noteEl.textContent = 'Already running your own brain? That one stays exactly as it is. This is a separate brain for your agency, and we can copy your skills and context across later.';
    }
    const connectBtn = document.getElementById('btn-connect-org');
    const recheckBtn = document.getElementById('btn-connect-recheck');
    // Bind listeners once; they read connectOrgSlug live, so re-entry with a
    // different team is safe.
    if (!connectOrgBound) {
      connectOrgBound = true;
      if (connectBtn) connectBtn.addEventListener('click', async () => {
        const url = `https://github.com/apps/agency-brain-sync/installations/new?state=${encodeURIComponent(connectOrgSlug)}`;
        try { await api.openExternalUrl(url); } catch (e) { /* ignore */ }
        connectOrgStartWaiting();
      });
      // "Check now" is also the retry: clear the previous ruling so the server
      // gets asked again rather than the screen staying stuck on it.
      if (recheckBtn) recheckBtn.addEventListener('click', () => {
        connectOrgEnsureDone = false;
        hideConnectOrgRecovery();
        if (!connectOrgPoll) connectOrgPoll = setInterval(connectOrgCheckOnce, 4000);
        connectOrgCheckOnce();
      });
      const useRepoBtn = document.getElementById('btn-connect-use-repo');
      if (useRepoBtn) useRepoBtn.addEventListener('click', async () => {
        const select = document.getElementById('connect-org-repo-select');
        const repoUrl = select && select.value;
        if (!repoUrl) return;
        const orig = useRepoBtn.textContent;
        useRepoBtn.disabled = true;
        useRepoBtn.textContent = 'Setting it up…';
        try {
          await api.setTeamRepoUrl(authToken, connectOrgSlug, repoUrl);
          stopConnectOrgPoll();
          if (teamInfo) teamInfo.repoUrl = repoUrl;
          enterMachine();
        } catch (err) {
          errorIn('err-connect-org', friendlyError(err, 'set-repo'));
          useRepoBtn.disabled = false;
          useRepoBtn.textContent = orig;
        }
      });
    }
    stopConnectOrgPoll();
    const statusEl = document.getElementById('connect-org-status');
    if (statusEl) statusEl.textContent = '';
    if (recheckBtn) recheckBtn.classList.add('hidden');
    hideConnectOrgRecovery();
    show('scene-connect-org');
  }

  // ====================================================================
  // 3 — machine check
  // ====================================================================
  async function enterMachine() {
    const curScene = document.querySelector('.screen.active');
    if (curScene && curScene.id && curScene.id !== 'scene-machine') machineBackTarget = curScene.id;
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
  document.getElementById('link-create-agency').addEventListener('click', enterCreateTeam);
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
  // ClientBrain (2026-07-23): a client's brain folder is named for THEIR
  // brain — the brand slug ('Acme Corp Brain' -> 'acme-corp-brain'), falling
  // back to 'business-brain' — never 'agencybrain'. Agencies keep
  // 'agencybrain' (returning '' here), so nothing changes for them.
  let folderSlugCache = '';
  async function brainFolderSlug() {
    if (!teamInfo || teamInfo.kind !== 'client') return '';
    if (folderSlugCache) return folderSlugCache;
    let name = '';
    try {
      const cc = await api.fetchClientConfig({ memberToken: teamInfo.memberToken || authToken, teamSlug: teamInfo.teamSlug });
      name = (cc && cc.config && cc.config.brandName) || '';
    } catch (e) { /* offline or no kit config — neutral fallback below */ }
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    folderSlugCache = slug || 'business-brain';
    return folderSlugCache;
  }

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
      chosenFolder = await api.getDefaultFolder(await brainFolderSlug());
      note.textContent = '';
    } else {
      chosenFolder = homePath + '/Projects/brain';     // canonical solo path
      note.textContent = '';
    }
    // The folder is ALWAYS changeable — there must always be a recovery path if
    // the default already exists or the member wants it elsewhere.
    pickBtn.classList.remove('hidden');
    // Full path, not the ~ short form. This is the screen where files get
    // created, so "~/acme-brain" leaves people guessing where that really is
    // (reported 2026-07-29). Everywhere else keeps displayPath().
    document.getElementById('folderPath').textContent = chosenFolder;
    document.getElementById('cloneLog').textContent = '';
    clearError('err-clone');
  }
  document.getElementById('btn-pick-folder').addEventListener('click', async () => {
    const picked = await api.pickFolder({});
    if (!picked) return;
    // Full freedom for everyone (incl. agency owners): the folder they pick or
    // create in the OS dialog is used exactly as chosen — any name, anywhere.
    chosenFolder = picked;
    document.getElementById('folderPath').textContent = chosenFolder;
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
        await api.cloneAgencyBrain({ memberToken: teamInfo.memberToken, teamSlug: teamInfo.teamSlug, repoUrl: teamInfo.repoUrl, targetFolder: chosenFolder, teamKind: teamInfo.kind || 'agency' });
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
          // ClientBrain: stamp the kind + brand name into config so the tray
          // and dialogs brand as the client's brain from next launch. The
          // brand name comes from the white-label record; a fetch failure
          // just means default branding until the CC's live fetch lands.
          let brandName = '';
          if ((teamInfo.kind || 'agency') === 'client' && api.fetchClientConfig) {
            try {
              const cc = await api.fetchClientConfig({ memberToken: teamInfo.memberToken || authToken, teamSlug: teamInfo.teamSlug });
              brandName = (cc && cc.config && cc.config.brandName) || '';
            } catch (e) { /* default branding until the live fetch works */ }
          }
          await api.saveConfig({
            brainPath: chosenFolder, mode: 'agency', teamSlug: teamInfo.teamSlug,
            memberEmail: authEmail, memberRole: (teamInfo.member || {}).role, memberToken: authToken, memberName: authName,
            // Seat cap (+ package label) for the upgrade banner. Server is the
            // source of truth; this is the at-install snapshot. server.cjs
            // /api/health refreshes it live so an upgrade reflects without a
            // re-login.
            scoutSeats: teamInfo.scoutSeats, packageTier: teamInfo.packageTier,
            kind: teamInfo.kind || 'agency', brandName,
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
    // App version for the footer diagnostic line. Best-effort: if the IPC isn't
    // there (an old main process), the footer just omits the version.
    try { appVersion = (await api.getAppVersion()) || ''; } catch (_) { appVersion = ''; }
    renderFooterIdentity();
    // Remember any personal brain this app already watches. If the member goes
    // Path B (start fresh) the app ends up watching the NEW agency folder and
    // silently stops syncing this one, so the done screen warns them about that.
    try {
      const prior = await api.getConfig();
      if (prior && prior.mode === 'personal' && prior.brainPath) priorBrainPath = prior.brainPath;
    } catch (_) { /* no prior config; brand-new install */ }
    if (launchIntent === 'reconnect') {
      reconnectMode = true;
      // Quick re-auth of an existing agency brain, NOT first-time setup: hide the
      // 7-step rail and start at a pre-filled email sign-in, skipping the invite
      // code. After the code we just re-attach the existing folder + team.
      const railEl = document.getElementById('rail'); if (railEl) railEl.style.display = 'none';
      const scEl = document.getElementById('stepCount'); if (scEl) scEl.style.display = 'none';
      const eb = document.querySelector('#scene-email .eyebrow'); if (eb) eb.textContent = 'Welcome back';
      let priorEmail = '';
      try { const pc = await api.getConfig(); priorEmail = (pc && pc.memberEmail) || ''; } catch (_) {}
      show('scene-email');
      const bb = document.getElementById('btn-back'); if (bb) bb.classList.add('hidden');
      if (priorEmail) {
        emailInput.value = priorEmail;
        authEmail = priorEmail.toLowerCase();
        if (sendCodeBtn) sendCodeBtn.disabled = false;
      }
      try { emailInput.focus(); } catch (_) {}
    } else {
      show('scene-welcome');
      // 'join-code' comes from the tray's "I have a code" item: this machine
      // already runs a brain and the member is adding another (an agency owner
      // staging a client brain, say). Same screen as a fresh install, but drop
      // the cursor in the code box so it's obvious that's the thing to do.
      if (launchIntent === 'join-code') { try { codeInput.focus(); } catch (_) {} }
    }
    // Deep-link join (agencybrain://join?token=…): the long token resolves the
    // same way as a pasted code, so kick it off automatically.
    let pending = null;
    try { pending = await api.consumePendingInviteToken(); } catch (_) {}
    if (pending) resolveCodeValue(pending);
  })();
})();
