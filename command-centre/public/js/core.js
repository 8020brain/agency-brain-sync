'use strict';
  function $(id){return document.getElementById(id);}
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function cap(s){return s?s.charAt(0).toUpperCase()+s.slice(1):s;}
  async function api(p,opts){var r=await fetch(p,opts);var j=await r.json().catch(function(){return{};});if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j;}

  function ago(iso){
    if(!iso) return '—';
    var d=new Date(/T/.test(iso)?iso:(iso+'T00:00:00Z')); if(isNaN(d)) return esc(iso);
    var days=Math.floor((Date.now()-d.getTime())/86400000);
    if(days<=0) return 'today'; if(days===1) return 'yesterday';
    if(days<30) return days+'d ago'; if(days<365) return Math.floor(days/30)+'mo ago';
    return Math.floor(days/365)+'y ago';
  }
  // Finer-grained relative time for the live "Synced" column (the watcher
  // heartbeat is minutes/hours fresh, so day-granularity ago() would just say
  // "today"). Falls through to ago() for anything older than a day.
  function agoFine(iso){
    if(!iso) return '—';
    var d=new Date(/T/.test(iso)?iso:(iso+'T00:00:00Z')); if(isNaN(d)) return esc(iso);
    var secs=Math.floor((Date.now()-d.getTime())/1000);
    if(secs<60) return 'just now';
    if(secs<3600) return Math.floor(secs/60)+'m ago';
    if(secs<86400) return Math.floor(secs/3600)+'h ago';
    return ago(iso);
  }
  function weekLabel(){
    var now=new Date(), off=(now.getDay()+6)%7;
    var mon=new Date(now); mon.setDate(now.getDate()-off);
    var sun=new Date(mon); sun.setDate(mon.getDate()+6);
    var mo=function(d){return d.toLocaleString('en-AU',{month:'short'});};
    var same=mon.getMonth()===sun.getMonth();
    return 'Week of '+mon.getDate()+(same?'':' '+mo(mon))+'–'+sun.getDate()+' '+mo(sun)+' '+sun.getFullYear();
  }

  // Per-person identity nudge: show until CLAUDE.local.md exists, one click writes
  // it (the app already knows who they are from login). If the login name is
  // blank (the members DB has no name for some people), the banner asks for it
  // inline instead of dead-ending on "sign in again" (Richard, 2026-07-03).
  function maybeIdentity(h){
    var b=$('identity-nudge'); if(!b) return;
    if(h && h.hasLocalIdentity){ b.hidden=true; return; }
    b.hidden=false;
    var cta=$('identity-cta');
    if(cta && !cta.__wired){ cta.__wired=true; cta.addEventListener('click',function(){
      var opts={method:'POST'};
      if(cta.__askName){
        var inp=$('identity-name'); var nm=(inp&&inp.value||'').trim();
        if(!nm){ if(inp) inp.focus(); return; }
        opts={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nm})};
      }
      cta.disabled=true; cta.textContent='Setting up…';
      api('/api/write-identity',opts).then(function(r){
        $('identity-p').textContent='Done. Your Claude now knows you\'re '+(r.name||'you')+', '+(r.role||'')+' at '+(r.agency||(CCKIND==='client'?'your business':'your agency'))+'. Next stop: the Getting started tab.';
        cta.remove();
        setTimeout(function(){ b.hidden=true; loadHealth(); }, 2500);
      }).catch(function(e){
        cta.disabled=false;
        if(/don't know your name/i.test(e.message||'')){
          cta.__askName=true; cta.textContent='Save';
          $('identity-p').innerHTML='One quick thing: I don\'t have your name from your login. Type it here and I\'ll set you up. <input id="identity-name" placeholder="Your name" style="margin-left:8px;padding:4px 10px;font:inherit;border:1px solid #ccc;border-radius:2px;">';
          var inp2=$('identity-name'); if(inp2){ inp2.focus(); inp2.addEventListener('keydown',function(ev){ if(ev.key==='Enter') cta.click(); }); }
          return;
        }
        cta.textContent=cta.__askName?'Save':'Set it up';
        // Never show raw filesystem errors (2026-07-23 test: a deleted brain
        // folder surfaced as "ENOENT: no such file or directory" here).
        var im=e.message||'try again';
        if(/ENOENT|no such file|EACCES|EPERM/i.test(im)) im='your brain folder seems to be missing on this computer. Click the brain icon in the menu bar and choose "Set up..." to reconnect it.';
        $('identity-p').textContent='Couldn\'t set it up: '+im;
      });
    }); }
    var x=$('identity-x');
    if(x && !x.__wired){ x.__wired=true; x.addEventListener('click',function(){ b.hidden=true; }); }
  }

  async function loadHealth(){
    try{
      var h=await api('/api/health');
      TEAMSLUG=h.teamSlug||'';
      // Read the kind straight off the payload rather than the CCKIND global,
      // which isn't assigned until further down. Everything painted in this
      // function has to be client-safe on the very first render.
      var kind=(h.teamKind||'agency');
      $('brand-team').textContent=(h.teamSlug||(kind==='client'?'':'Your agency'));
      var role=uiRole((h.memberRole||'').toLowerCase());
      $('who-role').textContent=(role?cap(role):'No role')+' view';
      // Owners and scouts can add members right here (server-side invite via the
      // member's own token). Team members don't see the control.
      // Owner + scout both get the "Add member" control (owner-view IDs and the
      // scout-view -s copies). Either role can add anyone, including an owner.
      // Solo (personal-mode) detection: an owner with no team yet. The server
      // returns memberRole='owner' + empty teamSlug, so the add control shows, but
      // /api/team-invite would 400 ('not signed in to a team'). Intercept the click
      // and show a nudge to the tray's "Connect to my agency team…" item instead.
      // Read TEAMSLUG live at click time (not captured) — loadHealth can re-run and
      // the handler is wired once, so a captured flag would go stale after a flip.
      [['add-member','add-form','af-name','solo-nudge'],['add-member-s','add-form-s','af-name-s','solo-nudge-s']].forEach(function(t){
        var ab=$(t[0]);
        if(ab && (role==='owner'||role==='scout'||role==='head-scout'||role==='agency')){
          ab.hidden=false;
          // Once on a team, clear any solo nudge left visible from before (e.g. a
          // flip that didn't restart the window). The form stays user-toggled.
          if(TEAMSLUG){ var ndt=$(t[3]); if(ndt) ndt.hidden=true; }
          if(!ab.__wired){ ab.__wired=true; ab.addEventListener('click',function(){
            var nudge=$(t[3]), f=$(t[1]);
            if(!TEAMSLUG){ if(f) f.hidden=true; if(nudge) nudge.hidden=!nudge.hidden; return; }
            if(nudge) nudge.hidden=true;
            f.hidden=!f.hidden; if(!f.hidden) $(t[2]).focus();
            // The "show me the email first" link rides with the form.
            var ip=$(t[1]==='add-form'?'invite-preview':'invite-preview-s');
            if(ip) ip.hidden=f.hidden;
          }); }
        } else {
          if(ab) ab.hidden=true;
          var af=$(t[1]); if(af) af.hidden=true;
          var nd=$(t[3]); if(nd) nd.hidden=true;
        }
      });
      // Session-expired surfacing: banner up top + the account line stops saying
      // "signed in" so an expired session can't look normal while nothing syncs.
      var _seb=$('session-expired-banner');
      if(_seb) _seb.hidden=!h.sessionExpired;
      if(h.sessionExpired){
        $('who-role').textContent='Session expired';
        $('who-email').textContent=(h.memberEmail||'')+' — reconnect in the app';
      } else {
        $('who-email').textContent=h.memberEmail||'';
      }
      $('brand-ver').textContent=h.version?('v'+h.version):'';
      // A client brain never names this product in its footer. applyBranding
      // replaces this with the client's own brand once /api/branding lands;
      // until then, and if that record has no name, it shows the bare version
      // rather than falling back to ours.
      var verTxt=h.version?('v'+h.version):'';
      $('ft-ver').textContent=(kind==='client')?verTxt:('Agency Brain'+(verTxt?' '+verTxt:''));
      $('ft-path').textContent=h.brainRoot||'';
      // CCROLE + CCKIND must be assigned BEFORE applyRoleTabs — the client-brain
      // tab gating inside it reads both. They used to be set after, which is why
      // every kind check in the tab code was dead.
      CCROLE=role; CCKIND=kind; ME=(h.memberEmail||'').toLowerCase(); ME_NAME=(h.memberName||'').toLowerCase();
      if(h.scoutSeats!=null) SCOUT_SEATS=Number(h.scoutSeats);
      if(h.packageTier) PACKAGE_TIER=h.packageTier;
      applyClientChrome(kind);
      applyRoleTabs(h.memberRole);
      applyBranding(h);
      maybeBanner(); maybePortalNudge(); maybeIdentity(h);
      var sw=$('dev-switch');
      if(sw){
        // Super-admin backdoor: Mike's two emails get the owner/scout/team view switcher
        // on EVERY build (not just preview), so he can eyeball each role's view live
        // instead of maintaining static prototype HTML. View-only — the server still
        // enforces real permissions, so flipping the view grants no extra rights.
        var SUPER_ADMINS=['mike@ads2ai.com','mike@mikerhodes.com.au'];
        var superAdmin=SUPER_ADMINS.indexOf((h.memberEmail||'').toLowerCase().trim())!==-1;
        var dev=/preview|dev/i.test(h.version||'');
        var showSwitch=superAdmin||dev;
        sw.hidden=!showSwitch;
        if(showSwitch){ var eff=uiRole((h.memberRole||'').toLowerCase()); sw.querySelectorAll('button').forEach(function(b){ b.classList.toggle('active', b.dataset.role===eff); }); }
      }
    }catch(e){}
  }

  // ClientBrain: a client brain shows the client's brand, never ours. The
  // server's /api/branding serves the white-label record (live fetch with an
  // offline cache); this swaps the visible name + accent pair. Best-effort —
  // any failure leaves the default branding, never a broken page.
  // Hover shade for filled buttons: ~18% darker than the brand accent, so
  // hover never falls back to the stock orange on a re-branded brain.
  function hoverShade(hex){
    var m=/^#?([0-9a-f]{6})$/i.exec(String(hex||'').trim()); if(!m) return '';
    var n=parseInt(m[1],16), f=0.82;
    var r=Math.round(((n>>16)&255)*f), g=Math.round(((n>>8)&255)*f), b=Math.round((n&255)*f);
    return '#'+((1<<24)|(r<<16)|(g<<8)|b).toString(16).slice(1);
  }
  // ClientBrain chrome. The copy baked into index.html assumes an agency is
  // reading it — the product name, "your agency", "your agency's Scout", plus
  // footer links to our public site. A client brain is white-label: the client
  // bought from their agency and has no idea we exist, so all of it is swapped
  // for neutral wording and the outward links are dropped. Called once before
  // applyRoleTabs (so nothing agency-facing paints) and again from applyBranding
  // with the brand name, which becomes the Welcome eyebrow when it's known.
  var CLIENT_TEXT={
    'wc-eyebrow':'Your business brain',
    'wc-h':'Everything your business knows, in one place Claude can use.',
    'wc-app-p':'This app sits quietly up in your menu bar and keeps the shared folder in sync on your machine, automatically. Leave it running, that’s all it needs. No Git, no technical setup, nothing to remember.',
    'wc-scout-h':'You’ve got support',
    'wc-scout-p':'You don’t have to work any of this out on your own. Whoever set this brain up for you gets you connected and walks you through your first run. Ask them anything, that’s what they’re there for.',
    'session-expired-text':'You are signed out, so nothing is syncing right now. Open the app in your menu bar and choose “Reconnect / sign in again” to fix it, then this clears on its own.',
    'bu-lead':'Update ready:'
  };
  var CLIENT_HTML={
    'cw-p':'Your brain is open in <b>Cowork</b> or the <b>Claude desktop app</b>. Switch to it, paste (<kbd>⌘V</kbd> / <kbd>Ctrl V</kbd>), and press enter. Claude works right inside your brain folder — no terminal or extra tools needed.'
  };
  function applyClientChrome(kind, brandName){
    if(kind!=='client') return;
    Object.keys(CLIENT_TEXT).forEach(function(id){ var el=$(id); if(el) el.textContent=CLIENT_TEXT[id]; });
    Object.keys(CLIENT_HTML).forEach(function(id){ var el=$(id); if(el) el.innerHTML=CLIENT_HTML[id]; });
    if(brandName){ var eb=$('wc-eyebrow'); if(eb) eb.textContent=brandName; }
    // The page title and the "· Agency Brain" suffix have to be right even when
    // the branding fetch never lands (offline, or no brand record saved yet).
    // applyBranding sets both from the real brand when it can, but it bails
    // inside a try/catch, so this is the copy that always runs.
    document.title=brandName?(brandName+' · Command Centre'):'Command Centre';
    var suffix=document.querySelector('.brand .agency');
    if(suffix) suffix.textContent=brandName?('· '+brandName):'';
    // What's new, Terms and Privacy all resolve to our changelog or our public
    // site, so a client brain drops the three of them outright.
    var f=document.querySelectorAll('footer .foot-link');
    for(var i=0;i<f.length;i++) f[i].hidden=true;
  }

  async function applyBranding(h){
    var kind=(h&&h.teamKind)||'agency';
    // Client brains wear their client's brand; agency brains can wear their
    // OWN (the portal's Your Brand page, 2026-07-24 — Jaywing's ask). Any
    // other kind stays stock, and clears the pre-paint cache so it can't
    // go stale.
    if(kind!=='client'&&kind!=='agency'){ try{localStorage.removeItem('cc-branding');}catch(e){} return; }
    // The pre-paint cache is shared by every brain (same 127.0.0.1 origin), so
    // after a brain switch it paints the PREVIOUS brain's title/colours. Drop
    // it the moment the server says we're a different team, BEFORE fetching
    // branding — then a failed fetch can't leave the old brand on screen.
    try{
      var cached=JSON.parse(localStorage.getItem('cc-branding')||'null');
      if(cached&&String(cached.teamSlug||'')!==String((h&&h.teamSlug)||'')){
        localStorage.removeItem('cc-branding');
        document.title='Command Centre';
      }
    }catch(e){}
    try{
      var b=await api('/api/branding');
      // An agency that never saved a brand runs stock — drop any old cache.
      if(kind==='agency'&&!(b&&b.config)){ try{localStorage.removeItem('cc-branding');}catch(e){} return; }
      var name=(b&&b.brandName)||'';
      var suffix=document.querySelector('.brand .agency');
      if(name){
        document.title=name+' · Command Centre';
        if(suffix) suffix.textContent='· '+name;
        $('ft-ver').textContent=name+(h.version?(' v'+h.version):'');
      } else if(kind==='client'){
        // A client brain whose brand record is empty or unreachable. Showing
        // nothing beats falling back to the stock "· Agency Brain" suffix and
        // page title, which is exactly what a white-label install must not say.
        document.title='Command Centre';
        if(suffix) suffix.textContent='';
      }
      applyClientChrome(kind, name);
      var col=((b&&b.config)||{}).colours||{};
      var hov=hoverShade(col.accentDeep)||col.accentDeep||'';
      if(col.accentDeep) document.documentElement.style.setProperty('--accent',col.accentDeep);
      if(col.accentSoft) document.documentElement.style.setProperty('--accent-soft',col.accentSoft);
      if(hov) document.documentElement.style.setProperty('--accent-hover',hov);
      // Brand font (2026-07-23: portal saves it, we now honour it). Google
      // Fonts load with graceful fallback — offline just keeps system-ui.
      var font=String(((b&&b.config)||{}).font||'').replace(/[^\w \-]/g,'').trim();
      if(font){
        var l=document.createElement('link');
        l.rel='stylesheet';
        l.href='https://fonts.googleapis.com/css2?family='+encodeURIComponent(font).replace(/%20/g,'+')+':wght@400;600;700&display=swap';
        document.head.appendChild(l);
        document.body.style.fontFamily="'"+font+"',system-ui,sans-serif";
      }
      // Cache the applied brand so index.html can paint it before first
      // render on the next load — no flash of the default orange/Oxanium.
      try{ localStorage.setItem('cc-branding', JSON.stringify({teamSlug:String((h&&h.teamSlug)||''), brandName:name, accentDeep:col.accentDeep||'', accentSoft:col.accentSoft||'', accentHover:hov, font:font})); }catch(e){}
      // Everything below (page toggles, path/cowork hiding, help contacts)
      // is CLIENT-brain-only — an agency brain keeps all its own tabs.
      if(kind!=='client') return;
      // Page-visibility toggles (2026-07-23: portal saves them, we now honour
      // them). Cached into CC_PAGES rather than applied inline, because
      // applyRoleTabs re-runs on a role change (from loadRoster) without this
      // fetch — without the cache, that re-run silently un-hid every tab the
      // agency had opted out of. applyClientTabs is the one place that decides.
      CC_PAGES=((b&&b.config)||{}).pages||{};
      applyClientTabs();
      // Help contacts (2026-07-23): a client's Help tab leads with THEIR
      // agency's contact details, injected above the stock content.
      var help=((b&&b.config)||{}).help||[];
      if(help.length){
        var pane=document.querySelector('#view-help .help-pane');
        var exist=document.getElementById('client-help-contacts');
        if(pane&&!exist){
          var box=document.createElement('div');
          box.id='client-help-contacts';
          box.style.cssText='border-left:4px solid var(--accent);background:#fff;padding:14px 18px;margin-bottom:18px;';
          var rows=help.map(function(hc){
            var label=String(hc.label||hc.type||'Contact');
            var value=String(hc.value||'');
            var href='';
            if(/email/i.test(hc.type||'')||/@/.test(value)) href='mailto:'+value;
            else if(/^https?:\/\//i.test(value)) href=value;
            else if(/phone|tel/i.test(hc.type||'')) href='tel:'+value.replace(/[^+\d]/g,'');
            var esc=function(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');};
            return '<div style="margin:3px 0"><strong>'+esc(label)+':</strong> '+(href?'<a href="'+esc(href)+'">'+esc(value)+'</a>':esc(value))+'</div>';
          }).join('');
          box.innerHTML='<div style="font-weight:700;margin-bottom:6px">Need a hand? Contact your team</div>'+rows;
          pane.insertBefore(box,pane.firstChild);
        }
      }
    }catch(e){}
  }

  function buildIntegrity(d){
    var s=d.summary;
    if(s.hasDrift) return '<strong style="color:var(--ink);margin:0 2px">'+s.driftCount+' of '+s.totalSkills+' skill'+(s.totalSkills===1?'':'s')+' differ</strong> from the team’s canonical version — ask Claude to review what changed.';
    // clientWords() drops the "agency" out of this for a client brain.
    return clientWords(s.totalSkills+' skills, no canonical baseline set yet. Ask Claude in your agency brain to lock one in, so any future drift gets flagged here.');
  }

  var ORDER={draft:0,live:1,trusted:2};
  var SK={data:null, q:'', maturity:'all', flags:'all', sortKey:'maturity', sortDir:1};
  function renderSkills(d){ SK.data=d; renderSkillTable(); var ig=$('integrity'); if(ig) ig.innerHTML=buildIntegrity(d); }
  function skillSortVal(sk,key){
    if(key==='name') return (sk.name||'').toLowerCase();
    if(key==='maturity') return ORDER[sk.maturity]!=null?ORDER[sk.maturity]:9;
    if(key==='runs7d') return sk.runs7d||0;
    if(key==='flags') return sk.flags||0;
    if(key==='lastImproved') return sk.lastImproved?new Date(/T/.test(sk.lastImproved)?sk.lastImproved:sk.lastImproved+'T00:00:00Z').getTime():0;
    return 0;
  }
  function renderSkillTable(){
    var d=SK.data; if(!d) return;
    if(!$('skills-head')) return; // owner skills table removed in v5 — Skills tab owns the full list now
    var hasRuns=!!d.summary.hasRuns, hasDrift=!!d.summary.hasDrift;
    function hdr(key,label,cls){ var on=SK.sortKey===key; return '<th class="sortable'+(cls?' '+cls:'')+'" data-sk="'+key+'">'+label+' <span class="arr">'+(on?(SK.sortDir>0?'▲':'▼'):'')+'</span></th>'; }
    $('skills-head').innerHTML='<tr>'+hdr('name','Skill')+hdr('maturity','Maturity')+(hasRuns?hdr('runs7d','Runs 7d','num'):'')+hdr('flags','Flags','num')+hdr('lastImproved','Last improved')+'</tr>';
    var q=SK.q.toLowerCase().trim();
    // "Start here" strip: curated featured skills, shown only when the list
    // isn't being searched or filtered (so it's a starting point, not clutter).
    var sh=$('start-here');
    if(sh){
      var feat=(d.featured||[]);
      if(feat.length && !q && SK.maturity==='all' && SK.flags!=='flagged'){
        sh.className='start-here';
        sh.innerHTML='<div class="sh-label">Start here</div><div class="sh-grid">'+feat.map(function(f){
          return '<div class="sh-card"><div class="n">'+esc(f.name)+'</div><div class="d">'+esc((f.description||'').replace(/^["']\s*/,'').slice(0,90))+'</div></div>';
        }).join('')+'</div>';
      } else { sh.className='start-here hidden'; sh.innerHTML=''; }
    }
    var rows=(d.skills||[]).filter(function(sk){
      if(SK.maturity!=='all' && sk.maturity!==SK.maturity) return false;
      if(SK.flags==='flagged' && !(sk.flags>0)) return false;
      if(q && (sk.name||'').toLowerCase().indexOf(q)<0) return false;
      return true;
    });
    rows.sort(function(a,b){ var av=skillSortVal(a,SK.sortKey), bv=skillSortVal(b,SK.sortKey); if(av<bv)return -SK.sortDir; if(av>bv)return SK.sortDir; return (a.name||'').localeCompare(b.name||''); });
    var cols=hasRuns?5:4;
    $('skills-tbody').innerHTML = rows.length ? rows.map(function(sk){
      var drift=(hasDrift&&sk.drift===true)?'<span class="drift">⚠ differs from canonical</span>':'';
      var fc=sk.flags>0?'has':'zero';
      var r='<tr><td class="name">'+esc(sk.name)+drift+'</td><td><span class="pill '+esc(sk.maturity)+'">'+esc(sk.maturity)+'</span></td>';
      if(hasRuns) r+='<td class="num">'+(sk.runs7d||0)+'</td>';
      r+='<td class="num"><span class="flagcount '+fc+'">'+(sk.flags||0)+'</span></td>';
      r+='<td class="ago" title="'+esc(sk.lastImprovedBy||'')+'">'+ago(sk.lastImproved)+'</td></tr>';
      return r;
    }).join('') : '<tr><td class="empty" colspan="'+cols+'">'+((d.skills||[]).length?'No skills match these filters.':'No skills in this brain yet.')+'</td></tr>';
    var cnt=$('skill-count'); if(cnt) cnt.textContent=rows.length+' of '+((d.skills||[]).length)+' skills';
  }
  // Sortable headers + filter controls for the skills table.
  (function(){
    var h=$('skills-head');
    if(h) h.addEventListener('click',function(ev){ var th=ev.target.closest&&ev.target.closest('th[data-sk]'); if(!th)return; var k=th.getAttribute('data-sk'); if(SK.sortKey===k){SK.sortDir*=-1;}else{SK.sortKey=k;SK.sortDir=(k==='name'||k==='maturity')?1:-1;} renderSkillTable(); });
    var s=$('skill-search'); if(s) s.addEventListener('input',function(){SK.q=s.value;renderSkillTable();});
    var m=$('skill-maturity'); if(m) m.addEventListener('change',function(){SK.maturity=m.value;renderSkillTable();});
    var f=$('skill-flags'); if(f) f.addEventListener('change',function(){SK.flags=f.value;renderSkillTable();});
  })();

  // The team table comes from the SERVER (the source of truth), acting as the
  // member — not from the local roles.json. Shows roster + who's synced.
  // Owners and scouts get inline Edit (name + role) and Remove controls.
  // 'agency' (ClientBrain: agency staff inside a client brain, scout-level) is
  // offered only inside client brains; the server rejects it elsewhere.
  var ROSTER_ROLES=['owner','head-scout','scout','team','agency'];
  // Owner-only preview helper: ?as=team|scout|owner overrides the role used for
  // UI gating, so an owner can see exactly what a team member sees. UI-only —
  // the API still enforces real permissions, so this can't escalate anything.
  var DEV_ROLE_OVERRIDE=null;
  function uiRole(serverRole){ if(DEV_ROLE_OVERRIDE) return DEV_ROLE_OVERRIDE; var a=new URLSearchParams(location.search).get('as'); return (a&&['owner','head-scout','scout','team','agency'].indexOf(a)>=0)?a:serverRole; }
  var ICON_EDIT='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var ICON_TRASH='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  function roleOptions(sel){
    return ROSTER_ROLES.map(function(r){ return '<option value="'+r+'"'+(r===sel?' selected':'')+'>'+cap(r)+'</option>'; }).join('');
  }
  async function loadRoster(){
    var tb=$('team-tbody'), th=$('team-head');
    var head4='<tr><th>Name</th><th>Email</th><th>Role</th><th>Activity</th></tr>';
    try{
      var d=await api('/api/team-roster');
      if(d.unavailable || !d.members){
        th.innerHTML=head4;
        tb.innerHTML='<tr><td class="empty" colspan="4">It’s just you on this brain so far.</td></tr>';
        ROSTER=null; renderAll();
        return;
      }
      ROSTER=d.members||null; ROSTER_REQ=d.requester||null;
      if(d.team){
        SCOUT_SEATS = d.team.scoutSeats==null ? SCOUT_SEATS : Number(d.team.scoutSeats);
        PACKAGE_TIER = d.team.packageTier ? d.team.packageTier : PACKAGE_TIER;
      }
      // Role is server-authoritative. If it changed since login (config is
      // stale), the roster's requester.role is the truth — re-apply the view so
      // it switches without a re-login. uiRole() preserves a dev-switch/?as= override.
      var rr=uiRole(((d.requester&&d.requester.role)||'').toLowerCase());
      if(rr && rr!==CCROLE){
        CCROLE=rr;
        applyRoleTabs((d.requester&&d.requester.role)||'');
        $('who-role').textContent=(rr?cap(rr):'No role')+' view';
      }
      var canEdit=(rr==='owner'||rr==='scout'||rr==='head-scout');
      th.innerHTML='<tr><th>Name</th><th>Email</th><th>Role</th><th>Activity</th>'+(canEdit?'<th></th>':'')+'</tr>';
      SCOUT_COUNT=(d.members||[]).filter(function(m){return /scout/.test(String(m.role||''));}).length;
      // Seats used = owner + scout (the priced portal seats), what the N+1 cap counts.
      SEATS_USED=(d.members||[]).filter(function(m){return /owner|scout|head/.test(String(m.role||''));}).length;
      maybeBanner(); maybePortalNudge();
      var newestVer = newestRosterVersion();
      tb.innerHTML = d.members.length ? d.members.map(function(m){
        var stt = memberStatus(m);
        var synced = connDot(m) + ' <span class="st '+stt.cls+'">'+stt.label+'</span>'
          + (stt.sa ? ' <span class="ago" style="font-size:11px">'+agoFine(stt.sa)+'</span>'
             : (m.pendingClaim ? ' <span class="notsynced">pending</span>' : ''));
        var nudge = (canEdit && stt.cls!=='active') ? '<button class="mini" data-nudge="'+esc(m.slug)+'" data-email="'+esc(m.email)+'" data-name="'+esc(m.name||'')+'" data-role="'+esc(m.role||'')+'" title="Resend their invite">Nudge</button>' : '';
        var actions = canEdit ? '<td class="row-actions">'+nudge+'<button class="mini icon" data-act="edit" data-slug="'+esc(m.slug)+'" title="Edit name / role" aria-label="Edit">'+ICON_EDIT+'</button><button class="mini icon danger" data-act="remove" data-slug="'+esc(m.slug)+'" data-name="'+esc(m.name||m.email)+'" title="Remove from team" aria-label="Remove">'+ICON_TRASH+'</button></td>' : '';
        var bld = (/scout|owner|head/.test(String(m.role||'')) && hasShipped(m)) ? '<span class="tag-build" title="Has sharpened a skill">building</span>' : '';
        return '<tr data-slug="'+esc(m.slug)+'" data-name="'+esc(m.name||'')+'" data-role="'+esc(m.role)+'">'
          +'<td class="name">'+esc(m.name||m.email)+bld+verTag(m,newestVer)+'</td>'
          +'<td class="mut email" title="'+esc(m.email)+'">'+esc(m.email)+'</td>'
          +'<td class="role-cell">'+esc(m.role)+'</td>'
          +'<td>'+synced+'</td>'+actions+'</tr>';
      }).join('') : '<tr><td class="empty" colspan="'+(canEdit?5:4)+'">No members yet.</td></tr>';
      renderAll();
    }catch(e){ th.innerHTML=head4; tb.innerHTML='<tr><td class="empty" colspan="4">Couldn’t load the roster: '+esc(e.message)+'</td></tr>'; }
  }

  // Inline edit + remove, delegated off the roster body.
  (function(){
    var handler=function(ev){
      var btn=ev.target.closest && ev.target.closest('button[data-act]'); if(!btn) return;
      var act=btn.getAttribute('data-act'), slug=btn.getAttribute('data-slug'), tr=btn.closest('tr');
      if(!tr) return;
      if(act==='edit') return startEdit(tr);
      if(act==='cancel') return loadRoster();
      if(act==='save') return saveEdit(tr, slug);
      if(act==='remove') return removeMember(slug, btn.getAttribute('data-name'));
    };
    ['team-tbody','team-tbody-s'].forEach(function(id){ var tb=$(id); if(tb) tb.addEventListener('click', handler); });
  })();

  function startEdit(tr){
    var name=tr.getAttribute('data-name')||'', role=tr.getAttribute('data-role')||'team', tds=tr.children;
    tr.classList.add('row-edit');
    tds[0].innerHTML='<input class="edit-name" value="'+esc(name)+'" />';
    tds[2].innerHTML='<select class="edit-role">'+roleOptions(role)+'</select>';
    tds[4].innerHTML='<button class="mini save" data-act="save" data-slug="'+esc(tr.getAttribute('data-slug'))+'">Save</button><button class="mini" data-act="cancel">Cancel</button>';
    var i=tds[0].querySelector('input'); if(i){ i.focus(); i.select(); }
  }

  async function saveEdit(tr, slug){
    var name=((tr.querySelector('.edit-name')||{}).value||'').trim();
    var role=(tr.querySelector('.edit-role')||{}).value||'';
    var saveBtn=tr.querySelector('button[data-act="save"]');
    if(saveBtn){ saveBtn.disabled=true; saveBtn.textContent='Saving…'; }
    try{
      await api('/api/team-member-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberSlug:slug,name:name,role:role})});
      loadRoster();
    }catch(e){
      if(saveBtn){ saveBtn.disabled=false; saveBtn.textContent='Save'; }
      alert('Couldn’t save: '+e.message);
    }
  }

  async function removeMember(slug, name){
    if(!confirm('Remove '+(name||'this member')+' from the team? They lose access to the shared brain. This can’t be undone.')) return;
    try{
      await api('/api/team-member-remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberSlug:slug})});
      loadRoster();
    }catch(e){ alert('Couldn’t remove: '+e.message); }
  }

  // "Show the email they'll get" under each add-member form. Sending an invite
  // into a CLIENT brain puts a message in front of the client's own staff, so
  // the person sending it should be able to read it first, with no surprises
  // about who it appears to come from (2026-07-28 beta report). Fetched once,
  // lazily, from the API's own builder so it always matches what sends.
  (function(){
    var cache=null, inflight=null;
    function load(){
      if(cache) return Promise.resolve(cache);
      if(inflight) return inflight;
      inflight=api('/api/team-invite-preview').then(function(d){ cache=d; inflight=null; return d; });
      return inflight;
    }
    [['ip-toggle','ip-body','ip-from','ip-replyto','ip-subject','ip-text','invite-preview'],
     ['ip-toggle-s','ip-body-s','ip-from-s','ip-replyto-s','ip-subject-s','ip-text-s','invite-preview-s']].forEach(function(t){
      var toggle=$(t[0]); if(!toggle) return;
      toggle.addEventListener('click',function(){
        var body=$(t[1]); if(!body) return;
        var opening=body.hidden;
        body.hidden=!opening;
        toggle.setAttribute('aria-expanded', opening?'true':'false');
        toggle.textContent=opening?'Hide the email':'Show the email they’ll get';
        if(!opening) return;
        $(t[5]).textContent='Loading…';
        load().then(function(d){
          if(!d||d.unavailable||!d.subject){ $(t[5]).textContent='Couldn’t load the preview'+(d&&d.reason?': '+d.reason:'.'); return; }
          $(t[2]).textContent=d.fromName+' <'+d.fromEmail+'>';
          $(t[3]).textContent=d.replyTo||d.fromEmail;
          $(t[4]).textContent=d.subject;
          $(t[5]).textContent=d.body;
        }).catch(function(e){ $(t[5]).textContent='Couldn’t load the preview: '+e.message; });
      });
    });
  })();

  // add-member form. Visible "Sending…" state + a hard timeout so a click is
  // never silent, even if the server is slow warming up.
  (function(){
    // owner form + scout form (-s) share the same invite logic.
    [['af-send','af-name','af-email','af-role','af-status','add-form'],['af-send-s','af-name-s','af-email-s','af-role-s','af-status-s','add-form-s']].forEach(function(t){
      var send=$(t[0]); if(!send) return;
      send.addEventListener('click',function(){
        var name=$(t[1]).value.trim(), email=$(t[2]).value.trim(), role=$(t[3]).value, st=$(t[4]);
        if(!name||!email){ st.textContent='Name and email are both required.'; return; }
        send.disabled=true; send.textContent='Sending…';
        st.textContent='Warming up the server and sending the invite, this can take a few seconds…';
        var ctrl=new AbortController(), to=setTimeout(function(){ctrl.abort();},30000);
        api('/api/team-invite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,email:email,role:role}),signal:ctrl.signal})
          .then(function(d){
            $(t[1]).value=''; $(t[2]).value=''; loadRoster();
            // With a code to read, the message stays up: the email is the only
            // other carrier of the code, and spam filters eat it (2026-07-30).
            if(d&&d.code){ st.textContent='Invite emailed to '+email+'. Their code is '+d.code+'; if the email lands in spam, you can send them the code yourself.'; }
            else { st.textContent='Invite sent to '+email+'.'; setTimeout(function(){ $(t[5]).hidden=true; st.textContent=''; },1800); }
          })
          .catch(function(e){ st.textContent='Failed: '+(e.name==='AbortError'?'timed out — try again':e.message); })
          .then(function(){ clearTimeout(to); send.disabled=false; send.textContent='Send invite'; });
      });
    });
  })();

