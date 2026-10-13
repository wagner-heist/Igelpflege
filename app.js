'use strict';
/*
 * Igelpflege – lokale Web-App (PWA) zur Verwaltung von Igeln in einer Pflegestelle.
 * Alle Daten liegen ausschließlich in der IndexedDB dieses Geräts.
 * Es gibt keinerlei Netzwerkzugriffe auf Nutzerdaten.
 */
(function () {
  const VERSION = '1.3.0';

  // ---------- Konstanten ----------
  const STORES = ['igel', 'gewichte', 'medikation', 'gaben', 'befunde', 'tierarzt', 'futter', 'fotos', 'settings'];
  const DATA_STORES = STORES.filter((s) => s !== 'settings');
  const STATUS = [['aufnahme', 'Aufnahme'], ['pflege', 'In Pflege'], ['winterschlaf', 'Winterschlaf'], ['ausgewildert', 'Ausgewildert'], ['weitergegeben', 'Weitergegeben'], ['verstorben', 'Verstorben']];
  const STATUS_L = Object.fromEntries(STATUS);
  const ACTIVE = new Set(['aufnahme', 'pflege', 'winterschlaf']);
  const GESCHLECHT = [['unbekannt', 'unbekannt'], ['m', 'männlich'], ['w', 'weiblich']];
  const ALTER = [['unbekannt', 'unbekannt'], ['saeugling', 'Säugling'], ['jungtier', 'Jungtier'], ['adult', 'Erwachsen']];
  const APPLIKATION = [['oral', 'oral'], ['sc', 's.c. (unter die Haut)'], ['im', 'i.m. (in den Muskel)'], ['topisch', 'äußerlich'], ['sonstiges', 'sonstiges']];
  const PARASITEN = ['negativ', 'Crenosoma (Lungenwurm)', 'Capillaria aerophila (Lungenhaarwurm)', 'Capillaria spp. (Darmhaarwurm)', 'Brachylaemus (Saugwurm)', 'Bandwürmer', 'Kokzidien', 'Hefen/Pilze'];
  const BEFALL = [['', '–'], ['gering', 'gering'], ['mittel', 'mittel'], ['stark', 'stark']];
  const GEFRESSEN = [['alles', 'alles'], ['fast', 'fast alles'], ['haelfte', 'etwa die Hälfte'], ['wenig', 'wenig'], ['nichts', 'nichts'], ['offen', 'nicht kontrolliert']];
  const FUTTER_VORSCHLAEGE = ['Katzenfutter (Nass)', 'Katzen-Trockenfutter', 'Igel-Trockenfutter', 'Rührei (ungewürzt)', 'Hähnchen gekocht', 'Insekten', 'Aufzuchtmilch'];
  const DEFAULTS = { id: 'main', pflegestelle: '', ansprechpartner: '', kontakt: '', zielgewicht: 600, wiegenTage: 1, wiegenTageWinter: 7, alarmProzent: 5, alarmTage: 3, lastBackup: null, medListe: null, futterListe: null };

  // ---------- Zustand ----------
  let db;
  const D = {}; DATA_STORES.forEach((s) => (D[s] = []));
  let S = { ...DEFAULTS };
  const ui = { route: { name: 'list' }, prev: null, filter: 'aktiv', search: '', detailTab: 'uebersicht', futterAlle: false };
  const urlCache = new Map();

  // ---------- Hilfsfunktionen ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const pad = (n) => String(n).padStart(2, '0');
  const dStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dtStr = (d) => `${dStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = () => dStr(new Date());
  const nowDT = () => dtStr(new Date());
  function parseD(s) {
    if (!s) return null;
    const [y, m, d, hh = '0', mm = '0'] = String(s).split(/[-T:]/);
    return new Date(+y, +m - 1, +d, +hh, +mm);
  }
  const fmtD = (s) => { const d = parseD(s); return d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}` : ''; };
  const fmtDT = (s) => { const d = parseD(s); if (!d) return ''; return String(s).includes('T') ? `${fmtD(s)}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : fmtD(s); };
  const fmtShort = (s) => { const d = parseD(s); return d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.` : ''; };
  const dayOf = (s) => String(s || '').slice(0, 10);
  function daysBetween(a, b) {
    const da = parseD(dayOf(a)), dbb = parseD(dayOf(b));
    if (!da || !dbb) return null;
    return Math.round((dbb - da) / 864e5);
  }
  function addDays(s, n) { const d = parseD(s); d.setDate(d.getDate() + n); return dStr(d); }
  const num = (v) => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
  const fmtNum = (n, digits = 0) => (n == null ? '' : n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const signed = (n, digits = 0) => (n == null ? '–' : (n > 0 ? '+' : n < 0 ? '−' : '±') + fmtNum(Math.abs(n), digits));
  const label = (list, v) => (list.find((x) => x[0] === v) || [, v || ''])[1];
  const opts = (list) => list.map(([v, l]) => ({ v, l }));

  function toast(msg, ms = 2200) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  // ---------- Datenbank ----------
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('igelpflege', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of STORES) {
          if (!d.objectStoreNames.contains(s)) {
            const os = d.createObjectStore(s, { keyPath: 'id' });
            if (s !== 'igel' && s !== 'settings') os.createIndex('igelId', 'igelId');
          }
        }
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  function dbAll(store) {
    return new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function save(store, obj) {
    if (!obj.id) { obj.id = uid(); obj.createdAt = new Date().toISOString(); }
    obj.updatedAt = new Date().toISOString();
    const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(obj); await txDone(t);
    if (D[store]) { const i = D[store].findIndex((x) => x.id === obj.id); if (i >= 0) D[store][i] = obj; else D[store].push(obj); }
    return obj;
  }
  async function removeMany(store, ids) {
    if (!ids.length) return;
    const t = db.transaction(store, 'readwrite'); const os = t.objectStore(store); ids.forEach((id) => os.delete(id)); await txDone(t);
    const set = new Set(ids); D[store] = D[store].filter((x) => !set.has(x.id));
    if (store === 'fotos') ids.forEach(dropUrl);
  }
  const remove = (store, id) => removeMany(store, [id]);
  async function saveSettings() { const t = db.transaction('settings', 'readwrite'); t.objectStore('settings').put(S); await txDone(t); }
  async function loadAll() {
    for (const s of DATA_STORES) D[s] = await dbAll(s);
    const st = (await dbAll('settings')).find((x) => x.id === 'main');
    S = { ...DEFAULTS, ...(st || {}) };
    // Listen beim ersten Start anlegen (Futterliste mit Vorschlägen, Medikamentenliste leer)
    let init = false;
    if (!Array.isArray(S.medListe)) { S.medListe = []; init = true; }
    if (!Array.isArray(S.futterListe)) { S.futterListe = FUTTER_VORSCHLAEGE.map((name) => ({ id: uid(), name, menge: null, updatedAt: new Date().toISOString() })); init = true; }
    if (init) await saveSettings();
  }
  async function deleteIgel(id) {
    for (const s of DATA_STORES) {
      if (s === 'igel') continue;
      await removeMany(s, D[s].filter((x) => x.igelId === id).map((x) => x.id));
    }
    await remove('igel', id);
  }

  // ---------- Datenzugriff ----------
  const igelById = (id) => D.igel.find((x) => x.id === id);
  const igelName = (i) => (i ? (i.name || (i.nummer ? `Igel Nr. ${i.nummer}` : 'Igel ohne Namen')) : '?');
  const byIgel = (store, id) => D[store].filter((x) => x.igelId === id);
  const weightsOf = (id) => byIgel('gewichte', id).sort((a, b) => a.datum.localeCompare(b.datum));
  const lastWeight = (id) => { const w = weightsOf(id); return w.length ? w[w.length - 1] : null; };
  const firstWeight = (id) => weightsOf(id)[0] || null;
  function trend(id, days = 7) {
    const ws = weightsOf(id); if (ws.length < 2) return null;
    const last = ws[ws.length - 1];
    const cutoff = parseD(last.datum).getTime() - days * 864e5;
    let ref = null;
    for (const w of ws) { if (parseD(w.datum).getTime() <= cutoff) ref = w; }
    if (!ref) ref = ws[0];
    const span = (parseD(last.datum) - parseD(ref.datum)) / 864e5;
    if (span < 0.5) return null;
    return (last.gramm - ref.gramm) / span;
  }
  // Gewichtsalarm: 2× in Folge abgenommen (mind. 1 %) oder Verlust ≥ X % gegenüber dem Höchstwert der letzten N Tage.
  // Igel im Winterschlaf sind ausgenommen (Abnahme dort normal).
  function weightAlarm(i) {
    if (!i || !ACTIVE.has(i.status) || i.status === 'winterschlaf') return null;
    const ws = weightsOf(i.id); if (ws.length < 2) return null;
    const last = ws[ws.length - 1]; const reasons = [];
    if (ws.length >= 3) {
      const a = ws[ws.length - 3], b = ws[ws.length - 2];
      if (b.gramm < a.gramm && last.gramm < b.gramm && (a.gramm - last.gramm) / a.gramm >= 0.01) reasons.push(`2× in Folge abgenommen (${signed(last.gramm - a.gramm)} g)`);
    }
    const tage = S.alarmTage || 3;
    const cutoff = parseD(last.datum).getTime() - tage * 864e5;
    const fenster = ws.filter((w) => w !== last && parseD(w.datum).getTime() >= cutoff);
    if (fenster.length && S.alarmProzent) {
      const max = Math.max(...fenster.map((w) => w.gramm)); const pct = (max - last.gramm) / max * 100;
      if (pct >= S.alarmProzent) reasons.push(`−${fmtNum(pct, 1)} % in ${tage} Tagen (von ${fmtNum(max)} g)`);
    }
    return reasons.length ? { last, text: reasons.join(' · ') } : null;
  }
  // Winterschlaf: Gewicht bei Beginn (letzte Wiegung bis Beginn) und am Ende (erste Wiegung ab Ende) bzw. aktuell
  function winterInfo(i) {
    if (!i.winterschlafBeginn) return null;
    const ws = weightsOf(i.id); const b = i.winterschlafBeginn; const e = i.winterschlafEnde || null;
    const vor = ws.filter((w) => dayOf(w.datum) <= b);
    const wB = vor.length ? vor[vor.length - 1] : (ws.find((w) => dayOf(w.datum) >= b) || null);
    let wE;
    if (e) { wE = ws.find((w) => dayOf(w.datum) >= e) || ws.filter((w) => dayOf(w.datum) <= e).pop() || null; }
    else wE = ws.length ? ws[ws.length - 1] : null;
    const verlust = wB && wE && wE !== wB ? wE.gramm - wB.gramm : null;
    return { beginn: b, ende: e, tage: daysBetween(b, e || today()), wB, wE, verlust, pct: verlust != null ? verlust / wB.gramm * 100 : null };
  }
  const byBox = (a, b) => String(a.box || '~').localeCompare(String(b.box || '~'), 'de', { numeric: true }) || igelName(a).localeCompare(igelName(b), 'de');
  const boxChip = (i) => (i.box ? ` <span class="chip">Box ${esc(i.box)}</span>` : '');
  const photosOf = (id) => byIgel('fotos', id).sort((a, b) => (a.datum || '').localeCompare(b.datum || ''));
  function titlePhoto(igel) {
    const ps = photosOf(igel.id); if (!ps.length) return null;
    return ps.find((p) => p.id === igel.titelFotoId) || ps[ps.length - 1];
  }
  function photoUrl(p, full = false) {
    if (!p) return '';
    const key = p.id + (full ? ':f' : ':t');
    if (!urlCache.has(key)) urlCache.set(key, URL.createObjectURL(new Blob([full ? p.full : p.thumb], { type: p.type || 'image/jpeg' })));
    return urlCache.get(key);
  }
  function dropUrl(id) { for (const k of [id + ':f', id + ':t']) { if (urlCache.has(k)) { URL.revokeObjectURL(urlCache.get(k)); urlCache.delete(k); } } }
  const inCareDays = (i) => { const end = ACTIVE.has(i.status) ? today() : (i.abgangDatum || today()); return daysBetween(i.aufnahmeDatum, end); };

  function medActiveOn(m, day) {
    if (!m.start || m.start > day) return false;
    if (m.tage) { const ende = addDays(m.start, m.tage - 1); if (day > ende) return false; }
    return !m.abgesetzt;
  }
  const medEnde = (m) => (m.tage ? addDays(m.start, m.tage - 1) : null);
  const gabenOn = (medId, day) => D.gaben.filter((g) => g.medId === medId && dayOf(g.zeit) === day).sort((a, b) => a.zeit.localeCompare(b.zeit));

  // ---------- "Heute fällig" ----------
  function dueItems() {
    const t = today();
    const soon = addDays(t, 3);
    const active = D.igel.filter((i) => ACTIVE.has(i.status));
    const meds = [], wiegen = [], termine = [], kontrollen = [], futter = [], alarme = [];
    for (const i of active) {
      const al = weightAlarm(i); if (al) alarme.push({ igel: i, ...al });
      for (const m of byIgel('medikation', i.id)) {
        if (!medActiveOn(m, t)) continue;
        const done = gabenOn(m.id, t).length;
        meds.push({ igel: i, med: m, done, soll: m.proTag || 1 });
      }
      const lw = lastWeight(i.id);
      const intervall = i.status === 'winterschlaf' ? S.wiegenTageWinter : S.wiegenTage;
      const seit = lw ? daysBetween(lw.datum, t) : null;
      if (!lw || seit >= intervall) wiegen.push({ igel: i, seit, lw });

      const visits = byIgel('tierarzt', i.id);
      for (const v of visits) {
        if (!v.naechsterTermin || v.naechsterTermin > soon) continue;
        if (visits.some((x) => x.id !== v.id && x.datum >= v.naechsterTermin)) continue;
        termine.push({ igel: i, v, over: v.naechsterTermin < t, heute: v.naechsterTermin === t });
      }
      const bef = byIgel('befunde', i.id);
      for (const b of bef) {
        if (!b.kontrolleAm || b.kontrolleAm > soon) continue;
        if (bef.some((x) => x.id !== b.id && x.datum >= b.kontrolleAm)) continue;
        kontrollen.push({ igel: i, b, over: b.kontrolleAm < t, heute: b.kontrolleAm === t });
      }
      if (i.status !== 'winterschlaf' && !byIgel('futter', i.id).some((f) => dayOf(f.datum) === t)) futter.push({ igel: i });
    }
    const offeneMeds = meds.filter((x) => x.done < x.soll).length;
    const count = alarme.length + offeneMeds + wiegen.length +termine.filter((x) => x.over || x.heute).length + kontrollen.filter((x) => x.over || x.heute).length;
    [meds, wiegen, termine, kontrollen, futter, alarme].forEach((l) => l.sort((a, b) => byBox(a.igel, b.igel)));
    return { meds, wiegen, termine, kontrollen, futter, alarme, count };
  }
  function updateBadge() {
    const n = dueItems().count; const b = $('#badgeHeute');
    b.hidden = !n; b.textContent = n > 99 ? '99+' : n;
  }

  // ---------- Navigation ----------
  function go(route, opts2 = {}) {
    if (opts2.keepPrev !== true) ui.prev = ui.route;
    ui.route = route;
    if (route.name === 'detail' && !opts2.keepTab) { ui.detailTab = 'uebersicht'; ui.futterAlle = false; }
    window.scrollTo(0, 0);
    render();
  }
  function back() {
    const parent = { medliste: 'einstellungen', futterliste: 'einstellungen', finderliste: 'einstellungen', statistik: 'einstellungen', finder: 'finderliste' }[ui.route.name];
    let p = parent ? { name: parent } : (ui.prev && ui.prev.name !== 'detail' ? ui.prev : { name: 'list' });
    if (ui.route.name === 'finder' && ui.prev && ui.prev.name === 'detail') p = ui.prev; // vom Igel aus geöffnet → zurück zum Igel
    ui.prev = null; go(p, { keepPrev: true });
  }
  function setHeader(title, { back: showBack = false, action = null } = {}) {
    $('#title').textContent = title;
    $('#btnBack').hidden = !showBack;
    const a = $('#btnAction');
    if (action) { a.hidden = false; a.textContent = action.label; a.onclick = action.fn; a.setAttribute('aria-label', action.aria || action.label); }
    else { a.hidden = true; a.onclick = null; }
  }
  function setTab(name) { $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name)); }

  function render() {
    const r = ui.route;
    const view = $('#view');
    if (r.name === 'list') { setTab('igel'); view.innerHTML = viewList(); }
    else if (r.name === 'detail') {
      const i = igelById(r.id);
      if (!i) { ui.route = { name: 'list' }; return render(); }
      setTab(ui.prev && ui.prev.name === 'heute' ? 'heute' : 'igel');
      view.innerHTML = viewDetail(i);
    }
    else if (r.name === 'heute') { setTab('heute'); view.innerHTML = viewHeute(); }
    else if (r.name === 'medliste') { setTab('einstellungen'); view.innerHTML = viewMedListe(); }
    else if (r.name === 'futterliste') { setTab('einstellungen'); view.innerHTML = viewFutterListe(); }
    else if (r.name === 'finderliste') { setTab('einstellungen'); view.innerHTML = viewFinderListe(); }
    else if (r.name === 'finder') { setTab('einstellungen'); view.innerHTML = viewFinder(r.key); }
    else if (r.name === 'statistik') { setTab('einstellungen'); view.innerHTML = viewStatistik(); }
    else if (r.name === 'einstellungen') { setTab('einstellungen'); view.innerHTML = viewSettings(); fillStorageInfo(); }
    updateBadge();
  }

  // ---------- Ansicht: Liste ----------
  function viewList() {
    setHeader('Igel', { action: { label: '＋', aria: 'Igel aufnehmen', fn: () => igelForm() } });
    const q = ui.search.trim().toLowerCase();
    let list = D.igel.filter((i) => ui.filter === 'alle' || (ui.filter === 'aktiv' ? ACTIVE.has(i.status) : !ACTIVE.has(i.status)));
    if (q) list = list.filter((i) => [i.name, i.nummer, i.box, i.fundOrt, i.finderName].some((v) => String(v || '').toLowerCase().includes(q)));
    list.sort((a, b) => (b.aufnahmeDatum || '').localeCompare(a.aufnahmeDatum || '') || igelName(a).localeCompare(igelName(b)));
    const cntA = D.igel.filter((i) => ACTIVE.has(i.status)).length;
    let html = `
      <div class="seg">
        ${[['aktiv', `In Pflege (${cntA})`], ['abgeschlossen', 'Abgeschlossen'], ['alle', 'Alle']].map(([v, l]) => `<button data-act="filter" data-v="${v}" class="${ui.filter === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="toolbar"><input class="search" id="search" type="search" placeholder="Suchen (Name, Nr., Box, Fundort, Finder)" value="${esc(ui.search)}" autocomplete="off"></div>
      ${cntA ? `<div class="btn-row" style="margin-bottom:12px"><button class="btn small secondary" data-act="bulkWeigh">⚖️ Alle wiegen</button><button class="btn small secondary" data-act="bulkFeed">🍽️ Alle füttern</button></div>` : ''}`;
    if (!D.igel.length) {
      return html + `<div class="empty"><div class="big">🦔</div><p>Noch keine Igel erfasst.</p><button class="btn" data-act="newIgel" style="max-width:260px">Ersten Igel aufnehmen</button></div>`;
    }
    if (!list.length) return html + `<div class="empty">Keine Treffer.</div>`;
    html += `<div class="list">` + list.map((i) => {
      const p = titlePhoto(i); const lw = lastWeight(i.id); const tr = trend(i.id);
      const al = weightAlarm(i);
      const sub = [al ? '<span class="down">⚠️ Gewichtsalarm</span>' : '', i.nummer ? `Nr. ${esc(i.nummer)}` : '', i.box ? `Box ${esc(i.box)}` : '', lw ? `${fmtNum(lw.gramm)} g` : 'kein Gewicht', tr != null ? `<span class="${tr >= 0 ? 'up' : 'down'}">${signed(tr, 1)} g/Tag</span>` : ''].filter(Boolean).join(' · ');
      const tage = inCareDays(i);
      return `<button class="row" data-act="open" data-id="${i.id}">
        ${p ? `<img class="thumb" src="${photoUrl(p)}" alt="">` : `<span class="thumb">🦔</span>`}
        <span class="grow"><span class="t">${esc(igelName(i))}</span> <span class="chip ${i.status}">${esc(STATUS_L[i.status] || i.status)}</span><br><span class="s">${sub}</span></span>
        <span class="r">${tage != null ? `${tage} T` : ''}</span><span class="chev">›</span>
      </button>`;
    }).join('') + `</div>`;
    return html;
  }

  // ---------- Ansicht: Detail ----------
  function viewDetail(i) {
    setHeader(igelName(i), { back: true, action: { label: 'Bearbeiten', fn: () => igelForm(i) } });
    const tabs = [['uebersicht', 'Übersicht'], ['gewicht', 'Gewicht'], ['medizin', 'Medizin'], ['futter', 'Futter']];
    let html = `<div class="seg">${tabs.map(([v, l]) => `<button data-act="dtab" data-v="${v}" class="${ui.detailTab === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
    if (ui.detailTab === 'uebersicht') html += detailUebersicht(i);
    if (ui.detailTab === 'gewicht') html += detailGewicht(i);
    if (ui.detailTab === 'medizin') html += detailMedizin(i);
    if (ui.detailTab === 'futter') html += detailFutter(i);
    return html;
  }

  function statsHtml(i) {
    const lw = lastWeight(i.id), fw = firstWeight(i.id), tr = trend(i.id);
    const diff = lw && fw && lw !== fw ? lw.gramm - fw.gramm : null;
    return `<div class="stats">
      <div class="stat"><div class="v">${lw ? fmtNum(lw.gramm) + ' g' : '–'}</div><div class="l">Aktuell${lw ? ' · ' + fmtShort(lw.datum) : ''}</div></div>
      <div class="stat"><div class="v ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}">${diff != null ? signed(diff) + ' g' : '–'}</div><div class="l">seit Aufnahme</div></div>
      <div class="stat"><div class="v ${tr > 0 ? 'up' : tr < 0 ? 'down' : ''}">${tr != null ? signed(tr, 1) : '–'}</div><div class="l">g/Tag (7 Tage)</div></div>
    </div>`;
  }

  function detailUebersicht(i) {
    const p = titlePhoto(i); const ps = photosOf(i.id);
    const tage = inCareDays(i);
    const al = weightAlarm(i); const wi = winterInfo(i);
    const kv = [
      ['Pflege-Nr.', i.nummer], ['Box / Gehege', i.box], ['Geschlecht', label(GESCHLECHT, i.geschlecht)], ['Alter', label(ALTER, i.alter)],
      ['Aufnahme', fmtD(i.aufnahmeDatum)], ['Fund am', fmtD(i.fundDatum)], ['Fundort', i.fundOrt], ['Fundumstände', i.fundUmstaende],
      ['Finder', i.finderName], ['Kontakt Finder', i.finderKontakt], ['Zustand bei Aufnahme', i.zustand],
      ['Abgang am', fmtD(i.abgangDatum)], ['Verbleib / Ort', i.abgangOrt], ['Notizen', i.notizen]
    ].filter(([, v]) => v && v !== 'unbekannt' || false);
    const winterHtml = wi ? `
      <div class="section-title">Winterschlaf</div>
      <div class="card"><dl class="kv">
        <dt>Beginn</dt><dd>${fmtD(wi.beginn)}</dd>
        <dt>Ende</dt><dd>${wi.ende ? fmtD(wi.ende) : `läuft (${wi.tage} ${wi.tage === 1 ? 'Tag' : 'Tage'})`}</dd>
        ${wi.ende ? `<dt>Dauer</dt><dd>${wi.tage} Tage</dd>` : ''}
        <dt>Gewicht Beginn</dt><dd>${wi.wB ? `${fmtNum(wi.wB.gramm)} g (${fmtD(wi.wB.datum)})` : '–'}</dd>
        <dt>${wi.ende ? 'Gewicht Ende' : 'Gewicht aktuell'}</dt><dd>${wi.wE ? `${fmtNum(wi.wE.gramm)} g (${fmtD(wi.wE.datum)})` : '–'}</dd>
        <dt>Veränderung</dt><dd class="${wi.verlust < 0 ? 'down' : wi.verlust > 0 ? 'up' : ''}">${wi.verlust != null ? `${signed(wi.verlust)} g (${signed(wi.pct, 1)} %)` : '–'}</dd>
      </dl></div>` : '';
    return `
      ${al ? `<div class="hint alarm">⚠️ <strong>Gewichtsalarm:</strong> ${esc(al.text)}</div>` : ''}
      <div class="card">
        <div class="hero">
          ${p ? `<img class="avatar" src="${photoUrl(p)}" alt="" data-act="photo" data-id="${p.id}">` : `<span class="avatar">🦔</span>`}
          <div><h2>${esc(igelName(i))}</h2>
            <span class="chip ${i.status}">${esc(STATUS_L[i.status])}</span>
            <div class="meta">${[i.box ? `Box ${esc(i.box)}` : '', tage != null ? `${tage} ${tage === 1 ? 'Tag' : 'Tage'} in Pflege` : ''].filter(Boolean).join(' · ')}</div></div>
        </div>
        ${statsHtml(i)}
      </div>
      <div class="section-title">Fotos (${ps.length})</div>
      <div class="gallery">
        <button class="add" data-act="addPhoto" data-id="${i.id}">📷<br>Foto hinzufügen</button>
        ${ps.slice().reverse().map((f) => `<img src="${photoUrl(f)}" alt="" data-act="photo" data-id="${f.id}">`).join('')}
      </div>
      ${winterHtml}
      <div class="section-title">Daten</div>
      <div class="card">${kv.length ? `<dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${k === 'Kontakt Finder' ? kontaktLinks(String(v).split(/[,;]/).map((x) => x.trim()).filter(Boolean)) : esc(v)}</dd>`).join('')}</dl>` : '<span class="note">Keine weiteren Daten.</span>'}
        ${i.finderName || i.finderKontakt ? `<p style="margin:10px 0 0"><button class="link" data-act="openFinder" data-key="${esc(finderKey(i))}">👤 Finder anzeigen${(() => { const n = finderList().find((f) => f.key === finderKey(i))?.igel.length || 0; return n > 1 ? ` (${n} Igel)` : ''; })()}</button></p>` : ''}</div>
      <div class="btn-row">
        <button class="btn secondary" data-act="pdf" data-id="${i.id}">📄 Pflegeprotokoll (PDF)</button>
        <button class="btn danger" data-act="delIgel" data-id="${i.id}">Igel löschen</button>
      </div>`;
  }

  function detailGewicht(i) {
    const ws = weightsOf(i.id);
    const rows = ws.slice().reverse().map((w, idx, arr) => {
      const prev = arr[idx + 1];
      const d = prev ? w.gramm - prev.gramm : null;
      return `<button class="row" data-act="editWeight" data-id="${w.id}">
        <span class="grow"><span class="t">${fmtNum(w.gramm)} g</span>${d != null ? ` <span class="${d >= 0 ? 'up' : 'down'}">${signed(d)} g</span>` : ''}<br><span class="s">${fmtDT(w.datum)}${w.notiz ? ' · ' + esc(w.notiz) : ''}</span></span><span class="chev">›</span></button>`;
    }).join('');
    const al = weightAlarm(i);
    return `
      ${al ? `<div class="hint alarm">⚠️ <strong>Gewichtsalarm:</strong> ${esc(al.text)}</div>` : ''}
      <div class="card">${statsHtml(i)}<div style="margin-top:12px">${chartSvg(ws)}</div></div>
      <button class="btn" data-act="addWeight" data-id="${i.id}">⚖️ Wiegen</button>
      <div class="section-title">Wiegeprotokoll (${ws.length})</div>
      ${ws.length ? `<div class="list">${rows}</div>` : '<div class="empty">Noch keine Wiegung eingetragen.</div>'}`;
  }

  function detailMedizin(i) {
    const t = today();
    const meds = byIgel('medikation', i.id).sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    const aktiv = meds.filter((m) => medActiveOn(m, t) || (m.start > t && !m.abgesetzt));
    const alt = meds.filter((m) => !aktiv.includes(m));
    const medRow = (m) => {
      const ende = medEnde(m);
      const g = gabenOn(m.id, t).length; const soll = m.proTag || 1;
      const isActive = medActiveOn(m, t);
      return `<button class="row" data-act="editMed" data-id="${m.id}">
        <span class="grow"><span class="t">${esc(m.mittel)}</span> <span class="s">${esc(m.dosis)} · ${esc(label(APPLIKATION, m.applikation))} · ${soll}× tägl.</span><br>
        <span class="s">${fmtD(m.start)} – ${m.abgesetzt ? 'abgesetzt ' + fmtD(m.abgesetzt) : ende ? fmtD(ende) : 'offen'}${m.grund ? ' · ' + esc(m.grund) : ''}</span></span>
        ${isActive ? `<span class="r ${g >= soll ? 'done-mark' : 'progress'}">${g}/${soll} heute</span>` : ''}<span class="chev">›</span></button>`;
    };
    const bef = byIgel('befunde', i.id).sort((a, b) => b.datum.localeCompare(a.datum));
    const ta = byIgel('tierarzt', i.id).sort((a, b) => b.datum.localeCompare(a.datum));
    return `
      <div class="section-title">Aktuelle Medikation <button class="link" data-act="addMed" data-id="${i.id}">＋ Neu</button></div>
      ${aktiv.length ? `<div class="list">${aktiv.map(medRow).join('')}</div>` : '<div class="card note">Keine laufende Medikation.</div>'}
      ${aktiv.filter((m) => medActiveOn(m, t)).length ? `<div class="btn-row" style="margin-bottom:12px">${aktiv.filter((m) => medActiveOn(m, t)).map((m) => `<button class="btn small secondary" data-act="give" data-id="${m.id}">✓ ${esc(m.mittel)} gegeben</button>`).join('')}</div>` : ''}
      ${alt.length ? `<div class="section-title">Frühere Medikation</div><div class="list">${alt.map(medRow).join('')}</div>` : ''}

      <div class="section-title">Kotproben / Parasiten <button class="link" data-act="addBefund" data-id="${i.id}">＋ Neu</button></div>
      ${bef.length ? `<div class="list">${bef.map((b) => `<button class="row" data-act="editBefund" data-id="${b.id}">
        <span class="grow"><span class="t">${fmtD(b.datum)}</span>${b.befall ? ` <span class="chip">${esc(b.befall)}</span>` : ''}<br>
        <span class="s">${esc((b.ergebnis || []).join(', ') || 'kein Ergebnis eingetragen')}${b.kontrolleAm ? ' · Kontrolle ' + fmtD(b.kontrolleAm) : ''}</span></span><span class="chev">›</span></button>`).join('')}</div>` : '<div class="card note">Noch keine Kotprobe eingetragen.</div>'}

      <div class="section-title">Tierarzt <button class="link" data-act="addVet" data-id="${i.id}">＋ Neu</button></div>
      ${ta.length ? `<div class="list">${ta.map((v) => `<button class="row" data-act="editVet" data-id="${v.id}">
        <span class="grow"><span class="t">${fmtD(v.datum)}</span> <span class="s">${esc(v.praxis || '')}</span><br>
        <span class="s">${esc(v.grund || '')}${v.diagnose ? ' · ' + esc(v.diagnose) : ''}${v.naechsterTermin ? ' · nächster Termin ' + fmtD(v.naechsterTermin) : ''}</span></span>
        ${v.kosten != null ? `<span class="r">${fmtNum(v.kosten, 2)} €</span>` : ''}<span class="chev">›</span></button>`).join('')}</div>` : '<div class="card note">Noch kein Tierarztbesuch eingetragen.</div>'}`;
  }

  function detailFutter(i) {
    const fs = byIgel('futter', i.id).sort((a, b) => b.datum.localeCompare(a.datum));
    const shown = ui.futterAlle ? fs : fs.slice(0, 40);
    return `
      <button class="btn" data-act="addFutter" data-id="${i.id}">🍽️ Fütterung eintragen</button>
      <div class="section-title">Futterprotokoll (${fs.length})</div>
      ${fs.length ? `<div class="list">${shown.map((f) => `<button class="row" data-act="editFutter" data-id="${f.id}">
        <span class="grow"><span class="t">${esc(f.futter || 'Futter')}</span>${f.menge != null ? ` <span class="s">${fmtNum(f.menge)} g</span>` : ''}<br>
        <span class="s">${fmtDT(f.datum)} · gefressen: ${esc(label(GEFRESSEN, f.gefressen))}${f.notiz ? ' · ' + esc(f.notiz) : ''}</span></span><span class="chev">›</span></button>`).join('')}</div>
        ${fs.length > shown.length ? `<button class="btn secondary" data-act="futterAlle">Alle ${fs.length} Einträge anzeigen</button>` : ''}` : '<div class="empty">Noch keine Fütterung eingetragen.</div>'}`;
  }

  // ---------- Diagramm ----------
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  function chartScale(ws, ziel) {
    const xs = ws.map((w) => parseD(w.datum).getTime()); const ys = ws.map((w) => w.gramm);
    let ymin = Math.min(...ys), ymax = Math.max(...ys);
    if (ziel) { ymin = Math.min(ymin, ziel); ymax = Math.max(ymax, ziel); }
    const step = niceStep(Math.max(ymax - ymin, 40) / 4);
    ymin = Math.floor(ymin / step) * step; ymax = Math.ceil(ymax / step) * step;
    if (ymax === ymin) ymax += step;
    let xmin = Math.min(...xs), xmax = Math.max(...xs);
    if (xmax - xmin < 864e5) xmax = xmin + 864e5;
    return { xs, ys, xmin, xmax, ymin, ymax, step };
  }
  function chartSvg(ws) {
    if (ws.length < 2) return '<p class="note">Ab zwei Wiegungen erscheint hier der Gewichtsverlauf.</p>';
    const W = 340, H = 190, L = 40, R = 10, T = 12, B = 24;
    const ziel = S.zielgewicht || null;
    const sc = chartScale(ws, ziel);
    const X = (x) => L + (x - sc.xmin) / (sc.xmax - sc.xmin) * (W - L - R);
    const Y = (y) => T + (1 - (y - sc.ymin) / (sc.ymax - sc.ymin)) * (H - T - B);
    let g = '';
    for (let v = sc.ymin; v <= sc.ymax + 0.001; v += sc.step) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 5}" y="${Y(v) + 3}" text-anchor="end">${fmtNum(v)}</text>`;
    const nx = 4;
    for (let k = 0; k <= nx; k++) {
      const x = sc.xmin + (sc.xmax - sc.xmin) * k / nx;
      g += `<text x="${X(x)}" y="${H - 6}" text-anchor="${k === 0 ? 'start' : k === nx ? 'end' : 'middle'}">${fmtShort(dtStr(new Date(x)))}</text>`;
    }
    const pts = sc.xs.map((x, k) => [X(x), Y(sc.ys[k])]);
    const path = pts.map((p, k) => (k ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
    const area = path + `L${pts[pts.length - 1][0].toFixed(1)},${Y(sc.ymin)}L${pts[0][0].toFixed(1)},${Y(sc.ymin)}Z`;
    const zielLine = ziel ? `<line class="ziel" x1="${L}" x2="${W - R}" y1="${Y(ziel)}" y2="${Y(ziel)}"/><text class="ziel-t" x="${W - R}" y="${Y(ziel) - 4}" text-anchor="end">Ziel ${fmtNum(ziel)} g</text>` : '';
    const dots = pts.length <= 60 ? pts.map((p) => `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3"/>`).join('') : '';
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewichtsverlauf">${g}<path class="area" d="${area}"/>${zielLine}<path class="line" d="${path}"/>${dots}</svg>`;
  }

  // ---------- Ansicht: Heute ----------
  function viewHeute() {
    setHeader('Heute');
    const d = dueItems(); const t = today();
    let html = '';
    const backupAlt = !S.lastBackup || daysBetween(S.lastBackup, t) >= 7;
    if (D.igel.length && backupAlt) html += `<div class="hint">💾 ${S.lastBackup ? `Letztes Backup vor ${daysBetween(S.lastBackup, t)} Tagen.` : 'Noch kein Backup erstellt.'} <button class="link" data-act="backup">Jetzt sichern</button></div>`;

    const igelLink = (i) => `<button class="link" data-act="open" data-id="${i.id}">${esc(igelName(i))}</button>${boxChip(i)}`;
    const anyActive = D.igel.some((i) => ACTIVE.has(i.status));
    const anyFeed = D.igel.some((i) => ACTIVE.has(i.status) && i.status !== 'winterschlaf');

    if (d.alarme.length) {
      html += `<div class="section-title">⚠️ Gewichtsalarm</div><div class="list">${d.alarme.map(({ igel, last, text }) => `
        <div class="row due over"><span class="grow">${igelLink(igel)}<br><span class="s down">${esc(text)}</span><br>
        <span class="s">aktuell ${fmtNum(last.gramm)} g · ${fmtDT(last.datum)}</span></span></div>`).join('')}</div>`;
    }

    html += `<div class="section-title">Medikamente</div>`;
    if (d.meds.length) {
      d.meds.sort((a, b) => (a.done >= a.soll) - (b.done >= b.soll) || byBox(a.igel, b.igel));
      html += `<div class="list">${d.meds.map(({ igel, med, done, soll }) => `
        <div class="row ${done < soll ? 'due' : ''}">
          <span class="grow">${igelLink(igel)}<br><span class="t">${esc(med.mittel)}</span> <span class="s">${esc(med.dosis)} · ${esc(label(APPLIKATION, med.applikation))}</span>
          ${done ? `<br><span class="s">gegeben: ${gabenOn(med.id, t).map((g) => fmtDT(g.zeit).split(', ')[1]).join(', ')} · <button class="link" data-act="undoGive" data-id="${med.id}">rückgängig</button></span>` : ''}</span>
          <span class="r"><span class="${done >= soll ? 'done-mark' : 'progress'}">${done}/${soll}</span><br>
          ${done < soll ? `<button class="btn small" data-act="give" data-id="${med.id}">✓ Gegeben</button>` : ''}</span>
        </div>`).join('')}</div>`;
    } else html += `<div class="card note">Heute keine Medikamente fällig.</div>`;

    html += `<div class="section-title">Wiegen fällig ${anyActive ? '<button class="link" data-act="bulkWeigh">⚖️ Alle wiegen</button>' : ''}</div>`;
    if (d.wiegen.length) {
      html += `<div class="list">${d.wiegen.map(({ igel, seit, lw }) => `
        <div class="row due"><span class="grow">${igelLink(igel)}<br><span class="s">${lw ? `zuletzt ${fmtNum(lw.gramm)} g, vor ${seit} ${seit === 1 ? 'Tag' : 'Tagen'}` : 'noch nie gewogen'}</span></span>
        <button class="btn small" data-act="addWeight" data-id="${igel.id}">⚖️ Wiegen</button></div>`).join('')}</div>`;
    } else html += `<div class="card note">Alle Igel sind aktuell gewogen.</div>`;

    if (d.termine.length || d.kontrollen.length) {
      html += `<div class="section-title">Termine (nächste 3 Tage)</div><div class="list">`;
      html += d.termine.map(({ igel, v, over, heute }) => `<div class="row due ${over ? 'over' : ''}"><span class="grow">${igelLink(igel)}<br><span class="s">🩺 Tierarzt ${over ? 'überfällig seit' : heute ? 'heute,' : 'am'} ${fmtD(v.naechsterTermin)}${v.praxis ? ' · ' + esc(v.praxis) : ''}</span></span></div>`).join('');
      html += d.kontrollen.map(({ igel, b, over, heute }) => `<div class="row due ${over ? 'over' : ''}"><span class="grow">${igelLink(igel)}<br><span class="s">🔬 Kontroll-Kotprobe ${over ? 'überfällig seit' : heute ? 'heute,' : 'am'} ${fmtD(b.kontrolleAm)}</span></span></div>`).join('');
      html += `</div>`;
    }

    html += `<div class="section-title">Fütterung heute offen ${anyFeed ? '<button class="link" data-act="bulkFeed">🍽️ Alle füttern</button>' : ''}</div>`;
    if (d.futter.length) {
      html += `<div class="list">${d.futter.map(({ igel }) => `<div class="row"><span class="grow">${igelLink(igel)}</span><button class="btn small secondary" data-act="addFutter" data-id="${igel.id}">🍽️ Eintragen</button></div>`).join('')}</div>`;
    } else html += `<div class="card note">${D.igel.some((i) => ACTIVE.has(i.status)) ? 'Für alle Igel ist heute eine Fütterung eingetragen.' : 'Zurzeit keine Igel in Pflege.'}</div>`;
    return html;
  }

  // ---------- Ansicht: Medikamenten- und Futterliste ----------
  function viewMedListe() {
    setHeader('Medikamentenliste', { back: true, action: { label: '＋', aria: 'Medikament hinzufügen', fn: () => medListeForm() } });
    const l = byName(S.medListe);
    return `<p class="note">Vorlagen für die Medikation. Beim Eintragen einer Medikation wählst du ein Medikament aus der Liste, dann werden Dosis, Verabreichung, Gaben pro Tag und Dauer vorbelegt. Die Werte bleiben im Formular änderbar.</p>` +
      (l.length ? `<div class="list">${l.map((m) => `<button class="row" data-act="editMedListe" data-id="${m.id}"><span class="grow"><span class="t">${esc(m.name)}</span><br>
        <span class="s">${[m.dosis, m.applikation ? label(APPLIKATION, m.applikation) : '', m.proTag ? `${m.proTag}× tägl.` : '', m.tage ? `${m.tage} Tage` : ''].filter(Boolean).map(esc).join(' · ') || 'keine Vorgaben'}</span>
        ${m.hinweis ? `<br><span class="s">ℹ️ ${esc(m.hinweis)}</span>` : ''}</span><span class="chev">›</span></button>`).join('')}</div>`
        : `<div class="empty">Noch keine Medikamente angelegt.<br><br><button class="btn" data-act="addMedListe" style="max-width:260px">Medikament anlegen</button></div>`);
  }
  function viewFutterListe() {
    setHeader('Futterliste', { back: true, action: { label: '＋', aria: 'Futter hinzufügen', fn: () => futterListeForm() } });
    const l = byName(S.futterListe);
    return `<p class="note">Futtersorten zur Auswahl beim Füttern. Ist eine Standardmenge hinterlegt, wird sie automatisch vorbelegt.</p>` +
      (l.length ? `<div class="list">${l.map((f) => `<button class="row" data-act="editFutterListe" data-id="${f.id}"><span class="grow"><span class="t">${esc(f.name)}</span>${f.notiz ? `<br><span class="s">${esc(f.notiz)}</span>` : ''}</span>
        <span class="r">${f.menge != null ? `${fmtNum(f.menge)} g` : ''}</span><span class="chev">›</span></button>`).join('')}</div>`
        : `<div class="empty">Noch keine Futtersorten angelegt.<br><br><button class="btn" data-act="addFutterListe" style="max-width:260px">Futter anlegen</button></div>`);
  }
  function listItemForm({ listKey, item, title, fields, deleteLabel }) {
    openForm({
      title, groups: [fields], values: item || {},
      onSave: async (v) => {
        if (S[listKey].some((x) => x.id !== item?.id && x.name.trim().toLowerCase() === v.name.trim().toLowerCase())) { toast(`„${v.name}“ steht schon in der Liste.`); return false; }
        const obj = { ...(item || { id: uid() }), ...v, updatedAt: new Date().toISOString() };
        const k = S[listKey].findIndex((x) => x.id === obj.id);
        if (k >= 0) S[listKey][k] = obj; else S[listKey].push(obj);
        await saveSettings(); toast('Gespeichert'); return true;
      },
      onDelete: item ? async () => {
        if (!confirm(`„${item.name}“ aus der Liste entfernen?\n\nBereits eingetragene Medikationen/Fütterungen bleiben erhalten.`)) return false;
        S[listKey] = S[listKey].filter((x) => x.id !== item.id); await saveSettings(); return true;
      } : null,
      deleteLabel
    });
  }
  function medListeForm(m = null) {
    listItemForm({
      listKey: 'medListe', item: m, title: m ? 'Medikament bearbeiten' : 'Neues Medikament', deleteLabel: 'Aus Liste entfernen',
      fields: [
        { key: 'name', label: 'Name (inkl. Stärke, z. B. „Baytril 2,5 %“)', required: true },
        { key: 'dosis', label: 'Standard-Dosis', placeholder: 'z. B. 0,1 ml' },
        { key: 'applikation', label: 'Verabreichung', type: 'select', options: opts(APPLIKATION), default: 'oral' },
        { key: 'proTag', label: 'Gaben pro Tag', type: 'number', default: 1 },
        { key: 'tage', label: 'Standard-Dauer in Tagen (leer = offen)', type: 'number' },
        { key: 'hinweis', label: 'Hinweis (wird beim Auswählen angezeigt)', type: 'textarea' }
      ]
    });
  }
  function futterListeForm(f = null) {
    listItemForm({
      listKey: 'futterListe', item: f, title: f ? 'Futter bearbeiten' : 'Neues Futter', deleteLabel: 'Aus Liste entfernen',
      fields: [
        { key: 'name', label: 'Futtersorte', required: true },
        { key: 'menge', label: 'Standardmenge (g, optional)', type: 'number' },
        { key: 'notiz', label: 'Notiz (z. B. Marke, Bezugsquelle)' }
      ]
    });
  }

  // ---------- Finderliste (wird automatisch aus den Igel-Daten gebildet) ----------
  const finderKey = (i) => {
    const n = String(i.finderName || '').trim().toLowerCase();
    return n || '#' + String(i.finderKontakt || '').trim().toLowerCase();
  };
  function finderList() {
    const map = new Map();
    for (const i of D.igel) {
      if (!String(i.finderName || '').trim() && !String(i.finderKontakt || '').trim()) continue;
      const k = finderKey(i);
      let f = map.get(k);
      if (!f) { f = { key: k, name: String(i.finderName || '').trim(), kontakte: [], igel: [] }; map.set(k, f); }
      for (const kt of String(i.finderKontakt || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean)) if (!f.kontakte.includes(kt)) f.kontakte.push(kt);
      f.igel.push(i);
    }
    const fd = (i) => i.fundDatum || i.aufnahmeDatum || '';
    for (const f of map.values()) { f.igel.sort((a, b) => fd(b).localeCompare(fd(a))); f.letzter = fd(f.igel[0]); }
    return [...map.values()].sort((a, b) => (a.name || '~').localeCompare(b.name || '~', 'de'));
  }
  function kontaktLinks(list) {
    return list.map((k) => {
      const e = esc(k);
      if (k.includes('@')) return `<a href="mailto:${e}">${e}</a>`;
      const tel = k.replace(/[^\d+]/g, '');
      return tel.length >= 6 ? `<a href="tel:${esc(tel)}">${e}</a>` : e;
    }).join('<br>');
  }
  function viewFinderListe() {
    setHeader('Finderliste', { back: true });
    const all = finderList(); const q = (ui.finderSearch || '').trim().toLowerCase();
    const l = q ? all.filter((f) => [f.name, ...f.kontakte, ...f.igel.map((i) => igelName(i)), ...f.igel.map((i) => i.fundOrt)].some((v) => String(v || '').toLowerCase().includes(q))) : all;
    let html = `<p class="note">Alle Finder aus den Igel-Daten. Neue Finder kommen automatisch dazu, sobald du beim Igel einen Finder einträgst.</p>
      <div class="toolbar"><input class="search" id="finderSearch" type="search" placeholder="Suchen (Name, Telefon, Igel, Fundort)" value="${esc(ui.finderSearch || '')}" autocomplete="off"></div>`;
    if (!all.length) return html + `<div class="empty"><div class="big">👤</div>Noch keine Finder erfasst.<br><span class="note">Trage beim Igel unter „Bearbeiten“ Name und Kontakt des Finders ein.</span></div>`;
    if (!l.length) return html + `<div class="empty">Keine Treffer.</div>`;
    html += `<div class="list">${l.map((f) => `<button class="row" data-act="openFinder" data-key="${esc(f.key)}">
      <span class="grow"><span class="t">${esc(f.name || '(ohne Name)')}</span><br>
      <span class="s">${esc(f.kontakte.join(' · ') || 'kein Kontakt')}</span><br>
      <span class="s">${f.igel.length} ${f.igel.length === 1 ? 'Igel' : 'Igel'} · zuletzt ${fmtD(f.letzter)}</span></span>
      <span class="r">${f.igel.length}</span><span class="chev">›</span></button>`).join('')}</div>
      <button class="btn secondary" data-act="finderCsv">📄 Finderliste als CSV (Excel/Numbers)</button>`;
    return html;
  }
  function viewFinder(key) {
    const f = finderList().find((x) => x.key === key);
    if (!f) { ui.route = { name: 'finderliste' }; return viewFinderListe(); }
    setHeader(f.name || 'Finder', { back: true, action: { label: 'Bearbeiten', fn: () => finderForm(f) } });
    return `
      <div class="card"><dl class="kv">
        <dt>Name</dt><dd>${esc(f.name || '–')}</dd>
        <dt>Kontakt</dt><dd>${f.kontakte.length ? kontaktLinks(f.kontakte) : '–'}</dd>
        <dt>Igel gebracht</dt><dd>${f.igel.length}</dd>
        <dt>Zuletzt</dt><dd>${fmtD(f.letzter)}</dd>
      </dl></div>
      <div class="section-title">Gefundene Igel (${f.igel.length})</div>
      <div class="list">${f.igel.map((i) => {
        const p = titlePhoto(i);
        return `<button class="row" data-act="open" data-id="${i.id}">
          ${p ? `<img class="thumb" src="${photoUrl(p)}" alt="">` : '<span class="thumb">🦔</span>'}
          <span class="grow"><span class="t">${esc(igelName(i))}</span> <span class="chip ${i.status}">${esc(STATUS_L[i.status] || '')}</span><br>
          <span class="s">${[i.nummer ? `Nr. ${esc(i.nummer)}` : '', `gefunden ${fmtD(i.fundDatum || i.aufnahmeDatum)}`, i.fundOrt ? esc(i.fundOrt) : ''].filter(Boolean).join(' · ')}</span>
          ${!ACTIVE.has(i.status) && (i.abgangDatum || i.abgangOrt) ? `<br><span class="s">${esc(STATUS_L[i.status])} ${fmtD(i.abgangDatum)}${i.abgangOrt ? ' · ' + esc(i.abgangOrt) : ''}</span>` : ''}</span>
          <span class="chev">›</span></button>`;
      }).join('')}</div>`;
  }
  // Änderungen am Finder werden in alle zugehörigen Igel übernommen
  function finderForm(f) {
    openForm({
      title: 'Finder bearbeiten',
      groups: [[{ key: 'name', label: 'Name' }, { key: 'kontakt', label: 'Kontakt (Telefon / E-Mail, mehrere mit Komma trennen)', type: 'tel' }]],
      values: { name: f.name, kontakt: f.kontakte.join(', ') },
      onSave: async (v) => {
        if (!v.name && !v.kontakt) { toast('Bitte Name oder Kontakt angeben.'); return false; }
        for (const i of f.igel) await save('igel', { ...i, finderName: v.name, finderKontakt: v.kontakt });
        ui.route = { name: 'finder', key: finderKey({ finderName: v.name, finderKontakt: v.kontakt }) };
        toast(`Bei ${f.igel.length} Igel aktualisiert`); return true;
      }
    });
  }
  function finderCsv() {
    const l = finderList(); if (!l.length) { toast('Keine Finder vorhanden.'); return; }
    const rows = [['Name', 'Kontakt', 'Anzahl Igel', 'Igel', 'Fundorte', 'Zuletzt']];
    for (const f of l) rows.push([f.name, f.kontakte.join(', '), f.igel.length, f.igel.map((i) => (i.nummer ? `${i.nummer} ` : '') + igelName(i)).join(', '),
      [...new Set(f.igel.map((i) => i.fundOrt).filter(Boolean))].join(', '), fmtD(f.letzter)]);
    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
    readySheet('CSV bereit', new Blob([csv], { type: 'text/csv;charset=utf-8' }), `igelpflege-finder-${today()}.csv`, `${l.length} Finder · öffnet in Excel oder Numbers`);
  }

  // ---------- Ansicht: Statistik ----------
  function statYears() {
    const ys = new Set(D.igel.map((i) => (i.aufnahmeDatum || '').slice(0, 4)).filter(Boolean));
    D.tierarzt.forEach((v) => v.datum && ys.add(v.datum.slice(0, 4)));
    ys.add(String(new Date().getFullYear()));
    return [...ys].sort().reverse();
  }
  function statData(J) {
    const inJ = (s) => J === 'alle' || String(s || '').startsWith(J);
    const igel = D.igel.filter((i) => inJ(i.aufnahmeDatum));
    const cnt = (s) => igel.filter((i) => i.status === s).length;
    const aus = cnt('ausgewildert'), weiter = cnt('weitergegeben'), tot = cnt('verstorben');
    const abg = aus + weiter + tot;
    const dauern = igel.filter((i) => !ACTIVE.has(i.status) && i.abgangDatum).map(inCareDays).filter((x) => x != null);
    const aufnG = igel.map((i) => firstWeight(i.id)).filter(Boolean).map((w) => w.gramm);
    const visits = D.tierarzt.filter((v) => inJ(v.datum));
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    const monate = Array(12).fill(0); igel.forEach((i) => { const m = parseD(i.aufnahmeDatum); if (m) monate[m.getMonth()]++; });
    return {
      igel, aufnahmen: igel.length, aktiv: igel.filter((i) => ACTIVE.has(i.status)).length, winter: cnt('winterschlaf'),
      aus, weiter, tot, abg, quoteAus: abg ? aus / abg * 100 : null, quoteTot: abg ? tot / abg * 100 : null,
      dauer: avg(dauern), aufnG: avg(aufnG),
      m: igel.filter((i) => i.geschlecht === 'm').length, w: igel.filter((i) => i.geschlecht === 'w').length,
      besuche: visits.length, kosten: visits.reduce((s, v) => s + (v.kosten || 0), 0), monate
    };
  }
  function viewStatistik() {
    setHeader('Statistik', { back: true });
    const years = statYears();
    if (!ui.statJahr || (ui.statJahr !== 'alle' && !years.includes(ui.statJahr))) ui.statJahr = years[0];
    const J = ui.statJahr; const s = statData(J);
    const tile = (v, l, cls = '') => `<div class="stat"><div class="v ${cls}">${v}</div><div class="l">${l}</div></div>`;
    const mn = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    const mx = Math.max(1, ...s.monate);
    const bars = `<svg class="chart" viewBox="0 0 340 130" role="img" aria-label="Aufnahmen pro Monat">${s.monate.map((n, k) => {
      const h = n / mx * 90; const x = 8 + k * 27.5;
      return `<rect x="${x}" y="${104 - h}" width="20" height="${h}" rx="3" class="bar"/>${n ? `<text x="${x + 10}" y="${100 - h}" text-anchor="middle">${n}</text>` : ''}<text x="${x + 10}" y="122" text-anchor="middle">${mn[k]}</text>`;
    }).join('')}</svg>`;
    return `
      <div class="seg seg-scroll">${[...years, 'alle'].map((y) => `<button data-act="statJahr" data-v="${y}" class="${J === y ? 'active' : ''}">${y === 'alle' ? 'Gesamt' : y}</button>`).join('')}</div>
      <div class="section-title">Aufnahmen ${J === 'alle' ? 'gesamt' : J}</div>
      <div class="card"><div class="stats" style="margin-top:0">
        ${tile(s.aufnahmen, 'Aufnahmen')}${tile(s.aktiv, 'noch in Pflege')}${tile(s.winter, 'im Winterschlaf')}
        ${tile(s.aus, 'ausgewildert', 'up')}${tile(s.weiter, 'weitergegeben')}${tile(s.tot, 'verstorben', s.tot ? 'down' : '')}
        ${tile(s.quoteAus != null ? fmtNum(s.quoteAus) + ' %' : '–', 'ausgewildert*')}${tile(s.dauer != null ? fmtNum(s.dauer) + ' T' : '–', 'Ø Pflegedauer*')}${tile(s.aufnG != null ? fmtNum(s.aufnG) + ' g' : '–', 'Ø Aufnahmegewicht')}
        ${tile(s.w, 'weiblich')}${tile(s.m, 'männlich')}${tile(s.aufnahmen - s.w - s.m, 'unbekannt')}
      </div><p class="note" style="margin-bottom:0">* bezogen auf abgeschlossene Fälle (${s.abg})</p></div>
      ${J !== 'alle' || s.aufnahmen ? `<div class="section-title">Aufnahmen pro Monat</div><div class="card">${bars}</div>` : ''}
      <div class="section-title">Tierarzt ${J === 'alle' ? 'gesamt' : J}</div>
      <div class="card"><div class="stats" style="margin-top:0">
        ${tile(s.besuche, 'Besuche')}${tile(fmtNum(s.kosten, 2) + ' €', 'Kosten')}${tile(s.besuche ? fmtNum(s.kosten / s.besuche, 2) + ' €' : '–', 'Ø pro Besuch')}
      </div></div>
      <button class="btn secondary" data-act="csv">📄 Igel-Liste ${J === 'alle' ? 'gesamt' : J} als CSV (Excel/Numbers)</button>`;
  }
  function csvCell(v) {
    let s = typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v ?? '');
    s = s.replace(/−/g, '-');
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function csvExport(J) {
    const s = statData(J);
    if (!s.igel.length) { toast('Keine Igel in diesem Zeitraum.'); return; }
    const rows = [['Pflege-Nr.', 'Name', 'Box', 'Status', 'Geschlecht', 'Alter', 'Aufnahme', 'Abgang', 'Tage in Pflege', 'Gewicht Aufnahme (g)', 'Gewicht zuletzt (g)', 'Winterschlaf von', 'Winterschlaf bis', 'Fundort', 'Finder', 'Kontakt Finder', 'Verbleib', 'Tierarztbesuche', 'Tierarztkosten (EUR)']];
    s.igel.slice().sort((a, b) => (a.aufnahmeDatum || '').localeCompare(b.aufnahmeDatum || '')).forEach((i) => {
      const fw = firstWeight(i.id), lw = lastWeight(i.id); const v = byIgel('tierarzt', i.id);
      rows.push([i.nummer, i.name, i.box, STATUS_L[i.status], label(GESCHLECHT, i.geschlecht), label(ALTER, i.alter), fmtD(i.aufnahmeDatum), fmtD(i.abgangDatum),
        inCareDays(i) ?? '', fw ? fw.gramm : '', lw ? lw.gramm : '', fmtD(i.winterschlafBeginn), fmtD(i.winterschlafEnde),
        i.fundOrt, i.finderName, i.finderKontakt, i.abgangOrt, v.length, v.reduce((x, y) => x + (y.kosten || 0), 0)]);
    });
    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
    readySheet('CSV bereit', new Blob([csv], { type: 'text/csv;charset=utf-8' }), `igelpflege-${J === 'alle' ? 'gesamt' : J}.csv`, `${s.igel.length} Igel · Semikolon-getrennt, öffnet direkt in Excel oder Numbers`);
  }

  // ---------- Ansicht: Einstellungen ----------
  function viewSettings() {
    setHeader('Einstellungen');
    const counts = DATA_STORES.reduce((a, s) => ((a[s] = D[s].length), a), {});
    return `
      <button class="btn secondary" data-act="statistik" style="margin-top:4px">📊 Jahresstatistik</button>
      <div class="section-title">Listen</div>
      <div class="list">
        <button class="row" data-act="medliste"><span class="grow"><span class="t">💊 Medikamentenliste</span><br><span class="s">Vorlagen mit Dosis, Verabreichung, Dauer</span></span><span class="r">${S.medListe.length}</span><span class="chev">›</span></button>
        <button class="row" data-act="futterliste"><span class="grow"><span class="t">🍽️ Futterliste</span><br><span class="s">Futtersorten mit Standardmenge</span></span><span class="r">${S.futterListe.length}</span><span class="chev">›</span></button>
        <button class="row" data-act="finderliste"><span class="grow"><span class="t">👤 Finderliste</span><br><span class="s">Alle Finder mit Kontakt und ihren Igeln</span></span><span class="r">${finderList().length}</span><span class="chev">›</span></button>
      </div>
      <div class="section-title">Pflegestelle (erscheint im PDF)</div>
      <div class="form">
        <label class="field"><span>Name der Pflegestelle</span><input id="s_pflegestelle" value="${esc(S.pflegestelle)}"></label>
        <label class="field"><span>Ansprechpartner</span><input id="s_ansprechpartner" value="${esc(S.ansprechpartner)}"></label>
        <label class="field"><span>Kontakt (Telefon / E-Mail)</span><input id="s_kontakt" value="${esc(S.kontakt)}"></label>
      </div>
      <div class="section-title">Gewicht & Erinnerungen</div>
      <div class="form">
        <label class="field"><span>Zielgewicht in g (Linie im Diagramm, leer = keine)</span><input id="s_zielgewicht" inputmode="numeric" value="${esc(S.zielgewicht ?? '')}"></label>
        <label class="field"><span>Wiegen fällig nach … Tagen</span><input id="s_wiegenTage" inputmode="numeric" value="${esc(S.wiegenTage)}"></label>
        <label class="field"><span>Im Winterschlaf: Wiegen fällig nach … Tagen</span><input id="s_wiegenTageWinter" inputmode="numeric" value="${esc(S.wiegenTageWinter)}"></label>
      </div>
      <div class="section-title">Gewichtsalarm</div>
      <div class="form">
        <label class="field"><span>Alarm ab Gewichtsverlust von … % (leer = aus)</span><input id="s_alarmProzent" inputmode="decimal" value="${esc(S.alarmProzent ?? '')}"></label>
        <label class="field"><span>… innerhalb von … Tagen</span><input id="s_alarmTage" inputmode="numeric" value="${esc(S.alarmTage)}"></label>
      </div>
      <p class="note">Zusätzlich gibt es immer Alarm, wenn ein Igel 2× in Folge abnimmt. Igel im Winterschlaf sind ausgenommen.</p>
      <button class="btn" data-act="saveSettings">Einstellungen speichern</button>

      <div class="section-title">Datensicherung</div>
      <div class="card">
        <p class="note" style="margin-top:0">Alle Daten liegen nur auf diesem Gerät. Wird die App vom Home-Bildschirm entfernt, sind die Daten weg. Sichere regelmäßig ein Backup, z. B. in „Dateien“ / iCloud Drive.</p>
        <p class="note">Letztes Backup: <strong>${S.lastBackup ? fmtD(S.lastBackup) : 'noch keins'}</strong></p>
        <div class="btn-row">
          <button class="btn" data-act="backup">💾 Backup erstellen</button>
          <button class="btn secondary" data-act="restore">Backup einspielen</button>
        </div>
        <input type="file" id="restoreFile" accept=".json,application/json" hidden>
      </div>

      <div class="section-title">Speicher</div>
      <div class="card"><dl class="kv">
        <dt>Igel</dt><dd>${counts.igel}</dd><dt>Wiegungen</dt><dd>${counts.gewichte}</dd><dt>Fotos</dt><dd>${counts.fotos}</dd>
        <dt>Medikationen / Gaben</dt><dd>${counts.medikation} / ${counts.gaben}</dd><dt>Kotproben</dt><dd>${counts.befunde}</dd>
        <dt>Tierarztbesuche</dt><dd>${counts.tierarzt}</dd><dt>Fütterungen</dt><dd>${counts.futter}</dd>
        <dt>Belegt</dt><dd id="storageUsed">…</dd><dt>Dauerhaft</dt><dd id="storagePersist">…</dd>
      </dl></div>

      <div class="section-title">Gefahrenzone</div>
      <button class="btn danger" data-act="wipe">Alle Daten löschen</button>
      <p class="note" style="text-align:center;margin-top:20px">Igelpflege ${VERSION} · Daten verlassen dieses Gerät nur, wenn du sie selbst teilst.</p>`;
  }
  async function fillStorageInfo() {
    try {
      if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); const el = $('#storageUsed'); if (el) el.textContent = `${fmtNum((e.usage || 0) / 1048576, 1)} MB`; }
      const p = navigator.storage?.persisted ? await navigator.storage.persisted() : null; const el2 = $('#storagePersist'); if (el2) el2.textContent = p == null ? 'unbekannt' : p ? 'ja' : 'nein (Backup wichtig)';
    } catch (e) { /* ignorieren */ }
  }

  // ---------- Sheet / Formulare ----------
  function openSheet({ title, body, saveLabel = 'Sichern', onSave = null, cancelLabel = 'Abbrechen', onOpen = null }) {
    const sh = $('#sheet');
    sh.innerHTML = `<div class="sheet-head"><button class="cancel" data-sheet="cancel">${esc(cancelLabel)}</button><h3>${esc(title)}</h3>${onSave ? `<button class="save" data-sheet="save">${esc(saveLabel)}</button>` : ''}</div>${body}`;
    const wasOpen = !sh.hidden;
    sh.hidden = false; $('#sheetBackdrop').hidden = false;
    if (!wasOpen) lockBody();
    sh.scrollTop = 0;
    sh._onSave = onSave;
    fitSheet();
    if (onOpen) onOpen(sh);
  }
  function closeSheet() {
    const sh = $('#sheet');
    if (document.activeElement && sh.contains(document.activeElement)) document.activeElement.blur();
    sh.hidden = true; sh.innerHTML = ''; sh._onSave = null; sh._onDelete = null; sh._share = null; sh._backup = null;
    sh.style.top = ''; sh.style.height = '';
    $('#sheetBackdrop').hidden = true;
    unlockBody();
  }
  // iOS: Seite hinter dem Formular festhalten, damit sie beim Öffnen der Tastatur nicht verrutscht
  let lockedScrollY = 0;
  function lockBody() {
    lockedScrollY = window.scrollY || 0;
    document.body.style.top = `-${lockedScrollY}px`;
    document.body.classList.add('sheet-open');
  }
  function unlockBody() {
    if (!document.body.classList.contains('sheet-open')) return;
    document.body.classList.remove('sheet-open');
    document.body.style.top = '';
    window.scrollTo(0, lockedScrollY);
  }
  // Formular immer exakt in den sichtbaren Bereich legen (oberhalb der Tastatur)
  function fitSheet() {
    const sh = $('#sheet'); if (!sh || sh.hidden) return;
    const vv = window.visualViewport;
    if (vv) { sh.style.top = `${Math.max(0, vv.offsetTop)}px`; sh.style.height = `${vv.height}px`; }
  }
  function revealField(el) {
    const sh = $('#sheet'); if (!el || !sh.contains(el)) return;
    setTimeout(() => {
      fitSheet();
      const head = $('.sheet-head', sh); const headH = head ? head.offsetHeight : 0;
      const r = el.getBoundingClientRect(); const sr = sh.getBoundingClientRect();
      const top = r.top - sr.top; const visible = sh.clientHeight;
      if (top < headH + 8 || r.bottom - sr.top > visible - 12) sh.scrollTop += top - headH - Math.max(40, (visible - headH - r.height) / 3);
    }, 350);
  }

  function fieldHtml(f, v) {
    const id = 'f_' + f.key;
    const req = f.required ? ' <span class="req">*</span>' : '';
    const val = v ?? f.default ?? '';
    let input;
    switch (f.type) {
      case 'textarea': input = `<textarea id="${id}" rows="3">${esc(val)}</textarea>`; break;
      case 'pick': input = `<select id="${id}" data-pick="${esc(f.pick)}"><option value="">– auswählen –</option>${f.options.map((o) => `<option value="${esc(o.v)}">${esc(o.l)}</option>`).join('')}</select>`; break;
      case 'select': input =`<select id="${id}">${f.options.map((o) => `<option value="${esc(o.v)}"${String(o.v) === String(val) ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`; break;
      case 'checks': {
        const arr = Array.isArray(val) ? val : [];
        input = `<div class="checks" id="${id}">${f.options.map((o) => {
          const ov = typeof o === 'object' ? o.v : o; const ol = typeof o === 'object' ? o.l : o;
          return `<label><input type="checkbox" value="${esc(ov)}"${arr.includes(ov) ? ' checked' : ''}>${esc(ol)}</label>`;
        }).join('')}</div>`; break;
      }
      case 'number': input = `<input id="${id}" type="text" inputmode="decimal" value="${esc(val === '' || val == null ? '' : String(val).replace('.', ','))}" placeholder="${esc(f.placeholder || '')}">`; break;
      case 'date': input = `<input id="${id}" type="date" value="${esc(val)}">`; break;
      case 'datetime': input = `<input id="${id}" type="datetime-local" value="${esc(val)}">`; break;
      default: input = `<input id="${id}" type="${f.type === 'tel' ? 'tel' : 'text'}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"${f.list ? ` list="${id}_l"` : ''} autocomplete="off">${f.list ? `<datalist id="${id}_l">${f.list.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>` : ''}`;
    }
    return `<label class="field"><span>${esc(f.label)}${req}</span>${input}</label>`;
  }
  function readField(f) {
    const el = $('#f_' + f.key);
    if (!el) return undefined;
    if (f.type === 'checks') return $$('input:checked', el).map((x) => x.value);
    if (f.type === 'number') return num(el.value);
    return el.value.trim();
  }
  function openForm({ title, groups, values = {}, onSave, onDelete = null, deleteLabel = 'Eintrag löschen' }) {
    const allFields = groups.flat();
    const body = groups.map((g) => `<div class="form">${g.map((f) => fieldHtml(f, values[f.key])).join('')}</div>`).join('') +
      `<button class="btn btn-save-bottom" data-sheet="save">Sichern</button>` +
      (onDelete ?`<button class="btn danger" data-sheet="delete">${esc(deleteLabel)}</button>` : '');
    openSheet({
      title, body,
      onSave: async () => {
        const out = {};
        for (const f of allFields) out[f.key] = readField(f);
        for (const f of allFields) {
          if (f.required && (out[f.key] === null || out[f.key] === '' || (Array.isArray(out[f.key]) && !out[f.key].length))) { toast(`Bitte „${f.label}“ ausfüllen.`); return false; }
        }
        return onSave(out);
      },
      onOpen: (sh) => { sh._onDelete = onDelete; }
    });
  }

  // ---------- Formulare: Igel ----------
  // Nächste freie Pflege-Nr.: letzte vergebene Nummer (zuletzt angelegter Igel) + 1.
  // Präfix, Suffix und führende Nullen bleiben erhalten: "2026-14" → "2026-15", "007" → "008".
  function nextNummer() {
    const withNr = D.igel
      .filter((x) => /\d/.test(String(x.nummer || '')))
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    if (!withNr.length) return '1';
    const last = String(withNr[withNr.length - 1].nummer).trim();
    const m = last.match(/^(.*?)(\d+)(\D*)$/);
    if (!m) return '1';
    const used = new Set(D.igel.map((x) => String(x.nummer || '').trim()));
    let n = parseInt(m[2], 10); const width = m[2].length; let cand;
    do { n++; cand = m[1] + String(n).padStart(width, '0') + m[3]; } while (used.has(cand));
    return cand;
  }
  function igelForm(i = null) {
    const isNew = !i;
    const groups = [
      [{ key: 'name', label: 'Name / Rufname' }, { key: 'nummer', label: isNew ? 'Pflege-Nr. (automatisch, änderbar)' : 'Pflege-Nr.', default: isNew ? nextNummer() : '' },
       { key: 'box', label: 'Box / Gehege' },
       { key: 'status', label: 'Status', type: 'select', options: opts(STATUS), default: 'aufnahme' },
       { key: 'geschlecht', label: 'Geschlecht', type: 'select', options: opts(GESCHLECHT), default: 'unbekannt' },
       { key: 'alter', label: 'Alter', type: 'select', options: opts(ALTER), default: 'unbekannt' }],
      [{ key: 'aufnahmeDatum', label: 'Aufnahme am', type: 'date', required: true, default: today() },
       ...(isNew ? [{ key: 'aufnahmeGewicht', label: 'Gewicht bei Aufnahme (g)', type: 'number', placeholder: 'z. B. 380' }] : []),
       { key: 'zustand', label: 'Zustand bei Aufnahme', type: 'textarea' }],
      [{ key: 'fundDatum', label: 'Fund am', type: 'date' }, { key: 'fundOrt', label: 'Fundort' },
       { key: 'fundUmstaende', label: 'Fundumstände', type: 'textarea' },
       ...(finderList().length ? [{ key: 'vorlage', label: 'Bekannten Finder wählen', type: 'pick', pick: 'finder', options: finderList().map((f) => ({ v: f.key, l: (f.name || '(ohne Name)') + (f.kontakte[0] ? ` – ${f.kontakte[0]}` : '') })) }] : []),
       { key: 'finderName', label: 'Finder (Name)' }, { key: 'finderKontakt', label: 'Kontakt Finder (Telefon / E-Mail)', type: 'tel' }],
      [{ key: 'winterschlafBeginn', label: 'Winterschlaf Beginn (wird bei Status „Winterschlaf“ automatisch gesetzt)', type: 'date' },
       { key: 'winterschlafEnde', label: 'Winterschlaf Ende / aufgewacht', type: 'date' }],
      [{ key: 'abgangDatum', label: 'Abgang am (Auswilderung / Weitergabe / Tod)', type: 'date' }, { key: 'abgangOrt', label: 'Verbleib / Auswilderungsort' },
       { key: 'notizen', label: 'Notizen', type: 'textarea' }]
    ];
    openForm({
      title: isNew ? 'Igel aufnehmen' : 'Igel bearbeiten', groups, values: i || {},
      onSave: async (v) => {
        if (!v.name && !v.nummer) { toast('Bitte Name oder Pflege-Nr. angeben.'); return false; }
        const doppelt = v.nummer && D.igel.find((x) => x.id !== i?.id && String(x.nummer || '').trim() === v.nummer);
        if (doppelt) { toast(`Pflege-Nr. ${v.nummer} ist schon an „${igelName(doppelt)}“ vergeben.`, 3500); return false; }
        const obj = { ...(i || {}), ...v };
        delete obj.aufnahmeGewicht; delete obj.vorlage;
        if (!ACTIVE.has(obj.status) && !obj.abgangDatum) obj.abgangDatum = today();
        const prevStatus = i ? i.status : null;
        if (obj.status === 'winterschlaf' && prevStatus !== 'winterschlaf' && !obj.winterschlafBeginn) obj.winterschlafBeginn = today();
        if (prevStatus === 'winterschlaf' && obj.status !== 'winterschlaf' && obj.winterschlafBeginn && !obj.winterschlafEnde) obj.winterschlafEnde = today();
        if (obj.winterschlafBeginn && obj.winterschlafEnde && obj.winterschlafEnde < obj.winterschlafBeginn) { toast('Winterschlaf-Ende liegt vor dem Beginn.'); return false; }
        await save('igel', obj);
        if (isNew && v.aufnahmeGewicht) await save('gewichte', { igelId: obj.id, datum: `${v.aufnahmeDatum}T${nowDT().slice(11)}`, gramm: v.aufnahmeGewicht, notiz: 'Aufnahme' });
        toast(isNew ? 'Igel aufgenommen' : 'Gespeichert');
        if (isNew) { closeSheet(); go({ name: 'detail', id: obj.id }); return 'handled'; }
        return true;
      },
      onDelete: isNew ? null : () => confirmDeleteIgel(i.id), deleteLabel: 'Igel löschen'
    });
  }
  async function confirmDeleteIgel(id) {
    const i = igelById(id);
    if (!confirm(`„${igelName(i)}“ mit allen Wiegungen, Fotos, Medikationen und Einträgen endgültig löschen?`)) return false;
    await deleteIgel(id); closeSheet(); toast('Igel gelöscht'); go({ name: 'list' }, { keepPrev: true }); return 'handled';
  }

  // ---------- Formulare: Gewicht ----------
  function weightForm(igelId, w = null) {
    openForm({
      title: w ? 'Wiegung bearbeiten' : `Wiegen – ${igelName(igelById(igelId))}`,
      groups: [[{ key: 'gramm', label: 'Gewicht (g)', type: 'number', required: true, placeholder: lastWeight(igelId) ? `zuletzt ${fmtNum(lastWeight(igelId).gramm)} g` : 'z. B. 450' },
        { key: 'datum', label: 'Zeitpunkt', type: 'datetime', required: true, default: nowDT() }, { key: 'notiz', label: 'Notiz' }]],
      values: w || {},
      onSave: async (v) => {
        if (v.gramm <= 0 || v.gramm > 3000) { toast('Gewicht unplausibel – bitte prüfen.'); return false; }
        await save('gewichte', { ...(w || { igelId }), ...v }); toast('Gewicht gespeichert'); return true;
      },
      onDelete: w ? async () => { if (!confirm('Wiegung löschen?')) return false; await remove('gewichte', w.id); return true; } : null
    });
    setTimeout(() => { const el = $('#f_gramm'); if (el && !w) el.focus(); }, 250);
  }

  // ---------- Formulare: Medikation ----------
  const byName = (l) => (l || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const listHas = (l, name) => (l || []).some((x) => x.name.trim().toLowerCase() === String(name || '').trim().toLowerCase());
  function medPickField() {
    return S.medListe.length
      ? [{ key: 'vorlage', label: 'Aus Medikamentenliste wählen', type: 'pick', pick: 'med', options: byName(S.medListe).map((x) => ({ v: x.id, l: x.name + (x.dosis ? ` – ${x.dosis}` : '') })) }]
      : [];
  }
  function futterPickField() {
    return S.futterListe.length
      ? [{ key: 'vorlage', label: 'Aus Futterliste wählen', type: 'pick', pick: 'futter', options: byName(S.futterListe).map((x) => ({ v: x.id, l: x.name + (x.menge != null ? ` – ${fmtNum(x.menge)} g` : '') })) }]
      : [];
  }
  const merkenField = (txt) => ({ key: 'merken', label: 'Liste', type: 'checks', options: [{ v: 'ja', l: txt }] });
  // Ausgewählten Listeneintrag in die Formularfelder übernehmen (Felder bleiben änderbar)
  function applyPick(kind, id) {
    const set = (k, v) => { const el = $('#f_' + k); if (!el || v === undefined) return; el.value = v == null ? '' : (typeof v === 'number' ? String(v).replace('.', ',') : v); };
    if (kind === 'med') {
      const m = S.medListe.find((x) => x.id === id); if (!m) return;
      set('mittel', m.name); set('dosis', m.dosis || ''); set('applikation', m.applikation || 'oral'); set('proTag', m.proTag || 1); set('tage', m.tage ?? null);
      if (m.hinweis) toast(`Hinweis: ${m.hinweis}`, 5000);
    }
    if (kind === 'futter') {
      const f = S.futterListe.find((x) => x.id === id); if (!f) return;
      set('futter', f.name); if (f.menge != null) set('menge', f.menge);
    }
    if (kind === 'finder') {
      const f = finderList().find((x) => x.key === id); if (!f) return;
      set('finderName', f.name); set('finderKontakt', f.kontakte.join(', '));
    }
  }
  async function addToList(listKey, item) {
    if (!item.name || listHas(S[listKey], item.name)) return false;
    S[listKey].push({ id: uid(), updatedAt: new Date().toISOString(), ...item }); await saveSettings(); return true;
  }

  function medForm(igelId, m = null) {
    openForm({
      title: m ? 'Medikation bearbeiten' : 'Neue Medikation',
      groups: [
        [...medPickField(), { key: 'mittel', label: 'Medikament', required: true }, { key: 'grund', label: 'Grund / Indikation' },
         { key: 'dosis', label: 'Dosis', required: true, placeholder: 'z. B. 0,1 ml' },
         { key: 'applikation', label: 'Verabreichung', type: 'select', options: opts(APPLIKATION), default: 'oral' },
         { key: 'proTag', label: 'Gaben pro Tag', type: 'number', required: true, default: 1 }],
        [{ key: 'start', label: 'Beginn', type: 'date', required: true, default: today() },
         { key: 'tage', label: 'Dauer in Tagen (leer = bis abgesetzt)', type: 'number' },
         { key: 'abgesetzt', label: 'Vorzeitig abgesetzt am', type: 'date' },
         { key: 'verordnetVon', label: 'Verordnet von (Tierarzt)' }, { key: 'notiz', label: 'Notiz', type: 'textarea' }],
        ...(m ? [] : [[merkenField('Als Vorlage in die Medikamentenliste aufnehmen (falls neu)')]])
      ],
      values: m || {},
      onSave: async (v) => {
        v.proTag = Math.max(1, Math.round(v.proTag || 1)); if (v.tage != null) v.tage = Math.max(1, Math.round(v.tage));
        const merken = (v.merken || []).includes('ja'); delete v.merken; delete v.vorlage;
        await save('medikation', { ...(m || { igelId }), ...v });
        const neu = merken && await addToList('medListe', { name: v.mittel, dosis: v.dosis, applikation: v.applikation, proTag: v.proTag, tage: v.tage });
        toast(neu ? 'Medikation gespeichert · in Liste aufgenommen' : 'Medikation gespeichert'); return true;
      },
      onDelete: m ? async () => {
        if (!confirm('Medikation inkl. aller eingetragenen Gaben löschen?')) return false;
        await removeMany('gaben', D.gaben.filter((g) => g.medId === m.id).map((g) => g.id)); await remove('medikation', m.id); return true;
      } : null
    });
  }
  async function give(medId) {
    const m = D.medikation.find((x) => x.id === medId); if (!m) return;
    await save('gaben', { igelId: m.igelId, medId, zeit: nowDT() });
    toast(`${m.mittel} eingetragen`); render();
  }
  async function undoGive(medId) {
    const g = gabenOn(medId, today()); if (!g.length) return;
    await remove('gaben', g[g.length - 1].id); toast('Letzte Gabe entfernt'); render();
  }

  // ---------- Formulare: Kotprobe ----------
  function befundForm(igelId, b = null) {
    openForm({
      title: b ? 'Kotprobe bearbeiten' : 'Neue Kotprobe',
      groups: [
        [{ key: 'datum', label: 'Datum', type: 'date', required: true, default: today() }, { key: 'untersucher', label: 'Untersucht von (Tierarzt / Labor / selbst)' }],
        [{ key: 'ergebnis', label: 'Befund', type: 'checks', options: PARASITEN }, { key: 'befall', label: 'Befallsgrad', type: 'select', options: opts(BEFALL) }],
        [{ key: 'kontrolleAm', label: 'Kontrolle geplant am', type: 'date' }, { key: 'notiz', label: 'Notiz', type: 'textarea' }]
      ],
      values: b || {},
      onSave: async (v) => { await save('befunde', { ...(b || { igelId }), ...v }); toast('Kotprobe gespeichert'); return true; },
      onDelete: b ? async () => { if (!confirm('Kotprobe löschen?')) return false; await remove('befunde', b.id); return true; } : null
    });
  }

  // ---------- Formulare: Tierarzt ----------
  function vetForm(igelId, v0 = null) {
    const lastPraxis = D.tierarzt.slice().sort((a, b) => b.datum.localeCompare(a.datum))[0]?.praxis || '';
    openForm({
      title: v0 ? 'Tierarztbesuch bearbeiten' : 'Tierarztbesuch',
      groups: [
        [{ key: 'datum', label: 'Datum', type: 'date', required: true, default: today() }, { key: 'praxis', label: 'Praxis / Tierarzt', default: v0 ? '' : lastPraxis },
         { key: 'grund', label: 'Grund des Besuchs', required: true }],
        [{ key: 'diagnose', label: 'Befund / Diagnose', type: 'textarea' }, { key: 'behandlung', label: 'Behandlung', type: 'textarea' }],
        [{ key: 'kosten', label: 'Kosten (€)', type: 'number' }, { key: 'naechsterTermin', label: 'Nächster Termin', type: 'date' }, { key: 'notiz', label: 'Notiz', type: 'textarea' }]
      ],
      values: v0 || {},
      onSave: async (v) => { await save('tierarzt', { ...(v0 || { igelId }), ...v }); toast('Tierarztbesuch gespeichert'); return true; },
      onDelete: v0 ? async () => { if (!confirm('Tierarztbesuch löschen?')) return false; await remove('tierarzt', v0.id); return true; } : null
    });
  }

  // ---------- Formulare: Futter ----------
  function futterForm(igelId, f = null) {
    const last = byIgel('futter', igelId).sort((a, b) => b.datum.localeCompare(a.datum))[0];
    openForm({
      title: f ? 'Fütterung bearbeiten' : `Fütterung – ${igelName(igelById(igelId))}`,
      groups: [[
        { key: 'datum', label: 'Zeitpunkt', type: 'datetime', required: true, default: nowDT() },
        ...futterPickField(),
        { key: 'futter', label: 'Futter', required: true, list: S.futterListe.map((x) => x.name), default: f ? '' : last?.futter || '' },
        { key: 'menge', label: 'Menge (g)', type: 'number', default: f ? '' : last?.menge ?? '' },
        { key: 'gefressen', label: 'Gefressen', type: 'select', options: opts(GEFRESSEN), default: 'offen' },
        { key: 'notiz', label: 'Notiz (Kot, Trinken, Auffälligkeiten)' }
      ], ...(f ? [] : [[merkenField('In die Futterliste aufnehmen (falls neu)')]])],
      values: f || {},
      onSave: async (v) => {
        const merken = (v.merken || []).includes('ja'); delete v.merken; delete v.vorlage;
        await save('futter', { ...(f || { igelId }), ...v });
        const neu = merken && await addToList('futterListe', { name: v.futter, menge: v.menge });
        toast(neu ? 'Fütterung gespeichert · in Liste aufgenommen' : 'Fütterung gespeichert'); return true;
      },
      onDelete: f ? async () => { if (!confirm('Eintrag löschen?')) return false; await remove('futter', f.id); return true; } : null
    });
  }

  // ---------- Schnellerfassung: Alle wiegen ----------
  function bulkWeighSheet() {
    const list = D.igel.filter((i) => ACTIVE.has(i.status)).sort(byBox);
    if (!list.length) { toast('Keine Igel in Pflege.'); return; }
    const t = today();
    const body = `
      <div class="form"><label class="field"><span>Zeitpunkt (für alle)</span><input id="bw_datum" type="datetime-local" value="${nowDT()}"></label></div>
      <p class="note">Gewicht eintippen – „Weiter“ springt zum nächsten Igel. Leere Felder werden übersprungen.</p>
      <div class="form">${list.map((i, k) => {
        const lw = lastWeight(i.id); const heute = lw && dayOf(lw.datum) === t;
        return `<label class="field"><span>${esc(igelName(i))}${i.box ? ` · Box ${esc(i.box)}` : ''}${i.status === 'winterschlaf' ? ' · 💤' : ''}${lw ? ` · zuletzt ${fmtNum(lw.gramm)} g (${heute ? 'heute' : fmtShort(lw.datum)})` : ' · noch nie gewogen'}</span>
          <span class="bulk-in"><input data-bw="${i.id}" data-last="${lw ? lw.gramm : ''}" inputmode="decimal" enterkeyhint="${k < list.length - 1 ? 'next' : 'done'}" placeholder="Gewicht in g" autocomplete="off"><em class="bw-diff"></em></span></label>`;
      }).join('')}</div>
      <button class="btn btn-save-bottom" data-sheet="save">Alle sichern</button>`;
    openSheet({
      title: 'Alle wiegen', body,
      onSave: async () => {
        const datum = $('#bw_datum').value || nowDT();
        const vals = [];
        for (const el of $$('[data-bw]')) {
          const g = num(el.value); if (g == null) continue;
          if (g <= 0 || g > 3000) { toast(`Gewicht bei „${igelName(igelById(el.dataset.bw))}“ unplausibel.`); el.focus(); return false; }
          vals.push({ igelId: el.dataset.bw, gramm: g });
        }
        if (!vals.length) { toast('Kein Gewicht eingetragen.'); return false; }
        for (const v of vals) await save('gewichte', { ...v, datum });
        const alarme = vals.map((v) => igelById(v.igelId)).filter((i) => weightAlarm(i)).length;
        toast(`${vals.length} ${vals.length === 1 ? 'Gewicht' : 'Gewichte'} gespeichert${alarme ? ` · ⚠️ ${alarme}× Gewichtsalarm` : ''}`, alarme ? 4000 : 2200);
        return true;
      }
    });
  }
  function updateBulkDiff(el) {
    const em = el.parentElement.querySelector('.bw-diff'); const g = num(el.value); const last = num(el.dataset.last);
    if (g == null || last == null) { em.textContent = ''; em.className = 'bw-diff'; return; }
    const d = g - last; em.textContent = `${signed(d)} g`; em.className = 'bw-diff ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
  }

  // ---------- Schnellerfassung: Alle füttern ----------
  function bulkFeedSheet() {
    const list = D.igel.filter((i) => ACTIVE.has(i.status) && i.status !== 'winterschlaf').sort(byBox);
    if (!list.length) { toast('Keine Igel zum Füttern (Winterschlaf ausgenommen).'); return; }
    const lastF = D.futter.slice().sort((a, b) => b.datum.localeCompare(a.datum))[0];
    openForm({
      title: 'Alle füttern',
      groups: [
        [{ key: 'datum', label: 'Zeitpunkt', type: 'datetime', required: true, default: nowDT() },
         ...futterPickField(),
         { key: 'futter', label: 'Futter', required: true, list: S.futterListe.map((x) => x.name), default: lastF?.futter || '' },
         { key: 'menge', label: 'Menge pro Igel (g)', type: 'number', default: lastF?.menge ?? '' },
         { key: 'gefressen', label: 'Gefressen', type: 'select', options: opts(GEFRESSEN), default: 'offen' }],
        [{ key: 'igel', label: 'Gefüttert wurden', type: 'checks', required: true, options: list.map((i) => ({ v: i.id, l: igelName(i) + (i.box ? ` (Box ${i.box})` : '') })), default: list.map((i) => i.id) }],
        [merkenField('In die Futterliste aufnehmen (falls neu)')]
      ],
      onSave: async (v) => {
        for (const id of v.igel) await save('futter', { igelId: id, datum: v.datum, futter: v.futter, menge: v.menge, gefressen: v.gefressen });
        if ((v.merken || []).includes('ja')) await addToList('futterListe', { name: v.futter, menge: v.menge });
        toast(`Fütterung für ${v.igel.length} Igel eingetragen`); return true;
      }
    });
  }

  // ---------- Fotos ----------
  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Bild konnte nicht gelesen werden')); };
      img.src = url;
    });
  }
  function scaled(img, max, q) {
    const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * r); c.height = Math.round(img.naturalHeight * r);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? b.arrayBuffer().then((buf) => res({ buf, w: c.width, h: c.height })) : rej(new Error('Bild konnte nicht verarbeitet werden'))), 'image/jpeg', q));
  }
  function pickPhotos(igelId) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = async () => {
      const files = Array.from(inp.files || []); if (!files.length) return;
      toast('Fotos werden gespeichert …', 10000);
      let ok = 0;
      for (const file of files) {
        try {
          const img = await loadImage(file);
          const full = await scaled(img, 1600, 0.82); const thumb = await scaled(img, 360, 0.75);
          const datum = file.lastModified ? dtStr(new Date(file.lastModified)) : nowDT();
          await save('fotos', { igelId, datum, type: 'image/jpeg', full: full.buf, thumb: thumb.buf, w: full.w, h: full.h });
          ok++;
        } catch (e) { console.error(e); }
      }
      toast(ok === files.length ? `${ok} Foto${ok === 1 ? '' : 's'} gespeichert` : `${ok} von ${files.length} Fotos gespeichert`);
      render();
    };
    inp.click();
  }
  function photoSheet(fotoId) {
    const p = D.fotos.find((x) => x.id === fotoId); if (!p) return;
    const i = igelById(p.igelId);
    openSheet({
      title: fmtDT(p.datum) || 'Foto', cancelLabel: 'Schließen',
      body: `<img src="${photoUrl(p, true)}" alt="" style="width:100%;border-radius:14px;margin-bottom:12px">
        <div class="btn-row">
          <button class="btn secondary" data-sheet="photoTitle" data-id="${p.id}"${i && i.titelFotoId === p.id ? ' disabled' : ''}>Als Titelbild</button>
          <button class="btn secondary" data-sheet="photoShare" data-id="${p.id}">Teilen</button>
          <button class="btn danger" data-sheet="photoDel" data-id="${p.id}">Löschen</button>
        </div>`
    });
  }

  // ---------- Teilen / Speichern ----------
  async function shareFile(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return true; }
      catch (e) { if (e.name === 'AbortError') return false; console.warn(e); }
    }
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000); return true;
  }
  // iOS verlangt für "Teilen" einen direkten Tipp. Daher: erst Datei erzeugen, dann Teilen-Knopf anzeigen.
  function readySheet(title, blob, filename, info, after) {
    openSheet({
      title, cancelLabel: 'Schließen',
      body: `<div class="card"><p style="margin-top:0"><strong>${esc(filename)}</strong><br><span class="note">${esc(info)}</span></p>
        <button class="btn" data-sheet="share">Teilen / In Dateien sichern</button></div>`,
      onOpen: (sh) => { sh._share = async () => { const ok = await shareFile(blob, filename); if (ok && after) await after(); }; }
    });
  }

  // ---------- Backup ----------
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf); let bin = ''; const CH = 0x8000;
    for (let k = 0; k < bytes.length; k += CH) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + CH));
    return btoa(bin);
  }
  function b64ToBuf(b64) { const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k); return bytes.buffer; }
  async function makeBackup() {
    toast('Backup wird erstellt …', 10000);
    const data = {};
    for (const s of DATA_STORES) data[s] = s === 'fotos' ? D.fotos.map((p) => ({ ...p, full: bufToB64(p.full), thumb: bufToB64(p.thumb) })) : D[s];
    const settings = { ...S }; delete settings.lastBackup;
    const json = JSON.stringify({ app: 'igelpflege', format: 1, version: VERSION, exportedAt: new Date().toISOString(), settings, data });
    const blob = new Blob([json], { type: 'application/json' });
    $('#toast').hidden = true;
    readySheet('Backup bereit', blob, `igelpflege-backup-${today()}.json`, `${D.igel.length} Igel, ${D.fotos.length} Fotos · ${fmtNum(blob.size / 1048576, 1)} MB. Am besten in „Dateien“ → iCloud Drive sichern.`,
      async () => { S.lastBackup = today(); await saveSettings(); updateBadge(); });
  }
  async function restoreBackup(file) {
    let obj;
    try { obj = JSON.parse(await file.text()); } catch (e) { toast('Datei ist kein gültiges Backup.'); return; }
    if (!obj || obj.app !== 'igelpflege' || !obj.data) { toast('Datei ist kein Igelpflege-Backup.'); return; }
    const n = (obj.data.igel || []).length;
    openSheet({
      title: 'Backup einspielen',
      body: `<div class="card"><p style="margin-top:0"><strong>Backup vom ${fmtDT(dtStr(new Date(obj.exportedAt)))}</strong><br>
        <span class="note">${n} Igel · ${(obj.data.gewichte || []).length} Wiegungen · ${(obj.data.fotos || []).length} Fotos</span></p>
        <button class="btn" data-sheet="restoreMerge">Zusammenführen (empfohlen)</button>
        <p class="note">Neue Einträge aus dem Backup kommen dazu. Bei Einträgen, die es auf beiden Geräten gibt, gewinnt die neuere Änderung. Auf diesem Gerät gelöschte Einträge kommen wieder, wenn sie im Backup noch enthalten sind.</p>
        <button class="btn danger" data-sheet="restoreReplace">Alles ersetzen</button>
        <p class="note" style="margin-bottom:0">Alle Daten auf diesem Gerät werden gelöscht und durch das Backup ersetzt.</p></div>`,
      onOpen: (sh) => { sh._backup = obj; }
    });
  }
  async function applyBackup(obj, mode) {
    let added = 0, updated = 0, kept = 0;
    try {
      const t = db.transaction(STORES, 'readwrite');
      for (const s of DATA_STORES) {
        const os = t.objectStore(s);
        if (mode === 'replace') os.clear();
        const local = new Map(D[s].map((x) => [x.id, x]));
        for (const rec of obj.data[s] || []) {
          if (mode === 'merge') {
            const l = local.get(rec.id);
            if (l && (l.updatedAt || '') >= (rec.updatedAt || '')) { kept++; continue; }
            if (l) updated++; else added++;
          }
          os.put(s === 'fotos' ? { ...rec, full: b64ToBuf(rec.full), thumb: b64ToBuf(rec.thumb) } : rec);
        }
      }
      if (mode === 'merge' && obj.settings) {
        // Listen zusammenführen: gleiche ID → neuere Änderung gewinnt; gleicher Name → nicht doppelt anlegen
        const mergeList = (lokal, fremd) => {
          const out = (lokal || []).slice();
          for (const x of fremd || []) {
            const k = out.findIndex((y) => y.id === x.id);
            if (k >= 0) { if ((x.updatedAt || '') > (out[k].updatedAt || '')) out[k] = x; }
            else if (!listHas(out, x.name)) out.push(x);
          }
          return out;
        };
        t.objectStore('settings').put({ ...S, medListe: mergeList(S.medListe, obj.settings.medListe), futterListe: mergeList(S.futterListe, obj.settings.futterListe) });
      }
      if (mode === 'replace' && obj.settings) t.objectStore('settings').put({ ...DEFAULTS, ...obj.settings, id: 'main', lastBackup: dStr(new Date(obj.exportedAt)) });
      await txDone(t);
      for (const k of urlCache.keys()) URL.revokeObjectURL(urlCache.get(k)); urlCache.clear();
      await loadAll(); closeSheet();
      const nrs = D.igel.map((i) => String(i.nummer || '').trim()).filter(Boolean);
      const dup = nrs.length - new Set(nrs).size;
      toast(mode === 'merge' ? `Zusammengeführt: ${added} neu, ${updated} aktualisiert, ${kept} unverändert${dup ? ` · ⚠️ ${dup} doppelte Pflege-Nr. – bitte prüfen` : ''}` : 'Backup eingespielt', dup ? 6000 : 3500);
      go({ name: 'list' }, { keepPrev: true });
    } catch (e) { console.error(e); toast('Fehler beim Einspielen: ' + e.message, 5000); await loadAll(); render(); }
  }
  async function wipeAll() {
    if (!confirm('Wirklich ALLE Daten (Igel, Fotos, Protokolle) von diesem Gerät löschen?')) return;
    if (!confirm('Letzte Rückfrage: Das kann nicht rückgängig gemacht werden. Fortfahren?')) return;
    const t = db.transaction(STORES, 'readwrite'); STORES.forEach((s) => t.objectStore(s).clear()); await txDone(t);
    for (const k of urlCache.keys()) URL.revokeObjectURL(urlCache.get(k)); urlCache.clear();
    await loadAll(); toast('Alle Daten gelöscht'); go({ name: 'list' }, { keepPrev: true });
  }

  // ---------- PDF ----------
  // PDF-Standardschrift kennt kein typografisches Minus: ersetzen
  const pdfTxt = (s) => String(s ?? '').replace(/−/g, '-').replace(/→/g, '->');
  function autoTable(doc, o) {
    for (const k of ['head', 'body', 'foot']) if (o[k]) o[k] = o[k].map((r) => r.map(pdfTxt));
    if (typeof doc.autoTable === 'function') return doc.autoTable(o);
    const p = window.jspdf_autotable; const fn = p && (p.autoTable || p.default);
    if (fn) return fn(doc, o);
    throw new Error('PDF-Tabellen-Modul nicht geladen');
  }
  async function buildPdf(i) {
    if (!window.jspdf) throw new Error('PDF-Modul nicht geladen');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, M = 14;
    const green = [91, 127, 58];
    const tableBase = { margin: { left: M, right: M }, styles: { fontSize: 9, cellPadding: 1.6, overflow: 'linebreak' }, headStyles: { fillColor: green, textColor: 255 }, alternateRowStyles: { fillColor: [244, 246, 241] } };
    const endY = () => doc.lastAutoTable.finalY;
    let y = M;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(30);
    doc.text(`Pflegeprotokoll: ${igelName(i)}`, M, y + 5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(110);
    const kopf = [S.pflegestelle, S.ansprechpartner, S.kontakt].filter(Boolean).join(' · ');
    y += 10;
    if (kopf) { doc.text(kopf, M, y); y += 4.5; }
    doc.text(`Erstellt am ${fmtDT(nowDT())}`, M, y); y += 5;

    const p = titlePhoto(i); const photoW = 52; let photoBottom = y;
    if (p) {
      const h = Math.min(photoW * (p.h / p.w), 70);
      const w = h / (p.h / p.w);
      doc.addImage(new Uint8Array(p.full), 'JPEG', W - M - w, y, w, h); photoBottom = y + h;
    }
    const lw = lastWeight(i.id), fw = firstWeight(i.id);
    const stamm = [
      ['Name', i.name], ['Pflege-Nr.', i.nummer], ['Box / Gehege', i.box], ['Status', STATUS_L[i.status]], ['Geschlecht', label(GESCHLECHT, i.geschlecht)], ['Alter', label(ALTER, i.alter)],
      ['Aufnahme', fmtD(i.aufnahmeDatum)], ['Tage in Pflege', inCareDays(i) != null ? String(inCareDays(i)) : ''],
      ['Gewicht Aufnahme', fw ? `${fmtNum(fw.gramm)} g (${fmtD(fw.datum)})` : ''], ['Gewicht aktuell', lw ? `${fmtNum(lw.gramm)} g (${fmtD(lw.datum)})` : ''],
      ['Fund am', fmtD(i.fundDatum)], ['Fundort', i.fundOrt], ['Fundumstände', i.fundUmstaende], ['Finder', [i.finderName, i.finderKontakt].filter(Boolean).join(', ')],
      ['Zustand bei Aufnahme', i.zustand],
      ...(() => {
        const wi = winterInfo(i); if (!wi) return [];
        return [
          ['Winterschlaf', `${fmtD(wi.beginn)} – ${wi.ende ? fmtD(wi.ende) : 'laufend'} (${wi.tage} Tage)`],
          ['Gewicht Winterschlaf', wi.wB && wi.wE ? `${fmtNum(wi.wB.gramm)} g -> ${fmtNum(wi.wE.gramm)} g${wi.verlust != null ? ` (${signed(wi.verlust)} g, ${signed(wi.pct, 1)} %)` : ''}` : '']
        ];
      })(),
      ['Abgang am', fmtD(i.abgangDatum)], ['Verbleib', i.abgangOrt], ['Notizen', i.notizen]
    ].filter(([, v]) => v);
    autoTable(doc, { ...tableBase, startY: y, body: stamm, theme: 'plain', tableWidth: W - 2 * M - (p ? photoW + 4 : 0),
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 38, textColor: 90 } }, styles: { fontSize: 9.5, cellPadding: 1.2 } });
    y = Math.max(endY(), photoBottom) + 7;

    const section = (title) => {
      if (y > 265) { doc.addPage(); y = M; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(30); doc.text(title, M, y); y += 2.5;
    };

    // Gewicht
    const ws = weightsOf(i.id);
    section('Gewichtsverlauf');
    if (ws.length >= 2) {
      const cw = W - 2 * M, ch = 55; if (y + ch > 280) { doc.addPage(); y = M; }
      const ziel = S.zielgewicht || null; const sc = chartScale(ws, ziel);
      const L = M + 12, T = y + 3, R = M + cw, B = y + ch - 6;
      const X = (x) => L + (x - sc.xmin) / (sc.xmax - sc.xmin) * (R - L);
      const Yp = (v) => T + (1 - (v - sc.ymin) / (sc.ymax - sc.ymin)) * (B - T);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(120); doc.setDrawColor(220); doc.setLineWidth(0.2);
      for (let v = sc.ymin; v <= sc.ymax + 0.001; v += sc.step) { doc.line(L, Yp(v), R, Yp(v)); doc.text(fmtNum(v), L - 1.5, Yp(v) + 1, { align: 'right' }); }
      for (let k = 0; k <= 5; k++) { const x = sc.xmin + (sc.xmax - sc.xmin) * k / 5; doc.text(fmtShort(dtStr(new Date(x))), X(x), B + 4, { align: k === 0 ? 'left' : k === 5 ? 'right' : 'center' }); }
      if (ziel) { doc.setDrawColor(122, 87, 60); doc.setLineDashPattern([1.5, 1.2], 0); doc.line(L, Yp(ziel), R, Yp(ziel)); doc.setLineDashPattern([], 0); doc.setTextColor(122, 87, 60); doc.text(`Ziel ${fmtNum(ziel)} g`, R, Yp(ziel) - 1, { align: 'right' }); }
      doc.setDrawColor(...green); doc.setLineWidth(0.6);
      for (let k = 1; k < ws.length; k++) doc.line(X(sc.xs[k - 1]), Yp(sc.ys[k - 1]), X(sc.xs[k]), Yp(sc.ys[k]));
      doc.setFillColor(...green); if (ws.length <= 80) ws.forEach((_, k) => doc.circle(X(sc.xs[k]), Yp(sc.ys[k]), 0.7, 'F'));
      doc.setLineWidth(0.2); y += ch + 2;
    }
    if (ws.length) {
      autoTable(doc, { ...tableBase, startY: y, head: [['Datum', 'Gewicht', 'Veränderung', 'Notiz']],
        body: ws.map((w, k) => [fmtDT(w.datum), `${fmtNum(w.gramm)} g`, k ? `${signed(w.gramm - ws[k - 1].gramm)} g` : '', w.notiz || '']) });
      y = endY() + 7;
    } else { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('Keine Wiegungen.', M, y + 4); y += 10; }

    // Medikation
    const meds = byIgel('medikation', i.id).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    section('Medikation');
    if (meds.length) {
      autoTable(doc, { ...tableBase, startY: y, head: [['Medikament', 'Dosis', 'Gabe', 'pro Tag', 'Zeitraum', 'Gaben erfasst', 'Grund / Notiz']],
        body: meds.map((m) => [m.mittel, m.dosis, label(APPLIKATION, m.applikation), String(m.proTag || 1),
          `${fmtD(m.start)} – ${m.abgesetzt ? fmtD(m.abgesetzt) + ' (abgesetzt)' : medEnde(m) ? fmtD(medEnde(m)) : 'offen'}`,
          String(D.gaben.filter((g) => g.medId === m.id).length), [m.grund, m.verordnetVon ? 'verordnet: ' + m.verordnetVon : '', m.notiz].filter(Boolean).join(' · ')]) });
      y = endY() + 7;
    } else { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('Keine Medikation.', M, y + 4); y += 10; }

    // Kotproben
    const bef = byIgel('befunde', i.id).sort((a, b) => a.datum.localeCompare(b.datum));
    section('Kotproben / Parasiten');
    if (bef.length) {
      autoTable(doc, { ...tableBase, startY: y, head: [['Datum', 'Befund', 'Befall', 'Untersucht von', 'Kontrolle', 'Notiz']],
        body: bef.map((b) => [fmtD(b.datum), (b.ergebnis || []).join(', '), b.befall || '', b.untersucher || '', fmtD(b.kontrolleAm), b.notiz || '']) });
      y = endY() + 7;
    } else { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('Keine Kotproben.', M, y + 4); y += 10; }

    // Tierarzt
    const ta = byIgel('tierarzt', i.id).sort((a, b) => a.datum.localeCompare(b.datum));
    section('Tierarztbesuche');
    if (ta.length) {
      const sum = ta.reduce((s, v) => s + (v.kosten || 0), 0);
      autoTable(doc, { ...tableBase, startY: y, head: [['Datum', 'Praxis', 'Grund', 'Befund / Diagnose', 'Behandlung', 'Kosten']],
        body: ta.map((v) => [fmtD(v.datum), v.praxis || '', v.grund || '', v.diagnose || '', v.behandlung || '', v.kosten != null ? `${fmtNum(v.kosten, 2)} €` : '']),
        foot: sum ? [['', '', '', '', 'Summe', `${fmtNum(sum, 2)} €`]] : undefined, footStyles: { fillColor: [230, 236, 224], textColor: 30, fontStyle: 'bold' } });
      y = endY() + 7;
    } else { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('Keine Tierarztbesuche.', M, y + 4); y += 10; }

    // Futter
    const fs = byIgel('futter', i.id).sort((a, b) => a.datum.localeCompare(b.datum));
    section('Futterprotokoll');
    if (fs.length) {
      autoTable(doc, { ...tableBase, startY: y, head: [['Zeitpunkt', 'Futter', 'Menge', 'Gefressen', 'Notiz']],
        body: fs.map((f) => [fmtDT(f.datum), f.futter || '', f.menge != null ? `${fmtNum(f.menge)} g` : '', label(GEFRESSEN, f.gefressen), f.notiz || '']) });
      y = endY() + 7;
    } else { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('Keine Fütterungen.', M, y + 4); y += 10; }

    const pages = doc.getNumberOfPages();
    for (let k = 1; k <= pages; k++) {
      doc.setPage(k); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140);
      doc.text(`${igelName(i)} · Pflegeprotokoll`, M, 290); doc.text(`Seite ${k} von ${pages}`, W - M, 290, { align: 'right' });
    }
    return doc.output('blob');
  }
  async function makePdf(id) {
    const i = igelById(id); if (!i) return;
    toast('PDF wird erstellt …', 10000);
    try {
      const blob = await buildPdf(i);
      $('#toast').hidden = true;
      const fname = `Pflegeprotokoll-${igelName(i).replace(/[^\wäöüÄÖÜß-]+/g, '_')}-${today()}.pdf`;
      readySheet('PDF bereit', blob, fname, `${fmtNum(blob.size / 1024)} KB`);
    } catch (e) { console.error(e); toast('PDF-Fehler: ' + e.message, 5000); }
  }

  // ---------- Aktionen ----------
  const actions = {
    filter: (d) => { ui.filter = d.v; render(); },
    newIgel: () => igelForm(),
    open: (d) => go({ name: 'detail', id: d.id }),
    dtab: (d) => { ui.detailTab = d.v; render(); },
    addPhoto: (d) => pickPhotos(d.id),
    photo: (d) => photoSheet(d.id),
    pdf: (d) => makePdf(d.id),
    delIgel: (d) => confirmDeleteIgel(d.id),
    addWeight: (d) => weightForm(d.id),
    editWeight: (d) => { const w = D.gewichte.find((x) => x.id === d.id); if (w) weightForm(w.igelId, w); },
    addMed: (d) => medForm(d.id),
    editMed: (d) => { const m = D.medikation.find((x) => x.id === d.id); if (m) medForm(m.igelId, m); },
    give: (d) => give(d.id),
    undoGive: (d) => undoGive(d.id),
    addBefund: (d) => befundForm(d.id),
    editBefund: (d) => { const b = D.befunde.find((x) => x.id === d.id); if (b) befundForm(b.igelId, b); },
    addVet: (d) => vetForm(d.id),
    editVet: (d) => { const v = D.tierarzt.find((x) => x.id === d.id); if (v) vetForm(v.igelId, v); },
    addFutter: (d) => futterForm(d.id),
    editFutter: (d) => { const f = D.futter.find((x) => x.id === d.id); if (f) futterForm(f.igelId, f); },
    futterAlle: () => { ui.futterAlle = true; render(); },
    bulkWeigh: () => bulkWeighSheet(),
    bulkFeed: () => bulkFeedSheet(),
    statistik: () => go({ name: 'statistik' }),
    medliste: () => go({ name: 'medliste' }),
    finderliste: () => { ui.finderSearch = ''; go({ name: 'finderliste' }); },
    openFinder: (d) => go({ name: 'finder', key: d.key }),
    finderCsv: () => finderCsv(),
    futterliste: () => go({ name: 'futterliste' }),
    addMedListe: () => medListeForm(),
    editMedListe: (d) => { const m = S.medListe.find((x) => x.id === d.id); if (m) medListeForm(m); },
    addFutterListe: () => futterListeForm(),
    editFutterListe: (d) => { const f = S.futterListe.find((x) => x.id === d.id); if (f) futterListeForm(f); },
    statJahr: (d) => { ui.statJahr = d.v; render(); },
    csv: () => csvExport(ui.statJahr),
    backup: () => makeBackup(),
    restore: () => $('#restoreFile').click(),
    wipe: () => wipeAll(),
    saveSettings: async () => {
      const g = (k) => $('#s_' + k).value.trim();
      S.pflegestelle = g('pflegestelle'); S.ansprechpartner = g('ansprechpartner'); S.kontakt = g('kontakt');
      S.zielgewicht = num(g('zielgewicht')); S.wiegenTage = Math.max(1, Math.round(num(g('wiegenTage')) || 1)); S.wiegenTageWinter = Math.max(1, Math.round(num(g('wiegenTageWinter')) || 7));
      S.alarmProzent = num(g('alarmProzent')); S.alarmTage = Math.max(1, Math.round(num(g('alarmTage')) || 3));
      await saveSettings(); toast('Einstellungen gespeichert'); render();
    }
  };

  const sheetActions = {
    cancel: () => closeSheet(),
    save: async (el, sh) => {
      if (!sh._onSave || sh._saving) return; sh._saving = true;
      if (document.activeElement && sh.contains(document.activeElement)) document.activeElement.blur();
      try { const r = await sh._onSave(); if (r === true) { closeSheet(); render(); } }
      catch (e) { console.error(e); toast('Fehler beim Speichern: ' + e.message, 5000); }
      finally { sh._saving = false; }
    },
    delete: async (el, sh) => { if (!sh._onDelete) return; const r = await sh._onDelete(); if (r === true) { closeSheet(); render(); toast('Gelöscht'); } },
    share: async (el, sh) => { if (sh._share) await sh._share(); },
    restoreMerge: async (el, sh) => { if (sh._backup) await applyBackup(sh._backup, 'merge'); },
    restoreReplace: async (el, sh) => {
      if (!sh._backup) return;
      if (!confirm('Wirklich ALLE Daten auf diesem Gerät durch das Backup ersetzen?')) return;
      await applyBackup(sh._backup, 'replace');
    },
    photoTitle: async (el) => { const p = D.fotos.find((x) => x.id === el.dataset.id); const i = p && igelById(p.igelId); if (!i) return; i.titelFotoId = p.id; await save('igel', i); closeSheet(); render(); toast('Titelbild gesetzt'); },
    photoShare: async (el) => { const p = D.fotos.find((x) => x.id === el.dataset.id); if (p) await shareFile(new Blob([p.full], { type: 'image/jpeg' }), `igel-${dStr(parseD(p.datum) || new Date())}.jpg`); },
    photoDel: async (el) => { if (!confirm('Foto löschen?')) return; const p = D.fotos.find((x) => x.id === el.dataset.id); if (!p) return; const i = igelById(p.igelId); if (i && i.titelFotoId === p.id) { i.titelFotoId = null; await save('igel', i); } await remove('fotos', p.id); closeSheet(); render(); toast('Foto gelöscht'); }
  };

  function bindEvents() {
    $('#view').addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]'); if (!el) return;
      e.preventDefault(); const fn = actions[el.dataset.act]; if (fn) fn(el.dataset, el);
    });
    $('#view').addEventListener('input', (e) => {
      if (e.target.id === 'search' || e.target.id === 'finderSearch') {
        const id = e.target.id;
        if (id === 'search') ui.search = e.target.value; else ui.finderSearch = e.target.value;
        const pos = e.target.selectionStart;
        render(); const s = $('#' + id); if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (_) { /* */ } }
      }
    });
    $('#view').addEventListener('change', (e) => { if (e.target.id === 'restoreFile' && e.target.files[0]) { restoreBackup(e.target.files[0]); e.target.value = ''; } });
    $('#sheet').addEventListener('click', (e) => {
      const el = e.target.closest('[data-sheet]'); if (!el) return;
      e.preventDefault(); const fn = sheetActions[el.dataset.sheet]; if (fn) fn(el, $('#sheet'));
    });
    $('#sheet').addEventListener('focusin', (e) => { if (e.target.matches('input, select, textarea')) revealField(e.target.closest('.field') || e.target); });
    $('#sheet').addEventListener('keydown', (e) => {
      // Return in einem einzeiligen Feld schließt nur die Tastatur
      if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox])')) {
        e.preventDefault();
        if (e.target.dataset.bw) { // Alle wiegen: zum nächsten Igel springen
          const all = $$('[data-bw]', $('#sheet')); const nxt = all[all.indexOf(e.target) + 1];
          if (nxt) { nxt.focus(); return; }
        }
        e.target.blur();
      }
    });
    $('#sheet').addEventListener('change', (e) => { const p = e.target.dataset && e.target.dataset.pick; if (p && e.target.value) applyPick(p, e.target.value); });
    $('#sheet').addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.bw) updateBulkDiff(e.target); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitSheet);
      window.visualViewport.addEventListener('scroll', fitSheet);
    }
    window.addEventListener('resize', fitSheet);
    $('#sheetBackdrop').addEventListener('click', closeSheet);
    $('#btnBack').addEventListener('click', back);
    $$('.tabbar button').forEach((b) => b.addEventListener('click', () => {
      const t = b.dataset.tab; ui.prev = null;
      ui.route = { name: t === 'igel' ? 'list' : t }; window.scrollTo(0, 0); render();
    }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && db) render(); });
  }

  // ---------- Start ----------
  async function init() {
    bindEvents();
    try {
      db = await openDB();
      await loadAll();
    } catch (e) {
      $('#view').innerHTML = `<div class="empty"><div class="big">⚠️</div><p>Die lokale Datenbank konnte nicht geöffnet werden.</p><p class="note">${esc(e.message || e)}</p></div>`;
      return;
    }
    try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (e) { /* */ }
    render();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded) return; reloaded = true;
        if ($('#sheet').hidden) location.reload(); else toast('Update geladen – wird beim nächsten Start aktiv.', 4000);
      });
    }
  }
  // Für Tests
  window.__igel = { D, get S() { return S; }, buildPdf, dueItems };
  init();
})();
