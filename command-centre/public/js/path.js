'use strict';
  // Getting started tab — the guided paths. Renders the same path definitions
  // the Cowork /start skill runs (.claude/skills/start/team-path.json +
  // scout-path.json) and the same local progress files (personal/
  // <key>-path-progress.json), so a step done in either surface shows as done
  // in both. All local, nothing synced. Team members see the team path;
  // scouts/owners default to the scout path with a switcher to preview the
  // team path.
  var TP_DATA=null;
  var TP_SEL=null;       // 'team' | 'scout' — which path is on screen
  var TP_OPEN={};        // step id -> true while expanded, survives re-renders
  var TP_COPY={};        // step id -> text the copy button puts on the clipboard

  // Turn any http(s) URL in a paragraph into a clickable link (the rest stays escaped).
  function tpLinkify(par){
    return par.split(/(https?:\/\/[^\s)]+)/g).map(function(part){
      if(/^https?:\/\//.test(part)){
        var u=esc(part);
        return '<a href="'+u+'" target="_blank" rel="noopener" style="color:#D64C00;text-decoration:underline">'+u+'</a>';
      }
      return esc(part);
    }).join('');
  }

  function tpLoad(){
    api('/api/team-path').then(function(d){
      TP_DATA=d;
      if(d.available){
        var role=(d.role||'').toLowerCase();
        var wantScout=(role==='scout'||role==='head-scout'||role==='owner');
        TP_SEL=(wantScout&&d.paths.scout)?'scout':(d.paths.team?'team':'scout');
      }
      tpRender();
    }).catch(function(){
      var r=$('tp-root'); if(r) r.innerHTML='<div class="card"><p class="tp-loading">Couldn\'t load the path. Is the app connected to your brain folder?</p></div>';
    });
  }

  function tpCur(){ return TP_DATA && TP_DATA.paths ? TP_DATA.paths[TP_SEL] : null; }
  function tpDone(stepId){
    var c=tpCur();
    return !!(c && c.progress && c.progress.steps && c.progress.steps[stepId]);
  }

  function tpRender(){
    var root=$('tp-root'); if(!root||!TP_DATA) return;
    TP_COPY={};
    if(!TP_DATA.available){
      root.innerHTML='<div class="card"><div class="sec">Getting started</div>'
        +'<p>Your brain doesn\'t have the guided path yet — it ships with newer agency brains. '
        +'Ask your Scout to update the brain, and in the meantime the <b>Welcome</b> tab covers the essentials.</p></div>';
      return;
    }
    var cur=tpCur(); if(!cur){ root.innerHTML=''; return; }
    var p=cur.def, role=(TP_DATA.role||'').toLowerCase();
    var isTeamRole=(role==='team');
    var bothPaths=!!(TP_DATA.paths.team&&TP_DATA.paths.scout);
    var allSteps=[], doneCount=0;
    p.tracks.forEach(function(t){ t.steps.forEach(function(s){ allSteps.push(s); if(tpDone(s.id)) doneCount++; }); });
    var pct=allSteps.length?Math.round(doneCount/allSteps.length*100):0;

    var h='<div class="card tp-hero">'
      +'<div class="sec">'+esc(p.title)+' <span class="note">'+doneCount+' of '+allSteps.length+' steps done</span></div>';
    // Path switcher: scouts/owners can flip to preview what their team sees.
    if(bothPaths&&!isTeamRole){
      h+='<div class="tp-switch">'
        +'<button class="tp-switch-btn'+(TP_SEL==='scout'?' active':'')+'" data-tp-path="scout">Scout path</button>'
        +'<button class="tp-switch-btn'+(TP_SEL==='team'?' active':'')+'" data-tp-path="team">Team path (what your team sees)</button>'
        +'</div>';
    }
    h+='<p class="tp-intro">'+esc(p.intro)+'</p>'
      +'<div class="tp-bar"><div class="tp-bar-fill" style="width:'+pct+'%"></div></div>'
      +'<div class="tp-cowork"><b>The guided way:</b> '+(TP_SEL==='scout'
        ?'open Claude Code in your brain folder and type <code>/start</code>. '
        :'open Cowork (pointed at your brain folder) and type <code>/start</code>. ')
      +'Claude walks you through these steps and does them with you. This page is the map; tick steps off in either place. '
      +'Don\'t have Cowork yet? <span class="tp-link" data-ext="https://claude.ai/download">Download it here</span>.</div>'
      +(isTeamRole||TP_SEL!=='team'?'':'<p class="tp-note">This is the path your team members follow. Ticks here are your own local progress, so feel free to try it.</p>')
      +'</div>';

    p.tracks.forEach(function(t,ti){
      var done=t.steps.filter(function(s){return tpDone(s.id);}).length;
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
        var isDone=tpDone(s.id);
        var kind=(s.type||'').toLowerCase();
        var kindLabel=kind?kind.charAt(0).toUpperCase()+kind.slice(1):'';
        if(s.prompt) TP_COPY[s.id]=s.prompt;
        else if(s.quiz) TP_COPY[s.id]='Run /start and give me the "'+s.title+'" quiz from the "'+t.title+'" track. Ask me one question at a time, in your own words, and let me answer before telling me how I did.';
        h+='<div class="tp-step'+(isDone?' done':'')+'" data-step="'+esc(s.id)+'">'
          +'<button class="tp-check" data-tp-toggle="'+esc(s.id)+'" title="'+(isDone?'Mark not done':'Mark done')+'">'+(isDone?'✓':'')+'</button>'
          +'<div class="tp-step-main">'
          +'<div class="tp-step-head" data-tp-open="'+esc(s.id)+'">'
          +'<span class="tp-caret'+(TP_OPEN[s.id]?' open':'')+'" aria-hidden="true">›</span>'
          +'<span class="tp-chip tp-chip-'+esc(kind)+'">'+esc(kindLabel)+'</span>'
          +'<span class="tp-step-title">'+esc(s.title)+'</span>'
          +'<span class="tp-mins">'+s.minutes+' min</span>'
          +'</div>'
          +'<div class="tp-step-body"'+(TP_OPEN[s.id]?'':' hidden')+'>'
          +s.body.split(/\n+/).filter(Boolean).map(function(par){ return '<p>'+tpLinkify(par)+'</p>'; }).join('')
          +(s.prompt?'<div class="tp-prompt" data-tp-copy="'+esc(s.id)+'" title="Click anywhere to copy"><code>'+esc(s.prompt)+'</code><button class="mini" type="button" tabindex="-1">'+(TP_SEL==='scout'?'Copy for Claude Code':'Copy for Cowork')+'</button></div>':'')
          +(s.quiz?'<div class="tp-quiz">'+s.quiz.map(function(q){return '<details><summary>'+esc(q.q)+'</summary><p>'+esc(q.a)+'</p></details>';}).join('')+'</div>'
            +'<div class="tp-prompt tp-quiz-copy" data-tp-copy="'+esc(s.id)+'" title="Click anywhere to copy"><code>Want it as a proper back-and-forth? Claude will quiz you.</code><button class="mini" type="button" tabindex="-1">'+(TP_SEL==='scout'?'Copy for Claude Code':'Copy for Cowork')+'</button></div>':'')
          +'</div></div></div>';
      });
      h+='</div></div>';
    });
    root.innerHTML=h;

    root.querySelectorAll('[data-tp-path]').forEach(function(el){
      el.addEventListener('click',function(){
        TP_SEL=el.getAttribute('data-tp-path');
        TP_OPEN={};
        tpRender();
      });
    });
    root.querySelectorAll('[data-tp-open]').forEach(function(el){
      el.addEventListener('click',function(){
        var id=el.getAttribute('data-tp-open');
        TP_OPEN[id]=!TP_OPEN[id];
        var body=el.parentElement.querySelector('.tp-step-body');
        if(body) body.hidden=!TP_OPEN[id];
        var caret=el.querySelector('.tp-caret');
        if(caret) caret.classList.toggle('open', !!TP_OPEN[id]);
      });
    });
    root.querySelectorAll('[data-tp-toggle]').forEach(function(el){
      el.addEventListener('click',function(){
        api('/api/team-path/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:el.getAttribute('data-tp-toggle'),path:TP_SEL})})
          .then(function(r){ var c=tpCur(); if(c) c.progress=r.progress; tpRender(); })
          .catch(function(e){ alert(e.message||'Could not save.'); });
      });
    });
    root.querySelectorAll('[data-tp-copy]').forEach(function(el){
      el.addEventListener('click',function(){
        var txt=TP_COPY[el.getAttribute('data-tp-copy')]||'';
        var btn=el.querySelector('.mini'); var label=btn?btn.textContent:'';
        navigator.clipboard.writeText(txt).then(function(){
          if(btn){ btn.textContent='Copied — paste it over there'; setTimeout(function(){ btn.textContent=label; },2000); }
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', tpLoad);
