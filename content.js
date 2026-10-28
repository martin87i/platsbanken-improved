(function () {
  'use strict';

  if (window.top !== window.self) return; // not in iframes
  if (!location.pathname.startsWith('/platsbanken')) return; // only on Platsbanken

  /* ================= UTIL ================= */
  function whenBodyReady(fn) {
    if (document.body) { fn(); return; }
    const mo = new MutationObserver(() => {
      if (document.body) { mo.disconnect(); fn(); }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  let __tick = false;
  function scheduleTick(delay = 120) {
    if (__tick) return;
    __tick = true;
    setTimeout(() => { __tick = false; tick(); }, delay);
  }

  /* ================= STATE ================= */
  let hiddenJobs = new Set(JSON.parse(localStorage.getItem('pb_hiddenJobs') || '[]'));
  const saveHidden = () => localStorage.setItem('pb_hiddenJobs', JSON.stringify([...hiddenJobs]));
  let viewMode = sessionStorage.getItem('pb_viewMode') || 'normal';
  const setViewMode = (m) => { viewMode = m; sessionStorage.setItem('pb_viewMode', m); updateToolbarState(); scheduleTick(40); };

  // === Filter-STATE (ord-taggar) ===
  // format: [{word:'bemanning', active:true}, {word:'säljare', active:false}]
  let blockedTokens = JSON.parse(localStorage.getItem('pb_blockedTokens') || '[]');

  function saveBlockedTokens() {
    localStorage.setItem('pb_blockedTokens', JSON.stringify(blockedTokens));
  }
  function getActiveBlockedWords() {
    return blockedTokens.filter(t => t.active).map(t => t.word);
  }
  function addBlockedToken(raw) {
    const word = String(raw || '').trim().toLowerCase();
    if (!word || word.length < 2) return;
    if (blockedTokens.some(t => t.word === word)) return; // avoid duplicates
    blockedTokens.push({ word, active: true });
    saveBlockedTokens();
    renderTokenList();
    applyVisibility();
  }
  function removeBlockedToken(word) {
    blockedTokens = blockedTokens.filter(t => t.word !== word);
    saveBlockedTokens();
    renderTokenList();
    applyVisibility();
  }
  function setTokenActive(word, active) {
    const t = blockedTokens.find(t => t.word === word);
    if (!t) return;
    t.active = !!active;
    saveBlockedTokens();
    applyVisibility();
  }
  function isWordBlocked(card) {
    const activeWords = getActiveBlockedWords() || [];
    if (!activeWords.length) return false;
    const text = (card.textContent || '').toLowerCase();
    return activeWords.some(w => text.includes(w));
  }

  /* ================= CSS ================= */
  const css = `
    /* Grundlayout 34vw + fri höger */
    html, body, main,
    .sv-responsive, .sv-template-applicationsmall-bootstrap4,
    .sv-layout-content, .sv-layout, .sv-container, .container, .container-fluid,
    .content, .layout, .app, .pb-search-results, .pb-search-result-list, .row, .grid {
      margin-left: 0 !important;
      padding-left: 0 !important;
      max-width: none !important;
      width: auto !important;
      justify-content: flex-start !important;
      align-items: stretch !important;
      text-align: left !important;
    }
    .pb-search-results, .pb-search-result-list { display:block; margin:0 !important; }

    .card-container{
      width:34vw !important; max-width:34vw !important;
      margin:0 0 16px 0 !important; position:relative !important;
    }

    /* Dölj/Visa-knapp i header */
    .header-container{ position:relative !important; }
    .pb-hide-btn-wrapper{ position:absolute; right:8px; bottom:6px; display:flex; justify-content:flex-end; width:auto; pointer-events:none; }
    .pb-hide-btn{ pointer-events:auto; background:#e74c3c; color:#fff; border:none; border-radius:8px;
      font-size:19.5px !important; padding:6px 12px !important; min-height:2.7em !important;
      display:inline-flex; align-items:center; justify-content:center; cursor:pointer; transition:background .15s; }
    .pb-hide-btn:hover{background:#c0392b}
    .pb-show-btn{background:#2ecc71!important}
    .pb-show-btn:hover{background:#27ae60!important}

    /* Footer: håll publicerad text & spara kompakt, knappen får plats */
    .pb-job-card-footer, .pb-list-footer, .card-container .pb-feature-save-job{
      display:flex !important; flex-direction:row !important; align-items:center !important; justify-content:space-between !important;
      gap:8px; width:100%; margin-top:0 !important; padding-top:0 !important; flex-wrap:nowrap !important;
    }
    .card-container [class*="publish"], .card-container [data-testid*="publish"], .card-container [aria-label*="Publicerad"]{
      flex:1 1 auto !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important;
    }
    .card-container .pb-feature-save-job, .card-container .pb-feature-save-job *{ white-space:nowrap !important; }
    .pb-feature-save-job button, .save-button, .save-button-text, .pb-feature-save-job a{
      flex:0 0 auto !important; font-size:19.5px !important; padding:6px 12px !important; min-height:2.7em !important; border-radius:8px !important;
    }

    /* Visuella markeringar för dolda */
    .pb-hidden-outline{ opacity:.55 !important; box-shadow:inset 0 0 0 3px rgba(231,76,60,.6) !important; }
    .pb-hidden-saved-outline{ opacity:.65 !important; box-shadow:inset 0 0 0 3px rgba(46,204,113,.6) !important; }

    /* Höger förhandsvisningspanel – full höjd, täcker inte sidfoten */
    #pb-preview{
      position:fixed; top:0; left:34vw; right:0; bottom:0; background:#fff;
      border-left:1px solid #ccc; box-shadow:-4px 0 18px rgba(0,0,0,.15);
      z-index:1000000; display:none; flex-direction:column;
    }
    #pb-preview.pb-open{ display:flex; }
    #pb-preview-header{ display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-bottom:1px solid #eee; flex:0 0 auto; }
    #pb-preview-header .btn{ background:#2d89ef; color:#fff; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; }
    #pb-preview-header .btn.secondary{ background:#6c757d; }
    #pb-preview-iframe{ width:100%; height:calc(100% - 42px); border:0; flex:1 1 auto; }

    /* Verktygsfält + donationsrad */
    #pb-tools{ position:sticky; top:10px; width:34vw; display:flex; flex-direction:column; align-items:flex-start; gap:6px; padding:8px 8px 10px 0; z-index:10; }
    #pb-tools .pb-tb-btn{ background:#0b5ed7; color:#fff; border:none; border-radius:10px; padding:8px 12px; cursor:pointer; transition:transform .05s; }
    #pb-tools .pb-tb-btn:hover{ transform:translateY(-1px); }
    #pb-tools .pb-tb-btn.is-active[aria-pressed="true"]{ background:#094cb7; outline:3px solid #0b5ed7; box-shadow:0 0 0 3px #fff inset, 0 0 0 4px rgba(11,94,215,.55); }
    #pb-donate-row{ display:flex; align-items:center; gap:8px; justify-content:flex-start; }
    #pb-hide-donate-wrap{ font-size:12px; color:#000; display:flex; align-items:center; gap:4px; }

    /* Paginering: placera i metadata-container, horisontell, 34vw */
    nav[aria-label*="Paginering" i],
    nav[aria-label*="pagination" i],
    nav[aria-label*="Sida" i],
    nav.digi-navigation-pagination__pagination {
      box-sizing:border-box !important;
      display:flex !important; flex-direction:row !important; align-items:center !important;
      justify-content:flex-start !important; flex-wrap:wrap !important; gap:.4rem !important;
      width:34vw !important; max-width:34vw !important; margin:6px 0 0 0 !important;
    }
    nav[aria-label*="Paginering" i] ul, nav[aria-label*="Paginering" i] ol,
    nav[aria-label*="pagination" i] ul,  nav[aria-label*="pagination" i] ol,
    nav[aria-label*="Sida" i] ul,        nav[aria-label*="Sida" i] ol,
    nav.digi-navigation-pagination__pagination ul, nav.digi-navigation-pagination__pagination ol {
      display:flex !important; flex-direction:row !important; flex-wrap:wrap !important; gap:.4rem !important;
      list-style:none !important; margin:0 !important; padding:0 !important;
    }
    nav[aria-label*="Paginering" i] li,
    nav[aria-label*="pagination" i] li,
    nav[aria-label*="Sida" i] li,
    nav.digi-navigation-pagination__pagination li {
      display:inline-flex !important; align-items:center !important;
    }
    nav[aria-label*="Paginering" i] a, nav[aria-label*="Paginering" i] button,
    nav[aria-label*="pagination" i] a,  nav[aria-label*="pagination" i] button,
    nav[aria-label*="Sida" i] a,        nav[aria-label*="Sida" i] button,
    nav.digi-navigation-pagination__pagination a, nav.digi-navigation-pagination__pagination button {
      display:inline-flex !important; flex:0 0 auto !important;
    }
  `;
  document.documentElement.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

  /* ================= HELPERS ================= */
  const getCards = () => [...document.querySelectorAll('.card-container')];
  const getJobId = (card) => card.querySelector('a[href*="/platsbanken/annonser"]')?.getAttribute('href');
  const isSaved = (card) => {
    const t = card.querySelector('.save-button-text')?.textContent?.toLowerCase() || '';
    const pressed = card.querySelector('button[aria-pressed="true"]');
    return t.includes('sparad') || !!pressed;
  };

  /* ================= PREVIEW ================= */
  let panel, iframe, titleEl, openNewTab;
  function ensurePanel(){
    if(panel && document.body.contains(panel)) return;
    panel = document.createElement('div');
    panel.id = 'pb-preview';
    panel.innerHTML = `
      <div id="pb-preview-header">
        <div class="title">Annons</div>
        <div style="display:flex;gap:8px">
          <a id="pb-open-newtab" class="btn secondary" target="_blank" rel="noopener">Ny flik</a>
          <button id="pb-close" class="btn">Stäng</button>
        </div>
      </div>
      <iframe id="pb-preview-iframe"></iframe>
    `;
    document.body.appendChild(panel);
    iframe = panel.querySelector('#pb-preview-iframe');
    titleEl = panel.querySelector('.title');
    openNewTab = panel.querySelector('#pb-open-newtab');
    panel.querySelector('#pb-close').addEventListener('click', ()=>{ panel.classList.remove('pb-open'); iframe.removeAttribute('src'); });
    window.addEventListener('keydown', e=>{ if(e.key==='Escape'){ panel.classList.remove('pb-open'); iframe.removeAttribute('src'); }});
  }
  function openPreview(url, titleText){
    ensurePanel();
    panel.classList.add('pb-open');
    iframe.src = url;
    openNewTab.href = url;
    titleEl.textContent = titleText || 'Annons';
  }

  /* ================= HIDE/SHOW ================= */
  function setHideButtonState(card, btn, id){
    const hidden = id && hiddenJobs.has(id);
    btn.textContent = hidden ? 'Visa' : 'Dölj';
    btn.classList.toggle('pb-show-btn', hidden);
  }
  function ensureHideButtonInHeader(card){
    if(card.querySelector('.pb-hide-btn')) return;
    const id = getJobId(card); if(!id) return;
    const header = card.querySelector('.header-container'); if(!header) return;
    const wrap = document.createElement('div'); wrap.className = 'pb-hide-btn-wrapper';
    const btn = document.createElement('button'); btn.className = 'pb-hide-btn';
    setHideButtonState(card, btn, id);
    btn.addEventListener('click', e=>{
      e.preventDefault(); e.stopPropagation();
      const cid = getJobId(card); if(!cid) return;
      if(hiddenJobs.has(cid)) hiddenJobs.delete(cid); else hiddenJobs.add(cid);
      saveHidden(); setHideButtonState(card, btn, cid); applyVisibilityForCard(card, cid);
    });
    wrap.appendChild(btn); header.appendChild(wrap);
  }

  /* ================= PAGINATION ================= */
  const META_SEL = 'div.metadata-container, .metadata-container';
  const PAGER_SEL = [
    'nav[aria-label*="Paginering" i]',
    'nav[aria-label*="pagination" i]',
    'nav[aria-label*="Sida" i]',
    'nav.digi-navigation-pagination__pagination'
  ].join(',');

  function movePagersIntoMetadata() {
    const meta = document.querySelector(META_SEL);
    if (!meta) return;
    const pagers = [...document.querySelectorAll(PAGER_SEL)].filter(n => n && n.isConnected);
    if (pagers.length === 0) return;
    const main = pagers[pagers.length - 1];
    for (const nav of pagers) { if (nav !== main) try { nav.remove(); } catch {} }
    if (main.parentElement !== meta) meta.appendChild(main);
  }

  /* ================= VISIBILITY ================= */
  function applyVisibilityForCard(card, id){
    // HÅRD: ta bort ord-blockerade kort helt ur DOM så de aldrig visas
    if (isWordBlocked(card)) {
      try { card.remove(); } catch {}
      return;
    }

    card.classList.remove('pb-hidden-outline','pb-hidden-saved-outline');
    const hidden = id && hiddenJobs.has(id);

    if (viewMode==='normal') {
      card.style.display = hidden ? 'none' : '';
    } else if (viewMode==='showAll') {
      card.style.display='';
      if(hidden) card.classList.add('pb-hidden-outline');
    } else if (viewMode==='showHiddenSaved') {
      const show=hidden&&isSaved(card); card.style.display=show?'':'none'; if(show) card.classList.add('pb-hidden-saved-outline');
    } else if (viewMode==='showHiddenOnly') {
      card.style.display = hidden ? '' : 'none'; if(hidden) card.classList.add('pb-hidden-outline');
    }
  }
  function applyVisibility(){
    for (const card of getCards()) {
      const id = getJobId(card);
      const btn = card.querySelector('.pb-hide-btn'); if (btn) setHideButtonState(card, btn, id);
      applyVisibilityForCard(card, id);
    }
  }

  /* ================= TOOLBAR ================= */
  let renderTokenList = () => {}; // placeholder for hoisting

  function ensureToolbar() {
    if (document.getElementById('pb-tools')) return;
    const firstCard = document.querySelector('.card-container');
    if (!firstCard) return;

    const bar = document.createElement('div');
    bar.id = 'pb-tools';
    bar.innerHTML = `
      <div id="pb-donate-row">
        <button id="pb-donate-btn" class="pb-tb-btn" style="background:#f7b731;color:#000;">☕ Stöd utvecklaren</button>
        <label id="pb-hide-donate-wrap">
          <input type="checkbox" id="pb-hide-donate"> Dölj permanent
        </label>
      </div>
      <div id="pb-tool-buttons" style="display:flex;flex-wrap:wrap;gap:8px;">
        <button class="pb-tb-btn" data-a="normal">Normalt</button>
        <button class="pb-tb-btn" data-a="showAll">Visa alla</button>
        <button class="pb-tb-btn" data-a="showHiddenOnly">Endast dolda</button>
        <button class="pb-tb-btn" data-a="showHiddenSaved">Dolda + sparade</button>
        <button class="pb-tb-btn" data-a="clear">Rensa</button>
      </div>
      <div id="pb-filter-box" style="width:100%;">
        <div style="margin-top:8px;">
          <label style="font-size:13px;font-weight:600;display:block;margin-bottom:6px;">
            Filtrera bort ord <span style="font-weight:500;color:#666">(skriv ord och tryck Enter)</span>
          </label>
          <input id="pb-token-input" type="text" autocomplete="off"
                 placeholder="t.ex. bemanning, säljare, konsult"
                 style="width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px;">
          <div id="pb-token-list" style="margin-top:8px;max-height:180px;overflow:auto;border:1px solid #e5e7eb;border-radius:8px;background:#fff;display:none;"></div>
        </div>
      </div>
    `;

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.pb-tb-btn');
      if (!btn || btn.id === 'pb-donate-btn') return;
      const a = btn.dataset.a;
      if (!a) return;
      if (a === 'clear') {
        if (confirm('Rensa alla dolda annonser?')) { hiddenJobs.clear(); saveHidden(); setViewMode('normal'); }
      } else setViewMode(a);
    });

    const donateRow = bar.querySelector('#pb-donate-row');
    const donateBtn = bar.querySelector('#pb-donate-btn');
    const hideCheck = bar.querySelector('#pb-hide-donate');
    const hiddenDonate = localStorage.getItem('pb_hideDonate') === 'true';
    if (hiddenDonate) donateRow.style.display = 'none';
    hideCheck.checked = hiddenDonate;

    donateBtn.addEventListener('click', () => window.open('https://buymeacoffee.com/lowkeylokee', '_blank', 'noopener'));
    hideCheck.addEventListener('change', (e) => {
      const v = !!e.target.checked;
      localStorage.setItem('pb_hideDonate', String(v));
      donateRow.style.display = v ? 'none' : 'flex';
    });

    // token UI
    const tokenInput = bar.querySelector('#pb-token-input');
    const tokenList  = bar.querySelector('#pb-token-list');

    tokenInput.addEventListener('keydown', (e) => {
      if (['Enter', 'Tab'].includes(e.key) || (e.key === ',')) {
        const v = tokenInput.value;
        if (v.trim()) { addBlockedToken(v); }
        tokenInput.value = '';
        if (e.key !== ',') e.preventDefault();
      }
    });

    renderTokenList = function () {
	tokenList.textContent = '';
		if (!blockedTokens.length) { tokenList.style.display = 'none'; return; }
			tokenList.style.display = 'block';
			for (const t of blockedTokens) {
    const row = document.createElement('div');
    row.className = 'pb-token-row';
    row.dataset.word = t.word;
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #f0f0f0;';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'pb-token-check';
    check.checked = !!t.active;
    check.setAttribute('aria-label', "Aktiv filtrering för '" + t.word + "'");

    const label = document.createElement('span');
    label.style.cssText = 'flex:1 1 auto;font-size:14px;';
    label.textContent = t.word;

    const del = document.createElement('button');
    del.className = 'pb-token-remove';
    del.setAttribute('aria-label', "Ta bort '" + t.word + "'");
    del.style.cssText = 'background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:4px 8px;cursor:pointer;';
    del.textContent = '✕';

    row.append(check, label, del);
    tokenList.appendChild(row);
		}
	};
    renderTokenList();

    tokenList.addEventListener('click', (e) => {
      const row = e.target.closest('.pb-token-row');
      if (!row) return;
      const word = row.getAttribute('data-word');
      if (e.target.classList.contains('pb-token-remove')) {
        removeBlockedToken(word);
      }
    });
    tokenList.addEventListener('change', (e) => {
      const row = e.target.closest('.pb-token-row');
      if (!row) return;
      if (e.target.classList.contains('pb-token-check')) {
        setTokenActive(row.getAttribute('data-word'), e.target.checked);
      }
    });

    firstCard.parentElement.insertBefore(bar, firstCard);
    updateToolbarState();
  }
  function updateToolbarState(){
    const bar=document.getElementById('pb-tools'); if(!bar) return;
    for(const b of bar.querySelectorAll('.pb-tb-btn')){
      const active=(b.dataset.a===viewMode);
      b.classList.toggle('is-active',active);
      b.setAttribute('aria-pressed',active?'true':'false');
    }
  }

  /* ================= INTERCEPT – körs TIDIGT ================= */
  const isAdLinkHref = (s) => /\/platsbanken\/annonser(\/|$|\?)/.test(String(s||''));
  function findAnchorFromEvent(e){
    const path=typeof e.composedPath==='function'?e.composedPath():[];
    for(const n of path) if(n && n.tagName==='A' && (n.href || n.getAttribute('href'))) return n;
    return e.target?.closest?.('a') || null;
  }
  function interceptToPreview(e){
    if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button===1) return;
    const a=findAnchorFromEvent(e); if(!a) return;
    const card = a.closest('.card-container'); if(!card) return;

    // STOPPA om ord-blockerad
    if (isWordBlocked(card)) {
      e.preventDefault(); e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      return;
    }

    if(!a.closest('.card-container')) return;
    const href=a.href||a.getAttribute('href')||''; if(!isAdLinkHref(href)) return;
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    e.preventDefault(); e.stopPropagation();
    openPreview(href,(a.textContent||'').trim());
  }
  // capture-phase & document-start so we win
  ['pointerdown','mousedown','click'].forEach(t=>document.addEventListener(t,interceptToPreview,true));
  document.addEventListener('keydown',e=>{
    if(e.key!=='Enter') return;
    const a=e.target && e.target.tagName==='A'?e.target:null; if(!a||!a.closest('.card-container')) return;
    const href=a.href||a.getAttribute('href')||''; if(!isAdLinkHref(href)) return;
    if(typeof e.stopImmediatePropagation==='function') e.stopImmediatePropagation();
    e.preventDefault(); e.stopPropagation(); openPreview(href,(a.textContent||'').trim());
  },true);

  /* ================= MAIN ================= */
  function tick(){
    ensureToolbar();
    movePagersIntoMetadata();
    for(const card of getCards()) ensureHideButtonInHeader(card);
    applyVisibility();
    updateToolbarState();
    ensurePanel();
  }

  whenBodyReady(()=>{
    tick();

    const host = document.querySelector('.pb-search-result-list, .pb-search-results') || document.body;
    new MutationObserver(()=>scheduleTick(80)).observe(host,{ childList:true, subtree:true });

    // sidan är en SPA – fånga URL-byten
    let last = location.href;
    const reinit = () => { if (location.href !== last) { last = location.href; scheduleTick(40); } };
    const _push = history.pushState; history.pushState = function(...a){ const r=_push.apply(this,a); setTimeout(reinit,0); return r; };
    const _replace = history.replaceState; history.replaceState = function(...a){ const r=_replace.apply(this,a); setTimeout(reinit,0); return r; };
    window.addEventListener('popstate', reinit);
    window.addEventListener('resize', ()=>scheduleTick(100));

    // kickstarta paginerings-flytten flera gånger (olika laddningsvägar)
    let n=0; const kick=setInterval(()=>{ movePagersIntoMetadata(); ensurePanel(); if(++n>8) clearInterval(kick); },250);
  });
})();
