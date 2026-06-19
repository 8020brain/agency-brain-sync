'use strict';
  // ---- Google Ads setup page ----
  function copyBlock(el){
    if(!el || el.__wired) return; el.__wired=true;
    el.addEventListener('click',function(){
      var txt=el.dataset.copy||el.textContent;
      navigator.clipboard.writeText(txt).then(function(){ el.classList.add('copied'); setTimeout(function(){ el.classList.remove('copied'); },1600); });
    });
  }
  function gadsToolRow(label, ok, ver, warn){
    return '<div class="row"><span class="'+(ok?'ok':'bad')+'">'+(ok?'✓':'✗')+'</span> <span>'+esc(label)+'</span>'+(ver?' <span class="ago">'+esc(ver)+'</span>':'')+(warn?' <span class="bad">'+esc(warn)+'</span>':'')+'</div>';
  }
  var gadsPoll=null;
  async function gadsDetect(){
    var box=$('ga-tools'); if(!box) return;
    try{
      var d=await api('/api/gads/detect'); var py=d.python||{}, px=d.pipx||{};
      var allOk=!!(py.present&&py.ok) && !!px.present;
      var rows=gadsToolRow('Python 3.11+', !!(py.present&&py.ok), py.version||'', (py.present&&!py.ok)?'need 3.11 or newer':'')
             + gadsToolRow('pipx', !!px.present, px.version||'', '');
      var help='';
      if(!allOk){
        var win=(d.platform==='win32');
        var cmds=win ? 'winget install Python.Python.3.12\n$env:Path=[Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")\npython -m pip install --user pipx\npython -m pipx ensurepath'
                     : 'brew install python@3.12 pipx\npipx ensurepath';
        help='<details class="esc"><summary>Something\'s missing — how do I install it?</summary><p>Run these in '+(win?'PowerShell':'Terminal')+' (one paste), then reopen it and come back.'+(win?' The PATH line lets this same window see Python right after winget installs it. If <code>python</code> opens the Microsoft Store instead of installing, turn off its App Execution Alias (Settings &gt; Apps &gt; Advanced app settings &gt; App execution aliases) and retry.':'')+'</p><div class="copyblock" id="ga-install-cmds" data-copy="'+esc(cmds)+'">'+esc(cmds)+'</div></details>';
      }
      var recheck='<button class="add-btn secondary" id="ga-recheck" style="margin-top:10px">Re-check this machine</button>';
      box.innerHTML='<div class="sec" style="margin-top:4px">On this machine</div>'+rows+help+(allOk?'':recheck);
      copyBlock($('ga-install-cmds'));
      var rb=$('ga-recheck'); if(rb) rb.addEventListener('click', gadsDetect);
      // Status would otherwise stay stale forever after an install; auto-poll every
      // 8s until both tools are present (then stop), alongside the manual Re-check.
      if(allOk){ if(gadsPoll){ clearInterval(gadsPoll); gadsPoll=null; } }
      else if(!gadsPoll){ gadsPoll=setInterval(gadsDetect, 8000); }
    }catch(e){ /* transient; the poll or Re-check button will retry */ }
  }
  (function(){
    var make=$('ga-make');
    if(make) make.addEventListener('click',async function(){
      var st=$('ga-make-status'); st.textContent='Building…';
      try{
        var r=await api('/api/gads/encode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          dev:$('ga-dev').value.trim(), cid:$('ga-cid').value.trim(), csec:$('ga-csec').value.trim(),
          rt:$('ga-rt').value.trim(), mcc:$('ga-mcc').value.trim(), project:$('ga-proj').value.trim() })});
        var blk=$('ga-block'); blk.hidden=false; blk.textContent=r.block; blk.dataset.copy=r.block;
        st.textContent='Ready — click the block to copy.';
      }catch(e){ st.textContent=e.message; }
    });
    copyBlock($('ga-block'));
    var conn=$('ga-connect');
    if(conn) conn.addEventListener('click',async function(){
      var st=$('ga-connect-status'); st.textContent='Working…';
      try{
        var r=await api('/api/gads/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ block:$('ga-paste').value })});
        st.textContent='Saved.';
        var dc=$('ga-done-card'); if(dc) dc.hidden=false;
        var sw=$('ga-saved-where'); if(sw){ sw.innerHTML='Wrote <b>google-ads.yaml</b> to <code>'+esc(r.yamlPath||'?')+'</code>.'+(r.configPath?' Added a <b>google-ads</b> connector entry to <code>'+esc(r.configPath)+'</code>.':''); }
        var pr=$('ga-prompt'); if(pr){ pr.textContent=r.verifyPrompt; pr.dataset.copy=r.verifyPrompt; copyBlock(pr); }
      }catch(e){ st.textContent=e.message; }
    });
  })();

  // ---- Google Ads proxy (recommended path): Scout sets the URL once, team pastes a token ----
  async function gadsProxyInit(role){
    try{
      var cfg=await api('/api/gads-proxy/config');
      if(role==='team'){
        var pm=$('gads-proxy-member'), yaml=$('gads-member-yaml');
        if(cfg.configured){
          if(pm) pm.hidden=false;
          if(yaml) yaml.hidden=true;
          var ud=$('gp-url-display'); if(ud) ud.innerHTML='Connecting through <b>'+esc(cfg.url)+'</b>';
        } else {
          if(pm) pm.hidden=true;
          if(yaml) yaml.hidden=false;
        }
      } else {
        var inp=$('gp-url'); if(inp && cfg.url && !inp.value) inp.value=cfg.url;
        var cur=$('gp-current');
        if(cur){ if(cfg.url){ cur.hidden=false; cur.innerHTML='Current team proxy URL: <code>'+esc(cfg.url)+'</code> — this syncs to your team automatically.'; } else { cur.hidden=true; } }
      }
    }catch(e){ /* transient; role switch or reload will retry */ }
  }
  // The DIY commands for the Google Ads proxy, behind a "Copy the setup commands"
  // button so we never make anyone go hunting in a README file path. One paste:
  // run in a terminal in the brain folder, or hand the whole block to Claude.
  var GADS_PROXY_CMDS = [
    '# Google Ads proxy setup. Run these from your agency brain folder.',
    '# You can also paste this whole block to Claude in your brain and it will do it for you.',
    '',
    '# Prereq: a Cloudflare API token in your .env as CLOUDFLARE_WORKERS_TOKEN.',
    '# Get one at dash.cloudflare.com (My Profile, API Tokens, Create Token, "Edit Cloudflare Workers", Create).',
    '',
    '# 1) Deploy the Worker (prints your Worker URL):',
    'node -r dotenv/config .claude/skills/gads-proxy/cloudflare/deploy.cjs',
    '',
    '# 2) Set the Google Ads secrets and generate a gate token:',
    'node -r dotenv/config .claude/skills/gads-proxy/cloudflare/set-secrets.cjs',
    '',
    '# 3) Test it (use the URL printed in step 1):',
    'curl https://gads-proxy.YOUR-SUBDOMAIN.workers.dev/ping',
    '',
    '# Then paste the Worker URL into the box above. Each teammate only needs a gate token.'
  ].join('\n');

  (function(){
    var cc=$('gp-copy-cmds');
    if(cc) cc.addEventListener('click',function(){
      navigator.clipboard.writeText(GADS_PROXY_CMDS).then(function(){
        cc.textContent='Copied';
        setTimeout(function(){ cc.textContent='Copy the setup commands'; },1800);
      }).catch(function(){ cc.textContent='Copy failed, the commands are in .claude/skills/gads-proxy/cloudflare/'; });
    });
    var save=$('gp-save');
    if(save) save.addEventListener('click',async function(){
      var st=$('gp-save-status'); st.textContent='Saving…';
      try{
        var r=await api('/api/gads-proxy/set-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ url:$('gp-url').value.trim() })});
        st.textContent='Saved — it will sync to your team.';
        var cur=$('gp-current'); if(cur){ cur.hidden=false; cur.innerHTML='Current team proxy URL: <code>'+esc(r.url)+'</code> — this syncs to your team automatically.'; }
      }catch(e){ st.textContent=e.message; }
    });
    var conn=$('gp-connect');
    if(conn) conn.addEventListener('click',async function(){
      var st=$('gp-connect-status'); st.textContent='Connecting…';
      try{
        var r=await api('/api/gads-proxy/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ secret:$('gp-token').value.trim() })});
        st.textContent='Connected.';
        var dc=$('gp-done-card'); if(dc) dc.hidden=false;
        var sw=$('gp-saved-where'); if(sw) sw.innerHTML='Wrote <b>gads-proxy.yaml</b> to <code>'+esc(r.yamlPath||'?')+'</code> (gitignored, never synced).';
        var pr=$('gp-prompt'); if(pr){ pr.textContent=r.verifyPrompt; pr.dataset.copy=r.verifyPrompt; copyBlock(pr); }
      }catch(e){ st.textContent=e.message; }
    });
  })();

  // Auto-update banner (Electron only — needs the preload bridge). Shows the
  // bottom-left "Relaunch to update" toast when a new build has downloaded.
  (function(){
    var toast=$('update-toast'); if(!toast || !window.agencyBrain) return;
    function show(info){ if(!info || !info.version) return; var v=$('ut-version'); if(v) v.textContent='v'+info.version; toast.hidden=false; }
    if(window.agencyBrain.getUpdateState) window.agencyBrain.getUpdateState().then(function(s){ if(s) show(s); }).catch(function(){});
    if(window.agencyBrain.onUpdateDownloaded) window.agencyBrain.onUpdateDownloaded(show);
    toast.addEventListener('click',function(e){
      if(e.target && e.target.id==='ut-later'){
        if(window.agencyBrain.delayUpdate) window.agencyBrain.delayUpdate();
        var h=toast.querySelector('.ut-h'); if(h) h.textContent='Will install on next restart';
        var l=$('ut-later'); if(l) l.hidden=true;
        return;
      }
      if(window.agencyBrain.installUpdate) window.agencyBrain.installUpdate();
    });
  })();

  // Skills page (master-detail) — team + scout. Reuses the observability data
  // already in SK.data; shows what each skill is, plus its status.
  var SP_SEL=null;
  function renderSkillsList(){
    var box=$('sp-items'); if(!box||!SK.data) return;
    var q=((($('sp-search')||{}).value)||'').toLowerCase().trim();
    var list=(SK.data.skills||[]).slice().sort(function(a,b){return (a.name||'').localeCompare(b.name||'');});
    if(q) list=list.filter(function(s){return (s.name||'').toLowerCase().indexOf(q)>=0;});
    box.innerHTML=list.length?list.map(function(s){
      return '<div class="sp-item'+(s.name===SP_SEL?' active':'')+'" data-skill="'+esc(s.name)+'"><span class="nm">'+esc(s.name)+'</span><span class="pill '+esc(s.maturity)+'">'+esc(s.maturity)+'</span></div>';
    }).join(''):'<div class="sp-item" style="cursor:default;color:var(--muted)">No skills match.</div>';
  }
  function renderSkillDetail(name){
    var d=$('sp-detail'); if(!d||!SK.data) return;
    var s=(SK.data.skills||[]).filter(function(x){return x.name===name;})[0];
    if(!s){ d.innerHTML='<div class="sp-empty">Pick a skill on the left to see what it does.</div>'; return; }
    SP_SEL=name;
    var status=[]; status.push(s.flags>0?(s.flags+' open flag'+(s.flags===1?'':'s')):'no open flags');
    if(s.lastImproved) status.push('improved '+ago(s.lastImproved));
    if(s.runs7d) status.push(s.runs7d+' run'+(s.runs7d===1?'':'s')+' this week');
    var desc=s.description||'';
    var uw=desc.search(/\bUSE WHEN\b/i);
    if(uw>0) desc=desc.slice(0,uw).replace(/[\s.;,]+$/,'').trim();
    d.innerHTML='<h2>'+esc(s.name)+'</h2>'
      +'<div class="sp-meta"><span class="pill '+esc(s.maturity)+'">'+esc(s.maturity)+'</span>'+(s.version?'<span class="sp-ver">v'+esc(s.version)+'</span>':'')+'</div>'
      +'<div class="sp-sec">What it is</div>'
      +'<div class="sp-desc">'+(desc?esc(desc):'<span class="mut">This skill has no description in its SKILL.md yet.</span>')+'</div>'
      +'<div class="sp-sec">Status</div>'
      +'<div class="sp-status">'+esc(status.join(' · '))+'</div>';
    var items=$('sp-items'); if(items){ var all=items.querySelectorAll('.sp-item'); for(var i=0;i<all.length;i++) all[i].classList.toggle('active',all[i].getAttribute('data-skill')===name); }
  }
  (function(){
    var items=$('sp-items');
    if(items) items.addEventListener('click',function(ev){ var it=ev.target.closest&&ev.target.closest('.sp-item[data-skill]'); if(it) renderSkillDetail(it.getAttribute('data-skill')); });
    var ss=$('sp-search'); if(ss) ss.addEventListener('input',renderSkillsList);
  })();

  // Flag a skill — populate the dropdown from the same skills data, submit to
  // the CC server (which writes the feedback file), refresh so counts update.
  function renderWelcomeStats(){ var el=$('wc-skill-count'); if(el&&SK.data) el.textContent=(SK.data.skills||[]).length; }
  function populateFlagSkills(){
    var sel=$('fg-skill'); if(!sel||!SK.data) return;
    var cur=sel.value;
    sel.innerHTML='<option value="">Select a skill…</option>'+(SK.data.skills||[]).slice().sort(function(a,b){return (a.name||'').localeCompare(b.name||'');}).map(function(s){return '<option value="'+esc(s.name)+'">'+esc(s.name)+'</option>';}).join('');
    if(cur) sel.value=cur;
  }
  (function(){
    var send=$('fg-send');
    if(send) send.addEventListener('click',function(){
      var skill=(($('fg-skill')||{}).value)||'', client=((($('fg-client')||{}).value)||'').trim(), wrong=((($('fg-wrong')||{}).value)||'').trim(), wanted=((($('fg-wanted')||{}).value)||'').trim(), st=$('fg-status');
      if(!skill){ st.textContent='Pick a skill first.'; return; }
      if(!wrong&&!wanted){ st.textContent='Tell us what went wrong or what you wanted instead.'; return; }
      send.disabled=true; send.textContent='Flagging…'; st.textContent='';
      api('/api/flag-skill',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({skill:skill,client:client,wrong:wrong,wanted:wanted})})
        .then(function(){ st.textContent='Flagged '+skill+'. The Scout will see it.'; $('fg-client').value=''; $('fg-wrong').value=''; $('fg-wanted').value=''; $('fg-skill').value=''; loadObservability(); })
        .catch(function(e){ st.textContent='Failed: '+e.message; })
        .then(function(){ send.disabled=false; send.textContent='Flag it'; });
    });
    var tog=$('fg-explain-toggle');
    if(tog) tog.addEventListener('click',function(){ var b=$('fg-explain-body'); var open=b.hidden; b.hidden=!open; tog.setAttribute('aria-expanded',open?'true':'false'); });
  })();
  // Sign out (footer). The app keeps running in the tray; this just clears the
  // member token so you re-auth before syncing again.
  var so=$('sign-out');
  if(so) so.addEventListener('click',function(){
    if(!(window.agencyBrain&&window.agencyBrain.signOut)) return;
    if(confirm('Sign out of Agency Brain? It keeps running in the menu bar, but you’ll need to re-enter your email and code to sync again.')) window.agencyBrain.signOut();
  });

