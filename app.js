// Plano Manutenção ETO. Inspeção da rede MT de Palmas e Taquaralto.
// Sem framework. Leaflet no mapa, IndexedDB para a fila offline, Supabase (REST + Storage) para gravar.
// Regra de gravação: o app só ACRESCENTA (inspeção nova, foto nova). O estado do poste é a última inspeção dele.
(function () {
  'use strict';
  const CFG = window.PM_CONFIG;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = n => Number(n || 0).toLocaleString('pt-BR');
  const pct = (a, b) => b ? Math.round(1000 * a / b) / 10 : 0;
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
  const chaveNome = s => norm(s).toLocaleLowerCase('pt-BR');
  const guarda = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } return null; };
  const dataBR = iso => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

  // ── checklist (o mesmo combinado com o gestor) ────────────────────────────────────────────────
  const ITENS = [
    { id: 'poste', nome: 'Poste', defeitos: ['Trincado', 'Inclinado', 'Base comprometida'] },
    { id: 'cruzeta', nome: 'Cruzeta', defeitos: ['Quebrada / trincada', 'Deteriorada', 'Torta / desalinhada', 'Ferragem solta'] },
    { id: 'isolador', nome: 'Isolador', defeitos: ['Quebrado / trincado', 'Lascado', 'Contaminado', 'Pino solto / torto'] },
    { id: 'pararaios', nome: 'Para-raios', defeitos: ['Danificado', 'Desconectado', 'Ausente'] },
    { id: 'chave', nome: 'Chave', eq: ['03', '33', '02', '88', 'SEC', 'FTR', '40', '41', '42', '79', '78'], defeitos: ['Danificada', 'Porta-fusível com defeito', 'Contato oxidado / aquecido', 'Sem identificação'] },
    { id: 'trafo', nome: 'Transformador', eq: ['TR'], defeitos: ['Vazamento de óleo', 'Bucha danificada', 'Ruído / aquecimento', 'Tanque corroído', 'Sem identificação'] },
    { id: 'aterramento', nome: 'Aterramento', defeitos: ['Cabo de descida rompido', 'Haste exposta / ausente', 'Conexão solta'] },
    { id: 'estai', nome: 'Estai', defeitos: ['Frouxo', 'Rompido', 'Âncora exposta', 'Sem isolador de estai'] },
    { id: 'cabo', nome: 'Cabo / conector', defeitos: ['Cabo danificado', 'Emenda irregular', 'Conector oxidado / aquecido', 'Flecha fora do padrão', 'Amarração solta'] },
    { id: 'vegetacao', nome: 'Vegetação', defeitos: ['Em contato com a rede', 'Próxima da rede (poda)'] },
    { id: 'outro', nome: 'Outro', defeitos: [] }
  ];
  const PRIO = { urgente: 'Urgente', '6meses': 'Até 6 meses', dez2027: 'Até dez/2027' };
  const PESO = { urgente: 3, '6meses': 2, dez2027: 1 };
  const RESULT = { sem_anomalia: 'Sem anomalia', anomalia: 'Anomalia', nao_localizado: 'Não localizado', sem_acesso: 'Sem acesso' };

  // feriados nacionais, do Tocantins e de Palmas (contam como dia sem campo)
  const FERIADOS = new Set(['2026-11-20', '2026-12-25', '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-18', '2027-03-26',
    '2027-04-21', '2027-05-01', '2027-05-20', '2027-05-27', '2027-09-07', '2027-09-08', '2027-10-05', '2027-10-12',
    '2027-11-02', '2027-11-15', '2027-11-20', '2027-12-25']);
  const isoDia = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  function diasUteis(de, ate) {
    let n = 0; const d = new Date(de.getFullYear(), de.getMonth(), de.getDate());
    while (d <= ate) { const w = d.getDay(); if (w && w < 6 && !FERIADOS.has(isoDia(d))) n++; d.setDate(d.getDate() + 1); }
    return n;
  }

  // ── estado ────────────────────────────────────────────────────────────────────────────────────
  let BASE = null, POSTES = [], IDX = new Map(), QUADRAS = [], ALIMS = [], NOMES_EQ = {};
  let PQ = [];                       // índices de poste por quadra
  const ESTADO = new Map();          // poste -> {r, p, t, tec, id}  (servidor)
  const LOCAL = new Map();           // poste -> {r, p, t, tec}      (fila deste celular, ainda ou já enviada)
  const ROTAS = new Map();           // quadra -> técnico
  let maxId = 0;
  let usuario = norm(guarda('pm_tecnico') || '');
  let pos = null;
  let quadraSel = -1;
  let fichaAtual = -1;

  // ── Supabase ──────────────────────────────────────────────────────────────────────────────────
  const KEY = CFG.supabaseChave;
  const H = () => (KEY.startsWith('eyJ') ? { apikey: KEY, Authorization: 'Bearer ' + KEY } : { apikey: KEY });
  async function sb(path, opt = {}) {
    const r = await fetch(CFG.supabaseUrl + path, { ...opt, headers: { ...H(), ...(opt.headers || {}) } });
    if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error(r.status + ' ' + t.slice(0, 200)); e.status = r.status; e.corpo = t; throw e; }
    return r;
  }
  const sbJson = async (path, opt) => (await sb(path, opt)).json();
  async function lePaginado(path, por = 1000) {
    const out = [];
    for (let ini = 0; ; ini += por) {
      const r = await sbJson(path + (path.includes('?') ? '&' : '?') + `limit=${por}&offset=${ini}`);
      out.push(...r);
      if (r.length < por) return out;
    }
  }
  const fotoUrl = p => CFG.supabaseUrl + '/storage/v1/object/authenticated/' + CFG.bucketFotos + '/' + p.split('/').map(encodeURIComponent).join('/');
  async function baixaFoto(p) { const r = await fetch(fotoUrl(p), { headers: H() }); if (!r.ok) throw new Error('foto ' + r.status); return URL.createObjectURL(await r.blob()); }

  // ── IndexedDB (fila e cópia do estado) ─────────────────────────────────────────────────────────
  let _db = null;
  function db() {
    if (_db) return Promise.resolve(_db);
    return new Promise((ok, erro) => {
      const rq = indexedDB.open('vera-eto-pm', 1);
      rq.onupgradeneeded = () => { const d = rq.result; d.createObjectStore('fila', { keyPath: 'cliente_id' }); d.createObjectStore('kv'); };
      rq.onsuccess = () => { _db = rq.result; ok(_db); };
      rq.onerror = () => erro(rq.error);
    });
  }
  async function idb(store, modo, fn) {
    const d = await db();
    return new Promise((ok, erro) => {
      const tx = d.transaction(store, modo); const s = tx.objectStore(store); let res;
      const rq = fn(s); if (rq) rq.onsuccess = () => { res = rq.result; };
      tx.oncomplete = () => ok(res); tx.onerror = () => erro(tx.error); tx.onabort = () => erro(tx.error);
    });
  }
  const filaTodas = () => idb('fila', 'readonly', s => s.getAll());
  const filaGrava = r => idb('fila', 'readwrite', s => s.put(r));
  const kvLe = k => idb('kv', 'readonly', s => s.get(k));
  const kvGrava = (k, v) => idb('kv', 'readwrite', s => s.put(v, k));

  // ── toast ─────────────────────────────────────────────────────────────────────────────────────
  let _tt = 0;
  function toast(msg, tipo = '') { const t = $('toast'); t.textContent = msg; t.className = 'show ' + tipo; clearTimeout(_tt); _tt = setTimeout(() => { t.className = tipo; }, 3200); }

  // ── base ──────────────────────────────────────────────────────────────────────────────────────
  async function carregaBase() {
    const [b, r] = await Promise.all([
      fetch('dados/base.json?v=' + CFG.versao).then(x => { if (!x.ok) throw new Error('base ' + x.status); return x.json(); }),
      fetch('dados/rede.json?v=' + CFG.versao).then(x => x.ok ? x.json() : null).catch(() => null)
    ]);
    BASE = b; POSTES = b.postes; QUADRAS = b.quadras; ALIMS = b.alimentadores; NOMES_EQ = b.nomes_eq;
    PQ = QUADRAS.map(() => []);
    POSTES.forEach((p, i) => { IDX.set(p[0], i); PQ[p[4]].push(i); });
    return r;
  }
  const estadoDe = id => LOCAL.get(id) || ESTADO.get(id) || null;
  function feitosNaQuadra(qi) { let n = 0; for (const i of PQ[qi]) if (estadoDe(POSTES[i][0])) n++; return n; }

  // ── sincronização do estado (o que já foi inspecionado, por qualquer técnico) ────────────────────
  async function carregaEstadoLocal() {
    const snap = await kvLe('estado').catch(() => null);
    if (snap && snap.v === 1) { maxId = snap.maxId; for (const [k, v] of snap.itens) ESTADO.set(k, v); }
    for (const f of await filaTodas().catch(() => [])) aplicaLocal(f.row);
  }
  function aplicaLocal(row) {
    const cur = LOCAL.get(row.poste);
    if (!cur || cur.t <= row.feito_em) LOCAL.set(row.poste, { r: row.resultado, p: row.prioridade, t: row.feito_em, tec: row.tecnico });
  }
  async function atualizaEstado() {
    if (!navigator.onLine) return false;
    let linhas;
    if (!maxId) {
      linhas = await lePaginado('/rest/v1/pm_estado?select=id,poste,resultado,prioridade,criado_em,tecnico&order=id.asc');
    } else {
      linhas = await lePaginado(`/rest/v1/pm_inspecoes?select=id,poste,resultado,prioridade,criado_em,tecnico&id=gt.${maxId}&order=id.asc`);
    }
    for (const l of linhas) {
      ESTADO.set(l.poste, { r: l.resultado, p: l.prioridade, t: l.criado_em, tec: l.tecnico, id: l.id });
      if (l.id > maxId) maxId = l.id;
    }
    const rotas = await sbJson('/rest/v1/pm_rota_atual?select=quadra,tecnico');
    ROTAS.clear(); for (const r of rotas) if (r.tecnico) ROTAS.set(r.quadra, r.tecnico);
    guarda('pm_rotas', JSON.stringify([...ROTAS]));
    await kvGrava('estado', { v: 1, maxId, itens: [...ESTADO] }).catch(() => {});
    return linhas.length > 0;
  }

  // ── fila: envia fotos e inspeções ───────────────────────────────────────────────────────────────
  let enviando = false;
  async function sincroniza(avisar) {
    if (enviando) return;
    const fila = (await filaTodas()).filter(f => f.status !== 'enviado');
    atualizaBarra(fila.length);
    if (!fila.length || !navigator.onLine) { if (avisar && !fila.length) toast('Nada para enviar.'); return; }
    enviando = true; atualizaBarra(fila.length, true);
    let ok = 0, falha = 0;
    for (const f of fila.sort((a, b) => a.row.feito_em < b.row.feito_em ? -1 : 1)) {
      try {
        for (const ft of f.fotos) {
          if (ft.enviada) continue;
          const r = await fetch(CFG.supabaseUrl + '/storage/v1/object/' + CFG.bucketFotos + '/' + ft.path.split('/').map(encodeURIComponent).join('/'),
            { method: 'POST', headers: { ...H(), 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }, body: ft.blob });
          if (!r.ok) { const t = await r.text(); if (!/exist|Duplicate|409/i.test(t)) throw new Error('foto: ' + r.status + ' ' + t.slice(0, 120)); }
          ft.enviada = true; await filaGrava(f);
        }
        await sb('/rest/v1/pm_inspecoes?on_conflict=cliente_id', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify([f.row])
        });
        f.status = 'enviado'; f.enviado_em = new Date().toISOString(); f.erro = '';
        for (const ft of f.fotos) ft.blob = null;            // a foto já está no servidor; libera o celular
        await filaGrava(f); ok++;
      } catch (e) {
        f.status = 'erro'; f.erro = String(e.message || e); await filaGrava(f).catch(() => {}); falha++;
        if (!navigator.onLine) break;
      }
    }
    enviando = false;
    const resta = (await filaTodas()).filter(f => f.status !== 'enviado').length;
    atualizaBarra(resta);
    if (avisar || falha) toast(falha ? `${ok} enviada(s), ${falha} com erro — tento de novo depois.` : `${ok} inspeção(ões) enviada(s).`, falha ? 'error' : 'success');
    if ($('tab-registros').classList.contains('active')) desenhaRegistros();
    atualizaEstado().then(() => redesenha()).catch(() => {});
  }
  function atualizaBarra(pend, envi) {
    const bar = $('status-bar');
    const on = navigator.onLine;
    bar.className = envi ? 'syncing' : on ? 'online' : 'offline';
    $('status-txt').textContent = envi ? 'Enviando…' : on ? 'Online' : 'Sem internet — salvando no celular';
    if (pend !== undefined) $('pend-badge').textContent = pend + ' para enviar';
  }

  // ── mapa ──────────────────────────────────────────────────────────────────────────────────────
  let map, rua, sat, emSat = guarda('pm_sat') === '1';
  let camQuadras, camPostes, camRede, camRotulos, voce, render;
  const COR = {
    pend: ['#ffffff', '#1a2e1a'], sem_anomalia: ['#2e9d4f', '#1b5e20'], anomalia: ['#f0a020', '#8a5a00'],
    urgente: ['#d32f2f', '#7f0000'], nao_localizado: ['#8a8f98', '#444'], sem_acesso: ['#8a8f98', '#444']
  };
  function corPoste(id) {
    const e = estadoDe(id); if (!e) return COR.pend;
    if (e.r === 'anomalia' && e.p === 'urgente') return COR.urgente;
    return COR[e.r] || COR.pend;
  }
  function corQuadra(qi) {
    const n = PQ[qi].length, f = feitosNaQuadra(qi), p = n ? f / n : 0;
    if (p >= 1) return '#2e9d4f'; if (p > 0) return '#e8a020'; return '#7a8a76';
  }
  const minha = qi => usuario && chaveNome(ROTAS.get(QUADRAS[qi].id)) === chaveNome(usuario);

  function iniciaMapa(rede) {
    render = L.canvas({ padding: 0.4, tolerance: 9 });
    map = L.map('map', { zoomControl: false, preferCanvas: true, maxZoom: 21 }).setView([-10.235, -48.33], 13);
    rua = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
    sat = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 21, maxNativeZoom: 20, subdomains: '0123', attribution: '© Google' });
    (emSat ? sat : rua).addTo(map); $('m-camada').classList.toggle('on', emSat);
    camRede = L.layerGroup(); camQuadras = L.layerGroup().addTo(map); camPostes = L.layerGroup().addTo(map); camRotulos = L.layerGroup().addTo(map);
    if (rede) rede.rede.forEach(segs => L.polyline(segs.map(s => [[s[1], s[0]], [s[3], s[2]]]), { color: '#1565C0', weight: 2, opacity: 0.55, renderer: render, interactive: false }).addTo(camRede));
    desenhaQuadras();
    map.on('moveend zoomend', desenhaPostes);
    desenhaPostes();
    $('m-camada').onclick = () => { emSat = !emSat; guarda('pm_sat', emSat ? '1' : '0'); map.removeLayer(emSat ? rua : sat); (emSat ? sat : rua).addTo(map); $('m-camada').classList.toggle('on', emSat); };
    $('m-eu').onclick = () => { if (pos) map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 17)); else toast('Sem GPS ainda. Confira se a localização está ligada.', 'warning'); };
    $('m-perto').onclick = proximoPoste;
  }
  function desenhaQuadras() {
    camQuadras.clearLayers(); camRotulos.clearLayers();
    QUADRAS.forEach((q, qi) => {
      if (!q.contorno || q.contorno.length < 3) return;
      const sel = qi === quadraSel, mi = minha(qi);
      const pg = L.polygon(q.contorno, {
        color: sel ? '#1565C0' : mi ? '#1565C0' : '#1a2e1a', weight: sel ? 4 : mi ? 3 : 1.2, dashArray: q.tipo === 'fora' ? '5 5' : null,
        fillColor: corQuadra(qi), fillOpacity: sel ? 0.08 : 0.18, renderer: render
      }).addTo(camQuadras);
      pg.on('click', () => selecionaQuadra(qi, false));
      if (sel || mi) L.tooltip({ permanent: true, direction: 'center', className: 'quadra-rotulo' }).setLatLng(q.centro).setContent(esc(q.nome)).addTo(camRotulos);
    });
  }
  function desenhaPostes() {
    camPostes.clearLayers();
    const z = map.getZoom();
    if (z >= 14) { if (!map.hasLayer(camRede)) camRede.addTo(map); } else if (map.hasLayer(camRede)) map.removeLayer(camRede);
    if (z < 15) return;
    const b = map.getBounds().pad(0.1); let n = 0;
    for (let i = 0; i < POSTES.length && n < 4000; i++) {
      const p = POSTES[i]; if (!b.contains([p[1], p[2]])) continue; n++;
      const [fill, borda] = corPoste(p[0]);
      const m = L.circleMarker([p[1], p[2]], { radius: p[6].length ? 7.5 : 5.5, color: borda, weight: p[6].length ? 2.5 : 1.6, fillColor: fill, fillOpacity: 1, renderer: render });
      m.on('click', ev => { L.DomEvent.stopPropagation(ev); abreFicha(i); });
      m.addTo(camPostes);
    }
  }
  function redesenha() { if (!map) return; desenhaQuadras(); desenhaPostes(); if (quadraSel >= 0) infoQuadra(); }
  function selecionaQuadra(qi, voar = true) {
    quadraSel = qi; guarda('pm_quadra', QUADRAS[qi].id);
    desenhaQuadras(); infoQuadra();
    if (voar) map.fitBounds(L.polygon(QUADRAS[qi].contorno).getBounds(), { padding: [30, 30], maxZoom: 17 });
  }
  function infoQuadra() {
    const q = QUADRAS[quadraSel], n = PQ[quadraSel].length, f = feitosNaQuadra(quadraSel);
    const tec = ROTAS.get(q.id);
    const prog = q.prog ? ` · programação anterior: ${esc(q.prog.status || '')}${q.prog.data ? ' ' + esc(q.prog.data) : ''}` : '';
    $('m-quadra').innerHTML = `<b>${esc(q.nome)}</b> <span class="q-meta">(${q.id})</span><br>${nf(f)} de ${nf(n)} estruturas · ${pct(f, n)}%` +
      `${tec ? ' · técnico: ' + esc(tec) : ''}<span class="q-meta">${prog}</span>`;
    $('m-quadra').hidden = false;
  }
  function proximoPoste() {
    const ref = pos ? [pos.lat, pos.lon] : [map.getCenter().lat, map.getCenter().lng];
    const lista = quadraSel >= 0 ? PQ[quadraSel] : POSTES.map((_, i) => i);
    let best = -1, bd = 1e18;
    for (const i of lista) { const p = POSTES[i]; if (estadoDe(p[0])) continue; const d = dist(ref[0], ref[1], p[1], p[2]); if (d < bd) { bd = d; best = i; } }
    if (best < 0) { toast(quadraSel >= 0 ? 'Esta quadra está completa.' : 'Nenhum poste pendente.', 'success'); return; }
    map.setView([POSTES[best][1], POSTES[best][2]], Math.max(map.getZoom(), 18));
    abreFicha(best);
  }
  function dist(la1, lo1, la2, lo2) {
    const k = Math.PI / 180, x = (lo2 - lo1) * k * Math.cos((la1 + la2) / 2 * k), y = (la2 - la1) * k;
    return Math.sqrt(x * x + y * y) * 6371000;
  }

  // ── GPS ───────────────────────────────────────────────────────────────────────────────────────
  function iniciaGps() {
    if (!navigator.geolocation) { $('gps-pill').textContent = 'GPS indisponível'; return; }
    navigator.geolocation.watchPosition(g => {
      pos = { lat: g.coords.latitude, lon: g.coords.longitude, acc: g.coords.accuracy };
      $('gps-pill').textContent = `GPS ±${Math.round(pos.acc)} m · ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`;
      if (!voce) voce = L.marker([pos.lat, pos.lon], { icon: L.divIcon({ className: '', html: '<div class="voce"></div>', iconSize: [16, 16] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      else voce.setLatLng([pos.lat, pos.lon]);
    }, e => { $('gps-pill').textContent = 'GPS: ' + (e.code === 1 ? 'permissão negada' : 'sem sinal'); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }

  // ── ficha do poste ────────────────────────────────────────────────────────────────────────────
  function abreFicha(i) {
    fichaAtual = i;
    const p = POSTES[i], q = QUADRAS[p[4]], al = ALIMS[p[3]];
    const e = estadoDe(p[0]);
    const d = pos ? dist(pos.lat, pos.lon, p[1], p[2]) : null;
    const eqs = p[6].map(([c, t]) => `<span class="eq">${esc(NOMES_EQ[t] || t)} · ${esc(c)}</span>`).join('');
    let est = '<div class="estado">Ainda não inspecionado.</div>';
    if (e) {
      const cls = e.r === 'sem_anomalia' ? 'ok' : e.r === 'anomalia' ? (e.p === 'urgente' ? 'urgente' : 'anomalia') : '';
      const pend = LOCAL.has(p[0]) && !ESTADO.has(p[0]) ? ' (no celular)' : '';
      est = `<div class="estado ${cls}"><b>${esc(RESULT[e.r] || e.r)}</b>${e.p ? ' · ' + esc(PRIO[e.p]) : ''} — ${esc(e.tec || '')}, ${dataBR(e.t)}${pend}</div>`;
    }
    $('s-corpo').innerHTML =
      `<div class="ficha-cod">${esc(p[0])}</div>` +
      `<div class="ficha-meta">${p[7] === 'S' ? '<b>Equipamento sem código de poste na base</b><br>' : ''}` +
      `Quadra <b>${esc(q.nome)}</b> (${q.id})<br>${esc(al.cod)} · ${esc(al.se_nome)}${p[5] ? ' · trecho ' + esc(p[5]) : ''}` +
      `${d != null ? '<br>Você está a ' + nf(Math.round(d)) + ' m' : ''}</div>` +
      (eqs ? `<div class="eq-lista">${eqs}</div>` : '') + est +
      (d != null && d > CFG.distanciaAviso ? `<div class="aviso-dist">Você está longe deste poste (${nf(Math.round(d))} m). Confira o código antes de salvar.</div>` : '') +
      `<div class="acoes"><button class="btn-ok" id="a-ok">✓ Sem anomalia</button><button class="btn-anom" id="a-anom">⚠ Registrar anomalia</button>` +
      `<div class="linha"><button class="btn-sec" id="a-nl">Não localizado</button><button class="btn-sec" id="a-sa">Sem acesso</button></div></div>`;
    $('sheet').hidden = false;
    $('a-ok').onclick = () => salvaSimples('sem_anomalia');
    $('a-nl').onclick = () => salvaSimples('nao_localizado');
    $('a-sa').onclick = () => salvaSimples('sem_acesso');
    $('a-anom').onclick = () => { fechaFicha(); abreForm(i); };
  }
  function fechaFicha() { $('sheet').hidden = true; }
  function confereDistancia(i) {
    if (!pos) return true;
    const p = POSTES[i], d = dist(pos.lat, pos.lon, p[1], p[2]);
    return d <= CFG.distanciaAviso || confirm(`Você está a ${Math.round(d)} m do poste ${p[0]}. Salvar assim mesmo?`);
  }
  async function salvaSimples(res) {
    const i = fichaAtual; if (!confereDistancia(i)) return;
    let obs = '';
    if (res !== 'sem_anomalia') { obs = prompt(res === 'nao_localizado' ? 'O que aconteceu? (ex.: poste não existe no local)' : 'Por que não teve acesso? (ex.: área fechada, cão)') ; if (obs === null) return; }
    await registra(i, res, null, [], [], norm(obs));
    fechaFicha();
    toast(RESULT[res] + ' — salvo.', 'success');
    if (res === 'sem_anomalia') setTimeout(() => sugereProximo(i), 400);
  }
  function sugereProximo(i) {
    // depois de um «sem anomalia» já mostra o próximo pendente mais perto deste poste, na mesma quadra
    const p = POSTES[i]; let best = -1, bd = 1e18;
    for (const j of PQ[p[4]]) { const o = POSTES[j]; if (estadoDe(o[0])) continue; const d = dist(p[1], p[2], o[1], o[2]); if (d < bd) { bd = d; best = j; } }
    if (best >= 0 && bd < 400) { map.panTo([POSTES[best][1], POSTES[best][2]]); abreFicha(best); }
    else if (best < 0) toast('Quadra completa!', 'success');
  }
  async function registra(i, resultado, prioridade, itens, fotos, obs) {
    const p = POSTES[i];
    const row = {
      cliente_id: uuid(), feito_em: new Date().toISOString(), poste: p[0], quadra: QUADRAS[p[4]].id, alimentador: ALIMS[p[3]].cod,
      tecnico: usuario, resultado, prioridade, itens, obs: obs || null,
      lat: pos ? +pos.lat.toFixed(7) : null, lon: pos ? +pos.lon.toFixed(7) : null, precisao_m: pos ? Math.round(pos.acc) : null,
      dist_m: pos ? Math.round(dist(pos.lat, pos.lon, p[1], p[2])) : null, app_versao: CFG.versao
    };
    await filaGrava({ cliente_id: row.cliente_id, row, fotos, status: 'pendente', criado: Date.now() });
    aplicaLocal(row);
    redesenha();
    sincroniza(false);
  }

  // ── formulário de anomalia ────────────────────────────────────────────────────────────────────
  let F = null;
  function abreForm(i) {
    const p = POSTES[i];
    const tem = new Set(p[6].map(x => x[1]));
    F = { i, itens: {} };
    $('f-poste').textContent = 'Poste ' + p[0] + ' · ' + QUADRAS[p[4]].nome;
    $('f-obs').value = '';
    $('f-itens').innerHTML = ITENS.map(it => {
      const temEq = it.eq && it.eq.some(t => tem.has(t));
      return `<div class="item" data-it="${it.id}">
        <label class="item-topo"><input type="checkbox"><span class="item-nome">${esc(it.nome)}</span>${temEq ? '<span class="item-tem">tem no poste</span>' : ''}</label>
        <div class="item-corpo">
          ${it.defeitos.length ? `<div class="sub">Defeito</div><div class="chips">${it.defeitos.map(d => `<button type="button" class="chip" data-d="${esc(d)}">${esc(d)}</button>`).join('')}</div>` : ''}
          <div class="sub">Prioridade</div>
          <div class="prio">${Object.entries(PRIO).map(([k, v]) => `<button type="button" data-p="${k}">${v}</button>`).join('')}</div>
          <div class="sub">Fotos${CFG.fotoObrigatoria ? ' (obrigatória)' : ''}</div>
          <div class="photo-area">📷 Tirar foto ou escolher da galeria<input type="file" accept="image/*" capture="environment" multiple></div>
          <div class="photo-preview"></div>
          <div class="sub">${it.id === 'outro' ? 'Descreva (obrigatório)' : 'Observação'}</div>
          <textarea class="field-input" rows="2" maxlength="500" placeholder="${it.id === 'outro' ? 'O que foi encontrado' : 'Opcional'}"></textarea>
        </div></div>`;
    }).join('');
    $('f-itens').querySelectorAll('.item').forEach(el => {
      const id = el.dataset.it;
      const st = F.itens[id] = { marcado: false, defeitos: new Set(), prioridade: null, fotos: [], obs: '' };
      el.querySelector('.item-topo input').onchange = ev => { st.marcado = ev.target.checked; el.classList.toggle('marcado', st.marcado); };
      el.querySelectorAll('.chip').forEach(c => c.onclick = () => { const d = c.dataset.d; if (st.defeitos.has(d)) st.defeitos.delete(d); else st.defeitos.add(d); c.classList.toggle('on'); });
      el.querySelectorAll('.prio button').forEach(b => b.onclick = () => { st.prioridade = b.dataset.p; el.querySelectorAll('.prio button').forEach(x => x.classList.toggle('on', x === b)); });
      el.querySelector('textarea').oninput = ev => { st.obs = ev.target.value; };
      el.querySelector('input[type=file]').onchange = async ev => {
        const arqs = [...ev.target.files]; ev.target.value = '';
        for (const a of arqs) {
          try { const blob = await comprime(a); st.fotos.push({ blob, url: URL.createObjectURL(blob) }); }
          catch (e) { toast('Não consegui ler a foto: ' + e.message, 'error'); }
        }
        desenhaFotos(el, st);
      };
    });
    $('form').hidden = false; $('form').scrollTop = 0;
  }
  function desenhaFotos(el, st) {
    const box = el.querySelector('.photo-preview');
    box.innerHTML = st.fotos.map((f, k) => `<div class="photo-thumb"><img src="${f.url}" alt=""><button type="button" data-k="${k}">✕</button></div>`).join('');
    box.querySelectorAll('button').forEach(b => b.onclick = () => { st.fotos.splice(+b.dataset.k, 1); desenhaFotos(el, st); });
  }
  async function comprime(arq) {
    const MAX = 1280;
    let img;
    try { img = await createImageBitmap(arq, { imageOrientation: 'from-image' }); }
    catch (e) { img = await new Promise((ok, erro) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => erro(new Error('formato')); im.src = URL.createObjectURL(arq); }); }
    const w0 = img.width, h0 = img.height, k = Math.min(1, MAX / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
    // carimbo: data e poste, para a foto não se perder do registro
    const txt = `${POSTES[F.i][0]} · ${new Date().toLocaleString('pt-BR')}`;
    g.font = `${Math.max(14, Math.round(c.width / 45))}px sans-serif`; const tw = g.measureText(txt).width;
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, c.height - 30 - c.width / 90, tw + 20, 30 + c.width / 90);
    g.fillStyle = '#fff'; g.fillText(txt, 10, c.height - 10);
    for (const q of [0.72, 0.6, 0.45]) {
      const b = await new Promise(ok => c.toBlob(ok, 'image/jpeg', q));
      if (b && b.size < 900000) return b;
    }
    throw new Error('foto grande demais');
  }
  async function salvaForm() {
    const marcados = Object.entries(F.itens).filter(([, s]) => s.marcado);
    if (!marcados.length) { toast('Marque pelo menos um item com defeito.', 'error'); return; }
    for (const [id, s] of marcados) {
      const nome = ITENS.find(x => x.id === id).nome;
      if (id === 'outro' && !norm(s.obs)) { toast('Descreva o defeito em «Outro».', 'error'); return; }
      if (id !== 'outro' && !s.defeitos.size && !norm(s.obs)) { toast(`Escolha o defeito de «${nome}».`, 'error'); return; }
      if (!s.prioridade) { toast(`Escolha a prioridade de «${nome}».`, 'error'); return; }
      if (CFG.fotoObrigatoria && !s.fotos.length) { toast(`Tire a foto de «${nome}».`, 'error'); return; }
    }
    if (!confereDistancia(F.i)) return;
    $('f-salvar').disabled = true;
    try {
      const p = POSTES[F.i], base = Date.now().toString(36);
      const fotos = [], itens = [];
      let n = 0;
      for (const [id, s] of marcados) {
        const paths = s.fotos.map(f => { n++; const path = `${String(p[0]).replace(/[^\w.-]/g, '_')}/${base}_${id}_${n}.jpg`; fotos.push({ path, blob: f.blob, enviada: false }); return path; });
        itens.push({ item: id, nome: ITENS.find(x => x.id === id).nome, defeitos: [...s.defeitos], prioridade: s.prioridade, obs: norm(s.obs) || null, fotos: paths });
      }
      const prioridade = itens.map(x => x.prioridade).sort((a, b) => PESO[b] - PESO[a])[0];
      await registra(F.i, 'anomalia', prioridade, itens, fotos, norm($('f-obs').value));
      $('form').hidden = true;
      toast(`Anomalia salva (${PRIO[prioridade]}).`, 'success');
    } catch (e) { toast('Erro ao salvar: ' + e.message, 'error'); }
    finally { $('f-salvar').disabled = false; }
  }

  // ── abas ──────────────────────────────────────────────────────────────────────────────────────
  function abreAba(nome) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + nome));
    if (nome === 'mapa') setTimeout(() => map.invalidateSize(), 50);
    if (nome === 'quadras') desenhaListaQuadras();
    if (nome === 'registros') desenhaRegistros();
    if (nome === 'painel') desenhaPainel();
  }
  function cartaoQuadra(qi, extra = '') {
    const q = QUADRAS[qi], n = PQ[qi].length, f = feitosNaQuadra(qi);
    return `<div class="q-card" data-q="${qi}"><div><div class="q-nome">${esc(q.nome)}</div><div class="q-meta">${q.id} · ${esc(q.local)} · ${nf(f)} de ${nf(n)}${extra}</div></div>` +
      `<div class="q-pct">${pct(f, n)}%</div><div class="barra"><i style="width:${pct(f, n)}%"></i></div></div>`;
  }
  function ligaCartoes(box) { box.querySelectorAll('.q-card').forEach(c => c.onclick = () => { abreAba('mapa'); selecionaQuadra(+c.dataset.q); }); }
  function desenhaListaQuadras() {
    const minhas = QUADRAS.map((_, i) => i).filter(minha);
    $('q-minhas').innerHTML = minhas.length ? minhas.map(qi => cartaoQuadra(qi)).join('') : '<p class="ajuda">Nenhuma quadra atribuída a você ainda. Escolha uma perto de você abaixo ou peça ao gestor.</p>';
    const ref = pos ? [pos.lat, pos.lon] : [map.getCenter().lat, map.getCenter().lng];
    const perto = QUADRAS.map((q, i) => [dist(ref[0], ref[1], q.centro[0], q.centro[1]), i]).filter(x => PQ[x[1]].length).sort((a, b) => a[0] - b[0]).slice(0, 15);
    $('q-perto').innerHTML = perto.map(([d, qi]) => cartaoQuadra(qi, ' · ' + (d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km') + (ROTAS.get(QUADRAS[qi].id) ? ' · ' + esc(ROTAS.get(QUADRAS[qi].id)) : ''))).join('');
    ligaCartoes($('q-minhas')); ligaCartoes($('q-perto'));
  }
  async function desenhaRegistros() {
    const fila = (await filaTodas()).sort((a, b) => b.criado - a.criado);
    const hoje = isoDia(new Date());
    const deHoje = fila.filter(f => isoDia(new Date(f.criado)) === hoje).length;
    $('r-cont').textContent = `${fila.length} neste celular · ${deHoje} hoje · ${fila.filter(f => f.status !== 'enviado').length} para enviar`;
    $('r-lista').innerHTML = fila.length ? fila.slice(0, 300).map(f => {
      const r = f.row, tag = f.status === 'enviado' ? '<span class="tag sync">Enviado</span>' : f.status === 'erro' ? '<span class="tag erro">Erro — tento de novo</span>' : '<span class="tag pend">No celular</span>';
      const itens = (r.itens || []).map(x => x.nome + (x.defeitos.length ? ': ' + x.defeitos.join(', ') : '')).join(' · ');
      return `<div class="record-card ${f.status === 'enviado' ? '' : f.status === 'erro' ? 'erro' : 'pending'}"><div class="record-top"><span class="record-id">${esc(r.poste)}</span>${tag}</div>` +
        `<div class="record-meta"><b>${esc(RESULT[r.resultado])}</b>${r.prioridade ? ' · ' + PRIO[r.prioridade] : ''} · ${esc(r.quadra)} · ${dataBR(r.feito_em)}` +
        `${f.fotos.length ? ' · ' + f.fotos.length + ' foto(s)' : ''}${itens ? '<br>' + esc(itens) : ''}${r.obs ? '<br>' + esc(r.obs) : ''}${f.erro && f.status === 'erro' ? '<br><span style="color:#c0392b">' + esc(f.erro) + '</span>' : ''}</div></div>`;
    }).join('') : '<div class="ajuda">Nenhuma inspeção neste celular ainda.</div>';
  }

  // ── painel do gestor ──────────────────────────────────────────────────────────────────────────
  let painelSel = new Set();
  let painelFiltro = { prio: '', local: '', item: '' };
  async function desenhaPainel() {
    const box = $('p-conteudo');
    try { await atualizaEstado(); } catch (e) { /* mostra o que tem */ }
    const total = POSTES.length;
    let feitos = 0, ok = 0, anom = { urgente: 0, '6meses': 0, dez2027: 0 }, outros = 0;
    for (const p of POSTES) {
      const e = estadoDe(p[0]); if (!e) continue; feitos++;
      if (e.r === 'sem_anomalia') ok++; else if (e.r === 'anomalia') anom[e.p] = (anom[e.p] || 0) + 1; else outros++;
    }
    const hoje = new Date(), prazo = new Date(CFG.prazoFinal + 'T23:59:59');
    const du = diasUteis(new Date(hoje.getTime() + 864e5), prazo);
    const falta = total - feitos;
    const necessario = du ? Math.ceil(falta / du) : falta;
    // ritmo: inspeções novas (primeira de cada poste) nos últimos 10 dias úteis
    const dias = []; const d = new Date(hoje); while (dias.length < 10) { const w = d.getDay(); if (w && w < 6 && !FERIADOS.has(isoDia(d))) dias.push(isoDia(d)); d.setDate(d.getDate() - 1); }
    const janela = new Set(dias); let naJanela = 0;
    const porTec = new Map();
    for (const [, e] of ESTADO) { const dia = isoDia(new Date(e.t)); if (janela.has(dia)) naJanela++; const k = e.tec || '—'; const t = porTec.get(k) || { total: 0, j: 0 }; t.total++; if (janela.has(dia)) t.j++; porTec.set(k, t); }
    const ritmo = naJanela / 10;
    const previsao = ritmo * du * 4 < falta ? 'muito depois de 2027' : ritmo > 0 ? (() => { let n = 0; const x = new Date(hoje); while (n < falta / ritmo) { x.setDate(x.getDate() + 1); const w = x.getDay(); if (w && w < 6 && !FERIADOS.has(isoDia(x))) n++; } return x.toLocaleDateString('pt-BR'); })() : '—';
    const porLocal = {};
    QUADRAS.forEach((q, qi) => { const l = porLocal[q.local || '—'] ||= { n: 0, f: 0 }; l.n += PQ[qi].length; l.f += feitosNaQuadra(qi); });

    const linhasQ = QUADRAS.map((q, qi) => ({ q, qi, n: PQ[qi].length, f: feitosNaQuadra(qi), tec: ROTAS.get(q.id) || '' })).filter(x => x.n);
    const tecnicos = [...new Set([...ROTAS.values(), ...[...ESTADO.values()].map(e => e.tec)].filter(Boolean))].sort();

    box.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="kpi-n">${nf(feitos)}</div><div class="kpi-l">de ${nf(total)} estruturas inspecionadas (${pct(feitos, total)}%)</div></div>
        <div class="kpi"><div class="kpi-n">${nf(falta)}</div><div class="kpi-l">faltam</div></div>
        <div class="kpi"><div class="kpi-n ${necessario > ritmo ? 'amber' : ''}">${nf(necessario)}</div><div class="kpi-l">por dia útil para fechar em ${new Date(CFG.prazoFinal + 'T12:00').toLocaleDateString('pt-BR')} (${nf(du)} dias úteis)</div></div>
        <div class="kpi"><div class="kpi-n">${ritmo.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}</div><div class="kpi-l">por dia útil nos últimos 10 · nesse ritmo fecha ${previsao.includes('depois') ? previsao : 'em ' + previsao}</div></div>
        <div class="kpi"><div class="kpi-n red">${nf(anom.urgente)}</div><div class="kpi-l">anomalias urgentes</div></div>
        <div class="kpi"><div class="kpi-n amber">${nf(anom['6meses'])}</div><div class="kpi-l">anomalias até 6 meses</div></div>
        <div class="kpi"><div class="kpi-n">${nf(anom.dez2027)}</div><div class="kpi-l">anomalias até dez/2027</div></div>
        <div class="kpi"><div class="kpi-n">${nf(ok)}</div><div class="kpi-l">sem anomalia · ${nf(outros)} não localizados ou sem acesso</div></div>
      </div>
      <div class="bloco"><div class="config-title">Por local</div><div class="tabela-wrap"><table class="t"><tr><th>Local</th><th>Estruturas</th><th>Inspecionadas</th><th>%</th></tr>
        ${Object.entries(porLocal).map(([l, v]) => `<tr><td>${esc(l)}</td><td class="n">${nf(v.n)}</td><td class="n">${nf(v.f)}</td><td class="n">${pct(v.f, v.n)}%</td></tr>`).join('')}</table></div></div>
      <div class="bloco"><div class="config-title">Técnicos</div><div class="tabela-wrap"><table class="t"><tr><th>Técnico</th><th>Total</th><th>Últimos 10 dias úteis</th></tr>
        ${[...porTec].sort((a, b) => b[1].total - a[1].total).map(([t, v]) => `<tr><td>${esc(t)}</td><td class="n">${nf(v.total)}</td><td class="n">${nf(v.j)}</td></tr>`).join('') || '<tr><td colspan="3">Nenhuma inspeção ainda.</td></tr>'}</table></div></div>
      <div class="bloco"><div class="config-title">Lista de manutenção (anomalias)</div>
        <div class="filtros"><select id="pm-prio"><option value="">Todas as prioridades</option>${Object.entries(PRIO).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <select id="pm-item"><option value="">Todos os itens</option>${ITENS.map(x => `<option value="${x.id}">${x.nome}</option>`).join('')}</select>
          <button class="btn-export" id="pm-csv">Baixar CSV</button></div>
        <div id="pm-lista"><p class="ajuda">Carregando…</p></div></div>
      <div class="bloco"><div class="config-title">Distribuir quadras</div>
        <p class="ajuda">Marque as quadras na tabela, escreva o técnico e o PIN do gestor. Deixe o técnico vazio para devolver a quadra.</p>
        <div class="filtros"><input id="pa-tec" list="pa-tecs" placeholder="Técnico" maxlength="60"><datalist id="pa-tecs">${tecnicos.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
          <input id="pa-pin" type="password" inputmode="numeric" placeholder="PIN do gestor" maxlength="12" style="width:120px">
          <button class="btn-export" id="pa-atribui">Atribuir <span id="pa-n">0</span></button>
          <button class="btn-export sec" id="pa-limpa">Limpar seleção</button></div>
        <div class="filtros"><select id="pa-fl"><option value="">Todos os locais</option><option>Palmas</option><option>Taquaralto</option></select>
          <select id="pa-ft"><option value="">Todas</option><option value="livre">Sem técnico</option><option value="prog">Só da programação</option><option value="fora">Só fora da programação</option></select></div>
        <div class="tabela-wrap alta"><table class="t" id="pa-tab"><thead><tr><th></th><th>Quadra</th><th>Técnico</th><th>Estruturas</th><th>Feitas</th><th>%</th></tr></thead><tbody></tbody></table></div></div>`;

    const desenhaTab = () => {
      const fl = $('pa-fl').value, ft = $('pa-ft').value;
      const ls = linhasQ.filter(x => (!fl || x.q.local === fl) && (!ft || (ft === 'livre' ? !x.tec : ft === 'prog' ? x.q.tipo === 'programacao' : x.q.tipo === 'fora')));
      $('pa-tab').querySelector('tbody').innerHTML = ls.map(x => `<tr><td><input type="checkbox" data-q="${esc(x.q.id)}" ${painelSel.has(x.q.id) ? 'checked' : ''}></td><td><b>${esc(x.q.nome)}</b><br><span class="q-meta">${x.q.id} · ${esc(x.q.local)}</span></td><td>${esc(x.tec) || '—'}</td><td class="n">${nf(x.n)}</td><td class="n">${nf(x.f)}</td><td class="n">${pct(x.f, x.n)}%</td></tr>`).join('');
      $('pa-tab').querySelectorAll('input').forEach(c => c.onchange = () => { if (c.checked) painelSel.add(c.dataset.q); else painelSel.delete(c.dataset.q); $('pa-n').textContent = painelSel.size; });
      $('pa-n').textContent = painelSel.size;
    };
    $('pa-fl').onchange = desenhaTab; $('pa-ft').onchange = desenhaTab; desenhaTab();
    $('pa-limpa').onclick = () => { painelSel.clear(); desenhaTab(); };
    $('pa-atribui').onclick = async () => {
      if (!painelSel.size) { toast('Marque as quadras primeiro.', 'error'); return; }
      const tec = norm($('pa-tec').value), pin = $('pa-pin').value;
      if (!pin) { toast('Digite o PIN do gestor.', 'error'); return; }
      try {
        const r = await sbJson('/rest/v1/rpc/pm_atribui', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin, quadras: [...painelSel], tecnico: tec, por: usuario }) });
        toast(`${r} quadra(s) ${tec ? 'para ' + tec : 'devolvida(s)'}.`, 'success');
        painelSel.clear(); await atualizaEstado(); redesenha(); desenhaPainel();
      } catch (e) { toast(/28000|PIN/.test(e.message) ? 'PIN do gestor não confere.' : 'Erro: ' + e.message, 'error'); }
    };
    ['pm-prio', 'pm-item'].forEach(id => $(id).onchange = () => { painelFiltro.prio = $('pm-prio').value; painelFiltro.item = $('pm-item').value; listaManutencao(); });
    $('pm-prio').value = painelFiltro.prio; $('pm-item').value = painelFiltro.item;
    $('pm-csv').onclick = baixaCsv;
    listaManutencao();
  }
  let ANOM = [];
  async function carregaAnomalias() {
    const linhas = await lePaginado('/rest/v1/pm_inspecoes?select=id,poste,quadra,alimentador,tecnico,prioridade,itens,obs,feito_em,criado_em,lat,lon,dist_m&resultado=eq.anomalia&order=id.desc');
    ANOM = linhas.filter(l => { const e = ESTADO.get(l.poste); return e && e.id === l.id; });   // só a anomalia que ainda é o estado do poste
    const ord = { urgente: 0, '6meses': 1, dez2027: 2 };
    ANOM.sort((a, b) => ord[a.prioridade] - ord[b.prioridade] || (a.criado_em < b.criado_em ? 1 : -1));
  }
  async function listaManutencao() {
    const box = $('pm-lista'); if (!box) return;
    try { await carregaAnomalias(); } catch (e) { box.innerHTML = '<p class="ajuda">Sem conexão para ler as anomalias.</p>'; return; }
    const ls = ANOM.filter(a => (!painelFiltro.prio || a.prioridade === painelFiltro.prio) && (!painelFiltro.item || a.itens.some(x => x.item === painelFiltro.item)));
    box.innerHTML = ls.length ? `<div class="tabela-wrap"><table class="t"><tr><th>Prioridade</th><th>Poste</th><th>O que tem</th><th>Técnico / data</th></tr>` +
      ls.slice(0, 500).map((a, k) => {
        const q = QUADRAS.find(x => x.id === a.quadra);
        const fotos = a.itens.flatMap(x => x.fotos || []);
        return `<tr><td><span class="tag ${a.prioridade === 'urgente' ? 'erro' : a.prioridade === '6meses' ? 'pend' : 'sync'}">${PRIO[a.prioridade]}</span></td>` +
          `<td><b>${esc(a.poste)}</b><br><span class="q-meta">${esc(q ? q.nome : a.quadra)}<br>${esc(a.alimentador)}</span><br><a href="#" data-ir="${esc(a.poste)}">ver no mapa</a></td>` +
          `<td>${a.itens.map(x => `<b>${esc(x.nome)}</b>${x.defeitos.length ? ': ' + esc(x.defeitos.join(', ')) : ''}${x.obs ? ' — ' + esc(x.obs) : ''} <span class="q-meta">(${PRIO[x.prioridade]})</span>`).join('<br>')}${a.obs ? '<br><i>' + esc(a.obs) + '</i>' : ''}` +
          `${fotos.length ? `<div class="fotos-mini" data-fotos="${esc(JSON.stringify(fotos))}"><button class="btn-export sec" data-vf="${k}">ver ${fotos.length} foto(s)</button></div>` : ''}</td>` +
          `<td>${esc(a.tecnico)}<br><span class="q-meta">${dataBR(a.feito_em || a.criado_em)}</span></td></tr>`;
      }).join('') + '</table></div>' + (ls.length > 500 ? `<p class="ajuda">Mostrando 500 de ${nf(ls.length)}. O CSV traz todas.</p>` : '')
      : '<p class="ajuda">Nenhuma anomalia com esse filtro.</p>';
    box.querySelectorAll('[data-ir]').forEach(a => a.onclick = ev => { ev.preventDefault(); const i = IDX.get(a.dataset.ir); if (i == null) return; abreAba('mapa'); map.setView([POSTES[i][1], POSTES[i][2]], 18); abreFicha(i); });
    box.querySelectorAll('[data-vf]').forEach(b => b.onclick = async () => {
      const wrap = b.parentElement, fotos = JSON.parse(wrap.dataset.fotos); b.textContent = 'carregando…';
      const urls = await Promise.all(fotos.map(p => baixaFoto(p).catch(() => null)));
      wrap.innerHTML = urls.map(u => u ? `<img src="${u}" alt="foto">` : '<span class="q-meta">foto indisponível</span>').join('');
      wrap.querySelectorAll('img').forEach(im => im.onclick = () => { const o = document.createElement('div'); o.className = 'foto-grande'; o.innerHTML = `<img src="${im.src}" alt="">`; o.onclick = () => o.remove(); document.body.appendChild(o); });
    });
  }
  function baixaCsv() {
    const cab = ['prioridade', 'poste', 'quadra', 'nome_quadra', 'local', 'alimentador', 'item', 'defeitos', 'prioridade_item', 'obs_item', 'obs_geral', 'fotos', 'tecnico', 'data', 'lat_poste', 'lon_poste', 'mapa'];
    const linhas = [cab.join(';')];
    const c = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    for (const a of ANOM.filter(a => (!painelFiltro.prio || a.prioridade === painelFiltro.prio) && (!painelFiltro.item || a.itens.some(x => x.item === painelFiltro.item)))) {
      const i = IDX.get(a.poste), p = i != null ? POSTES[i] : null, q = QUADRAS.find(x => x.id === a.quadra);
      for (const x of a.itens) {
        if (painelFiltro.item && x.item !== painelFiltro.item) continue;
        linhas.push([PRIO[a.prioridade], a.poste, a.quadra, q ? q.nome : '', q ? q.local : '', a.alimentador, x.nome, x.defeitos.join(', '), PRIO[x.prioridade], x.obs, a.obs,
          (x.fotos || []).map(fotoUrl).join(' '), a.tecnico, dataBR(a.feito_em || a.criado_em), p ? p[1] : '', p ? p[2] : '',
          p ? `https://www.google.com/maps?q=${p[1]},${p[2]}` : ''].map(c).join(';'));
      }
    }
    const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `manutencao_mt_palmas_${isoDia(new Date())}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ── início ────────────────────────────────────────────────────────────────────────────────────
  function entra() {
    $('login-screen').hidden = true; $('app').hidden = false;
    $('h-user').textContent = usuario;
  }
  async function inicia() {
    $('l-versao').textContent = 'VERSÃO ' + CFG.versao;
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js?v=' + CFG.versao).catch(() => {});
    $('l-entrar').onclick = () => {
      const n = norm($('l-nome').value);
      if (n.length < 3 || !/\s/.test(n)) { $('l-erro').textContent = 'Escreva nome e sobrenome.'; return; }
      usuario = n; guarda('pm_tecnico', n); entra(); setTimeout(() => map && map.invalidateSize(), 60); redesenha();
    };
    $('l-nome').onkeydown = e => { if (e.key === 'Enter') $('l-entrar').click(); };
    $('h-sair').onclick = () => { if (!confirm('Trocar de técnico neste celular?')) return; guarda('pm_tecnico', null); usuario = ''; $('app').hidden = true; $('login-screen').hidden = false; $('l-nome').value = ''; };
    document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => abreAba(b.dataset.tab));
    $('s-fechar').onclick = fechaFicha; $('sheet').onclick = e => { if (e.target === $('sheet')) fechaFicha(); };
    $('f-voltar').onclick = () => { if (confirm('Sair sem salvar a anomalia?')) $('form').hidden = true; };
    $('f-salvar').onclick = salvaForm;
    $('r-sync').onclick = () => sincroniza(true);
    addEventListener('online', () => { atualizaBarra(); sincroniza(false); });
    addEventListener('offline', () => atualizaBarra());

    if (usuario) entra();
    let rede;
    try { rede = await carregaBase(); } catch (e) { toast('Não consegui carregar a base: ' + e.message, 'error'); return; }
    try { for (const [k, v] of JSON.parse(guarda('pm_rotas') || '[]')) ROTAS.set(k, v); } catch (e) { /* nada */ }
    await carregaEstadoLocal().catch(() => {});
    iniciaMapa(rede);
    const qs = guarda('pm_quadra'); const qi = QUADRAS.findIndex(q => q.id === qs); if (qi >= 0) selecionaQuadra(qi);
    iniciaGps();
    atualizaBarra((await filaTodas().catch(() => [])).filter(f => f.status !== 'enviado').length);
    atualizaEstado().then(() => redesenha()).catch(() => {});
    sincroniza(false);
    setInterval(() => { sincroniza(false); }, 120000);
    setInterval(() => { atualizaEstado().then(m => { if (m) redesenha(); }).catch(() => {}); }, 300000);
    window.__pm = { POSTES, QUADRAS, ESTADO, LOCAL, ROTAS, sincroniza, abreFicha, selecionaQuadra, map: () => map };
  }
  inicia();
})();
