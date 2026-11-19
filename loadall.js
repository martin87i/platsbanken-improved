// Körs i sidans egen värld (world: MAIN, se manifest.json) så att Platsbankens sidskript inte kan blockera den.
// Samma kod ligger som reserv i content.js (injectLoadAll) för webbläsare som saknar world: MAIN.
(function (CHUNK, LIMIT, STEP) {
  if (window.__pbLoadAll) return;
  window.__pbLoadAll = true;
  const SEARCH = '/jobs/v1/search';
  const FILTER = { ids: new Set(), shown: new Set(), words: [], invert: false };
  let cap = STEP, state = null, filterReady = null, gotFilter = false;
  filterReady = new Promise((res) => { window.__pbFilterGo = res; setTimeout(res, 1500); });
  // Jobb från karriärsidor som användaren läst in (jobbsamlaren). Visas under fliken Externa webbplatser.
  // Filen kan ta några sekunder att läsa in. Säger tillägget att den läses in (pbExtPending) väntar sökningen
  // på den, högst 20 s; annars bara 1,5 s.
  const EXT = { ads: [], v: 0 };
  let extTimer = 0;
  const extReady = new Promise((res) => { window.__pbExtGo = res; extTimer = setTimeout(res, 1500); });
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    const d = e.data;
    if (d.pbExtPending) { clearTimeout(extTimer); extTimer = setTimeout(window.__pbExtGo, 20000); }
    if (d.pbExt) { EXT.ads = Array.isArray(d.pbExt.ads) ? d.pbExt.ads : []; EXT.v = d.pbExt.v || 0; window.__pbExtGo(); }
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

  // Vilka inlästa jobb som matchar sökningen. Filtrerar som Platsbanken: alla sökord måste finnas
  // (ord med minus får inte finnas), ort och yrke matchas på Arbetsförmedlingens concept-id.
  // Filtertyper som jobben saknar uppgifter för (t.ex. anställningsform) ger inga träffar.
  const PLACE = ['municipality', 'region', 'country'], OCC = ['occupation', 'occupationGroup', 'occupationField'];
  const KNOWN = PLACE.concat(OCC, ['freetext']);
  function extQuery(req) {
    const by = {};
    for (const f of (req.filters || [])) if (f && f.type) (by[f.type] = by[f.type] || []).push(String(f.value));
    const words = [], nots = [];
    for (const w of (String((by.freetext || [''])[0]).toLowerCase().match(/"[^"]+"|\S+/g) || [])) {
      const neg = w[0] === '-' && w.length > 1, t = (neg ? w.slice(1) : w).replace(/"/g, '').trim();
      if (t) (neg ? nots : words).push(t);
    }
    return { by, words, nots, unknown: Object.keys(by).some((t) => KNOWN.indexOf(t) < 0) };
  }
  function matchExt(req) {
    const q = extQuery(req);
    if (q.unknown) return [];
    const has = (a, types) => {
      let any = false;
      for (const t of types) {
        if (!q.by[t]) continue;
        any = true;
        const v = a.x ? a.x[t] : null, arr = Array.isArray(v) ? v : [v];
        for (const want of q.by[t]) if (arr.indexOf(want) >= 0) return true;
      }
      return !any;
    };
    const from = req.fromDate ? Date.parse(req.fromDate) : NaN, to = req.toDate ? Date.parse(req.toDate) : NaN;
    return EXT.ads.filter((a) => {
      if (!has(a, PLACE) || !has(a, OCC)) return false;
      const p = Date.parse(a.publishedDate || '');
      if (!isNaN(from) && !(p >= from)) return false;
      if (!isNaN(to) && p > to) return false;
      if (q.words.length || q.nots.length) {
        const t = [a.title, a.employerName, a.occupation, a.workplace].concat(a.workplaces || []).join(' ').toLowerCase();
        for (const w of q.words) if (t.indexOf(w) < 0) return false;
        for (const w of q.nots) if (t.indexOf(w) >= 0) return false;
      }
      return true;
    });
  }
  // Sortering: vid relevans och sökord kommer Platsbankens egna träffar först, annars blandas allt efter datum
  function mergeExt(theirs, ext, req) {
    const t = (a) => Date.parse(a.publishedDate || '') || 0;
    const mine = ext.slice().sort((a, b) => t(b) - t(a));
    if (/relev/i.test(String(req.order || '')) && extQuery(req).words.length) return theirs.concat(mine);
    return theirs.concat(mine).sort((a, b) => t(b) - t(a));
  }

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
    // Externa webbplatser: blanda in inlästa jobb från karriärsidor, om några finns
    if (req && req.source === 'joblinks') {
      extReady.then(() => {
        if (!EXT.ads.length) { st.skip = true; return send.apply(xhr, args); }
        if (!(req.maxRecords > 0)) { st.extCount = matchExt(req).length; return send.apply(xhr, args); } // bara antal, t.ex. till flikens rubrik
        run(true);
      });
      return;
    }
    if (!req || !(req.maxRecords > 0) || req.source !== 'pb') { st.skip = true; return send.apply(this, args); }
    run(false);
    function run(links) {
    const base = Object.assign({}, req);
    delete base.startIndex; delete base.maxRecords; delete base.toDate; delete base.fromDate;
    const key = JSON.stringify(base) + '|' + req.toDate + (links ? '|ext' + EXT.v : '');
    if (!state || state.key !== key) {
      state = { key, url: st.url, base, to: req.toDate || new Date().toISOString(), raw: [], ids: new Set(), li: 0, off: 0, exhausted: false, total: 0, leaves: null, q: Promise.resolve() };
      cap = STEP;
    }
    const s = state;
    s.q = s.q.then(async () => {
      await filterReady;
      if (!s.leaves) await makePlan(s);
      // Externa webbplatser har få annonser: hämta alla direkt så att de inlästa jobben kan sorteras in rätt
      await fill(s, links ? Infinity : cap);
      if (links && !s.extAdded) {
        s.extAdded = true;
        const ext = matchExt(req).filter((a) => !s.ids.has(a.id));
        for (const a of ext) s.ids.add(a.id);
        s.raw = mergeExt(s.raw, ext, req);
        s.total += ext.length;
      }
      const pass = s.raw.filter(passes);
      st.ads = pass.slice(0, cap);
      st.total = s.total;
      st.msg = { pbTotal: s.total, pbShown: st.ads.length, pbFiltered: s.raw.length - pass.length, pbMore: pass.length > cap || !s.exhausted };
      send.call(xhr, JSON.stringify(Object.assign({}, req, { startIndex: 0, maxRecords: 1 })));
    }).catch(() => { st.skip = true; send.apply(xhr, args); });
    }
  };
  function merge(xhr, v) {
    const st = xhr.__pb;
    if (!st || st.skip || (!st.ads && st.extCount === undefined)) return v;
    const isStr = typeof v === 'string';
    let j = v;
    try { if (isStr) j = JSON.parse(v); } catch (e) { return v; }
    if (!j || (st.ads && !Array.isArray(j.ads))) return v;
    if (st.src === v && st.out) return st.out;
    if (!st.ads) { // antalsfråga: lägg till de inlästa jobben i antalet
      const c = Object.assign({}, j, { numberOfAds: (Number(j.numberOfAds) || 0) + st.extCount });
      st.src = v; st.out = isStr ? JSON.stringify(c) : c;
      return st.out;
    }
    const o = Object.assign({}, j, { ads: st.ads, numberOfAds: st.total });
    st.src = v; st.out = isStr ? JSON.stringify(o) : o;
    try { window.postMessage(st.msg, '*'); } catch (e) {}
    return st.out;
  }
  Object.defineProperty(XMLHttpRequest.prototype, 'responseText', { get() { return merge(this, rt.get.call(this)); }, configurable: true });
  Object.defineProperty(XMLHttpRequest.prototype, 'response', { get() { return merge(this, rs.get.call(this)); }, configurable: true });
})(100, 2100, 200);
