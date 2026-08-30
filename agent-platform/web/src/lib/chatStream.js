// Consumo dello stream SSE di /api/chat + supporto all'invio di un messaggio.
// Estratto da Chat.jsx (task 0d45535e — send() era un unico handler da 140
// righe/ciclomatica ~31; MOVE puro, zero cambi di comportamento).

// Lettura incrementale del ReadableStream della risposta fetch: decoder +
// split degli eventi SSE (delimitati da riga vuota), parsing del payload
// `data: `, skip degli eventi malformati (non uccide lo stream), dispatch
// al callback giusto in `handlers` per tipo evento. Flush finale dei byte
// residui del decoder a fine stream.
export async function consumeChatStream(response, handlers = {}) {
  const { onRun, onDelta, onReset, onError, onStopped, onDone, onQueued } = handlers;

  const handleEvent = (ev) => {
    const line = ev.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return;
    let data;
    try { data = JSON.parse(line.slice(6)); } catch { return; } // evento malformato: si salta, non si uccide lo stream
    if (data.type === 'delta') onDelta?.(data);
    else if (data.type === 'run') onRun?.(data);
    else if (data.type === 'stopped') onStopped?.(data);
    else if (data.type === 'reset') onReset?.(data);
    else if (data.type === 'done') onDone?.(data);
    else if (data.type === 'error') onError?.(data);
    // Sessione già occupata da un altro turno (task 311d2946): il messaggio è
    // stato accodato su disco invece di avviare un turno parallelo — nessuna
    // bolla assistant per questa chiamata, vedi Chat.jsx (task 13aad6c3).
    else if (data.type === 'queued') onQueued?.(data);
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const ev of events) handleEvent(ev);
  }
  buffer += decoder.decode(); // flush dei byte residui
  if (buffer.trim()) handleEvent(buffer);
}

// Accumulo dei delta con flush a requestAnimationFrame: un solo re-render
// per frame anche con chunk fittissimi, ordine e completezza garantiti
// (l'append avviene in un unico punto, in ordine di arrivo). `onFlush(text)`
// riceve il testo accumulato dall'ultimo flush.
export function createDeltaBuffer(onFlush) {
  let pending = '';
  let raf = 0;
  const flush = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!pending) return;
    const t = pending;
    pending = '';
    onFlush(t);
  };
  const push = (text) => {
    pending += text;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const reset = () => { pending = ''; };
  return { push, flush, reset };
}

// Normalizza input testuale + allegati per l'invio: trim del messaggio,
// stato "uploading" in corso, lista allegati pronti (status 'done'), e i
// due mapping derivati — payload per il server (solo i campi che servono
// all'API, niente stato locale di UI) e copia per la bolla utente in UI.
export function buildOutgoingMessage(input, attachments) {
  const message = input.trim();
  const uploading = attachments.some((a) => a.status === 'uploading');
  const ready = attachments.filter((a) => a.status === 'done');
  const attachPayload = ready.map(({ id, name, stored, type, kind, size, url }) => ({ id, name, stored, type, kind, size, url }));
  const attachForBubble = ready.map((a) => ({ ...a }));
  return { message, uploading, ready, attachPayload, attachForBubble };
}
