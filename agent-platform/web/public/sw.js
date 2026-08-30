// Service worker: cache-first per gli asset statici, network-only per /api,
// fallback offline sulla shell (niente schermata bianca), gestione notifiche push.
//
// Aggiornamento SENZA stale cache: niente skipWaiting() automatico in install
// (lascerebbe un mix di tab vecchie/nuove attive insieme). Il nuovo SW resta
// "waiting" finché il client non chiede esplicitamente l'update (messaggio
// SKIP_WAITING, vedi src/sw-register.js + il toast "Nuova versione"): solo
// allora attiva, elimina le cache vecchie, e il client ricarica.
const CACHE = 'agent-platform-v6';
const SHELL_URL = '/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([SHELL_URL, '/manifest.json'])));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Il client manda questo messaggio (dopo conferma utente in UI) per attivare
// subito il SW in attesa.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api')) return;

  // Navigazioni (apertura/refresh pagina, anche con query string tipo
  // ?decision=... dal tap su una push): se la rete fallisce (offline) serve la
  // shell dalla cache invece della pagina d'errore del browser.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          const copy = resp.clone();
          if (resp.ok) caches.open(CACHE).then((c) => c.put(SHELL_URL, copy));
          return resp;
        })
        .catch(() => caches.match(SHELL_URL, { ignoreSearch: true }))
    );
    return;
  }

  // JavaScript, CSS e worker devono preferire sempre la rete. Una shell nuova
  // che riceve per errore un asset precedente può montare una UI ibrida anche
  // dopo un hard refresh, perché il service worker intercetta le subresource.
  // La cache resta solo come fallback offline.
  if (['script', 'style', 'worker'].includes(e.request.destination)) {
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          const copy = resp.clone();
          if (resp.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Niente `.catch(() => hit)` qui: si entra nel ramo fetch() solo quando hit
  // è falsy, quindi quel catch risolverebbe sempre a `undefined` e respondWith
  // lancerebbe un TypeError invece del normale errore di rete. Se offline su
  // una risorsa non in cache, l'errore di fetch() propaga così com'è.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((resp) => {
        const copy = resp.clone();
        if (resp.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
        return resp;
      });
    })
  );
});

// ---- Notifiche push ----
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() ?? {}; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title ?? 'Agent Platform', {
      body: data.body ?? '',
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // requireInteraction: una decisione resta finché non la si guarda (iOS la
      // mostra comunque; su desktop non sparisce da sola).
      requireInteraction: Boolean(data.decision),
      data: { tenantId: data.tenantId, decision: data.decision ?? null },
    })
  );
});

// Tap sulla notifica: se porta una "decision" apre il popup dedicato nella PWA
// (schermata della singola cosa da decidere), altrimenti apre l'app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const dec = e.notification.data?.decision || null;
  // tenantId nell'URL: serve al deep-link a freddo (app chiusa) per selezionare
  // il business giusto prima di aprire progetto/decisione.
  const target = dec ? `/?decision=${encodeURIComponent(`${dec.kind}:${dec.id}:${dec.tenantId ?? ''}`)}` : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.focus();
          // La PWA è già aperta: le dico di aprire il popup su questa decisione.
          w.postMessage({ type: 'open-decision', decision: dec });
          return undefined;
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
