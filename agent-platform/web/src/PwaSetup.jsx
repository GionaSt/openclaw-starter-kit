import React, { useEffect, useState } from 'react';
import { ensurePushSubscription } from './api.js';

// Installabilità A2HS + attivazione push, in un'unica barra in-flow (non
// position:fixed: l'audit mobile fa4ab564 ha già segnalato troppi FAB fissi
// sovrapposti al composer — questa sta sopra il contenuto, non ci si somma).
// Due momenti, uno alla volta:
//  1. non ancora installata -> istruzioni A2HS (iOS Safari, niente
//     beforeinstallprompt: Condividi -> Aggiungi a Home) o bottone nativo
//     (Android/Chrome, cattura beforeinstallprompt).
//  2. installata (o browser non-iOS, dove il push non richiede l'installazione)
//     e permesso non ancora chiesto -> bottone "Attiva notifiche": la richiesta
//     DEVE partire da un gesto utente, mai in automatico al login (requisito
//     duro iOS 16.4+: Notification.requestPermission() fuori da un gesto viene
//     ignorato/negato silenziosamente in standalone).
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches
  || window.navigator.standalone === true;
const pushSupported = () => 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

export default function PwaSetup({ user }) {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [installDismissed, setInstallDismissed] = useState(() => localStorage.getItem('pwa-install-dismissed') === '1');
  const [pushDismissed, setPushDismissed] = useState(() => localStorage.getItem('pwa-push-dismissed') === '1');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushGranted, setPushGranted] = useState(() => pushSupported() && Notification.permission === 'granted');

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setDeferredPrompt(e); };
    const onInstalled = () => { setInstalled(true); setDeferredPrompt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!user) return null;

  // ---- Step 1: installazione ----
  if (!installed && !installDismissed) {
    const dismiss = () => { localStorage.setItem('pwa-install-dismissed', '1'); setInstallDismissed(true); };
    if (isIOS()) {
      return (
        <div className="pwa-banner">
          <span className="pwa-banner-icon" aria-hidden="true">📲</span>
          <span className="pwa-banner-text">
            Installa l'app: tocca <strong>Condividi</strong> (□↑) poi <strong>"Aggiungi a Home"</strong>.
          </span>
          <button className="pwa-banner-x" onClick={dismiss} aria-label="Chiudi">✕</button>
        </div>
      );
    }
    if (deferredPrompt) {
      return (
        <div className="pwa-banner">
          <span className="pwa-banner-icon" aria-hidden="true">📲</span>
          <span className="pwa-banner-text">Installa l'app sulla home per un accesso più veloce.</span>
          <button
            className="pwa-banner-action"
            onClick={async () => {
              const dp = deferredPrompt;
              setDeferredPrompt(null);
              dp.prompt();
              await dp.userChoice.catch(() => {});
            }}
          >
            Installa
          </button>
          <button className="pwa-banner-x" onClick={dismiss} aria-label="Chiudi">✕</button>
        </div>
      );
    }
    // Browser senza beforeinstallprompt e non-iOS (es. desktop non Chromium):
    // nessun percorso di installazione affidabile, niente banner.
  }

  // ---- Step 2: notifiche push (iOS: solo da app installata) ----
  const canOfferPush = pushSupported() && Notification.permission === 'default' && !pushGranted
    && (!isIOS() || installed);
  if (canOfferPush && !pushDismissed) {
    const dismiss = () => { localStorage.setItem('pwa-push-dismissed', '1'); setPushDismissed(true); };
    return (
      <div className="pwa-banner">
        <span className="pwa-banner-icon" aria-hidden="true">🔔</span>
        <span className="pwa-banner-text">Attiva le notifiche per decisioni e richieste urgenti.</span>
        <button
          className="pwa-banner-action"
          disabled={pushBusy}
          onClick={async () => {
            setPushBusy(true);
            await ensurePushSubscription();
            setPushBusy(false);
            setPushGranted(pushSupported() && Notification.permission === 'granted');
            dismiss();
          }}
        >
          {pushBusy ? '...' : 'Attiva'}
        </button>
        <button className="pwa-banner-x" onClick={dismiss} aria-label="Chiudi">✕</button>
      </div>
    );
  }

  return null;
}
