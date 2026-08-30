// Comportamento condiviso del tasto Enter nei campi di composizione messaggio
// (chat agente, popup "Da decidere"/richieste, ecc.), decisione Owner 2026-07-24:
// - touch/mobile: Enter = SEMPRE a capo, mai invio. Invio solo col bottone ➤.
// - desktop: Enter = invia, Shift+Enter = a capo (standard).
//
// Rilevamento "è touch" via media query pointer/hover (non user-agent sniffing,
// fragile e facilmente falsato da iPadOS/desktop mode ecc.): pointer:coarse è lo
// standard per "il puntatore primario è un dito, non un mouse/trackpad preciso".
export function isTouchPrimary() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

// Da passare a onKeyDown della textarea del composer. `onSubmit` viene chiamato
// solo quando l'Enter deve davvero inviare (desktop, senza Shift, non IME).
export function handleComposerKeyDown(e, onSubmit) {
  if (e.key !== 'Enter') return;
  if (e.nativeEvent?.isComposing) return; // non intercettare la conferma IME
  if (isTouchPrimary()) return; // mobile/touch: sempre a capo, mai invio
  if (e.shiftKey) return; // desktop: Shift+Enter = a capo
  e.preventDefault();
  onSubmit();
}
