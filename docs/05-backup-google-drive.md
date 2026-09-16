# Nightly backup of the whole VPS to Google Drive

Everything the assistant is (config, memory, sessions, workspace, docker state)
lives on one disk. This sets up a nightly encrypted, deduplicated backup of the
whole host to your Google Drive with [restic](https://restic.net) over
[rclone](https://rclone.org), plus a one-command restore. Scripts are in
`tools/backup-global/`.

Time: about 20 minutes of setup, then it runs itself at 03:00 host time.

## 0. What you need

- Root access to the VPS (the scripts run on the HOST, not inside a container).
- A Google account with enough free Drive space: the first upload is roughly the
  size of `/root/.openclaw` plus your docker volumes (typically 2-15 GB). After that
  only daily changes travel (hundreds of MB).
- Optional: a Telegram bot token + your chat id if you want a nightly report message.

## 1. Install rclone and connect it to Google Drive

On the VPS, as root:

```bash
curl -fsSL https://rclone.org/install.sh | bash
rclone config
```

Answer the wizard like this:

1. `n` (new remote), name: `gdrive`
2. Storage: `drive` (Google Drive)
3. `client_id` / `client_secret`: leave empty (press Enter) unless you created your own OAuth app
4. scope: `1` (full access)
5. `service_account_file`: empty
6. Edit advanced config: `n`
7. **Use auto config: `n`** (the VPS has no browser). rclone prints a command like
   `rclone authorize "drive" "eyJ..."`. Run THAT command on your laptop (install rclone
   there too), log in with your Google account in the browser, and paste the resulting
   token back into the VPS prompt.
8. Shared drive: `n`. Confirm with `y`, then `q`.

Check: `rclone lsd gdrive:` must list your Drive folders.

## 2. Install the backup

```bash
cd /path/to/openclaw-starter-kit
bash tools/backup-global/install-host.sh            # dry-run, shows what it will do
bash tools/backup-global/install-host.sh --apply    # installs restic, creates /root/.backup-global, init repo, adds cron
```

Before `--apply`, or right after, edit `/root/.backup-global/backup-global.env`:

- `OPENCLAW_HOME`: where OpenClaw keeps its state (`/root/.openclaw` by default; if you
  run OpenClaw as a non-root user it is `/home/<user>/.openclaw`).
- `OPENCLAW_COMPOSE_DIR`: the folder with your `docker-compose.yml`.
- `EXTRA_PATHS`: anything else you want in (space separated).
- `DOCKER_VOLUME_PREFIX`: volumes to include from the host filesystem (empty to disable).
- `TG_TOKEN` / `TG_CHAT`: optional nightly Telegram report.
- `PG_DUMP_URL`: optional external Postgres dump.

Then start the first backup (it can take hours, it is the full upload):

```bash
bash tools/backup-global/backup-global.sh
# or, from the installer: install-host.sh --apply --run-now (runs in background, log in /var/log/backup-global.log)
```

If the kit lives inside the OpenClaw workspace (recommended, e.g.
`/root/.openclaw/workspace/openclaw-starter-kit`), the cron line points there and
any edit to the script is live the next night.

## 3. Save the survival kit OFF the VPS (mandatory)

`install-host.sh --apply` creates `/root/backup-global-KIT-<date>.tar.gz`. It contains:

- `rclone.conf` (the Drive token)
- `restic.pass` (the encryption password, random, generated on install)
- `backup-global.env`, `restore-global.sh`, `gen-docker-run.py`, `README-RESTORE.txt`

Download it (scp / FileZilla) and store it in your password manager. If the VPS dies
and you do not have this file, the backup on Drive is unreadable. Delete the tarball
from the VPS afterwards if you want.

## 4. Check it works

- Next morning: `cat /root/.openclaw/workspace/tools/backup-global/last-run.json`
  (or ask your assistant "backup status": it can read that file from its container).
  `status` should be `ok` or `ok-with-warnings`.
- On the host: `restic snapshots` (with `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE`
  from the env file exported) or simply `bash tools/backup-global/restore-global.sh --list`.
- Do ONE real restore test now, not the day you need it:
  `bash tools/backup-global/restore-global.sh --files --target /tmp/r` and check that
  `/tmp/r/root/.openclaw/openclaw.json` and the `.sqlite.bak` copies are there.

## 5. Restore

| Situation | Command |
|---|---|
| Lost a file/folder | `restore-global.sh --path /root/.openclaw/workspace/memory --snapshot <id>` |
| Look inside a snapshot | `restore-global.sh --files --snapshot <id> --target /tmp/r` |
| Same VPS, badly damaged | `restore-global.sh --full` |
| Brand new VPS | upload the kit, `restore-global.sh --bootstrap`, copy the 3 kit files where it tells you, `restore-global.sh --full --yes` |

After a full restore on a new VPS you still do by hand: DNS to the new IP, firewall
rules (saved in `/root/.backup-global/snapshot/host/ufw-status.txt`), and reinstalling
the Claude CLI inside containers if you use the subscription bridge.

## How it works (for the curious)

Every night: dump host state (crontab, docker inspect, ufw, packages) → consistent
copy of every SQLite DB with `VACUUM INTO` → optional `pg_dump` → `restic backup` of
all paths (dedup, AES encryption, only changed blocks uploaded) → `restic forget`
7 daily / 4 weekly / 6 monthly / 2 yearly, prune on Sundays, integrity check on the 1st
→ a small local config-only tarball (3 days) → Telegram + `last-run.json`.

Footguns already handled:

- A transient Drive error is NOT treated as "repository missing" (which would make
  `restic init` die on an existing config): 3 attempts, then a clear "unreachable" error.
- Live SQLite files are excluded; the consistent copies carry a `.bak` suffix so the
  `*.db` exclude pattern does not eat them.
- Free disk check before starting (`MIN_FREE_MB`), lock file against overlapping runs.
- The installer merges the crontab, never overwrites it, and saves a copy first.
