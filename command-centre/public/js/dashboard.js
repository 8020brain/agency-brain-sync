'use strict';
  // ---- v5 owner/scout action surfaces ----------------------------------------
  // SCOUT_SEATS / PACKAGE_TIER come from the team's package (team-summary via
  // /api/team-roster; also /api/health if present). Null/0 until an admin links a
  // package, so the banner + plan card stay hidden until then. SCOUT_COUNT + ROSTER
  // are the live server roster. ME / ME_NAME identify the signed-in member.
  var CCROLE='', SCOUT_SEATS=0, SCOUT_COUNT=0, SEATS_USED=0, PACKAGE_TIER=null, RENEWAL=null;
  var ME='', ME_NAME='', ROSTER=null, ROSTER_REQ=null, TEAMSLUG='', CUR_BANNER_SIG='';
  // Session-only reveal: the "Show dismissed cards" link sets this true so the
  // dismissed/snoozed banners reappear until the next refresh (or until re-dismissed).
  var SHOW_DISMISSED=false;
  // Seats = owner + scout, capped at the package's scout count + 1 (the owner's
  // free seat + N scout seats). The banner + plan card display it in scout-seat
  // terms (owner's seat unnamed): scout seats used = max(0, owner+scout - 1).
  var NEXT_TIER={2:'5-scout',5:'10-scout'};
  var PKG_PRICE={'Solo':799,'Solo + coaching':999,'Team of 2':1199,'Team of 5':1995,'Team of 10':2995};
  function planLabel(t){ return ({'Team of 2':'+2 scouts','Team of 5':'+5 scouts','Team of 10':'+10 scouts'})[t]||t; }
  function ccRole(){ var r=CCROLE; return r==='head-scout'?'scout':r; }

  // Dismiss is keyed on team + scout-seat count, so the banner reappears if the
  // plan changes (an upgrade resets it), but stays gone within the same plan.
  function bannerDismissed(){ try{ return localStorage.getItem('ab-upsell-dismissed')===CUR_BANNER_SIG; }catch(e){ return false; } }
  function wireDismiss(btn, banner){
    if(!btn || btn.__wired) return; btn.__wired=true;
    btn.addEventListener('click', function(){ try{ localStorage.setItem('ab-upsell-dismissed', CUR_BANNER_SIG); }catch(e){} banner.hidden=true; SHOW_DISMISSED=false; updateDismissedToggle(); });
  }
  // The "Add Scouts" solo-owner card is dismissible, but the dismiss only snoozes
  // it for a week; it then reappears (still dismissible). A middle ground between
  // non-dismissible (nagged) and dismiss-forever (the old one got missed).
  var ADDSCOUTS_SNOOZE_MS=7*24*60*60*1000;
  function addScoutsSnoozed(){
    try{ var t=parseInt(localStorage.getItem('ab-addscouts-snooze')||'0',10); return !!t && (Date.now()-t)<ADDSCOUTS_SNOOZE_MS; }catch(e){ return false; }
  }
  function wireSnooze(btn, banner){
    if(!btn || btn.__wiredSnooze) return; btn.__wiredSnooze=true;
    btn.addEventListener('click', function(){ try{ localStorage.setItem('ab-addscouts-snooze', String(Date.now())); }catch(e){} banner.hidden=true; SHOW_DISMISSED=false; updateDismissedToggle(); });
  }
  // True when the current owner/scout has a card hidden by a dismiss/snooze that
  // the "Show dismissed cards" link could bring back.
  function anyCardDismissed(){
    var r=ccRole();
    if(r!=='owner' && r!=='scout') return false;
    var n=SCOUT_SEATS||0, used=Math.max(0,(SEATS_USED||0)-1), atCap=n>0&&used>=n;
    var bannerHidden = atCap ? bannerDismissed() : (r==='owner' && !n && addScoutsSnoozed());
    return !!bannerHidden || portalNudgeDismissed();
  }
  // The small "Show dismissed cards" link at the top of the active dashboard. Only
  // shows when something's hidden; clicking it reveals the cards for this session.
  function updateDismissedToggle(){
    var suffix=(ccRole()==='scout'?'-s':'-o');
    var wrap=$('dismissed-toggle'+suffix), link=$('show-dismissed'+suffix);
    if(!wrap||!link) return;
    if(!link.__wired){ link.__wired=true; link.addEventListener('click', function(e){ e.preventDefault(); SHOW_DISMISSED=true; maybeBanner(); maybePortalNudge(); }); }
    wrap.hidden = SHOW_DISMISSED || !anyCardDismissed();
  }
  function portalNudgeDismissed(){ try{ return localStorage.getItem('ab-portal-dismissed')==='1'; }catch(e){ return false; } }
  function maybePortalNudge(){
    // Members-portal access is owner+scout only (locked decision), so the nudge only
    // shows on those dashboards. Members-portal only for now — agency members aren't
    // auto-added to Circle, so no Circle line yet. Dismissible, remembered.
    var r=ccRole();
    var show=(r==='owner'||r==='scout') && (SHOW_DISMISSED || !portalNudgeDismissed());
    ['portal-nudge','portal-nudge-s'].forEach(function(id){ var el=$(id); if(el) el.hidden=!show; });
    [['portal-nudge-x','portal-nudge'],['portal-nudge-x-s','portal-nudge-s']].forEach(function(p){
      var btn=$(p[0]); if(btn && !btn.__wired){ btn.__wired=true; btn.addEventListener('click', function(){
        try{ localStorage.setItem('ab-portal-dismissed','1'); }catch(e){}
        ['portal-nudge','portal-nudge-s'].forEach(function(id){ var e2=$(id); if(e2) e2.hidden=true; });
        SHOW_DISMISSED=false; updateDismissedToggle();
      }); }
    });
    updateDismissedToggle();
  }
  function maybeBanner(){
    var r=ccRole(), n=SCOUT_SEATS||0;
    // Scout seats used = owner+scout minus the owner's free seat. The cap is the
    // package's N scout seats (a 2nd owner just uses one). We don't name the
    // owner's free seat — public framing stays "Team of N = N scout seats".
    var used=Math.max(0, (SEATS_USED||0)-1);
    var atCap=(r==='owner'||r==='scout') && n>0 && used>=n;
    CUR_BANNER_SIG=(TEAMSLUG||'')+':'+n;
    var show=atCap && (SHOW_DISMISSED || !bannerDismissed());
    var word=(n===2 ? 'Both scout seats' : 'All '+n+' scout seats');
    var ob=$('upsell-banner');
    if(ob){
      if(show && r==='owner'){
        // At-cap: nudge to the NEXT tier (5/10). No self-serve page for those yet, so email Mike.
        var next=NEXT_TIER[n]||'next';
        $('ub-h').textContent=word+' are in use.';
        $('ub-p').innerHTML='To add more scouts, email <a href="mailto:mike@mikerhodes.com.au">mike@mikerhodes.com.au</a> for a coupon — you only pay the difference up to the '+next+' plan.';
        $('ub-cta').href='mailto:mike@mikerhodes.com.au?subject=Agency%20Brain%20upgrade';
        $('ub-cta').textContent='Email Mike for a coupon';
        var ubxA=$('ub-x'); if(ubxA) ubxA.hidden=false;
        ob.hidden=false; wireDismiss(ubxA, ob);
      } else if(r==='owner' && !n && (SHOW_DISMISSED || !addScoutsSnoozed())){
        // Solo owner (no scout seats yet): self-serve Team-2 upgrade on the page —
        // direct pay, no emailing Mike. Dismissible, but the × only snoozes it for a
        // week, then it returns. (Non-dismissible nagged; the old dismiss-forever
        // banner got missed — owners couldn't find where to add a Scout.)
        $('ub-h').textContent='Add Scouts to your team — €300/yr.';
        $('ub-p').innerHTML='Make two of your team full members who can build and sharpen skills, not just use them. It\'s +€300/yr for 2 Scout seats (pro-rated to your renewal) and lifts your free Team cap from 5 to 10.';
        $('ub-cta').href='https://ads2ai.com/agency-brain/upgrade';
        $('ub-cta').textContent='Add Scouts';
        var ubxB=$('ub-x'); if(ubxB){ ubxB.hidden=false; ubxB.title='Snooze for a week'; wireSnooze(ubxB, ob); }
        ob.hidden=false;
      } else ob.hidden=true;
    }
    var sb=$('upsell-banner-s');
    if(sb){
      if(show && r==='scout'){
        $('ub-h-s').textContent=word+' are full.';
        $('ub-p-s').innerHTML='Want another scout on the team? Ask your owner to email <a href="mailto:mike@mikerhodes.com.au">mike@mikerhodes.com.au</a> for an upgrade coupon — they only pay the difference.';
        sb.hidden=false; wireDismiss($('ub-x-s'), sb);
      } else sb.hidden=true;
    }
  }

  // Join a roster member to their z-logs/team-usage/<self>.jsonl stats. log-usage
  // now keys usage by the slugified email local-part, one deterministic rule. The
  // three-key fallback below stays so the join also survives any older machine
  // that wrote under a name or a roles.json slug.
  function ccSlug(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''); }
  function memberUsage(m){
    if(!m) return null;
    var mu=(OBS&&OBS.milestones&&OBS.milestones.members)||{};
    return mu[m.slug] || mu[ccSlug(m.name)] || mu[ccSlug(String(m.email||'').split('@')[0])] || null;
  }
  // Did this member author a skill improvement since setup? (git author = name)
  function hasShipped(m){
    if(!OBS||!m) return false;
    var nm=String(m.name||'').toLowerCase();
    return (OBS.recentlyImproved||[]).some(function(s){ return String(s.lastImprovedBy||'').toLowerCase()===nm; });
  }

  // status of one roster member. Connection (lastSyncedAt heartbeat = app
  // running) is kept SEPARATE from contribution (lastContributedAt = actually
  // pushed authored content). active/quiet keys off CONTRIBUTION, so a machine
  // left running pulling everyone else's work never masquerades as active.
  //   not started — never connected
  //   installed   — connected but no authored contribution yet
  //   active      — contributed in the last 7 days
  //   quiet       — connected, but no contribution in 7+ days
  // sa = the contribution time (what the "ago" label shows).
  function memberStatus(m){
    var conn=m.lastSyncedAt||m.installCompletedAt;
    var contrib=m.lastContributedAt;
    if(!conn) return {cls:'dormant',label:'not started',sa:null,conn:null};
    if(!contrib) return {cls:'installed',label:'installed',sa:null,conn:conn};
    var days=Math.floor((Date.now()-new Date(contrib).getTime())/86400000);
    if(days>=7) return {cls:'quiet',label:'quiet',sa:contrib,conn:conn};
    return {cls:'active',label:'active',sa:contrib,conn:conn};
  }
  // Connection dot from the heartbeat. The watcher mints a token ~hourly, so
  // "online" allows 90 min of slack before we call a machine offline.
  function connDot(m){
    var c=m.lastSyncedAt; if(!c) return '';
    var mins=Math.floor((Date.now()-new Date(c).getTime())/60000);
    var on=mins<90;
    return '<span class="conn '+(on?'on':'off')+'" title="'+(on?'App online':'App last seen '+agoFine(c))+'">●</span>';
  }
  // Per-member Command Centre version. Flagged when behind the newest version
  // anyone on the roster is running — usually means "quit and reopen to update".
  function cmpVer(a,b){var pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);for(var i=0;i<Math.max(pa.length,pb.length);i++){var x=pa[i]||0,y=pb[i]||0;if(x!==y)return x<y?-1:1;}return 0;}
  function newestRosterVersion(){var v=null;(ROSTER||[]).forEach(function(m){if(m.appVersion&&(!v||cmpVer(m.appVersion,v)>0))v=m.appVersion;});return v;}
  function verTag(m,newest){
    if(!m.appVersion) return '';
    var behind = newest && cmpVer(m.appVersion,newest)<0;
    var title = behind ? 'Behind v'+esc(newest)+' — quit and reopen to update' : 'Command Centre version';
    return ' <span class="ver'+(behind?' behind':'')+'" title="'+title+'">v'+esc(m.appVersion)+'</span>';
  }
  function rosterBuckets(){
    var notStarted=[], quiet=[];
    (ROSTER||[]).forEach(function(m){ var s=memberStatus(m); if(s.cls==='dormant') notStarted.push(m); else if(s.cls==='quiet') quiet.push(m); });
    return {notStarted:notStarted, quiet:quiet};
  }

  // Called whenever OBS or ROSTER changes; each sub-render guards on its own data.
  // The scout Dashboard reuses the owner's roster, maturity and integrity views
  // (rendered into owner-view IDs). Copy them into the scout-view -s copies so a
  // scout sees Who's-in + the charts too, without duplicating the render logic.
  function mirrorRoster(){
    [['team-tbody','team-tbody-s'],['team-head','team-head-s'],['owner-maturity','owner-maturity-s'],['owner-integrity','owner-integrity-s'],['owner-progress','owner-progress-s']]
      .forEach(function(p){ var src=$(p[0]), dst=$(p[1]); if(src&&dst){ dst.innerHTML=src.innerHTML; dst.hidden=src.hidden; } });
  }

  // Agency progress = the value journey (customised → first client → first skill
  // sharpened → a skill trusted), each derived from the synced repo. The headline
  // that turns "everyone synced" into "here's how far the agency actually got".
  function renderAgencyProgress(){
    var el=$('owner-progress'); if(!el) return;
    var ms=(OBS&&OBS.milestones&&OBS.milestones.agency)||[];
    if(!ms.length){ el.hidden=true; return; }
    el.hidden=false;
    var doneCount=ms.filter(function(m){return m.done;}).length;
    var nextIdx=-1; for(var i=0;i<ms.length;i++){ if(!ms[i].done){ nextIdx=i; break; } }
    var steps=ms.map(function(m,i){
      var state=m.done?'done':(i===nextIdx?'next':'todo');
      var mark=m.done?'✓':String(i+1);
      return '<div class="ap-step '+state+'"><span class="ap-mark">'+mark+'</span>'
        +'<div class="ap-body"><div class="ap-label">'+esc(m.label)+'</div>'
        +'<div class="ap-detail">'+esc(m.detail||'')+'</div></div></div>';
    }).join('');
    var next = (nextIdx>=0)
      ? '<div class="ap-next"><strong>Next:</strong> '+esc(ms[nextIdx].action||ms[nextIdx].label)+'</div>'
      : '<div class="ap-next all-done">All four milestones reached — your agency brain is fully up and running.</div>';
    el.innerHTML='<div class="ap-card"><div class="ap-head"><span class="ap-eyebrow">Agency progress</span>'
      +'<span class="ap-count">'+doneCount+' of '+ms.length+'</span></div>'
      +'<div class="ap-steps">'+steps+'</div>'+next+'</div>';
  }
  function renderAll(){ renderOwnerView(); renderAgencyProgress(); renderOwnerPlan(); renderScoutView(); renderVerdicts(); renderGetGoing(); maybeBanner(); maybePortalNudge(); renderStartHere(CCROLE==='team'); if(CCROLE==='scout') renderFeedback(); mirrorRoster(); }

  function renderOwnerView(){
    if(!OBS) return;
    var s=OBS.summary, md=s.maturityDist||{};
    var mm=$('owner-maturity');
    if(mm) mm.innerHTML=[['draft','Draft'],['live','Live'],['trusted','Trusted']].map(function(p){
      return '<div class="m '+p[0]+'"><div class="n">'+(md[p[0]]||0)+'</div><div class="k">'+p[1]+'</div></div>';
    }).join('');
    var ig=$('owner-integrity'); if(ig) ig.innerHTML=buildIntegrity(OBS);
    var sb=$('scouts-built');
    if(sb){
      var ri=(OBS.recentlyImproved||[]).slice(0,6);
      sb.innerHTML = ri.length ? ri.map(function(x){
        return '<div class="built-row"><span class="who">'+esc(x.lastImprovedBy||'someone')+'</span> improved <b>'+esc(x.name)+'</b> <span class="when">'+ago(x.lastImproved)+'</span></div>';
      }).join('') : '<p class="empty">Nothing improved in the last 30 days yet. When a scout sharpens a skill, it shows up here.</p>';
    }
  }

  function renderOwnerPlan(){
    var card=$('owner-plan-card'), box=$('owner-plan'), note=$('owner-plan-note');
    if(!card||!box) return;
    if(!PACKAGE_TIER){ card.hidden=true; return; } // no package linked yet (null or "")
    card.hidden=false;
    // Scout seats consumed = owner+scout minus the owner's free seat (a 2nd
    // owner uses a scout seat). Matches the banner's at-cap math.
    var seats=SCOUT_SEATS||0, used=Math.max(0,(SEATS_USED||0)-1), full=seats>0 && used>=seats, price=PKG_PRICE[PACKAGE_TIER];
    if(note) note.textContent=full?'scout seats full':'';
    var h=[];
    h.push('<div class="bill-row"><span class="k">Plan</span><span class="v">'+esc(planLabel(PACKAGE_TIER))+(price?(' · €'+price.toLocaleString()+'/yr'):'')+'</span></div>');
    if(seats>0){
      h.push('<div class="bill-row"><span class="k">Scout seats</span><span class="v'+(full?' cap':'')+'">'+used+' of '+seats+' used'+(full?' · full':'')+'</span></div>');
      h.push('<div class="seatbar"><i style="width:'+Math.min(100,Math.round(used/seats*100))+'%"></i></div>');
    } else {
      h.push('<div class="bill-row"><span class="k">Scouts</span><span class="v">none on this plan</span></div>');
    }
    h.push('<div class="bill-row"><span class="k">Team members</span><span class="v">unlimited</span></div>');
    if(RENEWAL) h.push('<div class="bill-row"><span class="k">Next renewal</span><span class="v">'+esc(RENEWAL)+'</span></div>');
    if(full) h.push('<div class="plan-cta"><a class="btn ghost sm" href="mailto:mike@mikerhodes.com.au?subject=Agency%20Brain%20upgrade">Add more scouts</a></div>');
    box.innerHTML=h.join('');
  }

  // Promotion candidates (interim, runs-blocked): a DRAFT skill with zero flags
  // that has settled for a week is ready for the draft→live bump. We deliberately
  // do NOT suggest live→trusted here — that needs run evidence (how often it's
  // used, across how many clients), which doesn't exist until session logging
  // ships. So "stable + unflagged" only earns the first promotion, not the second.
  function promotionCandidates(){
    return ((OBS&&OBS.skills)||[]).filter(function(sk){
      return sk.maturity==='draft' && (sk.flags||0)===0 && sk.daysStale!=null && sk.daysStale>=7;
    }).sort(function(a,b){ return (b.daysStale||0)-(a.daysStale||0); });
  }

  var FIXQ=[];
  function renderScoutView(){
    if(!OBS) return;
    var s=OBS.summary;
    // fix queue — client-tagged float to the top, then most recent.
    FIXQ=(OBS.flagEntries||[]).slice().sort(function(a,b){
      var ac=a.client?0:1, bc=b.client?0:1; if(ac!==bc) return ac-bc;
      return (b.flaggedAt||'').localeCompare(a.flaggedAt||'');
    });
    var fq=$('fix-queue');
    if(fq) fq.innerHTML = FIXQ.length ? FIXQ.map(function(f,i){
      var badge=f.client?'<span class="impact">Client · '+esc(f.client)+'</span>':'';
      var meta=[f.flaggedBy&&('flagged by '+f.flaggedBy), f.flaggedAt&&ago(f.flaggedAt)].filter(Boolean).map(esc).join(' · ');
      var body=(f.body||'').replace(/^##\s+/gm,'').trim(); // strip markdown headers from the flag entry
      return '<div class="work"><div class="wh">'+badge+'<h4>'+esc(f.skill)+'</h4></div>'
        +(meta?'<div class="meta">'+meta+'</div>':'')
        +(body?'<p>'+esc(body)+'</p>':'')
        +'<div class="act"><button class="btn sm" data-fix="'+i+'">Open in Claude to fix</button></div></div>';
    }).join('') : '<p class="empty">Nothing flagged right now. When the team runs <code>/flag-skill</code>, it lands here — the client-tagged ones first, so the widest-reaching fix is on top.</p>';

    var allCands=promotionCandidates(), cands=allCands.slice(0,6);
    var pr=$('promotions');
    if(pr) pr.innerHTML = cands.length ? (cands.map(function(sk){
      var wks=Math.floor((sk.daysStale||0)/7);
      var ev='stable '+(wks>=1?(wks+' week'+(wks===1?'':'s')):((sk.daysStale)+' days'))+' · 0 flags';
      return '<div class="promo"><div class="pi"><span class="nm">'+esc(sk.name)+'</span> <span class="pill '+esc(sk.maturity)+'">'+esc(sk.maturity)+'</span><div class="ev">'+ev+'</div></div><span class="st quiet">ready for Live</span></div>';
    }).join('') + (allCands.length>cands.length?'<p class="mut" style="margin:10px 0 0;font-size:12px">+'+(allCands.length-cands.length)+' more ready for Live</p>':''))
      : '<p class="empty">No draft skills are ready to promote yet. A draft shows up here once it has held steady for a week with no flags — the cue to take it live.</p>';

    var openF=s.openFlags||0, sk2=$('scout-kpis');
    if(sk2){
      var k=function(n,l){return '<div class="kpi"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>';};
      sk2.innerHTML=k(openF,'Flag'+(openF===1?'':'s')+' waiting on you')+k(allCands.length,'Ready to promote');
    }
    renderYourMonth();
  }

  function renderYourMonth(){
    var box=$('your-month'); if(!box||!OBS) return;
    var me=ME_NAME, meLocal=(ME||'').split('@')[0];
    var mine=(OBS.recentlyImproved||[]).filter(function(x){
      var by=(x.lastImprovedBy||'').toLowerCase();
      return by && (by===me || (me&&by.indexOf(me)>=0) || (meLocal&&by.indexOf(meLocal)>=0));
    });
    box.innerHTML='<b>'+mine.length+'</b> skill'+(mine.length===1?'':'s')+' improved by you in the last 30 days.'
      +(mine.length?' <span class="mut">('+mine.slice(0,4).map(function(x){return esc(x.name);}).join(', ')+')</span>':' Flag-fixes and tweaks you commit show up here.');
  }

  function renderVerdicts(){
    var ov=$('owner-verdict');
    if(ov){
      if(!ROSTER){ ov.hidden=true; }
      else{
        var b=rosterBuckets();
        if(b.notStarted.length){
          var m=b.notStarted[0], fn=esc((m.name||m.email).split(' ')[0]);
          ov.className='verdict amber'; ov.hidden=false;
          ov.innerHTML='<span class="dot"></span><div>'
            +'<div class="vh">'+(b.notStarted.length===1?'One teammate hasn’t started yet.':b.notStarted.length+' teammates haven’t started yet.')+'</div>'
            +'<div class="vp"><b>'+esc(m.name||m.email)+'</b> hasn’t opened the brain. A nudge from you lands harder than one from anyone else.</div>'
            +'<div class="vact"><button class="btn" data-nudge="'+esc(m.slug||'')+'" data-email="'+esc(m.email)+'" data-name="'+esc(m.name||'')+'" data-role="'+esc(m.role||'')+'">Resend invite to '+fn+'</button></div></div>';
        } else {
          ov.className='verdict'; ov.hidden=false;
          ov.innerHTML='<span class="dot"></span><div><div class="vh">Everyone’s on the brain.</div><div class="vp">Your whole team has connected. Nothing needs you right now.</div></div>';
        }
      }
    }
    var sv=$('scout-verdict');
    if(sv && OBS){
      var s=OBS.summary, flags=s.openFlags||0, cands=promotionCandidates().length;
      var go=ROSTER?rosterBuckets():{notStarted:[],quiet:[]}, nGo=go.notStarted.length+go.quiet.length;
      var parts=[flags+' flag'+(flags===1?'':'s')+' to fix', cands+' to promote', nGo+' to get going'];
      var lead;
      if(flags>0){ var top=(OBS.flagEntries||[]).filter(function(f){return f.client;})[0]||(OBS.flagEntries||[])[0];
        lead='Start with the flag'+(top&&top.client?(' on <b>'+esc(top.skill)+'</b> (client: '+esc(top.client)+'), so the fix lands widest'):'')+'.'; }
      else if(cands>0){ lead='No flags waiting. '+cands+' skill'+(cands===1?'':'s')+' look ready for a maturity bump.'; }
      else { lead='Nothing urgent. Keep an eye on the flag queue and the team.'; }
      sv.className='verdict'+(flags>0?' amber':''); sv.hidden=false;
      sv.innerHTML='<span class="dot"></span><div><div class="vh">Today: '+parts.join(' · ')+'.</div><div class="vp">'+lead+'</div></div>';
    } else if(sv){ sv.hidden=true; }
  }

  function renderGetGoing(){
    var box=$('get-going'); if(!box) return;
    if(!ROSTER){ box.innerHTML='<p class="empty">The roster loads once you’re signed in to a team.</p>'; return; }
    var b=rosterBuckets();
    var rows=b.notStarted.map(function(m){return {m:m,why:'invited, never connected'};})
      .concat(b.quiet.map(function(m){return {m:m,why:'quiet for over a week'};}));
    box.innerHTML = rows.length ? '<table><tbody>'+rows.map(function(r){
      return '<tr><td class="name">'+esc(r.m.name||r.m.email)+'</td><td class="mut" style="color:var(--muted)">'+esc(r.why)+'</td><td class="row-actions"><button class="btn sm mut" data-nudge="'+esc(r.m.slug||'')+'" data-email="'+esc(r.m.email)+'" data-name="'+esc(r.m.name||'')+'" data-role="'+esc(r.m.role||'')+'">Resend</button></td></tr>';
    }).join('')+'</tbody></table>' : '<p class="empty">Everyone’s active. Nobody needs unsticking right now.</p>';
  }

