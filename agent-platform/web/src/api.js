// Fetch autenticato: aggiunge il token e su 401 rimanda al login.
export const getToken = () => localStorage.getItem('auth-token');
export const setToken = (t) => localStorage.setItem('auth-token', t);
export const getUser = () => {
  try { return JSON.parse(localStorage.getItem('auth-user')); } catch { return null; }
};
export const setUser = (u) => localStorage.setItem('auth-user', JSON.stringify(u));

export function logout() {
  localStorage.removeItem('auth-token');
  localStorage.removeItem('auth-user');
  window.location.reload();
}

export async function authFetch(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...(options.headers ?? {}), Authorization: `Bearer ${getToken() ?? ''}` },
  });
  if (resp.status === 401) {
    logout();
    throw new Error('non autenticato');
  }
  return resp;
}

export async function apiJson(url, options = {}) {
  const resp = await authFetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: options.body !== undefined && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
  return data;
}

// Ruoli con permessi di gestione (task, approvazioni, schedulazioni).
export const canManage = (user) => user && (user.role === 'admin' || user.role === 'manager');

// Registra la subscription push per l'utente corrente (best-effort: se i permessi
// vengono negati o il browser non supporta il push, semplicemente non fa nulla).
export async function ensurePushSubscription() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await apiJson('/api/push/vapid-key');
      // Conversione base64url -> Uint8Array per compatibilità con tutti i browser.
      const pad = '='.repeat((4 - (key.length % 4)) % 4);
      const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
      const appKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appKey,
      });
    }
    await apiJson('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch (err) {
    console.warn('push non attivato:', err.message);
  }
}

// WebSocket autenticato con riconnessione automatica. Ritorna una funzione di chiusura.
// onReconnect (opzionale) viene chiamato quando il socket si riapre dopo una caduta:
// i broadcast persi durante il buco non arrivano più, il chiamante deve ricaricare lo stato.
export function openWs(onMessage, onReconnect) {
  let ws;
  let closed = false;
  let retry;
  let everConnected = false;
  const connect = () => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(getToken() ?? '')}`);
    ws.onopen = () => {
      if (everConnected && onReconnect) { try { onReconnect(); } catch {} }
      everConnected = true;
    };
    ws.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch {}
    };
    ws.onclose = () => {
      if (!closed) retry = setTimeout(connect, 3000);
    };
  };
  connect();
  return () => { closed = true; clearTimeout(retry); ws?.close(); };
}
