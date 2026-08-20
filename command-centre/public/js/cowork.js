'use strict';
  // Learn Cowork tab: the standalone Cowork course. Renders cowork-path.json
  // (the same path schema as the team/scout paths) from the synced start skill,
  // and shares the same local progress mechanism (personal/cowork-path-progress
  // .json) and toggle endpoint as the Getting started tab, so a step ticked in
  // Cowork's /start shows as done here too. No switcher: this tab is always the
  // one Cowork course, available to every role. All local, nothing synced.
  var CW_DATA=null;      // the cowork path { def, progress } or null
  var CW_OPEN={};        // step id -> true while expanded, survives re-renders
  var CW_COPY={};        // step id -> text the copy button puts on the clipboard

  function cwLoad(){
    api('/api/team-path').then(function(d){
      CW_DATA=(d && d.available && d.paths && d.paths.cowork) ? d.paths.cowork : null;
      cwRender();
    }).catch(function(){
      var r=$('cw-root'); if(r) r.innerHTML='<div class="card"><p class="tp-loading">Couldn\'t load the course. Is the app connected to your brain folder?</p></div>';
    });
  }

  function cwDone(stepId){
    return !!(CW_DATA && CW_DATA.progress && CW_DATA.progress.steps && CW_DATA.progress.steps[stepId]);
  }

  function cwRender(){
    var root=$('cw-root'); if(!root) return;
    CW_COPY={};
    if(!CW_DATA){
      root.innerHTML='<div class="card"><div class="sec">Learn Cowork</div>'
        +'<p>Your brain doesn\'t have the Cowork course yet. It ships with newer agency brains. '
        +'Ask your Scout to update the brain, and in the meantime the <b>Welcome</b> tab covers the essentials.</p></div>';
      return;
    }
    var p=CW_DATA.def;
    var allSteps=[], doneCount=0;
    p.tracks.forEach(function(t){ t.steps.forEach(function(s){ allSteps.push(s); if(cwDone(s.id)) doneCount++; }); });
    var pct=allSteps.length?Math.round(doneCount/allSteps.length*100):0;

    var h='<div class="card tp-hero">'
      +'<div class="sec">'+esc(p.title)+' <span class="note">'+doneCount+' of '+allSteps.length+' steps done</span></div>'
      +'<p class="tp-intro">'+esc(p.intro)+'</p>'
      +'<div class="tp-bar"><div class="tp-bar-fill" style="width:'+pct+'%"></div></div>'
      // Never tell anyone to TYPE /start in Cowork: repo skills aren't
      // registered as commands there (Peter, 2026-07-30), so the way in is the
      // per-step Copy for Cowork buttons below (Mike, 2026-08-20).
      +'<div class="tp-cowork"><b>The guided way:</b> every step below has a <b>Copy for Cowork</b> button. '
      +'Paste one into Cowork (the Claude desktop app pointed at your brain folder) and Claude does that step with you. '
      +'This page is the map; tick steps off in either place. '
      +'Don\'t have Cowork yet? <span class="tp-link" data-ext="https://claude.ai/download">Download it here</span>.</div>'
      +'</div>';

    // Same markup as the Getting started tab (path.js tpRender): numbered track
    // badges, a caret chevron per step, type chips, click-anywhere prompt copy.
    // Keep the two renderers visually identical — this one drifted once (v0.9.35)
    // and Mike flagged the clunky look.
    p.tracks.forEach(function(t,ti){
      var done=t.steps.filter(function(s){return cwDone(s.id);}).length;
      var allDone=t.steps.length>0&&done===t.steps.length;
      h+='<div class="card tp-track">'
        +'<div class="tp-track-head">'
          +'<span class="tp-badge'+(allDone?' done':'')+'">'+(allDone?'✓':(ti+1))+'</span>'
          +'<span class="tp-track-titles"><span class="tp-track-title">'+esc(t.title)+'</span>'
          +'<span class="tp-track-tag">'+esc(t.tagline)+'</span></span>'
          +'<span class="tp-track-prog">'+done+' / '+t.steps.length+' done</span>'
        +'</div>'
        +'<div class="tp-steps">';
      t.steps.forEach(function(s){
        var isDone=cwDone(s.id);
        var kind=(s.type||'').toLowerCase();
        var kindLabel=kind?kind.charAt(0).toUpperCase()+kind.slice(1):'';
        if(s.prompt) CW_COPY[s.id]=s.prompt;
        else if(s.quiz) CW_COPY[s.id]='Read the file .claude/skills/start/SKILL.md in this folder and follow it for the Learn Cowork course: give me the "'+s.title+'" quiz from the "'+t.title+'" track. Ask me one question at a time, in your own words, and let me answer before telling me how I did.';
        h+='<div class="tp-step'+(isDone?' done':'')+'" data-step="'+esc(s.id)+'">'
          +'<button class="tp-check" data-cw-toggle="'+esc(s.id)+'" title="'+(isDone?'Mark not done':'Mark done')+'">'+(isDone?'✓':'')+'</button>'
          +'<div class="tp-step-main">'
          +'<div class="tp-step-head" data-cw-open="'+esc(s.id)+'">'
          +'<span class="tp-caret'+(CW_OPEN[s.id]?' open':'')+'" aria-hidden="true">›</span>'
          +'<span class="tp-chip tp-chip-'+esc(kind)+'">'+esc(kindLabel)+'</span>'
          +'<span class="tp-step-title">'+esc(s.title)+'</span>'
          +'<span class="tp-mins">'+esc(s.minutes)+' min</span>'
          +'</div>'
          +'<div class="tp-step-body"'+(CW_OPEN[s.id]?'':' hidden')+'>'
          +s.body.split(/\n+/).filter(Boolean).map(function(par){ return '<p>'+tpLinkify(par)+'</p>'; }).join('')
          +(s.prompt?'<div class="tp-prompt" data-cw-copy="'+esc(s.id)+'" title="Click anywhere to copy"><code>'+esc(s.prompt)+'</code><button class="mini" type="button" tabindex="-1">Copy for Cowork</button></div>'
            +'<p class="tp-hint">Paste it into Cowork, the Claude desktop app pointed at your brain folder, and Claude does this step with you.</p>':'')
          +(s.quiz?'<div class="tp-quiz">'+s.quiz.map(function(q){return '<details><summary>'+esc(q.q)+'</summary><p>'+esc(q.a)+'</p></details>';}).join('')+'</div>'
            +'<div class="tp-prompt tp-quiz-copy" data-cw-copy="'+esc(s.id)+'" title="Click anywhere to copy"><code>Want it as a proper back-and-forth? Claude will quiz you.</code><button class="mini" type="button" tabindex="-1">Copy for Cowork</button></div>':'')
          +'</div></div></div>';
      });
      h+='</div></div>';
    });
    root.innerHTML=h;

    root.querySelectorAll('[data-cw-open]').forEach(function(el){
      el.addEventListener('click',function(){
        var id=el.getAttribute('data-cw-open');
        CW_OPEN[id]=!CW_OPEN[id];
        var body=el.parentElement.querySelector('.tp-step-body');
        if(body) body.hidden=!CW_OPEN[id];
        var caret=el.querySelector('.tp-caret');
        if(caret) caret.classList.toggle('open', !!CW_OPEN[id]);
      });
    });
    root.querySelectorAll('[data-cw-toggle]').forEach(function(el){
      el.addEventListener('click',function(){
        api('/api/team-path/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:el.getAttribute('data-cw-toggle'),path:'cowork'})})
          .then(function(r){ if(CW_DATA) CW_DATA.progress=r.progress; cwRender(); })
          .catch(function(e){ alert(e.message||'Could not save.'); });
      });
    });
    root.querySelectorAll('[data-cw-copy]').forEach(function(el){
      el.addEventListener('click',function(){
        var txt=CW_COPY[el.getAttribute('data-cw-copy')]||'';
        var btn=el.querySelector('.mini'); var label=btn?btn.textContent:'';
        navigator.clipboard.writeText(txt).then(function(){
          if(btn){ btn.textContent='Copied — paste it over there'; setTimeout(function(){ btn.textContent=label; },2000); }
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', cwLoad);
