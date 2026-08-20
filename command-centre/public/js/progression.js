'use strict';
  // Self-report progression rail. Team members tick where they feel they are on
  // the six trust-spine levels (self-declared, never measured). Owners and scouts
  // do NOT tick here — they track their own progression on the members-portal
  // rail — so on their dashboard they only see the team's self-reports rolled up.
  // All data is local + synced via the shared repo; see lib/progression.cjs.
  // Uses the globals from core.js: $, esc, api, ago.
  (function(){
    var PROG=null;
    function load(){
      return api('/api/progression').then(function(d){ PROG=d; render(); })
        .catch(function(){ /* leave containers as-is on a failed load */ });
    }
    function lvl(n){ return Math.round((n==null?0:n)*10)/10; }
    function pct(scoreVal){ return Math.max(0, Math.min(100, Math.round((scoreVal/6)*100))); }

    // ---- team member: their own self-report rail ----
    function renderSelf(){
      var root=$('prog-self-root'); if(!root) return;
      // A client brain never shows the six-level rail. It is a way for an agency
      // to think about adoption, not something to put in front of a client's team
      // on day two (Lucy Walker, 2026-08-19). Agency brains keep it, below the
      // guided path rather than above it.
      // CCKIND already carries Mike's kind-preview override (core.js uiKind), so
      // prefer it over the server's answer; fall back to the payload if this
      // renders before /api/health lands.
      var kind=(typeof CCKIND!=='undefined'&&CCKIND)?CCKIND:PROG.kind;
      if(!PROG || kind==='client' || PROG.role!=='team' || !PROG.self){ root.innerHTML=''; return; }
      var self=PROG.self, ticks=self.ticks||{};
      var h='<div class="card prog-card">'
        +'<div class="sec">Where you are <span class="note">your own read — tick what feels true</span></div>'
        +'<p class="prog-intro">Self-reported, just so you and your team can see where a hand might help. Nothing here is measured or watched. Tick a step when it feels true; untick any time.</p>'
        +'<div class="prog-scorebar"><div class="prog-scorebar-fill" style="width:'+pct(self.score)+'%"></div></div>'
        +'<div class="prog-scorenum">Level '+lvl(self.score)+' <span class="note">of 6</span></div>';
      (PROG.levels||[]).forEach(function(l){
        var pl=(self.perLevel&&self.perLevel[l.level])||{done:0,total:l.steps.length,complete:false};
        h+='<div class="prog-lvl'+(pl.complete?' done':'')+'">'
          +'<div class="prog-lvl-head">'
          +'<span class="prog-lvl-badge'+(pl.complete?' done':'')+'">'+(pl.complete?'✓':l.level)+'</span>'
          +'<span class="prog-lvl-name">'+esc(l.name)+'</span>'
          +'<span class="prog-lvl-blurb">'+esc(l.blurb)+'</span>'
          +'<span class="prog-lvl-count">'+pl.done+' / '+pl.total+'</span>'
          +'</div><div class="prog-steps">';
        l.steps.forEach(function(s){
          var on=!!ticks[s.id];
          h+='<button class="prog-step'+(on?' on':'')+'" data-prog-step="'+esc(s.id)+'" title="'+esc(s.note)+'">'
            +'<span class="prog-check">'+(on?'✓':'')+'</span>'
            +'<span class="prog-step-label">'+esc(s.label)+'</span></button>';
        });
        h+='</div></div>';
      });
      h+='</div>';
      root.innerHTML=h;
      root.querySelectorAll('[data-prog-step]').forEach(function(el){
        el.addEventListener('click',function(){
          el.disabled=true;
          api('/api/progression/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stepId:el.getAttribute('data-prog-step')})})
            .then(function(r){ PROG.self=r.self; renderSelf(); })
            .catch(function(e){ el.disabled=false; alert(e.message||'Could not save.'); });
        });
      });
    }

    // ---- owner/scout: the team rollup ----
    function renderRollup(){
      ['prog-team-owner','prog-team-scout'].forEach(function(id){
        var box=$(id); if(!box) return;
        if(!PROG || PROG.role==='team' || !PROG.rollup){ box.hidden=true; box.innerHTML=''; return; }
        var rows=PROG.rollup;
        var h='<div class="sec">Where your team is <span class="note">self-reported by each teammate</span></div>'
          +'<p class="prog-intro">Each teammate ticks their own progress on the six levels. It’s their read, not a measurement, so use it to spot who might want a hand — never as a score to rank people by.</p>';
        if(!rows.length){
          h+='<p class="empty">No self-reports yet. Team members set theirs on the <b>Where you are</b> panel in their own Command Centre.</p>';
        } else {
          h+='<div class="prog-roll">';
          rows.forEach(function(m){
            h+='<div class="prog-roll-row">'
              +'<div class="prog-roll-who"><span class="prog-roll-name">'+esc(m.name)+'</span><span class="prog-roll-role">'+esc(m.role)+'</span></div>'
              +'<div class="prog-roll-bar"><div class="prog-roll-fill" style="width:'+pct(m.score)+'%"></div></div>'
              +'<div class="prog-roll-score">L'+lvl(m.score)+'</div>'
              +'<div class="prog-roll-updated" title="last updated">'+(m.updated?ago(m.updated):'—')+'</div>'
              +'</div>';
          });
          h+='</div>';
        }
        box.innerHTML=h; box.hidden=false;
      });
    }

    function render(){ renderSelf(); renderRollup(); }
    document.addEventListener('DOMContentLoaded', load);
    setInterval(load, 60000);
  })();
