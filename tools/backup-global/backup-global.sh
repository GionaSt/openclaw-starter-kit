#!/usr/bin/env bash
# ============================================================================
# backup-global.sh — daily GLOBAL backup of an OpenClaw VPS to Google Drive
# (or any rclone remote) with restic. Runs ON THE HOST as root (cron).
# One engine for everything:
#   - OpenClaw state ($OPENCLAW_HOME: config, credentials, sessions, workspace,
#     memory, agent platform, ...)
#   - docker volumes matching $DOCKER_VOLUME_PREFIX (extra OpenClaw instances)
#   - host: nginx, letsencrypt, root crontab, compose/env, rclone, ssh, systemd,
#     ufw, docker inventory (inspect of all containers, volumes, images)
#   - CONSISTENT copies of every SQLite database (VACUUM INTO, never a hot copy)
#   - optional: pg_dump of an external Postgres ($PG_DUMP_URL)
# Engine: restic (dedup + encryption + snapshots) over rclone. Only the daily
# delta travels; retention 7 daily / 4 weekly / 6 monthly / 2 yearly.
# Result: optional Telegram message + last-run.json readable by the assistant.
# Restore: restore-global.sh (same folder).
# Flags: --dry-run  --prune  --check
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="${BACKUP_GLOBAL_DIR:-/root/.backup-global}"
CONF="${BACKUP_GLOBAL_CONF:-$CONF_DIR/backup-global.env}"
[ -f "$CONF" ] && . "$CONF"

OPENCLAW_HOME="${OPENCLAW_HOME:-/root/.openclaw}"
OPENCLAW_COMPOSE_DIR="${OPENCLAW_COMPOSE_DIR:-/root/openclaw}"
WS="${WORKSPACE:-$OPENCLAW_HOME/workspace}"
OUTDIR="${STATUS_DIR:-$WS/tools/backup-global}"
LOG="${BACKUP_LOG:-$OUTDIR/backup-global.log}"
STATUS="$OUTDIR/last-run.json"
SNAP="$CONF_DIR/snapshot"                 # small staging area: host dumps + sqlite copies
LOCK="/var/lock/backup-global.lock"
MIN_FREE_MB="${MIN_FREE_MB:-3000}"
DOCKER_VOLUME_PREFIX="${DOCKER_VOLUME_PREFIX-openclaw_}"
EXTRA_PATHS="${EXTRA_PATHS:-}"

export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-rclone:gdrive:OpenClaw_Restic}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$CONF_DIR/restic.pass}"
export RESTIC_COMPRESSION="${RESTIC_COMPRESSION:-auto}"
export RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/root/.cache/restic}"
KEEP_DAILY="${KEEP_DAILY:-7}"; KEEP_WEEKLY="${KEEP_WEEKLY:-4}"; KEEP_MONTHLY="${KEEP_MONTHLY:-6}"; KEEP_YEARLY="${KEEP_YEARLY:-2}"
TG_TOKEN="${TG_TOKEN:-}"; TG_CHAT="${TG_CHAT:-}"
PG_DUMP_URL="${PG_DUMP_URL:-}"
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"

DRY_RUN=0; FORCE_PRUNE=0; FORCE_CHECK=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --prune) FORCE_PRUNE=1 ;;
    --check) FORCE_CHECK=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
  esac
done

START_TS=$(date +%s)
STAMP="$(date +%F_%H%M)"
mkdir -p "$OUTDIR" "$CONF_DIR" "$RESTIC_CACHE_DIR"
log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }
WARN=(); GAPS=(); STEP="init"; SNAP_ID=""; SUMMARY_JSON=""

