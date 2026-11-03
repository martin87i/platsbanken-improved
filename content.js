(function () {
  'use strict';

  if (!location.pathname.startsWith('/platsbanken')) return; // only on Platsbanken
  if (window.top !== window.self) {
    // I iframes (förhandsvisningen): bevaka bara spara-knappen och meddela sidan ovanför
    installSaveHook((adId, saved) => { try { window.parent.postMessage({ pbKartotek: true, adId, saved }, location.origin); } catch {} });
    return;
  }
  injectLoadAll();

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
  // Inställningar sparas i tilläggets egen lagring (storage.local), inte i sidans localStorage,
  // eftersom Platsbanken kan tömma localStorage, t.ex. vid utloggning.
  const api = (typeof browser !== 'undefined' && browser.storage) ? browser
            : (typeof chrome !== 'undefined' && chrome.storage) ? chrome : null;
  const STORE_KEYS = ['pb_hiddenJobs', 'pb_shownJobs', 'pb_blockedTokens', 'pb_hideDonate', 'pb_tokensExpanded', 'pb_tokenSort'];
  const store = {};
  function storeSet(key, val) {
    store[key] = val;
    if (api) {
      try { const r = api.storage.local.set({ [key]: val }); if (r && r.catch) r.catch(() => {}); } catch {}
    } else {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch {} // reservlösning
    }
  }

  let hiddenJobs = new Set();
  const saveHidden = () => storeSet('pb_hiddenJobs', [...hiddenJobs]);
  // Annonser som användaren själv valt att visa trots att ett filterord slår på dem
  let shownJobs = new Set();
  const saveShown = () => storeSet('pb_shownJobs', [...shownJobs]);
  let viewMode = sessionStorage.getItem('pb_viewMode') || 'normal';
  const setViewMode = (m) => { const was = viewMode; viewMode = m; sessionStorage.setItem('pb_viewMode', m); updateToolbarState(); scheduleTick(40); if ((was === 'normal') !== (m === 'normal') || (was === 'showHiddenOnly') !== (m === 'showHiddenOnly') || (was === 'showSaved') !== (m === 'showSaved')) syncAdFilter(true); };

  // === Filter-STATE (ord-taggar) ===
  // format: [{word:'bemanning', active:true}, {word:'säljare', active:false}]
  let blockedTokens = [];

  function saveBlockedTokens() {
    storeSet('pb_blockedTokens', blockedTokens);
  }

  // Läs in sparade värden innan sidan byggs. Flyttar även över gamla värden från localStorage en gång.
  const storeReady = (async () => {
    try { if (api) Object.assign(store, await api.storage.local.get(STORE_KEYS)); } catch {}
    for (const k of STORE_KEYS) {
      if (store[k] !== undefined) continue;
      let raw = null;
      try { raw = localStorage.getItem(k); } catch {}
      if (raw === null) continue;
      let v;
      try { v = JSON.parse(raw); } catch { v = raw; }
      storeSet(k, v);
    }
    hiddenJobs = new Set(Array.isArray(store.pb_hiddenJobs) ? store.pb_hiddenJobs : []);
    shownJobs = new Set(Array.isArray(store.pb_shownJobs) ? store.pb_shownJobs : []);
    blockedTokens = Array.isArray(store.pb_blockedTokens) ? store.pb_blockedTokens : [];
  })();

  // Håll flera öppna flikar synkade
  try {
    if (api && api.storage.onChanged) api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let changed = false;
      if (changes.pb_blockedTokens && JSON.stringify(changes.pb_blockedTokens.newValue || []) !== JSON.stringify(blockedTokens)) {
        store.pb_blockedTokens = changes.pb_blockedTokens.newValue || [];
        blockedTokens = store.pb_blockedTokens; changed = true;
      }
      if (changes.pb_hiddenJobs && JSON.stringify(changes.pb_hiddenJobs.newValue || []) !== JSON.stringify([...hiddenJobs])) {
        store.pb_hiddenJobs = changes.pb_hiddenJobs.newValue || [];
        hiddenJobs = new Set(store.pb_hiddenJobs); changed = true;
      }
      if (changes.pb_shownJobs && JSON.stringify(changes.pb_shownJobs.newValue || []) !== JSON.stringify([...shownJobs])) {
        store.pb_shownJobs = changes.pb_shownJobs.newValue || [];
        shownJobs = new Set(store.pb_shownJobs); changed = true;
      }
      if (changed) { renderTokenList(); applyVisibility(); syncAdFilter(true); }
    });
  } catch {}
  function getActiveBlockedWords() {
    return blockedTokens.map(t => t.word);
  }
  function addBlockedToken(raw) {
    const word = String(raw || '').trim().toLowerCase();
    if (!word || word.length < 2) return;
    if (blockedTokens.some(t => t.word === word)) return; // avoid duplicates
    blockedTokens.push({ word, active: true });
    saveBlockedTokens();
    syncAdFilter(false);
    renderTokenList();
    applyVisibility();
  }
  function removeBlockedToken(word) {
    blockedTokens = blockedTokens.filter(t => t.word !== word);
    saveBlockedTokens();
    syncAdFilter(true);
    renderTokenList();
    applyVisibility();
  }
  // Slår något filterord på kortets text (oavsett om användaren valt att visa annonsen)?
  function isWordMatch(card) {
    const activeWords = getActiveBlockedWords() || [];
    if (!activeWords.length) return false;
    const text = (card.textContent || '').toLowerCase();
    return activeWords.some(w => text.includes(w));
  }
  // Ordblockerad, men inte om användaren klickat Visa på just den här annonsen
  function isWordBlocked(card) {
    if (!isWordMatch(card)) return false;
    const id = getJobId(card);
    return !(id && shownJobs.has(id));
  }
  const isEffectivelyHidden = (card, id) => !!(id && hiddenJobs.has(id)) || isWordBlocked(card);

  /* ================= CSS ================= */
  const css = `
    /* Grundlayout 34vw + fri höger */
    html:not(.main-menu__wrapper *),
    body:not(.main-menu__wrapper *),
    main:not(.main-menu__wrapper *),
    .sv-responsive:not(.main-menu__wrapper *),
    .sv-template-applicationsmall-bootstrap4:not(.main-menu__wrapper *),
    .sv-layout-content:not(.main-menu__wrapper *),
    .sv-layout:not(.main-menu__wrapper *),
    .sv-container:not(.main-menu__wrapper *),
    .container:not(.main-menu__wrapper *),
    .container-fluid:not(.main-menu__wrapper *),
    .content:not(.main-menu__wrapper *),
    .layout:not(.main-menu__wrapper *),
    .app:not(.main-menu__wrapper *),
    .pb-search-results:not(.main-menu__wrapper *),
    .pb-search-result-list:not(.main-menu__wrapper *),
    .row:not(.main-menu__wrapper *),
    .grid:not(.main-menu__wrapper *) {
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


    /* Egen sidnavigering ersätter Platsbankens (alla annonser laddas på en sida) */
    digi-navigation-pagination, nav[aria-label*="Paginering" i], nav.digi-navigation-pagination__pagination{ display:none !important; }
    #pb-loadbar{ position:relative; overflow:hidden; box-sizing:border-box; width:34vw; max-width:34vw; margin:0 0 24px; padding:12px 14px 16px;
      background:#fff; border:1px solid #d9dce1; border-radius:10px; color:#111; }
    #pb-loadbar .pb-lb-main{ font-size:15px; font-weight:600; }
    #pb-loadbar .pb-lb-sub{ font-size:13px; color:#555; margin-top:2px; }
    #pb-loadbar .pb-lb-btn{ margin-top:8px; background:#0b5ed7; color:#fff; border:0; border-radius:8px; padding:6px 12px; font-size:13px; cursor:pointer; }
    #pb-loadbar .pb-lb-track{ position:absolute; left:0; right:0; bottom:0; height:5px; background:#e5e7eb; }
    #pb-loadbar .pb-lb-fill{ height:100%; width:calc(var(--pull,0) * 1%); background:#0b5ed7; transition:width .12s ease-out; }
    #pb-loadbar.is-busy .pb-lb-fill{ width:35%; transition:none; animation:pb-slide 1.1s ease-in-out infinite; }
    @keyframes pb-slide{ 0%{ margin-left:-35%; } 100%{ margin-left:100%; } }

    /* Dölj/Visa-knapp i header */
    .header-container{ position:relative !important; }
    .pb-hide-btn-wrapper{ position:absolute; right:8px; bottom:6px; display:flex; justify-content:flex-end; width:auto; pointer-events:none; }
    .pb-hide-btn{ pointer-events:auto; background:#e74c3c; color:#fff; border:none; border-radius:8px;
      font-size:19.5px !important; padding:6px 12px !important; min-height:2.7em !important;
      display:inline-flex; align-items:center; justify-content:center; cursor:pointer; transition:background .15s; }
    .pb-hide-btn:hover{background:#c0392b}
    .pb-show-btn{background:#2ecc71!important}
    .pb-show-btn:hover{background:#27ae60!important}

    /* Titeln är inte längre en länk: texten går att markera, och en länkknapp ligger bredvid */
    .card-container h3 a{ pointer-events:none !important; text-decoration:none !important; color:inherit !important; cursor:text !important; user-select:text !important; -webkit-user-select:text !important; }
    .card-container h3{ user-select:text !important; -webkit-user-select:text !important; }
    .pb-hide-btn-wrapper{ gap:8px; }
    .pb-link-btn{ pointer-events:auto; background:#4b5d73; color:#fff; border:none; border-radius:8px; font-size:19.5px !important; padding:6px 12px !important; min-height:2.7em !important; display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; transition:background .15s; white-space:nowrap; }
    .pb-link-btn:hover{ background:#344457; }
    .pb-link-btn svg{ width:20px; height:20px; flex:none; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
    .pb-filter-btn{ pointer-events:auto; background:#0b5ed7; color:#fff; border:none; border-radius:8px; font-size:19.5px !important; padding:6px 12px !important; min-height:2.7em !important; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; transition:background .15s; }
    .pb-filter-btn:hover{ background:#094bb0; }
    .pb-filter-btn{ position:relative; }
    .pb-filter-btn .pb-tip{ position:absolute; top:calc(100% + 8px); left:50%; transform:translateX(-50%); z-index:5; padding:6px 12px; background:#935500; color:#fff; border-radius:8px; font-size:14px; line-height:1.3; white-space:nowrap; box-shadow:0 2px 8px rgba(0,0,0,.25); pointer-events:none; }
    .pb-filter-btn .pb-tip::before{ content:''; position:absolute; left:50%; top:-5px; margin-left:-5px; border:5px solid transparent; border-top:0; border-bottom:5px solid #935500; }
    .pb-filter-btn.pb-done{ background:#2ecc71; }
    .pb-filter-btn.pb-warn{ background:#935500; }
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
    .pb-word-outline{ opacity:.75 !important; box-shadow:inset 0 0 0 3px rgba(243,156,18,.75) !important; }
    .pb-hidden-saved-outline{ opacity:.65 !important; box-shadow:inset 0 0 0 3px rgba(46,204,113,.6) !important; }

    /* Höger förhandsvisningspanel – full höjd, täcker inte sidfoten */
    #pb-preview{
      position:fixed; top:0; left:34vw; right:0; bottom:0; background:#fff;
      border-left:1px solid #ccc; box-shadow:-4px 0 18px rgba(0,0,0,.15);
      z-index:1000000; display:none; flex-direction:column;
    }
    #pb-preview.pb-open{ display:flex; }
    #pb-preview-header{ display:flex; justify-content:space-between; align-items:center; gap:10px; padding:6px 12px 0; border-bottom:1px solid #d9dce1; flex:0 0 auto; background:#f4f5f7; }
    #pb-preview-header .btn{ background:#2d89ef; color:#fff; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; text-decoration:none; font-size:14px; }
    #pb-preview-header .btn.secondary{ background:#6c757d; }
    #pb-header-right{ display:flex; gap:8px; align-items:center; padding-bottom:6px; flex:0 0 auto; }
    #pb-tabs{ display:flex; align-items:flex-end; gap:4px; min-width:0; flex:1 1 auto; }
    #pb-tabs .pb-tab{ background:#e4e7ec; color:#333; border:1px solid #d9dce1; border-bottom:0; border-radius:8px 8px 0 0; padding:8px 16px; font-size:14px; font-weight:600; cursor:pointer; flex:0 0 auto; margin-bottom:-1px; }
    #pb-tabs .pb-tab:hover{ background:#eef0f3; }
    #pb-tabs .pb-tab.is-active{ background:#fff; color:#0b5ed7; border-bottom:1px solid #fff; }
    #pb-tabs .pb-count{ font-weight:500; color:#666; }
    #pb-native-menus{ display:flex; align-items:flex-end; gap:4px; flex:0 0 auto; margin-left:6px; padding-bottom:4px; }
    #pb-native-menus pb-section-modal{ display:block !important; width:auto !important; margin:0 !important; }
    #pb-native-menus button.modal-toggle{ width:auto !important; height:auto !important; min-height:0 !important; padding:5px 10px !important; margin:0 !important; font-size:13px !important; line-height:1.2 !important; display:inline-flex !important; align-items:center; gap:6px; white-space:nowrap; border-radius:6px !important; }
    #pb-native-menus button.modal-toggle .save-icon-align{ width:auto !important; height:auto !important; margin:0 !important; display:inline-flex; }
    #pb-native-menus button.modal-toggle svg{ width:16px !important; height:16px !important; }
    #pb-native-menus button.modal-toggle .icon-container{ display:none !important; }
    html.pb-panel-open .cdk-overlay-container{ z-index:1000002 !important; }
    html.pb-silent .cdk-overlay-container{ visibility:hidden !important; }
    /* Dialogerna (Sökningar/Sparade) visas över högerpanelen, med sin ursprungliga bredd */
    html.pb-panel-open .cdk-global-overlay-wrapper, html.pb-panel-open .cdk-overlay-backdrop{ left:34vw !important; width:auto !important; right:0 !important; }
    /* Dialogbredd: 40 % av högerfönstret (66vw) */
    html.pb-panel-open .cdk-overlay-pane{ width:calc(66vw * 0.4) !important; max-width:none !important; }
    #pb-preview .title{ font-size:13px; color:#555; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 8px 8px; min-width:0; }
    /* Högerfönstret är alltid öppet, därför ingen Stäng-knapp */
    #pb-close{ display:none !important; }
    /* "Sortera efter" ligger under raden med antal annonser och jobb */
    pb-section-search-metadata .metadata-container{ min-height:0 !important; padding-top:6px !important; padding-bottom:6px !important; flex-direction:column !important; align-items:flex-start !important; gap:0 !important; }
    html body .pb-sort-moved .btn-group .dropdown-menu.dropdown-menu-right, html body .pb-sort-moved .dropdown-menu.show{ left:0 !important; right:auto !important; inset:100% auto auto 0 !important; }
    /* Sökfältet får inte sträcka sig in under högerfönstret */
    pb-feature-search .input-container, pb-section-search-input{ max-width:calc(34vw - 30px) !important; }
    .pb-tail-hide{ display:none !important; }
    .pb-sort-moved{ display:flex !important; align-items:center !important; justify-content:flex-start !important; flex:0 0 auto !important; margin:0 !important; padding-top:0 !important; max-width:34vw !important; }
    /* Sidhuvudet ryms i vänsterfönstret: Sök och Meny vänsterjusteras så att högerfönstret inte döljer dem */
    header .header-nav .container{ max-width:34vw !important; margin-left:0 !important; margin-right:0 !important; flex-wrap:wrap !important; }
    header, header .sv-template-portlet, header .sv-script-portlet, header nav.header-nav, header .header-nav .container{ height:auto !important; min-height:69px !important; }
    header .functions-nav{ flex-wrap:wrap !important; justify-content:flex-start !important; margin-left:0 !important; width:100% !important; }
    /* Menyn som öppnas med Meny ser ut som vanligt men använder högerfönstrets vänsterkant som skärmens högerkant */
    nav.main-menu__wrapper{ right:66vw !important; }
    /* Välkomstvy när ingen annons visas */
    #pb-welcome{ display:none; position:relative; flex:1 1 auto; min-height:0; overflow-y:auto; background:#fff; padding:0 24px 40px; }
    #pb-preview[data-tab="ad"][data-ad="none"] #pb-welcome{ display:block; }
    #pb-preview[data-ad="none"] #pb-preview-iframe{ display:none; }
    #pb-welcome .pbw-in{ position:relative; max-width:1100px; margin:0 auto; font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; color:#1b2330; }
    #pb-welcome .pbw-arrow{ position:absolute; top:0; width:0; }
    #pb-welcome .pbw-arrow::before{ content:""; position:absolute; left:-2px; top:12px; bottom:0; width:4px; border-radius:2px; background:#0b5ed7; }
    #pb-welcome .pbw-arrow::after{ content:""; position:absolute; left:-9px; top:0; border-left:9px solid transparent; border-right:9px solid transparent; border-bottom:14px solid #0b5ed7; }
    #pb-welcome .pbw-label{ position:absolute; max-width:min(440px,calc(100% - 24px)); padding:10px 14px; background:#eef4ff; border:1px solid #b9d0fb; border-radius:10px; }
    #pb-welcome .pbw-label b{ display:block; color:#0b5ed7; font-size:15px; margin-bottom:2px; }
    #pb-welcome .pbw-text{ position:absolute; left:0; right:0; max-width:680px; font-size:16px; line-height:1.55; }
    #pb-welcome .pbw-text p{ margin:0 0 14px; }
    #pb-welcome .pbw-text ol{ margin:0 0 14px; padding-left:24px; }
    #pb-welcome .pbw-text li{ margin-bottom:8px; }
    #pb-preview-iframe{ width:100%; border:0; flex:1 1 auto; min-height:0; }
    #pb-kartotek-host{ display:none; flex:1 1 auto; min-height:0; position:relative; }
    #pb-preview[data-tab="kartotek"] #pb-preview-iframe, #pb-preview[data-tab="kartotek"] .title{ display:none; }
    #pb-preview[data-tab="kartotek"] #pb-kartotek-host{ display:block; }
    #pb-kart-edge{ position:fixed; right:0; top:34%; z-index:999999; writing-mode:vertical-rl; background:#0b5ed7; color:#fff; border:0;
      border-radius:10px 0 0 10px; padding:14px 8px; font-size:14px; font-weight:600; cursor:pointer; box-shadow:-2px 2px 10px rgba(0,0,0,.25); display:none; }
    #pb-kart-edge:hover{ background:#094cb7; }
    #pb-notice{ position:fixed; right:16px; bottom:16px; z-index:1000002; display:none; align-items:center; gap:14px; max-width:min(460px,calc(100vw - 32px));
      padding:10px 14px; background:#1b2330; color:#fff; border-radius:8px; box-shadow:0 6px 24px rgba(0,0,0,.35); font-size:14px; }
    #pb-notice button{ background:none; border:0; color:#9fc0ff; font-weight:700; text-decoration:underline; cursor:pointer; font-size:14px; padding:0; }

    /* Verktygsfält + donationsrad */
    #pb-tools{ position:sticky; top:10px; width:34vw; box-sizing:border-box; display:flex; flex-direction:column; align-items:flex-start; gap:6px;
      padding:10px 12px 12px; z-index:10; background:#fff; border:1px solid #d9dce1; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,.15);
      max-height:calc(100vh - 20px); overflow-y:auto; }
    #pb-tools.pb-tools-start{ margin:16px 0 24px; }
    #pb-tools .pb-tb-btn{ background:#0b5ed7; color:#fff; border:none; border-radius:10px; padding:8px 12px; cursor:pointer; transition:transform .05s; }
    #pb-tools .pb-tb-btn:hover{ transform:translateY(-1px); }
    #pb-tools .pb-tb-btn.is-active[aria-pressed="true"]{ background:#094cb7; outline:3px solid #0b5ed7; box-shadow:0 0 0 3px #fff inset, 0 0 0 4px rgba(11,94,215,.55); }
    #pb-top-row{ display:grid; grid-template-columns:auto minmax(0,1fr) auto; column-gap:8px; row-gap:6px; width:100%; align-items:start; }
    #pb-tool-buttons{ grid-column:1; grid-row:1; display:flex; flex-wrap:nowrap; gap:6px; }
    #pb-donate-row{ grid-column:3; grid-row:1 / span 2; margin-left:10px; align-self:start; }
    #pbp-tb-slot{ grid-column:2; grid-row:1; align-self:center; justify-self:center; }
    #pbp-tb-slot .pbp-chip{ height:38px; padding:0 12px; font-size:15px; border-radius:19px; }
    #pbp-tb-slot .pbp-dot{ width:15px; height:15px; }
    #pb-filter-head{ grid-column:1 / 3; grid-row:2; min-width:0; }
    #pb-filter-rest{ grid-column:1 / -1; grid-row:3; min-width:0; }
    @media (max-width:1399px){
      #pb-donate-row{ grid-column:1 / -1; grid-row:2; margin-left:0; justify-self:start; }
      #pbp-tb-slot{ grid-column:3; justify-self:end; }
      #pb-filter-head{ grid-column:1 / -1; grid-row:3; }
      #pb-filter-rest{ grid-row:4; }
    }
    #pb-tool-buttons .pb-tb-btn{ font-size:clamp(11px,.7vw,13px); padding:.55em .8em; white-space:nowrap; flex:0 0 auto; }
    #pb-donate-row{ display:flex; flex-direction:column; align-items:flex-start; gap:4px; flex:0 0 auto; padding:6px; border:1px solid #d9dce1; border-radius:10px; background:#fafafa; }
    #pb-donate-btn{ font-size:clamp(10px,.62vw,12px) !important; padding:.5em .7em !important; white-space:nowrap; }
    #pb-hide-donate-wrap{ font-size:11px; color:#000; display:flex; align-items:center; gap:4px; white-space:nowrap; }

    /* Paginering: placera i metadata-container, horisontell, 34vw */
    nav[aria-label*="Paginering" i],
    nav[aria-label*="pagination" i],
    nav[aria-label*="Sida" i]:not(.main-menu__wrapper),
    nav.digi-navigation-pagination__pagination {
      box-sizing:border-box !important;
      display:flex !important; flex-direction:row !important; align-items:center !important;
      justify-content:flex-start !important; flex-wrap:wrap !important; gap:.4rem !important;
      width:34vw !important; max-width:34vw !important; margin:6px 0 0 0 !important;
    }
    nav[aria-label*="Paginering" i] ul, nav[aria-label*="Paginering" i] ol,
    nav[aria-label*="pagination" i] ul,  nav[aria-label*="pagination" i] ol,
    nav[aria-label*="Sida" i]:not(.main-menu__wrapper) ul,        nav[aria-label*="Sida" i]:not(.main-menu__wrapper) ol,
    nav.digi-navigation-pagination__pagination ul, nav.digi-navigation-pagination__pagination ol {
      display:flex !important; flex-direction:row !important; flex-wrap:wrap !important; gap:.4rem !important;
      list-style:none !important; margin:0 !important; padding:0 !important;
    }
    nav[aria-label*="Paginering" i] li,
    nav[aria-label*="pagination" i] li,
    nav[aria-label*="Sida" i]:not(.main-menu__wrapper) li,
    nav.digi-navigation-pagination__pagination li {
      display:inline-flex !important; align-items:center !important;
    }
    nav[aria-label*="Paginering" i] a, nav[aria-label*="Paginering" i] button,
    nav[aria-label*="pagination" i] a,  nav[aria-label*="pagination" i] button,
    nav[aria-label*="Sida" i]:not(.main-menu__wrapper) a,        nav[aria-label*="Sida" i]:not(.main-menu__wrapper) button,
    nav.digi-navigation-pagination__pagination a, nav.digi-navigation-pagination__pagination button {
      display:inline-flex !important; flex:0 0 auto !important;
    }
  `;
  document.documentElement.appendChild(Object.assign(document.createElement('style'), { textContent: css }));

  /* ================= HELPERS ================= */
  const getCards = () => [...document.querySelectorAll('.card-container')];
  const getJobId = (card) => card.querySelector('a[href*="/platsbanken/annonser"]')?.getAttribute('href');
  const SAVE_BTN_SEL = 'pb-feature-save-job button, button#save-ad-btn';
  // Sparad: etiketten/texten säger "annonsen är sparad" / "Sparad annons". Osparad: "spara annons".
  function saveState(btn) {
    const s = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.textContent || '')).toLowerCase();
    if (s.includes('sparad')) return true;
    if (s.includes('spara')) return false;
    return null;
  }
  const isSaved = (card) => {
    const b = card.querySelector(SAVE_BTN_SEL);
    if (b) { const s = saveState(b); if (s !== null) return s; }
    const t = card.querySelector('.save-button-text')?.textContent?.toLowerCase() || '';
    return t.includes('sparad') || !!card.querySelector('button[aria-pressed="true"]');
  };

  /* ================= PREVIEW + KARTOTEK ================= */
  let panel, iframe, titleEl, kartHost, edgeTab, noticeEl, noticeTimer;
  let kartCtrl = null, activeTab = 'ad', kartCount = 0, kartSubscribed = false;
  const KB = () => window.PBKartotek;

  function ensurePanel(){
    if(panel && document.body.contains(panel)) return;
    panel = document.createElement('div');
    panel.id = 'pb-preview';
    panel.dataset.tab = 'ad';
    panel.dataset.ad = 'none';
    panel.innerHTML = `
      <div id="pb-preview-header">
        <div id="pb-tabs" role="tablist">
          <button type="button" class="pb-tab is-active" data-tab="ad" role="tab">Annons</button>
          <button type="button" class="pb-tab" data-tab="kartotek" role="tab">Kartotek <span class="pb-count"></span></button>
          <div id="pb-native-menus"></div>
          <div class="title"></div>
        </div>
        <div id="pb-header-right">
          <span class="pbp-slot"></span>
          <button id="pb-close" class="btn">Stäng</button>
        </div>
      </div>
      <iframe id="pb-preview-iframe"></iframe>
      <div id="pb-welcome"><div class="pbw-in" id="pbw-in"></div></div>
      <div id="pb-kartotek-host"></div>
    `;
    document.body.appendChild(panel);
    iframe = panel.querySelector('#pb-preview-iframe');
    titleEl = panel.querySelector('.title');
    kartHost = panel.querySelector('#pb-kartotek-host');
    kartCtrl = null; // värden är ny, kartoteket monteras om vid behov
    panel.querySelector('#pb-close').addEventListener('click', closePanel);
    panel.querySelector('#pb-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('.pb-tab'); if (b) setTab(b.dataset.tab);
    });

    edgeTab = document.getElementById('pb-kart-edge');
    if (!edgeTab) {
      edgeTab = document.createElement('button');
      edgeTab.id = 'pb-kart-edge'; edgeTab.type = 'button';
      edgeTab.addEventListener('click', () => openPanel('kartotek'));
      document.body.appendChild(edgeTab);
    }
    if (KB() && !kartSubscribed) {
      kartSubscribed = true;
      KB().subscribe((m) => { kartCount = m.size; updateKartLabels(); });
    }
    PBW.build();
    updateKartLabels(); updateEdge();
  }
  // Platsbankens egna "Sökningar"/"Sparade"-knappar flyttas in i panelen medan den är öppen
  const movedMenus = [];
  function adoptNativeMenus(){
    if (!panel) return;
    const host = panel.querySelector('#pb-native-menus'); if (!host) return;
    for (const el of document.querySelectorAll('pb-section-modal')) {
      if (host.contains(el)) continue;
      const ph = document.createComment('pb-menu'); el.before(ph);
      movedMenus.push({ el, ph }); host.appendChild(el);
    }
  }
  function restoreNativeMenus(){
    for (const { el, ph } of movedMenus.splice(0)) {
      if (ph.isConnected) ph.replaceWith(el);
      else { const a = document.querySelector('aside.pb-toolbar'); if (a) a.appendChild(el); }
    }
  }
  function updateKartLabels(){
    const txt = kartCount ? '(' + kartCount + ')' : '';
    if (panel) { const c = panel.querySelector('.pb-count'); if (c) c.textContent = txt; }
    if (edgeTab) edgeTab.textContent = 'Kartotek ' + txt;
    requestAnimationFrame(() => PBW.place());
  }
  function updateEdge(){
    if (!edgeTab) return;
    edgeTab.style.display = (KB() && !(panel && panel.classList.contains('pb-open'))) ? 'block' : 'none';
  }

  /* ---------- Välkomstvy (när ingen annons visas) ---------- */
  const PBW = (() => {
    function build(){
      const root = document.getElementById('pbw-in'); if (!root) return;
      root.innerHTML = `
        <div class="pbw-arrow" id="pbw-a1"></div><div class="pbw-arrow" id="pbw-a2"></div>
        <div class="pbw-label" id="pbw-l2"><b>Kartotek</b></div>
        <div class="pbw-label" id="pbw-l1"><b>Annons</b></div>
        <div class="pbw-text" id="pbw-g">
          <p>I högerfönstret kan man växla mellan att visa aktuell annons och kartoteket.<br>Alla sparade annonser hamnar i kartoteket.</p>
          <p>Det finns två nya sätt att dölja annonser på:</p>
          <ol>
            <li>Med ordfiltreringen där du lägger till ord i listan. Det kan du göra genom att antingen skriva ett ord i rutan och trycka enter, eller markera ett ord i annonsen och klicka på "Filtrera". Alla annonser som innehåller filterorden döljs automatiskt.</li>
            <li>Med "Dölj"-knappen på vardera annons. Då döljs den individuella annonsen.</li>
          </ol>
          <p>Högst upp i filterrutan kan man växla och visa annonser efter normal vy, dolda eller sparade.</p>
          <p>Skapa en profil för att skilja dina egna filterord och sparade annonser från någon annan.</p>
          <p>Man kan exportera/importera filterord, dolda och sparade annonser till och från datorn.</p>
        </div>`;
    }
    function place(){
      const root = document.getElementById('pbw-in'); if (!root || !panel || !root.offsetParent) return;
      const r0 = root.getBoundingClientRect();
      const t1 = panel.querySelector('.pb-tab[data-tab="ad"]'), t2 = panel.querySelector('.pb-tab[data-tab="kartotek"]');
      if (!t1 || !t2) return;
      const cx = (t) => { const b = t.getBoundingClientRect(); return b.left + b.width / 2 - r0.left; };
      const x1 = Math.max(10, cx(t1)), x2 = Math.max(x1 + 60, cx(t2));
      const a1 = root.querySelector('#pbw-a1'), a2 = root.querySelector('#pbw-a2'), l1 = root.querySelector('#pbw-l1'), l2 = root.querySelector('#pbw-l2'), g = root.querySelector('#pbw-g');
      const T2 = 52, H2 = l2.offsetHeight, T1 = T2 + H2 + 18, H1 = l1.offsetHeight;
      a2.style.left = x2 + 'px'; a2.style.height = (T2 + 20) + 'px';
      l2.style.left = Math.max(0, x2 - 16) + 'px'; l2.style.top = T2 + 'px';
      a1.style.left = x1 + 'px'; a1.style.height = (T1 + 20) + 'px';
      l1.style.left = Math.max(0, x1 - 16) + 'px'; l1.style.top = T1 + 'px';
      const top = T1 + H1 + 36;
      g.style.top = top + 'px';
      root.style.minHeight = (top + g.offsetHeight + 20) + 'px';
    }
    return { build, place };
  })();
  function setTab(tab){
    ensurePanel();
    if (tab === 'kartotek' && !KB()) tab = 'ad';
    activeTab = tab;
    panel.dataset.tab = tab;
    for (const b of panel.querySelectorAll('.pb-tab')) {
      const on = b.dataset.tab === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (tab === 'kartotek') {
      if (!kartCtrl) kartCtrl = KB().mount(kartHost, { openAd: (url, t) => openPreview(url, t), getSaved: readSaved });
      requestAnimationFrame(() => kartCtrl && kartCtrl.onShow());
    }
    requestAnimationFrame(() => PBW.place());
  }
  function openPanel(tab){
    ensurePanel();
    panel.classList.add('pb-open');
    document.documentElement.classList.add('pb-panel-open');
    adoptNativeMenus();
    updateEdge();
    setTab(tab);
  }
  function closePanel(){
    if (!panel) return;
    panel.classList.remove('pb-open');
    document.documentElement.classList.remove('pb-panel-open');
    restoreNativeMenus();
    iframe.removeAttribute('src'); panel.dataset.ad = 'none';
    updateEdge();
  }
  function openPreview(url, titleText){
    ensurePanel();
    iframe.src = url; panel.dataset.ad = 'yes';
    titleEl.textContent = titleText || '';
    openPanel('ad');
  }
  window.addEventListener('resize', () => PBW.place());
  window.addEventListener('keydown', (e) => {
    if (!panel || !panel.classList.contains('pb-open')) return;
    if (e.key === 'Escape') {
      if (activeTab === 'kartotek' && kartCtrl && kartCtrl.escape()) return;
      // högerfönstret är alltid öppet: Esc stänger det inte
    } else if (e.key === '/' && activeTab === 'kartotek' && kartCtrl && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = (typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target);
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault(); kartCtrl.focusSearch();
    }
  });

  // Liten bekräftelse nere till höger
  function notice(msg, act){
    if (!noticeEl) { noticeEl = document.createElement('div'); noticeEl.id = 'pb-notice'; noticeEl.setAttribute('role', 'status'); document.body.appendChild(noticeEl); }
    noticeEl.textContent = '';
    const s = document.createElement('span'); s.textContent = msg; noticeEl.appendChild(s);
    if (act) { const b = document.createElement('button'); b.type = 'button'; b.textContent = act.label; b.addEventListener('click', () => { noticeEl.style.display = 'none'; act.fn(); }); noticeEl.appendChild(b); }
    noticeEl.style.display = 'flex';
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { noticeEl.style.display = 'none'; }, act ? 7000 : 4000);
  }

  /* ================= FAVORIT -> KARTOTEKSKORT ================= */
  // Platsbankens egen lista över sparade annonser (ligger i sidans localStorage)
  // "Ansökt" lagras av Platsbanken i en egen lista med annons-id (inte på de sparade annonserna)
  function readApplied(){
    try { const a = JSON.parse(localStorage.getItem('platsbanken.appliedJobs') || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
  }
  function readSaved(){
    let list = [];
    try { const a = JSON.parse(localStorage.getItem('platsbanken.savedAds') || '[]'); list = Array.isArray(a) ? a.filter(x => x && x.id) : []; } catch {}
    const ap = new Set(readApplied());
    return list.map(x => Object.assign({}, x, { isApplied: ap.has(String(x.id)) }));
  }
  // Fångar sparande/borttag/ansökt även från "sparade annonser"-rutan i sidhuvudet.
  // Stora ändringar på en gång (t.ex. utloggning som tömmer listan) ignoreras, så inga kort försvinner av misstag.
  let savedSnap = null;
  function pollSaved(){
    const K = KB(); if (!K) return;
    const map = new Map(readSaved().map(x => [String(x.id), x]));
    if (savedSnap) {
      const added = [...map.keys()].filter(i => !savedSnap.has(i));
      const removed = [...savedSnap.keys()].filter(i => !map.has(i));
      if (added.length && added.length <= 2) added.forEach(i => handleSaveChange(i, true, null, map.get(i)));
      if (removed.length === 1) handleSaveChange(removed[0], false, null);
      map.forEach((it, i) => { const o = savedSnap.get(i); if (o && !!o.isApplied !== !!it.isApplied) K.setApplied(i, !!it.isApplied); });
    }
    savedSnap = map;
  }
  // Kartotek -> Platsbanken: sätt "Ansökt" på Platsbankens sida. Sidan håller listan i minnet och läser inte om
  // localStorage, så vi kryssar i rutan i den (osynliga) sparade-dialogen. Misslyckas det skrivs listan direkt.
  let pbApplyChain = Promise.resolve();
  const setPbApplied = (adId, on) => (pbApplyChain = pbApplyChain.then(() => setPbAppliedNow(String(adId), !!on)).catch(() => {}));
  async function setPbAppliedNow(id, on){
    if (readApplied().includes(id) === on) return;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const isSaved = readSaved().some(x => String(x.id) === id);
    const dialogOpen = !!document.querySelector('.cdk-overlay-container mat-dialog-container');
    if (isSaved && !dialogOpen) {
      const holder = [...document.querySelectorAll('pb-section-modal')].find(m => /sparad/i.test(m.textContent || ''));
      const toggle = holder && holder.querySelector('button');
      if (toggle) {
        document.documentElement.classList.add('pb-silent');
        try {
          toggle.click();
          let cb = null;
          for (let i = 0; i < 25 && !cb; i++) {
            await sleep(100);
            for (const li of document.querySelectorAll('.cdk-overlay-container pb-feature-saved-jobs-list-item')) {
              const a = li.querySelector('a[href]');
              if (a && new RegExp('/' + id + '(\\D|$)').test(a.getAttribute('href') || '')) { cb = li.querySelector('input[type="checkbox"]'); break; }
            }
          }
          if (cb && cb.checked !== on) cb.click();
          await sleep(200);
          const close = [...document.querySelectorAll('.cdk-overlay-container mat-dialog-container button')].find(b => /Stäng/.test(b.textContent || ''));
          if (close) close.click();
          await sleep(300);
        } finally { document.documentElement.classList.remove('pb-silent'); }
      }
    }
    if (readApplied().includes(id) !== on) {
      const s = new Set(readApplied()); if (on) s.add(id); else s.delete(id);
      try { localStorage.setItem('platsbanken.appliedJobs', JSON.stringify([...s])); } catch {}
    }
  }
  let appliedPrev = null, appliedSyncOn = false;
  function startAppliedSync(){
    const K = KB(); if (!K || appliedSyncOn) return; appliedSyncOn = true;
    K.subscribe((m) => {
      const cur = new Map();
      for (const c of m.values()) if (c && c.adId) cur.set(String(c.adId), !!c.applied);
      if (appliedPrev) for (const [id, v] of cur) if (appliedPrev.has(id) && appliedPrev.get(id) !== v) setPbApplied(id, v);
      appliedPrev = cur;
    });
  }
  function adFromCard(card, id){
    const q = (s) => (card && card.querySelector(s)?.textContent || '').trim();
    return { adId: id, title: q('a[href*="/platsbanken/annonser/"]'), company: q('.pb-company-name'), place: q('.pb-workplaces'), hours: '', deadline: null, description: '', applyUrl: '' };
  }
  async function handleSaveChange(adId, saved, card, savedItem){
    const K = KB(); if (!K || !adId) return;
    if (saved) {
      let data = null;
      for (let i = 0; i < 2 && !data; i++) data = await K.fetchAd(adId);
      if (!data) data = savedItem ? K.dataFromSaved(savedItem) : adFromCard(card, adId);
      if (savedItem && savedItem.isApplied) data.applied = K.todayISO();
      const r = await K.addFromAd(data);
      if (r.status === 'added') notice('Lade till kort i kartoteket: ' + (data.title || 'annons'), { label: 'Öppna', fn: () => openPanel('kartotek') });
    } else {
      const old = await K.removeByAd(adId);
      if (old) notice('Kortet togs bort från kartoteket.', { label: 'Ångra', fn: () => K.restoreCard(old) });
    }
  }
  // Körs både i huvudsidan och i förhandsvisningens iframe
  function installSaveHook(sink){
    const SEL = 'pb-feature-save-job button, button#save-ad-btn'; // egen kopia: i iframes hinner de övriga konstanterna inte skapas
    const findBtn = (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      for (const n of path) if (n && n.tagName === 'BUTTON' && (n.id === 'save-ad-btn' || (n.closest && n.closest('pb-feature-save-job')))) return n;
      return null;
    };
    document.addEventListener('click', (e) => {
      const btn = findBtn(e); if (!btn) return;
      const card = btn.closest('.card-container');
      const href = card?.querySelector('a[href*="/platsbanken/annonser/"]')?.getAttribute('href') || location.pathname;
      const m = /annonser\/(\d+)/.exec(href || ''); if (!m) return;
      const before = saveState(btn);
      const cur = () => (card ? card.querySelector(SEL) : document.querySelector(SEL)) || btn;
      let tries = 0;
      const check = () => {
        const now = saveState(cur());
        if (now !== null && now !== before) { sink(m[1], now, card); return; }
        if (++tries < 5) setTimeout(check, 500);
      };
      setTimeout(check, 500);
    }, true);
  }
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.pbKartotek !== true) return;
    handleSaveChange(String(d.adId || ''), !!d.saved, null);
  });
  installSaveHook(handleSaveChange);


  /* ================= ALLA ANNONSER I SÖKNINGEN ================= */
  // Platsbanken hämtar 25 annonser per sida via /jobs/v1/search, och API:t lämnar högst 2 100 per sökning.
  // Den här koden körs i SIDANS egen värld (inte tilläggets) och gör tre saker:
  //  1. Stora sökningar delas upp i datumfönster som var och en ryms under gränsen, så ALLA träffar går att hämta.
  //  2. Annonser hämtas stegvis (200 i taget) när du scrollar ned. Platsbankens egen lista ritar dem.
  //  3. Dolda annonser och annonser med dina filterord tas bort redan i hämtningen, så de aldrig ritas.
  function injectLoadAll() {
    const code = '(' + function (CHUNK, LIMIT, STEP) {
      if (window.__pbLoadAll) return;
      window.__pbLoadAll = true;
      const SEARCH = '/jobs/v1/search';
      const FILTER = { ids: new Set(), shown: new Set(), words: [], invert: false };
      let cap = STEP, state = null, filterReady = null, gotFilter = false;
      filterReady = new Promise((res) => { window.__pbFilterGo = res; setTimeout(res, 1500); });
      window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data) return;
        const d = e.data;
        if (d.pbMore) cap += STEP;
        if (d.pbFilter) {
          FILTER.ids = new Set((d.pbFilter.ids || []).map(String));
          FILTER.shown = new Set((d.pbFilter.shown || []).map(String));
          FILTER.words = (d.pbFilter.words || []).map((w) => String(w).toLowerCase());
          FILTER.invert = !!d.pbFilter.invert;
          gotFilter = true; window.__pbFilterGo();
        }
      });
      const post = (url, body) => fetch(url, {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body)
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const textOf = (a) => [a.title, a.employerName, a.occupation].concat(a.workplaces || [a.workplace]).join(' ').toLowerCase();
      const blocked = (a) => {
        if (FILTER.ids.has(String(a.id))) return true;
        if (FILTER.shown.has(String(a.id))) return false;
        if (FILTER.words.length) { const t = textOf(a); for (const w of FILTER.words) if (w && t.indexOf(w) >= 0) return true; }
        return false;
      };
      // Vanligt läge: släpp igenom allt som INTE är blockerat. "Endast dolda": släpp bara igenom det blockerade.
      const passes = (a) => (FILTER.invert ? blocked(a) : !blocked(a));
      const iso = (ms) => new Date(ms).toISOString();

      async function makePlan(st) {
        const count = (f, t) => post(st.url, Object.assign({}, st.base, { fromDate: f, toDate: t, maxRecords: 0, startIndex: 0 })).then((j) => (j ? Number(j.numberOfAds) || 0 : 0));
        const total = await count(null, st.to);
        st.total = total;
        if (total <= LIMIT) { st.leaves = total ? [{ f: null, t: st.to, n: total }] : []; return; }
        const split = async (f, t, n) => {
          if (n <= LIMIT || t - f < 36e5) return n > 0 ? [{ f: iso(f), t: iso(t), n: Math.min(n, LIMIT) }] : [];
          const m = Math.floor((f + t) / 2);
          const ab = await Promise.all([count(iso(f), iso(m)), count(iso(m), iso(t))]);
          const parts = await Promise.all([split(m, t, ab[1]), split(f, m, ab[0])]); // nyast först
          return parts[0].concat(parts[1]);
        };
        const to = Date.parse(st.to), lb = to - 400 * 864e5, lb2 = to - 3650 * 864e5;
        const nr = await Promise.all([count(iso(lb), st.to), count(iso(lb2), iso(lb)), count(null, iso(lb2))]);
        const recent = await split(lb, to, nr[0]);
        const older = await split(lb2, lb, nr[1]);
        st.leaves = recent.concat(older, nr[2] > 0 ? [{ f: null, t: iso(lb2), n: Math.min(nr[2], LIMIT) }] : []);
      }
      async function fill(st, want) {
        while (!st.exhausted) {
          let vis = 0;
          for (const a of st.raw) if (passes(a)) vis++;
          if (vis > want) break; // en extra så vi vet att det finns mer
          const jobs = [];
          while (jobs.length < 4 && st.li < st.leaves.length) {
            const lf = st.leaves[st.li];
            jobs.push({ lf, off: st.off });
            st.off += CHUNK;
            if (st.off >= lf.n) { st.li++; st.off = 0; }
          }
          if (!jobs.length) { st.exhausted = true; break; }
          const parts = await Promise.all(jobs.map((j) => post(st.url, Object.assign({}, st.base, { fromDate: j.lf.f, toDate: j.lf.t, startIndex: j.off, maxRecords: Math.min(CHUNK, j.lf.n - j.off) }))));
          for (const p of parts) for (const a of ((p && p.ads) || [])) if (!st.ids.has(a.id)) { st.ids.add(a.id); st.raw.push(a); }
          if (st.li >= st.leaves.length) st.exhausted = true;
        }
      }

      const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
      const rt = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
      const rs = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
      XMLHttpRequest.prototype.open = function (m, u) {
        this.__pb = (String(m).toUpperCase() === 'POST' && String(u).indexOf(SEARCH) >= 0) ? { url: String(u) } : null;
        return open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        const st = this.__pb, xhr = this, args = arguments;
        if (!st) return send.apply(this, args);
        let req;
        try { req = JSON.parse(body); } catch (e) { return send.apply(this, args); }
        if (!req || !(req.maxRecords > 0) || req.source !== 'pb') { st.skip = true; return send.apply(this, args); }
        const base = Object.assign({}, req);
        delete base.startIndex; delete base.maxRecords; delete base.toDate; delete base.fromDate;
        const key = JSON.stringify(base) + '|' + req.toDate;
        if (!state || state.key !== key) {
          state = { key, url: st.url, base, to: req.toDate || new Date().toISOString(), raw: [], ids: new Set(), li: 0, off: 0, exhausted: false, total: 0, leaves: null, q: Promise.resolve() };
          cap = STEP;
        }
        const s = state;
        s.q = s.q.then(async () => {
          await filterReady;
          if (!s.leaves) await makePlan(s);
          await fill(s, cap);
          const pass = s.raw.filter(passes);
          st.ads = pass.slice(0, cap);
          st.total = s.total;
          st.msg = { pbTotal: s.total, pbShown: st.ads.length, pbFiltered: s.raw.length - pass.length, pbMore: pass.length > cap || !s.exhausted };
          send.call(xhr, JSON.stringify(Object.assign({}, req, { startIndex: 0, maxRecords: 1 })));
        }).catch(() => { st.skip = true; send.apply(xhr, args); });
      };
      function merge(xhr, v) {
        const st = xhr.__pb;
        if (!st || st.skip || !st.ads) return v;
        const isStr = typeof v === 'string';
        let j = v;
        try { if (isStr) j = JSON.parse(v); } catch (e) { return v; }
        if (!j || !Array.isArray(j.ads)) return v;
        if (st.src === v && st.out) return st.out;
        const o = Object.assign({}, j, { ads: st.ads, numberOfAds: st.total });
        st.src = v; st.out = isStr ? JSON.stringify(o) : o;
        try { window.postMessage(st.msg, '*'); } catch (e) {}
        return st.out;
      }
      Object.defineProperty(XMLHttpRequest.prototype, 'responseText', { get() { return merge(this, rt.get.call(this)); }, configurable: true });
      Object.defineProperty(XMLHttpRequest.prototype, 'response', { get() { return merge(this, rs.get.call(this)); }, configurable: true });
    }.toString() + ')(100, 2100, 200)';
    try {
      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch {}
  }

  // Skickar dolda annonser och filterord till sidans värld, så att de kan sorteras bort redan vid hämtningen
  let adRefreshTimer = 0;
  function syncAdFilter(refresh) {
    const only = viewMode === 'showHiddenOnly';
    const savedOnly = viewMode === 'showSaved';
    const digits = (h) => (/(\d+)\s*$/.exec(String(h)) || [])[1];
    // "Sparade annonser": bara de sparade annonserna visas, oavsett om de är dolda eller träffas av ett filterord
    const ids = savedOnly ? readSaved().map(x => digits(x.id)).filter(Boolean)
              : ((viewMode === 'normal' || only) ? [...hiddenJobs].map(digits).filter(Boolean) : []);
    const shown = savedOnly ? [] : [...shownJobs].map(digits).filter(Boolean);
    window.postMessage({ pbFilter: { ids, shown, words: savedOnly ? [] : getActiveBlockedWords(), invert: only || savedOnly } }, '*');
    if (refresh) { clearTimeout(adRefreshTimer); adRefreshTimer = setTimeout(refreshAds, 500); }
  }
  // Platsbankens egen sidväxling får appen att söka om (vi byter till en annan sida än den aktiva)
  function refreshAds() {
    const btns = [...document.querySelectorAll('digi-navigation-pagination button')].filter(b => /^[12]$/.test((b.textContent || '').trim()));
    const other = btns.find(b => !/--variation-primary/.test(b.className)) || btns[0];
    if (other) { holdScroll(); other.click(); }
    return !!other;
  }

  // Håller kvar scrollpositionen medan Platsbanken ritar om listan (sidan blir kort en stund och appen kan själv scrolla upp)
  let hold = null;
  function holdScroll() {
    if (hold) return;
    document.body.style.minHeight = document.documentElement.scrollHeight + 'px';
    hold = { y: window.scrollY, expect: null, t0: Date.now(), settle: 0 };
    hold.timer = setInterval(stepHold, 100);
  }
  function releaseHold() {
    if (!hold) return;
    clearInterval(hold.timer);
    document.body.style.minHeight = '';
    hold = null;
  }
  function stepHold() {
    if (!hold) return;
    const now = Date.now();
    if (Math.abs(window.scrollY - hold.y) > 3) window.scrollTo({ top: hold.y, behavior: 'instant' });
    if (hold.expect !== null && getCards().length >= hold.expect) {
      if (!hold.settle) hold.settle = now;
      if (now - hold.settle > 600) releaseHold();
    } else if (now - hold.t0 > 20000) releaseHold();
  }
  // Scrollar användaren under tiden följer positionen med; tangenter och tryck avslutar hållningen
  window.addEventListener('wheel', (e) => {
    if (!hold) return;
    let dy = e.deltaY; if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= window.innerHeight;
    hold.y = Math.max(0, hold.y + dy);
  }, { capture: true, passive: true });
  ['keydown', 'touchstart', 'mousedown'].forEach((ev) => window.addEventListener(ev, () => releaseHold(), { capture: true, passive: true }));

  // Raden längst ned i listan: status, framsteg och "scrollmotstånd" som hämtar fler annonser
  let adTotal = 0, adShown = 0, adMore = false, adFiltered = 0, adBusy = false, adBusyTimer = 0, pull = 0, pullTimer = 0;
  const PULL_NEEDED = 320;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.pbTotal === undefined) return;
    adTotal = Number(e.data.pbTotal) || 0; adMore = !!e.data.pbMore; adFiltered = Number(e.data.pbFiltered) || 0; adShown = Number(e.data.pbShown) || 0;
    if (hold) hold.expect = adShown;
    adBusy = false; clearTimeout(adBusyTimer);
    renderLoadBar();
  });
  function maybeLoadMore() {
    const bar = document.getElementById('pb-loadbar');
    if (!bar || !adMore || adBusy) return;
    adBusy = true; pull = 0;
    adBusyTimer = setTimeout(() => { adBusy = false; renderLoadBar(); }, 25000);
    window.postMessage({ pbMore: true }, '*');
    if (!refreshAds()) { adBusy = false; clearTimeout(adBusyTimer); }
    renderLoadBar();
  }
  function setPull(v) {
    pull = Math.max(0, v);
    const bar = document.getElementById('pb-loadbar');
    if (bar) { bar.style.setProperty('--pull', String(Math.min(100, Math.round(pull / PULL_NEEDED * 100)))); bar.classList.toggle('is-pulling', pull > 0); }
    clearTimeout(pullTimer);
    if (pull > 0) pullTimer = setTimeout(() => setPull(0), 900);
  }
  // Är slutet av listan (raden) i bild, så ger scroll nedåt ett lätt motstånd och sedan hämtas fler annonser
  function pullBar() {
    const bar = document.getElementById('pb-loadbar');
    if (!bar || !adMore || adBusy || hold) return null;
    const r = bar.getBoundingClientRect();
    const inView = r.bottom <= window.innerHeight + 30 && r.bottom > 0;
    if (!inView) { barSeenAt = 0; return null; }
    if (!barSeenAt) barSeenAt = performance.now();
    return bar;
  }
  // Stopp: efter att raden kommit i bild dröjer det 1 sekund innan scroll räknas
  let barSeenAt = 0;
  const PULL_DELAY = 1000;
  window.addEventListener('scroll', () => { pullBar(); }, { passive: true });
  const pullReady = () => !!barSeenAt && performance.now() - barSeenAt >= PULL_DELAY;
  let lastWheelT = 0, pullGesture = false;
  const inPanel = (e) => (typeof e.composedPath === 'function' ? e.composedPath() : []).some(n => n && n.id === 'pb-preview');
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.deltaY <= 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY) || inPanel(e)) return;
    // Momentum från en tidigare scroll (tätt följande hjulhändelser) ska inte räknas: en ny scroll måste börja efter ett uppehåll
    const tw = performance.now(), gapW = tw - lastWheelT; lastWheelT = tw;
    if (!pullBar() || !pullReady()) { pullGesture = false; return; }
    if (!pullGesture) { if (gapW > 120) pullGesture = true; else return; }
    e.preventDefault();
    let dy = e.deltaY; if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= window.innerHeight;
    setPull(pull + Math.min(dy, 120));
    if (pull >= PULL_NEEDED) maybeLoadMore();
  }, { passive: false });
  let touchY = null, touchOk = false;
  window.addEventListener('touchstart', (e) => { touchY = e.touches.length === 1 ? e.touches[0].clientY : null; touchOk = !!pullBar() && pullReady(); }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (touchY === null || inPanel(e) || !pullBar()) return;
    if (!pullReady() || !touchOk) { touchY = e.touches[0].clientY; return; }
    const y = e.touches[0].clientY, dy = touchY - y; touchY = y;
    if (dy <= 0) return;
    if (e.cancelable) e.preventDefault();
    setPull(pull + dy);
    if (pull >= PULL_NEEDED) maybeLoadMore();
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'End' || e.key === 'PageDown' || e.key === ' ') && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') && pullBar() && pullReady() && !inPanel(e)) {
      setPull(pull + 140); if (pull >= PULL_NEEDED) maybeLoadMore();
    }
  }, { passive: true });

  // Så länge fler annonser kan hämtas slutar sidan vid raden: allt som ligger efter (sidfoten) döljs, så det går inte att scrolla förbi
  function hideTail(bar, on){
    let n = bar;
    while (n && n !== document.body && n !== document.documentElement) {
      for (let sib = n.nextElementSibling; sib; sib = sib.nextElementSibling) {
        const keep = /^(SCRIPT|STYLE|LINK|NOSCRIPT)$/.test(sib.tagName) || (sib.id && /^pbp?-/.test(sib.id)) || sib.classList.contains('cdk-overlay-container') || /(^|\s)pb-/.test(sib.className || '') || (sib.querySelector && sib.querySelector('#pb-tools, #pb-preview, .card-container')) || sib.tagName.indexOf('-') > 0 && /^PB-SECTION-MODAL$/.test(sib.tagName);
        if (keep) continue;
        sib.classList.toggle('pb-tail-hide', !!on);
      }
      n = n.parentElement;
    }
  }
  function renderLoadBar() {
    let bar = document.getElementById('pb-loadbar');
    const cards = getCards();
    if (!cards.length || !adTotal) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'pb-loadbar';
      bar.innerHTML = '<div class="pb-lb-main"></div><div class="pb-lb-sub"></div><button type="button" class="pb-lb-btn">Hämta fler nu</button><div class="pb-lb-track"><div class="pb-lb-fill"></div></div>';
      bar.querySelector('.pb-lb-btn').addEventListener('click', maybeLoadMore);
    }
    const last = cards[cards.length - 1];
    if (last.nextElementSibling !== bar) last.insertAdjacentElement('afterend', bar);
    hideTail(bar, adMore);
    const shown = cards.length, hid = cards.filter(c => c.style.display === 'none').length;
    const only = viewMode === 'showHiddenOnly';
    const sig = [shown, hid, adTotal, adFiltered, adMore ? 1 : 0, adBusy ? 1 : 0, only ? 1 : 0].join('|');
    if (bar.dataset.sig === sig) return;
    bar.dataset.sig = sig;
    const nf = (n) => n.toLocaleString('sv-SE');
    bar.classList.toggle('is-busy', adBusy);
    bar.querySelector('.pb-lb-btn').style.display = (adMore && !adBusy) ? '' : 'none';
    const possible = Math.max(0, adTotal - adFiltered);
    bar.querySelector('.pb-lb-main').textContent = (adBusy ? 'Hämtar fler annonser … ' : '') + (only
      ? 'Visar ' + nf(shown) + ' dolda och ordfiltrerade annonser (av ' + nf(adTotal) + ' i sökningen)'
      : 'Visar ' + nf(shown) + ' av ' + nf(adTotal) + ' annonser');
    const extra = [];
    if (adFiltered) extra.push(only ? nf(adFiltered) + ' vanliga annonser hoppas över' : nf(adFiltered) + ' bortfiltrerade av Dölj/filterord');
    if (hid) extra.push(nf(hid) + ' dolda på sidan');
    if (!adMore && !adBusy && !only) {
      bar.querySelector('.pb-lb-sub').textContent = 'Alla annonser är laddade, ' + nf(shown - hid) + ' visas, ' + nf(hid + adFiltered) + ' är dolda.';
      void possible; return;
    }
    bar.querySelector('.pb-lb-sub').textContent = (adBusy ? 'Vänta en stund …' : adMore ? 'Fortsätt scrolla för att ladda fler.' : (only ? 'Hela sökningen är genomsökt.' : 'Alla annonser i sökningen finns på sidan.')) + (extra.length ? ' (' + extra.join(', ') + ')' : '');
    void possible;
  }

  /* ================= HIDE/SHOW ================= */
  function setHideButtonState(card, btn, id){
    const hidden = isEffectivelyHidden(card, id);
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
      if (isEffectivelyHidden(card, cid)) {
        // Visa: ta bort från dolda, och om ett filterord slår på annonsen, åsidosätt ordet för just den här
        hiddenJobs.delete(cid);
        if (isWordMatch(card)) shownJobs.add(cid);
      } else {
        hiddenJobs.add(cid);
        shownJobs.delete(cid);
      }
      saveHidden(); saveShown(); setHideButtonState(card, btn, cid); applyVisibilityForCard(card, cid); syncAdFilter(false);
    });
    wrap.appendChild(btn); header.appendChild(wrap);
  }

  /* ================= TITELLÄNK + FILTRERA ================= */
  const mkLinkSvg = () => {
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1'].forEach((d) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); });
    return svg;
  };
  function selectedTextIn(card){
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    const n = sel.getRangeAt(0).commonAncestorContainer;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    if (!el || !card.contains(el)) return '';
    return sel.toString().replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  function ensureCardTools(card){
    const h3 = card.querySelector('.header-container h3');
    const a = h3 && h3.querySelector('a');
    if (a) a.setAttribute('draggable', 'false');
    // Står titeln på en rad ligger knapparna i höjd med den: lägg till ett radbryts luft så knapparna hamnar under
    if (h3 && a) {
      const hc = h3.closest('.header-container');
      const key = h3.clientWidth + '|' + (a.textContent || '').length + '|' + window.innerWidth;
      if (hc && card.dataset.pbLines !== key) {
        card.dataset.pbLines = key;
        const rg = document.createRange(); rg.selectNodeContents(a);
        const lines = new Set(Array.from(rg.getClientRects()).filter(q => q.width > 0).map(q => Math.round(q.top))).size;
        if (lines <= 1) { hc.style.paddingBottom = Math.max(24, Math.round(a.getBoundingClientRect().height || 30)) + 'px'; hc.dataset.pbOne = '1'; }
        else { hc.style.paddingBottom = ''; delete hc.dataset.pbOne; }
      }
    }
    const wrap = card.querySelector('.pb-hide-btn-wrapper');
    if (wrap && a && !wrap.querySelector('.pb-link-btn')) {
      const lb = document.createElement('button');
      lb.type = 'button'; lb.className = 'pb-link-btn'; lb.title = 'Öppna annonsen'; lb.setAttribute('aria-label', 'Öppna annonsen'); { const sp = document.createElement('span'); sp.textContent = 'Annons'; lb.append(mkLinkSvg(), sp); }
      lb.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const href = a.href || a.getAttribute('href') || ''; if (!isAdLinkHref(href)) return;
        const t = Array.from(a.childNodes).filter(n => n.nodeType === 3).map(n => n.nodeValue).join('').trim() || (a.textContent || '').trim();
        openPreview(href, t);
      });
      wrap.insertBefore(lb, wrap.firstChild);
    }
    if (wrap && !wrap.querySelector('.pb-filter-btn')) {
      const fb = document.createElement('button');
      fb.type = 'button'; fb.className = 'pb-filter-btn'; fb.textContent = 'Filtrera';
      fb.title = 'Markera ett ord eller en fras på annonsen och klicka här för att filtrera bort annonser med det';
      // behåll textmarkeringen när knappen trycks
      fb.addEventListener('mousedown', (e) => e.preventDefault());
      fb.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const t = selectedTextIn(card);
        const flash = (txt, cls) => { fb.textContent = txt; fb.classList.add(cls); setTimeout(() => { fb.textContent = 'Filtrera'; fb.classList.remove(cls); }, 1600); };
        if (!t || t.length < 2) {
          const old = fb.querySelector('.pb-tip'); if (old) old.remove();
          const tip = document.createElement('span'); tip.className = 'pb-tip'; tip.textContent = 'Markera ett ord först';
          fb.appendChild(tip); setTimeout(() => tip.remove(), 1800);
          return;
        }
        addBlockedToken(t);
        const sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges();
        flash('Filtrerar: ' + t.toLowerCase(), 'pb-done');
      });
      const lbx = wrap.querySelector('.pb-link-btn'); wrap.insertBefore(fb, lbx ? lbx.nextSibling : wrap.firstChild);
    }
  }

  /* ================= PAGINATION ================= */
  const META_SEL = 'div.metadata-container, .metadata-container';
  const PAGER_SEL = [
    'nav[aria-label*="Paginering" i]',
    'nav[aria-label*="pagination" i]',
    'nav[aria-label*="Sida" i]:not(.main-menu__wrapper)',
    'nav.digi-navigation-pagination__pagination'
  ].join(',');

  function movePagersIntoMetadata() {
    return; // Platsbankens sidnavigering är dold; alla annonser laddas på en sida
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
    // Ord-blockerade kort döljs hårt (kvar i DOM) så att de kommer tillbaka när ordet tas bort.
    // I läget "Endast dolda" visas de i stället, tillsammans med de annonser man dolt med knappen.
    const wordBlocked = isWordBlocked(card);
    if (wordBlocked && viewMode !== 'showHiddenOnly' && viewMode !== 'showSaved') {
      card.classList.remove('pb-hidden-outline','pb-hidden-saved-outline');
      card.style.setProperty('display', 'none', 'important');
      card.dataset.pbWordBlocked = '1';
      return;
    }
    if (card.dataset.pbWordBlocked) {
      delete card.dataset.pbWordBlocked;
      card.style.removeProperty('display');
    }

    card.classList.remove('pb-hidden-outline','pb-hidden-saved-outline','pb-word-outline');
    const hidden = id && hiddenJobs.has(id);

    if (viewMode==='normal') {
      card.style.display = hidden ? 'none' : '';
    } else if (viewMode==='showAll') {
      card.style.display='';
      if(hidden) card.classList.add('pb-hidden-outline');
    } else if (viewMode==='showSaved') {
      card.style.display='';
      if (hidden) card.classList.add('pb-hidden-outline');
    } else if (viewMode==='showHiddenSaved') {
      const show=hidden&&isSaved(card); card.style.display=show?'':'none'; if(show) card.classList.add('pb-hidden-saved-outline');
    } else if (viewMode==='showHiddenOnly') {
      const show = hidden || wordBlocked;
      card.style.display = show ? '' : 'none';
      if (hidden) card.classList.add('pb-hidden-outline'); else if (wordBlocked) card.classList.add('pb-word-outline');
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
    // startsidan (ingen sökning gjord): filterrutan läggs under sökrutan
    const startBox = !firstCard ? document.querySelector('pb-page-start .section-search-start') : null;
    if (!firstCard && !startBox) return;

    const bar = document.createElement('div');
    bar.id = 'pb-tools';
    bar.innerHTML = `
      <div id="pb-top-row">
        <div id="pb-tool-buttons">
          <button class="pb-tb-btn" data-a="normal">Normalt</button>
          <button class="pb-tb-btn" data-a="showAll">Visa alla</button>
          <button class="pb-tb-btn" data-a="showHiddenOnly">Endast dolda</button>
          <button class="pb-tb-btn" data-a="showSaved">Sparade</button>
        </div>
        <div class="pbp-slot" id="pbp-tb-slot"></div>
        <div id="pb-donate-row">
          <button id="pb-donate-btn" class="pb-tb-btn" style="background:#f7b731;color:#000;">☕ Stöd utvecklaren</button>
          <label id="pb-hide-donate-wrap">
            <input type="checkbox" id="pb-hide-donate"> Dölj permanent
          </label>
        </div>
        <div id="pb-filter-head">
          <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px;">
            Filtrera bort ord <span style="font-weight:500;color:#666">(skriv ord och tryck Enter)</span>
          </label>
          <input id="pb-token-input" type="text" autocomplete="off"
                 placeholder="t.ex. bemanning, säljare, konsult"
                 style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px;">
          <div id="pb-counts" style="margin-top:6px;font-size:13px;color:#333;"></div>
        </div>
        <div id="pb-filter-rest">
          <div id="pb-token-controls" style="display:none;align-items:center;gap:12px;flex-wrap:wrap;">
            <button id="pb-token-toggle" type="button" aria-expanded="false"
                    style="background:none;border:none;padding:2px 0;font-size:13px;color:#0b5ed7;cursor:pointer;text-decoration:underline;"></button>
            <label id="pb-token-sort-wrap" style="display:none;align-items:center;gap:6px;font-size:13px;color:#444;">
              Sortera:
              <select id="pb-token-sort" style="font-size:13px;padding:2px 4px;border:1px solid #ccc;border-radius:6px;background:#fff;">
                <option value="recent">Senast inlagda</option>
                <option value="alpha">A\u2013\u00D6</option>
              </select>
            </label>
          </div>
          <div id="pb-token-list" style="display:none;"></div>
        </div>
      </div>
    `;

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.pb-tb-btn');
      if (!btn || btn.id === 'pb-donate-btn') return;
      const a = btn.dataset.a;
      if (!a) return;
      setViewMode(a);
    });

    const donateRow = bar.querySelector('#pb-donate-row');
    const donateBtn = bar.querySelector('#pb-donate-btn');
    const hideCheck = bar.querySelector('#pb-hide-donate');
    const hiddenDonate = store.pb_hideDonate === true;
    if (hiddenDonate) donateRow.style.display = 'none';
    hideCheck.checked = hiddenDonate;

    donateBtn.addEventListener('click', () => window.open('https://buymeacoffee.com/lowkeylokee', '_blank', 'noopener'));
    hideCheck.addEventListener('change', (e) => {
      const v = !!e.target.checked;
      storeSet('pb_hideDonate', v);
      donateRow.style.display = v ? 'none' : 'flex';
    });

    // token UI
    const tokenInput = bar.querySelector('#pb-token-input');
    const tokenList  = bar.querySelector('#pb-token-list');
    const tokenControls = bar.querySelector('#pb-token-controls');
    const tokenToggle = bar.querySelector('#pb-token-toggle');
    const tokenSortWrap = bar.querySelector('#pb-token-sort-wrap');
    const tokenSortSel = bar.querySelector('#pb-token-sort');
    let tokensExpanded = false;
    let tokenSort = 'recent'; // 'recent' | 'alpha'
    try {
      tokensExpanded = store.pb_tokensExpanded === true;
      const sv = store.pb_tokenSort;
      if (sv === 'recent' || sv === 'alpha') tokenSort = sv;
    } catch {}
    tokenSortSel.value = tokenSort;
    tokenToggle.addEventListener('click', () => {
      tokensExpanded = !tokensExpanded;
      storeSet('pb_tokensExpanded', tokensExpanded);
      renderTokenList();
    });
    tokenSortSel.addEventListener('change', () => {
      tokenSort = tokenSortSel.value === 'alpha' ? 'alpha' : 'recent';
      storeSet('pb_tokenSort', tokenSort);
      renderTokenList();
    });

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
      const total = blockedTokens.length;
      if (!total) {
        tokenList.style.display = 'none';
        tokenControls.style.display = 'none';
        return;
      }

      // Alltid i vald ordning. Minimerat visar bara första raden, expanderat alla.
      const visible = tokenSort === 'alpha'
        ? [...blockedTokens].sort((a, b) => a.word.localeCompare(b.word, 'sv'))
        : [...blockedTokens].reverse();

      const multi = total > 1;
      tokenControls.style.display = 'flex';
      tokenToggle.style.display = multi ? 'inline-block' : 'none';
      tokenSortWrap.style.display = multi ? 'inline-flex' : 'none';
      if (multi) {
        tokenToggle.textContent = tokensExpanded ? 'Minimera \u25B4' : 'Visa alla (' + total + ') \u25BE';
        tokenToggle.setAttribute('aria-expanded', tokensExpanded ? 'true' : 'false');
      }

      if (tokensExpanded && multi) {
        // Expanderat: fullbred ruta under kontrollraden
        tokenControls.insertAdjacentElement('afterend', tokenList);
        tokenList.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;width:100%;box-sizing:border-box;margin-top:8px;max-height:180px;overflow:auto;border:1px solid #e5e7eb;border-radius:8px;background:#fff;padding:8px;';
      } else {
        // Minimerat: taggarna på kontrollraden, till höger om sorteringen
        tokenControls.appendChild(tokenList);
        tokenList.style.cssText = 'display:flex;flex-wrap:wrap;flex:1 1 150px;min-width:0;gap:6px;margin:0;padding:0;border:0;background:none;overflow:hidden;';
      }

      for (const t of visible) {
        const chip = document.createElement('span');
        chip.className = 'pb-token-chip';
        chip.dataset.word = t.word;
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:2px;padding:3px 4px 3px 10px;background:#e8f0fe;border:1px solid #c6d4f0;border-radius:999px;font-size:13px;line-height:1.2;color:#111;';

        const label = document.createElement('span');
        label.textContent = t.word;

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'pb-token-remove';
        del.setAttribute('aria-label', "Ta bort '" + t.word + "'");
        del.style.cssText = 'background:none;border:none;cursor:pointer;padding:0 5px;font-size:14px;line-height:1;color:#555;';
        del.textContent = '\u2715';

        chip.append(label, del);
        tokenList.appendChild(chip);
      }

      // Minimerat läge: dölj taggar som bryts till rad två eller längre
      if (!(tokensExpanded && multi)) {
        const kids = [...tokenList.children];
        if (kids.length) {
          const firstTop = kids[0].offsetTop;
          for (const k of kids) if (k.offsetTop > firstTop + 2) k.style.display = 'none';
        }
      }
    };
    window.addEventListener('resize', () => { if (!tokensExpanded) renderTokenList(); });
    renderTokenList();

    tokenList.addEventListener('click', (e) => {
      const chip = e.target.closest('.pb-token-chip');
      if (!chip) return;
      if (e.target.classList.contains('pb-token-remove')) {
        removeBlockedToken(chip.getAttribute('data-word'));
      }
    });

    if (firstCard) firstCard.parentElement.insertBefore(bar, firstCard);
    else { bar.classList.add('pb-tools-start'); (startBox.closest('.search-container') || startBox).after(bar); }
    renderTokenList();
    updateToolbarState();
  }
  function updateToolbarState(){
    const bar=document.getElementById('pb-tools'); if(!bar) return;
    const ce = bar.querySelector('#pb-counts');
    if (ce) {
      const cs = getCards(), hid = cs.filter(c => c.style.display === 'none').length, vis = cs.length - hid;
      const sig = vis + '|' + hid + '|' + adFiltered;
      if (ce.dataset.sig !== sig) {
        ce.dataset.sig = sig;
        const nf = (n) => n.toLocaleString('sv-SE');
        const hidTot = hid + adFiltered;
        ce.textContent = '';
        { const b1 = document.createElement('b'), b2 = document.createElement('b'); b1.textContent = nf(vis); b2.textContent = nf(hidTot); ce.append(b1, ' visas \u00a0·\u00a0 ', b2, ' dolda'); }
        ce.title = nf(hid) + ' dolda på sidan' + (adFiltered ? ' + ' + nf(adFiltered) + ' som redan filtrerats bort vid hämtningen (Dölj/filterord)' : '');
      }
    }
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
    if (isWordBlocked(card) && viewMode !== 'showHiddenOnly' && viewMode !== 'showSaved') {
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
  // Flyttar Platsbankens "Sortera efter" till en egen rad under "NN annonser med NN jobb"
  function findCountHeading(){
    const el = document.querySelector('pb-feature-search-result-number');
    if (el) return el;
    return Array.from(document.querySelectorAll('h1,h2,h3')).find(h => /annonser\s+med\s+[\d\s\u00a0]+\s*jobb/i.test(h.textContent || '')) || null;
  }
  function moveSortNextToTabs(){
    const sel = Array.from(document.querySelectorAll('pb-section-dropdown-select')).find(e => /sortera/i.test(e.textContent || ''));
    if (!sel) return;
    const sort = sel.closest('.sort') || sel;
    const head = findCountHeading(); if (!head) return;
    if (sort.previousElementSibling === head && sort.classList.contains('pb-sort-moved')) return;
    sort.classList.add('pb-sort-moved');
    head.after(sort);
  }
  function tick(){
    ensureToolbar();
    moveSortNextToTabs();
    if (panel && panel.classList.contains('pb-open')) adoptNativeMenus();
    movePagersIntoMetadata();
    for(const card of getCards()) { ensureHideButtonInHeader(card); ensureCardTools(card); }
    applyVisibility();
    renderLoadBar();
    pullBar();
    updateToolbarState();
    ensurePanel();
    // högerfönstret är alltid öppet
    if (panel && !panel.classList.contains('pb-open')) openPanel(activeTab === 'ad' && !(iframe && iframe.getAttribute('src')) ? 'kartotek' : activeTab);
  }

  storeReady.then(() => whenBodyReady(()=>{
    syncAdFilter(false);
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

    startAppliedSync();
    pollSaved(); setInterval(pollSaved, 1500); window.addEventListener('storage', pollSaved);

    // kickstarta paginerings-flytten flera gånger (olika laddningsvägar)
    let n=0; const kick=setInterval(()=>{ movePagersIntoMetadata(); ensurePanel(); if(++n>8) clearInterval(kick); },250);
  }));
})();
