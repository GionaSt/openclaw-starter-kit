#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.yml"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ROLLBACK_IMAGE="agent-platform:pre-operating-system-v2-$STAMP"
PUBLIC_URL="${PUBLIC_URL:-https://your-domain.example}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

cd "$ROOT_DIR"

if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
  echo "Config OpenClaw non trovata: $OPENCLAW_CONFIG" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 non trovato sulla VPS: necessario per leggere la configurazione OpenClaw." >&2
  exit 1
fi

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  export OPENCLAW_GATEWAY_TOKEN="$(python3 - "$OPENCLAW_CONFIG" <<'PYTOKEN'
import json
import sys
with open(sys.argv[1], encoding='utf-8') as handle:
    config = json.load(handle)
print(config.get('gateway', {}).get('auth', {}).get('token', ''), end='')
PYTOKEN
)"
fi
if [[ -z "$OPENCLAW_GATEWAY_TOKEN" ]]; then
  echo "Token Gateway OpenClaw non trovato nella configurazione." >&2
  exit 1
fi

export OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-ws://host.docker.internal:18789}"
export OPENCLAW_GATEWAY_ORIGIN="${OPENCLAW_GATEWAY_ORIGIN:-http://localhost:18789}"
python3 - "$OPENCLAW_CONFIG" "$ROOT_DIR/server/config/openclaw-models.json" <<'PYMODELS'
import json
import sys

source, target = sys.argv[1:3]
with open(source, encoding='utf-8') as handle:
    config = json.load(handle)
defaults = config.get('agents', {}).get('defaults', {})
entries = defaults.get('models', {}) or {}
model_setting = defaults.get('model')
primary = model_setting if isinstance(model_setting, str) else (model_setting or {}).get('primary')
models = [
    {'id': model_id, 'label': (value or {}).get('alias') or model_id}
    for model_id, value in entries.items()
]
with open(target, 'w', encoding='utf-8') as handle:
    fallback_candidates = [
        'openai/gpt-5.4',
        'google/gemini-3.1-pro-preview',
    ]
    available = {item['id'] for item in models}
    fallbacks = [model_id for model_id in fallback_candidates if model_id in available and model_id != primary]
    json.dump({'defaultModel': primary or (models[0]['id'] if models else ''), 'fallbackModels': fallbacks, 'models': models}, handle, indent=2)
    handle.write('\n')
PYMODELS

echo "[1/6] Backup dati live"
docker exec agent-platform node server/scripts/backup.mjs --reason pre-operating-system-v2

echo "[2/6] Snapshot immagine rollback: $ROLLBACK_IMAGE"
docker tag "$(docker inspect --format '{{.Image}}' agent-platform)" "$ROLLBACK_IMAGE"

echo "[3/6] Validazione compose"
docker compose -f "$COMPOSE_FILE" config >/dev/null

echo "[4/6] Build e deploy V2"
docker compose -f "$COMPOSE_FILE" up -d --build --no-deps platform

echo "[5/6] Attesa healthcheck"
for attempt in $(seq 1 60); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' agent-platform 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]]; then
    break
  fi
  if [[ "$health" == "unhealthy" || "$health" == "exited" || "$health" == "dead" ]]; then
    docker logs --tail 120 agent-platform
    echo "Deploy fallito. Immagine rollback disponibile: $ROLLBACK_IMAGE" >&2
    exit 1
  fi
  sleep 2
done

health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' agent-platform)"
if [[ "$health" != "healthy" ]]; then
  docker logs --tail 120 agent-platform
  echo "Timeout healthcheck. Immagine rollback disponibile: $ROLLBACK_IMAGE" >&2
  exit 1
fi

docker exec agent-platform node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('/app/server/config/platform.json','utf8')); if(c?.operatingSystemV2?.exclusive!==true) process.exit(1)" || {
  echo "Il container è healthy, ma Operating System V2 exclusive non è attivo." >&2
  exit 1
}

