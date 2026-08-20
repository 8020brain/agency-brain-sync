'use strict';
  // ---- charts (ported from the prototype) ----
  function drawChart(svg,cfg){
    var data=cfg.data,labels=cfg.labels,type=cfg.type||'line',max=cfg.max,yticks=cfg.yticks,color='#D64C00';
    var W=540,H=180,padL=32,padR=16,padT=14,padB=28,plotW=W-padL-padR,plotH=H-padT-padB;
    var x=function(i){return padL+(plotW*i)/((data.length-1)||1);};
    var xb=function(i){return padL+(plotW*(i+0.5))/data.length;};
    var y=function(v){return padT+plotH-(plotH*v)/(max||1);};
    var out='';
    yticks.forEach(function(v){out+='<line class="gridline" x1="'+padL+'" y1="'+y(v)+'" x2="'+(W-padR)+'" y2="'+y(v)+'"/><text class="chart-x" x="'+(padL-8)+'" y="'+(y(v)+4)+'" text-anchor="end">'+v+'</text>';});
    out+='<line class="axis" x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(H-padB)+'"/><line class="axis" x1="'+padL+'" y1="'+(H-padB)+'" x2="'+(W-padR)+'" y2="'+(H-padB)+'"/>';
    if(type==='bar'){
      var bw=(plotW/data.length)*0.5;
      data.forEach(function(v,i){var by=y(v),bh=Math.max(0,(H-padB)-by);out+='<rect x="'+(xb(i)-bw/2)+'" y="'+by+'" width="'+bw+'" height="'+bh+'" fill="'+color+'" rx="1"/>';});
      labels.forEach(function(dn,i){out+='<text class="chart-x" x="'+xb(i)+'" y="'+(H-9)+'" text-anchor="middle">'+esc(dn)+'</text>';});
    } else {
      var pts=data.map(function(v,i){return [x(i),y(v)];}); var dd='M '+pts[0][0]+' '+pts[0][1];
      for(var i=0;i<pts.length-1;i++){var p0=pts[i-1]||pts[i],p1=pts[i],p2=pts[i+1],p3=pts[i+2]||p2;dd+=' C '+(p1[0]+(p2[0]-p0[0])/6)+' '+(p1[1]+(p2[1]-p0[1])/6)+' '+(p2[0]-(p3[0]-p1[0])/6)+' '+(p2[1]-(p3[1]-p1[1])/6)+' '+p2[0]+' '+p2[1];}
      out+='<path class="curve" d="'+dd+'"/>'; pts.forEach(function(p){out+='<circle class="dot" cx="'+p[0]+'" cy="'+p[1]+'" r="3"/>';});
      labels.forEach(function(dn,i){out+='<text class="chart-x" x="'+x(i)+'" y="'+(H-9)+'" text-anchor="middle">'+esc(dn)+'</text>';});
    }
    svg.innerHTML=out;
  }
  function niceMax(v){if(v<=4)return 4;if(v<=6)return 6;if(v<=10)return 10;if(v<=20)return 20;if(v<=50)return 50;return Math.ceil(v/50)*50;}

  var OBS=null, runsType='line';
  function drawRuns(){
    var svg=$('chart-runs'); if(!svg||!OBS) return;
    if(!OBS.summary.hasRuns){
      $('runs-card').innerHTML='<div class="sec">Skill runs per day</div><p class="chart-note">Per-skill run counts arrive with session logging (it ships with the home skill). Until then this stays empty rather than showing made-up numbers.</p>';
      return;
    }
    var ap=OBS.activityPerDay||[]; var data=ap.map(function(p){return p.count;}); var max=niceMax(Math.max(1,Math.max.apply(null,data.concat([0]))));
    var labels=ap.map(function(p,i){return (i===0||i===ap.length-1||i===Math.floor(ap.length/2))?p.date.slice(5):'';});
    drawChart(svg,{data:data,labels:labels,type:runsType,max:max,yticks:[0,Math.round(max/2),max]});
  }
  function drawImprove(){
    if(!OBS) return;
    var ip=OBS.improvementsPerWeek||[]; var data=ip.map(function(p){return p.count;}); var max=niceMax(Math.max(1,Math.max.apply(null,data.concat([0]))));
    var labels=ip.map(function(p){return p.weekStart.slice(5);});
    var cfg={data:data,labels:labels,type:'bar',max:max,yticks:[0,Math.round(max/2),max]};
    // owner + scout both show this chart (the scout copy has id chart-improve-s)
    ['chart-improve','chart-improve-s'].forEach(function(id){ var svg=$(id); if(svg) drawChart(svg,cfg); });
  }

  async function loadObservability(){
    try{
      OBS=await api('/api/observability');
      renderSkills(OBS); // sets SK.data for the Skills tab + flag dropdown (owner table is gone)
      renderSkillsList(); if(SP_SEL) renderSkillDetail(SP_SEL); populateFlagSkills(); renderWelcomeStats();
      drawImprove();
      renderAll();
    }catch(e){ var ig=$('owner-integrity'); if(ig) ig.textContent='Could not load observability: '+e.message; }
  }

  // runs chart toggle (the runs card is owner-only and removed in v5; guard it)
  var _runsToggle=$('runs-toggle');
  if(_runsToggle) _runsToggle.addEventListener('click',function(e){
    var b=e.target.closest('.tg'); if(!b) return;
    runsType=b.dataset.type;
    var tgs=this.querySelectorAll('.tg'); for(var i=0;i<tgs.length;i++) tgs[i].classList.toggle('active',tgs[i]===b);
    drawRuns();
  });
  // tabs
  function activateView(view){
    document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x.dataset.view===view);});
    document.querySelectorAll('.view').forEach(function(x){x.classList.remove('active');});
    var v=$('view-'+view); if(v) v.classList.add('active');
  }
  document.querySelectorAll('.tab').forEach(function(t){
    t.addEventListener('click',function(){ activateView(t.dataset.view); });
  });
  // Help page sub-nav: Get set up / How it works / Flag a skill / FAQ all live in
  // the one Help tab now, switched by the left menu. setHelpSection shows one pane.
  // First Help sub-nav item still visible, so the pane can never open on a
  // section that was removed a moment earlier.
  function landOnFirstVisibleHelpSection(preferred){
    // A client team member should land on the questions, which is what the
    // original code intended before the FAQ was removed out from under it.
    // Fall through to the first non-empty section when that is not available.
    if(preferred){
      var pb=document.querySelector('.help-navi[data-help="'+preferred+'"]');
      if(pb && !pb.hidden && $('help-'+preferred)){ setHelpSection(preferred); return; }
    }
    var first=null;
    document.querySelectorAll('.help-navi').forEach(function(b){
      if(first || b.hidden || !b.dataset.help) return;
      // Skip a nav item whose pane has nothing in it. Sections get emptied by
      // node moves (the Cowork course, the Skills browser) and by the client
      // FAQ removal, and landing on an empty one is the whole bug.
      var sec=$('help-'+b.dataset.help);
      if(sec && !sec.children.length && !String(sec.textContent||'').trim()) return;
      first=b.dataset.help;
    });
    if(first) setHelpSection(first);
  }
  function setHelpSection(name){
    document.querySelectorAll('.help-sec').forEach(function(s){ s.hidden = (s.id !== 'help-'+name); });
    document.querySelectorAll('.help-navi').forEach(function(b){ b.classList.toggle('active', b.dataset.help===name); });
  }
  document.querySelectorAll('.help-navi').forEach(function(b){
    b.addEventListener('click',function(){ setHelpSection(b.dataset.help); });
  });
  (function(){
    var s=$('help-search'); if(!s) return;
    s.addEventListener('input',function(){
      var q=s.value.trim().toLowerCase();
      if(q) setHelpSection('faq');
      document.querySelectorAll('#help-faq .faq-group').forEach(function(g){
        var any=false;
        g.querySelectorAll('.faq-item').forEach(function(d){
          var hit = !q || d.textContent.toLowerCase().indexOf(q)>=0;
          d.hidden = !hit; if(hit) any=true;
        });
        g.hidden = !!q && !any; // hide the whole section when nothing in it matches
      });
    });
  })();
  // How it works: scout/member perspective toggle on the explainer page.
  function setHiwPov(v){
    var hiw=$('hiw'); if(!hiw) return;
    hiw.setAttribute('data-pov', v);
    var pov=$('hiw-pov'); if(pov) pov.querySelectorAll('button').forEach(function(b){ b.classList.toggle('on', b.dataset.v===v); });
  }
  (function(){
    var pov=$('hiw-pov'); if(!pov) return;
    pov.addEventListener('click',function(e){
      var b=e.target.closest('button'); if(!b) return;
      setHiwPov(b.dataset.v);
    });
  })();
  // Role gates the tabs (v5 owner/scout split):
  //   owner → #view-owner (Dashboard) · scout → #view-scout (Dashboard) · team → #view-welcome
  // Everyone gets Skills (browse all), Flag, and Google Ads. head-scout is a
  // legacy alias of scout. The API still enforces real permissions server-side.
  function applyRoleTabs(serverRole){
    var role=uiRole((serverRole||'').toLowerCase());
    // head-scout is a legacy alias of scout; 'agency' (ClientBrain: agency
    // staff inside a client brain) gets the scout view — same access level.
    if(role==='head-scout'||role==='agency') role='scout';
    var isTeam=(role==='team'), isOwner=(role==='owner'), isScout=(role==='scout');
    var setTab=function(v,show){ var t=document.querySelector('.tab[data-view="'+v+'"]'); if(t) t.hidden=!show; };
    setTab('welcome', isTeam);
    setTab('path', true);   // the team path: team members run it, owners/scouts preview what their team sees
    setTab('cowork', isTeam);   // Learn Cowork: team members work in Cowork so they get the tab; owners/scouts find it under Help (optional for them)
    setTab('owner', isOwner);
    setTab('scout', isScout);
    setTab('skills', true);   // owner+scout+team can all browse the full skill list here
    setTab('gads', true);
    setTab('help', true);   // consolidated hub: Get set up, How it works, Flag a skill, FAQ
    // Help/FAQ: owners+scouts see their own FAQ plus the team FAQ appended at the end
    // (with a note + "Team" pills marking the shared questions); team members see only
    // their own FAQ, no pills, no note.
    var hos=$('help-os'), ht=$('help-team'), hf=$('help-faq');
    if(hos) hos.hidden=isTeam;
    if(ht) ht.hidden=false;
    if(hf) hf.classList.toggle('faq-owner-view', !isTeam);
    // How it works: default the POV toggle to the viewer's seat (team → member view, owner/scout → scout view).
    setHiwPov(isTeam ? 'member' : 'scout');
    // Get set up: owner and scout each see their own version of the page (inside Help now).
    var go=$('getset-owner'), gsc=$('getset-scout');
    if(go) go.hidden=!isOwner;
    if(gsc) gsc.hidden=!isScout;
    // Help sub-nav: which sections each role sees, and the default landing pane.
    var setHelpNav=function(n,show){ var b=document.querySelector('.help-navi[data-help="'+n+'"]'); if(b) b.hidden=!show; };
    setHelpNav('setup', isOwner||isScout);  // team's onboarding is the Welcome tab
    setHelpNav('how', true);
    setHelpNav('updates', !isTeam);          // owners/scouts run brain updates; team gets them via sync
    setHelpNav('cowork', !isTeam);           // optional for owners/scouts, so it lives here not the top nav
    // The one rendered Learn Cowork course (#cw-root) lives in the top-level tab for
    // team, inside the Help pane for owners/scouts. Move the node to this role's home.
    var cwRoot=$('cw-root'), cwHome=isTeam?$('view-cowork'):$('help-cowork');
    if(cwRoot && cwHome && cwRoot.parentElement!==cwHome) cwHome.appendChild(cwRoot);
    setHelpNav('flag', true);                // everyone gets the flag-a-skill docs + form; the scout also has the live inbox on their Dashboard
    setHelpNav('faq', true);
    setHelpSection(isTeam ? 'faq' : 'setup');
    // Client brains override the tab + help decisions above. This runs LAST so
    // its hiding always wins, and it runs on every applyRoleTabs call (including
    // the re-run loadRoster fires on a role change), so nothing can creep back.
    applyClientTabs();
    // Getting started must track the effective role too, or a VIEW AS flip keeps
    // showing the previous role's path (no-ops unless the role actually changed).
    if(typeof tpApplyRole==='function') tpApplyRole();
    // "Start here" featured strip is for NEW users only (team). Scouts/owners know the skills.
    renderStartHere(isTeam);
    if(isScout) renderFeedback();
    // Google Ads: owners/scouts get the credential form, team gets paste-and-connect.
    var gs=$('gads-scout'), gm=$('gads-member');
    if(gs) gs.hidden=isTeam;
    if(gm) gm.hidden=!isTeam;
    if(isTeam) gadsDetect();
    gadsProxyInit(role);
    activateView(isTeam?'welcome':(isScout?'scout':'owner'));
  }
  // ---- ClientBrain tab + help gating ----------------------------------------
  //
  // Four tabs carry agency-facing content or links into our world: Getting
  // started and Learn Cowork (portal links, our courses), Skills (the agency's
  // own toolkit) and Google Ads (six links to the members portal). In a client
  // brain all four are OPT-IN: hidden unless the agency has explicitly switched
  // that tab on for this role in the portal's Customize panel. Every other tab
  // keeps the normal opt-out behaviour (`=== false` hides it).
  //
  // Skills and Google Ads used to be hard-wired on for every role with no kind
  // check at all, which is how a client's team member ended up browsing the
  // agency's skill list and six ads2ai.com links (2026-07-29).
  //
  // 2026-08-20 (Mike): Google Ads comes out of client brains ENTIRELY. It was
  // inherited from Agency Brain and is not something to put in front of a
  // client's team, so the switch goes too — an agency must not be able to turn
  // it back on. Skills stops being a top-level tab and moves inside Help, next
  // to Flag a skill, so the two sit together. That leaves a client with
  // Welcome, Getting started, Learn Cowork, Help.
  var CLIENT_OPT_IN_TABS=['path','cowork'];
  var CLIENT_NEVER_TABS=['gads','skills'];
  // The portal's Customize panel offers owner / scout / team / agency. head-scout
  // is a legacy alias of scout everywhere else (applyRoleTabs collapses it just
  // above), so it has to collapse here too: otherwise a head-scout matches no
  // key at all, falls through to hidden, and the agency has no way to opt them
  // into anything. 'agency' deliberately does NOT collapse — the portal offers
  // it as a role in its own right.
  function pagesRole(){ return CCROLE==='head-scout' ? 'scout' : CCROLE; }
  // Getting started and Learn Cowork are ON for a client brain unless the
  // agency switches them off (Mike, 2026-08-20, the "new team member's first
  // hour" review): Getting started now holds the only connect-Cowork
  // instructions, so hiding it behind an opt-in dead-ended the wizard's
  // "your Command Centre walks you through it" handoff for any client whose
  // agency never opened the Customize panel. Everything else stays explicit
  // opt-in.
  //
  // These two are also shown on the FIRST paint, before the branding record has
  // arrived, rather than flashing hidden and appearing a moment later (Mike,
  // 2026-08-20: "show the two that are safe to show, then respect the setup the
  // scout chose"). Hiding everything pre-branding was the right call when Skills
  // and Google Ads were in this list, because those two carry agency content and
  // a wrong guess leaked it. They're in CLIENT_NEVER_TABS now and can never show
  // in a client brain at all, so the only thing left to guess about is the
  // client's own onboarding, where there is nothing to leak and a blank tab bar
  // is the worse outcome. Anything NOT in this list still stays hidden until the
  // record says otherwise.
  var CLIENT_DEFAULT_ON=['path','cowork'];
  function clientPageOn(k){
    var isDefaultOn=CLIENT_DEFAULT_ON.indexOf(k)>=0;
    if(typeof CC_PAGES==='undefined'||!CC_PAGES) return isDefaultOn;
    var row=CC_PAGES[k];
    if(isDefaultOn) return !(row&&row[pagesRole()]===false);
    return !!(row&&row[pagesRole()]===true);
  }
  function applyClientTabs(){
    if(CCKIND!=='client') return;
    var pages=(typeof CC_PAGES!=='undefined'&&CC_PAGES)||{};
    var role=pagesRole();
    var setTab=function(v,show){ var t=document.querySelector('.tab[data-view="'+v+'"]'); if(t) t.hidden=!show; };
    Object.keys(pages).forEach(function(k){
      if(pages[k]&&pages[k][role]===false) setTab(k,false);
    });
    // The two onboarding tabs paint immediately and stay on unless the agency
    // switches them off; everything else waits for the record. See clientPageOn.
    CLIENT_OPT_IN_TABS.forEach(function(k){ setTab(k, clientPageOn(k)); });
    CLIENT_NEVER_TABS.forEach(function(k){ setTab(k, false); });
    // Skills has no tab of its own in a client brain, so move the browser into
    // the Help pane. Same relocation pattern as the Learn Cowork course above:
    // one node, moved, never duplicated.
    var skRoot=$('skills-root'), skHome=$('help-skills');
    if(skRoot && skHome && skRoot.parentElement!==skHome) skHome.appendChild(skRoot);
    applyClientHelpNav();
  }
  // The Help sub-nav escapes the tab-level hiding above (it's a second nav
  // inside one visible tab), so a client's owner could still walk into "Get set
  // up" (our download page), Updates (the members portal) and both FAQs. In a
  // client brain the only section that survives is Flag a skill; the client's
  // real help is the agency contact block applyBranding injects into this pane.
  function applyClientHelpNav(){
    if(CCKIND!=='client') return;
    // FAQ is back ON for clients, but it is a different FAQ: faq-live.js fills
    // #help-faq from the brain's own .claude/faq/faq.json, never from Firestore.
    // Learn Cowork is a TOP-LEVEL tab for a team member, and applyRoleTabs moves
    // the one course node up there, so the Help copy of it is an empty shell for
    // them. Offering it here landed the tab on a blank pane. Owners and scouts
    // keep it, because for them the course lives inside Help.
    var coworkInHelp = clientPageOn('cowork') && CCROLE !== 'team';
    var show={setup:false, how:false, updates:false, cowork:coworkInHelp, flag:true, faq:true, skills:true};
    Object.keys(show).forEach(function(n){
      var b=document.querySelector('.help-navi[data-help="'+n+'"]');
      if(b) b.hidden=!show[n];
      if(!show[n]){ var s=$('help-'+n); if(s) s.hidden=true; }
    });
    // Remove the FAQ blocks outright rather than hiding them. faq-live.js
    // rebuilds #help-os / #help-team from Firestore and appends the Client Brain
    // reseller FAQ into #help-os; with the nodes gone it has nothing to write
    // into even if its fetch wins the race against this.
    ['help-os','help-team','help-team-note','help-clientbrain'].forEach(function(id){ var el=$(id); if(el) el.remove(); });
    var srch=$('help-search'); if(srch) srch.hidden=true;
    // Landing section, and this is the LAST word on it. Two earlier calls aim at
    // sections that may not be there: applyRoleTabs sends a team member to 'faq',
    // and the line that used to live here sent everyone to 'cowork' or 'flag'
    // whether or not those panes had anything in them. A client team member's
    // Cowork course lives in the top-level tab, so the Help copy is an empty
    // shell, which is how the tab came to open on a blank page for every client
    // (client field report, 2026-08-19). Prefer the questions, fall back to the first
    // section that is both visible and non-empty.
    landOnFirstVisibleHelpSection('faq');
  }

  // Footer role switcher. Visible to the two super-admin emails on every build (see the
  // gate in loadHealth), plus preview/dev builds; lets Mike flip owner/scout/team without
  // the ?as= URL trick. Regular members never see it, and it only changes the view —
  // the server enforces real permissions regardless of which role is selected here.
  (function(){
    var kw=$('dev-kind');
    if(kw && !kw.__wired){
      kw.__wired=true;
      kw.querySelectorAll('button').forEach(function(b){
        b.addEventListener('click',function(){
          try{ localStorage.setItem('cc-dev-kind', b.dataset.kind); }catch(e){}
          location.reload();
        });
      });
    }
    var sw=$('dev-switch'); if(!sw) return;
    sw.querySelectorAll('button').forEach(function(b){
      b.addEventListener('click',function(){
        DEV_ROLE_OVERRIDE=b.dataset.role;
        try{ localStorage.setItem('cc-dev-role', b.dataset.role); }catch(e){}
        loadHealth(); loadRoster();
      });
    });
  })();

