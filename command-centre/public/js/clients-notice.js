/*
 * Staged-client notice + "Have a setup code?" box (owner + scout dashboards).
 *
 * A staged client brain is a SEPARATE brain: it never appears in this app's
 * team list, and that is exactly where owners went hunting for it (Greg
 * Dickson, 2026-07-30). The notice names who is waiting and points at the
 * Your Clients page, which owns the setup code and the handover steps.
 *
 * The code box is the tray's "I have a code (add a brain)" made findable: it
 * hands the typed code to the wizard through the preload bridge, so it only
 * renders when the page is running inside the app (window.agencyBrain).
 * Server-side, /api/my-clients answers { clients: [] } for team seats and
 * client-brain installs without a network call, so this module can stay dumb.
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }

  // ---- staged-client notice ----
  function renderNotice(clients) {
    // Waiting = nobody has completed an install and nothing has ever synced.
    // A client mid-install (GitHub connected, wizard running) still counts:
    // the point of the notice is "this brain will not appear here".
    var waiting = (clients || []).filter(function (c) {
      return !c.installCompletedAt && !c.lastSyncedAt;
    });
    ['', '-s'].forEach(function (sfx) {
      var el = $('staged-clients' + sfx);
      if (!el) return;
      if (!waiting.length) { el.hidden = true; return; }
      var names = waiting.map(function (c) { return c.brandName || c.name || c.slug; });
      var h = waiting.length === 1
        ? names[0] + '’s brain is staged and waiting to be set up.'
        : waiting.length + ' client brains are staged and waiting to be set up.';
      var p = 'A client brain is its own separate brain, so it will not appear in this app. '
        + 'The setup code and the handover steps are on your Your Clients page.'
        + (waiting.length > 1 ? ' Waiting: ' + names.join(', ') + '.' : '');
      var hEl = $('sc-h' + sfx), pEl = $('sc-p' + sfx);
      if (hEl) hEl.textContent = h;
      if (pEl) pEl.textContent = p;
      el.hidden = false;
    });
  }

  function loadClients() {
    fetch('/api/my-clients')
      .then(function (r) { return r.json(); })
      .then(function (j) { renderNotice(j && j.clients); })
      .catch(function () { /* offline or signed out: no notice */ });
  }

  // ---- "Have a setup code?" box ----
  function normalise(v) { return String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6); }
  function wireCodeBox(sfx) {
    var card = $('join-code-card' + sfx);
    if (!card) return;
    // Only inside the app: the wizard handoff needs the preload bridge, and
    // this page can also be opened in a plain browser.
    var bridge = window.agencyBrain && window.agencyBrain.openJoinCode;
    if (!bridge) { card.hidden = true; return; }
    card.hidden = false;
    var input = $('jc-code' + sfx), btn = $('jc-go' + sfx), status = $('jc-status' + sfx);
    if (!input || !btn || input.__wired) return;
    input.__wired = true;
    input.addEventListener('input', function () {
      btn.disabled = normalise(input.value).length !== 6;
      if (status) status.textContent = '';
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
    btn.addEventListener('click', function () {
      var code = normalise(input.value);
      if (code.length !== 6) return;
      if (status) status.textContent = 'Opening setup…';
      window.agencyBrain.openJoinCode(code).catch(function () {
        if (status) status.textContent = 'Could not open the setup window. Use the menu-bar icon: "I have a code (add a brain)".';
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    loadClients();
    wireCodeBox('');
    wireCodeBox('-s');
  });
})();
