import React from 'react';
import OperatingSystem from './OperatingSystem.jsx';

export default function TenantHome({ user, tenant, onBack, initialProjectId = null, onInitialProjectConsumed = () => {} }) {
  return (
    <div className="os-tenant-shell" style={{ '--accent': tenant.color }}>
      <header className="topbar os-tenant-topbar">
        <button className="back" onClick={onBack}>←</button>
        <div className="os-tenant-title">
          <h1>{tenant.icon} {tenant.name}</h1>
          <small>⚡ Operating System</small>
        </div>
      </header>
      <OperatingSystem user={user} tenant={tenant} initialProjectId={initialProjectId} onInitialProjectConsumed={onInitialProjectConsumed} />
    </div>
  );
}
