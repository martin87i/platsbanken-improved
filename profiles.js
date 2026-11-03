/*
 * Profiler: flera personer (eller användningssätt) kan dela samma webbläsare utan att dela filterord,
 * dolda annonser, kartotek och sparade annonser.
 *
 * Så fungerar det: den aktiva profilens data ligger på de vanliga nycklarna i tilläggets lagring (och i
 * Platsbankens egen localStorage för sparade/ansökta annonser), så resten av tillägget är oförändrat.
 * Övriga profilers data ligger undanstoppad under "pbp:<id>". Vid profilbyte sparas den aktiva profilens
 * data undan, den nya profilens data läggs in, och sidan laddas om.
 */
(function () {
  'use strict';
  if (window.PBProfiles) return;
  const api = (typeof browser !== 'undefined' && browser.storage) ? browser
            : (typeof chrome !== 'undefined' && chrome.storage) ? chrome : null;
  const PKEY = 'pb_profiles';
  const DATA_KEYS = ['pb_hiddenJobs', 'pb_shownJobs', 'pb_blockedTokens', 'pb_tokensExpanded', 'pb_tokenSort',
                     'pb_kartotek', 'pb_kartotek_view', 'pb_kartotek_sort', 'pb_kartotek_boxoff', 'pb_kartotek_tagcolors', 'pb_kartotek_sizes', 'pb_kartotek_markcolor', 'pb_kartotek_shapes'];
  const LS_KEYS = ['platsbanken.savedAds', 'platsbanken.appliedJobs'];
  const MEANINGFUL = ['pb_hiddenJobs', 'pb_shownJobs', 'pb_blockedTokens', 'pb_kartotek', 'ls:platsbanken.savedAds', 'ls:platsbanken.appliedJobs'];
  const isTop = window.top === window;
  const state = { active: null, list: [] };
  let reloading = false;

  const get = async (keys) => { try { return (await api.storage.local.get(keys)) || {}; } catch { return {}; } };
  const set = (o) => api.storage.local.set(o);
  const del = async (k) => { try { await api.storage.local.remove(k); } catch {} };

  const ready = (async () => {
    if (!api) return;
    const v = (await get(PKEY))[PKEY];
    if (v && Array.isArray(v.list)) { state.active = v.active || null; state.list = v.list; }
  })();

  const HUES = [210, 140, 20, 330, 270, 50, 180, 0];
  const mk = (name) => {
    const used = new Set(state.list.map((p) => p.hue));
    const hue = HUES.find((h) => !used.has(h));
    return { id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), name, hue: hue === undefined ? Math.floor(Math.random() * 360) : hue };
  };
  const byId = (id) => state.list.find((p) => p.id === id) || null;
  const active = () => byId(state.active);

  async function snapshotCurrent() {
    const d = await get(DATA_KEYS), snap = {};
    DATA_KEYS.forEach((k) => { if (d[k] !== undefined) snap[k] = d[k]; });
    LS_KEYS.forEach((k) => { try { const v = localStorage.getItem(k); if (v !== null) snap['ls:' + k] = v; } catch {} });
    return snap;
  }
  function hasData(snap) {
    return MEANINGFUL.some((k) => {
      let v = snap[k];
      if (v === undefined || v === null) return false;
      if (k.indexOf('ls:') === 0) { try { v = JSON.parse(v); } catch { return false; } }
      return Array.isArray(v) ? v.length > 0 : !!v;
    });
  }
  async function applySnapshot(snap) {
    const rm = [], put = {};
    DATA_KEYS.forEach((k) => { if (snap[k] !== undefined) put[k] = snap[k]; else rm.push(k); });
    if (rm.length) await del(rm);
    if (Object.keys(put).length) await set(put);
    LS_KEYS.forEach((k) => {
      try { const v = snap['ls:' + k]; if (v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {}
    });
  }
  async function commit(next) {
    reloading = true;
    await set({ [PKEY]: next });      // skrivs sist: andra flikar laddar om när den ändras
    state.active = next.active; state.list = next.list;
    if (isTop) location.reload();
  }

  /* ---------- operationer ---------- */
  async function switchTo(id) {
    await ready;
    if (!byId(id) || id === state.active) return;
    const cur = await snapshotCurrent();
    if (state.active) await set({ ['pbp:' + state.active]: cur });
    const nxt = (await get('pbp:' + id))['pbp:' + id] || {};
    await applySnapshot(nxt);
    await commit({ active: id, list: state.list });
  }
  async function rename(id, name) {
    const p = byId(id); if (!p) return;
    const list = state.list.map((q) => q.id === id ? Object.assign({}, q, { name }) : q);
    await set({ [PKEY]: { active: state.active, list } });
    state.list = list; renderAll();
  }
  async function removeProfile(id) {
    if (id === state.active || !byId(id)) return;
    await del('pbp:' + id);
    const list = state.list.filter((q) => q.id !== id);
    await set({ [PKEY]: { active: state.active, list } });
    state.list = list; renderAll();
  }
  async function createProfile(name, where) {
    await ready;
    const cur = await snapshotCurrent();
    const newP = mk(name), list = state.list.slice();
    list.push(newP);
    if (!state.list.length) {
      // första profilen: den data som redan finns tillhör ännu ingen
      if (hasData(cur)) {
        if (where && where.target === 'this') { /* datan ligger kvar och blir den nya profilens */ }
        else {
          let owner = where && where.target === 'existing' ? byId(where.id) : null;
          if (!owner) { state.list = list; owner = mk(where.name); list.push(owner); }
          await set({ ['pbp:' + owner.id]: cur });
          await applySnapshot({});
        }
      }
    } else {
      // den aktiva profilen äger datan; den nya börjar tom
      await set({ ['pbp:' + state.active]: cur });
      await applySnapshot({});
    }
    await commit({ active: newP.id, list });
  }

  /* ---------- gränssnitt ---------- */
  const css = document.createElement('style');
  css.textContent = `
    .pbp-chip{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;font:600 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b2330;background:#fff;border:1px solid #c5ccd6;border-radius:15px;cursor:pointer;white-space:nowrap;max-width:150px}
    .pbp-chip>.pbp-name{overflow:hidden;text-overflow:ellipsis}
    .pbp-chip:hover{border-color:#6b7788}
    .pbp-dot{width:12px;height:12px;border-radius:50%;flex:none}
    .pbp-menu{position:fixed;z-index:2147483600;min-width:230px;padding:6px;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b2330;background:#fff;border:1px solid #c5ccd6;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25)}
    .pbp-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;text-align:left;font:inherit;color:inherit;background:none;border:0;border-radius:6px;cursor:pointer}
    .pbp-item:hover{background:#eef2f7}
    .pbp-sep{height:1px;margin:5px 0;background:#e2e7ee}
    .pbp-mod{position:fixed;inset:0;z-index:2147483640;display:grid;place-items:center;padding:16px;background:rgba(10,14,20,.5);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b2330}
    .pbp-box{display:flex;flex-direction:column;gap:12px;width:min(440px,100%);padding:20px;background:#fff;border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.35)}
    .pbp-box h2{margin:0;font:700 18px/1.2 system-ui,sans-serif}
    .pbp-box p{margin:0}
    .pbp-box input[type=text]{width:100%;box-sizing:border-box;padding:8px 10px;font:inherit;border:1px solid #c5ccd6;border-radius:6px}
    .pbp-opt{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid #d6dce5;border-radius:8px;cursor:pointer}
    .pbp-opt input[type=radio]{margin-top:3px}
    .pbp-opt:has(input:checked){border-color:#2b59c9;background:#eef3ff}
    .pbp-acts{display:flex;gap:8px;justify-content:flex-end}
    .pbp-btn{height:34px;padding:0 14px;font:600 14px/1 system-ui,sans-serif;color:#1b2330;background:#fff;border:1px solid #c5ccd6;border-radius:6px;cursor:pointer}
    .pbp-btn.pri{color:#fff;background:#2b59c9;border-color:#2b59c9}
    .pbp-err{color:#b4374b;font-size:13px;min-height:1em}
    html.pbp-on #pb-tools::before{content:'';position:absolute;left:0;right:0;top:0;height:9px;background:var(--pbp-color);border-radius:10px 10px 0 0;pointer-events:none}
    #pbp-line{position:fixed;left:0;right:0;top:0;height:4px;z-index:2147483500;pointer-events:none}`;
  const root = () => document.documentElement;
  if (isTop) (document.head || root()).appendChild(css);

  function modal(title, build, buttons) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div'); wrap.className = 'pbp-mod';
      const box = document.createElement('div'); box.className = 'pbp-box';
      const h = document.createElement('h2'); h.textContent = title; box.appendChild(h);
      const get = build(box);
      const err = document.createElement('div'); err.className = 'pbp-err'; box.appendChild(err);
      const acts = document.createElement('div'); acts.className = 'pbp-acts';
      const close = (v) => { wrap.remove(); resolve(v); };
      buttons.forEach((b) => {
        const el = document.createElement('button'); el.type = 'button'; el.className = 'pbp-btn' + (b.primary ? ' pri' : ''); el.textContent = b.label;
        el.addEventListener('click', () => {
          if (!b.primary) return close(null);
          const v = get(); const m = b.check ? b.check(v) : '';
          if (m) { err.textContent = m; return; }
          close(v);
        });
        acts.appendChild(el);
      });
      box.appendChild(acts); wrap.appendChild(box);
      wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') acts.querySelector('.pri') && acts.querySelector('.pri').click(); e.stopPropagation(); });
      root().appendChild(wrap);
      const first = box.querySelector('input[data-af]'); if (first) first.focus();
    });
  }
  const nameErr = (name, exceptId) => {
    const n = (name || '').trim();
    if (!n) return 'Skriv ett namn.';
    if (state.list.some((p) => p.id !== exceptId && p.name.toLowerCase() === n.toLowerCase())) return 'Det finns redan en profil med det namnet.';
    return '';
  };
  const textField = (box, label, value) => {
    const l = document.createElement('label'); l.textContent = label; l.style.fontWeight = '600';
    const i = document.createElement('input'); i.type = 'text'; i.dataset.af = '1'; i.maxLength = 30; i.value = value || ''; i.style.marginTop = '4px';
    l.appendChild(document.createElement('br')); l.appendChild(i); box.appendChild(l); return i;
  };

  async function newProfileFlow() {
    await ready;
    const r = await modal('Ny profil', (box) => { const i = textField(box, 'Profilens namn', ''); return () => ({ name: i.value.trim() }); },
      [{ label: 'Avbryt' }, { label: 'Skapa', primary: true, check: (v) => nameErr(v.name) }]);
    if (!r) return;
    let where = null;
    if (!state.list.length && hasData(await snapshotCurrent())) {
      where = await modal('Var ska den sparade informationen ligga?', (box) => {
        const p = document.createElement('p'); p.textContent = 'Det finns redan sparade filterord, dolda annonser, kartotek och/eller sparade annonser. Vilken profil ska äga dem?'; box.appendChild(p);
        const opts = [];
        const add = (value, text, extra) => {
          const l = document.createElement('label'); l.className = 'pbp-opt';
          const rd = document.createElement('input'); rd.type = 'radio'; rd.name = 'pbp-where'; rd.value = value; if (!opts.length) rd.checked = true;
          const d = document.createElement('div'); d.textContent = text; if (extra) d.appendChild(extra);
          l.appendChild(rd); l.appendChild(d); box.appendChild(l); opts.push(rd);
        };
        add('this', 'På «' + r.name + '» (den nya profilen)');
        const ni = document.createElement('input'); ni.type = 'text'; ni.maxLength = 30; ni.placeholder = 'Namn på den andra profilen'; ni.style.marginTop = '6px';
        add('new', 'På en annan profil, som jag skapar nu:', ni);
        ni.addEventListener('focus', () => { opts[1].checked = true; });
        return () => ({ target: opts.find((o) => o.checked).value, name: ni.value.trim() });
      }, [{ label: 'Avbryt' }, { label: 'Fortsätt', primary: true, check: (v) => v.target === 'new' ? (nameErr(v.name) || (v.name.toLowerCase() === r.name.toLowerCase() ? 'Profilerna måste heta olika.' : '')) : '' }]);
      if (!where) return;
    }
    await createProfile(r.name, where);
  }
  async function renameFlow() {
    const p = active(); if (!p) return;
    const r = await modal('Byt namn på profilen', (box) => { const i = textField(box, 'Nytt namn', p.name); return () => ({ name: i.value.trim() }); },
      [{ label: 'Avbryt' }, { label: 'Spara', primary: true, check: (v) => nameErr(v.name, p.id) }]);
    if (r) await rename(p.id, r.name);
  }
  async function deleteFlow() {
    const others = state.list.filter((p) => p.id !== state.active);
    if (!others.length) { await modal('Ta bort profil', (box) => { const p = document.createElement('p'); p.textContent = 'Det finns ingen annan profil att ta bort. Den aktiva profilen kan inte tas bort; byt först till en annan profil.'; box.appendChild(p); return () => ({}); }, [{ label: 'OK', primary: true }]); return; }
    const r = await modal('Ta bort profil', (box) => {
      const p = document.createElement('p'); p.textContent = 'Välj vilken profil som ska tas bort. All dess data raderas och går inte att ångra.'; box.appendChild(p);
      const opts = [];
      others.forEach((o, n) => {
        const l = document.createElement('label'); l.className = 'pbp-opt';
        const rd = document.createElement('input'); rd.type = 'radio'; rd.name = 'pbp-del'; rd.value = o.id; if (!n) rd.checked = true;
        const d = document.createElement('div'); d.textContent = o.name; l.appendChild(rd); l.appendChild(d); box.appendChild(l); opts.push(rd);
      });
      return () => ({ id: opts.find((o) => o.checked).value });
    }, [{ label: 'Avbryt' }, { label: 'Ta bort', primary: true }]);
    if (r) await removeProfile(r.id);
  }

  /* ---------- flytta/kopiera data mellan profiler ---------- */
  const parseJ = (v) => { try { return JSON.parse(v); } catch { return null; } };
  const uni = (x, y, key) => {
    const seen = new Set(), r = [];
    [].concat(Array.isArray(x) ? x : [], Array.isArray(y) ? y : []).forEach((it) => { const k = it == null ? null : key(it); if (k == null || seen.has(k)) return; seen.add(k); r.push(it); });
    return r;
  };
  // Slår ihop käll- och måldata; vid dubbletter vinner målets version
  function mergeSnap(a, b) {
    const out = Object.assign({}, b, a);
    ['pb_hiddenJobs', 'pb_shownJobs'].forEach((k) => { if (a[k] !== undefined || b[k] !== undefined) out[k] = uni(a[k], b[k], String); });
    if (a.pb_blockedTokens !== undefined || b.pb_blockedTokens !== undefined) out.pb_blockedTokens = uni(a.pb_blockedTokens, b.pb_blockedTokens, (x) => x.word);
    if (a.pb_kartotek !== undefined || b.pb_kartotek !== undefined) out.pb_kartotek = uni(a.pb_kartotek, b.pb_kartotek, (x) => x.adId ? 'a' + x.adId : 'i' + x.id);
    [['ls:platsbanken.savedAds', (x) => x && x.id], ['ls:platsbanken.appliedJobs', String]].forEach(([k, f]) => {
      if (a[k] !== undefined || b[k] !== undefined) out[k] = JSON.stringify(uni(parseJ(a[k]), parseJ(b[k]), f));
    });
    return out;
  }
  const snapOf = async (id) => id === state.active ? await snapshotCurrent() : ((await get('pbp:' + id))['pbp:' + id] || {});
  async function transfer(fromId, toId, move) {
    const src = await snapOf(fromId), dst = await snapOf(toId);
    const merged = mergeSnap(dst, src);
    const touchesActive = fromId === state.active || toId === state.active;
    if (toId === state.active) await applySnapshot(merged); else await set({ ['pbp:' + toId]: merged });
    if (move) { if (fromId === state.active) await applySnapshot({}); else await del('pbp:' + fromId); }
    if (touchesActive && isTop) { reloading = true; location.reload(); }
  }
  async function transferFlow() {
    await ready;
    if (state.list.length < 2) return;
    const r = await modal('Flytta data mellan profiler', (box) => {
      const p = document.createElement('p'); p.textContent = 'Filterord, dolda och visade annonser, kartotek och sparade annonser flyttas eller kopieras från en profil till en annan. Finns redan data hos målet slås den ihop, och målets version behålls vid dubbletter.'; box.appendChild(p);
      const mkSel = (label, sel) => {
        const l = document.createElement('label'); l.style.fontWeight = '600'; l.textContent = label;
        const s = document.createElement('select'); s.style.cssText = 'display:block;width:100%;margin-top:4px;padding:7px;font:inherit;border:1px solid #c5ccd6;border-radius:6px';
        state.list.forEach((q) => { const o = document.createElement('option'); o.value = q.id; o.textContent = q.name + (q.id === state.active ? ' (aktiv)' : ''); s.appendChild(o); });
        s.value = sel; l.appendChild(s); box.appendChild(l); return s;
      };
      const other = state.list.find((q) => q.id !== state.active);
      const from = mkSel('Från profil', other.id), to = mkSel('Till profil', state.active);
      const rd = [];
      [['move', 'Flytta (källprofilen töms)'], ['copy', 'Kopiera (källprofilen behåller sin data)']].forEach(([v, text], n) => {
        const l = document.createElement('label'); l.className = 'pbp-opt';
        const i = document.createElement('input'); i.type = 'radio'; i.name = 'pbp-tr'; i.value = v; if (!n) i.checked = true;
        const d = document.createElement('div'); d.textContent = text; l.appendChild(i); l.appendChild(d); box.appendChild(l); rd.push(i);
      });
      return () => ({ from: from.value, to: to.value, move: rd.find((x) => x.checked).value === 'move' });
    }, [{ label: 'Avbryt' }, { label: 'Fortsätt', primary: true, check: (v) => v.from === v.to ? 'Välj två olika profiler.' : '' }]);
    if (r) await transfer(r.from, r.to, r.move);
  }

  const dotColor = (p) => 'hsl(' + p.hue + ' 70% 48%)';
  const mounts = new Set();
  function openMenu(chip) {
    document.querySelectorAll('.pbp-menu').forEach((m) => m.remove());
    const m = document.createElement('div'); m.className = 'pbp-menu';
    const item = (text, fn, dot) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pbp-item';
      if (dot) { const d = document.createElement('span'); d.className = 'pbp-dot'; d.style.background = dot; b.appendChild(d); }
      b.appendChild(document.createTextNode(text));
      b.addEventListener('click', () => { m.remove(); fn(); }); m.appendChild(b);
    };
    state.list.forEach((p) => item((p.id === state.active ? '✓ ' : '') + p.name, () => switchTo(p.id), dotColor(p)));
    if (state.list.length) { const s = document.createElement('div'); s.className = 'pbp-sep'; m.appendChild(s); }
    item('Ny profil …', newProfileFlow);
    if (active()) item('Byt namn på aktiv profil …', renameFlow);
    if (state.list.length > 1) item('Flytta data mellan profiler …', transferFlow);
    if (state.list.length > 1) item('Ta bort profil …', deleteFlow);
    { const s2 = document.createElement('div'); s2.className = 'pbp-sep'; m.appendChild(s2); }
    item('Exportera all data …', exportFlow);
    item('Importera från fil …', importFlow);
    root().appendChild(m);
    const r = chip.getBoundingClientRect();
    m.style.top = Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 6) + 'px';
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left)) + 'px';
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  }
  // Exporterar all data i den aktiva profilen: kort, filterord, dolda och sparade annonser och inställningar
  async function exportFlow() {
    await ready;
    const snap = await snapshotCurrent();
    const cards = Array.isArray(snap.pb_kartotek) ? snap.pb_kartotek : [];
    const data = Object.assign({}, snap); delete data.pb_kartotek;
    if (!cards.length && !hasData(snap) && !Object.keys(data).length) {
      await modal('Exportera', (box) => { const p = document.createElement('p'); p.textContent = 'Det finns ingen data att exportera.'; box.appendChild(p); return () => ({}); }, [{ label: 'Ok', primary: true }]);
      return;
    }
    const out = { app: 'platsbanken-improved-kartotek', version: 2, exportedAt: new Date().toISOString(), profile: active() ? active().name : null, cards, data };
    const d = new Date(), z = (n) => (n < 10 ? '0' : '') + n;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    const pn = active() ? String(active().name).trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, '').replace(/\s+/g, '-').slice(0, 40) : '';
    a.download = 'platsbanken-improved-' + (pn ? pn + '-' : '') + d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '.json';
    root().appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    await modal('Exportera', (box) => { const p = document.createElement('p'); p.textContent = 'All data exporterades (' + cards.length + ' kort med filterord, dolda och sparade annonser och inställningar).'; box.appendChild(p); return () => ({}); }, [{ label: 'Ok', primary: true }]);
  }
  // Läser in en exporterad fil och lägger till innehållet i den aktiva profilen. Vid dubbletter vinner det som redan finns.
  function importFlow() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json'; inp.style.display = 'none';
    root().appendChild(inp);
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; inp.remove();
      if (!f) return;
      const msg = (text) => modal('Importera', (box) => { const p = document.createElement('p'); p.textContent = text; box.appendChild(p); return () => ({}); }, [{ label: 'Ok', primary: true }]);
      let j;
      try { j = JSON.parse(await f.text()); } catch { await msg('Filen kunde inte läsas.'); return; }
      const list = Array.isArray(j) ? j : (j && Array.isArray(j.cards) ? j.cards : []);
      const imp = Object.assign({}, (j && !Array.isArray(j) && j.data && typeof j.data === 'object') ? j.data : {}, { pb_kartotek: list });
      if (!list.length && Object.keys(imp).length <= 1) { await msg('Hittade ingen data i filen.'); return; }
      const cur = await snapshotCurrent();
      const before = Array.isArray(cur.pb_kartotek) ? cur.pb_kartotek.length : 0;
      const merged = mergeSnap(cur, imp);
      await applySnapshot(merged);
      const added = (Array.isArray(merged.pb_kartotek) ? merged.pb_kartotek.length : 0) - before;
      await msg('Filen lästes in (' + added + ' nya kort). Sidan laddas om.');
      reloading = true; if (isTop) location.reload();
    });
    inp.click();
  }
  function renderChip(slot) {
    slot.textContent = '';
    const p = active();
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pbp-chip';
    b.title = p ? 'Aktiv profil: ' + p.name + '. Klicka för att byta eller skapa profil.' : 'Ingen profil är skapad. Klicka för att skapa en.';
    const d = document.createElement('span'); d.className = 'pbp-dot'; d.style.background = p ? dotColor(p) : '#9aa5b4'; b.appendChild(d);
    const nm = document.createElement('span'); nm.className = 'pbp-name'; nm.textContent = p ? p.name : 'Profil'; b.appendChild(nm);
    b.appendChild(document.createTextNode(' ▾'));
    b.addEventListener('click', (e) => { e.stopPropagation(); openMenu(b); });
    slot.appendChild(b);
  }
  function renderLine() {
    let l = document.getElementById('pbp-line');
    const p = active();
    root().classList.toggle('pbp-on', !!p);
    if (p) root().style.setProperty('--pbp-color', dotColor(p)); else root().style.removeProperty('--pbp-color');
    if (!p) { if (l) l.remove(); return; }
    if (!l) { l = document.createElement('div'); l.id = 'pbp-line'; root().appendChild(l); }
    l.style.background = dotColor(p); l.title = 'Profil: ' + p.name;
  }
  function renderAll() { mounts.forEach((s) => { if (s.isConnected) renderChip(s); else mounts.delete(s); }); renderLine(); }
  function mount(slot) { if (!api || !slot || mounts.has(slot)) return; mounts.add(slot); ready.then(() => renderChip(slot)); }
  if (isTop && api) {
    ready.then(() => {
      renderLine();
      setInterval(() => { document.querySelectorAll('.pbp-slot').forEach(mount); if (!document.getElementById('pbp-line') && active()) renderLine(); }, 600);
    });
    try {
      api.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local' || !ch[PKEY]) return;
        const nv = ch[PKEY].newValue || { active: null, list: [] };
        if ((nv.active || null) !== state.active && !reloading) { reloading = true; location.reload(); return; }
        state.active = nv.active || null; state.list = nv.list || []; renderAll();
      });
    } catch {}
  }

  window.PBProfiles = { ready, state, mount, switchTo, createProfile, snapshotCurrent, hasData, mergeSnap, applySnapshot };
})();
