// Registrazione service worker + rilevazione aggiornamenti, SENZA cache stale:
// il nuovo SW installato resta "in attesa" (vedi public/sw.js, niente
// skipWaiting automatico) finché l'utente non conferma dal toast "Nuova
// versione" in App.jsx. Segnala l'update disponibile con un CustomEvent così
// App.jsx non deve importare/gestire la Registration direttamente.

// Flag a livello di modulo: distingue un controllerchange dovuto a un update
// REALE confermato dall'utente (applyServiceWorkerUpdate) da quello che scatta
// comunque alla primissima installazione (self.clients.claim() nell'
// 'activate' di sw.js fa scattare controllerchange anche senza controller
// precedente). Senza questa distinzione si ottiene un reload spurio a ogni
// prima visita/incognito/"clear site data".
let updating = false;
let reloaded = false;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const notifyUpdate = (reg) => window.dispatchEvent(new CustomEvent('sw-update-available', { detail: reg }));

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await reg.update();
      // Un SW è già "in attesa" al momento della registrazione (tab aperta da
      // prima del deploy successivo).
      if (reg.waiting && navigator.serviceWorker.controller) notifyUpdate(reg);
      reg.addEventListener('updatefound', () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener('statechange', () => {
          // 'installed' + già un controller attivo = è un update (non la prima
          // installazione): il nuovo SW aspetta conferma prima di attivarsi.
          if (fresh.state === 'installed' && navigator.serviceWorker.controller) notifyUpdate(reg);
        });
      });
    } catch (err) {
      console.warn('service worker non registrato:', err.message);
    }
  });

  // Quando il nuovo SW prende controllo ricarica una volta sola per caricare
  // la shell/asset aggiornati — ma solo dopo un update confermato (vedi
  // applyServiceWorkerUpdate sotto), non alla prima installazione.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updating || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

// Chiamata dal click su "Aggiorna" nel toast: arma il reload sopra e dice al
// SW in attesa di attivarsi.
export function applyServiceWorkerUpdate(reg) {
  updating = true;
  reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
}
