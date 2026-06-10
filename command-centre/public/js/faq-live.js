/*
 * faq-live.js — fetch the live Agency Brain FAQ and swap it into the Help view.
 *
 * The FAQ baked into index.html (between the FAQ-SYNC markers) is a build-time
 * fallback. On load we fetch the canonical live copy from Firestore
 * (members8020, doc community/agency-brain-faq, published by the brain's
 * tools/sync-faq.cjs) and rebuild the owner/scout + team blocks from it, so
 * FAQ edits go live without an app release. The doc holds one JSON-string
 * field (`json`) precisely so this keyless REST fetch can JSON.parse a single
 * value instead of decoding Firestore's typed-value format. Any failure
 * (offline, doc missing, bad payload) leaves the baked fallback in place.
 *
 * Rendering here mirrors buildCcBlock() in brain tools/sync-faq.cjs — same
 * section grouping, same category merge, same Team pill. If you change the
 * structure in one place, change it in the other.
 */
(function () {
  var FAQ_URL = 'https://firestore.googleapis.com/v1/projects/members8020/databases/(default)/documents/community/agency-brain-faq';

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

  function renderGroups(arr) {
    var bySec = {};
    arr.forEach(function (it) {
      var s = SECTION[it.category] || it.category;
      (bySec[s] = bySec[s] || []).push(it);
    });
    var secs = ORDER.filter(function (s) { return bySec[s]; })
      .concat(Object.keys(bySec).filter(function (s) { return ORDER.indexOf(s) === -1; }));
    return secs.map(function (s) {
      return '<div class="faq-group"><h3 class="faq-section">' + inlineHtml(s) + '</h3>' +
        bySec[s].map(function (it) {
          var pill = it.section === 'SHARED' ? ' <span class="faq-pill">Team</span>' : '';
          return '<details class="faq-item"><summary>' + inlineHtml(it.q) + pill + '</summary><div class="faq-a">' + inlineHtml(it.a) + '</div></details>';
        }).join('') +
        '</div>';
    }).join('');
  }

  function applyFaq(payload) {
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

  function loadLiveFaq() {
    fetch(FAQ_URL)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) {
        var raw = doc && doc.fields && doc.fields.json && doc.fields.json.stringValue;
        if (!raw) return;
        applyFaq(JSON.parse(raw));
      })
      .catch(function () { /* offline or blocked: baked fallback stays */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadLiveFaq);
  else loadLiveFaq();
})();
