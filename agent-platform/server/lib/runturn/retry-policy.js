// Policy di retry/backoff di streamTurn (server/lib/runturn/stream.js) — MOVE
// puro delle condizioni sparse dentro attemptWithModelFallback/attemptResilient
// e nel ramo "riparti senza resume" (task 1eed85e7, follow-up di 60d40a34).
// Funzioni pure: solo errore + stato in ingresso, nessun accesso a
// query/withLock/journal/sessionMap — decidono "ritenta / degrada / arrenditi"
// senza eseguire side-effect. Permette test unitari deterministici sulla
// policy senza mai invocare l'SDK reale (il vero guadagno di questo passo).
// Stessa semantica delle 4 regressioni storiche coperte prima dell'estrazione
// (bug 1c04b1b9, 2671cc26, e i due bug di model-tiering/resume): zero cambi
// di comportamento, solo rilocazione.
import { isModelUnavailableError, fallbackTier } from '../models.js';
import { isUsageLimitError } from '../runs.js';
import { isTerminalStatus, isStickyStatus } from '../runstates.js';

// Cap dei retry "risposta vuota" (bug 2671cc26): il reinvio manuale
// funzionava sempre al primo tentativo, quindi un cap basso non cicla mai.
export const MAX_NOOP_RETRIES = 2;

// Run non più "viva": fermata dall'utente (sticky) OPPURE già finalizzata
// (terminale). In entrambi i casi streamTurn NON deve ritentare/riavviare — un
// nuovo query() ripartirebbe fuori controllo. Il caso terminale copre il timeout
// wall-clock (task 019ab89d): journalTimeout marca failed e interrompe la query;
// l'errore dell'interrupt NON deve innescare un restart-senza-resume (che
// spawnerebbe una query fresca SENZA il deadline timer, girando all'infinito).
function isHalted(runStatus) {
  return isStickyStatus(runStatus) || isTerminalStatus(runStatus);
}

// Requisito 3 (model tiering): se l'errore indica modello non disponibile nel
// piano/CLI (niente crediti/seat per quel tier, servizio disabilitato per
// l'org, id modello sconosciuto...) degrada di UN tier. Ritorna il tier
// successivo, o null se l'errore non è di quel tipo o non c'è più fallback
// (fine catena, es. haiku) — in quel caso il chiamante deve rilanciare.
export function decideModelFallback(err, currentTier) {
  if (!isModelUnavailableError(err?.message)) return null;
  return fallbackTier(currentTier);
}

// Bug 2671cc26: un result "success" ma vuoto (0 output token) al resume è un
// no-op del CLI (ha processato una notifica pendente invece del prompt), non
// una risposta vera — ritenta finché non supera il cap o finché nel frattempo
// non arriva uno stop/pausa manuale (sticky): mai ciclare oltre uno stop.
export function decideNoopRetry(err, { noopTries, runStatus }) {
  return Boolean(err?.noop) && noopTries < MAX_NOOP_RETRIES && !isHalted(runStatus);
}

// Fallimento col resume attivo (es. sessione Claude persa dopo ricreazione
// container): riparte UNA volta da una sessione pulita invece di mostrare
// errore. MAI se la causa è il limite Max (ritenterebbe subito con lo stesso
// esito) o se nel frattempo è arrivato uno stop/pausa manuale.
export function decideRestartWithoutResume(err, { hasResumeSession, runStatus }) {
  return Boolean(hasResumeSession) && !isUsageLimitError(err?.message) && !isHalted(runStatus);
}
