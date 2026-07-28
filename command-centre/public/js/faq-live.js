/*
 * faq-live.js — fetch the live FAQ and swap it into the Help view.
 *
 * The FAQ baked into index.html (between the FAQ-SYNC markers) is a build-time
 * fallback. On load we fetch the canonical live copies from Firestore
 * (members8020, keyless REST — the docs hold one JSON-string field precisely
 * so this fetch can JSON.parse a single value instead of decoding Firestore's
 * typed-value format) and rebuild the Help content from them, so FAQ edits go
 * live without an app release. Any failure (offline, doc missing, bad payload)
 * leaves the baked fallback in place.
 *
 * Two docs:
 *  - community/agency-brain-faq (published by brain tools/sync-faq.cjs):
 *    rebuilds the owner/scout + team blocks. Rendering mirrors buildCcBlock()
 *    in sync-faq.cjs — same section grouping, category merge, Team pill. If
 *    you change the structure in one place, change it in the other.
 *  - community/faq (published by brain tools/faq/publish-faq.cjs): the
 *    combined tabbed FAQ. From it we take the client-brain tab and append a
 *    "Client Brain FAQ" section inside the owner/scout block (2026-07-29) —
 *    owners and scouts are the people who sell Client Brain; team seats never
 *    see it. Live-only, no baked fallback: offline, the section is absent.
 */
(function () {
  var BASE = 'https://firestore.googleapis.com/v1/projects/members8020/databases/(default)/documents/community/';
  var AGENCY_URL = BASE + 'agency-brain-faq';
  var COMBINED_URL = BASE + 'faq';

  // Mirrors inlineHtml() in sync-faq.cjs: escape, then `code`, links, bare URLs.
  function inlineHtml(s) {
    var t = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s)]+)(?=[\s).]|$)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return t;
  }

  var SECTION = { 'Roles & seats': 'Plans & seats', 'Billing': 'Plans & seats' };
  var ORDER = ['Getting started', 'Syncing & conflicts', 'Privacy & data', 'Plans & seats', 'Troubleshooting'];

  function renderGroups(arr, opts) {
    opts = opts || {};
    var bySec = {};
    arr.forEach(function (it) {
      var s = SECTION[it.category] || it.category;
      (bySec[s] = bySec[s] || []).push(it);
    });
    var secs = ORDER.filter(function (s) { return bySec[s]; })
      .concat(Object.keys(bySec).filter(function (s) { return ORDER.indexOf(s) === -1; }));
    return secs.map(function (s) {
      return '<div class="faq-group"><h3 class="faq-section">' + inlineHtml((opts.prefix || '') + s) + '</h3>' +
        bySec[s].map(function (it) {
          var pill = !opts.noPills && it.section === 'SHARED' ? ' <span class="faq-pill">Team</span>' : '';
          return '<details class="faq-item"><summary>' + inlineHtml(it.q) + pill + '</summary><div class="faq-a">' + inlineHtml(it.a) + '</div></details>';
        }).join('') +
        '</div>';
    }).join('');
  }

  function applyAgencyFaq(payload) {
    if (!payload || !Array.isArray(payload.items) || !payload.items.length) return;
    var os = document.getElementById('help-os');
    var team = document.getElementById('help-team');
    if (!os || !team) return;
    // 'surface: portal' questions never render in the Command Centre.
    var items = payload.items.filter(function (i) { return i.surface !== 'portal'; });
    var osItems = items.filter(function (i) { return i.section === 'SHARED' || i.section === 'OWNER+SCOUT'; });
    var teamItems = items.filter(function (i) { return i.section === 'SHARED' || i.section === 'TEAM'; });
    if (!osItems.length || !teamItems.length) return;
    os.innerHTML = '<h2 class="faq-h">FAQ for Owners and Scouts</h2>' + renderGroups(osItems);
    team.innerHTML = '<h2 class="faq-h">FAQ for Team members</h2>' + renderGroups(teamItems);
    var banner = document.querySelector('#help-faq .faq-banner');
    if (banner && payload.banner) banner.innerHTML = inlineHtml(payload.banner);
  }

  // The Client Brain section, appended INSIDE #help-os so it inherits the
  // role gating (hidden for team seats) — must run AFTER applyAgencyFaq,
  // which rebuilds #help-os's innerHTML.
  function applyClientBrainFaq(payload) {
    if (!payload || !Array.isArray(payload.tabs)) return;
    var tab = null;
    payload.tabs.forEach(function (t) { if (t.key === 'client-brain') tab = t; });
    if (!tab || !Array.isArray(tab.items) || !tab.items.length) return;
    var os = document.getElementById('help-os');
    if (!os) return;
    var old = document.getElementById('help-clientbrain');
    if (old) old.remove();
    var div = document.createElement('div');
    div.id = 'help-clientbrain';
    div.innerHTML = '<h2 class="faq-h">Client Brain FAQ</h2>' +
      renderGroups(tab.items, { noPills: true });
    os.appendChild(div);
  }

  function fetchJsonDoc(url) {
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) {
        var raw = doc && doc.fields && doc.fields.json && doc.fields.json.stringValue;
        return raw ? JSON.parse(raw) : null;
      })
      .catch(function () { return null; });
  }

  function loadLiveFaq() {
    // Sequential on purpose: the agency apply rebuilds #help-os, so the
    // Client Brain append has to come after it, whatever the network order.
    Promise.all([fetchJsonDoc(AGENCY_URL), fetchJsonDoc(COMBINED_URL)]).then(function (res) {
      try { if (res[0]) applyAgencyFaq(res[0]); } catch (e) { /* baked fallback stays */ }
      try { if (res[1]) applyClientBrainFaq(res[1]); } catch (e) { /* section absent */ }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadLiveFaq);
  else loadLiveFaq();
})();