write_status() {  # $1=status $2=message
  local status="$1" msg="$2" dur=$(( $(date +%s) - START_TS ))
  python3 - "$STATUS" "$status" "$msg" "$STEP" "$SNAP_ID" "$dur" "$STAMP" "$SUMMARY_JSON" "$(IFS='|'; echo "${WARN[*]:-}")" "$(IFS='|'; echo "${GAPS[*]:-}")" <<'PY'
import json, sys, datetime
p, status, msg, step, snap, dur, stamp, summary, warn, gaps = sys.argv[1:]
try: s = json.loads(summary) if summary else {}
except Exception: s = {}
out = {"status": status, "message": msg, "step": step, "snapshot_id": snap,
       "duration_s": int(dur), "stamp_local": stamp,
       "finished_utc": datetime.datetime.utcnow().isoformat(timespec="seconds")+"Z",
       "restic_summary": s,
       "warnings": [w for w in warn.split("|") if w],
       "gaps": [g for g in gaps.split("|") if g]}
json.dump(out, open(p, "w"), indent=2, ensure_ascii=False)
PY
}

tg() {  # Telegram notification (best effort, only if configured)
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] || return 0
  curl -s --max-time 20 -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="$TG_CHAT" --data-urlencode text="$1" >/dev/null 2>&1 || true
}

die() {
  log "ERROR [$STEP]: $*"
  write_status "failed" "$*"
  [ "$DRY_RUN" = 1 ] && exit 1
  tg "❌ Global backup FAILED (${STAMP}) at step ${STEP}: $*
Log: $LOG"
  exit 1
}

# ---------------------------------------------------------------- 0. lock
exec 9>"$LOCK"
flock -n 9 || { log "another backup is running, exiting"; exit 0; }
log "=== backup-global START $STAMP (dry-run=$DRY_RUN)"

# ---------------------------------------------------------------- 1. preflight
STEP="preflight"
[ "$(id -u)" = 0 ] || die "must run as root on the host"
for b in restic rclone python3 curl; do command -v "$b" >/dev/null || die "missing binary '$b' (see install-host.sh)"; done
command -v docker >/dev/null || WARN+=("docker not found: no container inventory, no docker volumes")
command -v sqlite3 >/dev/null || { WARN+=("sqlite3 missing: SQLite DBs are copied hot (corruption risk), install sqlite3"); }
[ -s "$RESTIC_PASSWORD_FILE" ] || die "missing restic password in $RESTIC_PASSWORD_FILE"
FREE_MB=$(df -Pm /root | awk 'NR==2{print $4}')
[ "$FREE_MB" -ge "$MIN_FREE_MB" ] || die "free space on /root: ${FREE_MB} MB < ${MIN_FREE_MB} MB required"
if [ "${RESTIC_REPOSITORY#rclone:}" != "$RESTIC_REPOSITORY" ]; then
  RCLONE_REMOTE="${RESTIC_REPOSITORY#rclone:}"; RCLONE_REMOTE="${RCLONE_REMOTE%%:*}"
  rclone listremotes 2>/dev/null | grep -qx "${RCLONE_REMOTE}:" || die "rclone remote '${RCLONE_REMOTE}' not configured (run: rclone config)"
fi
# Tell "repository missing" apart from "remote unreachable": a transient rclone
# error must NOT trigger `restic init` (it would die on "config already exists").
# 3 attempts; init ONLY if restic explicitly says the repository does not exist.
REPO_MISSING=0; REPO_STATE="unreachable"; CAT_ERR=""
for attempt in 1 2 3; do
  if CAT_ERR=$(restic cat config 2>&1 >/dev/null); then REPO_STATE="ok"; break; fi
  if printf '%s' "$CAT_ERR" | grep -qiE "Is there a repository at the following location|repository does not exist|does not exist"; then REPO_STATE="missing"; break; fi
  log "restic cat config attempt $attempt/3 failed: $(printf '%s' "$CAT_ERR" | tail -1)"
  [ "$attempt" -lt 3 ] && sleep 30
done
case "$REPO_STATE" in
  ok) ;;
  missing)
    if [ "$DRY_RUN" = 1 ]; then REPO_MISSING=1; log "restic repository missing (dry-run: skipping restic step)"; else
      log "restic repository missing at $RESTIC_REPOSITORY: initializing"
      restic init >>"$LOG" 2>&1 || die "restic init failed (remote reachable? rclone token expired?)"
    fi ;;
  *) die "repository $RESTIC_REPOSITORY UNREACHABLE after 3 attempts (rclone token expired? remote down?): $(printf '%s' "$CAT_ERR" | tail -1)" ;;
esac

