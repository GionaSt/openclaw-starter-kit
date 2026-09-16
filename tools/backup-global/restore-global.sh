#!/usr/bin/env bash
# ============================================================================
# restore-global.sh — "one command" restore from a restic snapshot of the
# global backup. Runs ON THE HOST as root. Works on:
#   (a) the current VPS (restore files/folders after damage), or
#   (b) a NEW, empty Ubuntu VPS (full disaster recovery).
#
# Prerequisites (from the SURVIVAL KIT, see make-survival-kit.sh):
#   /root/.config/rclone/rclone.conf      remote token (Google Drive, ...)
#   /root/.backup-global/restic.pass      repository password
#   /root/.backup-global/backup-global.env (optional, for the repository name/paths)
#
# Usage:
#   restore-global.sh --list                       list snapshots
#   restore-global.sh --bootstrap                  new VPS: install docker/restic/rclone/nginx/certbot
#   restore-global.sh --full [--snapshot ID] [--yes]   full restore (files + sqlite + cron + docker + services)
#   restore-global.sh --files [--snapshot ID] --target /tmp/r   extract only, into a folder (inspection)
#   restore-global.sh --path /root/.openclaw/workspace/memory --snapshot ID   restore just that path (into /tmp/restore-<stamp>)
# ============================================================================
set -uo pipefail
CONF_DIR="${BACKUP_GLOBAL_DIR:-/root/.backup-global}"
CONF="$CONF_DIR/backup-global.env"; [ -f "$CONF" ] && . "$CONF"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-rclone:gdrive:OpenClaw_Restic}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$CONF_DIR/restic.pass}"
OPENCLAW_HOME="${OPENCLAW_HOME:-/root/.openclaw}"
OPENCLAW_COMPOSE_DIR="${OPENCLAW_COMPOSE_DIR:-/root/openclaw}"
DOCKER_VOLUME_PREFIX="${DOCKER_VOLUME_PREFIX-openclaw_}"
WS="${WORKSPACE:-$OPENCLAW_HOME/workspace}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
MODE=""; SNAPSHOT="latest"; TARGET=""; ONLY_PATH=""; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE=list ;; --bootstrap) MODE=bootstrap ;; --full) MODE=full ;; --files) MODE=files ;;
    --path) MODE=path; ONLY_PATH="$2"; shift ;;
    --snapshot) SNAPSHOT="$2"; shift ;; --target) TARGET="$2"; shift ;; --yes) YES=1 ;;
    -h|--help|"") sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac; shift
done
[ -n "$MODE" ] || { sed -n '2,20p' "$0"; exit 0; }
log() { printf '%s %s\n' "$(date -Is)" "$*"; }
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

# ---------------------------------------------------------------- bootstrap (new VPS)
if [ "$MODE" = bootstrap ]; then
  log "bootstrap: installing docker, restic, rclone, sqlite3, nginx, certbot"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y && apt-get install -y ca-certificates curl gnupg restic sqlite3 nginx certbot python3-certbot-nginx ufw python3 unzip
  command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  command -v rclone >/dev/null || curl -fsSL https://rclone.org/install.sh | bash
  mkdir -p /root/.config/rclone "$CONF_DIR"
  echo
  echo "NOW copy from the KIT: rclone.conf into /root/.config/rclone/ and restic.pass + backup-global.env into $CONF_DIR/ (chmod 600)."
  echo "Then: $0 --list   and   $0 --full"
  exit 0
fi

for b in restic rclone; do command -v "$b" >/dev/null || { echo "missing $b: run --bootstrap"; exit 1; }; done
[ -s "$RESTIC_PASSWORD_FILE" ] || { echo "missing $RESTIC_PASSWORD_FILE (from the KIT)"; exit 1; }
restic cat config >/dev/null 2>&1 || { echo "repository $RESTIC_REPOSITORY unreachable: check rclone.conf and the password"; exit 1; }

if [ "$MODE" = list ]; then restic snapshots --compact; exit $?; fi

# ---------------------------------------------------------------- extract into a folder
if [ "$MODE" = files ] || [ "$MODE" = path ]; then
  TARGET="${TARGET:-/tmp/restore-$STAMP}"; mkdir -p "$TARGET"
  INC=(); [ -n "$ONLY_PATH" ] && INC=(--include "$ONLY_PATH")
  log "extracting snapshot $SNAPSHOT into $TARGET ${ONLY_PATH:+(only $ONLY_PATH)}"
  restic restore "$SNAPSHOT" --target "$TARGET" "${INC[@]}" || exit 1
  echo "Done. Content in $TARGET (consistent SQLite copies are under $TARGET$CONF_DIR/snapshot/sqlite/... with a .bak suffix)."
  exit 0
fi

