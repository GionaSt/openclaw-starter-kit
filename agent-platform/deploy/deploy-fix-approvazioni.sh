#!/bin/bash
# DEPLOY V2 FIX APPROVAZIONI - eseguire sulla VPS come root
# Progetto: ac27074d-df94-4d9b-b2eb-db4ad32edc09 (verifica_e2e)
# Approvato da Owner il 2026-08-15
set -Eeuo pipefail

cd /root/.openclaw/workspace/agent-platform-live

echo "=== 1. Verifica stato git (i fix sono untracked/modified) ==="
git status --short | head -10

echo ""
echo "=== 2. Backup dati live ==="
docker exec agent-platform node server/scripts/backup.mjs --reason pre-deploy-fix-approvazioni 2>/dev/null || echo "WARN: backup fallito, continuo"

echo ""
echo "=== 3. Snapshot immagine rollback ==="
STAMP=$(date -u +%Y%m%d-%H%M%S)
ROLLBACK_IMAGE="agent-platform:pre-fix-approvazioni-$STAMP"
docker tag $(docker inspect --format '{{.Image}}' agent-platform) "$ROLLBACK_IMAGE"
echo "Rollback: $ROLLBACK_IMAGE"

echo ""
echo "=== 4. Build immagine con fix ==="
docker compose -f deploy/docker-compose.yml build platform

echo ""
echo "=== 5. Deploy (finestra controllata: nessuna run V2 lunga in volo) ==="
docker compose -f deploy/docker-compose.yml up -d --no-deps platform

echo ""
echo "=== 6. Attesa healthcheck ==="
for i in $(seq 1 30); do
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' agent-platform 2>/dev/null || echo "unknown")
  echo "  tentativo $i: $health"
  [[ "$health" == "healthy" ]] && break
  [[ "$health" == "unhealthy" || "$health" == "exited" ]] && { echo "FALLITO"; docker logs --tail 50 agent-platform; exit 1; }
  sleep 2
done

echo ""
echo "=== 7. Verifica versione ==="
curl -s http://localhost:18800/api/version | python3 -m json.tool

echo ""
echo "=== 8. Verifica fix presenti ==="
curl -s http://localhost:18800/api/version | grep -q '"stale":false' && echo "OK: codice aggiornato" || echo "WARN: potrebbe essere stale"

echo ""
echo "=== DEPLOY COMPLETATO ==="
echo "Progetto di test: creare via UI o API e testare 3 approvazioni chat + 1 ripresa bottone + 1 rifiuto"