# ---------------------------------------------------------------- 2. host snapshot
STEP="host-snapshot"
rm -rf "$SNAP"; mkdir -p "$SNAP/docker" "$SNAP/host" "$SNAP/sqlite" "$SNAP/pgdump"
crontab -l > "$SNAP/host/crontab-root.txt" 2>/dev/null || echo "# no root crontab" > "$SNAP/host/crontab-root.txt"
if command -v docker >/dev/null; then
  docker ps -a --format '{{json .}}' > "$SNAP/docker/containers-ps.jsonl" 2>/dev/null
  docker inspect $(docker ps -aq) > "$SNAP/docker/containers-inspect.json" 2>/dev/null || echo "[]" > "$SNAP/docker/containers-inspect.json"
  docker volume ls --format '{{.Name}}' > "$SNAP/docker/volumes.txt" 2>/dev/null
  docker volume inspect $(docker volume ls -q) > "$SNAP/docker/volumes-inspect.json" 2>/dev/null || echo "[]" > "$SNAP/docker/volumes-inspect.json"
  docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' > "$SNAP/docker/images.txt" 2>/dev/null
  docker network ls --format '{{.Name}} {{.Driver}}' > "$SNAP/docker/networks.txt" 2>/dev/null
  docker compose ls -a > "$SNAP/docker/compose-projects.txt" 2>/dev/null || true
fi
{ hostname; hostname -I; cat /etc/os-release; } > "$SNAP/host/system.txt" 2>/dev/null
ip -br addr > "$SNAP/host/ip.txt" 2>/dev/null || true
ufw status verbose > "$SNAP/host/ufw-status.txt" 2>/dev/null || true
dpkg --get-selections > "$SNAP/host/dpkg-selections.txt" 2>/dev/null || true
systemctl list-unit-files --state=enabled --no-pager > "$SNAP/host/systemd-enabled.txt" 2>/dev/null || true
restic version > "$SNAP/host/tool-versions.txt" 2>/dev/null; rclone version 2>/dev/null | head -1 >> "$SNAP/host/tool-versions.txt"; docker --version >> "$SNAP/host/tool-versions.txt" 2>/dev/null
cp "$0" "$SNAP/host/backup-global.sh.copy" 2>/dev/null || true

# ---------------------------------------------------------------- 3. consistent SQLite copies
STEP="sqlite"
# Every live SQLite DB (OpenClaw + prefixed docker volumes) is snapshotted with
# VACUUM INTO under $SNAP/sqlite/<absolute path>. Live files (*.sqlite, -wal, -shm)
# are EXCLUDED from the backup: the consistent copy is what gets restored.
SQLITE_ROOTS=("$OPENCLAW_HOME")
VOL_DIRS=()
if command -v docker >/dev/null && [ -n "$DOCKER_VOLUME_PREFIX" ]; then
  mapfile -t VOL_DIRS < <(docker volume ls -q 2>/dev/null | grep -E "^${DOCKER_VOLUME_PREFIX}" | while read -r v; do docker volume inspect -f '{{.Mountpoint}}' "$v"; done)
fi
SQLITE_ROOTS+=("${VOL_DIRS[@]}")
N_SQLITE=0
if command -v sqlite3 >/dev/null; then
  while IFS= read -r db; do
    dst="$SNAP/sqlite$db"; mkdir -p "$(dirname "$dst")"
    if [ "$DRY_RUN" = 1 ]; then N_SQLITE=$((N_SQLITE+1)); continue; fi
    if sqlite3 "$db" "VACUUM INTO '$dst'" 2>>"$LOG"; then N_SQLITE=$((N_SQLITE+1)); else WARN+=("VACUUM INTO failed: $db"); fi
  done < <(find "${SQLITE_ROOTS[@]}" -type f \( -name '*.sqlite' -o -name '*.db' -o -name '*.sqlite3' \) \
            -not -path '*/node_modules/*' -not -path '*/.trash/*' -not -path '*/.venv*' -not -path '*/tmp/*' 2>/dev/null)
fi
log "sqlite snapshots: $N_SQLITE"

