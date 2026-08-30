import React, { useEffect, useState } from 'react';
import TenantPicker from './TenantPicker.jsx';
import TenantHome from './TenantHome.jsx';
import Login from './Login.jsx';
import PwaSetup from './PwaSetup.jsx';
import { applyServiceWorkerUpdate } from './sw-register.js';
import { getToken, getUser, logout } from './api.js';

export default function App() {
  const [user, setUser] = useState(() => (getToken() ? getUser() : null));
  const [tenant, setTenant] = useState(null);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [swUpdate, setSwUpdate] = useState(null);
  // Deep-link dal tap su una push di chat progetto: ?decision=project:<id>:<tenantId>
  // (app chiusa) oppure postMessage 'open-decision' dal service worker (app aperta).
  const [pendingProject, setPendingProject] = useState(() => {
    const raw = new URLSearchParams(window.location.search).get('decision');
    if (!raw) return null;
    window.history.replaceState({}, '', '/');
    const [kind, id, tenantId] = raw.split(':');
    return kind === 'project' && id && tenantId ? { id, tenantId } : null;
  });

  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return undefined;
    const onMessage = (event) => {
      const dec = event.data?.type === 'open-decision' ? event.data.decision : null;
      if (dec?.kind === 'project' && dec.id && dec.tenantId) setPendingProject({ id: dec.id, tenantId: dec.tenantId });
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, []);

  // Se la push riguarda un altro business, torna al picker che auto-seleziona.
  useEffect(() => {
    if (pendingProject && tenant && tenant.id !== pendingProject.tenantId) setTenant(null);
  }, [pendingProject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const syncHeight = () => document.documentElement.style.setProperty('--vvh', `${viewport.height}px`);
    syncHeight();
    viewport.addEventListener('resize', syncHeight);
    viewport.addEventListener('scroll', syncHeight);
    return () => {
      viewport.removeEventListener('resize', syncHeight);
      viewport.removeEventListener('scroll', syncHeight);
    };
  }, []);

  useEffect(() => {
    const onUpdate = (event) => setSwUpdate(event.detail);
    window.addEventListener('sw-update-available', onUpdate);
    return () => window.removeEventListener('sw-update-available', onUpdate);
  }, []);

  let view;
  if (!user) view = <Login onDone={setUser} />;
  else if (!tenant) view = <TenantPicker user={user} onSelect={setTenant} onLogout={logout} autoSelectId={pendingProject?.tenantId} />;
  else view = <TenantHome user={user} tenant={tenant} onBack={() => setTenant(null)} initialProjectId={tenant.id === pendingProject?.tenantId ? pendingProject.id : null} onInitialProjectConsumed={() => setPendingProject(null)} />;

  return (
    <div className="app os-exclusive-app">
      {!online && <div className="offline-banner">📴 Sei offline. Riprovo appena torna la connessione.</div>}
      {swUpdate && (
        <div className="sw-update-toast">
          <span className="pwa-banner-icon">⟳</span>
          <span className="pwa-banner-text">Nuova versione disponibile.</span>
          <button className="pwa-banner-action" onClick={() => applyServiceWorkerUpdate(swUpdate)}>Aggiorna</button>
        </div>
      )}
      {!swUpdate && user && !tenant && <PwaSetup user={user} />}
      {view}
    </div>
  );
}
