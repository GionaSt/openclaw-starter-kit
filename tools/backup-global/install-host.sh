#!/usr/bin/env bash
# ============================================================================
# install-host.sh — install the global backup on the VPS (host, as root).
#   bash tools/backup-global/install-host.sh                  # dry-run: shows what it would do
#   bash tools/backup-global/install-host.sh --apply          # do it
#   bash tools/backup-global/install-host.sh --apply --run-now   # and start the first backup now (hours)
#   --hour N   cron hour (default 3 = 03:00 host local time)
# Does: apt restic+sqlite3, /root/.backup-global (password, env, exclude),
# restic init on the remote, adds ONE crontab line (merge: existing lines are
# kept untouched, a copy of the previous crontab is saved first).
# Prerequisite: an rclone remote already configured (see docs/05-backup-google-drive.md).
# ============================================================================
set -uo pipefail
APPLY=0; RUN_NOW=0; HOUR=3
while [ $# -gt 0 ]; do case "$1" in --apply) APPLY=1 ;; --run-now) RUN_NOW=1 ;; --hour) HOUR="$2"; shift ;; esac; shift; done
[ "$(id -u)" = 0 ] || { echo "run as root on the host"; exit 1; }
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="${BACKUP_GLOBAL_DIR:-/root/.backup-global}"
STAMP="$(date +%Y%m%d-%H%M%S)"
say() { printf '%s\n' "$*"; }
run() { if [ "$APPLY" = 1 ]; then eval "$@"; else say "  [dry-run] $*"; fi; }

say "== 1. binaries"
for b in restic sqlite3 rclone docker python3 curl; do
  if command -v "$b" >/dev/null; then say "  ok $b"; else say "  MISSING $b"; fi
done
if ! command -v restic >/dev/null || ! command -v sqlite3 >/dev/null; then
  run "DEBIAN_FRONTEND=noninteractive apt-get install -y restic sqlite3"
fi
command -v rclone >/dev/null || { say "  rclone missing: install it (curl https://rclone.org/install.sh | bash) and configure a remote (rclone config)"; }

say "== 2. config dir $CONF_DIR"
run "mkdir -p $CONF_DIR && chmod 700 $CONF_DIR"
if [ ! -s "$CONF_DIR/restic.pass" ]; then
  say "  creating restic password (32 random bytes). PUT IT IN THE SURVIVAL KIT: without it the backups are unreadable."
  run "openssl rand -base64 32 > $CONF_DIR/restic.pass && chmod 600 $CONF_DIR/restic.pass"
else say "  ok restic.pass exists"; fi
if [ ! -f "$CONF_DIR/backup-global.env" ]; then
  run "cp $SRC/backup-global.env.example $CONF_DIR/backup-global.env && chmod 600 $CONF_DIR/backup-global.env"
  say "  -> edit $CONF_DIR/backup-global.env (remote name, paths, Telegram) before the first real run"
else say "  ok backup-global.env exists"; fi
run "chmod +x $SRC/backup-global.sh $SRC/restore-global.sh $SRC/make-survival-kit.sh $SRC/gen-docker-run.py"

say "== 3. restic repository"
if [ "$APPLY" = 1 ] && command -v restic >/dev/null; then
  . "$CONF_DIR/backup-global.env"
  export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-rclone:gdrive:OpenClaw_Restic}" RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$CONF_DIR/restic.pass}"
  if [ "${RESTIC_REPOSITORY#rclone:}" != "$RESTIC_REPOSITORY" ]; then
    R="${RESTIC_REPOSITORY#rclone:}"; R="${R%%:*}"
    rclone listremotes 2>/dev/null | grep -qx "${R}:" || { say "  ERROR: rclone remote '$R' not found. Run 'rclone config' first (docs/05-backup-google-drive.md)."; exit 1; }
  fi
  if restic cat config >/dev/null 2>&1; then say "  ok existing repo $RESTIC_REPOSITORY"; else restic init && say "  repo created $RESTIC_REPOSITORY"; fi
else say "  [dry-run] restic init on the repository from backup-global.env if missing"; fi

say "== 4. root crontab (merge, no clobber)"
CUR="$(crontab -l 2>/dev/null || true)"
NEW_LINE="0 $HOUR * * * $SRC/backup-global.sh >> /var/log/backup-global.log 2>&1"
if printf '%s\n' "$CUR" | grep -qF "backup-global.sh"; then say "  crontab already has a backup-global line"; else
  MERGED="$(printf '%s\n%s\n' "$CUR" "$NEW_LINE")"
  say "  adding: $NEW_LINE"
  if [ "$APPLY" = 1 ]; then
    printf '%s\n' "$CUR" > "$CONF_DIR/crontab-before-$STAMP.txt"
    printf '%s\n' "$MERGED" | crontab - && say "  crontab updated (previous copy: $CONF_DIR/crontab-before-$STAMP.txt)"
  fi
fi

say "== 5. dry run of the backup"
if [ "$APPLY" = 1 ]; then bash "$SRC/backup-global.sh" --dry-run | tail -5; else say "  [dry-run] backup-global.sh --dry-run"; fi

say "== 6. survival kit"
if [ "$APPLY" = 1 ]; then bash "$SRC/make-survival-kit.sh"; else say "  [dry-run] make-survival-kit.sh -> /root/backup-global-KIT-<date>.tar.gz"; fi

if [ "$APPLY" = 1 ] && [ "$RUN_NOW" = 1 ]; then
  say "== 7. first backup in background (first run = full upload, hours). Log: /var/log/backup-global.log"
  nohup bash "$SRC/backup-global.sh" >> /var/log/backup-global.log 2>&1 &
  say "  pid $!"
fi
[ "$APPLY" = 1 ] || say "
Nothing was changed (dry-run). Re-run with --apply [--run-now]."