# ---------------------------------------------------------------- 4. external Postgres (optional)
STEP="pgdump"
if [ -n "$PG_DUMP_URL" ]; then
  if [ "$DRY_RUN" = 1 ]; then log "pg_dump (dry-run, skipped)"; else
    if docker run --rm "$PG_IMAGE" pg_dump --no-owner --no-privileges --dbname="$PG_DUMP_URL" 2>>"$LOG" | gzip > "$SNAP/pgdump/pg-${STAMP}.sql.gz" \
       && [ "$(stat -c %s "$SNAP/pgdump/pg-${STAMP}.sql.gz")" -gt 1024 ]; then
      log "pg_dump ok ($(du -h "$SNAP/pgdump/pg-${STAMP}.sql.gz" | cut -f1))"
    else WARN+=("pg_dump failed (URL/port 5432 reachable? password?)"); rm -f "$SNAP/pgdump/"*.gz; fi
  fi
else
  GAPS+=("external Postgres NOT included: PG_DUMP_URL empty in $CONF (fine if you have none)")
fi

# ---------------------------------------------------------------- 5. restic backup
STEP="restic-backup"
CANDIDATES=(
  "$OPENCLAW_HOME" "$OPENCLAW_COMPOSE_DIR"
  /root/.config/rclone /root/.ssh /root/.claude /root/.claude.json /root/.bashrc /root/.profile
  "$CONF_DIR"
  /etc/nginx /etc/letsencrypt /etc/caddy /etc/docker /etc/ufw /etc/systemd/system /etc/cron.d /etc/crontab
  /etc/ssh/sshd_config /etc/ssh/sshd_config.d /etc/hosts /etc/fstab /etc/fail2ban
  /usr/local/bin /var/spool/cron/crontabs
)
for p in $EXTRA_PATHS; do CANDIDATES+=("$p"); done
CANDIDATES+=("${VOL_DIRS[@]}")
PATHS=(); for p in "${CANDIDATES[@]}"; do [ -e "$p" ] && PATHS+=("$p"); done
[ -n "$DOCKER_VOLUME_PREFIX" ] && [ ${#VOL_DIRS[@]} -eq 0 ] && WARN+=("no docker volume matching '${DOCKER_VOLUME_PREFIX}*' found")

EXCL="$CONF_DIR/exclude.txt"
[ -f "$EXCL" ] || cat > "$EXCL" <<EOF2
# Patterns excluded from the global backup (regenerable or volatile). Edit freely.
node_modules
__pycache__
.venv
.trash
*.sock
*.pid
*.tmp
$OPENCLAW_HOME/workspace/tmp
$OPENCLAW_HOME/npm
$OPENCLAW_HOME/browser
$OPENCLAW_HOME/workspace/node_modules
/root/.cache
# live SQLite DBs: the consistent copy in $CONF_DIR/snapshot/sqlite is saved instead
*.sqlite
*.sqlite-wal
*.sqlite-shm
*.sqlite3
*.db-wal
*.db-shm
EOF2
[ -f "$CONF_DIR/exclude.local.txt" ] && EXCL_LOCAL=(--exclude-file "$CONF_DIR/exclude.local.txt") || EXCL_LOCAL=()
# restic applies exclude patterns everywhere, so the sqlite copies get a .bak suffix
find "$SNAP/sqlite" -type f 2>/dev/null | while read -r f; do mv "$f" "$f.bak"; done

log "restic backup of ${#PATHS[@]} paths (docker volumes: ${#VOL_DIRS[@]})"
RESTIC_ARGS=(backup --tag daily --tag "host:$(hostname)" --exclude-file "$EXCL" "${EXCL_LOCAL[@]}" --exclude-caches --json "${PATHS[@]}")
[ "$DRY_RUN" = 1 ] && RESTIC_ARGS+=(--dry-run)
RESTIC_OUT="$(mktemp)"
if [ "$REPO_MISSING" = 1 ]; then RC=0; : > "$RESTIC_OUT"; else restic "${RESTIC_ARGS[@]}" > "$RESTIC_OUT" 2>>"$LOG"; RC=$?; fi
SUMMARY_JSON="$(grep '"message_type":"summary"' "$RESTIC_OUT" | tail -1 || true)"
grep -v '"message_type":"status"' "$RESTIC_OUT" | grep -v '"message_type":"summary"' | tail -20 >> "$LOG"
rm -f "$RESTIC_OUT"
case "$RC" in
  0) ;;
  3) WARN+=("restic: some files unreadable (exit 3), snapshot created anyway") ;;
  *) die "restic backup exit $RC" ;;
