'use strict';

// "Set up your brain" — the onboarding board, Agency Brain host.
//
// Interaction (per Mike, 2026-09-10):
//  - Each section is one card showing its questions as rows.
//  - You type an answer; moving on COLLAPSES that row to a slim line you can tap
//    to re-open and edit. Nothing is removed, so an answer is always editable.
//  - There are no per-question buttons. A single "Submit my answers" button sits
//    at the bottom of the card, visible but disabled until every question on the
//    card is answered or passed. Submitting files the answers and opens the next
//    section.
//  - A question can be passed to a named teammate; it then lives on their board
//    (state is in the synced repo, so it lands within a minute).
//
// Restyled to the Ads2AI house look via #view-setup CSS (soft corners, #D64C00).

(function () {
  var $id = function (id) { return document.getElementById(id); };
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  // Client-facing rule: never bare "the brain" — a client brain calls it "your
  // AI brain". Agency owners are fine with "your brain".
  function brainWord() { return SB.kind === 'client' ? 'your AI brain' : 'your brain'; }
  // The agency scout, inside a client brain, is setting the client up. Make it
  // obvious they can answer on the client's behalf and where to tailor it.
  function isAgencyPrefill() { return SB.kind === 'client' && SB.data && SB.data.me && SB.data.me.role === 'scout'; }
  function leadHtml() {
    if (isAgencyPrefill()) {
      var who = escHtml((SB.data && SB.data.teamName) || 'this client');
      return '<div class="sb-scoutlead">'
        + '<div class="sb-scoutlead-h">You can fill this in for ' + who + '</div>'
        + '<div class="sb-scoutlead-p">You know them from working together, so answer what you can from what you already know, and pass anything you’re not sure of to their team. Anything you fill in now, they won’t be asked again after handover. To change what’s asked, tell Claude Code to add, drop or reword the questions.</div>'
        + '</div>';
    }
    return '<p class="sb-resume">Take your time, and answer in your own words. If you’d rather talk than type, tap the mic key on your keyboard and speak.</p>';
  }

  var SB = {
    data: null,       // { kind, teamName, me, ownerEmail, roster, topics, drafts, answers, assignments, skipped }
    kind: 'agency',   // 'agency' or 'client' — drives the board's own wording
    person: null,     // email of the list being viewed
    openTopic: {},    // person email -> topic id they chose to open
    editing: {},      // qid -> true while a collapsed row is re-opened for editing
    busy: false,      // a submit/pass is in flight
    submitting: false // set on Save mousedown so a row doesn't collapse under the click
  };

  // ---- Data helpers ---------------------------------------------------------
  function roster() { return (SB.data && SB.data.roster) || []; }
  function personName(email) {
    var m = roster().find(function (x) { return x.email === email; });
    if (m) return m.name || m.email;
    if (SB.data && SB.data.me && SB.data.me.email === email) return SB.data.me.name || 'you';
    return email || 'you';
  }
  function personTag(email) {
    var m = roster().find(function (x) { return x.email === email; });
    return m ? (m.role || '') : '';
  }
  function others() { return roster().filter(function (m) { return m.email !== SB.person; }); }
  function effOwner(qid) {
    return (SB.data.assignments && SB.data.assignments[qid]) || SB.data.ownerEmail || (SB.data.me && SB.data.me.email) || '';
  }
  function isFinal(qid) { return !!(SB.data.answers && SB.data.answers[qid]); }
  function draftText(qid) { var d = SB.data.drafts && SB.data.drafts[qid]; return d && d.text ? d.text : ''; }
  function hasDraft(qid) { return !!draftText(qid).trim(); }
  function isSkipped(topicId) { return !!(SB.data.skipped && SB.data.skipped[topicId]); }
  function findQ(qid) {
    var t = SB.data.topics || [];
    for (var i = 0; i < t.length; i++) for (var j = 0; j < t[i].qs.length; j++) if (t[i].qs[j].id === qid) return t[i].qs[j];
    return null;
  }
  // The questions a person still has to ANSWER on a topic (drives progress and
  // whether Save is enabled). Passed-away questions are not in here.
  function cardQs(topic, email) {
    if (isSkipped(topic.id)) return [];
    return topic.qs.filter(function (q) { return effOwner(q.id) === email && !isFinal(q.id); });
  }
  function assignedTo(qid) { return (SB.data.assignments && SB.data.assignments[qid]) || ''; }
  // A row the viewer passed to someone else — shown so the choice stays visible
  // and editable (only the owner sees these).
  function isPassedRow(q, viewer) { var a = assignedTo(q.id); return !!a && a !== viewer && viewer === SB.data.ownerEmail; }
  // Everything shown on a topic's card: the viewer's own unanswered questions,
  // plus the ones they passed away.
  function cardRows(topic, viewer) {
    if (isSkipped(topic.id)) return [];
    return topic.qs.filter(function (q) {
      if (isFinal(q.id)) return false;
      return effOwner(q.id) === viewer || isPassedRow(q, viewer);
    });
  }
  function currentTopic(email) {
    var topics = SB.data.topics || [];
    var withOpen = topics.filter(function (t) { return cardQs(t, email).length; });
    if (!withOpen.length) return null;
    var chosen = SB.openTopic[email];
    for (var i = 0; i < withOpen.length; i++) if (withOpen[i].id === chosen) return withOpen[i];
    return withOpen[0];
  }
  function filedCount() { return Object.keys((SB.data && SB.data.answers) || {}).length; }

  // ---- Header ---------------------------------------------------------------
  function renderHeader() {
    var teamName = (SB.data && SB.data.teamName) || 'your agency';
    $id('sb-mark').textContent = (teamName.trim()[0] || 'A').toUpperCase();
    $id('sb-brandname').textContent = teamName;

    var topic = currentTopic(SB.person);
    var isMe = SB.data.me && SB.person === SB.data.me.email;
    var base = isMe ? 'Your list' : personName(SB.person) + "'s list";
    var whoBtn = $id('sb-whobtn');
    var label;
    if (!topic) label = base + ' · all done';
    else { var n = cardQs(topic, SB.person).length; label = base + ' · ' + n + (n === 1 ? ' thing' : ' things'); }
    whoBtn.hidden = false;
    if (roster().length > 1) { whoBtn.textContent = label + ' ▾'; whoBtn.classList.remove('sb-solo'); }
    else { whoBtn.textContent = label; whoBtn.classList.add('sb-solo'); }
  }

  function buildWhoMenu() {
    var html = '';
    roster().forEach(function (m) {
      var isMe = SB.data.me && m.email === SB.data.me.email;
      html += '<button type="button" data-who="' + escHtml(m.email) + '" class="' + (m.email === SB.person ? 'now' : '') + '">'
        + escHtml(isMe ? 'Your list' : personName(m.email) + "'s list")
        + '<span class="tag">' + escHtml(personTag(m.email)) + '</span></button>';
    });
    $id('sb-whomenu').innerHTML = html;
  }

  // ---- Row markup -----------------------------------------------------------
  function openRowHtml(q) {
    var canPass = others().length > 0;
    return '<div class="sb-qtop">'
      + '<div class="sb-qtext">' + escHtml(q.q) + '</div>'
      + (canPass ? '<div class="sb-qacts"><button type="button" class="sb-b-pass">Pass to…</button></div>' : '')
      + '</div>'
      + '<div class="sb-picker" hidden></div>'
      + '<textarea class="sb-ans" placeholder="Type here, in your own words.">' + escHtml(draftText(q.id)) + '</textarea>';
  }
  function collapsedRowHtml(q) {
    // One line: the answer only (the question is in the title on hover), so the
    // rolled-up card stays compact.
    return '<button type="button" class="sb-qsum" title="' + escHtml(q.q) + '">'
      + '<span class="sb-tick">✓</span>'
      + '<span class="sb-qsum-a">' + escHtml(clip(draftText(q.id), 140)) + '</span>'
      + '<span class="sb-edit">Edit</span>'
      + '</button>';
  }
  function passedRowHtml(q) {
    return '<div class="sb-qrow collapsed passed" data-qid="' + escHtml(q.id) + '">'
      + '<button type="button" class="sb-qsum sb-passbtn">'
      + '<span class="sb-passicon">↗</span>'
      + '<span class="sb-qsum-a"><span class="sb-passlabel">Passed to ' + escHtml(personName(assignedTo(q.id))) + '</span> · ' + escHtml(clip(q.q, 70)) + '</span>'
      + '<span class="sb-edit">Change</span></button>'
      + '<div class="sb-picker" hidden></div></div>';
  }
  function rowIsCollapsed(q) { return hasDraft(q.id) && !SB.editing[q.id]; }
  function rowHtml(q) {
    if (isPassedRow(q, SB.person)) return passedRowHtml(q);
    var collapsed = rowIsCollapsed(q);
    return '<div class="sb-qrow' + (collapsed ? ' collapsed' : '') + '" data-qid="' + escHtml(q.id) + '">'
      + (collapsed ? collapsedRowHtml(q) : openRowHtml(q)) + '</div>';
  }

  function fit(ta) { ta.style.height = 'auto'; ta.style.height = Math.max(68, ta.scrollHeight) + 'px'; }

  // ---- Render the one open card --------------------------------------------
  function renderStage(slide) {
    var stage = $id('sb-stage');
    var topic = currentTopic(SB.person);
    if (!topic) {
      var name = SB.data.me && SB.person === SB.data.me.email ? '' : ' ' + personName(SB.person);
      stage.innerHTML = '<section class="sb-card sb-alldone' + (slide ? ' sb-slidein' : '') + '">'
        + '<p class="sb-kicker">All wrapped up</p>'
        + '<h2>That’s everything on your list for now' + escHtml(name) + '.</h2>'
        + '<p class="sb-sub">New questions will arrive here as they come up.</p></section>';
      return;
    }
    var rowqs = cardRows(topic, SB.person);
    var skipBtn = topic.optional ? '<button type="button" class="sb-skip" data-skip="' + escHtml(topic.id) + '">Skip this section</button>' : '';
    var rows = ''; rowqs.forEach(function (q) { rows += rowHtml(q); });
    stage.innerHTML = '<section class="sb-card' + (slide ? ' sb-slidein' : '') + '">'
      + '<div class="sb-cardhead"><div>'
      + '<p class="sb-kicker">' + escHtml(topic.kick) + (topic.optional ? ' · optional' : '') + '</p>'
      + '<h2>' + escHtml(topic.title) + '</h2></div>' + skipBtn + '</div>'
      + '<p class="sb-sub">' + escHtml(topic.sub) + '</p>'
      + rows
      + '<div class="sb-submitbar"><button type="button" class="sb-submit" id="sb-submit">Save my context</button>'
      + '<span class="sb-submithint" id="sb-submithint"></span></div>'
      + '</section>';
    Array.prototype.forEach.call(stage.querySelectorAll('.sb-qrow'), function (row) { wireRow(row); });
    var save = $id('sb-submit');
    // Set the guard BEFORE the click so the focused row's blur doesn't collapse
    // and shift the button out from under the cursor (that ate the first click).
    save.addEventListener('mousedown', function () { SB.submitting = true; });
    save.addEventListener('click', submitCard);
    refreshSubmit();
  }

  function wireRow(row) {
    var q = findQ(row.getAttribute('data-qid'));
    if (row.classList.contains('passed')) { wirePassedRow(row, q); return; }
    if (rowIsCollapsed(q)) {
      row.querySelector('.sb-qsum').addEventListener('click', function () {
        SB.editing[q.id] = true;
        renderStage(false);
        var r2 = document.querySelector('.sb-qrow[data-qid="' + CSS.escape(q.id) + '"] .sb-ans');
        if (r2) { r2.focus(); fit(r2); }
      });
      return;
    }
    var ta = row.querySelector('.sb-ans');
    var picker = row.querySelector('.sb-picker');
    var passBtn = row.querySelector('.sb-b-pass');
    var passing = false;
    fit(ta);
    ta.addEventListener('input', function () { fit(ta); refreshSubmit(); });
    ta.addEventListener('blur', function () {
      if (passing) return;
      // Heading into Save: don't collapse (it would shift the button under the
      // cursor and eat the click). submitCard reads the live value.
      if (SB.submitting) { SB.submitting = false; saveDraft(q.id, (ta.value || '').trim()); return; }
      var text = (ta.value || '').trim();
      saveDraft(q.id, text);
      // Collapse once answered; an empty box stays open.
      if (text) { SB.editing[q.id] = false; collapseInPlace(row, q); }
      refreshSubmit();
    });
    if (passBtn) passBtn.addEventListener('mousedown', function () { passing = true; });
    if (passBtn) passBtn.addEventListener('click', function () {
      passing = false;
      if (!picker.hidden) { picker.hidden = true; passBtn.classList.remove('picking'); return; }
      var html = '<span class="sb-pickto">To:</span>';
      others().forEach(function (m) { html += '<button type="button" class="sb-pk" data-to="' + escHtml(m.email) + '">' + escHtml(personName(m.email)) + '</button>'; });
      html += '<button type="button" class="sb-nvm">never mind</button>';
      picker.innerHTML = html; picker.hidden = false; passBtn.classList.add('picking');
      picker.querySelector('.sb-nvm').addEventListener('click', function () { picker.hidden = true; passBtn.classList.remove('picking'); ta.focus(); });
      Array.prototype.forEach.call(picker.querySelectorAll('.sb-pk'), function (pk) {
        pk.addEventListener('click', function () { passQuestion(q, pk.getAttribute('data-to')); });
      });
    });
  }

  function collapseInPlace(row, q) {
    row.classList.add('collapsed');
    row.innerHTML = collapsedRowHtml(q);
    row.querySelector('.sb-qsum').addEventListener('click', function () {
      SB.editing[q.id] = true; renderStage(false);
      var r2 = document.querySelector('.sb-qrow[data-qid="' + CSS.escape(q.id) + '"] .sb-ans');
      if (r2) { r2.focus(); fit(r2); }
    });
  }

  // Submit is enabled only when every question on the card is answered: a
  // collapsed row has a draft, an open row has non-empty text.
  function answeredNow(q, stage) {
    if (hasDraft(q.id)) return true;
    var ta = stage.querySelector('.sb-qrow[data-qid="' + CSS.escape(q.id) + '"] .sb-ans');
    return !!(ta && ta.value.trim());
  }
  function refreshSubmit() {
    var stage = $id('sb-stage');
    var btn = $id('sb-submit'); if (!btn) return;
    var topic = currentTopic(SB.person); if (!topic) return;
    var qs = cardQs(topic, SB.person);
    var left = qs.filter(function (q) { return !answeredNow(q, stage); }).length;
    btn.disabled = left > 0 || SB.busy;
    var hint = $id('sb-submithint');
    if (hint) hint.textContent = left > 0 ? (left === 1 ? 'One more to answer' : left + ' more to answer') : '';
  }

  // ---- Server actions -------------------------------------------------------
  function saveDraft(qid, text) {
    SB.data.drafts[qid] = text ? { text: text } : undefined;
    if (!text) delete SB.data.drafts[qid];
    api('/api/onboarding/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid: qid, text: text }) })
      .catch(function () { /* draft autosave is best-effort; submit will re-send */ });
  }

  function submitCard() {
    if (SB.busy) return;
    var topic = currentTopic(SB.person); if (!topic) return;
    var qs = cardQs(topic, SB.person);
    // Read the CURRENT answer of every question right now — an open row's text,
    // or a collapsed row's draft — and send them with the save. Nothing depends
    // on an in-flight draft POST, so the just-typed last answer is never missed.
    var stage = $id('sb-stage');
    var answers = {};
    qs.forEach(function (q) {
      var ta = stage.querySelector('.sb-qrow[data-qid="' + CSS.escape(q.id) + '"] .sb-ans');
      answers[q.id] = ta ? (ta.value || '').trim() : draftText(q.id);
    });
    if (qs.some(function (q) { return !answers[q.id]; })) { refreshSubmit(); return; }
    SB.busy = true; refreshSubmit();
    api('/api/onboarding/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicId: topic.id, answers: answers }) })
      .then(function () {
        SB.busy = false; SB.submitting = false;
        qs.forEach(function (q) { SB.data.answers[q.id] = { text: answers[q.id] }; delete SB.data.drafts[q.id]; delete SB.editing[q.id]; });
        // Straight on to the next section — the pill turns green and the count
        // updates, so there's no need for an interstitial screen.
        delete SB.openTopic[SB.person];
        render(true);
      })
      .catch(function () { SB.busy = false; SB.submitting = false; refreshSubmit(); });
  }

  function passQuestion(q, toEmail) {
    if (SB.busy) return;
    SB.busy = true;
    api('/api/onboarding/pass', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid: q.id, toEmail: toEmail }) })
      .then(function () {
        SB.busy = false;
        SB.data.assignments[q.id] = toEmail; delete SB.data.drafts[q.id]; delete SB.editing[q.id];
        // The question stays on the card as a "Passed to X" row you can change,
        // rather than vanishing.
        render(false);
      })
      .catch(function () { SB.busy = false; });
  }

  function reclaimQuestion(q) {
    if (SB.busy) return;
    SB.busy = true;
    api('/api/onboarding/reclaim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid: q.id }) })
      .then(function () {
        SB.busy = false;
        delete SB.data.assignments[q.id]; SB.editing[q.id] = true;
        render(false);
      })
      .catch(function () { SB.busy = false; });
  }

  function wirePassedRow(row, q) {
    var btn = row.querySelector('.sb-passbtn');
    var picker = row.querySelector('.sb-picker');
    btn.addEventListener('click', function () {
      if (!picker.hidden) { picker.hidden = true; return; }
      var html = '<span class="sb-pickto">Change:</span>'
        + '<button type="button" class="sb-pk" data-reclaim="1">Bring it back to me</button>';
      others().forEach(function (m) {
        if (m.email === assignedTo(q.id)) return;
        html += '<button type="button" class="sb-pk" data-to="' + escHtml(m.email) + '">' + escHtml(personName(m.email)) + '</button>';
      });
      html += '<button type="button" class="sb-nvm">never mind</button>';
      picker.innerHTML = html; picker.hidden = false;
      picker.querySelector('.sb-nvm').addEventListener('click', function () { picker.hidden = true; });
      var rc = picker.querySelector('[data-reclaim]');
      if (rc) rc.addEventListener('click', function () { reclaimQuestion(q); });
      Array.prototype.forEach.call(picker.querySelectorAll('.sb-pk[data-to]'), function (pk) {
        pk.addEventListener('click', function () { passQuestion(q, pk.getAttribute('data-to')); });
      });
    });
  }

  function skipTopic(topicId) {
    if (SB.busy) return;
    SB.busy = true;
    api('/api/onboarding/skip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicId: topicId, skip: true }) })
      .then(function () { SB.busy = false; SB.data.skipped[topicId] = true; delete SB.openTopic[SB.person]; render(true); })
      .catch(function () { SB.busy = false; });
  }

  // ---- Section stepper: one pill per section, ticked off as you go ----------
  function topicHasFinal(t) { return t.qs.some(function (q) { return isFinal(q.id); }); }
  function pillState(t) {
    if (isSkipped(t.id)) return 'skipped';
    var cur = currentTopic(SB.person);
    if (cur && cur.id === t.id) return 'current';
    if (!cardQs(t, SB.person).length && topicHasFinal(t)) return 'done';
    return 'upcoming';
  }
  function renderChips() {
    var topics = SB.data.topics || [];
    var cur = currentTopic(SB.person);
    var html = '<div class="sb-steprow">';
    topics.forEach(function (t) {
      var st = pillState(t);
      html += '<button type="button" class="sb-step ' + st + '" data-topic="' + escHtml(t.id) + '">'
        + (st === 'done' ? '<span class="sb-steptick">✓</span>' : '')
        + escHtml(t.title) + (st === 'skipped' ? ' · skipped' : '') + '</button>';
    });
    html += '</div>'
      + '<p class="sb-stepnote">You can come back to this anytime. You don’t have to do it all in one go.</p>'
      + '<p class="sb-nudge" id="sb-nudge" hidden></p>';
    $id('sb-upnext').innerHTML = html;
    // Sections open in order. Tapping one that isn't open yet says why.
    Array.prototype.forEach.call($id('sb-upnext').querySelectorAll('.sb-step.upcoming'), function (step) {
      step.addEventListener('click', function () {
        var n = cur ? cardQs(cur, SB.person).length : 0;
        var nd = $id('sb-nudge');
        nd.textContent = (n === 1 ? 'Save this card first, then that one opens.' : 'Finish this card first, then that one opens.');
        nd.hidden = false; clearTimeout(renderChips._nt);
        renderChips._nt = setTimeout(function () { var x = $id('sb-nudge'); if (x) x.hidden = true; }, 4000);
      });
    });
  }

  // ---- Receipts line --------------------------------------------------------
  function renderFiled() {
    var receipts = [];
    (SB.data.topics || []).forEach(function (t) { t.qs.forEach(function (q) { if (isFinal(q.id)) receipts.push(q.receipt); }); });
    var open = !$id('sb-receipts').hidden;
    var n = filedCount();
    $id('sb-filedbtn').innerHTML = (n
      ? n + ' answer' + (n === 1 ? '' : 's') + ' saved into ' + brainWord() + ' so far. You’ll never be asked any of them again.'
      : 'Nothing saved yet. Answers are saved into ' + brainWord() + ' when you save a card.')
      + '<span class="sb-chev">' + (open ? '▴' : '▾') + '</span>';
    var html = '<ul>';
    receipts.slice(0, 12).forEach(function (r) { html += '<li><span class="sb-rt">✓</span>' + escHtml(r) + '</li>'; });
    html += '</ul>';
    if (receipts.length > 12) html += '<p class="sb-more">…and ' + (receipts.length - 12) + ' more.</p>';
    $id('sb-receipts').innerHTML = html;
  }

  function render(slide) { renderHeader(); renderStage(slide); renderChips(); renderFiled(); }

  // ---- Boot -----------------------------------------------------------------
  function shell() {
    return '<div class="sb-app">'
      + '<header class="sb-appbar"><div class="sb-brand"><div class="sb-mark" id="sb-mark"></div>'
      + '<div><div class="sb-brandname" id="sb-brandname"></div>'
      + '<div class="sb-brandsub">A few questions, so ' + brainWord() + ' gets things right</div></div></div>'
      + '<div class="sb-hright"><button class="sb-whobtn" id="sb-whobtn" type="button" hidden></button>'
      + '<div class="sb-whomenu" id="sb-whomenu" hidden></div></div></header>'
      + leadHtml()
      + '<section id="sb-stage"></section>'
      + '<div class="sb-upnext" id="sb-upnext"></div>'
      + '<div class="sb-filedline"><button class="sb-filedbtn" id="sb-filedbtn" type="button"></button>'
      + '<div class="sb-receipts" id="sb-receipts" hidden></div></div></div>';
  }

  function wireShell() {
    var whoBtn = $id('sb-whobtn'), whoMenu = $id('sb-whomenu');
    whoBtn.addEventListener('click', function (e) { e.stopPropagation(); if (roster().length <= 1) return; buildWhoMenu(); whoMenu.hidden = !whoMenu.hidden; });
    whoMenu.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-who]'); if (!btn) return;
      e.stopPropagation(); whoMenu.hidden = true;
      var who = btn.getAttribute('data-who'); if (who === SB.person) return;
      SB.person = who; SB.editing = {}; render(true);
    });
    document.addEventListener('click', function () { if (whoMenu) whoMenu.hidden = true; });
    $id('sb-stage').addEventListener('click', function (e) { var sk = e.target.closest('[data-skip]'); if (sk) skipTopic(sk.getAttribute('data-skip')); });
    $id('sb-filedbtn').addEventListener('click', function () { $id('sb-receipts').hidden = !$id('sb-receipts').hidden; renderFiled(); });
  }

  function sbLoad() {
    var root = $id('sb-root'); if (!root) return;
    api('/api/onboarding').then(function (d) {
      SB.data = d;
      SB.kind = d.kind === 'client' ? 'client' : 'agency';
      SB.data.drafts = d.drafts || {}; SB.data.answers = d.answers || {};
      SB.data.assignments = d.assignments || {}; SB.data.skipped = d.skipped || {};
      SB.person = (d.me && d.me.email) || d.ownerEmail || (d.roster[0] && d.roster[0].email) || '';
      SB.editing = {};
      root.innerHTML = shell(); wireShell(); render(false);
    }).catch(function () {
      root.innerHTML = '<div class="card"><p class="tp-loading">Couldn’t load the setup board. Is the app connected to your brain folder?</p></div>';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    sbLoad();
    var tab = document.querySelector('.tab[data-view="setup"]');
    if (tab) tab.addEventListener('click', sbLoad);
  });
  window.sbReload = sbLoad;
})();