# ---------------------------------------------------------------- full restore
[ "$MODE" = full ] || exit 2
TARGET="${TARGET:-/}"
echo "FULL RESTORE of snapshot '$SNAPSHOT' onto '$TARGET'."
echo "Overwrites $OPENCLAW_HOME, $OPENCLAW_COMPOSE_DIR, /etc/nginx, /etc/letsencrypt, docker volumes '${DOCKER_VOLUME_PREFIX}*' and the root crontab."
if [ "$YES" != 1 ]; then read -r -p "Type YES to continue: " ok; [ "$ok" = YES ] || exit 1; fi

log "1/7 stopping containers (if docker is present)"
command -v docker >/dev/null && { docker ps -q | xargs -r docker stop >/dev/null 2>&1 || true; }

log "2/7 pre-creating docker volumes (if missing)"
VOLS_TMP="$(mktemp -d)"
restic restore "$SNAPSHOT" --target "$VOLS_TMP" --include "$CONF_DIR/snapshot/docker/volumes.txt" >/dev/null 2>&1 || true
if command -v docker >/dev/null && [ -n "$DOCKER_VOLUME_PREFIX" ] && [ -f "$VOLS_TMP$CONF_DIR/snapshot/docker/volumes.txt" ]; then
  grep -E "^${DOCKER_VOLUME_PREFIX}" "$VOLS_TMP$CONF_DIR/snapshot/docker/volumes.txt" | while read -r v; do docker volume create "$v" >/dev/null; done
fi

log "3/7 restic restore (can take a while: downloads everything from the remote)"
restic restore "$SNAPSHOT" --target "$TARGET" || { echo "restore failed"; exit 1; }

log "4/7 putting the consistent SQLite copies back in place"
SQL_SRC="$TARGET$CONF_DIR/snapshot/sqlite"
if [ -d "$SQL_SRC" ]; then
  find "$SQL_SRC" -type f -name '*.bak' | while read -r f; do
    rel="${f#$SQL_SRC}"; dst="$TARGET${rel%.bak}"
    mkdir -p "$(dirname "$dst")"; cp -f "$f" "$dst"; rm -f "$dst-wal" "$dst-shm"
    # owner: OpenClaw runs as uid 1000 inside the container (known EACCES footgun)
    case "$dst" in */.openclaw/*|*/docker/volumes/${DOCKER_VOLUME_PREFIX}*) chown 1000:1000 "$dst" ;; esac
  done
fi
[ -d "$TARGET$OPENCLAW_HOME" ] && chown -R 1000:1000 "$TARGET$OPENCLAW_HOME" 2>/dev/null || true
if [ -n "$DOCKER_VOLUME_PREFIX" ]; then
  for d in "$TARGET"/var/lib/docker/volumes/${DOCKER_VOLUME_PREFIX}*/_data; do [ -d "$d" ] && chown -R 1000:1000 "$d"; done
fi

log "5/7 root crontab"
CRON_SRC="$TARGET$CONF_DIR/snapshot/host/crontab-root.txt"
if [ "$TARGET" = "/" ] && [ -f "$CRON_SRC" ]; then
  crontab -l > "$CONF_DIR/crontab-before-restore-$STAMP.txt" 2>/dev/null || true
  crontab "$CRON_SRC" && log "crontab restored (previous copy in $CONF_DIR/crontab-before-restore-$STAMP.txt)"
fi

log "6/7 services"
if [ "$TARGET" = "/" ] && command -v docker >/dev/null; then
  # standalone containers (created with `docker run`, not compose): regenerate the commands from the saved inspect
  GEN="$SCRIPT_DIR/gen-docker-run.py"; [ -f "$GEN" ] || GEN="$WS/tools/backup-global/gen-docker-run.py"
  if [ -f "$CONF_DIR/snapshot/docker/containers-inspect.json" ] && [ -f "$GEN" ]; then
    python3 "$GEN" "$CONF_DIR/snapshot/docker/containers-inspect.json" > "$CONF_DIR/recreate-standalone-$STAMP.sh"
    log "docker run commands for standalone containers in $CONF_DIR/recreate-standalone-$STAMP.sh (review, then run)"
  fi
  [ -f "$OPENCLAW_COMPOSE_DIR/docker-compose.yml" ] && (cd "$OPENCLAW_COMPOSE_DIR" && docker compose up -d) && log "OpenClaw stack up"
  if [ -f "$CONF_DIR/recreate-standalone-$STAMP.sh" ] && [ "$YES" = 1 ]; then
    bash "$CONF_DIR/recreate-standalone-$STAMP.sh" && log "standalone containers recreated"
  fi
  command -v nginx >/dev/null && nginx -t && systemctl reload nginx && log "nginx reloaded"
fi

log "7/7 done"
cat <<EOF2

RESTORE COMPLETED (snapshot $SNAPSHOT -> $TARGET).
Manual checks:
  1. docker ps            (all containers up)
  2. inside each container using the Claude CLI: reinstall the CLI (docs/02-claude-subscription.md)
  3. ufw: review $CONF_DIR/snapshot/host/ufw-status.txt and re-apply the rules
  4. certbot renew --dry-run
  5. ask your assistant "backup status": it reads tools/backup-global/last-run.json
EOF2