esac
SNAP_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("snapshot_id","")[:8])' "$SUMMARY_JSON" 2>/dev/null || true)"
log "snapshot: ${SNAP_ID:-(dry-run)}"

# ---------------------------------------------------------------- 6. retention / prune / check
STEP="retention"
if [ "$DRY_RUN" = 0 ]; then
  PRUNE=(); DOW=$(date +%u); DOM=$(date +%d)
  { [ "$DOW" = 7 ] || [ "$FORCE_PRUNE" = 1 ]; } && PRUNE=(--prune)
  restic forget --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --keep-yearly "$KEEP_YEARLY" \
    --group-by host,tags "${PRUNE[@]}" >>"$LOG" 2>&1 || WARN+=("restic forget/prune had errors (see log)")
  STEP="check"
  if [ "$DOM" = 01 ] || [ "$FORCE_CHECK" = 1 ]; then
    restic check --read-data-subset=2% >>"$LOG" 2>&1 && log "restic check ok" || WARN+=("restic check FAILED: repository needs attention")
  fi
fi

# ---------------------------------------------------------------- 7. local lightweight copy (config only)
STEP="local-config-copy"
LOCAL_DIR="${LOCAL_CONFIG_DIR:-/root/backups/global-config}"; mkdir -p "$LOCAL_DIR"
LOCAL_TAR="$LOCAL_DIR/config-${STAMP}.tar.gz"
if [ "$DRY_RUN" = 0 ]; then
  tar -czf "$LOCAL_TAR" --ignore-failed-read \
    "$OPENCLAW_HOME/openclaw.json" "$OPENCLAW_HOME/credentials" "$OPENCLAW_HOME/identity" "$OPENCLAW_HOME/devices" \
    "$WS/.env" "$OPENCLAW_COMPOSE_DIR" /etc/nginx /etc/letsencrypt "$SNAP/host" "$SNAP/docker" 2>/dev/null || true
  find "$LOCAL_DIR" -name 'config-*.tar.gz' -mtime +3 -delete 2>/dev/null || true
fi

# ---------------------------------------------------------------- 8. report
STEP="done"
DUR=$(( $(date +%s) - START_TS ))
STATS="$(restic stats latest --mode raw-data --json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin); print("%.2f GB in repo" % (d.get("total_size",0)/1e9))' 2>/dev/null || echo "n/a")"
HUMAN="$(python3 -c 'import json,sys
s=json.loads(sys.argv[1]) if sys.argv[1] else {}
print("new %d, changed %d, uploaded %.0f MB, total %.2f GB" % (s.get("files_new",0), s.get("files_changed",0), s.get("data_added",0)/1e6, s.get("total_bytes_processed",0)/1e9))' "$SUMMARY_JSON" 2>/dev/null || echo "n/a")"
STATUS_TXT="ok"; [ ${#WARN[@]} -gt 0 ] && STATUS_TXT="ok-with-warnings"
write_status "$STATUS_TXT" "backup completed"
MSG="📦 Global backup ${STAMP} OK in $((DUR/60)) min
Snapshot ${SNAP_ID:-dry-run}: ${HUMAN}
Docker volumes: ${#VOL_DIRS[@]} · SQLite: ${N_SQLITE} · Repo: ${STATS}"
[ ${#WARN[@]} -gt 0 ] && MSG="$MSG
⚠️ $(IFS=$'\n'; echo "${WARN[*]}")"
[ ${#GAPS[@]} -gt 0 ] && MSG="$MSG
🕳 $(IFS=$'\n'; echo "${GAPS[*]}")"
log "$MSG"
[ "$DRY_RUN" = 1 ] || tg "$MSG"
log "=== backup-global END ($DUR s)"
exit 0
