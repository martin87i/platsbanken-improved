/* Platsbanken Improved – Annonskartotek
 * Kartotekskort på en panorera/zooma-bar yta. Kortens data sparas i tilläggets egen lagring (storage.local).
 * Laddas före content.js och exponerar window.PBKartotek (delad värld mellan tilläggets content scripts). */
(function () {
  'use strict';
  if (window.top !== window.self) return;

  const NS = 'http://www.w3.org/2000/svg';
  const CARD_W = 280, MINW = 200, MAXW = 800, MINZ = 0.02, MAXZ = 2.5, STACK_GAP = 10, COL_GAP = 24;
  const KEY = 'pb_kartotek', VIEW_KEY = 'pb_kartotek_view', SORT_KEY = 'pb_kartotek_sort', BOX_KEY = 'pb_kartotek_boxoff', HUE_KEY = 'pb_kartotek_tagcolors', SHAPE_KEY = 'pb_kartotek_shapes', SIZE_KEY = 'pb_kartotek_sizes', MARK_KEY = 'pb_kartotek_markcolor';
  const AD_API = 'https://platsbanken-api.arbetsformedlingen.se/jobs/v1/job/';
  const AD_URL = 'https://arbetsformedlingen.se/platsbanken/annonser/';

  const api = (typeof browser !== 'undefined' && browser.storage) ? browser
            : (typeof chrome !== 'undefined' && chrome.storage) ? chrome : null;

  /* ================= HJÄLPARE ================= */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ck = (c) => String(c || '').trim().toLowerCase();
  // Taggar: lista av korta texter, unika oavsett versaler
  const tk = (s) => String(s || '').trim().toLowerCase();
  function normTags(v) {
    const raw = Array.isArray(v) ? v : String(v || '').split(/[,;\n]/);
    const out = [], seen = new Set();
    raw.forEach((x) => {
      const s = String(x || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (s && !seen.has(tk(s))) { seen.add(tk(s)); out.push(s); }
    });
    return out;
  }
  const tagsOf = (d) => normTags(d && d.tags);
  const hashHue = (name) => { let h = 2166136261; const s = tk(name); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; return (h >>> 8) % 360; };
  // Taggfärger: varje tagg får den nyans som ligger längst från de som redan används, och färgen sparas så att den
  // ligger fast. Därmed får taggar så långt det går olika färger.
  const tagHues = new Map();
  let hueSaveT = 0, hueReady = false;
  const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const saveHues = () => {
    clearTimeout(hueSaveT);
    hueSaveT = setTimeout(() => { try { const o = {}; tagHues.forEach((v, k) => { o[k] = v; }); if (api) api.storage.local.set({ [HUE_KEY]: o }); else localStorage.setItem(HUE_KEY, JSON.stringify(o)); } catch {} }, 400);
  };
  const tagHue = (name) => {
    const k = tk(name);
    if (tagHues.has(k)) return tagHues.get(k);
    const hh = hashHue(name), used = Array.from(tagHues.values()).concat([210]);   // 210 = rutan "Utan tagg"
    let pick = hh;
    {
      let bd = -1;
      for (let c = 0; c < 360; c += 10) {
        const cand = (c + (hh % 10)) % 360;
        const d = Math.min.apply(null, used.map((u) => hueDist(cand, u)));
        if (d > bd + 0.01) { bd = d; pick = cand; }
      }
    }
    tagHues.set(k, pick); saveHues();
    return pick;
  };
  const rating = (d) => clamp(Math.round(Number(d && d.rating) || 0), 0, 5);
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const isoLocal = (dt) => dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  const todayISO = () => isoLocal(new Date());
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    try { return dt.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return String(iso); }
  }
  function daysUntil(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    const n = new Date();
    const t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Math.round((t - t0) / 86400000);
  }
  function isExpired(d) {
    if (!d || d.applied || !d.deadline) return false;
    const n = daysUntil(d.deadline);
    return n !== null && n < 0;
  }
  const newId = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ================= DATALAGER (fungerar även utan öppet kartotek) ================= */
  const S = { map: new Map(), subs: [], loaded: false, last: '', writing: Promise.resolve(), queue: Promise.resolve() };
  // Alla asynkrona ändringar körs i tur och ordning så att en omläsning aldrig skriver över en pågående ändring
  const serial = (fn) => { const p = S.queue.then(fn, fn); S.queue = p.catch(() => {}); return p; };
  function copyMap() {
    const c = new Map();
    S.map.forEach((v, k) => c.set(k, Object.assign({}, v)));
    return c;
  }
  function notify() { const c = copyMap(); S.subs.forEach((cb) => { try { cb(c); } catch {} }); }
  function fromArray(arr) {
    const m = new Map();
    (Array.isArray(arr) ? arr : []).forEach((c) => { if (c && c.id) m.set(String(c.id), c); });
    return m;
  }
  async function rawRead() {
    try {
      if (api) { const r = await api.storage.local.get(KEY); return r[KEY]; }
      const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : [];
    } catch { return []; }
  }
  function persist() {
    const arr = Array.from(S.map.values());
    S.last = JSON.stringify(arr);
    try {
      if (api) { const r = api.storage.local.set({ [KEY]: arr }); S.writing = Promise.resolve(r).catch(() => {}); }
      else localStorage.setItem(KEY, S.last);
    } catch {}
    notify();
  }
  const ready = (async () => {
    S.map = fromArray(await rawRead());
    S.last = JSON.stringify(Array.from(S.map.values()));
    S.loaded = true;
  })();
  try {
    if (api && api.storage.onChanged) api.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch[KEY] || !S.loaded) return;
      const arr = ch[KEY].newValue || [];
      if (JSON.stringify(arr) === S.last) return;
      S.map = fromArray(arr); S.last = JSON.stringify(arr); notify();
    });
  } catch {}

  const store = {
    subscribe(cb) { S.subs.push(cb); if (S.loaded) cb(copyMap()); },
    create(data) { const id = newId(); S.map.set(id, Object.assign({ id }, data)); persist(); return id; },
    restore(id, data) { S.map.set(id, Object.assign({ id }, data)); persist(); },
    patch(id, p) { const o = S.map.get(id); if (!o) return; Object.assign(o, p); persist(); },
    remove(id) { S.map.delete(id); persist(); },
    importMany(list) {
      let n = 0;
      list.forEach((c) => {
        if (!c || typeof c !== 'object' || !String(c.title || '').trim()) return;
        const o = Object.assign({}, c);
        if (!o.id || S.map.has(String(o.id))) o.id = newId();
        o.id = String(o.id);
        S.map.set(o.id, o); n++;
      });
      if (n) persist();
      return n;
    }
  };

  /* ================= ANNONSDATA ================= */
  function htmlToText(html) {
    let s = String(html || '');
    try {
      const doc = new DOMParser().parseFromString(s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|ul|ol)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<\/li>/gi, '\n'), 'text/html');
      s = doc.body ? doc.body.textContent : s;
    } catch { s = s.replace(/<[^>]+>/g, ' '); }
    return s.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function clip(s, n) {
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const i = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
    return (i > n * 0.7 ? cut.slice(0, i) : cut).trim() + ' …';
  }
  // Gör om svaret från Platsbankens API till kortdata
  function cardDataFromApi(j, id) {
    const wp = j.workplace || (Array.isArray(j.workplaces) && j.workplaces[0]) || {};
    let deadline = null;
    if (j.lastApplicationDate) { const dt = new Date(j.lastApplicationDate); if (!isNaN(dt)) deadline = isoLocal(dt); }
    // publiceringsdatum: fältets namn är inte säkert känt, så ta det första fältet vars namn tyder på publicering och som är ett datum
    let published = '';
    const pk = ['publishedDate', 'publishDate', 'publicationDate', 'published', 'publishedAt', 'publication_date', 'firstPublishedDate', 'postedDate', 'createdDate']
      .concat(Object.keys(j).filter((k) => /publi|posted|created/i.test(k)));
    for (const k of pk) {
      const v = j[k];
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
      const dt = new Date(v); if (!isNaN(dt)) { published = isoLocal(dt); break; }
    }
    return {
      published,
      adId: String(id || j.id || ''),
      title: String(j.title || j.occupation || '').trim(),
      company: String((j.company && j.company.name) || wp.name || '').trim(),
      place: [wp.municipality || wp.city, j.workplaceModel && j.workplaceModel.label].filter(Boolean).join(' · '),
      hours: [j.workTimeExtent, j.duration, j.employmentType].filter(Boolean).join(' · '),
      deadline,
      description: htmlToText(j.description),
      applyUrl: (j.application && j.application.webAddress) || ''
    };
  }
  async function fetchAd(id) {
    try {
      const r = await fetch(AD_API + encodeURIComponent(id), { credentials: 'omit', headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      return cardDataFromApi(await r.json(), id);
    } catch { return null; }
  }
  // Äldre kort fick en beskrivning som kapats vid 1200 tecken (slutar på " …"). Hämta hela texten igen,
  // men bara för kort utan markeringar (de pekar på teckenpositioner) som inte redigerats.
  async function expandClipped() {
    try {
      await refreshFromStore();
      const todo = Array.from(S.map.values()).filter((c) => c.adId && c.source === 'platsbanken' && !(c.marks && c.marks.length)
        && typeof c.description === 'string' && / …$/.test(c.description) && c.description.length >= 1000 && c.description.length <= 1210);
      for (const c of todo) {
        const full = await fetchAd(c.adId);
        if (!full || !full.description) continue;
        await serial(async () => {
          await refreshFromStore();
          const cur = S.map.get(c.id);
          const head = c.description.slice(0, 200);
          if (cur && cur.description === c.description && full.description.length > c.description.length && full.description.startsWith(head)) {
            store.patch(c.id, { description: full.description });
          }
        });
      }
    } catch {}
  }
  // Kort som skapades innan publiceringsdatum fanns får det hämtat en gång
  async function backfillPublished() {
    try {
      await refreshFromStore();
      const todo = Array.from(S.map.values()).filter((c) => c.adId && c.source === 'platsbanken' && !c.pubTried);
      for (const c of todo) {
        const full = await fetchAd(c.adId);
        if (!full) continue;
        await serial(async () => { await refreshFromStore(); if (S.map.get(c.id)) store.patch(c.id, { published: full.published || '', pubTried: 1 }); });
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch {}
  }
  setTimeout(() => { ready.then(() => expandClipped()); }, 4000);
  setTimeout(() => { ready.then(() => backfillPublished()); }, 9000);
  function nextSpot() {
    // Rutnät där cellerna är lika stora som de största korten, så att nya kort inte hamnar över gamla
    const cs = Array.from(S.map.values());
    const info = cs.map((c) => { const m = S.sizeOf ? S.sizeOf(c.id) : null; return { x: Number(c.x) || 0, y: Number(c.y) || 0, w: (m && m.w) || Number(c.w) || CARD_W, h: (m && m.h) || 0 }; });
    const known = info.map((i) => i.h).filter(Boolean);
    const estH = known.length ? Math.max.apply(null, known) : 560;
    info.forEach((i) => { if (!i.h) i.h = estH; });
    const cw = Math.max(CARD_W, Math.max.apply(null, info.map((i) => i.w).concat([0]))) , ch = estH;
    const stepX = cw + COL_GAP, stepY = ch + 40, COLS = 4;
    for (let i = 0; i < 4000; i++) {
      const x = (i % COLS) * stepX, y = Math.floor(i / COLS) * stepY;
      if (!info.some((p) => x < p.x + p.w + 8 && p.x < x + cw + 8 && y < p.y + p.h + 8 && p.y < y + ch + 8)) return { x, y };
    }
    return { x: 0, y: 0 };
  }
  // Lägger ett kort från annonsdata. Finns annonsen redan skapas inget nytt kort.
  async function refreshFromStore() {
    await ready; await S.writing;
    const fresh = await rawRead();
    if (JSON.stringify(fresh || []) !== S.last) { S.map = fromArray(fresh); S.last = JSON.stringify(fresh || []); }
  }
  const addFromAd = (data) => serial(() => addFromAdNow(data));
  const VIA = (() => { let v = '?'; try { v = (typeof browser !== 'undefined' ? browser : chrome).runtime.getManifest().version; } catch {} return v + '/' + Math.random().toString(36).slice(2, 6) + '/' + (window.top === window.self ? 'top' : 'frame'); })();
  async function addFromAdNow(data) {
    await refreshFromStore();
    const id = String(data.adId || '');
    if (id) for (const c of S.map.values()) if (c.adId === id) return { status: 'exists', id: c.id, ageMs: Date.now() - (Number(c.createdAt) || 0), via: c.via || 'okänd (äldre kopia)', me: VIA };
    if (!String(data.title || '').trim()) data.title = 'Annons ' + id;
    const spot = nextSpot();
    const z = Array.from(S.map.values()).reduce((m, c) => Math.max(m, Number(c.z) || 0), 0) + 1;
    const cid = store.create(Object.assign({ rating: 0, applied: null, x: spot.x, y: spot.y, z, createdAt: Date.now(), last: Date.now(), example: false, source: 'platsbanken', via: VIA }, data));   // last: nyss sparad annons, hamnar sist i sin ruta (första taggen eller utan tagg)
    return { status: 'added', id: cid };
  }
  // Annonsen togs bort från favoriter: ta bort kortet. Returnerar kortets data (för ångra) eller null.
  const removeByAd = (adId) => serial(() => removeByAdNow(adId));
  async function removeByAdNow(adId) {
    await refreshFromStore();
    adId = String(adId || '');
    for (const c of S.map.values()) {
      if (adId && c.adId === adId) {
        const copy = Object.assign({}, c);
        store.remove(c.id);
        return copy;
      }
    }
    return null;
  }
  const hasAd = (adId) => { for (const c of S.map.values()) if (c.adId === String(adId)) return true; return false; };
  // Sätt ansökt-status från Platsbankens egen sparade-lista
  const setApplied = (adId, on) => serial(() => setAppliedNow(adId, on));
  async function setAppliedNow(adId, on) {
    await refreshFromStore();
    adId = String(adId || '');
    for (const c of S.map.values()) {
      if (c.adId === adId) {
        if (!!c.applied !== !!on) store.patch(c.id, { applied: on ? todayISO() : null });
        return;
      }
    }
  }
  // Gör om en post i Platsbankens sparade-lista till kortdata (reserv om annonsen inte går att hämta)
  function dataFromSaved(it) {
    let deadline = null;
    if (it.applicationDate) { const dt = new Date(it.applicationDate); if (!isNaN(dt)) deadline = isoLocal(dt); }
    return { adId: String(it.id), title: String(it.title || '').trim(), company: String(it.employerName || '').trim(), place: String(it.location || '').trim(), hours: '', deadline, description: '', applyUrl: '' };
  }
  const restoreCard = (c) => { if (!c || !c.id) return; ready.then(() => store.restore(c.id, c)); };
  // Alla taggar som finns på korten (vanligast först) och möjlighet att sätta taggarna på ett kort via annons-id
  const allTags = () => serial(allTagsNow);
  async function allTagsNow() {
    await refreshFromStore();
    const m = new Map();
    S.map.forEach((c) => tagsOf(c).forEach((t) => { const k = tk(t); const o = m.get(k) || { name: t, n: 0 }; o.n++; m.set(k, o); }));
    return Array.from(m.values()).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'sv'));
  }
  const setTagsByAd = (adId, tags) => serial(() => setTagsNow(adId, tags));
  async function setTagsNow(adId, tags) {
    await refreshFromStore();
    adId = String(adId || '');
    for (const c of S.map.values()) if (adId && c.adId === adId) { store.patch(c.id, { tags: normTags(tags) }); return true; }
    return false;
  }

  /* ================= GRÄNSSNITT ================= */
  function mount(host, hooks) {
    hooks = hooks || {};
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = ":host{all:initial;display:block;width:100%;height:100%;color-scheme:light;\n  --bg:#e7ebf0;--dot:#b7c1ce;--surface:#f7f9fb;--surface-line:#d0d8e2;--card:#fefefe;--card-edge:#cdd5df;--ruled:#dbe6f3;\n  --head-rule:#c9677a;--ink:#1b2330;--muted:#586578;--accent:#2b59c9;--accent-ink:#fff;--star:#d99100;--star-off:#bcc5d1;\n  --danger:#b4374b;--hl:#ffe066;--hit:#ffc59a;--warn:#935500;--ap-card:#9fdbb6;--ap-edge:#1f8a4c;--ap-ruled:#7cc79b;--ap-ink:#0c3f21;\n  --shadow:0 1px 2px rgba(20,30,50,.14),0 5px 14px rgba(20,30,50,.10);--shadow-lift:0 2px 4px rgba(20,30,50,.16),0 16px 34px rgba(20,30,50,.22);\n  --font-display:\"Segoe UI\",system-ui,-apple-system,sans-serif;--font-body:system-ui,-apple-system,\"Segoe UI\",sans-serif}\n*{box-sizing:border-box}\n[hidden]{display:none!important}\nbutton{font:inherit;color:inherit}\n:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.app{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;overflow:hidden;background:var(--bg);color:var(--ink);font:14px/1.45 var(--font-body)}\n.bar{position:relative;z-index:20;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 12px;background:var(--surface);border-bottom:1px solid var(--surface-line)}\n.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;min-width:0}\n.field{display:flex;align-items:center;gap:8px;min-width:0}\n.flabel{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);white-space:nowrap}\n.spacer{flex:1 1 0;min-width:0}\n.count{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}\nselect{height:34px;max-width:230px;padding:0 8px;font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--surface-line);border-radius:6px}\n.btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 14px;font-weight:600;color:var(--ink);background:var(--surface);border:1px solid var(--surface-line);border-radius:6px;cursor:pointer;white-space:nowrap}\n.btn:hover{border-color:var(--muted)}\n.btn.primary{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}\n.btn.primary:hover{filter:brightness(1.08)}\n.btn.danger{color:var(--danger)}\n.btn.plain{background:transparent}\n.icon{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}\n.stars{display:inline-flex;gap:1px}\n.sbtn{display:grid;place-items:center;width:24px;height:24px;padding:0;background:none;border:0;border-radius:4px;cursor:pointer}\n.star{width:18px;height:18px;fill:none;stroke:var(--star-off);stroke-width:1.6;stroke-linejoin:round}\n.sbtn.on .star{fill:var(--star);stroke:var(--star)}\n.sbtn:hover .star{stroke:var(--star)}\n.stars.big .sbtn{width:38px;height:38px}\n.stars.big .star{width:28px;height:28px}\n.stars-txt{min-width:2ch;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}\n.stage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}\n.canvas{position:absolute;inset:0;cursor:grab;touch-action:none;background-color:var(--bg);\n  background-image:radial-gradient(circle at center,var(--dot) 1.2px,transparent 1.7px);background-size:var(--gs,28px) var(--gs,28px);background-position:var(--gx,0px) var(--gy,0px)}\n.canvas.panning{cursor:grabbing}\n.world{position:absolute;left:0;top:0;transform-origin:0 0}\n.card{position:absolute;overflow-wrap:anywhere;width:280px;padding:12px 14px 8px;background:var(--card);border:1px solid var(--card-edge);border-radius:3px;box-shadow:var(--shadow);cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;color:var(--ink)}\n.card.dragging{cursor:grabbing;box-shadow:var(--shadow-lift)}\n.card-title{margin:0;padding-bottom:7px;border-bottom:1.5px solid var(--head-rule);font:600 23px/1.25 var(--font-display);overflow-wrap:anywhere}\n.meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px;min-height:20px}\n.company{font-size:12.5px;font-weight:600;overflow-wrap:anywhere}\n.company.none{font-weight:400;font-style:italic;color:var(--muted)}\n.place{margin-top:2px;font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}\n.hours{margin-top:6px;font-size:12.5px;line-height:1.45}\n.hlabel{margin-right:8px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}\n.hval{overflow-wrap:anywhere}\n.dl{margin-top:6px;font-size:12.5px;line-height:1.45}\n.dlv{font-weight:600}.dls{color:var(--muted)}\n.dl.warn .dlv,.dl.warn .dls{color:var(--warn)}\n.dl.urgent .dlv,.dl.urgent .dls{color:var(--danger)}\n.card.warn{border-color:var(--warn);box-shadow:0 0 0 2px var(--warn),var(--shadow)}\n.card.urgent{border-color:var(--danger);box-shadow:0 0 0 2px var(--danger),var(--shadow)}\n.card.warn.dragging{box-shadow:0 0 0 2px var(--warn),var(--shadow-lift)}\n.card.urgent.dragging{box-shadow:0 0 0 2px var(--danger),var(--shadow-lift)}\n.world.glide .card{transition:left 1.2s cubic-bezier(.65,0,.35,1),top 1.2s cubic-bezier(.65,0,.35,1)}\n@media (prefers-reduced-motion:reduce){.world.glide .card{transition:none}}\n.seg{display:inline-flex;background:var(--card);border:1px solid var(--surface-line);border-radius:6px;overflow:hidden}\n.segbtn{height:32px;padding:0 12px;font-weight:600;color:var(--muted);background:none;border:0;border-right:1px solid var(--surface-line);cursor:pointer;white-space:nowrap}\n.segbtn:last-child{border-right:0}\n.segbtn:hover{color:var(--ink)}\n.segbtn[aria-pressed=\"true\"]{color:var(--accent-ink);background:var(--accent)}\n.explist{display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow-y:auto}\n.exprow{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 12px;background:var(--card);border:1px solid var(--surface-line);border-radius:6px}\n.expinfo{flex:1 1 120px;min-width:0}\n.expt{font-weight:600;overflow-wrap:anywhere}\n.expm{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}\n.expnote{margin:0;color:var(--muted)}\nmark{padding:0 1px;margin:0 -1px;font-size:1.2em;color:inherit;background:var(--hl);border-radius:2px;-webkit-box-decoration-break:clone;box-decoration-break:clone}\n.app.marking .desc,.app.marking .hval{user-select:text;-webkit-user-select:text;cursor:text}\n.app.marking mark{cursor:pointer}\n.btn.active{color:var(--ink);background:var(--hl);border-color:var(--hl)}\n.markact{position:absolute;left:16px;bottom:76px;z-index:12;box-shadow:var(--shadow)}\n.grip{position:absolute;top:0;right:-7px;bottom:0;width:14px;cursor:ew-resize;touch-action:none}\n.grip::after{content:\"\";position:absolute;top:50%;left:5px;width:4px;height:36px;margin-top:-18px;border-radius:2px;background:var(--muted);opacity:0;transition:opacity .12s}\n.card:hover .grip::after,.card:focus-within .grip::after,.grip:hover::after,.card.dragging .grip::after{opacity:.55}\n.tag{flex:none;padding:1px 5px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border:1px solid var(--card-edge);border-radius:3px}\n.desc{margin:4px 0 0;min-height:40px;font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;\n  background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 19px,var(--ruled) 19px,var(--ruled) 20px)}\n.foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:2px 6px;margin-top:6px;padding-top:4px}\n.fl{display:flex;align-items:center}\n.fr{display:flex;align-items:center;gap:2px;margin-left:auto}\n.card.applied{--card:var(--ap-card);--card-edge:var(--ap-edge);--ruled:var(--ap-ruled)}\n.apl{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:calc(12.5px*var(--z-ap,1));line-height:1.15;font-weight:600;color:var(--ap-ink)}\n.apl .icon{width:calc(15px*var(--z-ap,1));height:calc(15px*var(--z-ap,1));flex:none}\n.abtn{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 8px;font-size:12px;font-weight:600;color:var(--muted);background:none;border:1px solid transparent;border-radius:4px;cursor:pointer}\n.abtn .icon{width:15px;height:15px}\n.abtn:hover{color:var(--ink);background:var(--bg)}\n.abtn[aria-pressed=\"true\"]{color:var(--ap-ink);background:var(--ap-ruled);border-color:var(--ap-edge)}\n.card.has-next::after{content:\"\";position:absolute;left:22px;bottom:-11px;width:4px;height:12px;border-radius:2px;background:var(--muted);opacity:.7}\n.card.link-src{outline:2px dashed var(--accent);outline-offset:3px}\n.app.linking .card{cursor:pointer}\n.app.linking .card:not(.link-src):hover{outline:2px solid var(--accent);outline-offset:3px}\n.linkbar{position:absolute;top:12px;left:50%;z-index:15;display:flex;align-items:center;gap:12px;max-width:calc(100% - 32px);padding:6px 6px 6px 14px;background:var(--surface);border:1px solid var(--accent);border-radius:8px;box-shadow:var(--shadow);transform:translateX(-50%)}\n.linkbar span{min-width:0;overflow-wrap:anywhere}\n.sinp{height:34px;width:min(240px,100%);min-width:0;padding:0 10px;font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--surface-line);border-radius:6px}\n::highlight(sok){background-color:var(--hit);color:inherit}\n.row{display:flex;gap:8px;align-items:center}\n.row .inp{flex:1 1 auto;width:auto;min-width:0}\n.score{padding:0;background:none;border:0;font-family:inherit;margin-left:6px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}\n.grow{flex:1 1 auto}\n.ibtn{display:grid;place-items:center;width:30px;height:30px;padding:0;color:var(--muted);background:none;border:0;border-radius:4px;cursor:pointer}\n.ibtn:hover{color:var(--ink);background:var(--bg)}\n.zoom{position:absolute;right:16px;bottom:16px;z-index:10;display:flex;background:var(--surface);border:1px solid var(--surface-line);border-radius:8px;box-shadow:var(--shadow);overflow:hidden}\n.zbtn{display:grid;place-items:center;min-width:40px;height:40px;padding:0 6px;background:none;border:0;border-right:1px solid var(--surface-line);cursor:pointer;font-variant-numeric:tabular-nums;font-weight:600}\n.zbtn:last-child{border-right:0}\n.zbtn:hover{background:var(--bg)}\n.zbtn.wide{min-width:62px;font-size:13px}\n.hint{position:absolute;left:16px;bottom:16px;z-index:10;max-width:min(440px,calc(100% - 280px));margin:0;padding:10px 14px;font-size:12px;line-height:1.45;color:var(--muted);background:var(--surface);border:1px solid var(--surface-line);border-radius:8px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.08)}\n.hint p{margin:0 0 6px}.hint p:last-child{margin-bottom:0}.hint b{color:var(--ink)}.hint .hint-mode:empty{display:none}.hint .hint-mode{padding-top:6px;border-top:1px solid var(--surface-line)}\n.hint .hint-i{display:none;width:30px;height:30px;padding:0;border:0;border-radius:50%;background:var(--accent);color:#fff;font:italic 700 17px/30px Georgia,serif;cursor:pointer}\n.hint.min{padding:0;border:0;border-radius:50%;background:none;box-shadow:none;width:30px;height:30px}.hint.min .hint-body{display:none}.hint.min .hint-i{display:block}\n.empty{position:absolute;inset:0;z-index:5;display:grid;place-items:center;padding:16px;pointer-events:none}\n.empty-box{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:360px;padding:22px 24px;text-align:center;background:var(--surface);border:1px solid var(--surface-line);border-radius:8px;box-shadow:var(--shadow);pointer-events:auto}\n.empty-box h2{margin:0;font:600 18px/1.2 var(--font-display)}\n.empty-box p{margin:0;color:var(--muted)}\n.overlay{position:absolute;inset:0;z-index:100;display:grid;place-items:center;padding:16px;background:rgba(8,12,18,.55);overflow-y:auto}\n.panel{display:flex;flex-direction:column;gap:14px;width:min(460px,100%);padding:20px;background:var(--surface);border:1px solid var(--surface-line);border-radius:8px;box-shadow:var(--shadow-lift)}\n.panel h2{margin:0;font:700 20px/1.2 var(--font-display)}\n.lbl{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}\n.inp{width:100%;padding:8px 10px;font:400 14px/1.45 var(--font-body);letter-spacing:0;text-transform:none;color:var(--ink);background:var(--card);border:1px solid var(--surface-line);border-radius:6px}\ntextarea.inp{min-height:120px;resize:vertical}\n.err{margin:0;font-size:12.5px;color:var(--danger)}\n.actions{display:flex;align-items:center;gap:8px}\n.toast{position:absolute;left:50%;bottom:76px;z-index:120;display:flex;align-items:center;gap:14px;max-width:calc(100% - 32px);padding:10px 14px;color:var(--bg);background:var(--ink);border-radius:8px;box-shadow:var(--shadow-lift);transform:translateX(-50%)}\n.toast button{padding:0;font-weight:700;color:inherit;background:none;border:0;text-decoration:underline;cursor:pointer}\n.tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}\n.tagchip{padding:1px 8px;font-size:11.5px;font-weight:600;border-radius:10px;color:hsl(var(--h) 55% 24%);background:hsl(var(--h) 75% 48% / .2);border:1.5px solid hsl(var(--h) 55% 48%)}\n.selchips{display:flex;flex-wrap:wrap;gap:4px;max-width:min(520px,100%)}\n.tagchip.pick{font-family:inherit;cursor:pointer}\n.tagchip.pick:hover{background:hsl(var(--h) 75% 48% / .38)}\n.tagx{margin:0 -4px 0 5px;padding:0 4px;font:700 1.9em/1 var(--font-body);color:inherit;background:none;border:0;border-radius:8px;cursor:pointer;opacity:.85}\n.tagx:hover{opacity:1;background:hsl(var(--h) 60% 80%)}\n.card.selected{outline:12px solid var(--accent);outline-offset:4px;border-radius:5px}\n.card.misplaced{outline:3px dashed #d33;outline-offset:2px}\n.tagbox{position:absolute;z-index:0;border:3px dashed hsl(var(--h) 55% 48%);background:hsl(var(--h) 75% 48% / .2);border-radius:14px;pointer-events:none;transition:background .12s}\n.tagbox.drop{background:hsl(var(--h) 75% 48% / .38);border-style:solid}\n.tagbox.moving:not(.sm){background:hsl(var(--h) 60% 90%)!important;box-shadow:0 10px 30px rgba(20,30,50,.30);transition:none}\n.tagbox-h{pointer-events:auto;cursor:grab;touch-action:none;position:absolute;left:18px;top:8px;right:18px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:700 calc(48px*var(--z-tagtitle,1))/1.2 var(--font-display);color:hsl(var(--h) 55% 26%)}\n.tagbox-h span{margin-left:14px;font-size:calc(24px*var(--z-tagtitle,1));font-weight:500;color:var(--muted)}\n.band{position:absolute;z-index:14;border:1.5px solid var(--accent);background:rgba(43,89,201,.12);pointer-events:none}\n.selbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:4px 6px 4px 12px;background:var(--card);border:1px solid var(--accent);border-radius:8px}\n.selcount{font-weight:700;white-space:nowrap}\n.desc{overflow:hidden}\n.desc.clipped{position:relative}\n.desc.clipped::after{content:'';position:absolute;left:0;right:0;bottom:0;height:24px;background:linear-gradient(to bottom,transparent,var(--card))}\n.selbar .sinp{width:150px}\n@media (max-width:720px){.hint{display:none}}\n.tagbox .rz{position:absolute;z-index:2;pointer-events:auto;display:none;touch-action:none}\n.tagbox.can .rz{display:block}\n.rz-r,.rz-l{top:16px;bottom:16px;width:12px}\n.rz-r{right:-6px;cursor:ew-resize}\n.rz-l{left:-6px;cursor:ew-resize}\n.rz-t,.rz-b{left:16px;right:16px;height:10px}\n.rz-t{top:-6px;cursor:ns-resize}\n.rz-b{bottom:-6px;cursor:ns-resize}\n.rz-br,.rz-bl,.rz-tr,.rz-tl{width:16px;height:16px}\n.rz-br{right:-6px;bottom:-6px;cursor:nwse-resize}\n.rz-tl{left:-6px;top:-6px;cursor:nwse-resize}\n.rz-bl{left:-6px;bottom:-6px;cursor:nesw-resize}\n.rz-tr{right:-6px;top:-6px;cursor:nesw-resize}\n.rzghost{position:absolute;z-index:6;pointer-events:none;border:3px solid #26303f;border-radius:14px;background:rgba(38,48,63,.07)}\n.rzlab{position:absolute;right:12px;top:8px;padding:2px 8px;font:600 14px/1.4 var(--font-body);color:#fff;background:#26303f;border-radius:6px}\n.tagbox.sm{border-width:2px;border-radius:10px}\n.tagbox.sm .tagbox-h{pointer-events:auto;cursor:grab;touch-action:none;top:5px;left:12px;right:12px;font-size:calc(48px*var(--z-tagtitle,1))}\n.pub{margin-top:6px;line-height:1.45}\n.pubv{font-weight:600}\n.pubs{color:var(--muted)}\n.card .pub{font-size:calc(12.5px*var(--z-pub,1))}\n.card .pub .hlabel{font-size:calc(10.5px*var(--z-pub,1))}\n.card mark{background:var(--mk,var(--hl));font-size:calc(1.2em*var(--z-mark,1))}\n.colrow input[type=color]{width:100%;height:26px;padding:0;border:1px solid var(--surface-line);border-radius:5px;background:var(--card);cursor:pointer}\n.colpop{max-height:min(70vh,520px);overflow-y:auto}\n.colrow{display:grid;grid-template-columns:minmax(90px,1fr) 150px 26px;align-items:center;gap:8px}\n.colrow .tagchip{justify-self:start;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\ninput.hue{-webkit-appearance:none;appearance:none;width:100%;height:12px;margin:0;border-radius:6px;background:linear-gradient(to right,hsl(0 75% 48%),hsl(60 75% 48%),hsl(120 75% 48%),hsl(180 75% 48%),hsl(240 75% 48%),hsl(300 75% 48%),hsl(360 75% 48%))}\ninput.hue::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #333}\ninput.hue::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #333}\ninput.hue::-moz-range-track{background:transparent}\n.card-title{font-size:calc(23px*var(--z-title,1))}\n.card .company{font-size:calc(12.5px*var(--z-co,1))}\n.card .place{font-size:calc(12.5px*var(--z-place,1))}\n.card .hours{font-size:calc(12.5px*var(--z-hours,1))}\n.card .hlabel{font-size:calc(10.5px*var(--z-hours,1))}\n.card .dl{font-size:calc(12.5px*var(--z-dl,1))}\n.card .tagchip{font-size:calc(11.5px*var(--z-tag,1))}\n.card .desc{font-size:calc(13px*var(--z-text,1));line-height:calc(20px*var(--z-text,1));min-height:calc(40px*var(--z-text,1));background-image:repeating-linear-gradient(to bottom,transparent 0,transparent calc(19px*var(--z-text,1)),var(--ruled) calc(19px*var(--z-text,1)),var(--ruled) calc(20px*var(--z-text,1)))}\n.card .sbtn{width:calc(24px*var(--z-rate,1)*var(--kr,1));height:calc(24px*var(--z-rate,1)*var(--kr,1))}\n.card .star{width:calc(18px*var(--z-rate,1)*var(--kr,1));height:calc(18px*var(--z-rate,1)*var(--kr,1))}\n.card .score{font-size:calc(12px*var(--z-rate,1)*var(--kr,1))}\n.card .abtn{height:calc(30px*var(--z-btn,1)*var(--kb,1));font-size:calc(12px*var(--z-btn,1)*var(--kb,1))}\n.card .abtn .icon{width:calc(15px*var(--z-btn,1)*var(--kb,1));height:calc(15px*var(--z-btn,1)*var(--kb,1))}\n.card .ibtn{width:calc(30px*var(--z-btn,1)*var(--kb,1));height:calc(30px*var(--z-btn,1)*var(--kb,1))}\n.card .ibtn .icon{width:calc(18px*var(--z-btn,1)*var(--kb,1));height:calc(18px*var(--z-btn,1)*var(--kb,1))}\n.cellghost{position:absolute;z-index:0;pointer-events:none;border:2px dashed rgba(38,48,63,.45);border-radius:6px;background:rgba(255,255,255,.35)}\n#overlay{padding:10px}\n#form.panel{width:100%;height:100%;max-width:none;gap:10px;padding:16px 20px;overflow:hidden}\n.edcols{display:flex;flex:1 1 auto;min-height:0;gap:18px}\n.edside{display:flex;flex-direction:column;gap:10px;flex:0 0 340px;min-width:0;overflow-y:auto;padding:3px}\n#edDescBox{flex:1 1 auto;min-width:0;min-height:0}\n.edhead{display:flex;align-items:center;justify-content:space-between}\n.edhead .btn{height:28px;font-size:12px;padding:0 10px;text-transform:none;letter-spacing:0}\n.edhead .btn:disabled{opacity:.45;cursor:default}\n.edwrap{position:relative;flex:1 1 auto;min-height:200px;background:var(--card);border-radius:6px}\n#edMirror,#edDesc{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:8px 10px;border:1px solid var(--surface-line);border-radius:6px;font:400 15px/1.5 var(--font-body);letter-spacing:0;text-transform:none;white-space:pre-wrap;overflow-wrap:anywhere;overflow-y:scroll;box-sizing:border-box}\n#edMirror{color:transparent;overflow-x:hidden;pointer-events:none}\n#edMirror mark{padding:0;margin:0;font-size:inherit;color:transparent;background:var(--mk,var(--hl));border-radius:2px}\n#edDesc{background:transparent;resize:none}\n@media (max-width:760px){.edcols{flex-direction:column}.edside{flex:none}}\n.sizepop{position:absolute;top:calc(100% + 4px);right:12px;z-index:40;width:350px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;background:var(--surface);border:1px solid var(--surface-line);border-radius:8px;box-shadow:var(--shadow-lift)}\n.sizepop h3{margin:0 0 2px;font:700 14px/1.2 var(--font-display)}\n.szb{width:24px;height:24px;padding:0;font:700 15px/1 var(--font-body);color:var(--ink);background:var(--card);border:1px solid var(--surface-line);border-radius:5px;cursor:pointer}\n.szb:hover{border-color:var(--muted)}\n.szrow{display:grid;grid-template-columns:104px 24px 1fr 24px 44px;align-items:center;gap:8px;font-size:13px}\n.szrow input{width:100%;margin:0}\n.szrow output{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}\n";
    root.appendChild(st);
    const tpl = document.createElement('template');
    tpl.innerHTML = "<div class=\"app\" id=\"app\">\n  <header class=\"bar\">\n    <div class=\"filters\">\n      <label class=\"field\"><span class=\"flabel\">Sök</span>\n        <input class=\"sinp\" id=\"fSearch\" type=\"search\" placeholder=\"Sök i korten\" autocomplete=\"off\" aria-label=\"Sök i korten\" title=\"Tryck / för att sätta markören här\">\n      </label>\n      <label class=\"field\"><span class=\"flabel\">Företag</span>\n        <select id=\"fCompany\" aria-label=\"Filtrera på företag\"><option value=\"*\">Alla företag</option></select>\n      </label>\n      <div class=\"field\"><span class=\"flabel\">Betyg minst</span>\n        <div class=\"stars\" id=\"fStars\" role=\"group\" aria-label=\"Filtrera på lägsta betyg\"></div>\n        <span class=\"stars-txt\" id=\"fStarsTxt\"></span>\n      </div>\n      <label class=\"field\"><span class=\"flabel\">Status</span>\n        <select id=\"fStatus\" aria-label=\"Filtrera på status\">\n          <option value=\"*\">Alla</option>\n          <option value=\"open\">Ej ansökta</option>\n          <option value=\"applied\">Ansökta</option>\n        </select>\n      </label>\n      <label class=\"field\"><span class=\"flabel\">Tagg</span>\n        <select id=\"fTag\" aria-label=\"Filtrera på tagg\"><option value=\"*\">Alla taggar</option></select>\n      </label>\n      <button type=\"button\" class=\"btn plain\" id=\"resetFilters\" hidden>Nollställ filter</button>\n    </div>\n    <div class=\"field\"><span class=\"flabel\">Ordning</span>\n      <div class=\"seg\" role=\"group\" aria-label=\"Ordning på korten\">\n        <button type=\"button\" class=\"segbtn\" data-sort=\"free\" aria-pressed=\"true\" title=\"Korten ligger där du har placerat dem\">Egen placering</button>\n        <button type=\"button\" class=\"segbtn\" data-sort=\"deadline\" aria-pressed=\"false\" title=\"Närmast sista ansökningsdag till vänster\">Efter sista ansökningsdag</button>\n        <button type=\"button\" class=\"segbtn\" data-sort=\"published\" aria-pressed=\"false\" title=\"Senast upplagda annonser till vänster\">Efter publiceringsdatum</button>\n        <button type=\"button\" class=\"segbtn\" data-sort=\"tag\" aria-pressed=\"false\" title=\"En ruta per tagg, kort med flera taggar där rutorna överlappar\">Efter tagg</button>\n      </div>\n    </div>\n    <div class=\"spacer\"></div>\n    <button type=\"button\" class=\"btn plain\" id=\"clearExamples\" hidden>Rensa exempelkort</button>\n    <button type=\"button\" class=\"btn plain\" id=\"expBtn\" hidden>Utgångna</button>\n    <span class=\"count\" id=\"count\" aria-live=\"polite\"></span>\n    <button type=\"button\" class=\"btn\" id=\"savedBtn\" hidden title=\"Skapa kort av annonser du redan har sparat i Platsbanken\">Hämta sparade annonser</button>\n    <button type=\"button\" class=\"btn plain\" id=\"sizeBtn\" title=\"Ändra storleken på texten och knapparna på korten\" aria-expanded=\"false\">Storlek</button>\n    <button type=\"button\" class=\"btn plain\" id=\"colBtn\" title=\"Välj färg på taggarna\" aria-expanded=\"false\">Färg</button>\n    <div class=\"sizepop\" id=\"sizePop\" hidden></div>\n    <div class=\"sizepop colpop\" id=\"colPop\" hidden></div>\n    <button type=\"button\" class=\"btn\" id=\"markBtn\" aria-pressed=\"false\" title=\"Markera text på korten\">\n      <svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M15 4l5 5-9.5 9.5H5.5v-5zM4 22h16\"/></svg>Markera text\n    </button>\n    <button type=\"button\" class=\"btn primary\" id=\"addBtn\">\n      <svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M12 5v14M5 12h14\"/></svg>Nytt kort\n    </button>\n    <div class=\"selbar\" id=\"selBar\" role=\"toolbar\" aria-label=\"Markerade kort\" hidden><span class=\"selcount\" id=\"selCount\"></span><input class=\"sinp\" id=\"selTag\" type=\"text\" list=\"tagList\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"Tagg\" aria-label=\"Tagg att lägga till eller ta bort\"><span class=\"selchips\" id=\"selChips\"></span><button type=\"button\" class=\"btn primary\" id=\"selAdd\">Lägg till tagg</button><button type=\"button\" class=\"btn\" id=\"selRem\">Ta bort tagg</button><button type=\"button\" class=\"btn plain\" id=\"selAll\">Markera alla</button><button type=\"button\" class=\"btn plain\" id=\"selClear\">Avmarkera</button></div>\n  </header>\n  <main class=\"stage\" id=\"stage\">\n    <div class=\"canvas\" id=\"canvas\"><div class=\"world\" id=\"world\"></div></div>\n    <div class=\"empty\" id=\"empty\" hidden>\n      <div class=\"empty-box\"><h2 id=\"emptyTitle\"></h2><p id=\"emptyText\"></p><button type=\"button\" class=\"btn primary\" id=\"emptyBtn\" hidden></button></div>\n    </div>\n    <div class=\"linkbar\" id=\"linkBar\" role=\"status\" hidden><span id=\"linkText\"></span><button type=\"button\" class=\"btn\" id=\"linkCancel\">Avbryt</button></div>\n    <div class=\"band\" id=\"band\" hidden></div>\n    <div class=\"hint\" id=\"hintBox\" title=\"Klicka för att minimera\"><button type=\"button\" class=\"hint-i\" id=\"hintI\" aria-label=\"Visa information\" title=\"Visa information\">i</button><div class=\"hint-body\"><p><b>Redigera kort:</b> Dubbelklicka på kortet eller klicka på den lilla redigeringsknappen på vardera kort.</p><p><b>Flytta kort:</b> Klicka och håll på ett kort för att dra kort runt.</p><p><b>Markera:</b> ctrl + klicka/ shift + klicka.</p><p><b>Markera alla kort i område:</b> shift + klicka och dra.</p><p><b>Tagga:</b> Markerade kort kan taggas. Skriv i taggrutan och tryck enter eller klicka på redan existerande tagg. Man kan också dra kortet till taggområde för att ge kortet den taggen.</p><p><b>Länka:</b> Kort som av någon anledning hör ihop med varandra kan länkas samman genom att klicka på \"länken\" på ett kort och sedan ett annat kort för att koppla samman dessa kort som en enhet.</p><p class=\"hint-mode\" id=\"hint\"></p></div></div>\n    <button type=\"button\" class=\"btn primary markact\" id=\"markAct\" hidden>Markera</button>\n    <div class=\"zoom\" role=\"group\" aria-label=\"Zoom\">\n      <button type=\"button\" class=\"zbtn\" id=\"zOut\" aria-label=\"Zooma ut\"><svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 12h14\"/></svg></button>\n      <button type=\"button\" class=\"zbtn wide\" id=\"zLabel\" aria-label=\"Återställ zoom till 100 procent\">100 %</button>\n      <button type=\"button\" class=\"zbtn\" id=\"zIn\" aria-label=\"Zooma in\"><svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M12 5v14M5 12h14\"/></svg></button>\n      <button type=\"button\" class=\"zbtn\" id=\"zFit\" aria-label=\"Visa alla kort\" title=\"Visa alla kort\"><svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 3v3M12 18v3M3 12h3M18 12h3\"/></svg></button>\n      <button type=\"button\" class=\"zbtn\" id=\"zFull\" aria-label=\"Fullskärm\" title=\"Fullskärm (Esc för att avsluta)\"><svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5\"/></svg></button>\n    </div>\n  </main>\n  <div class=\"overlay\" id=\"overlay\" hidden>\n    <form class=\"panel\" id=\"form\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"formTitle\" novalidate>\n      <h2 id=\"formTitle\">Nytt kort</h2>\n      <div class=\"edcols\"><div class=\"edside\">\n      <label class=\"lbl\" for=\"edTitle\">Titel<input class=\"inp\" id=\"edTitle\" type=\"text\" maxlength=\"140\" autocomplete=\"off\" placeholder=\"Jobbtitel\"></label>\n      <p class=\"err\" id=\"edErr\" role=\"alert\" hidden>Skriv en titel.</p>\n      <label class=\"lbl\" for=\"edCompany\">Företag<input class=\"inp\" id=\"edCompany\" type=\"text\" maxlength=\"100\" autocomplete=\"off\" list=\"companyList\" placeholder=\"Arbetsgivare\"></label>\n      <datalist id=\"companyList\"></datalist>\n      <label class=\"lbl\" for=\"edTags\">Taggar<input class=\"inp\" id=\"edTags\" type=\"text\" maxlength=\"200\" autocomplete=\"off\" list=\"tagList\" placeholder=\"Kommaseparerade, t.ex. Intressant, Ring först\"></label>\n      <datalist id=\"tagList\"></datalist>\n      <label class=\"lbl\" for=\"edPlace\">Ort<input class=\"inp\" id=\"edPlace\" type=\"text\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"Kommun, distans eller på plats\"></label>\n      <label class=\"lbl\" for=\"edHours\">Arbetstider<input class=\"inp\" id=\"edHours\" type=\"text\" maxlength=\"200\" autocomplete=\"off\" placeholder=\"Dagar, tider och omfattning\"></label>\n      <div class=\"lbl\">Sista ansökningsdag\n        <div class=\"row\"><input class=\"inp\" id=\"edDeadline\" type=\"date\" aria-label=\"Sista ansökningsdag\"><button type=\"button\" class=\"btn plain\" id=\"edDeadlineClear\">Rensa</button></div>\n      </div>\n      <div class=\"lbl\">Betyg<div class=\"stars big\" id=\"edStars\" role=\"group\" aria-label=\"Betyg\"></div></div>\n      <div class=\"lbl\">Ansökt den\n        <div class=\"row\"><input class=\"inp\" id=\"edApplied\" type=\"date\" aria-label=\"Datum då du ansökte\"><button type=\"button\" class=\"btn plain\" id=\"edAppliedClear\">Rensa</button></div>\n      </div>\n      </div>\n      <div class=\"lbl\" id=\"edDescBox\"><div class=\"edhead\"><label for=\"edDesc\">Beskrivning</label><button type=\"button\" class=\"btn plain\" id=\"edMark\" disabled>Markera text</button></div><div class=\"edwrap\"><div class=\"edmirror\" id=\"edMirror\" aria-hidden=\"true\"></div><textarea class=\"inp\" id=\"edDesc\" placeholder=\"Anteckningar om tjänsten\"></textarea></div></div>\n      </div>\n      <div class=\"actions\">\n        <button type=\"button\" class=\"btn danger\" id=\"edDelete\" hidden>Ta bort</button>\n        <span class=\"grow\"></span>\n        <button type=\"button\" class=\"btn plain\" id=\"edCancel\">Avbryt</button>\n        <button type=\"submit\" class=\"btn primary\" id=\"edSave\">Spara</button>\n      </div>\n    </form>\n  </div>\n  <div class=\"overlay\" id=\"expOverlay\" hidden>\n    <div class=\"panel\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"expTitle\">\n      <h2 id=\"expTitle\">Utgångna kort</h2>\n      <p class=\"expnote\">Sista ansökningsdagen har passerat för de här korten, så de är dolda på tavlan. Ändra datumet för att få tillbaka ett kort. Kort du har markerat som ansökta visas alltid på tavlan.</p>\n      <div class=\"explist\" id=\"expList\"></div>\n      <div class=\"actions\">\n        <button type=\"button\" class=\"btn danger\" id=\"expDelAll\">Ta bort alla</button>\n        <span class=\"grow\"></span>\n        <button type=\"button\" class=\"btn\" id=\"expClose\">Stäng</button>\n      </div>\n    </div>\n  </div>\n  <div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\" hidden></div>\n</div>\n";
    root.appendChild(tpl.content);

    const $ = (s) => root.querySelector(s);
    const appEl = $('#app'), canvas = $('#canvas'), world = $('#world');
    const fCompany = $('#fCompany'), fStars = $('#fStars'), fStarsTxt = $('#fStarsTxt');
    const resetBtn = $('#resetFilters'), countEl = $('#count'), clearExBtn = $('#clearExamples'), addBtn = $('#addBtn');
    const expBtn = $('#expBtn'), expOverlay = $('#expOverlay'), expList = $('#expList');
    const emptyEl = $('#empty'), emptyTitle = $('#emptyTitle'), emptyText = $('#emptyText'), emptyBtn = $('#emptyBtn');
    const zLabel = $('#zLabel');
    const overlay = $('#overlay'), form = $('#form'), edTitle = $('#edTitle'), edCompany = $('#edCompany'), edPlace = $('#edPlace');
    const edHours = $('#edHours'), edApplied = $('#edApplied'), edDeadline = $('#edDeadline'), fStatus = $('#fStatus'), fSearch = $('#fSearch');
    const linkBar = $('#linkBar'), linkText = $('#linkText');
    const edDesc = $('#edDesc'), edStars = $('#edStars'), edErr = $('#edErr'), edDelete = $('#edDelete');
    const companyList = $('#companyList'), toastEl = $('#toast');
    const markBtn = $('#markBtn'), markAct = $('#markAct'), hintEl = $('#hint');
    const fTag = $('#fTag'), tagList = $('#tagList'), edTags = $('#edTags'), selBar = $('#selBar'), selCount = $('#selCount'), selTag = $('#selTag'), selChips = $('#selChips'), bandEl = $('#band');

    let cards = new Map(), els = new Map(), loaded = false, viewReady = false;
    S.sizeOf = (id) => { const e = els.get(id); return e && e.offsetWidth ? { w: e.offsetWidth, h: e.offsetHeight } : null; };
    let view = { tx: 0, ty: 0, z: 1 };
    const filters = { company: '*', min: 0, status: '*', tag: '*', terms: [] };
    let visibleCount = 0, zTop = 1, markMode = false, ptrDown = false;
    let groups = new Map(), groupOf = new Map(), posMap = new Map(), live = null;
    let dragSet = new Set(), resizeSet = new Set(), linkSource = null, sortMode = 'free', wFactor = 1, hFactor = 1, tFactor = 1, refreshSizes = null;
    // Filtret Ansökta radar upp korten efter ansökningsdatum, vilken ordning som än är vald
    const layoutMode = () => (filters.status === 'applied' ? 'applied' : sortMode);
    const cardWidth = (d) => Math.round(clamp(Number(d && d.w) || CARD_W, MINW, MAXW) * wFactor);
    let selected = new Set(), liveMulti = null, tagBoxes = [], rowBoxes = [], misplaced = new Set();
    const boxEls = new Map();
    let liveTotal = 0, expiredCount = 0, posQueued = false, editingId = null, edRating = 3, companySig = '', lastFocus = null;

    /* ---------- stjärnor, ikoner, toast ---------- */
    const svgEl = (name, attrs) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    function icon(d) {
      const s = svgEl('svg', { viewBox: '0 0 24 24', 'class': 'icon', 'aria-hidden': 'true' });
      s.appendChild(svgEl('path', { d }));
      return s;
    }
    function starSvg() {
      const s = svgEl('svg', { viewBox: '0 0 24 24', 'class': 'star', 'aria-hidden': 'true' });
      s.appendChild(svgEl('polygon', { points: '12,2.5 14.9,8.9 21.8,9.6 16.6,14.3 18.1,21.1 12,17.6 5.9,21.1 7.4,14.3 2.2,9.6 9.1,8.9' }));
      return s;
    }
    function makeStars(container, onPick) {
      container.textContent = '';
      for (let i = 1; i <= 5; i++) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sbtn';
        b.setAttribute('aria-label', i + (i === 1 ? ' stjärna' : ' stjärnor'));
        b.appendChild(starSvg());
        b.addEventListener('click', (ev) => { ev.stopPropagation(); onPick(i); });
        container.appendChild(b);
      }
    }
    function paintStars(container, value) {
      const b = container.children;
      for (let i = 0; i < b.length; i++) {
        b[i].classList.toggle('on', i < value);
        b[i].setAttribute('aria-pressed', (i + 1 === value) ? 'true' : 'false');
      }
    }
    let toastTimer = 0;
    const hideToast = () => { toastEl.hidden = true; };
    function toast(msg, act, ms) {
      toastEl.textContent = '';
      const s = document.createElement('span'); s.textContent = msg; toastEl.appendChild(s);
      if (act) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = act.label;
        b.addEventListener('click', () => { hideToast(); act.fn(); });
        toastEl.appendChild(b);
      }
      toastEl.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, ms || (act ? 7000 : 3500));
    }

    /* ---------- vy (panorera / zooma) ---------- */
    let saveViewTimer = 0;
    function saveViewSoon() {
      clearTimeout(saveViewTimer);
      saveViewTimer = setTimeout(() => {
        try { if (api) api.storage.local.set({ [VIEW_KEY]: view }); else localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {}
      }, 400);
    }
    function applyView() {
      world.style.transform = 'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.z + ')';
      let step = 28;
      while (step * view.z < 14) step *= 2;
      const gs = step * view.z;
      canvas.style.setProperty('--gs', gs + 'px');
      canvas.style.setProperty('--gx', (view.tx - gs / 2) + 'px');
      canvas.style.setProperty('--gy', (view.ty - gs / 2) + 'px');
      zLabel.textContent = Math.round(view.z * 100) + ' %';
      if (viewReady) saveViewSoon();
    }
    let viewAnim = 0;
    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    function tweenView(tx, ty, z, ms) {
      cancelAnimationFrame(viewAnim);
      if (!ms || reducedMotion()) { view.tx = tx; view.ty = ty; view.z = z; applyView(); return; }
      const s = { tx: view.tx, ty: view.ty, z: view.z }, t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        view.tx = s.tx + (tx - s.tx) * e; view.ty = s.ty + (ty - s.ty) * e; view.z = s.z * Math.pow(z / s.z, e);
        applyView();
        if (k < 1) viewAnim = requestAnimationFrame(step);
      };
      viewAnim = requestAnimationFrame(step);
    }
    function zoomAt(cx, cy, nz) {
      cancelAnimationFrame(viewAnim);
      nz = clamp(nz, MINZ, MAXZ);
      const k = nz / view.z;
      view.tx = cx - (cx - view.tx) * k; view.ty = cy - (cy - view.ty) * k; view.z = nz;
      applyView();
    }
    function zoomCenter(f) { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, view.z * f); }
    function fit(animate) {
      const dur = typeof animate === 'number' ? animate : (animate === true ? 600 : 0);
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
      cards.forEach((d, id) => {
        const el = els.get(id);
        if (!el || el.hidden) return;
        const pp = posMap.get(id);
        const x = pp ? pp.x : (Number(d.x) || 0), y = pp ? pp.y : (Number(d.y) || 0);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + el.offsetWidth); y1 = Math.max(y1, y + el.offsetHeight);
        n++;
      });
      if (!n) { tweenView(r.width / 2 - CARD_W / 2, r.height / 2 - 100, 1, dur); return; }
      const pad = 56;
      const z = clamp(Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0)), MINZ, 1.1);
      tweenView((r.width - (x1 - x0) * z) / 2 - x0 * z, (r.height - (y1 - y0) * z) / 2 - y0 * z, z, dur);
    }

    const ptrs = new Map();
    let pinch = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('.card')) return;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
      if (e.shiftKey && e.button === 0 && ptrs.size === 0) { startBand(e); return; }
      cancelAnimationFrame(viewAnim);
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      canvas.classList.add('panning');
      if (ptrs.size === 2) {
        const p = Array.from(ptrs.values());
        pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2 };
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const px = p.x, py = p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 1) {
        view.tx += p.x - px; view.ty += p.y - py; applyView();
      } else if (ptrs.size === 2 && pinch) {
        const a = Array.from(ptrs.values());
        const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
        const mx = (a[0].x + a[1].x) / 2, my = (a[0].y + a[1].y) / 2;
        const r = canvas.getBoundingClientRect();
        view.tx += mx - pinch.mx; view.ty += my - pinch.my;
        zoomAt(mx - r.left, my - r.top, view.z * d / pinch.d);
        pinch.d = d; pinch.mx = mx; pinch.my = my;
      }
    });
    function endPtr(e) {
      if (!ptrs.has(e.pointerId)) return;
      const p0 = ptrs.get(e.pointerId);
      if (e.type === 'pointerup' && ptrs.size === 1 && selected.size && Math.hypot(e.clientX - p0.sx, e.clientY - p0.sy) < 4) clearSelection();
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size === 0) canvas.classList.remove('panning');
    }
    canvas.addEventListener('pointerup', endPtr);
    canvas.addEventListener('pointercancel', endPtr);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= r.height;
      zoomAt(e.clientX - r.left, e.clientY - r.top, view.z * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    $('#zIn').addEventListener('click', () => zoomCenter(1.25));
    $('#zOut').addEventListener('click', () => zoomCenter(0.8));
    zLabel.addEventListener('click', () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1); });
    $('#zFit').addEventListener('click', () => fit(true));
    // Fullskärm: hela kartoteket fyller skärmen (Esc eller samma knapp avslutar)
    {
      const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
      $('#zFull').addEventListener('click', () => {
        try {
          if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
          const rq = host.requestFullscreen || host.webkitRequestFullscreen;
          if (rq) { const pr = rq.call(host); if (pr && pr.catch) pr.catch(() => toast('Webbläsaren tillät inte fullskärm här.')); }
          else toast('Webbläsaren stöder inte fullskärm här.');
        } catch { toast('Webbläsaren tillät inte fullskärm här.'); }
      });
      const onFs = () => { setTimeout(() => { fit(true); }, 150); };
      document.addEventListener('fullscreenchange', onFs); document.addEventListener('webkitfullscreenchange', onFs);
    }

    /* ---------- markera flera kort och taggar ---------- */
    function updateSelection() {
      selected.forEach((id) => { const e = els.get(id); if (!e || e.hidden || !cards.has(id)) selected.delete(id); });
      els.forEach((e, id) => e.classList.toggle('selected', selected.has(id)));
      selBar.hidden = selected.size === 0;
      selCount.textContent = selected.size + (selected.size === 1 ? ' kort valt' : ' kort valda');
    }
    function clearSelection() { selected.clear(); updateSelection(); }
    function toggleSelect(id) { if (selected.has(id)) selected.delete(id); else selected.add(id); updateSelection(); }
    function selectAllVisible() { els.forEach((e, id) => { if (!e.hidden) selected.add(id); }); updateSelection(); }
    function changeTags(ids, fn, msg) {
      const prev = new Map();
      ids.forEach((id) => { const d = cards.get(id); if (d) prev.set(id, tagsOf(d)); });
      let n = 0;
      prev.forEach((old, id) => {
        const nt = normTags(fn(old.slice()));
        if (JSON.stringify(nt) !== JSON.stringify(old)) { patchLocal(id, { tags: nt }); n++; }
      });
      if (!n) { toast('Inget att ändra.'); return 0; }
      toast(msg(n), { label: 'Ångra', fn: () => prev.forEach((old, id) => { if (cards.has(id)) patchLocal(id, { tags: old }); }) });
      return n;
    }
    // Släpp i en eller flera rutor: kortens taggar blir de rutornas taggar (överlapp = flera taggar)
    function moveToBox(ids, boxes) {
      // kortet får taggarna för alla områden det släpps i (yttersta först); släpps det i områden vars taggar det redan har ändras inget
      const bs = boxes.filter((b) => b.key && b.name).sort((p, q) => q.w * q.h - p.w * p.h);
      const want = []; bs.forEach((b) => { if (!want.some((w) => tk(w) === tk(b.name))) want.push(b.name); });
      const wantKeys = new Set(want.map(tk));
      const todo = ids.filter((id) => {
        const d = cards.get(id); if (!d) return false;
        const have = tagsOf(d).map(tk);
        if (!want.length) return have.length > 0;
        return !want.every((w) => have.indexOf(tk(w)) >= 0);
      });
      if (!todo.length) return;
      const label = want.length ? want.map((n) => '«' + n + '»').join(' + ') : 'Utan tagg';
      changeTags(todo, () => want.slice(), (n) => n + ' kort flyttades till ' + label + '.');
    }
    function startMultiDrag(e, el) {
      const anchors = new Map(), members = new Set();
      selected.forEach((sid) => {
        const g = groupIds(sid); g.forEach((m) => members.add(m));
        if (!anchors.has(g[0])) { const ad = cards.get(g[0]); anchors.set(g[0], { x: Number(ad.x) || 0, y: Number(ad.y) || 0 }); }
      });
      dragSet = members;
      try { el.setPointerCapture(e.pointerId); } catch {}
      zTop += 1;
      members.forEach((i) => { const x = els.get(i); if (x) { x.style.zIndex = zTop; x.classList.add('dragging'); } });
      const sx = e.clientX, sy = e.clientY; let moved = false;
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
        moved = true;
        const dx = (ev.clientX - sx) / view.z, dy = (ev.clientY - sy) / view.z;
        liveMulti = new Map(); anchors.forEach((o, a) => liveMulti.set(a, { x: o.x + dx, y: o.y + dy }));
        positionAll();
      };
      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        try { el.releasePointerCapture(e.pointerId); } catch {}
        const lm = liveMulti; liveMulti = null; dragSet = new Set();
        members.forEach((i) => { const x = els.get(i); if (x) x.classList.remove('dragging'); });
        if (moved && lm) {
          anchors.forEach((o, a) => { const q = lm.get(a); patchLocal(a, { x: Math.round(q.x), y: Math.round(q.y) }); });
          members.forEach((i) => patchLocal(i, { z: zTop }));
        }
        positionAll();
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    }
    // Läget "Efter tagg": dra kort (eller alla markerade) till en annan ruta för att byta tagg
    function startTagDrag(e, el, id) {
      const base = selected.has(id) ? Array.from(selected) : [id];
      const all = new Set(); base.forEach((b) => groupIds(b).forEach((i) => all.add(i)));
      const moving = Array.from(all).map((i) => els.get(i)).filter(Boolean);
      dragSet = all;
      try { el.setPointerCapture(e.pointerId); } catch {}
      zTop += 1;
      moving.forEach((x) => { x.style.zIndex = zTop; x.classList.add('dragging'); });
      const sx = e.clientX, sy = e.clientY; let moved = false, target = '';
      const rkOf = (i) => { const dd = cards.get(i); const t = dd ? tagsOf(dd) : []; return t.length ? tk(t[0]) : ''; };
      const headId = groupIds(id)[0], rk0 = rkOf(headId);
      // Omordning i rutan: rutan har platser (även tomma). Korten byter plats en efter en, eller flyttas till en tom plats.
      let cellInfo = null, occ = null, cells = null, hs = -1, ghosts = [];
      const initOrder = () => {
        if (cellInfo || base.length !== 1) return;
        const ci = lastCells.get(rk0);
        if (!ci || ci.occ.indexOf(headId) < 0) return;
        const act = ci.occ.filter(Boolean);
        if (act.some((a) => !posMap.get(a) || !els.get(a))) return;
        // platserna följer med om rutan flyttats för hand
        const f = ci.occ.findIndex((a) => a), dx0 = f >= 0 ? posMap.get(ci.occ[f]).x - ci.base[f].x : 0, dy0 = f >= 0 ? posMap.get(ci.occ[f]).y - ci.base[f].y : 0;
        cellInfo = ci; occ = ci.occ.slice(); hs = occ.indexOf(headId);
        cells = ci.cells.map((c) => ({ x: c.x + dx0, y: c.y + dy0, w: c.w, h: c.h }));
        occ.forEach((a, k) => { if (!a) { const g = document.createElement('div'); g.className = 'cellghost'; g.style.cssText = 'left:' + cells[k].x + 'px;top:' + cells[k].y + 'px;width:' + cells[k].w + 'px;height:' + cells[k].h + 'px'; ghostHost().appendChild(g); ghosts.push(g); } });
      };
      const ghostHost = () => els.get(headId).parentNode;
      const origOcc = () => cellInfo.occ;
      const paintOrder = (instant) => {
        const oo = origOcc();
        occ.forEach((aid, k) => {
          if (!aid || aid === headId) return;
          const oi = oo.indexOf(aid), dx = cells[k].x - cells[oi].x, dy = cells[k].y - cells[oi].y;
          groupIds(aid).map((i) => els.get(i)).filter(Boolean).forEach((x) => { x.style.transition = instant ? 'none' : 'transform .28s cubic-bezier(.3,0,.2,1)'; x.style.transform = (dx || dy) ? 'translate(' + dx + 'px,' + dy + 'px)' : ''; });
        });
      };
      const overCell = (cx, cy) => {
        const cr = canvas.getBoundingClientRect(), wx = (cx - cr.left - view.tx) / view.z, wy = (cy - cr.top - view.ty) / view.z;
        for (let k = 0; k < cells.length; k++) {
          if (k === hs) continue;
          if (wx >= cells[k].x && wx <= cells[k].x + cells[k].w && wy >= cells[k].y && wy <= cells[k].y + cells[k].h) return k;
        }
        return -1;
      };
      const orderChanged = () => !!occ && occ.some((a, k) => a !== cellInfo.occ[k]);
      const clearGhosts = () => { ghosts.forEach((g) => g.remove()); ghosts = []; };
      const resetOrder = (instant) => {
        clearGhosts();
        if (!cellInfo) return;
        const ids = cellInfo.occ.filter((a) => a && a !== headId);
        ids.forEach((aid) => groupIds(aid).map((i) => els.get(i)).filter(Boolean).forEach((x) => { if (instant) x.style.transition = 'none'; x.style.transform = ''; }));
        if (instant) requestAnimationFrame(() => requestAnimationFrame(() => ids.forEach((aid) => groupIds(aid).map((i) => els.get(i)).filter(Boolean).forEach((x) => { x.style.transition = ''; }))));
      };
      const mark = (list) => { const sig = list.map((x) => x.key).join('|'); if (sig === target) return; target = sig; boxEls.forEach((bx, k) => bx.classList.toggle('drop', list.some((x) => x.key === k))); };
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true;
        const dx = (ev.clientX - sx) / view.z, dy = (ev.clientY - sy) / view.z;
        moving.forEach((x) => { x.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; });
        mark(boxesAt(ev.clientX, ev.clientY));
        initOrder();
        if (cellInfo) {
          const k = overCell(ev.clientX, ev.clientY);
          if (k >= 0) {
            const other = occ[k]; occ[k] = headId; occ[hs] = other; hs = k;
            ghosts.forEach((g) => g.remove()); ghosts = [];
            occ.forEach((a, q) => { if (!a) { const g = document.createElement('div'); g.className = 'cellghost'; g.style.cssText = 'left:' + cells[q].x + 'px;top:' + cells[q].y + 'px;width:' + cells[q].w + 'px;height:' + cells[q].h + 'px'; ghostHost().appendChild(g); ghosts.push(g); } });
            paintOrder(false);
          }
        }
      };
      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        try { el.releasePointerCapture(e.pointerId); } catch {}
        moving.forEach((x) => { x.style.transform = ''; x.classList.remove('dragging'); });
        const b = moved && ev.type === 'pointerup' ? boxesAt(ev.clientX, ev.clientY) : [];
        mark([]); dragSet = new Set();
        // släpps kortet utanför alla rutor förlorar det sina taggar (kan ångras)
        let swapped = false;
        if (moved && ev.type === 'pointerup') moveToBox(Array.from(all), b);
        // en omordning i rutan sparas (korten har bytt plats ett efter ett medan kortet drogs)
        if (moved && ev.type === 'pointerup' && cellInfo && orderChanged() && rkOf(headId) === rk0) {
          occ.forEach((aid, k) => { if (aid) patchLocal(aid, { ord: k }); }); swapped = true;
        }
        positionAll();
        resetOrder(swapped);
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    }
    function startBand(e) {
      const r = canvas.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      bandEl.hidden = false;
      const draw = (cx, cy) => {
        const x0 = Math.min(sx, cx), y0 = Math.min(sy, cy), w = Math.abs(cx - sx), h = Math.abs(cy - sy);
        bandEl.style.left = (x0 - r.left) + 'px'; bandEl.style.top = (y0 - r.top) + 'px'; bandEl.style.width = w + 'px'; bandEl.style.height = h + 'px';
        return { x0, y0, x1: x0 + w, y1: y0 + h };
      };
      draw(sx, sy);
      const move = (ev) => { if (ev.pointerId === e.pointerId) draw(ev.clientX, ev.clientY); };
      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up);
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
        const b = draw(ev.clientX, ev.clientY); bandEl.hidden = true;
        els.forEach((el, id) => {
          if (el.hidden) return;
          const q = el.getBoundingClientRect();
          if (q.right >= b.x0 && q.left <= b.x1 && q.bottom >= b.y0 && q.top <= b.y1) selected.add(id);
        });
        updateSelection();
      };
      canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    }

    /* ---------- filter och sökträffar ---------- */
    function matches(d) {
      if (filters.min && rating(d) < filters.min) return false;
      if (filters.company !== '*' && ck(d.company) !== filters.company) return false;
      if (filters.status === 'open' && d.applied) return false;
      if (filters.status === 'applied' && !d.applied) return false;
      if (filters.tag !== '*' && !tagsOf(d).some((x) => tk(x) === filters.tag)) return false;
      if (filters.terms.length) {
        const hay = [d.title, d.company, d.place, d.hours, d.description].join('\n').toLowerCase();
        for (const t of filters.terms) if (hay.indexOf(t) < 0) return false;
      }
      return true;
    }
    const filtersActive = () => filters.min > 0 || filters.company !== '*' || filters.status !== '*' || filters.tag !== '*' || filters.terms.length > 0;

    function paintHits() {
      if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
      CSS.highlights.delete('sok');
      const terms = filters.terms;
      if (!terms.length) return;
      const ranges = [];
      els.forEach((el) => {
        if (el.hidden) return;
        [el._t, el._c, el._pl, el._hv, el._d].forEach((node) => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let tn;
          while ((tn = walker.nextNode())) {
            const txt = tn.nodeValue.toLowerCase();
            terms.forEach((term) => {
              let i = txt.indexOf(term);
              while (i >= 0) {
                const r = new Range(); r.setStart(tn, i); r.setEnd(tn, i + term.length);
                ranges.push(r);
                i = txt.indexOf(term, i + term.length);
              }
            });
          }
        });
      });
      if (ranges.length) CSS.highlights.set('sok', new Highlight(...ranges));
    }

    /* ---------- grupper (kort som sitter ihop i en stapel) ---------- */
    function buildGroups() {
      groups = new Map(); groupOf = new Map();
      const tmp = new Map();
      cards.forEach((d, id) => {
        if (!d.group) return;
        let a = tmp.get(d.group);
        if (!a) { a = []; tmp.set(d.group, a); }
        a.push(id);
      });
      tmp.forEach((ids, gid) => {
        if (ids.length < 2) return;
        ids.sort((a, b) => ((Number(cards.get(a).order) || 0) - (Number(cards.get(b).order) || 0)) || (a < b ? -1 : 1));
        groups.set(gid, ids);
        ids.forEach((id) => groupOf.set(id, gid));
      });
    }
    const groupIds = (id) => { const g = groupOf.get(id); return g ? groups.get(g) : [id]; };

    function rowLayout(by) {
      const pubMode = by === 'published' || by === 'applied', fld = by === 'published' ? 'published' : (by === 'applied' ? 'applied' : 'deadline');
      const units = [];
      cards.forEach((d, id) => {
        if (groupOf.has(id)) return;
        const el = els.get(id);
        if (!el || el.hidden) return;
        units.push({ aid: id, ids: [id], date: d[fld] || '', title: d.title || '' });
      });
      groups.forEach((ids) => {
        const vis = ids.filter((i) => { const e = els.get(i); return e && !e.hidden; });
        if (!vis.length) return;
        let date = '';
        vis.forEach((i) => { const dd = cards.get(i)[fld]; if (dd && (!date || (pubMode ? dd > date : dd < date))) date = dd; });
        units.push({ aid: ids[0], ids: vis, date, title: cards.get(vis[0]).title || '' });
      });
      const byTitle = (a, b) => String(a.title).localeCompare(String(b.title), 'sv', { sensitivity: 'base' });
      units.sort((a, b) => {
        if (a.date && b.date) return a.date === b.date ? byTitle(a, b) : ((a.date < b.date) !== pubMode ? -1 : 1);
        if (a.date) return -1;
        if (b.date) return 1;
        return byTitle(a, b);
      });
      // varje kort (eller kortstapel) får egna rutor, en nästlad ruta för varje tagg
      const SD = 10, TP = 70 + 58 * Math.max(0, tFactor - 1);
      let x = 0; const map = new Map();
      rowBoxes = [];
      // alla kort ligger på samma höjd; rutor för flera taggar sticker upp över dem
      const maxL = units.reduce((m, u) => Math.max(m, tagsOf(cards.get(u.aid)).length, 1), 1);
      // ansökta: en gemensam ruta per månad och år runt korten (utöver rutorna för korten egna taggar)
      const ap = by === 'applied', Y0 = ap ? TP + SD : 0;
      const mk = (u) => { const m = /^(\d{4})-(\d{2})/.exec(String(u.date || '')); return m ? m[1] + '-' + m[2] : ''; };
      const mname = (k) => { if (!k) return 'Utan datum'; let n; try { n = new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, 1).toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' }); } catch { n = k; } return n.charAt(0).toUpperCase() + n.slice(1); };
      let run = null;
      const closeRun = () => { if (!run) return; rowBoxes.push({ key: 'm:' + run.k, name: mname(run.k), hues: [tagHue(mname(run.k))], sm: true, z: -200, x: run.x0, y: 0, w: x - COL_GAP - run.x0 + SD, h: Y0 + maxL * TP + run.h + maxL * SD + SD }); x += 2 * SD; run = null; };
      if (ap) x = SD;
      units.forEach((u) => {
        if (ap) { const mk0 = mk(u); if (!run || run.k !== mk0) { closeRun(); run = { k: mk0, x0: x - SD, h: 0 }; } }
        const tg = tagsOf(cards.get(u.aid)), L = Math.max(1, tg.length);
        let w = 0, h = 0;
        u.ids.forEach((i) => { w = Math.max(w, els.get(i).offsetWidth); h += els.get(i).offsetHeight + STACK_GAP; });
        h -= STACK_GAP;
        const OW = w + 2 * SD * L, OH = h + L * (TP + SD);
        map.set(u.aid, { x: x + L * SD, y: maxL * TP + Y0 });
        for (let k = 0; k < L; k++) rowBoxes.push({ key: 'c:' + u.aid + ':' + k, name: tg.length ? tg[k] : 'Utan tagg', hues: [tg.length ? tagHue(tg[k]) : 210], sm: true, z: k - 100,
          x: x + k * SD, y: Y0 + (maxL - L + k) * TP, w: OW - 2 * k * SD, h: OH - k * (TP + SD) });
        if (run) run.h = Math.max(run.h, h);
        x += OW + COL_GAP;
      });
      closeRun();
      return map;
    }
    // Alla synliga kort får högst samma höjd som det lägsta kortet. Beskrivningen kapas (med toning),
    // hela texten finns i redigeringsfönstret.
    function applyHeightCap() {
      // Mäter alla aktuella kort (även filtrerade) så att måtten, och därmed rutornas storlek, inte ändras av filter
      const all = [];
      els.forEach((e, id) => { const d = cards.get(id); if (d && e._d && !isExpired(d)) all.push(e); });
      const was = all.map((e) => e.hidden);
      all.forEach((e) => { e.hidden = false; e._d.style.maxHeight = ''; e._d.style.minHeight = ''; });
      // delar som inte får plats i kortets bredd (betyg, knappar) förminskas så att de passar
      all.forEach((e) => { if (e.hidden) return; const ft = e.querySelector('.foot'); if (!ft || !e._s || !e._ab) return; let kr = 1, kb = 1; e.style.setProperty('--kr', '1'); e.style.setProperty('--kb', '1'); const W = ft.clientWidth, fl = e._s.parentNode, fr = e._ab.parentNode;
        for (let i = 0; i < 4; i++) { const a1 = Math.min(1, W / Math.max(1, fl.offsetWidth)), b1 = Math.min(1, W / Math.max(1, fr.offsetWidth)); if (a1 >= 1 && b1 >= 1) break; kr = Math.max(0.15, kr * a1 - 0.002); kb = Math.max(0.15, kb * b1 - 0.002); e.style.setProperty('--kr', kr.toFixed(3)); e.style.setProperty('--kb', kb.toFixed(3)); } });
      const grips = all.map((e) => e.querySelector('.grip')); grips.forEach((g) => { if (g) g.style.display = 'none'; });
      grips.forEach((g) => { if (g) g.style.display = ''; });
      if (all.length) {
        const m = all.map((e) => ({ e, h: e.offsetHeight, dh: e._d.offsetHeight }));
        const minH = Math.min.apply(null, m.map((x) => x.h));
        m.forEach((x) => { const cut = x.h - minH; if (cut > 0) x.cap = Math.max(20, x.dh - cut); });
        m.forEach((x) => { if (x.cap) x.e._d.style.maxHeight = x.cap + 'px'; });
        // reglaget för höjd: beskrivningens höjd (lika för alla kort) skalas
        if (hFactor !== 1) m.forEach((x) => { const hh = Math.max(20, Math.round((x.cap || x.dh) * hFactor)) + 'px'; x.e._d.style.minHeight = hh; x.e._d.style.maxHeight = hh; });
        // ordning efter datum: alla kort lika höga (beskrivningen fyller ut det som saknas)
        if (layoutMode() === 'deadline' || layoutMode() === 'published' || layoutMode() === 'applied') {
          const m2 = all.map((e) => ({ e, h: e.offsetHeight, dh: e._d.offsetHeight }));
          const maxH = Math.max.apply(null, m2.map((x) => x.h));
          m2.forEach((x) => { if (x.h < maxH) { const hh = (x.dh + maxH - x.h) + 'px'; x.e._d.style.minHeight = hh; x.e._d.style.maxHeight = hh; } });
        }
      }
      all.forEach((e) => { e._d.classList.toggle('clipped', e._d.scrollHeight - e._d.clientHeight > 1); e._sz = { w: e.offsetWidth, h: e.offsetHeight }; });
      all.forEach((e, i) => { e.hidden = was[i]; });
    }
    // Layout efter tagg: varje tagg får en ruta. Kort med flera taggar läggs där rutorna överlappar.
    // Kort med samma uppsättning taggar bildar en "region". Regionerna placeras i ett rutnät så att varje taggs
    // begränsningsruta innehåller så få regioner som saknar taggen som möjligt (oftast inga).
    const topoCache = { sig: '', plan: null };
    const shapeOv = new Map();   // regionsnyckel -> antal kolumner som användaren valt genom att dra i en rutas kant
    const saveShapes = () => { try { const o = {}; shapeOv.forEach((v, k) => { o[k] = v; }); if (api) api.storage.local.set({ [SHAPE_KEY]: o }); else localStorage.setItem(SHAPE_KEY, JSON.stringify(o)); } catch {} };
    const boxOff = new Map(); let boxSeq = 0, boxSig = null; const PLAN_V = 6;   // höjs när planeringen ändras, så sparade flyttar/planer inte används mot en annan plan   // manuellt flyttade rutor: tagnyckel -> {dx, dy, seq}
    function mulberry(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let r = Math.imul(s ^ (s >>> 15), 1 | s); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
    // shapes[i] = möjliga former (antal kolumner) för region i, med verklig bredd och höjd.
    // Flera regioner får dela cell: de staplas då lodrätt, så att små grannrutor kan ligga i samma kolumn.
    function planRegions(regs, tagKeys, shapes) {
      const R = regs.length;
      const defIdx = (i) => Math.min(shapes[i].length - 1, Math.min(4, Math.max(1, Math.ceil(Math.sqrt(regs[i].units.length)))) - 1);
      if (R === 1) return { pos: [[0, 0]], sh: [defIdx(0)] };
      const has = regs.map((r) => tagKeys.map((k) => r.keys.indexOf(k) >= 0));
      const GXc = 70, GYc = 120, GST = 130, SIDE = 24, TOP = 76;
      // Kostnad = regioner som hamnar i en ruta de inte hör till (mycket dyrt) + rutornas verkliga yta + total yta
      let lastViol = 0, cols = 2, rows = 2;
      const cost = (pos, sh) => {
        const sizes = shapes.map((s, i) => s[sh[i]]);
        const cw = new Array(cols).fill(0), stackH = new Array(rows * cols).fill(0), cnt = new Array(rows * cols).fill(0), off = new Array(R).fill(0);
        for (let i = 0; i < R; i++) {
          const k = pos[i][0] * cols + pos[i][1];
          cw[pos[i][1]] = Math.max(cw[pos[i][1]], sizes[i].w);
          off[i] = cnt[k] ? stackH[k] + GST : 0; stackH[k] = off[i] + sizes[i].h; cnt[k]++;
        }
        const rh = new Array(rows).fill(0);
        for (let k = 0; k < stackH.length; k++) { const r = Math.floor(k / cols); if (stackH[k] > rh[r]) rh[r] = stackH[k]; }
        const cx = new Array(cols).fill(0), ry = new Array(rows).fill(0);
        let X = 0, Y = 0;
        for (let c = 0; c < cols; c++) { cx[c] = X; if (cw[c] > 0) X += cw[c] + GXc; }
        for (let r = 0; r < rows; r++) { ry[r] = Y; if (rh[r] > 0) Y += rh[r] + GYc; }
        const rx = [], rY = [];
        for (let i = 0; i < R; i++) { rx[i] = cx[pos[i][1]]; rY[i] = ry[pos[i][0]] + off[i]; }
        let viol = 0, area = 0, tall = 0;
        for (let t = 0; t < tagKeys.length; t++) {
          let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
          for (let i = 0; i < R; i++) if (has[i][t]) { x0 = Math.min(x0, rx[i]); x1 = Math.max(x1, rx[i] + sizes[i].w); y0 = Math.min(y0, rY[i]); y1 = Math.max(y1, rY[i] + sizes[i].h); }
          if (x1 < 0) continue;
          const bx0 = x0 - SIDE, bx1 = x1 + SIDE, by0 = y0 - TOP, by1 = y1 + SIDE;
          const bw = bx1 - bx0, bh = by1 - by0;
          area += bw * bh;
          tall += Math.max(0, bh - 0.7 * bw) * bw;   // hellre breda än höga rutor
          for (let i = 0; i < R; i++) if (!has[i][t] && rx[i] + sizes[i].w > bx0 + 2 && rx[i] < bx1 - 2 && rY[i] + sizes[i].h > by0 + 2 && rY[i] < by1 - 2) viol++;
        }
        lastViol = viol;
        return viol * 5e8 + area + 0.4 * X * Y + 0.6 * tall + 0.25 * Math.max(0, Y - 0.7 * X) * X;
      };
      let seed = 2166136261;
      regs.forEach((r) => { for (const ch of r.key) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619); });
      const rnd = mulberry(seed);
      // Rätt taggruta går före allt annat: söker först med ett litet rutnät, och om något kort då hamnar fel
      // provas ett större rutnät (mer luft) med fler försök, tills alla kort ligger rätt eller tiden är slut.
      let best = null, bestC = Infinity, bestViol = Infinity;
      const t0 = Date.now();
      const levels = [{ slack: 1.6, restarts: R > 24 ? 3 : 6, iters: R > 24 ? 2500 : 3500 }, { slack: 2.6, restarts: 8, iters: 9000 }, { slack: 4, restarts: 10, iters: 22000 }, { slack: 6, restarts: 10, iters: 30000 }];
      for (let lv = 0; lv < levels.length && bestViol > 0; lv++) {
        const L = levels[lv];
        cols = Math.max(2, Math.ceil(Math.sqrt(R * L.slack))); rows = Math.max(2, Math.ceil(R * L.slack / cols));
        for (let rs = 0; rs < L.restarts; rs++) {
          if (lv > 0 && Date.now() - t0 > 2500) break;
          const cells = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
          for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = cells[i]; cells[i] = cells[j]; cells[j] = x; }
          const pos = regs.map((_, i) => cells[i].slice());
          const sh = regs.map((_, i) => defIdx(i));
          let cur = cost(pos, sh), curV = lastViol;
          for (let it = 0; it < L.iters; it++) {
            const temp = 3e5 * (1 - it / L.iters) + 2e3;
            const i = Math.floor(rnd() * R);
            let undo;
            if (rnd() < 0.3 && shapes[i].length > 1) {
              const oldS = sh[i]; sh[i] = Math.floor(rnd() * shapes[i].length); undo = () => { sh[i] = oldS; };
            } else {
              const old = pos[i].slice(); pos[i] = [Math.floor(rnd() * rows), Math.floor(rnd() * cols)]; undo = () => { pos[i] = old; };
            }
            const c2 = cost(pos, sh);
            if (c2 <= cur || rnd() < Math.exp((cur - c2) / temp)) { cur = c2; curV = lastViol; } else undo();
            if (cur < bestC) { bestC = cur; bestViol = curV; best = { pos: pos.map((q) => q.slice()), sh: sh.slice() }; }
          }
          if (bestViol === 0 && lv > 0) break;
        }
      }
      // Förfining: när alla kort ligger rätt packas planen tätare (bara drag som behåller rätt placering godtas)
      if (best && bestViol === 0) {
        const uR = Array.from(new Set(best.pos.map((q) => q[0]))).sort((a, b) => a - b), uC = Array.from(new Set(best.pos.map((q) => q[1]))).sort((a, b) => a - b);
        rows = uR.length + 1; cols = uC.length + 1;
        const pos = best.pos.map((q) => [uR.indexOf(q[0]), uC.indexOf(q[1])]), sh = best.sh.slice();
        let cur = cost(pos, sh);
        if (lastViol === 0) {
          let bC2 = cur, bP = pos.map((q) => q.slice()), bS = sh.slice();
          const N = 60000, t1 = Date.now();
          for (let it = 0; it < N; it++) {
            if ((it & 255) === 0 && Date.now() - t1 > 2000) break;
            const temp = 1.2e6 * Math.pow(1 - it / N, 2) + 500;
            const i = Math.floor(rnd() * R);
            let undo;
            const u = rnd();
            if (u < 0.25 && shapes[i].length > 1) {
              const oldS = sh[i]; sh[i] = Math.floor(rnd() * shapes[i].length); undo = () => { sh[i] = oldS; };
            } else if (u < 0.6) {
              const old = pos[i].slice(), j = Math.floor(rnd() * R); pos[i] = pos[j].slice(); undo = () => { pos[i] = old; };   // lägg i samma cell som en annan region
            } else {
              const old = pos[i].slice(); pos[i] = [Math.floor(rnd() * rows), Math.floor(rnd() * cols)]; undo = () => { pos[i] = old; };
            }
            const c2 = cost(pos, sh);
            if (lastViol > 0) { undo(); continue; }
            if (c2 <= cur || rnd() < Math.exp((cur - c2) / temp)) { cur = c2; if (cur < bC2) { bC2 = cur; bP = pos.map((q) => q.slice()); bS = sh.slice(); } } else undo();
          }
          best = { pos: bP, sh: bS };
        }
      }
      return best;
    }
    let lastOrder = new Map();   // regionsnyckel -> korten (huvudkort) i visningsordning
    let lastCells = new Map();   // regionsnyckel -> { cells, occ } (platser i rutnätet, tomma = null)
    // Ny layout efter tagg: första taggen ger ett gemensamt område för alla kort som har den.
    // Övriga taggar ritas som nästlade rutor runt varje enskilt kort, i den ordning korten har taggarna.
    const groupPos = new Map();   // områdets senaste plats (utan manuell förflyttning)
    function tagLayout() {
      const ex = Math.max(0, tFactor - 1), SD = 10, TP = 70 + 58 * ex, GU = 16, SIDE = 24, TOPP = 76 + 58 * ex;
      const names = new Map(), groupsM = new Map();
      const addUnit = (aid, ids) => {
        const live = ids.filter((i) => { const e = els.get(i), d = cards.get(i); return e && d && !isExpired(d); });
        if (!live.length) return;
        const vis = live.filter((i) => !els.get(i).hidden);
        const d0 = cards.get(aid), tg = tagsOf(d0);
        tg.forEach((x) => { if (!names.has(tk(x))) names.set(tk(x), x); });
        const key = tg.length ? tk(tg[0]) : '';
        let g = groupsM.get(key);
        if (!g) { g = { key, units: [] }; groupsM.set(key, g); }
        let date = '', w = 0, h = 0;
        live.forEach((i) => { const dd = cards.get(i).deadline; if (dd && (!date || dd < date)) date = dd; const e = els.get(i), sz = e._sz || { w: e.offsetWidth, h: e.offsetHeight }; w = Math.max(w, sz.w); h += sz.h + STACK_GAP; });
        g.units.push({ aid, date, title: d0.title || '', tags: tg, L: Math.max(0, tg.length - 1), w, h: h - STACK_GAP, n: vis.length, last: Number.isFinite(Number(d0.last)) ? Number(d0.last) : 0, ord: (d0.ord !== null && d0.ord !== undefined && Number.isFinite(Number(d0.ord))) ? Number(d0.ord) : null });
      };
      cards.forEach((d, id) => { if (!groupOf.has(id)) addUnit(id, [id]); });
      groups.forEach((ids) => addUnit(ids[0], ids));
      tagBoxes = []; misplaced = new Set(); lastOrder = new Map(); lastCells = new Map();
      const map = new Map();
      const gl = Array.from(groupsM.values()).sort((a, b) => !a.key ? 1 : (!b.key ? -1 : names.get(a.key).localeCompare(names.get(b.key), 'sv', { sensitivity: 'base' })));
      if (!gl.length) return map;
      const byTitleU = (a, b) => String(a.title).localeCompare(String(b.title), 'sv', { sensitivity: 'base' });
      const defCmp = (a, c) => (a.date && c.date) ? (a.date < c.date ? -1 : (a.date > c.date ? 1 : byTitleU(a, c))) : (a.date ? -1 : (c.date ? 1 : byTitleU(a, c)));
      if (!boxSig) { boxSig = 'v'; saveBoxOff(); }
      // Byggare: ett område (eller en sammanslagen undertagg-ruta) innehåller kort utan fler taggar, kort med egna
      // nästlade rutor (en per tagg) och sammanslagna rutor för undertaggar som minst två kort delar.
      const lastCmp = (a, c) => (a.last && c.last) ? (a.last - c.last || defCmp(a, c)) : (a.last ? 1 : (c.last ? -1 : defCmp(a, c)));   // nyss sparade annonser sist
      const cmpOrd = (a, c) => (a.ord !== null && c.ord !== null) ? (a.ord - c.ord || defCmp(a, c)) : (a.ord !== null ? -1 : (c.ord !== null ? 1 : lastCmp(a, c)));
      const build = (units, st, top, gkey, path) => {
        const loose = [], byTag = new Map();
        units.forEach((u) => { if (u.tags.length > st) { const k = tk(u.tags[st]); if (!byTag.has(k)) byTag.set(k, []); byTag.get(k).push(u); } else loose.push(u); });
        const merged = [];
        byTag.forEach((arr, k) => { if (arr.length >= 2) merged.push({ k, arr, name: arr[0].tags[st] }); else loose.push(arr[0]); });
        loose.sort(cmpOrd);
        merged.sort((p, q) => String(p.name).localeCompare(String(q.name), 'sv', { sensitivity: 'base' }));
        const Lof = (u) => Math.max(0, u.tags.length - st);
        let grid = null;
        if (loose.length) {
          const n = loose.length, maxL = Math.max.apply(null, loose.map(Lof));
          const cw = Math.max.apply(null, loose.map((u) => u.w)) + 2 * SD * maxL, ch = Math.max.apply(null, loose.map((u) => u.h)) + maxL * (TP + SD);
          let cols = top ? shapeOv.get(gkey) : 0;
          if (!cols) cols = Math.max(1, Math.min(8, Math.round(Math.sqrt(n * ch / cw * 1.4))));
          cols = Math.max(1, Math.min(cols, n, 8));
          const rows = Math.ceil(n / cols), cap = cols * rows;
          const used = new Array(cap).fill(false), rest = [];
          loose.forEach((u) => { const o = top ? u.ord : null; if (o !== null && Number.isInteger(o) && o >= 0 && o < cap && !used[o]) { used[o] = true; u.slot = o; } else { u.slot = -1; rest.push(u); } });
          let f = 0; rest.forEach((u) => { while (used[f]) f++; used[f] = true; u.slot = f; });
          grid = { n, maxL, cw, ch, cols, rows, w: cols * cw + (cols - 1) * GU, h: rows * ch + (rows - 1) * GU };
        }
        const subs = merged.map((m) => { const inner = build(m.arr, st + 1, false, gkey, path + '>' + m.k); return { m, inner, w: inner.w + 2 * SD, h: inner.h + TP + SD, key: 's:' + gkey + ':' + path + '>' + m.k }; });
        const items = (grid ? [{ grid, w: grid.w, h: grid.h }] : []).concat(subs);
        const area = items.reduce((t, q) => t + q.w * q.h, 0), minW = Math.max.apply(null, items.map((q) => q.w));
        const W = Math.max(minW, Math.sqrt(area) * 1.3);
        let px = 0, py = 0, rh = 0, tw = 0;
        items.forEach((q) => { if (px > 0 && px + q.w > W) { px = 0; py += rh + GU; rh = 0; } q.x = px; q.y = py; px += q.w + GU; rh = Math.max(rh, q.h); tw = Math.max(tw, q.x + q.w); });
        const th = items.length ? py + rh : 0;
        const res = { w: tw, h: th, grid, loose, emit: null };
        res.emit = (ox, oy, lvl) => {
          items.forEach((q) => {
            if (q.grid) {
              const gd = q.grid, cells = [], occ = new Array(gd.cols * gd.rows).fill(null);
              for (let sl = 0; sl < occ.length; sl++) cells.push({ x: ox + q.x + (sl % gd.cols) * (gd.cw + GU), y: oy + q.y + Math.floor(sl / gd.cols) * (gd.ch + GU), w: gd.cw, h: gd.ch });
              loose.forEach((u) => {
                const c = cells[u.slot], L = Lof(u); occ[u.slot] = u.aid;
                // manuellt flyttade underrutor: förflyttningen gäller rutan, rutorna inuti och kortet
                const cum = []; let sx = 0, sy = 0;
                for (let k = 0; k < L; k++) { const f = boxOff.get('c:' + u.aid + ':' + k); if (f) { sx += f.dx; sy += f.dy; } cum.push([sx, sy]); }
                map.set(u.aid, { x: c.x + gd.maxL * SD + sx, y: c.y + gd.maxL * TP + sy });
                const OW = u.w + 2 * SD * L, OH = u.h + L * (TP + SD);
                for (let k = 0; k < L; k++) {
                  const t = u.tags[st + k];
                  tagBoxes.push({ key: 'c:' + u.aid + ':' + k, name: t, hues: [tagHue(t)], sm: true, z: -400 + 20 * lvl + 1 + k, n: 0, hd: TP,
                    x: c.x + (gd.maxL - L + k) * SD + cum[k][0], y: c.y + (gd.maxL - L + k) * TP + cum[k][1], w: OW - 2 * k * SD, h: OH - k * (TP + SD) });
                }
              });
              res.cells = cells; res.occ = occ;
            } else {
              const fo = boxOff.get(q.key) || { dx: 0, dy: 0 };
              tagBoxes.push({ key: q.key, name: q.m.name, hues: [tagHue(q.m.name)], sm: true, z: -400 + 20 * (lvl + 1), n: 0, hd: TP, x: ox + q.x + fo.dx, y: oy + q.y + fo.dy, w: q.w, h: q.h });
              q.inner.emit(ox + q.x + SD + fo.dx, oy + q.y + TP + fo.dy, lvl + 1);
            }
          });
        };
        return res;
      };
      const infos = gl.map((g) => {
        g.units.sort(cmpOrd);
        const res = build(g.units, 1, true, g.key, '');
        const gd = res.grid;
        return { g, res, gd, bw: res.w + 2 * SIDE, bh: res.h + TOPP + SIDE };
      });

      // Områdena behåller sin plats när kartan ritas om (t.ex. när ett kort tas bort). Nya områden, eller områden
      // som växt så att de krockar, får första lediga plats.
      const area = infos.reduce((s, q) => s + q.bw * q.bh, 0), maxBW = Math.max.apply(null, infos.map((q) => q.bw));
      const rowW = Math.max(maxBW, Math.sqrt(area) * 1.5), GAP = 60, placed = [];
      const clash = (x, y, q) => placed.some((r) => x - 8 < r.x + r.bw && r.x - 8 < x + q.bw && y - 8 < r.y + r.bh && r.y - 8 < y + q.bh);   // luften är mindre än den som gäller när man drar (12)
      const fit = (q) => {
        const xs = [10].concat(placed.map((r) => r.x + r.bw + GAP)), ys = [10].concat(placed.map((r) => r.y + r.bh + GAP));
        const cand = [];
        ys.forEach((y) => xs.forEach((x) => { if (x === 10 || x + q.bw <= 10 + rowW) cand.push([x, y]); }));
        cand.sort((m, n) => m[1] - n[1] || m[0] - n[0]);
        for (const c of cand) if (!clash(c[0], c[1], q)) return c;
        return [10, Math.max.apply(null, placed.map((r) => r.y + r.bh)) + GAP];
      };
      // Platserna räknas med områdenas verkliga läge (inklusive förflyttning för hand). Områden som flyttats för hand placeras först och behåller sin plats.
      const later = []; let offLost = false;
      const effOff = (q) => boxOff.get(q.g.key) || { dx: 0, dy: 0 };
      infos.slice().sort((p, q) => ((effOff(q).dx || effOff(q).dy) ? 1 : 0) - ((effOff(p).dx || effOff(p).dy) ? 1 : 0)).forEach((q) => {
        const st = groupPos.get(q.g.key), o = effOff(q);
        if (st && !clash(st.x + o.dx, st.y + o.dy, q)) { q.x = st.x; q.y = st.y; placed.push({ x: q.x + o.dx, y: q.y + o.dy, bw: q.bw, bh: q.bh }); } else later.push(q);
      });
      later.forEach((q) => { if (boxOff.delete(q.g.key)) offLost = true; const c = fit(q); q.x = c[0]; q.y = c[1]; placed.push({ x: q.x, y: q.y, bw: q.bw, bh: q.bh }); });
      if (offLost) saveBoxOff();
      infos.forEach((q) => groupPos.set(q.g.key, { x: q.x, y: q.y }));
      infos.forEach((q) => {
        const g = q.g, o = boxOff.get(g.key) || { dx: 0, dy: 0 };
        q.res.emit(q.x + o.dx + SIDE, q.y + o.dy + TOPP, 0);
        if (q.res.occ) {
          const occ = q.res.occ;
          lastOrder.set(g.key, occ.filter(Boolean));
          lastCells.set(g.key, { cells: q.res.cells, occ, base: occ.map((a) => a ? { x: map.get(a).x, y: map.get(a).y } : null) });
        }
        tagBoxes.push({ key: g.key, name: g.key ? names.get(g.key) : 'Utan tagg', n: g.units.reduce((s, u) => s + u.n, 0), depth: 0, hd: TOPP,
          own: q.gd ? { rk: g.key, n: q.gd.n, cols: q.gd.cols, w: q.gd.w, h: q.gd.h, uw: q.gd.cw, uh: q.gd.ch } : null,
          x: q.x + o.dx, y: q.y + o.dy, w: q.bw, h: q.bh });
      });
      return map;
    }
    // Dra i en rutas rubrik för att flytta rutan och alla kort som ligger inom den
    function saveBoxOff() {
      const o = {}; boxOff.forEach((v, k) => { if (v.dx || v.dy) o[k] = v; });
      const pack = { v: PLAN_V, sig: boxSig, o, plan: topoCache.plan };
      try { if (api) api.storage.local.set({ [BOX_KEY]: pack }); else localStorage.setItem(BOX_KEY, JSON.stringify(pack)); } catch {}
    }
    function startBoxResize(e, b, side) {
      e.stopPropagation(); e.preventDefault();
      const o = b.own, GU = 16, maxC = Math.min(o.n, 8);
      const sx = e.clientX, sy = e.clientY, hx = side.indexOf('r') >= 0 ? 1 : (side.indexOf('l') >= 0 ? -1 : 0), hy = side.indexOf('b') >= 0 ? 1 : (side.indexOf('t') >= 0 ? -1 : 0);
      const ghost = document.createElement('div'); ghost.className = 'rzghost'; const lab = document.createElement('div'); lab.className = 'rzlab'; ghost.appendChild(lab); world.appendChild(ghost);
      let cols = o.cols;
      const el = e.currentTarget; try { el.setPointerCapture(e.pointerId); } catch {}
      const draw = () => {
        const rows = Math.ceil(o.n / cols), W2 = cols * o.uw + (cols - 1) * GU, H2 = rows * o.uh + (rows - 1) * GU;
        const dW = W2 - o.w, dH = H2 - o.h;
        const gx = hx < 0 ? b.x - dW : b.x, gy = hy < 0 ? b.y - dH : b.y;
        ghost.style.left = gx + 'px'; ghost.style.top = gy + 'px'; ghost.style.width = (b.w + dW) + 'px'; ghost.style.height = (b.h + dH) + 'px';
        lab.textContent = cols + (cols === 1 ? ' kolumn' : ' kolumner') + ' · ' + rows + (rows === 1 ? ' rad' : ' rader');
      };
      draw();
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        const dx = hx * (ev.clientX - sx) / view.z, dy = hy * (ev.clientY - sy) / view.z;
        const cH = clamp(Math.round((o.w + dx + GU) / (o.uw + GU)), 1, maxC);
        const rV = clamp(Math.round((o.h + dy + GU) / (o.uh + GU)), 1, o.n), cV = clamp(Math.ceil(o.n / rV), 1, maxC);
        cols = (hx && (!hy || Math.abs(dx) >= Math.abs(dy))) ? cH : cV;
        draw();
      };
      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        try { el.releasePointerCapture(e.pointerId); } catch {}
        ghost.remove();
        if (ev.type === 'pointerup' && cols !== o.cols) { shapeOv.set(o.rk, cols); saveShapes(); positionAll(); }
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    }
    function startBoxDrag(e, b) {
      e.preventDefault(); e.stopPropagation();
      const h = e.currentTarget;
      const boxEl = boxEls.get(b.key);
      // mindre rutor som helt eller delvis överlappar den här rutan följer med (bara åt det hållet)
      const inRect = (q, r) => q.x >= r.x - 1 && q.y >= r.y - 1 && q.x + q.w <= r.x + r.w + 1 && q.y + q.h <= r.y + r.h + 1;
      const kids = b.sm ? tagBoxes.filter((q) => q !== b && q.sm && q.w * q.h < b.w * b.h && inRect(q, b)) : tagBoxes.filter((q) => q !== b && q.w * q.h < b.w * b.h && q.x + q.w > b.x + 2 && q.x < b.x + b.w - 2 && q.y + q.h > b.y + 2 && q.y < b.y + b.h - 2);
      const kidEls = kids.map((q) => boxEls.get(q.key)).filter(Boolean);
      const zone = [b].concat(kids), inside = [];
      posMap.forEach((pp, aid) => { const el = els.get(aid); if (!el) return; const cx = pp.x + 140, cy = pp.y + el.offsetHeight / 2; const d = cards.get(aid); const own = b.key && d && tagsOf(d).length && tk(tagsOf(d)[0]) === b.key; if (own || zone.some((z) => cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h)) inside.push(el); });
      const moving = inside.concat(boxEl ? [boxEl] : [], kidEls);
      try { h.setPointerCapture(e.pointerId); } catch {}
      // området som dras blir otransparent och ligger över andra områden och deras kort (korten i det följer med överst)
      zTop += 4; inside.forEach((x) => { x.style.zIndex = zTop; });
      if (!b.sm && boxEl) { boxEl.style.zIndex = String(zTop - 3); kidEls.forEach((k) => { k.style.zIndex = String(zTop - 2); }); }
      boxEl && boxEl.classList.add('moving');
      const sx = e.clientX, sy = e.clientY; let dx = 0, dy = 0;
      // Rutor får inte dras över varandra: rutan stannar mot andra rutor (och glider längs dem). Underrutor stannar dessutom inne i sitt område
      // och lägger sig inte över syskonrutor eller andra kort. Det som redan överlappar från början räknas inte som hinder.
      const mv = b.sm ? [b] : [b].concat(kids.filter((q) => !q.sm)), GAPB = 12;
      const hit = (m, q, ax, ay) => m.x + ax < q.x + q.w + GAPB && q.x < m.x + ax + m.w + GAPB && m.y + ay < q.y + q.h + GAPB && q.y < m.y + ay + m.h + GAPB;
      let parent = null;
      if (b.sm) tagBoxes.forEach((q) => { if (q !== b && q.w * q.h > b.w * b.h && inRect(b, q) && (!parent || q.w * q.h < parent.w * parent.h)) parent = q; });
      const cardRects = [];
      if (b.sm) posMap.forEach((pp, aid) => { const el = els.get(aid); if (!el || el.hidden) return; const r = { x: pp.x, y: pp.y, w: el.offsetWidth, h: el.offsetHeight }; const cx = r.x + r.w / 2, cy = r.y + r.h / 2; if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) return; cardRects.push(r); });
      const boxObs = tagBoxes.filter((q) => q !== b && mv.indexOf(q) < 0 && kids.indexOf(q) < 0 && (b.sm ? !inRect(b, q) : !q.sm));
      const obs = (mv.length ? boxObs.concat(cardRects) : []).filter((q) => !mv.some((m) => hit(m, q, 0, 0)));
      const inside0 = (ax, ay) => !parent || (b.x + ax >= parent.x + 6 && b.x + ax + b.w <= parent.x + parent.w - 6 && b.y + ay >= parent.y + (parent.hd || 40) - 4 && b.y + ay + b.h <= parent.y + parent.h - 6);
      const useParent = !!parent && inside0(0, 0);
      const free = (ax, ay) => (!useParent || inside0(ax, ay)) && !obs.some((q) => mv.some((m) => hit(m, q, ax, ay)));
      const travel = (a, t) => { const n = Math.max(1, Math.ceil(Math.max(Math.abs(t[0] - a[0]), Math.abs(t[1] - a[1])) / 12)); let ok = a; for (let i = 1; i <= n; i++) { const p = [a[0] + (t[0] - a[0]) * i / n, a[1] + (t[1] - a[1]) * i / n]; if (!free(p[0], p[1])) return ok; ok = p; } return ok; };
      const constrain = (cur, t) => {
        const r = travel(cur, t); if (r[0] === t[0] && r[1] === t[1]) return r;
        const a1 = travel(travel(r, [t[0], r[1]]), [travel(r, [t[0], r[1]])[0], t[1]]);
        const a2 = travel(travel(r, [r[0], t[1]]), [t[0], travel(r, [r[0], t[1]])[1]]);
        const dd = (p) => Math.abs(p[0] - t[0]) + Math.abs(p[1] - t[1]);
        return dd(a1) <= dd(a2) ? a1 : a2;
      };
      let okp = [0, 0];
      // Områden för första taggen får dras fritt över varandra. Släpps ett område på ett annat hamnar det vid närmaste sida om det,
      // och ligger något annat redan där hamnar det så nära som möjligt.
      const resolveDrop = () => {
        const others = tagBoxes.filter((q) => !q.sm && mv.indexOf(q) < 0 && kids.indexOf(q) < 0);
        const ovl = (r, q, g) => r.x < q.x + q.w + g && q.x < r.x + r.w + g && r.y < q.y + q.h + g && q.y < r.y + r.h + g;
        const R0 = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
        const hits = others.filter((q) => ovl(R0, q, 0));
        if (!hits.length) return [dx, dy];
        const area = (q) => Math.max(0, Math.min(R0.x + R0.w, q.x + q.w) - Math.max(R0.x, q.x)) * Math.max(0, Math.min(R0.y + R0.h, q.y + q.h) - Math.max(R0.y, q.y));
        const T = hits.slice().sort((p, q) => area(q) - area(p))[0], G = GAPB;
        const okAt = (x, y) => !others.some((q) => ovl({ x, y, w: b.w, h: b.h }, q, G - 1));
        const dist = (c) => Math.hypot(c.x - R0.x, c.y - R0.y);
        const sides = [{ x: T.x + T.w + G, y: R0.y }, { x: T.x - b.w - G, y: R0.y }, { x: R0.x, y: T.y + T.h + G }, { x: R0.x, y: T.y - b.h - G }].sort((p, q) => dist(p) - dist(q));
        const hitSide = sides.find((c) => okAt(c.x, c.y));
        if (hitSide) return [hitSide.x - b.x, hitSide.y - b.y];
        const xs = [R0.x], ys = [R0.y];
        others.forEach((q) => { xs.push(q.x - b.w - G, q.x + q.w + G); ys.push(q.y - b.h - G, q.y + q.h + G); });
        const want = sides[0]; let best = null, bd = Infinity;
        xs.forEach((x) => ys.forEach((y) => { if (!okAt(x, y)) return; const d = Math.hypot(x - want.x, y - want.y); if (d < bd) { bd = d; best = [x, y]; } }));
        return best ? [best[0] - b.x, best[1] - b.y] : [0, 0];
      };
      // Dras en ruta runt ett enskilt kort över ett annat kort (utan taggen) i området byter de plats, som när man drar kortet självt
      let swap = null; const shifted = new Set();
      if (b.sm && /^c:/.test(b.key)) {
        const aid = b.key.split(':')[1], d0 = cards.get(aid), rk = d0 && tagsOf(d0).length ? tk(tagsOf(d0)[0]) : '', ci = lastCells.get(rk);
        if (ci && ci.occ.indexOf(aid) >= 0 && ci.occ.filter(Boolean).every((a) => posMap.get(a) && els.get(a))) {
          const f = ci.occ.findIndex((a) => a), sx0 = f >= 0 ? posMap.get(ci.occ[f]).x - ci.base[f].x : 0, sy0 = f >= 0 ? posMap.get(ci.occ[f]).y - ci.base[f].y : 0;
          swap = { aid, oo: ci.occ, occ: ci.occ.slice(), hs: ci.occ.indexOf(aid), cells: ci.cells.map((c) => ({ x: c.x + sx0, y: c.y + sy0, w: c.w, h: c.h })) };
        }
      }
      const unitEls = (a) => groupIds(a).map((i) => els.get(i)).filter(Boolean).concat(Array.from({ length: 8 }, (_, j) => boxEls.get('c:' + a + ':' + j)).filter(Boolean));
      const paintSwap = () => {
        swap.occ.forEach((a, k) => {
          if (!a || a === swap.aid) return;
          const oi = swap.oo.indexOf(a), ddx = swap.cells[k].x - swap.cells[oi].x, ddy = swap.cells[k].y - swap.cells[oi].y;
          unitEls(a).forEach((x) => { shifted.add(x); x.style.transition = 'transform .28s cubic-bezier(.3,0,.2,1)'; x.style.transform = (ddx || ddy) ? 'translate(' + ddx + 'px,' + ddy + 'px)' : ''; });
        });
      };
      const swapChanged = () => !!swap && swap.occ.some((a, k) => a !== swap.oo[k]);
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        const tp = [(ev.clientX - sx) / view.z, (ev.clientY - sy) / view.z];
        if (b.sm && !swap && (obs.length || useParent)) okp = constrain(okp, tp); else okp = tp;   // med platsbyte följer rutan musen fritt; om den får ligga kvar avgörs när man släpper
        dx = okp[0]; dy = okp[1];
        moving.forEach((x) => { x.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; });
        if (swap) {
          const cr = canvas.getBoundingClientRect(), wx = (ev.clientX - cr.left - view.tx) / view.z, wy = (ev.clientY - cr.top - view.ty) / view.z;
          for (let k = 0; k < swap.cells.length; k++) {
            const c = swap.cells[k];
            if (k !== swap.hs && wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h) { const other = swap.occ[k]; swap.occ[k] = swap.aid; swap.occ[swap.hs] = other; swap.hs = k; paintSwap(); break; }
          }
        }
      };
      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
        try { h.releasePointerCapture(e.pointerId); } catch {}
        moving.forEach((x) => { x.style.transform = ''; });
        boxEl && boxEl.classList.remove('moving');
        if (ev.type === 'pointerup' && !b.sm && (dx || dy)) { const rr = resolveDrop(); dx = rr[0]; dy = rr[1]; }
        const didSwap = ev.type === 'pointerup' && swapChanged();
        shifted.forEach((x) => { if (didSwap) x.style.transition = 'none'; x.style.transform = ''; });
        if (didSwap) {
          // platsbytet sparas, och rutans egen förflyttning nollställs
          swap.occ.forEach((a, k) => { if (a) patchLocal(a, { ord: k }); });
          let ch = false; for (let j = 0; j < 8; j++) { if (boxOff.delete('c:' + swap.aid + ':' + j)) ch = true; } if (ch) saveBoxOff();
          requestAnimationFrame(() => requestAnimationFrame(() => shifted.forEach((x) => { x.style.transition = ''; })));
        } else if (ev.type === 'pointerup' && (dx || dy) && (!swap || free(dx, dy))) { (b.sm ? [b] : kids.concat([b]).filter((q) => !q.sm)).forEach((q) => { const o = boxOff.get(q.key) || { dx: 0, dy: 0, seq: 0 }; o.dx += dx; o.dy += dy; o.seq = ++boxSeq; boxOff.set(q.key, o); }); saveBoxOff(); }
        positionAll();
      };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
    }
    let holdCard = null;   // håller ett kort kvar på samma plats på skärmen när planen ritas om
    function renderBoxes() {
      els.forEach((e, id) => { const on = layoutMode() === 'tag' && misplaced.has(id); if (e.classList.contains('misplaced') !== on) { e.classList.toggle('misplaced', on); if (on) e.title = 'Kortet ligger i en ruta för en tagg det inte har (taggarna går inte att rita utan överlapp)'; else e.removeAttribute('title'); } });
      root.querySelectorAll('.tagchip[data-tag]').forEach((c) => { const hv = String(tagHue(c.dataset.tag)); if (c.style.getPropertyValue('--h') !== hv) c.style.setProperty('--h', hv); });
      const lm = layoutMode(), want = lm === 'tag' ? tagBoxes : ((lm === 'deadline' || lm === 'published' || lm === 'applied') ? rowBoxes : []);
      const keep = new Set(want.map((b) => b.key));
      boxEls.forEach((el, k) => { if (!keep.has(k)) { el.remove(); boxEls.delete(k); } });
      want.forEach((b) => {
        let el = boxEls.get(b.key);
        if (!el) {
          el = document.createElement('div'); el.className = 'tagbox';
          const h = document.createElement('div'); h.className = 'tagbox-h'; h.title = 'Dra i rubriken för att flytta rutan och korten i den. Dubbelklicka för att återställa platsen.'; el.appendChild(h); el._h = h;
          h.addEventListener('dblclick', () => { if (boxOff.delete(b.key)) { saveBoxOff(); positionAll(); } });
          h.addEventListener('pointerdown', (ev) => { if (ev.button !== 0 || layoutMode() !== 'tag') return; const bb = tagBoxes.find((q) => q.key === b.key); if (bb) startBoxDrag(ev, bb); });
          ['r', 'l', 't', 'b', 'br', 'bl', 'tr', 'tl'].forEach((sd) => {
            const hd = document.createElement('div'); hd.className = 'rz rz-' + sd; hd.title = 'Dra för att ändra rutans form (alla kort måste få plats). Dubbelklicka för att återställa.';
            hd.addEventListener('pointerdown', (ev) => { if (ev.button !== 0 || layoutMode() !== 'tag') return; const bb = tagBoxes.find((q) => q.key === b.key); if (bb && bb.own) startBoxResize(ev, bb, sd); });
            hd.addEventListener('dblclick', () => { const bb = tagBoxes.find((q) => q.key === b.key); if (bb && bb.own && shapeOv.delete(bb.own.rk)) { saveShapes(); positionAll(); } });
            el.appendChild(hd);
          });
          world.insertBefore(el, world.firstChild); boxEls.set(b.key, el);
        }
        el.style.setProperty('--h', b.hues ? b.hues[0] : (b.key ? tagHue(b.name) : 210));
        el.classList.toggle('sm', !!b.sm);
        el.classList.toggle('can', !b.sm && !!b.own);
        el.style.zIndex = b.sm ? String(b.z) : '';
        el.style.background = b.hues && b.hues.length > 1 ? 'linear-gradient(90deg,' + b.hues.map((hh) => 'hsl(' + hh + ' 75% 48% / .2)').join(',') + ')' : '';
        el.style.left = b.x + 'px'; el.style.top = b.y + 'px'; el.style.width = b.w + 'px'; el.style.height = b.h + 'px';
        el._h.textContent = b.name; if (!b.sm) { const cnt = document.createElement('span'); cnt.textContent = '(' + b.n + ')'; el._h.appendChild(cnt); }
      });
      // Rubriker som skulle hamna ovanpå varandra: den större rutans rubrik flyttas till rutans högra sida
      {
        const HH = 62 * Math.max(1, tFactor), rects = [];
        const hit = (r) => rects.some((q) => r.x0 < q.x1 && q.x0 < r.x1 && r.y0 < q.y1 && q.y0 < r.y1);
        want.filter((b) => !b.sm).sort((p, q) => p.w - q.w).forEach((b) => {
          const el = boxEls.get(b.key); if (!el) return;
          el._h.style.textAlign = '';
          const tw = Math.min(el._h.scrollWidth, b.w - 36);
          let r = { x0: b.x + 18, x1: b.x + 18 + tw, y0: b.y + 8, y1: b.y + 8 + HH };
          if (hit(r)) {
            const r2 = { x0: b.x + b.w - 18 - tw, x1: b.x + b.w - 18, y0: r.y0, y1: r.y1 };
            if (!hit(r2)) { r = r2; el._h.style.textAlign = 'right'; }
          }
          rects.push(r);
        });
      }
    }
    // Alla rutor som täcker en punkt (överlapp = flera taggar)
    const boxesAt = (cx, cy) => {
      if (layoutMode() !== 'tag') return [];
      const r = canvas.getBoundingClientRect();
      const wx = (cx - r.left - view.tx) / view.z, wy = (cy - r.top - view.ty) / view.z;
      return tagBoxes.filter((b) => wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h);
    };
    function positionAll() {
      posMap = new Map();
      const lmode = layoutMode(), rowPos = (lmode === 'deadline' || lmode === 'published' || lmode === 'applied') ? rowLayout(lmode) : (lmode === 'tag' ? tagLayout() : null);
      const basePos = (aid, d) => {
        if (rowPos && rowPos.has(aid)) return rowPos.get(aid);
        if (liveMulti && liveMulti.has(aid)) return liveMulti.get(aid);
        if (live && live.id === aid) return live;
        return { x: Number(d.x) || 0, y: Number(d.y) || 0 };
      };
      cards.forEach((d, id) => {
        if (groupOf.has(id)) return;
        const el = els.get(id);
        if (!el) return;
        const p = basePos(id, d);
        posMap.set(id, { x: p.x, y: p.y });
        el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      });
      groups.forEach((ids) => {
        const a = cards.get(ids[0]);
        const p = basePos(ids[0], a);
        let y = p.y;
        ids.forEach((id) => {
          const el = els.get(id);
          if (!el) return;
          posMap.set(id, { x: p.x, y });
          el.style.left = p.x + 'px'; el.style.top = y + 'px';
          if (!el.hidden) y += el.offsetHeight + STACK_GAP;
        });
      });
      renderBoxes();
      if (holdCard) {
        const hc = holdCard, np = posMap.get(hc.id);
        if (np) {
          holdCard = null;
          const nx = hc.sx - np.x * view.z, ny = hc.sy - np.y * view.z;
          if (Math.abs(nx - view.tx) > 0.5 || Math.abs(ny - view.ty) > 0.5) { view.tx = nx; view.ty = ny; applyView(); }
        } else if (Date.now() - hc.t > 1500) holdCard = null;
      }
    }
    function schedulePos() {
      if (posQueued) return;
      posQueued = true;
      requestAnimationFrame(() => { posQueued = false; applyHeightCap(); positionAll(); });
    }
    const ro = window.ResizeObserver ? new ResizeObserver(() => { schedulePos(); }) : null;

    function applyGroupState() {
      els.forEach((el, id) => {
        const gid = groupOf.get(id);
        const ids = gid ? groups.get(gid) : null;
        const i = ids ? ids.indexOf(id) : -1;
        el.classList.toggle('grouped', !!ids);
        el.classList.toggle('has-next', !!ids && i < ids.length - 1);
        el.classList.toggle('has-prev', !!ids && i > 0);
        el._unlink.hidden = !ids;
      });
      markLinkSrc();
    }
    function snapshotFor(ids) {
      const out = {};
      ids.forEach((id) => {
        const d = cards.get(id);
        if (!d) return;
        out[id] = { group: d.group || null, order: d.order == null ? null : d.order, x: Number(d.x) || 0, y: Number(d.y) || 0, w: d.w == null ? null : d.w };
      });
      return out;
    }
    function restoreSnapshot(snap) { Object.keys(snap).forEach((id) => { if (cards.has(id)) store.patch(id, snap[id]); }); }
    function patchLocal(id, p) {
      const d = cards.get(id);
      if (d) Object.assign(d, p);
      store.patch(id, p);
    }
    function refreshLayout() { buildGroups(); applyGroupState(); applyFilters(); positionAll(); updateEmpty(); }
    function shortTitle(id) {
      const d = cards.get(id);
      const t = (d && d.title) ? String(d.title) : 'Utan titel';
      return t.length > 40 ? t.slice(0, 40) + '…' : t;
    }
    function markLinkSrc() {
      const set = linkSource ? new Set(groupIds(linkSource)) : new Set();
      els.forEach((el, id) => el.classList.toggle('link-src', set.has(id)));
    }
    function stopLink() {
      linkSource = null;
      appEl.classList.remove('linking');
      linkBar.hidden = true;
      markLinkSrc();
    }
    function startLink(id) {
      if (linkSource === id) { stopLink(); return; }
      if (markMode) setMarkMode(false);
      linkSource = id;
      appEl.classList.add('linking');
      linkText.textContent = 'Klicka på kortet som «' + shortTitle(id) + '» ska ligga under.';
      linkBar.hidden = false;
      markLinkSrc();
    }
    function doLink(srcId, tgtId) {
      const sg = groupIds(srcId), tg = groupIds(tgtId);
      if (sg.indexOf(tgtId) >= 0) { toast('Välj ett annat kort.'); return; }
      const snap = snapshotFor(sg.concat(tg));
      const gid = groupOf.get(tgtId) || ('g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const tw = Number((cards.get(tgtId) || {}).w) || CARD_W;
      tg.forEach((id, i) => patchLocal(id, { group: gid, order: i }));
      const n = tg.length;
      sg.forEach((id, i) => patchLocal(id, { group: gid, order: n + i, w: tw }));
      stopLink(); refreshLayout();
      toast('Korten sitter ihop nu. De flyttas tillsammans.', { label: 'Ångra', fn: () => restoreSnapshot(snap) });
    }
    function unlinkCard(id) {
      const ids = groupIds(id);
      if (ids.length < 2) return;
      const snap = snapshotFor(ids);
      const aid = ids[0], ad = cards.get(aid);
      const ax = Number(ad.x) || 0, ay = Number(ad.y) || 0;
      const el = els.get(id);
      const w = el ? el.offsetWidth : CARD_W;
      const pp = posMap.get(id) || { x: ax, y: ay };
      const rest = ids.filter((i) => i !== id);
      patchLocal(id, { group: null, order: null, x: Math.round(ax + w + 40), y: Math.round(pp.y) });
      if (rest.length === 1) patchLocal(rest[0], { group: null, order: null, x: ax, y: ay });
      else if (id === aid) patchLocal(rest[0], { x: ax, y: ay });
      refreshLayout();
      toast('Kortet är frikopplat.', { label: 'Ångra', fn: () => restoreSnapshot(snap) });
    }

    /* ---------- kort ---------- */
    function buildCard(id) {
      const el = document.createElement('article');
      el.className = 'card'; el.tabIndex = 0; el.dataset.id = id;
      const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; };
      const ibtn = (label, path, cls) => {
        const b = mk('button', cls || 'ibtn'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label; b.appendChild(icon(path)); return b;
      };
      const t = mk('h3', 'card-title');
      const meta = mk('div', 'meta');
      const c = mk('span', 'company');
      const tag = mk('span', 'tag', 'Exempel');
      meta.append(c, tag);
      const tg = mk('div', 'tags');
      const pl = mk('div', 'place');
      const hrow = mk('div', 'hours');
      const hv = mk('span', 'hval');
      hrow.append(mk('span', 'hlabel', 'Arbetstider'), hv);
      const dl = mk('div', 'dl');
      const dlv = mk('span', 'dlv'), dls = mk('span', 'dls');
      dl.append(mk('span', 'hlabel', 'Sista ansökningsdag'), dlv, dls);
      const pub = mk('div', 'pub');
      const pubv = mk('span', 'pubv'), pubs = mk('span', 'pubs');
      pub.append(mk('span', 'hlabel', 'Upplagd'), pubv, pubs);
      const apl = mk('div', 'apl');
      apl.appendChild(icon('M5 12.5l4.5 4.5L19 7.5'));
      const aplTxt = mk('span'); apl.appendChild(aplTxt);
      const grip = mk('div', 'grip'); grip.title = 'Dra för att ändra bredden';
      const d = mk('p', 'desc');
      const foot = mk('div', 'foot');
      const s = mk('div', 'stars'); s.setAttribute('role', 'group'); s.setAttribute('aria-label', 'Betyg');
      const score = mk('button', 'score'); score.type = 'button'; score.addEventListener('click', (ev) => { ev.stopPropagation(); const cur = cards.get(id); if (cur && rating(cur) > 0) patchLocal(id, { rating: 0 }); });
      const fl = mk('div', 'fl'), fr = mk('div', 'fr');
      const ab = mk('button', 'abtn'); ab.type = 'button'; ab.setAttribute('aria-pressed', 'false');
      ab.appendChild(icon('M5 12.5l4.5 4.5L19 7.5'));
      ab.appendChild(mk('span', null, 'Ansökt'));
      const ob = ibtn('Öppna annonsen', 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5'); ob.hidden = true;
      const wb = ibtn('Öppna ansökningslänken', 'M4 12h14M13 6l6 6-6 6'); wb.hidden = true;
      const lb = ibtn('Koppla ihop med ett annat kort', 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1');
      const ub = ibtn('Koppla loss kortet', 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1M4 4l16 16'); ub.hidden = true;
      const eb = ibtn('Redigera', 'M4 20l1-4L16.5 4.5a1.8 1.8 0 012.5 0l.5.5a1.8 1.8 0 010 2.5L8 19l-4 1zM14 7l3 3');
      const db = ibtn('Ta bort', 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5');
      fl.append(s, score);
      fr.append(ab, ob, wb, lb, ub, eb, db);
      foot.append(fl, fr);
      el.append(t, meta, tg, pl, hrow, dl, pub, apl, d, foot, grip);

      makeStars(s, (n) => { const cur = cards.get(id); if (cur) patchLocal(id, { rating: n === rating(cur) ? 0 : n }); });
      eb.addEventListener('click', () => openEditor(id));
      db.addEventListener('click', () => deleteMany([id], 'Kortet togs bort.'));
      lb.addEventListener('click', () => startLink(id));
      ub.addEventListener('click', () => unlinkCard(id));
      ob.addEventListener('click', () => {
        const cur = cards.get(id);
        if (cur && cur.adId && hooks.openAd) hooks.openAd(AD_URL + cur.adId, cur.title);
      });
      wb.addEventListener('click', () => {
        const cur = cards.get(id);
        if (cur && /^https?:\/\//i.test(cur.applyUrl || '')) window.open(cur.applyUrl, '_blank', 'noopener');
      });
      ab.addEventListener('click', () => {
        const cur = cards.get(id);
        if (!cur) return;
        patchLocal(id, { applied: cur.applied ? null : todayISO() });
        if (isExpired(cards.get(id))) toast('Sista ansökningsdagen har passerat. Kortet ligger under Utgångna.');
      });
      el.addEventListener('click', (e) => {
        if (!linkSource || e.target.closest('button')) return;
        doLink(linkSource, id);
      });
      el.addEventListener('dblclick', (e) => {
        if (linkSource) return;
        if (e.target.closest('button, .grip')) return;
        if (markMode && e.target.closest('.desc, .hval')) return;
        openEditor(id);
      });

      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const cur = cards.get(id);
        if (!cur || linkSource) return;
        e.stopPropagation(); e.preventDefault();
        const gids = groupIds(id);
        resizeSet = new Set(gids);
        try { grip.setPointerCapture(e.pointerId); } catch {}
        const sx = e.clientX, w0 = el.offsetWidth;
        let nw = w0, moved = false;
        const move = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          nw = clamp(w0 + (ev.clientX - sx) / view.z, MINW, MAXW);
          gids.forEach((i) => { const x = els.get(i); if (x) x.style.width = nw + 'px'; });
          moved = true;
        };
        const up = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
          try { grip.releasePointerCapture(e.pointerId); } catch {}
          resizeSet = new Set();
          if (moved) { gids.forEach((i) => patchLocal(i, { w: Math.round(nw / wFactor) })); schedulePos(); }
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
      });

      el.addEventListener('keydown', (e) => {
        if (e.target !== el) return;
        if (e.key === 'Enter') { e.preventDefault(); openEditor(id); return; }
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          const cu = cards.get(id);
          if (!cu) return;
          const w2 = clamp((Number(cu.w) || CARD_W) + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 80 : 20), MINW, MAXW);
          groupIds(id).forEach((i) => { patchLocal(i, { w: w2 }); const x = els.get(i); if (x) x.style.width = w2 + 'px'; });
          return;
        }
        if (layoutMode() !== 'free') return;
        let dx = 0, dy = 0; const stp = e.shiftKey ? 80 : 20;
        if (e.key === 'ArrowLeft') dx = -stp; else if (e.key === 'ArrowRight') dx = stp;
        else if (e.key === 'ArrowUp') dy = -stp; else if (e.key === 'ArrowDown') dy = stp;
        else return;
        e.preventDefault();
        const aid = groupIds(id)[0];
        const cur = cards.get(aid);
        if (!cur) return;
        patchLocal(aid, { x: (Number(cur.x) || 0) + dx, y: (Number(cur.y) || 0) + dy });
        positionAll();
      });

      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button, .grip')) return;
        if (markMode && e.target.closest('.desc, .hval')) return;
        if (linkSource) return;
        const cur = cards.get(id);
        if (!cur) return;
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey || e.shiftKey) { e.preventDefault(); toggleSelect(id); return; }
        if (selected.size && !selected.has(id)) clearSelection();
        if (layoutMode() === 'tag') { startTagDrag(e, el, id); return; }
        if (layoutMode() === 'free' && selected.has(id) && selected.size > 1) { startMultiDrag(e, el); return; }
        if (layoutMode() !== 'free') {
          try { el.setPointerCapture(e.pointerId); } catch {}
          cancelAnimationFrame(viewAnim);
          let lx = e.clientX, ly = e.clientY;
          const pmove = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            view.tx += ev.clientX - lx; view.ty += ev.clientY - ly; lx = ev.clientX; ly = ev.clientY; applyView();
          };
          const pup = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            el.removeEventListener('pointermove', pmove); el.removeEventListener('pointerup', pup); el.removeEventListener('pointercancel', pup);
            try { el.releasePointerCapture(e.pointerId); } catch {}
          };
          el.addEventListener('pointermove', pmove); el.addEventListener('pointerup', pup); el.addEventListener('pointercancel', pup);
          return;
        }
        const gids = groupIds(id), aid = gids[0], ad = cards.get(aid);
        dragSet = new Set(gids);
        try { el.setPointerCapture(e.pointerId); } catch {}
        el.classList.add('dragging');
        zTop += 1;
        gids.forEach((i) => { const x = els.get(i); if (x) x.style.zIndex = zTop; });
        const sx = e.clientX, sy = e.clientY, ox = Number(ad.x) || 0, oy = Number(ad.y) || 0;
        let nx = ox, ny = oy, moved = false;
        const move = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          nx = ox + (ev.clientX - sx) / view.z; ny = oy + (ev.clientY - sy) / view.z;
          live = { id: aid, x: nx, y: ny }; positionAll(); moved = true;
        };
        const up = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
          try { el.releasePointerCapture(e.pointerId); } catch {}
          el.classList.remove('dragging');
          dragSet = new Set(); live = null;
          if (moved) gids.forEach((i) => {
            const p = { z: zTop };
            if (i === aid) { p.x = Math.round(nx); p.y = Math.round(ny); }
            patchLocal(i, p);
          });
          positionAll();
        };
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      });

      Object.assign(el, { _pub: pub, _pubv: pubv, _pubs: pubs, _tags: tg, _t: t, _c: c, _pl: pl, _tag: tag, _h: hrow, _hv: hv, _d: d, _s: s, _score: score, _dl: dl, _dlv: dlv, _dls: dls,
        _apl: apl, _aplTxt: aplTxt, _ab: ab, _unlink: ub, _open: ob, _web: wb });
      if (ro) ro.observe(el);
      return el;
    }

    function renderPub(el, d) {
      const txt = fmtDate(d.published);
      el._pub.hidden = !txt;
      if (!txt) { el._pubv.textContent = ''; el._pubs.textContent = ''; return; }
      const n = daysUntil(d.published);
      const days = n === null ? null : Math.max(0, -n);
      el._pubv.textContent = txt;
      el._pubs.textContent = days === null ? '' : ' · ' + (days === 0 ? 'upplagd idag' : 'legat uppe ' + days + (days === 1 ? ' dag' : ' dagar'));
    }
    function renderDeadline(el, d) {
      const txt = fmtDate(d.deadline);
      el._dl.hidden = !txt;
      el._dl.classList.remove('warn', 'urgent');
      el.classList.remove('warn', 'urgent');
      if (!txt) { el._dlv.textContent = ''; el._dls.textContent = ''; return; }
      const n = daysUntil(d.deadline);
      let st = '', cls = '';
      if (n !== null && !d.applied) {
        st = n < 0 ? 'har gått ut' : n === 0 ? 'idag' : n === 1 ? 'imorgon' : 'om ' + n + ' dagar';
        if (n <= 5) cls = 'urgent'; else if (n <= 7) cls = 'warn';
      }
      el._dlv.textContent = txt;
      el._dls.textContent = st ? ' · ' + st : '';
      if (cls) { el._dl.classList.add(cls); el.classList.add(cls); }
    }

    function updateCard(el, id, d) {
      const r = rating(d);
      const sig = [d.title, d.company, d.place, d.hours, d.description, r, d.example ? 1 : 0, d.applied || '', d.published || '', d.deadline || '', d.adId || '', d.applyUrl || '', JSON.stringify(d.marks || []), tagsOf(d).join('\u0002')].join('\u0001');
      if (el._sig !== sig) {
        el._sig = sig;
        const co = String(d.company || '').trim(), hrs = String(d.hours || '').trim(), plc = String(d.place || '').trim();
        const ap = fmtDate(d.applied), dlt = fmtDate(d.deadline);
        el.classList.toggle('applied', !!ap);
        el._apl.hidden = !ap;
        el._aplTxt.textContent = 'Ansökt ' + ap;
        el._ab.setAttribute('aria-pressed', ap ? 'true' : 'false');
        el._ab.title = ap ? 'Ta bort markeringen som ansökt' : 'Markera som ansökt idag';
        el._t.textContent = d.title || 'Utan titel';
        el._c.textContent = co || 'Inget företag';
        el._c.classList.toggle('none', !co);
        el._pl.textContent = plc; el._pl.hidden = !plc;
        el._tag.hidden = !d.example;
        el._tags.textContent = '';
        tagsOf(d).forEach((x) => { const s = document.createElement('span'); s.className = 'tagchip'; s.dataset.tag = x; s.textContent = x; s.style.setProperty('--h', tagHue(x));
          const xb = document.createElement('button'); xb.type = 'button'; xb.className = 'tagx'; xb.textContent = '×'; xb.title = 'Ta bort taggen «' + x + '» från kortet'; xb.setAttribute('aria-label', xb.title);
          xb.addEventListener('click', (ev) => { ev.stopPropagation(); const op = posMap.get(id); if (op) holdCard = { id, sx: view.tx + op.x * view.z, sy: view.ty + op.y * view.z, t: Date.now() }; changeTags([id], (old) => old.filter((o) => tk(o) !== tk(x)), () => 'Taggen «' + x + '» togs bort.'); });
          s.appendChild(xb); el._tags.appendChild(s); });
        el._tags.hidden = !el._tags.firstChild;
        el._h.hidden = !hrs;
        el._open.hidden = !d.adId;
        el._web.hidden = !/^https?:\/\//i.test(d.applyUrl || '');
        renderMarked(el._hv, ftext(d, 'hours'), d.marks, 'hours');
        renderMarked(el._d, ftext(d, 'description'), d.marks, 'description');
        paintStars(el._s, r);
        el._score.textContent = r + '/5'; el._score.title = r > 0 ? 'Klicka för att nollställa betyget' : ''; el._score.style.cursor = r > 0 ? 'pointer' : 'default';
        el.setAttribute('aria-label', (d.title || 'Kort') + (co ? ', ' + co : '') + (hrs ? ', arbetstider ' + hrs : '') + (ap ? ', ansökt ' + ap : '') + (dlt ? ', sista ansökningsdag ' + dlt : '') + ', betyg ' + r + ' av 5');
      }
      renderDeadline(el, d); renderPub(el, d);
      if (!dragSet.has(id)) el.style.zIndex = Number(d.z) || 1;
      if (!resizeSet.has(id)) el.style.width = cardWidth(d) + 'px';
    }

    function refreshCompanies() {
      const seen = new Map();
      let liveN = 0;
      cards.forEach((d) => {
        if (isExpired(d)) return;
        liveN++;
        const k = ck(d.company);
        let o = seen.get(k);
        if (!o) { o = { label: String(d.company || '').trim(), count: 0 }; seen.set(k, o); }
        o.count++;
      });
      const keys = Array.from(seen.keys()).sort((a, b) => {
        if (!a) return 1; if (!b) return -1;
        return seen.get(a).label.localeCompare(seen.get(b).label, 'sv');
      });
      const sig = liveN + '|' + keys.map((k) => k + ':' + seen.get(k).count + ':' + seen.get(k).label).join('\n');
      if (sig !== companySig) {
        companySig = sig;
        fCompany.textContent = '';
        const all = document.createElement('option');
        all.value = '*'; all.textContent = 'Alla företag (' + liveN + ')';
        fCompany.appendChild(all);
        companyList.textContent = '';
        keys.forEach((k) => {
          const o = document.createElement('option');
          o.value = k; o.textContent = (k ? seen.get(k).label : 'Utan företag') + ' (' + seen.get(k).count + ')';
          fCompany.appendChild(o);
          if (k) { const dl = document.createElement('option'); dl.value = seen.get(k).label; companyList.appendChild(dl); }
        });
      }
      if (filters.company !== '*' && !seen.has(filters.company)) filters.company = '*';
      fCompany.value = filters.company;
    }

    let tagSig = '';
    function refreshTags() {
      const seen = new Map();
      cards.forEach((d) => { if (isExpired(d)) return; tagsOf(d).forEach((x) => { const o = seen.get(tk(x)) || { label: x, n: 0 }; o.n++; seen.set(tk(x), o); }); });
      if (hueReady && loaded && cards.size) { let ch = false; tagHues.forEach((v, k) => { if (!seen.has(k)) { tagHues.delete(k); ch = true; } }); if (ch) saveHues(); }
      const keys = Array.from(seen.keys()).sort((a, b) => seen.get(a).label.localeCompare(seen.get(b).label, 'sv'));
      const sig = keys.map((k) => k + ':' + seen.get(k).n + ':' + seen.get(k).label).join('\n');
      if (sig !== tagSig) {
        tagSig = sig;
        fTag.textContent = ''; tagList.textContent = ''; selChips.textContent = '';
        const all = document.createElement('option'); all.value = '*'; all.textContent = 'Alla taggar'; fTag.appendChild(all);
        keys.forEach((k) => {
          const o = document.createElement('option'); o.value = k; o.textContent = seen.get(k).label + ' (' + seen.get(k).n + ')'; fTag.appendChild(o);
          const dl = document.createElement('option'); dl.value = seen.get(k).label; tagList.appendChild(dl);
          const lab = seen.get(k).label;
          const cb = document.createElement('button'); cb.type = 'button'; cb.className = 'tagchip pick'; cb.dataset.tag = lab; cb.textContent = lab; cb.style.setProperty('--h', tagHue(lab)); cb.title = 'Lägg till taggen «' + lab + '» på de markerade korten';
          cb.addEventListener('click', () => {
            changeTags(Array.from(selected), (old) => { if (!old.some((o) => tk(o) === tk(lab))) old.push(lab); return old; }, (n) => n + ' kort fick taggen ' + lab + '.');
          });
          selChips.appendChild(cb);
        });
      }
      if (filters.tag !== '*' && !seen.has(filters.tag)) filters.tag = '*';
      fTag.value = filters.tag;
    }
    function applyFilters() {
      let n = 0;
      const okMap = new Map();
      cards.forEach((d, id) => okMap.set(id, !isExpired(d) && matches(d)));
      groups.forEach((ids) => {
        if (ids.some((i) => okMap.get(i))) ids.forEach((i) => { if (!isExpired(cards.get(i))) okMap.set(i, true); });
      });
      cards.forEach((d, id) => {
        const el = els.get(id);
        if (!el) return;
        const ok = !!okMap.get(id);
        el.hidden = !ok;
        if (ok) n++;
      });
      visibleCount = n;
      let total = 0, expN = 0;
      cards.forEach((d) => { if (isExpired(d)) expN++; else total++; });
      liveTotal = total; expiredCount = expN;
      updateExpiredBtn();
      countEl.textContent = filtersActive() ? (n + ' av ' + total + ' kort') : (total + ' kort');
      resetBtn.hidden = !filtersActive();
      paintStars(fStars, filters.min);
      fStarsTxt.textContent = filters.min ? filters.min + '+' : '';
      fStatus.value = filters.status;
      updateSelection();
      applyHeightCap();
      positionAll();
      paintHits();
    }

    function updateEmpty() {
      let show = true;
      emptyBtn.hidden = true; emptyBtn.onclick = null;
      if (!loaded) {
        emptyTitle.textContent = 'Hämtar dina kort'; emptyText.textContent = 'Det här tar bara en stund.';
      } else if (liveTotal === 0 && expiredCount > 0) {
        emptyTitle.textContent = 'Inga aktuella kort';
        emptyText.textContent = 'Alla dina kort har passerat sista ansökningsdag. Du hittar dem under Utgångna.';
        emptyBtn.textContent = 'Visa utgångna'; emptyBtn.hidden = false; emptyBtn.onclick = openExp;
      } else if (liveTotal === 0) {
        emptyTitle.textContent = 'Inga kort ännu';
        emptyText.textContent = 'Spara en annons som favorit i Platsbanken så skapas ett kort med annonsens uppgifter. Du kan också lägga in ett kort själv med Nytt kort.';
        emptyBtn.textContent = 'Nytt kort'; emptyBtn.hidden = false; emptyBtn.onclick = () => openEditor(null);
      } else if (visibleCount === 0) {
        emptyTitle.textContent = 'Inget kort matchar filtren';
        emptyText.textContent = 'Prova ett annat sökord, ett lägre betyg eller alla företag.';
        emptyBtn.textContent = 'Nollställ filter'; emptyBtn.hidden = false; emptyBtn.onclick = resetFilters;
      } else show = false;
      emptyEl.hidden = !show;
    }

    function sync() {
      els.forEach((el, id) => { if (!cards.has(id)) { if (ro) ro.unobserve(el); el.remove(); els.delete(id); } });
      buildGroups();
      let ex = 0;
      cards.forEach((d, id) => {
        let el = els.get(id);
        if (!el) { el = buildCard(id); els.set(id, el); world.appendChild(el); }
        updateCard(el, id, d);
        zTop = Math.max(zTop, Number(d.z) || 0);
        if (d.example) ex++;
      });
      if (linkSource && !cards.has(linkSource)) stopLink();
      applyGroupState(); refreshCompanies(); refreshTags(); applyFilters(); updateEmpty(); updateSavedBtn();
      clearExBtn.hidden = ex === 0;
      clearExBtn.textContent = 'Rensa exempelkort (' + ex + ')';
    }

    function deleteMany(ids, msg) {
      ids = ids.filter((id) => cards.has(id));
      if (!ids.length) return;
      const set = new Set(ids);
      const orig = {};
      ids.forEach((id) => { const r = Object.assign({}, cards.get(id)); delete r.id; orig[id] = r; });
      const surv = new Set();
      ids.forEach((id) => groupIds(id).forEach((i) => { if (!set.has(i)) surv.add(i); }));
      const snap = snapshotFor(Array.from(surv));
      const seenG = new Set();
      ids.forEach((id) => {
        const gid = groupOf.get(id);
        if (!gid || seenG.has(gid)) return;
        seenG.add(gid);
        const all = groups.get(gid), keep = all.filter((i) => !set.has(i));
        const ad = cards.get(all[0]);
        const ax = Number(ad.x) || 0, ay = Number(ad.y) || 0;
        if (keep.length === 1) patchLocal(keep[0], { group: null, order: null, x: ax, y: ay });
        else if (keep.length > 1 && set.has(all[0])) patchLocal(keep[0], { x: ax, y: ay });
      });
      ids.forEach((id) => {
        if (linkSource === id) stopLink();
        store.remove(id);
        cards.delete(id);
        const el = els.get(id);
        if (el) { if (ro) ro.unobserve(el); el.remove(); els.delete(id); }
      });
      refreshCompanies(); refreshLayout();
      toast(msg || (ids.length + ' kort togs bort.'), { label: 'Ångra', fn: () => {
        ids.forEach((id) => store.restore(id, orig[id]));
        restoreSnapshot(snap);
      } });
    }

    /* ---------- utgångna kort ---------- */
    function expiredIds() {
      const a = [];
      cards.forEach((d, id) => { if (isExpired(d)) a.push(id); });
      a.sort((x, y) => String(cards.get(x).deadline).localeCompare(String(cards.get(y).deadline)));
      return a;
    }
    function updateExpiredBtn() {
      expBtn.hidden = expiredCount === 0;
      expBtn.textContent = 'Utgångna (' + expiredCount + ')';
      if (!expOverlay.hidden) { if (expiredCount === 0) closeExp(); else renderExpired(); }
    }
    function renderExpired() {
      expList.textContent = '';
      expiredIds().forEach((id) => {
        const d = cards.get(id);
        const row = document.createElement('div'); row.className = 'exprow';
        const info = document.createElement('div'); info.className = 'expinfo';
        const t = document.createElement('div'); t.className = 'expt'; t.textContent = d.title || 'Utan titel';
        const m = document.createElement('div'); m.className = 'expm';
        m.textContent = (d.company ? d.company + ' · ' : '') + 'sista dag ' + fmtDate(d.deadline);
        info.append(t, m);
        const eb = document.createElement('button'); eb.type = 'button'; eb.className = 'btn'; eb.textContent = 'Ändra datum';
        eb.addEventListener('click', () => { closeExp(); openEditor(id); });
        const db = document.createElement('button'); db.type = 'button'; db.className = 'btn danger'; db.textContent = 'Ta bort';
        db.addEventListener('click', () => deleteMany([id], 'Kortet togs bort.'));
        row.append(info, eb, db);
        expList.appendChild(row);
      });
    }
    function openExp() {
      lastFocus = root.activeElement;
      renderExpired(); expOverlay.hidden = false;
      setTimeout(() => $('#expClose').focus(), 0);
    }
    function closeExp() {
      expOverlay.hidden = true;
      if (lastFocus && lastFocus.isConnected) { try { lastFocus.focus(); } catch {} }
    }
    expBtn.addEventListener('click', openExp);
    $('#expClose').addEventListener('click', closeExp);
    $('#expDelAll').addEventListener('click', () => {
      const ids = expiredIds();
      closeExp();
      deleteMany(ids, ids.length + (ids.length === 1 ? ' utgånget kort togs bort.' : ' utgångna kort togs bort.'));
    });

    /* ---------- filter och sök ---------- */
    function resetFilters() {
      filters.company = '*'; filters.min = 0; filters.status = '*'; filters.tag = '*'; filters.terms = [];
      fCompany.value = '*'; fTag.value = '*'; fSearch.value = '';
      applyFilters(); updateEmpty();
    }
    function runSearch() {
      filters.terms = fSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
      applyFilters(); updateEmpty();
    }
    fSearch.addEventListener('input', runSearch);
    fSearch.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); fit(true); }
      else if (e.key === 'Escape') { if (fSearch.value) { fSearch.value = ''; runSearch(); } else fSearch.blur(); }
    });
    fCompany.addEventListener('change', () => { filters.company = fCompany.value; applyFilters(); updateEmpty(); });
    fStatus.addEventListener('change', () => {
      const was = layoutMode();
      filters.status = fStatus.value; if (refreshSizes) refreshSizes(); applyFilters(); updateEmpty();
      if (layoutMode() !== was) {
        if (!reducedMotion()) { world.classList.add('glide'); clearTimeout(glideTimer); glideTimer = setTimeout(() => world.classList.remove('glide'), 1400); }
        fit(1200);
      }
    });
    fTag.addEventListener('change', () => { filters.tag = fTag.value; applyFilters(); updateEmpty(); });
    $('#linkCancel').addEventListener('click', stopLink);
    makeStars(fStars, (n) => { filters.min = filters.min === n ? 0 : n; applyFilters(); updateEmpty(); });
    resetBtn.addEventListener('click', resetFilters);
    clearExBtn.addEventListener('click', () => {
      const ids = [];
      cards.forEach((d, id) => { if (d.example) ids.push(id); });
      ids.forEach((id) => store.remove(id));
      toast('Exempelkorten är borttagna.');
    });

    /* ---------- redigering ---------- */
    makeStars(edStars, (n) => { edRating = edRating === n ? 0 : n; paintStars(edStars, edRating); });
    function newSpot() {
      const r = canvas.getBoundingClientRect();
      const j = () => (Math.random() - 0.5) * 60;
      return { x: Math.round((r.width / 2 - view.tx) / view.z - CARD_W / 2 + j()), y: Math.round((r.height / 2 - view.ty) / view.z - 90 + j()) };
    }
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    // Markering i redigeringsfönstret: intervall i beskrivningstexten, ritas i ett lager bakom textrutan
    let edMarks = [], edPrev = '';
    const edMirror = $('#edMirror'), edMarkBtn = $('#edMark');
    function edPaint() {
      const text = edDesc.value; edMirror.textContent = '';
      let pos = 0;
      edMarks.forEach((m) => {
        if (m.s > pos) edMirror.appendChild(document.createTextNode(text.slice(pos, m.s)));
        const mk = document.createElement('mark'); mk.textContent = text.slice(m.s, m.e); edMirror.appendChild(mk); pos = m.e;
      });
      edMirror.appendChild(document.createTextNode(text.slice(pos) + '\n'));
      edMirror.scrollTop = edDesc.scrollTop;
    }
    function edShift() {
      const a = edPrev, b = edDesc.value; if (a === b) return;
      let i = 0; const mx = Math.min(a.length, b.length);
      while (i < mx && a[i] === b[i]) i++;
      let j = 0; while (j < mx - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
      const rs = i, re = a.length - j, delta = b.length - a.length;
      const out = [];
      edMarks.forEach((m) => {
        if (m.e <= rs) { out.push({ s: m.s, e: m.e }); return; }
        if (m.s >= re) { out.push({ s: m.s + delta, e: m.e + delta }); return; }
        const l = m.s < rs ? { s: m.s, e: rs } : null, r = m.e > re ? { s: re + delta, e: m.e + delta } : null;
        if (l && r) out.push({ s: l.s, e: r.e }); else if (l) out.push(l); else if (r) out.push(r);
      });
      edMarks = out.filter((m) => m.e > m.s && m.e <= b.length); edPrev = b;
    }
    const edSel = () => ({ s: edDesc.selectionStart, e: edDesc.selectionEnd });
    function edBtn() {
      const q = edSel();
      if (q.e <= q.s) { edMarkBtn.disabled = true; edMarkBtn.textContent = 'Markera text'; return; }
      edMarkBtn.disabled = false;
      edMarkBtn.textContent = edMarks.some((m) => m.s <= q.s && m.e >= q.e) ? 'Ta bort markering' : 'Markera text';
    }
    function edToggle() {
      const q = edSel(); if (q.e <= q.s) return;
      edMarks = edMarks.some((m) => m.s <= q.s && m.e >= q.e) ? subtractRange(edMarks, q.s, q.e) : unionRange(edMarks, q.s, q.e);
      edPaint(); edBtn(); edDesc.focus();
    }
    edMarkBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    edMarkBtn.addEventListener('mousedown', (e) => e.preventDefault());
    edMarkBtn.addEventListener('click', edToggle);
    edDesc.addEventListener('input', () => { edShift(); edPaint(); edBtn(); });
    edDesc.addEventListener('scroll', () => { edMirror.scrollTop = edDesc.scrollTop; });
    ['select', 'keyup', 'mouseup', 'focus', 'blur'].forEach((t) => edDesc.addEventListener(t, edBtn));
    edDesc.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); edToggle(); } });
    function edMarksOut(trimmed) {
      const raw = edDesc.value, lead = raw.length - raw.trimStart().length;
      const out = [];
      edMarks.forEach((m) => { const s2 = Math.max(0, m.s - lead), e2 = Math.min(trimmed.length, m.e - lead); if (e2 > s2) out.push({ f: 'description', s: s2, e: e2, t: trimmed.slice(s2, e2) }); });
      return out;
    }
    function openEditor(id) {
      lastFocus = root.activeElement;
      editingId = id;
      const d = id ? cards.get(id) : null;
      $('#formTitle').textContent = d ? 'Redigera kort' : 'Nytt kort';
      edTitle.value = d ? (d.title || '') : '';
      edCompany.value = d ? (d.company || '') : '';
      edPlace.value = d ? (d.place || '') : '';
      edHours.value = d ? (d.hours || '') : '';
      edApplied.value = d && ISO.test(d.applied || '') ? d.applied : '';
      edDeadline.value = d && ISO.test(d.deadline || '') ? d.deadline : '';
      edDesc.value = d ? (d.description || '') : '';
      edPrev = edDesc.value;
      edMarks = d ? rangesOf(d, 'description').filter((m) => m.e <= edPrev.length).sort((x, y) => x.s - y.s) : [];
      { const merged = []; edMarks.forEach((m) => { const l = merged[merged.length - 1]; if (l && m.s <= l.e) l.e = Math.max(l.e, m.e); else merged.push({ s: m.s, e: m.e }); }); edMarks = merged; }
      edPaint(); edBtn();
      edTags.value = d ? tagsOf(d).join(', ') : '';
      edRating = d ? rating(d) : 3;
      paintStars(edStars, edRating);
      edErr.hidden = true; edDelete.hidden = !d; overlay.hidden = false;
      setTimeout(() => edTitle.focus(), 0);
    }
    function closeEditor() {
      overlay.hidden = true; editingId = null;
      if (lastFocus && lastFocus.isConnected) { try { lastFocus.focus(); } catch {} }
    }
    addBtn.addEventListener('click', () => openEditor(null));
    $('#edCancel').addEventListener('click', closeEditor);
    edDelete.addEventListener('click', () => { const id = editingId; closeEditor(); if (id) deleteMany([id], 'Kortet togs bort.'); });
    $('#edAppliedClear').addEventListener('click', () => { edApplied.value = ''; });
    $('#edDeadlineClear').addEventListener('click', () => { edDeadline.value = ''; });
    function refreshDeadlines() {
      els.forEach((el, id) => { const d = cards.get(id); if (d) { renderDeadline(el, d); renderPub(el, d); } });
      refreshCompanies(); applyFilters(); updateEmpty();
    }
    setInterval(() => { if (host.isConnected) refreshDeadlines(); }, 600000);
    edDesc.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
    edTitle.addEventListener('input', () => { edErr.hidden = true; });
    // Tangentbord i formulären ska inte nå Platsbankens egna genvägar
    ['keydown', 'keyup', 'keypress'].forEach((t) => form.addEventListener(t, (e) => { if (e.key !== 'Escape') e.stopPropagation(); }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = edTitle.value.trim();
      if (!title) { edErr.hidden = false; edTitle.focus(); return; }
      const data = { title, company: edCompany.value.trim(), place: edPlace.value.trim(), hours: edHours.value.trim(), description: edDesc.value.trim(),
        rating: edRating, applied: edApplied.value || null, deadline: edDeadline.value || null, tags: normTags(edTags.value) };
      if (editingId) {
        const p = Object.assign({}, data, { example: false });
        const oldCard = cards.get(editingId);
        const oth = oldCard && Array.isArray(oldCard.marks) ? remapMarks(oldCard.marks.filter((m) => m && m.f === 'hours'), { hours: data.hours }) : [];
        p.marks = oth.concat(edMarksOut(data.description));
        store.patch(editingId, p);
      } else {
        const spot = newSpot();
        zTop += 1;
        store.create(Object.assign(data, { x: spot.x, y: spot.y, z: zTop, createdAt: Date.now(), example: false, marks: edMarksOut(data.description) }));
      }
      closeEditor();
      if (data.deadline && !data.applied && daysUntil(data.deadline) < 0) toast('Sista ansökningsdagen har passerat. Kortet ligger under Utgångna.');
      else if (filtersActive() && !matches(data)) toast('Kortet är dolt av dina filter.', { label: 'Nollställ filter', fn: resetFilters });
    });

    /* ---------- markeringar ---------- */
    const HINT0 = '';
    {
      const hb = $('#hintBox'), KEY = 'pb_kartotek_hint_min';
      const setMin = (m, save) => { hb.classList.toggle('min', m); hb.title = m ? '' : 'Klicka för att minimera'; if (save) { try { localStorage.setItem(KEY, m ? '1' : '0'); } catch {} } };
      try { if (localStorage.getItem(KEY) === '1') setMin(true, false); } catch {}
      hb.addEventListener('pointerdown', (e) => e.stopPropagation());
      hb.addEventListener('click', (e) => { e.stopPropagation(); setMin(!hb.classList.contains('min'), true); });
    }
    const HINT1 = 'Markeringsläge: markera text i en beskrivning eller i arbetstiderna. Markera redan markerad text igen, eller klicka på den, för att ta bort markeringen. Tryck Esc för att avsluta.';
    const HINT4 = 'Korten ligger i ordning efter när annonsen lades upp, de senast upplagda längst till vänster. Kort utan datum kommer sist i bokstavsordning. Byt till Egen placering för att flytta korten fritt.';
    const HINT2 = 'Korten ligger i ordning efter sista ansökningsdag, de som går ut först längst till vänster. Kort utan datum kommer sist i bokstavsordning. Byt till Egen placering för att flytta korten fritt.';
    const HINT3 = '';
    const ftext = (d, f) => f === 'hours' ? String(d.hours || '').trim() : String(d.description || '');
    function renderMarked(el, text, marks, f) {
      el.textContent = '';
      const list = (Array.isArray(marks) ? marks : []).filter((m) => m && m.f === f && isFinite(m.s) && isFinite(m.e) && m.s >= 0 && m.e > m.s && m.e <= text.length).sort((a, b) => a.s - b.s);
      let pos = 0;
      list.forEach((m) => {
        if (m.s < pos) return;
        if (m.s > pos) el.appendChild(document.createTextNode(text.slice(pos, m.s)));
        const mk = document.createElement('mark'); mk.textContent = text.slice(m.s, m.e); el.appendChild(mk);
        pos = m.e;
      });
      if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
    }
    function remapMarks(marks, texts) {
      const out = [];
      marks.forEach((m) => {
        const txt = m && texts[m.f];
        if (!m || typeof txt !== 'string' || !m.t) return;
        if (txt.slice(m.s, m.e) === m.t) { out.push(m); return; }
        const i = txt.indexOf(m.t);
        if (i >= 0) out.push({ f: m.f, s: i, e: i + m.t.length, t: m.t });
      });
      return out;
    }
    const rangesOf = (d, f) => (Array.isArray(d.marks) ? d.marks : []).filter((m) => m && m.f === f && isFinite(m.s) && isFinite(m.e) && m.e > m.s).map((m) => ({ s: m.s, e: m.e }));
    function unionRange(list, s, e) {
      const all = list.concat([{ s, e }]).sort((a, b) => a.s - b.s);
      const out = [];
      all.forEach((r) => { const last = out[out.length - 1]; if (last && r.s <= last.e) last.e = Math.max(last.e, r.e); else out.push({ s: r.s, e: r.e }); });
      return out;
    }
    function subtractRange(list, s, e) {
      const out = [];
      list.forEach((r) => {
        if (r.e <= s || r.s >= e) { out.push(r); return; }
        if (r.s < s) out.push({ s: r.s, e: s });
        if (r.e > e) out.push({ s: e, e: r.e });
      });
      return out;
    }
    function isCovered(info) {
      const d = cards.get(info.id);
      return !!d && rangesOf(d, info.f).some((r) => r.s <= info.s && r.e >= info.e);
    }
    function applyMark(info) {
      const d = cards.get(info.id);
      if (!d) return;
      const others = (Array.isArray(d.marks) ? d.marks : []).filter((m) => m && m.f !== info.f);
      const list = rangesOf(d, info.f);
      const next = isCovered(info) ? subtractRange(list, info.s, info.e) : unionRange(list, info.s, info.e);
      const out = others.concat(next.map((r) => ({ f: info.f, s: r.s, e: r.e, t: info.text.slice(r.s, r.e) })));
      d.marks = out;
      store.patch(info.id, { marks: out });
    }
    const fieldOf = (n) => { const el = n && (n.nodeType === 1 ? n : n.parentElement); return el && el.closest ? el.closest('.desc, .hval') : null; };
    function offsetIn(fieldEl, node, off) {
      const pre = document.createRange();
      pre.selectNodeContents(fieldEl); pre.setEnd(node, off);
      return pre.toString().length;
    }
    // Chrome kräver shadowRoot.getSelection() för markeringar inuti en shadow-rot, Firefox använder window.getSelection()
    const getSel = () => (typeof root.getSelection === 'function' ? root.getSelection() : window.getSelection());
    function selInfo() {
      if (!markMode) return null;
      const sel = getSel();
      if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
      const r = sel.getRangeAt(0);
      const fe = fieldOf(r.startContainer);
      if (!fe || fe !== fieldOf(r.endContainer)) return null;
      const card = fe.closest('.card');
      if (!card || card.hidden) return null;
      const text = fe.textContent;
      let s = offsetIn(fe, r.startContainer, r.startOffset);
      let e = s + r.toString().length;
      while (s < e && /\s/.test(text.charAt(s))) s++;
      while (e > s && /\s/.test(text.charAt(e - 1))) e--;
      if (e <= s) return null;
      return { id: card.dataset.id, f: fe.classList.contains('desc') ? 'description' : 'hours', s, e, text };
    }
    function clearSel() { const s = getSel(); if (s) s.removeAllRanges(); }
    function updateHint() { hintEl.textContent = markMode ? HINT1 : (sortMode === 'free' ? HINT0 : (sortMode === 'tag' ? HINT3 : (sortMode === 'published' ? HINT4 : HINT2))); }
    function setMarkMode(on) {
      markMode = !!on;
      appEl.classList.toggle('marking', markMode);
      markBtn.classList.toggle('active', markMode);
      markBtn.setAttribute('aria-pressed', markMode ? 'true' : 'false');
      updateHint();
      if (markMode) toast('Markeringsläge på. Markera text i beskrivning eller arbetstider.');
      else { clearSel(); markAct.hidden = true; }
    }
    markBtn.addEventListener('click', () => setMarkMode(!markMode));
    root.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') ptrDown = true; }, true);
    root.addEventListener('pointerup', (e) => {
      ptrDown = false;
      if (!markMode || e.pointerType === 'touch') return;
      const tgt = e.target;
      setTimeout(() => {
        const info = selInfo();
        if (info) { applyMark(info); clearSel(); return; }
        const sel = getSel();
        if (sel && sel.isCollapsed && tgt && tgt.closest) {
          const mk = tgt.closest('mark');
          const fe = mk && mk.closest('.desc, .hval');
          const card = fe && fe.closest('.card');
          if (fe && card) {
            const s = offsetIn(fe, mk, 0);
            applyMark({ id: card.dataset.id, f: fe.classList.contains('desc') ? 'description' : 'hours', s, e: s + mk.textContent.length, text: fe.textContent });
          }
        }
      }, 0);
    }, true);
    document.addEventListener('selectionchange', () => {
      if (!markMode || ptrDown) { markAct.hidden = true; return; }
      const info = selInfo();
      if (!info) { markAct.hidden = true; return; }
      markAct.textContent = isCovered(info) ? 'Ta bort markering' : 'Markera';
      markAct.hidden = false;
    });
    markAct.addEventListener('pointerdown', (e) => e.preventDefault());
    markAct.addEventListener('mousedown', (e) => e.preventDefault());
    markAct.addEventListener('click', () => { const info = selInfo(); if (info) { applyMark(info); clearSel(); } markAct.hidden = true; });

    /* ---------- ordning ---------- */
    const segBtns = Array.from(root.querySelectorAll('.segbtn'));
    let glideTimer = 0;
    function setSort(mode, quiet) {
      sortMode = mode === 'deadline' ? 'deadline' : (mode === 'published' ? 'published' : (mode === 'tag' ? 'tag' : 'free'));
      appEl.classList.toggle('sorted', sortMode !== 'free');
      segBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.sort === sortMode ? 'true' : 'false'));
      try { if (api) api.storage.local.set({ [SORT_KEY]: sortMode }); else localStorage.setItem(SORT_KEY, sortMode); } catch {}
      updateHint();
      if (!quiet && !reducedMotion()) {
        world.classList.add('glide'); clearTimeout(glideTimer);
        glideTimer = setTimeout(() => world.classList.remove('glide'), 1400);
      }
      if (refreshSizes) refreshSizes();
      schedulePos();
      positionAll();
      if (!quiet) fit(1200);
    }
    segBtns.forEach((b) => b.addEventListener('click', () => { if (b.dataset.sort !== sortMode) setSort(b.dataset.sort, false); }));

    /* ---------- redan sparade annonser i Platsbanken ---------- */
    const savedBtn = $('#savedBtn');
    let importing = false;
    const pendingSaved = () => {
      let list = [];
      try { list = hooks.getSaved ? hooks.getSaved() : []; } catch {}
      return list.filter((it) => it && it.id && !it.isDeleted && !it.isUnpublished && !hasAd(it.id));
    };
    function updateSavedBtn() {
      const n = importing ? 0 : pendingSaved().length;
      savedBtn.hidden = !n;
      savedBtn.textContent = 'Hämta sparade annonser (' + n + ')';
    }
    savedBtn.addEventListener('click', async () => {
      const items = pendingSaved();
      if (!items.length || importing) return;
      importing = true; savedBtn.hidden = true;
      let done = 0, partial = 0;
      for (const it of items) {
        toast('Hämtar annonser … ' + done + ' av ' + items.length, null, 60000);
        let data = await fetchAd(it.id);
        if (!data) { data = dataFromSaved(it); partial++; }
        if (it.isApplied) data.applied = todayISO();
        await addFromAd(data);
        done++;
        await new Promise((r) => setTimeout(r, 150));
      }
      importing = false;
      toast(done + ' annonser lades till' + (partial ? ' (' + partial + ' med bara titel och företag)' : '') + '.');
      updateSavedBtn();
      setTimeout(() => fit(true), 200);
    });

    /* ---------- storlek på kortens delar ---------- */
    {
      const ITEMS = [['w', 'Kortets bredd'], ['h', 'Kortets höjd'], ['title', 'Titel'], ['co', 'Företag'], ['tag', 'Taggar'], ['place', 'Ort'], ['hours', 'Arbetstider'], ['dl', 'Sista ansökningsdag'], ['pub', 'Upplagd (datum)'], ['text', 'Text'], ['rate', 'Betyg'], ['btn', 'Knappar'], ['mark', 'Markerad text'], ['tagtitle', 'Taggrubriker']];
      const sizes = {}, pop = $('#sizePop'), sbtn = $('#sizeBtn'), appEl = $('#app'), outs = {}, ins = {};
      let saveT = 0;
      // reglaget för bredd gäller alla kort lika: kort som dragits till egen bredd får också den gemensamma
      const sameWidth = () => cards.forEach((dd, id) => { if (dd.w !== undefined && dd.w !== null) patchLocal(id, { w: null }); });
      // Betyget kan förstoras till högst 380 %
      const rateMax = () => 380;
      const syncRate = () => { const r = ins.rate; if (!r) return; const m = rateMax(); if (Number(r.max) !== m) { r.max = String(m); r.value = String(sizes.rate || 100); } };
      const apply = () => {
        syncRate();
        // ordning efter sista ansökningsdag: datumet visas i 200 % (eget värde kommer tillbaka när man byter ordning)
        const forced = (k) => (k === 'dl' && sortMode === 'deadline') || (k === 'pub' && sortMode === 'published');
        ITEMS.forEach(([k]) => appEl.style.setProperty('--z-' + k, String((forced(k) ? 200 : (sizes[k] || 100)) / 100)));
        ['dl', 'pub'].forEach((k) => { if (!ins[k]) return; const on = forced(k), v = on ? 200 : (sizes[k] || 100); ins[k].value = String(v); outs[k].textContent = v + ' %'; ins[k].disabled = on; ins[k].title = on ? 'Vid den här ordningen visas datumet alltid i 200 %' : ''; });
        appEl.style.setProperty('--z-ap', layoutMode() === 'applied' ? '3' : '1');   // ansökningsdatumet visas i 300 % när man filtrerar på ansökta
        tFactor = (sizes.tagtitle || 100) / 100; wFactor = (sizes.w || 100) / 100; hFactor = (sizes.h || 100) / 100;
        els.forEach((e, id) => { const dd = cards.get(id); if (dd && !resizeSet.has(id)) e.style.width = cardWidth(dd) + 'px'; });
        schedulePos();
      };
      const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { if (api) api.storage.local.set({ [SIZE_KEY]: sizes }); else localStorage.setItem(SIZE_KEY, JSON.stringify(sizes)); } catch {} }, 300); };
      const h3 = document.createElement('h3'); h3.textContent = 'Storlek på korten'; pop.appendChild(h3);
      ITEMS.forEach(([k, lab]) => {
        const row = document.createElement('label'); row.className = 'szrow';
        const t = document.createElement('span'); t.textContent = lab;
        const r = document.createElement('input'); r.type = 'range'; r.min = '60'; r.max = '200'; r.step = '5'; r.value = '100';
        const o = document.createElement('output'); o.textContent = '100 %';
        const upd = () => { if ((k === 'dl' && sortMode === 'deadline') || (k === 'pub' && sortMode === 'published')) { r.value = '200'; return; } sizes[k] = Number(r.value); o.textContent = r.value + ' %'; if (k === 'w') sameWidth(); apply(); save(); };
        r.addEventListener('input', upd);
        const stepBtn = (txt, dlt, ttl) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'szb'; b.textContent = txt; b.title = ttl; b.setAttribute('aria-label', ttl + ' – ' + lab);
          b.addEventListener('click', (ev) => { ev.preventDefault(); r.value = String(clamp(Number(r.value) + dlt, 60, Number(r.max))); upd(); }); return b; };
        outs[k] = o; ins[k] = r; row.append(t, stepBtn('−', -5, 'Mindre'), r, stepBtn('+', 5, 'Större'), o); pop.appendChild(row);
      });
      const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'btn plain'; reset.textContent = 'Återställ alla';
      reset.addEventListener('click', () => { ITEMS.forEach(([k]) => { delete sizes[k]; ins[k].value = '100'; outs[k].textContent = '100 %'; }); sameWidth(); apply(); save(); });
      pop.appendChild(reset);
      const show = (on) => { if (on) syncRate(); pop.hidden = !on; sbtn.setAttribute('aria-expanded', on ? 'true' : 'false'); };
      sbtn.addEventListener('click', () => show(pop.hidden));
      root.addEventListener('pointerdown', (ev) => { if (!pop.hidden && !pop.contains(ev.target) && !sbtn.contains(ev.target)) show(false); }, true);
      refreshSizes = apply;
      (async () => {
        try {
          const sv = api ? (await api.storage.local.get(SIZE_KEY))[SIZE_KEY] : JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
          if (sv && typeof sv === 'object') ITEMS.forEach(([k]) => { const v = Number(sv[k]); if (isFinite(v) && v >= 60 && v <= (k === 'rate' ? 380 : 200) && v !== 100) { sizes[k] = v; ins[k].value = String(v); outs[k].textContent = v + ' %'; } });
        } catch {}
        apply();
      })();
    }
    /* ---------- färg på taggarna ---------- */
    {
      const pop = $('#colPop'), cbtn = $('#colBtn');
      const show = (on) => { pop.hidden = !on; cbtn.setAttribute('aria-expanded', on ? 'true' : 'false'); if (on) build(); };
      const recolor = (k) => {
        const hv = String(tagHue(k === '' ? '' : (names0.get(k) || k)));
        root.querySelectorAll('.tagchip[data-tag]').forEach((c) => { if (tk(c.dataset.tag) === k) c.style.setProperty('--h', hv); });
        const bx = boxEls.get(k); if (bx) bx.style.setProperty('--h', hv);
      };
      const names0 = new Map();
      let markColor = '';
      const appEl2 = $('#app');
      const applyMark = () => { if (markColor) appEl2.style.setProperty('--mk', markColor); else appEl2.style.removeProperty('--mk'); };
      const saveMark = () => { try { if (api) api.storage.local.set({ [MARK_KEY]: markColor }); else localStorage.setItem(MARK_KEY, JSON.stringify(markColor)); } catch {} };
      (async () => { try { const v = api ? (await api.storage.local.get(MARK_KEY))[MARK_KEY] : JSON.parse(localStorage.getItem(MARK_KEY) || 'null'); if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) { markColor = v; applyMark(); } } catch {} })();
      function build() {
        pop.textContent = ''; names0.clear();
        cards.forEach((d) => tagsOf(d).forEach((x) => { if (!names0.has(tk(x))) names0.set(tk(x), x); }));
        const mh = document.createElement('h3'); mh.textContent = 'Markering'; pop.appendChild(mh);
        {
          const row = document.createElement('div'); row.className = 'colrow';
          const lab = document.createElement('span'); lab.textContent = 'Markeringsfärg';
          const ci = document.createElement('input'); ci.type = 'color'; ci.value = markColor || '#ffe066'; ci.setAttribute('aria-label', 'Färg på markerad text');
          ci.addEventListener('input', () => { markColor = ci.value; applyMark(); saveMark(); });
          const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'szb'; rb.textContent = '↺'; rb.title = 'Tillbaka till standardfärgen';
          rb.addEventListener('click', () => { markColor = ''; ci.value = '#ffe066'; applyMark(); saveMark(); });
          row.append(lab, ci, rb); pop.appendChild(row);
        }
        const h3 = document.createElement('h3'); h3.textContent = 'Färg på taggarna'; h3.style.marginTop = '8px'; pop.appendChild(h3);
        if (!names0.size) { const p = document.createElement('p'); p.className = 'expnote'; p.textContent = 'Det finns inga taggar än.'; pop.appendChild(p); return; }
        Array.from(names0.entries()).sort((a, b) => a[1].localeCompare(b[1], 'sv', { sensitivity: 'base' })).forEach(([k, name]) => {
          const row = document.createElement('div'); row.className = 'colrow';
          const chip = document.createElement('span'); chip.className = 'tagchip'; chip.dataset.tag = name; chip.textContent = name; chip.style.setProperty('--h', tagHue(name));
          const r = document.createElement('input'); r.type = 'range'; r.className = 'hue'; r.min = '0'; r.max = '359'; r.step = '1'; r.value = String(tagHue(name)); r.setAttribute('aria-label', 'Färg för taggen ' + name);
          r.addEventListener('input', () => { tagHues.set(k, Number(r.value)); saveHues(); chip.style.setProperty('--h', r.value); recolor(k); });
          const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'szb'; rb.textContent = '↺'; rb.title = 'Välj en färg automatiskt igen';
          rb.addEventListener('click', () => { tagHues.delete(k); const v = tagHue(name); r.value = String(v); chip.style.setProperty('--h', v); recolor(k); });
          row.append(chip, r, rb); pop.appendChild(row);
        });
      }
      cbtn.addEventListener('click', () => show(pop.hidden));
      root.addEventListener('pointerdown', (ev) => { if (!pop.hidden && !pop.contains(ev.target) && !cbtn.contains(ev.target)) show(false); }, true);
    }
    /* ---------- export / import ---------- */
    /* ---------- start ---------- */
    function initView() {
      if (viewReady || !loaded || !canvas.getBoundingClientRect().width) return;
      viewReady = true;
      (async () => {
        let saved = null;
        try {
          if (api) saved = (await api.storage.local.get(VIEW_KEY))[VIEW_KEY];
          else saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
        } catch {}
        if (saved && isFinite(saved.tx) && isFinite(saved.ty) && isFinite(saved.z) && cards.size) {
          view = { tx: saved.tx, ty: saved.ty, z: clamp(saved.z, MINZ, MAXZ) };
          applyView();
        } else fit();
      })();
    }
    applyView(); applyFilters(); updateEmpty();
    (async () => {
      let sv = null;
      try { sv = api ? (await api.storage.local.get(SORT_KEY))[SORT_KEY] : localStorage.getItem(SORT_KEY); } catch {}
      try {
        const hu = api ? (await api.storage.local.get(HUE_KEY))[HUE_KEY] : JSON.parse(localStorage.getItem(HUE_KEY) || 'null');
        if (hu && typeof hu === 'object') {
          let diff = false;
          Object.keys(hu).forEach((k) => { const v = Number(hu[k]); if (isFinite(v) && tagHues.get(k) !== v) { tagHues.set(k, v); diff = true; } });
          hueReady = true;
          if (diff && cards.size) { sync(); schedulePos(); root.querySelectorAll('.tagchip[data-tag]').forEach((c) => c.style.setProperty('--h', tagHue(c.dataset.tag))); }
        } else hueReady = true;
      } catch { hueReady = true; }
      try {
        const sh = api ? (await api.storage.local.get(SHAPE_KEY))[SHAPE_KEY] : JSON.parse(localStorage.getItem(SHAPE_KEY) || 'null');
        if (sh && typeof sh === 'object') Object.keys(sh).forEach((k) => { const v = Math.round(Number(sh[k])); if (v >= 1 && v <= 8) shapeOv.set(k, v); });
      } catch {}
      try {
        const bo = api ? (await api.storage.local.get(BOX_KEY))[BOX_KEY] : JSON.parse(localStorage.getItem(BOX_KEY) || 'null');
        if (bo && typeof bo === 'object' && bo.sig && bo.o && bo.v === PLAN_V) { boxSig = bo.sig; if (bo.plan && Array.isArray(bo.plan.pos) && Array.isArray(bo.plan.sh)) { topoCache.sig = bo.sig; topoCache.plan = bo.plan; } Object.keys(bo.o).forEach((k) => { const v = bo.o[k]; if (v && isFinite(v.dx) && isFinite(v.dy)) { boxOff.set(k, { dx: v.dx, dy: v.dy, seq: Number(v.seq) || 0 }); boxSeq = Math.max(boxSeq, Number(v.seq) || 0); } }); }
      } catch {}
      setSort(sv, true);
    })();
    store.subscribe((m) => {
      cards = m; sync();
      if (!loaded) { loaded = true; updateEmpty(); }
      initView();
    });
    ready.then(() => { if (!loaded) { loaded = true; sync(); initView(); } });

    $('#selClear').addEventListener('click', clearSelection);
    $('#selAll').addEventListener('click', selectAllVisible);
    $('#selAdd').addEventListener('click', () => {
      const add = normTags(selTag.value);
      if (!add.length) { selTag.focus(); return; }
      changeTags(Array.from(selected), (old) => { add.forEach((a) => { if (!old.some((o) => tk(o) === tk(a))) old.push(a); }); return old; },
        (n) => n + (n === 1 ? ' kort fick taggen ' : ' kort fick taggen ') + add.join(', ') + '.');
      selTag.value = '';
    });
    $('#selRem').addEventListener('click', () => {
      const rm = normTags(selTag.value).map(tk);
      if (!rm.length) { toast('Skriv eller välj taggen som ska tas bort.'); selTag.focus(); return; }
      changeTags(Array.from(selected), (old) => old.filter((o) => rm.indexOf(tk(o)) < 0), (n) => 'Taggen togs bort från ' + n + (n === 1 ? ' kort.' : ' kort.'));
      selTag.value = '';
    });
    selBar.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); if (e.key === 'Enter' && e.target === selTag) { e.preventDefault(); $('#selAdd').click(); } });
    root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && !(e.target.closest && e.target.closest('input, textarea, select'))) { e.preventDefault(); selectAllVisible(); }
    });

    return {
      onShow() { initView(); schedulePos(); updateSavedBtn(); },
      // Esc: stänger det översta lagret i kartoteket. Returnerar true om något stängdes.
      escape() {
        if (!expOverlay.hidden) { closeExp(); return true; }
        if (!overlay.hidden) { closeEditor(); return true; }
        if (linkSource) { stopLink(); return true; }
        if (selected.size) { clearSelection(); return true; }
        if (markMode) { setMarkMode(false); return true; }
        return false;
      },
      focusSearch() { fSearch.focus(); fSearch.select(); },
      toast
    };
  }

  // Kort som sparats utan annonstext får texten när den finns (t.ex. hämtade jobb vars text hämtats senare).
  // Bara tomma beskrivningar fylls i, så användarens egna ändringar skrivs aldrig över.
  const fillDescriptions = (byAd) => serial(async () => {
    await refreshFromStore();
    let n = 0;
    for (const c of S.map.values()) {
      const d = c.adId && byAd(String(c.adId));
      if (d && !String(c.description || '').trim() && String(d).trim()) { store.patch(c.id, { description: String(d) }); n++; }
    }
    return n;
  });

  window.PBKartotek = {
    ready, mount, fetchAd, addFromAd, removeByAd, restoreCard, setApplied, dataFromSaved, todayISO, hasAd, cardDataFromApi, allTags, setTagsByAd, fillDescriptions,
    subscribe: (cb) => store.subscribe(cb)
  };
})();