echo "Verifica grafo contesto condiviso"
context_ready=""
for attempt in $(seq 1 90); do
  context_ready="$(docker exec agent-platform node -e "const fs=require('fs'); try { const g=JSON.parse(fs.readFileSync('/app/server/data/context-graph/graph.json','utf8')); if(g?.graph?.context_stats?.ready) process.stdout.write(String(g.graph.context_stats.nodes||0)); } catch {}" 2>/dev/null || true)"
  [[ "$context_ready" =~ ^[1-9][0-9]*$ ]] && break
  sleep 2
done
if [[ ! "$context_ready" =~ ^[1-9][0-9]*$ ]]; then
  docker logs --tail 120 agent-platform
  echo "Il container è healthy, ma il grafo condiviso OpenClaw/V1/V2 non è pronto." >&2
  exit 1
fi
echo "Grafo condiviso pronto: $context_ready nodi"

echo "[6/6] Verifica bundle pubblico"
index_html="$(curl -fsSL --retry 5 --retry-delay 2 "$PUBLIC_URL/")"
asset_path="$(printf '%s' "$index_html" | grep -oE '/assets/[^\" ]+\.js' | head -n 1)"
if [[ -z "$asset_path" ]]; then
  echo "Bundle JavaScript non trovato su $PUBLIC_URL" >&2
  exit 1
fi

public_bundle="$(mktemp)"
trap 'rm -f "$public_bundle"' EXIT
curl -fsSL --retry 5 --retry-delay 2 "$PUBLIC_URL$asset_path" > "$public_bundle"
if ! grep -q 'L’Architect sta pensando' "$public_bundle"; then
  echo "La piattaforma è healthy, ma manca l'indicatore testuale di elaborazione della chat." >&2
  exit 1
fi
if ! grep -q 'Approva piano e avvia' "$public_bundle"; then
  echo "La piattaforma è healthy, ma il bundle pubblico non contiene ancora la UX chat-first." >&2
  echo "Controllare cache nginx/browser. Asset rilevato: $asset_path" >&2
  exit 1
fi
if ! grep -q 'Progetti' "$public_bundle" || ! grep -q 'Report' "$public_bundle" || ! grep -q 'Configurazione' "$public_bundle"; then
  echo "La piattaforma è healthy, ma manca la navigazione essenziale Progetti, Report e Configurazione." >&2
  echo "Asset rilevato: $asset_path" >&2
  exit 1
fi
if ! grep -q 'Nuovo report' "$public_bundle" || ! grep -q 'Apri progetto da questo report' "$public_bundle"; then
  echo "La piattaforma è healthy, ma il flusso Report Designer o report-verso-progetto non è disponibile." >&2
  exit 1
fi
if ! grep -q 'Piano del progetto' "$public_bundle"; then
  echo "La piattaforma è healthy, ma manca il nuovo menu laterale dei progetti." >&2
  exit 1
fi
if ! grep -q 'Struttura del report' "$public_bundle"; then
  echo "La piattaforma è healthy, ma manca il nuovo menu laterale dei report." >&2
  exit 1
fi
if ! grep -q 'Quality gate' "$public_bundle"; then
  echo "La piattaforma è healthy, ma il bundle pubblico non contiene il quality gate V2." >&2
  exit 1
fi
if grep -q 'Agenti live' "$public_bundle" || grep -q 'Organigramma' "$public_bundle" || grep -q 'Schedulazioni' "$public_bundle"; then
  echo "La piattaforma è healthy, ma il bundle contiene ancora la navigazione V1." >&2
  exit 1
fi

public_sw="$(curl -fsSL --retry 5 --retry-delay 2 "$PUBLIC_URL/sw.js")"
if ! grep -q "agent-platform-v6" <<<"$public_sw"; then
  echo "Il service worker pubblico non usa ancora la cache V6 (turno Architect server-side + push chat)." >&2
  exit 1
fi

echo "Deploy completato. Apri: $PUBLIC_URL. Operating System V2 è ora l'interfaccia principale."
echo "Rollback image: $ROLLBACK_IMAGE"
