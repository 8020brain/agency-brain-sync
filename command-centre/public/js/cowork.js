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
      +'<div class="tp-cowork"><b>The guided way:</b> open Cowork (pointed at your brain folder) and type <code>/start</code>, then say you want the Cowork course. '
      +'Claude walks you through these steps and does them with you. This page is the map; tick steps off in either place. '
      +'Don\'t have Cowork yet? <span class="tp-link" data-ext="https://claude.ai/download">Download it here</span>.</div>'
      +'</div>';

    p.tracks.forEach(function(t,ti){
      var done=t.steps.filter(function(s){return cwDone(s.id);}).length;
      h+='<div class="card tp-track">'
        +'<div class="sec">'+(ti+1)+' · '+esc(t.title)+' <span class="note">'+done+'/'+t.steps.length+' · '+esc(t.tagline)+'</span></div>'
        +'<div class="tp-steps">';
      t.steps.forEach(function(s){
        var isDone=cwDone(s.id);
        if(s.prompt) CW_COPY[s.id]=s.prompt;
        else if(s.quiz) CW_COPY[s.id]='Run /start, ask for the Cowork course, and give me the "'+s.title+'" quiz from the "'+t.title+'" track. Ask me one question at a time, in your own words, and let me answer before telling me how I did.';
        h+='<div class="tp-step'+(isDone?' done':'')+'" data-step="'+esc(s.id)+'">'
          +'<button class="tp-check" data-cw-toggle="'+esc(s.id)+'" title="'+(isDone?'Mark not done':'Mark done')+'">'+(isDone?'✓':'')+'</button>'
          +'<div class="tp-step-main">'
          +'<div class="tp-step-head" data-cw-open="'+esc(s.id)+'">'
          +'<span class="tp-step-title">'+esc(s.title)+'</span>'
          +'<span class="tp-chip">'+esc(s.type)+'</span>'
          +'<span class="tp-mins">'+s.minutes+' min</span>'
          +'</div>'
          +'<div class="tp-step-body"'+(CW_OPEN[s.id]?'':' hidden')+'>'
          +s.body.split(/\n+/).filter(Boolean).map(function(par){ return '<p>'+esc(par)+'</p>'; }).join('')
          +(s.prompt?'<div class="tp-prompt"><code>'+esc(s.prompt)+'</code><button class="mini" data-cw-copy="'+esc(s.id)+'">Copy for Cowork</button></div>'
            +'<p class="tp-hint">Paste it into Cowork, the Claude desktop app pointed at your brain folder. Or skip the pasting: type <code>/start</code> in Cowork and ask for the Cowork course, and Claude runs this whole thing with you.</p>':'')
          +(s.quiz?'<div class="tp-quiz">'+s.quiz.map(function(q){return '<details><summary>'+esc(q.q)+'</summary><p>'+esc(q.a)+'</p></details>';}).join('')+'</div>'
            +'<div class="tp-prompt tp-quiz-copy"><code>Want it as a proper back-and-forth? Claude will quiz you.</code><button class="mini" data-cw-copy="'+esc(s.id)+'">Copy for Cowork</button></div>':'')
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
        var label=el.textContent;
        navigator.clipboard.writeText(txt).then(function(){
          el.textContent='Copied! Paste it over there';
          setTimeout(function(){ el.textContent=label; },2000);
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', cwLoad);
