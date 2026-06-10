'use strict';
  // Getting started tab — the team path. Renders the same path definition the
  // Cowork /start skill runs (.claude/skills/start/team-path.json) and the
  // same local progress file (personal/team-path-progress.json), so a step
  // done in either surface shows as done in both. All local, nothing synced.
  var TP_DATA=null;
  var TP_OPEN={};   // step id -> true while expanded, survives re-renders

  function tpLoad(){
    api('/api/team-path').then(function(d){
      TP_DATA=d;
      tpRender();
    }).catch(function(){
      var r=$('tp-root'); if(r) r.innerHTML='<div class="card"><p class="tp-loading">Couldn\'t load the path. Is the app connected to your brain folder?</p></div>';
    });
  }

  function tpDone(stepId){
    return !!(TP_DATA && TP_DATA.progress && TP_DATA.progress.steps && TP_DATA.progress.steps[stepId]);
  }

  var TP_COPY={};   // step id -> text the copy button puts on the clipboard

  function tpRender(){
    var root=$('tp-root'); if(!root||!TP_DATA) return;
    TP_COPY={};
    if(!TP_DATA.available){
      root.innerHTML='<div class="card"><div class="sec">Getting started</div>'
        +'<p>Your brain doesn\'t have the guided path yet — it ships with newer agency brains. '
        +'Ask your Scout to update the brain, and in the meantime the <b>Welcome</b> tab covers the essentials.</p></div>';
      return;
    }
    var p=TP_DATA.path, role=(TP_DATA.role||'').toLowerCase();
    var allSteps=[], doneCount=0;
    p.tracks.forEach(function(t){ t.steps.forEach(function(s){ allSteps.push(s); if(tpDone(s.id)) doneCount++; }); });
    var pct=allSteps.length?Math.round(doneCount/allSteps.length*100):0;

    var h='<div class="card tp-hero">'
      +'<div class="sec">'+esc(p.title)+' <span class="note">'+doneCount+' of '+allSteps.length+' steps done</span></div>'
      +'<p class="tp-intro">'+esc(p.intro)+'</p>'
      +'<div class="tp-bar"><div class="tp-bar-fill" style="width:'+pct+'%"></div></div>'
      +'<div class="tp-cowork"><b>The guided way:</b> open Cowork (pointed at your brain folder) and type <code>/start</code>. '
      +'Claude walks you through these steps and does them with you. This page is the map; tick steps off in either place. '
      +'Don\'t have Cowork yet? <span class="tp-link" data-ext="https://claude.ai/download">Download it here</span>.</div>'
      +(role&&role!=='team'?'<p class="tp-note">You\'re viewing as '+esc(role)+': this is the path your team members follow. Ticks here are your own local progress, so feel free to try it.</p>':'')
      +'</div>';

    p.tracks.forEach(function(t,ti){
      var done=t.steps.filter(function(s){return tpDone(s.id);}).length;
      h+='<div class="card tp-track">'
        +'<div class="sec">'+(ti+1)+' · '+esc(t.title)+' <span class="note">'+done+'/'+t.steps.length+' · '+esc(t.tagline)+'</span></div>'
        +'<div class="tp-steps">';
      t.steps.forEach(function(s){
        var isDone=tpDone(s.id);
        if(s.prompt) TP_COPY[s.id]=s.prompt;
        else if(s.quiz) TP_COPY[s.id]='Run /start and give me the "'+s.title+'" quiz from the "'+t.title+'" track. Ask me one question at a time, in your own words, and let me answer before telling me how I did.';
        h+='<div class="tp-step'+(isDone?' done':'')+'" data-step="'+esc(s.id)+'">'
          +'<button class="tp-check" data-tp-toggle="'+esc(s.id)+'" title="'+(isDone?'Mark not done':'Mark done')+'">'+(isDone?'✓':'')+'</button>'
          +'<div class="tp-step-main">'
          +'<div class="tp-step-head" data-tp-open="'+esc(s.id)+'">'
          +'<span class="tp-step-title">'+esc(s.title)+'</span>'
          +'<span class="tp-chip">'+esc(s.type)+'</span>'
          +'<span class="tp-mins">'+s.minutes+' min</span>'
          +'</div>'
          +'<div class="tp-step-body"'+(TP_OPEN[s.id]?'':' hidden')+'>'
          +'<p>'+esc(s.body)+'</p>'
          +(s.prompt?'<div class="tp-prompt"><code>'+esc(s.prompt)+'</code><button class="mini" data-tp-copy="'+esc(s.id)+'">Copy for Cowork</button></div>'
            +'<p class="tp-hint">Paste it into Cowork, the Claude desktop app pointed at your brain folder. Or skip the pasting: type <code>/start</code> in Cowork and Claude runs this whole path with you.</p>':'')
          +(s.quiz?'<div class="tp-quiz">'+s.quiz.map(function(q){return '<details><summary>'+esc(q.q)+'</summary><p>'+esc(q.a)+'</p></details>';}).join('')+'</div>'
            +'<div class="tp-prompt tp-quiz-copy"><code>Want it as a proper back-and-forth? Claude will quiz you in Cowork.</code><button class="mini" data-tp-copy="'+esc(s.id)+'">Copy for Cowork</button></div>':'')
          +'</div></div></div>';
      });
      h+='</div></div>';
    });
    root.innerHTML=h;

    root.querySelectorAll('[data-tp-open]').forEach(function(el){
      el.addEventListener('click',function(){
        var id=el.getAttribute('data-tp-open');
        TP_OPEN[id]=!TP_OPEN[id];
        var body=el.parentElement.querySelector('.tp-step-body');
        if(body) body.hidden=!TP_OPEN[id];
      });
    });
    root.querySelectorAll('[data-tp-toggle]').forEach(function(el){
      el.addEventListener('click',function(){
        api('/api/team-path/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:el.getAttribute('data-tp-toggle')})})
          .then(function(r){ TP_DATA.progress=r.progress; tpRender(); })
          .catch(function(e){ alert(e.message||'Could not save.'); });
      });
    });
    root.querySelectorAll('[data-tp-copy]').forEach(function(el){
      el.addEventListener('click',function(){
        var txt=TP_COPY[el.getAttribute('data-tp-copy')]||'';
        navigator.clipboard.writeText(txt).then(function(){
          el.textContent='Copied — paste into Cowork';
          setTimeout(function(){ el.textContent='Copy for Cowork'; },2000);
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', tpLoad);
