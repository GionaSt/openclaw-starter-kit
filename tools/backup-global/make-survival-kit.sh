#!/usr/bin/env bash
# make-survival-kit.sh — build the SURVIVAL KIT to keep OFF the VPS (password
# manager + USB stick). Without it an encrypted backup is worthless.
# Contains: rclone.conf (Drive token), restic.pass, backup-global.env,
# restore-global.sh, gen-docker-run.py, README. Output: /root/backup-global-KIT-<date>.tar.gz (chmod 600).
# Download it ONCE (scp / FileZilla), then delete it from the VPS if you like.
set -euo pipefail
CONF_DIR="${BACKUP_GLOBAL_DIR:-/root/.backup-global}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="/root/backup-global-KIT-$(date +%F).tar.gz"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/kit"
RCLONE_CONF="$(rclone config file 2>/dev/null | tail -1)"; [ -f "$RCLONE_CONF" ] || RCLONE_CONF=/root/.config/rclone/rclone.conf
cp "$RCLONE_CONF" "$TMP/kit/rclone.conf" 2>/dev/null || echo "WARNING: rclone.conf not found ($RCLONE_CONF)"
cp "$CONF_DIR/restic.pass" "$CONF_DIR/backup-global.env" "$TMP/kit/" 2>/dev/null || echo "WARNING: restic.pass or backup-global.env missing"
cp "$SRC/restore-global.sh" "$SRC/gen-docker-run.py" "$SRC/README.md" "$TMP/kit/" 2>/dev/null || true
cat > "$TMP/kit/README-RESTORE.txt" <<'EOF2'
DISASTER RECOVERY ON A FRESH VPS (Ubuntu), as root:
 1. scp / FileZilla: upload this kit to the VPS, extract it:  tar xzf backup-global-KIT-*.tar.gz
 2. bash kit/restore-global.sh --bootstrap        (docker, restic, rclone, nginx, certbot)
 3. mkdir -p /root/.config/rclone /root/.backup-global
    cp kit/rclone.conf /root/.config/rclone/ ; cp kit/restic.pass kit/backup-global.env /root/.backup-global/ ; chmod 600 /root/.backup-global/*
 4. bash kit/restore-global.sh --list             (see the snapshots)
 5. bash kit/restore-global.sh --full --yes       (download everything and bring services up)
 6. DNS: point your A records to the new IP.
 7. Inside each OpenClaw container that uses the Claude CLI: reinstall the CLI (see docs/02-claude-subscription.md).
Realistic time: 20-60 minutes, almost all of it download from the remote.
EOF2
tar -C "$TMP" -czf "$OUT" kit && chmod 600 "$OUT"
echo "KIT ready: $OUT ($(du -h "$OUT" | cut -f1)) sha256 $(sha256sum "$OUT" | cut -c1-16)"
echo "Download it and put it in your password manager. It contains the Drive token and the backup password."
