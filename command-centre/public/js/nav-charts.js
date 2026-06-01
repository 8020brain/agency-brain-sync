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
    if(role==='head-scout') role='scout';
    var isTeam=(role==='team'), isOwner=(role==='owner'), isScout=(role==='scout');
    var setTab=function(v,show){ var t=document.querySelector('.tab[data-view="'+v+'"]'); if(t) t.hidden=!show; };
    setTab('getset', isOwner||isScout);  // onboarding/help page — owner + scout each get their own
    setTab('welcome', isTeam);
    setTab('owner', isOwner);
    setTab('scout', isScout);
    setTab('skills', true);   // owner+scout+team can all browse the full skill list here
    setTab('howitworks', true); // the sync & update explainer — useful to every role
    setTab('flag', true);
    setTab('gads', true);
    setTab('help', true);   // FAQ — everyone gets it; the block inside swaps per role
    // Help/FAQ: owners+scouts see the owner/scout block, team sees the team block.
    var hos=$('help-os'), ht=$('help-team');
    if(hos) hos.hidden=isTeam;
    if(ht) ht.hidden=!isTeam;
    // How it works: default the POV toggle to the viewer's seat (team → member view, owner/scout → scout view).
    setHiwPov(isTeam ? 'member' : 'scout');
    // Get set up: owner and scout each see their own version of the page.
    var go=$('getset-owner'), gsc=$('getset-scout');
    if(go) go.hidden=!isOwner;
    if(gsc) gsc.hidden=!isScout;
    // Flag tab: team + owner submit a flag; the scout RECEIVES them, so the scout
    // gets a Feedback inbox instead and the tab is relabelled.
    var fsub=$('flag-submit'), fsco=$('flag-scout');
    if(fsub) fsub.hidden=isScout;
    if(fsco) fsco.hidden=!isScout;
    var flagTab=document.querySelector('.tab[data-view="flag"]');
    if(flagTab) flagTab.innerHTML = isScout ? 'Feedback' : 'Flag a skill <span style="font-weight:500;color:inherit">(how feedback works)</span>';
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
  // Footer role switcher. Visible to the two super-admin emails on every build (see the
  // gate in loadHealth), plus preview/dev builds; lets Mike flip owner/scout/team without
  // the ?as= URL trick. Regular members never see it, and it only changes the view —
  // the server enforces real permissions regardless of which role is selected here.
  (function(){
    var sw=$('dev-switch'); if(!sw) return;
    sw.querySelectorAll('button').forEach(function(b){
      b.addEventListener('click',function(){ DEV_ROLE_OVERRIDE=b.dataset.role; loadHealth(); loadRoster(); });
    });
  })();

