# Global VPS backup to Google Drive (restic + rclone)

One engine that backs up the WHOLE OpenClaw VPS every night, encrypted and
deduplicated, to Google Drive (or any rclone remote), with a one-command restore.
Full walkthrough: [docs/05-backup-google-drive.md](../../docs/05-backup-google-drive.md).

## What it saves

1. `$OPENCLAW_HOME` (default `/root/.openclaw`): config, credentials, sessions, workspace, memory.
2. Your OpenClaw compose dir, rclone/ssh/claude configs, nginx, Let's Encrypt, ufw, systemd units, cron.
3. Docker inventory (`docker inspect` of every container, volumes, images, networks) so containers can be recreated.
4. Docker volumes whose name starts with `DOCKER_VOLUME_PREFIX` (extra OpenClaw instances).
5. CONSISTENT copies of every SQLite database (`VACUUM INTO`), never a hot copy.
6. Optional `pg_dump` of an external Postgres (`PG_DUMP_URL`).

Excluded on purpose (regenerable): `node_modules`, `.venv`, `.trash`, `tmp`, npm/browser caches, live SQLite files.

## Files

| File | Role |
|---|---|
| `backup-global.sh` | the nightly job (cron, root, host) |
| `restore-global.sh` | `--list`, `--path`, `--files`, `--full`, `--bootstrap` |
| `install-host.sh` | one-time installer (dry-run by default) |
| `make-survival-kit.sh` | tarball with Drive token + restic password + restore script, to keep OFF the VPS |
| `gen-docker-run.py` | rebuilds `docker run` commands for standalone containers from the saved inspect |
| `backup-global.env.example` | all settings, copied to `/root/.backup-global/backup-global.env` |

## Install (once, on the host as root)

```bash
rclone config                                  # create a Google Drive remote named "gdrive" (see the doc)
bash tools/backup-global/install-host.sh       # dry-run
bash tools/backup-global/install-host.sh --apply --run-now
```

Then download `/root/backup-global-KIT-<date>.tar.gz` and store it in your password manager.
Without that kit the backups are unreadable.

## Verify

- `tools/backup-global/last-run.json` in the workspace: `status` (`ok`, `ok-with-warnings`, `failed`), `snapshot_id`, `warnings`, `gaps`. Your assistant can read it from inside its container.
- `restic snapshots` on the host, or `restore-global.sh --list`.
- Do one real test after the first backup: `restore-global.sh --files --target /tmp/r` and look inside.

## Restore

| Case | Command (host, root) |
|---|---|
| One file or folder | `restore-global.sh --path /root/.openclaw/workspace/memory --snapshot <id>` then copy from `/tmp/restore-<stamp>/...` |
| Inspect a snapshot | `restore-global.sh --files --snapshot <id> --target /tmp/r` |
| Current VPS damaged | `restore-global.sh --full` (asks for confirmation) |
| NEW VPS | upload the kit, `restore-global.sh --bootstrap`, copy the 3 kit files, `restore-global.sh --full --yes` |

Honest timing: a full restore is one command but takes 20-60 minutes, almost all download.
