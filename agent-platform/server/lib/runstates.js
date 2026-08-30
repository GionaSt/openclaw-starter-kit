// Macchina a stati UNICA delle run agente — unica fonte di verità condivisa tra
// server (journal/watchdog/endpoint) e UI (web/src/LiveAgents.jsx ne tiene un
// mirror di sola presentazione: label/icone/ordine, NIENTE logica di stato).
//
// Stati e significato:
//   running     — sta girando in questo processo
//   resumed     — il watchdog l'ha appena rimessa in moto (transitorio verso running)
//   interrupted — caduta (errore/limite/riavvio) o ripresa manuale richiesta:
//                 riparte DA SOLA al maturare del backoff (watchdog)
//   paused      — messa in pausa dall'utente (sticky): NON riparte da sola, ma è
//                 pensata per la ripresa; con resumeAt (pausa a tempo) la riprende
//                 il watchdog al primo tick dopo resumeAt
//   stopped     — fermata dall'utente (sticky): non riparte mai da sola
//   completed   — finita con successo (terminale)
//   failed      — fallita definitivamente (terminale)
//
// INVARIANTE (bug a3d510cb): una run "paused" preserva lo stato riprendibile
// INDEFINITAMENTE. Non decade mai a failed per mancanza di heartbeat: il
// watchdog (failStaleExternal/listResumable) non tocca gli stati sticky, e
// journalInterrupt/journalFail sono no-op su di essi. La pausa sospende gli
// heartbeat ma preserva lo stato.

export const RUN_STATES = [
  'running', 'resumed', 'interrupted', 'paused', 'stopped', 'completed', 'failed',
];

// Classi di stato (insiemi disgiunti che coprono RUN_STATES):
export const TERMINAL_STATES = new Set(['completed', 'failed']);   // fine vita, non riprendibile
export const STICKY_STATES = new Set(['stopped', 'paused']);       // ferma per volere utente, riprendibile
export const RUNNING_STATES = new Set(['running', 'resumed']);     // gira / si sta riavviando ORA
export const PENDING_STATES = new Set(['interrupted']);            // riparte da sola (watchdog)

export function isTerminalStatus(s) { return TERMINAL_STATES.has(s); }
// Sticky: vince sugli eventi di interrupt/fail generati dalla terminazione del
// processo (la run resta ferma finché non è l'utente — o il watchdog per le
// pause a tempo — a riprenderla).
export function isStickyStatus(s) { return STICKY_STATES.has(s); }
export function isRunningStatus(s) { return RUNNING_STATES.has(s); }
export function isPendingStatus(s) { return PENDING_STATES.has(s); }

// Transizioni valide documentate (da → insieme dei possibili verso). Usata come
// documentazione eseguibile e per canTransition; non è un gate imposto a ogni
// journalUpdate (troppo invasivo), ma la sorgente di verità di cosa è lecito.
export const TRANSITIONS = {
  running: ['completed', 'failed', 'interrupted', 'stopped', 'paused', 'resumed'],
  resumed: ['running', 'completed', 'failed', 'interrupted', 'stopped', 'paused'],
  interrupted: ['resumed', 'failed', 'stopped', 'paused'],
  paused: ['interrupted', 'resumed', 'stopped'], // resume manuale→interrupted; watchdog(pausa a tempo)→resumed
  stopped: ['interrupted'],                        // solo resume manuale
  completed: [],
  failed: [],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

// ---- Insiemi operativi (dispatcher/boardcheck) ----
// Task 81c7bbc8 (code-quality 2026-07-26): dispatcher.js e boardcheck.js
// duplicavano questi insiemi con nomi diversi (OCCUPIES_SLOT vs ACTIVE, stesso
// contenuto) — unica fonte qui, stessa convenzione di suffisso `_STATES` di
// sopra. Array (non Set) perché i chiamanti usano .includes()/spread.

// Stati di RUN che occupano uno slot di concorrenza per il dispatcher (girano
// o ripartiranno da sole, non vanno ricontate come lancio nuovo).
export const SLOT_OCCUPYING_STATES = ['running', 'resumed', 'interrupted', 'paused'];

// Stati di RUN "interattiva" davvero in corso (esclude interrupted/paused: non
// occupano l'utente in questo momento) — usato per dare precedenza alla chat
// umana sul lancio autonomo.
export const INTERACTIVE_ACTIVE_STATES = ['running', 'resumed'];

// Stati di TASK delle due fasi del quality gate (manager poi CEO).
export const REVIEW_STATES = ['review_manager', 'review_ceo'];

// Stati di TASK eleggibili al lancio autonomo del dispatcher.
export const DISPATCHABLE_STATES = ['todo', 'revisione', ...REVIEW_STATES];

// Decisione del resume MANUALE (bottone "Riprendi"): l'intento dell'utente è
// SEMPRE "rimettila in moto". Restituisce l'azione da eseguire + un messaggio
// che riferisce lo stato REALE della run (requisito del bug: niente più il
// messaggio-regola "solo le run fermate o in pausa possono essere riprese").
//   - nudge : stato sticky → va spinta a interrupted con retry immediato
//   - noop  : già in esecuzione o già in ripartenza → 200, la UI aveva uno
//             stato stantio (race col watchdog), nessuna azione necessaria
//   - reject: terminale/esterna/inesistente → errore con lo stato reale
export function resumeDecision(run) {
  if (!run) return { action: 'reject', code: 404, message: 'run non trovata' };
  if (run.external) {
    return { action: 'reject', code: 409, message: 'run esterna: il server non può riprenderla (vive in un processo suo)' };
  }
  const s = run.status;
  if (isStickyStatus(s)) {
    return { action: 'nudge', code: 200, message: s === 'paused' ? 'ripresa dalla pausa' : 'ripresa dallo stop' };
  }
  if (isRunningStatus(s) || isPendingStatus(s)) {
    return {
      action: 'noop',
      code: 200,
      message: s === 'interrupted'
        ? 'la run risulta interrotta: sta già ripartendo da sola, nessuna azione necessaria'
        : 'la run risulta già in esecuzione, nessuna azione necessaria',
    };
  }
  // terminale (completed | failed)
  return {
    action: 'reject',
    code: 409,
    message: `la run risulta ${s}: è già terminata e non è più riprendibile (riavviala con un nuovo messaggio)`,
  };
}
