#!/bin/bash
# DEPLOY V2 FIX DOPPIO INVIO + REQUEST CARD LEGGIBILI - eseguire sulla VPS come root
# Fix 2026-08-19:
#  1. operating-system.js resolveProjectInput: una risposta di tipo 'input' non
#     azzera piu' approvedAt -> il runner non ricrea il gate di approvazione e
#     Owner non deve piu' mandare il messaggio due volte.
#  2. v2-executor.js workerPrompt/resumePrompt: le richieste needs_input devono
#     aprire con l'azione concreta per Owner (perche' + tempo, tecnica in fondo).
set -Eeuo pipefail

cd /root/.openclaw/workspace/agent-platform-live

echo "=== 1. Backup dati live ==="
docker exec agent-platform node server/scripts/backup.mjs --reason pre-deploy-fix-double-send 2>/dev/null || echo "WARN: backup fallito, continuo"

echo ""
echo "=== 2. Snapshot immagine rollback ==="
STAMP=$(date -u +%Y%m%d-%H%M%S)
ROLLBACK_IMAGE="agent-platform:pre-fix-double-send-$STAMP"
docker tag $(docker inspect --format '{{.Image}}' agent-platform) "$ROLLBACK_IMAGE"
echo "Rollback: $ROLLBACK_IMAGE"

echo ""
echo "=== 3. Build immagine con fix ==="
docker compose -f deploy/docker-compose.yml build platform

echo ""
echo "=== 4. Deploy ==="
docker compose -f deploy/docker-compose.yml up -d --no-deps platform

echo ""
echo "=== 5. Attesa healthcheck ==="
for i in $(seq 1 30); do
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' agent-platform 2>/dev/null || echo "unknown")
  echo "  tentativo $i: $health"
  [[ "$health" == "healthy" ]] && break
  [[ "$health" == "unhealthy" || "$health" == "exited" ]] && { echo "FALLITO"; docker logs --tail 50 agent-platform; exit 1; }
  sleep 2
done

echo ""
echo "=== 6. Verifica fix dentro il container ==="
docker exec agent-platform grep -q "sopravvive alle risposte di tipo 'input'" server/lib/operating-system.js 2>/dev/null \
  || docker exec agent-platform grep -q "SOPRAVVIVE alle risposte" server/lib/operating-system.js \
  && echo "OK: fix approvedAt presente" || echo "WARN: fix approvedAt NON trovato"
docker exec agent-platform grep -q "azionabile in 10 secondi" server/lib/v2-executor.js \
  && echo "OK: fix request card presente" || echo "WARN: fix request card NON trovato"
docker exec agent-platform grep -q "sopravvive alla ri-emissione del piano" server/lib/operating-system.js \
  && echo "OK: fix architect-spec/execution presente" || echo "WARN: fix architect-spec NON trovato"

echo ""
echo "=== DEPLOY COMPLETATO ==="
