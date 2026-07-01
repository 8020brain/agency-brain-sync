'use strict';
  // Dispatch a task to Claude the way members actually work: copy a ready-made
  // prompt and point them at their brain folder in Cowork / the Claude desktop
  // app. No Node, no command-line tool — the old CLI-terminal spawn needed both,
  // which a fresh member machine doesn't have (decision 2026-05-25).
  var CW_PROMPT='';
  function dispatchToCowork(prompt){
    CW_PROMPT=prompt;
    try{ navigator.clipboard.writeText(prompt); }catch(e){}
    var ov=$('cw-overlay'); if(ov) ov.hidden=false;
  }
  (function(){
    var ov=$('cw-overlay'); if(!ov) return;
    var close=function(){ ov.hidden=true; };
    $('cw-done').addEventListener('click',close);
    ov.addEventListener('click',function(e){ if(e.target===ov) close(); });
    $('cw-copy').addEventListener('click',function(){ try{ navigator.clipboard.writeText(CW_PROMPT); }catch(e){} var b=$('cw-copy'); b.textContent='Copied'; setTimeout(function(){ b.textContent='Copy again'; },1400); });
    var ob=$('cw-open');
    if(window.agencyBrain && window.agencyBrain.launchClaudeApp){
      ob.addEventListener('click',function(){ window.agencyBrain.launchClaudeApp(); });
    } else if(ob){ ob.hidden=true; } // no Electron bridge (plain browser) → no launch button
  })();

  // Fix-queue "Open in Claude to fix" → copy the fix prompt + open Claude.
  (function(){
    var fq=$('fix-queue'); if(!fq) return;
    fq.addEventListener('click',function(ev){
      var b=ev.target.closest&&ev.target.closest('button[data-fix]'); if(!b) return;
      var f=FIXQ[Number(b.getAttribute('data-fix'))]; if(!f) return;
      var prompt='A teammate flagged the "'+f.skill+'" skill'+(f.client?(' (client: '+f.client+')'):'')+'. Their note:\n\n'+(f.body||'(no detail given)')+'\n\nOpen .claude/skills/'+f.skill+'/SKILL.md, work out what went wrong, and fix it. Your agency brain folder is your working directory.';
      dispatchToCowork(prompt);
      var orig=b.textContent; b.textContent='Copied — paste into Claude'; setTimeout(function(){ b.textContent=orig; },2400);
    });
  })();

  // Nudge / Resend (owner verdict + roster + scout get-going) → re-send the
  // member's invite via the server (owner/scout only; enforced server-side).
  document.addEventListener('click',function(ev){
    var b=ev.target.closest&&ev.target.closest('button[data-nudge]'); if(!b) return;
    var email=b.getAttribute('data-email'), slug=b.getAttribute('data-nudge');
    var name=b.getAttribute('data-name')||'', role=b.getAttribute('data-role')||''; if(!email) return;
    var orig=b.textContent; b.disabled=true; b.textContent='Sending…';
    api('/api/team-resend-invite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,memberSlug:slug,name:name,role:role})})
      .then(function(){ b.textContent='Invite resent'; })
      .catch(function(e){ b.disabled=false; b.textContent=orig; alert('Couldn’t resend: '+e.message); });
  });

  loadHealth();
  loadRoster();
  loadObservability();
  setInterval(function(){ loadObservability(); loadRoster(); },30000);

  // ===== Get set up page + team-only Start here strip + scout Feedback inbox (2026-05-25) =====
  // NOTE: these MUST stay inside the IIFE — they call esc/ago/$/api/activateView/OBS/CCROLE,
  // which are scoped to this IIFE. Defined outside it (v0.8.34) they threw ReferenceError
  // inside applyRoleTabs, which aborted before un-hiding the Google Ads panels (blank page).
  function renderStartHere(isTeam){
    var sh=$('start-here'); if(!sh) return;
    var feat=(OBS&&OBS.featured)||[];
    if(isTeam && feat.length){
      sh.className='start-here';
      sh.innerHTML='<div class="sh-label">Start here</div><div class="sh-sub">New to the brain? These are great first skills to try.</div><div class="sh-grid">'
        +feat.map(function(f){ return '<div class="sh-card" data-skill="'+esc(f.name)+'" role="button" tabindex="0"><div class="n">'+esc(f.name)+'</div><div class="d">'+esc((f.description||'').replace(/^["']\s*/,'').slice(0,80))+'</div></div>'; }).join('')+'</div>';
      // Clicking a card opens that skill's detail below (the cards used to be dead).
      if(!sh.__wired){ sh.__wired=true; sh.addEventListener('click',function(ev){
        var c=ev.target.closest&&ev.target.closest('.sh-card[data-skill]'); if(!c) return;
        var name=c.getAttribute('data-skill');
        if(window.__skillDetail) window.__skillDetail(name);
      }); }
    } else { sh.className='start-here hidden'; sh.innerHTML=''; }
  }
  function renderFeedback(){
    var box=$('fb-open'), n=$('fb-open-n'); if(!box) return;
    var fl=((OBS&&OBS.flagEntries)||[]).slice().sort(function(a,b){ var ac=a.client?0:1, bc=b.client?0:1; if(ac!==bc) return ac-bc; return (b.flaggedAt||'').localeCompare(a.flaggedAt||''); });
    if(n) n.textContent=fl.length?(fl.length+' waiting on you'):'';
    box.innerHTML = fl.length ? fl.map(function(f){
      var meta=[f.client&&('client: '+f.client), f.flaggedBy&&('flagged by '+f.flaggedBy), f.flaggedAt&&ago(f.flaggedAt)].filter(Boolean).map(esc).join(' · ');
      var body=(f.body||'').replace(/^##\s+/gm,'').trim();
      return '<div class="work"><div class="wh"><h4>'+esc(f.skill)+'</h4></div>'+(meta?'<div class="meta">'+meta+'</div>':'')+(body?'<p>'+esc(body)+'</p>':'')
        +'<div class="act"><button class="btn sm" data-fbfix="1" data-skill="'+esc(f.skill)+'" data-client="'+esc(f.client||'')+'" data-body="'+esc(body)+'">Open in Claude to fix</button></div></div>';
    }).join('') : '<p class="empty">No open flags. When the team runs <code>/flag-skill</code>, it lands here.</p>';
  }
  var GUIDES={
    'g-start':{html:'<h2>Start here (orientation)</h2><p class="gp-path">docs/scout-guide/00-start-here.md</p>'
      +'<p>Agency Brain is one shared folder your whole agency runs with Claude. Everyone\'s copy stays in sync automatically, so the skills you build and the client context you write are instantly available to the whole team.</p>'
      +'<h3>The three roles</h3><ul><li><b>Owner</b> sets direction, owns billing, and can keep a separate private space for owner-only docs.</li><li><b>Scout</b> (you) builds the skills the team uses and onboards people.</li><li><b>Team</b> uses the skills. They read everywhere and write only inside their own personal folder.</li></ul>'
      +'<h3>Your job in one line</h3><p>You\'re the explainer, not the installer. You never touch a teammate\'s machine. You add people in the portal, tell them what to expect, build skills, and help when someone gets stuck.</p>'},
    'g-claudemd':{html:'<h2>Setting up your CLAUDE.md files</h2><p class="gp-path">docs/scout-guide/your-claude-md.md</p>'
      +'<p><code>CLAUDE.md</code> is how you tell Claude how your agency works. Claude reads it automatically at the start of every session in this folder. There are three levels, and they stack.</p>'
      +'<h3>1. The shared agency CLAUDE.md</h3><p>The root file is the one everyone shares: who you are, services, clients, tools, voice, working preferences. Change it and sync, and every teammate picks it up within about a minute. Fill the placeholders by running the <code>/agency-brain-context-setup</code> prompt in Claude Code. You have write access; team members don\'t.</p>'
      +'<h3>2. Your personal CLAUDE.md</h3><p>You get <code>personal/&lt;you&gt;/CLAUDE.md</code> for how you like to work. <code>/agency-team-join</code> seeds it. Everyone can see your personal folder, so keep anything truly private out of it.</p>'
      +'<h3>3. Subfolder CLAUDE.md files</h3><p>A <code>clients/acme/CLAUDE.md</code> carries that client\'s tone and rules. Client-specific rules belong with the client, not the root file.</p>'},
    'g-creating':{html:'<h2>Creating skills for your team</h2><p class="gp-path">docs/scout-guide/creating-skills.md</p>'
      +'<p>A skill is a repeatable job your team runs by name: a markdown file at <code>.claude/skills/&lt;name&gt;/SKILL.md</code>. When a skill gets something wrong, you fix the markdown.</p>'
      +'<h3>Find one worth building</h3><p>Watch for repetition: a monthly report, an audit, the questions you ask every new client. Start with one that\'s painful and frequent.</p>'
      +'<h3>Build it with /skill-creator</h3><p>Run <code>/skill-creator</code> and describe what you want. It interviews you, then writes the <code>SKILL.md</code>. Learn by reading <code>client-setup</code> and <code>agency-meeting-prep</code>.</p>'
      +'<h3>Start at draft</h3><pre>---\nname: client-monthly-review\nmaturity: draft\n---</pre><p>Run it on real work, fix what comes out wrong, and move it to <code>live</code> only when it behaves.</p>'},
    'g-sharing':{html:'<h2>Sharing a skill with your team</h2><p class="gp-path">docs/scout-guide/sharing-skills.md</p>'
      +'<p>No publish button, no install step. A skill lives in the shared brain, so the moment it syncs, every teammate has it. The synced folder is the catalogue.</p>'
      +'<h3>How it reaches them</h3><ol><li>Build or improve the skill.</li><li>Run <code>/save</code>; it pulls team changes, shows what you changed, commits and pushes.</li><li>Every teammate pulls within about a minute. They run it by name.</li></ol>'
      +'<h3>Set maturity to say it\'s ready</h3><p><code>draft</code> = still building. <code>live</code> = works. <code>trusted</code> = you vouch for it. Flip the field and <code>/save</code>.</p>'
      +'<h3>The feedback loop</h3><p>Teammates flag with <code>/flag-skill</code>; the flag lands where you\'ll see it. Fix, save, the better version reaches everyone.</p>'},
    'g-onboard':{html:'<h2>Onboarding your team</h2><p class="gp-path">docs/scout-guide/onboarding-your-team.md</p>'
      +'<p>You add people from your <b>Dashboard</b> (Add member): name, email, role. That registers their email and emails them an invite. You can add team members, other scouts, even the owner.</p>'
      +'<h3>How they get in</h3><ul><li>They download Agency Brain from <code>ads2ai.com/downloads</code> and install it.</li><li>They open it and <b>sign in with their email</b> (a 6-digit code by email), and it finds the agency you added them to. No invite code needed.</li><li>If they have the invite code from the email, they can paste that instead. Either way works.</li></ul><p>There is no GitHub step for them. The agency owns the GitHub side; they borrow access transparently.</p>'
      +'<h3>If they already use a personal 8020brain</h3><p>Fresh install. Don\'t merge. Two folders, two purposes, leave the personal one alone.</p>'},
    'g-trouble':{html:'<h2>Troubleshooting</h2><p class="gp-path">docs/scout-guide/troubleshooting.md</p>'
      +'<h3>Common stuck points</h3><ol><li><b>Icon stays grey.</b> Re-run the wizard from the app menu.</li><li><b>Can\'t find the invite email.</b> Check spam, or resend from the portal.</li><li><b>"Git is not installed" (Windows).</b> Point them at git-scm.com.</li><li><b>Cowork can\'t see files.</b> Wrong folder; the app menu shows the watched path.</li><li><b>Icon went red.</b> A conflict; use "Discard my changes".</li></ol>'
      +'<h3>Two real gotchas</h3><ul><li><b>Windows clone never pushes</b> if it had no git identity. Newer app versions self-heal on launch.</li><li><b>Smart Start first-run toast on Mac</b> is benign: click Allow on the OS pop-up, then run it again.</li></ul>'},
    'g-owner-setup':{html:'<h2>Owner setup walkthrough</h2><p class="gp-path">onboarding-owner.md</p>'
      +'<p>If you\'re setting the brain up yourself rather than handing it to a scout, this is the path.</p>'
      +'<ol><li><b>Create the brain.</b> The portal creates your agency\'s GitHub repo from the template when you set up; you don\'t do this by hand.</li><li><b>Install the Agency Brain app</b> from the link in your email and let it clone the brain to your machine.</li><li><b>Connect Cowork</b> by pointing it at the folder the app keeps in sync.</li><li><b>Fill your agency context</b> with the tune-brain prompt or <code>/agency-brain-context-setup</code>.</li><li><b>Add your people</b> in the portal: scouts first, then team.</li></ol>'
      +'<p>You don\'t have to do any of this yourself. Add a scout and hand them steps 2 to 5.</p>'},
    'g-private':{html:'<h2>Your owner-private brain</h2><p class="gp-path">github.com/8020brain/agency-brain-personal-template</p>'
      +'<p>The shared agency brain is visible to your whole team. Anything that should never be (financials, salaries, contractor rates, sensitive client notes, strategy) goes in a separate <b>owner-private repo</b> that only you can see and that never syncs to the team.</p>'
      +'<h3>Set it up once</h3><p>Use the <b>Copy a prompt</b> button above, or start the public template <code>8020brain/agency-brain-personal-template</code> yourself (its <b>Use this template</b> button, or <code>gh repo create &lt;my-agency&gt;-private --private --template 8020brain/agency-brain-personal-template --clone</code>). Clone it to its own folder, next to the shared brain, never inside it.</p>'
      +'<h3>What it gives you</h3><ul><li><b>CLAUDE.md</b> at the root: explains this is your confidential space and what stays private versus shared. Rewrite it for your agency.</li><li><b>team/</b>: a board.md of who reports to you, a one-on-ones/ folder (one file per direct report for review notes), and room for comp and salary.</li><li><b>business/</b>: formation documents, contracts, partnerships, strategy.</li><li><b>finances/</b>: revenue, costs, rates, margins, forecasts.</li></ul>'
      +'<h3>How you use it</h3><p>Point a Claude Code or Cowork session at that folder when you\'re working on owner-only things. It never syncs to the team, so nothing in it can leak into the shared brain, and you never copy private numbers back into the shared brain.</p>'}
  };
  // Owner-voiced orientation + onboarding. (These used to alias the SCOUT guides,
  // so an owner's "Orient" opened "Scout (you) builds the skills…" — wrong reader.)
  GUIDES['g-start-o']={html:'<h2>Start here (orientation)</h2><p class="gp-path">onboarding-owner.md</p>'
    +'<p>Agency Brain is one shared folder your whole agency runs with Claude. Everyone\'s copy stays in sync automatically, so the skills your team builds and the client context you write are instantly available to the whole agency.</p>'
    +'<h3>The three roles</h3><ul><li><b>Owner</b> (you) sets direction, owns billing, and keeps a separate private space for owner-only docs. You decide what\'s shared and what stays private.</li><li><b>Scout</b> builds the skills the team uses and onboards people. Be your own scout, or add one at step 4.</li><li><b>Team</b> uses the skills. They read everywhere and write only inside their own personal folder.</li></ul>'
    +'<h3>Your job in one line</h3><p>Set direction, decide what\'s private, and watch the brain mature. You never have to touch a terminal: do the hands-on setup yourself with the guides here, or add a scout at step 4 and hand them steps 1 to 3.</p>'};
  GUIDES['g-onboard-o']={html:'<h2>Bringing your people on</h2><p class="gp-path">onboarding-owner.md</p>'
    +'<p>You add people from your <b>Dashboard</b> (Add member): name, email, role. That registers their email and sends them an invite. Add your scout first (they build the skills), then your team.</p>'
    +'<h3>How they get in</h3><ul><li>They download Agency Brain from <code>ads2ai.com/downloads</code> and install it.</li><li>They open it and <b>sign in with their own email</b> (a 6-digit code), and it finds the agency you added them to. No invite code, no GitHub account.</li></ul><p>The agency owns the GitHub side; your people borrow access transparently, so there\'s no GitHub step for them.</p>'
    +'<h3>Scouts vs Team</h3><p>Scouts are full A2AI members who build and edit skills (a paid seat). Team members use the brain in the app and are free up to your plan\'s cap. Add a scout when you want someone building; add team when you want people using what\'s built.</p>'};
  // Pre-June-release bridge (remove after the June release ships). The gads-proxy
  // skill isn't in members' brains until June, so until 2026-06-04 the Google Ads
  // tab points owners/scouts at the members portal to grab the skill zip first.
  // On/after June 4 it leaves the normal "just say it" instruction in place.
  (function(){
    if(new Date() >= new Date('2026-06-04')) return;
    var el=document.getElementById('gp-proxy-intro');
    if(!el) return;
    el.innerHTML='<b>First, get the skill.</b> The <code>gads-proxy</code> skill ships to every brain in the June release; until then, grab it: go to <a href="https://m.ads2ai.com/skills" target="_blank" rel="noopener">m.ads2ai.com/skills</a>, scroll to the bottom, and download <b>gads-proxy.zip</b>. Unzip the <code>gads-proxy</code> folder into your brain\'s <code>.claude/skills/</code> folder. <b>Then</b> open your brain and say <b>"set up the Google Ads proxy"</b> &mdash; it deploys a small Cloudflare Worker that holds the agency\'s Google Ads credentials and hands you back the Worker URL and a gate token. You set the URL here once (it syncs to your team); each member only ever holds the revocable gate token, never the credentials.';
  })();
  function closeGuides(except){ document.querySelectorAll('.guide-panel.open').forEach(function(p){ if(p.id!==except) p.classList.remove('open'); }); }
  document.addEventListener('click',function(ev){
    var t=ev.target;
    var gb=t.closest&&t.closest('[data-guide]');
    if(gb){ var id=gb.getAttribute('data-guide'), panel=$(id); if(panel){ var open=panel.classList.contains('open'); closeGuides(id); if(!open){ panel.innerHTML=(GUIDES[id]||{}).html||'<p>(guide)</p>'; panel.classList.add('open'); panel.scrollIntoView({behavior:'smooth',block:'nearest'}); } else panel.classList.remove('open'); } return; }
    var ext=t.closest&&t.closest('[data-ext]'); if(ext){ ev.preventDefault(); var u=ext.getAttribute('data-ext'); if(/^https?:/.test(u)) window.open(u,'_blank'); return; }
    var gob=t.closest&&t.closest('[data-go]'); if(gob){ activateView(gob.getAttribute('data-go')); window.scrollTo({top:0,behavior:'smooth'}); return; }
    // Buttons copy a prompt to the clipboard; the member pastes it into the
    // Claude Code / Cowork session they already have open. No session spawning.
    var sp=t.closest&&t.closest('[data-spawn]');
    if(sp){ var pr=sp.getAttribute('data-spawn'), o=sp.textContent;
      navigator.clipboard.writeText(pr).then(function(){ sp.textContent='Copied, paste into Claude Code'; }).catch(function(){ sp.textContent='Copy failed, select it by hand'; });
      setTimeout(function(){ sp.textContent=o; },2400); return; }
    var fb=t.closest&&t.closest('[data-fbfix]');
    if(fb){ var sk=fb.getAttribute('data-skill'), cl=fb.getAttribute('data-client'), bd=fb.getAttribute('data-body');
      var p='A teammate flagged the "'+sk+'" skill'+(cl?(' (client: '+cl+')'):'')+'. Their note:\n\n'+(bd||'(no detail given)')+'\n\nOpen .claude/skills/'+sk+'/SKILL.md, work out what went wrong, and fix it. The brain root is your working directory.';
      var fo=fb.textContent;
      navigator.clipboard.writeText(p).then(function(){ fb.textContent='Copied, paste into Claude Code'; }).catch(function(){ fb.textContent='Copy failed, select it by hand'; });
      setTimeout(function(){ fb.textContent=fo; },2400); return; }
  });

  // Brain updates banner — pending docs/migrations/ updates for owner/scout
  // (the server returns an empty list for team role). The button copies the
  // apply prompt; the member pastes it into Claude Code in their brain.
  (function(){
    var b=$('bu-banner'); if(!b) return;
    fetch('/api/brain-updates').then(function(r){return r.json();}).then(function(d){
      var pending=(d&&d.pending)||[]; if(!pending.length) return;
      $('bu-title').textContent = pending.length===1 ? pending[0].title
        : pending.length+' updates: '+pending.map(function(m){return m.title;}).join(' \u00b7 ');
      var prompt='Apply the pending Agency Brain update'+(pending.length>1?'s':'')+': read '+
        pending.map(function(m){return m.file;}).join(', then ')+
        ' and follow the instructions inside exactly.';
      $('bu-copy').addEventListener('click',function(){
        try{ navigator.clipboard.writeText(prompt); }catch(e){}
        var btn=$('bu-copy'); btn.textContent='Copied \u2014 paste into Claude Code';
        setTimeout(function(){ btn.textContent='Copy the update prompt'; },2200);
      });
      b.hidden=false;
    }).catch(function(){});
  })();
