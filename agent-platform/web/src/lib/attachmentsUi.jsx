// UI condivisa degli allegati (task B3): chip con anteprima/rimozione, mapping
// dei tipi accettati e upload autenticato. Estratta da Chat.jsx per riusarla
// nella chat di progetto V2 (OperatingSystem.jsx) senza duplicare la logica di
// anteprima immagini via fetch autenticato.
import React, { useEffect, useState } from 'react';
import { authFetch } from '../api.js';

// Tipi file accettati per gli allegati (deve combaciare con l'allowlist server
// in server/lib/uploads.js).
export const ACCEPT_ATTR = 'image/*,application/pdf,text/plain,text/markdown,text/csv,.md,.markdown,.csv,.txt';

// Limite lato server (MAX_UPLOAD_BYTES): usato per un errore leggibile PRIMA di
// sprecare l'upload quando il file è palesemente troppo grande.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// MIME da inviare al server: alcuni browser danno type vuoto o generico per
// .md/.csv → si deduce dall'estensione.
export function fileTypeFor(file) {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (file.type === 'application/vnd.ms-excel' && ext === 'csv') return 'text/csv';
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  return { md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', txt: 'text/plain' }[ext]
    ?? file.type ?? 'application/octet-stream';
}

export function humanSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Upload di un singolo file su un endpoint raw (POST body = file). Ritorna il
// metadata salvato dal server; lancia Error con il messaggio del server (già
// leggibile: "file troppo grande (max 20MB)", "tipo file non supportato: …").
export async function uploadAttachment(endpoint, file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`file troppo grande (${humanSize(file.size)}, max ${humanSize(MAX_UPLOAD_BYTES)})`);
  }
  const resp = await authFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': fileTypeFor(file), 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.error ?? `HTTP ${resp.status}`);
  return data;
}

// Miniatura/chip di un allegato. Le immagini si caricano via fetch autenticato
// (l'<img src> non può portare il token) trasformando la risposta in object URL;
// per gli allegati appena scelti (non ancora inviati) si usa il previewUrl locale.
export function AttachmentChip({ att, onRemove }) {
  const [thumb, setThumb] = useState(att.previewUrl ?? null);
  useEffect(() => {
    if (att.previewUrl) { setThumb(att.previewUrl); return; }
    if (att.kind !== 'image' || !att.url) return;
    let obj;
    authFetch(att.url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b) { obj = URL.createObjectURL(b); setThumb(obj); } })
      .catch(() => {});
    return () => { if (obj) URL.revokeObjectURL(obj); };
  }, [att.url, att.previewUrl, att.kind]);

  async function open() {
    if (!att.url) return;
    try {
      const r = await authFetch(att.url);
      if (!r.ok) return;
      const url = URL.createObjectURL(await r.blob());
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* apertura best-effort */ }
  }

  const icon = att.kind === 'pdf' ? '📄' : att.kind === 'text' ? '📝' : '📎';
  return (
    <div className={`attachment ${att.status === 'error' ? 'att-error' : ''}`} title={att.error || att.name}>
      <button type="button" className="att-body" onClick={open}>
        {thumb ? <img className="att-thumb" src={thumb} alt={att.name} /> : <span className="att-icon">{icon}</span>}
        <span className="att-meta">
          <span className="att-name">{att.name}</span>
          <small className="muted">
            {att.status === 'uploading' ? 'caricamento…' : att.status === 'error' ? (att.error || 'errore') : humanSize(att.size)}
          </small>
        </span>
      </button>
      {onRemove && <button type="button" className="att-x" title="Rimuovi" onClick={onRemove}>×</button>}
    </div>
  );
}
