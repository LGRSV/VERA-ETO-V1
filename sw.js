// Plano Manutenção ETO. Funciona sem internet: guarda o app, a base e os ladrilhos do mapa já vistos.
const VERSAO = 'pm-1.0.1';
const APP = ['./', 'index.html', 'app.css', 'app.js', 'config.js', 'manifest.json', 'dados/base.json?v=1.0.1', 'dados/rede.json?v=1.0.1',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'];
const LADRILHOS = 'pm-ladrilhos';
const MAX_LADRILHOS = 4000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO && k !== LADRILHOS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname.endsWith('supabase.co')) return;                                    // dados vivos: sempre na rede
  if (/tile\.openstreetmap\.org|google\.com\/vt/.test(u.href)) {                     // mapa: o que já foi visto fica guardado
    e.respondWith(caches.open(LADRILHOS).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const r = await fetch(e.request);
        if (r.ok || r.type === 'opaque') {
          c.put(e.request, r.clone());
          c.keys().then(ks => { if (ks.length > MAX_LADRILHOS) ks.slice(0, ks.length - MAX_LADRILHOS).forEach(k => c.delete(k)); });
        }
        return r;
      } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  // app e base: rede primeiro (pega versão nova), cache se estiver sem internet
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && (u.origin === location.origin || u.hostname === 'cdnjs.cloudflare.com')) caches.open(VERSAO).then(c => c.put(e.request, r.clone()));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: u.pathname.endsWith('.json') ? false : true }).then(r => r || caches.match('index.html'))));
});
