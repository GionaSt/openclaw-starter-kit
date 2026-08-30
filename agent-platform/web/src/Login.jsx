import React, { useState } from 'react';
import { setToken, setUser } from './api.js';

export default function Login({ onDone }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!username || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error(data?.error ?? `Errore server (${resp.status})`);
      setToken(data.token);
      setUser(data.user);
      onDone(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page login">
      <form className="card login-card" onSubmit={submit}>
        <span className="card-icon">🔐</span>
        <strong>⚡ Operating System</strong>
        <input
          type="text"
          value={username}
          placeholder="Nome utente"
          autoFocus
          autoCapitalize="none"
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          value={password}
          placeholder="Password"
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !username || !password}>{busy ? '…' : 'Entra'}</button>
      </form>
    </main>
  );
}
