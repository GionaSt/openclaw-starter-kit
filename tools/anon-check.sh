#!/usr/bin/env bash
# Anonymization gate. Run before every commit if you fork/extend this kit.
# Exit 1 if any secret pattern or blacklisted personal term is found.
#
# Extend BLACKLIST with your own name, businesses, domains, chat IDs before
# committing anything you authored.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SECRET_PATTERNS=(
  'sk-ant-oat01-[A-Za-z0-9_-]{8,}'
  'sk-ant-api03-[A-Za-z0-9_-]{8,}'
  'AIza[0-9A-Za-z_-]{30,}'
  'ghp_[A-Za-z0-9]{20,}'
  'xox[bap]-[A-Za-z0-9-]{10,}'
  '[0-9]{8,10}:[A-Za-z0-9_-]{30,}'    # telegram bot token
  'BEGIN (RSA|OPENSSH|EC) PRIVATE KEY'
)

# Personal terms that must never appear in the kit (case-insensitive).
# NOTE: maintained OUTSIDE the repo on purpose; see tools/anon-blacklist.local
BLACKLIST_FILE="$ROOT/tools/anon-blacklist.local"

FAIL=0
for p in "${SECRET_PATTERNS[@]}"; do
  HITS=$(grep -rInE --binary-files=without-match \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist \
    "$p" "$ROOT" | grep -v 'anon-check.sh' || true)
  if [ -n "$HITS" ]; then
    echo "SECRET PATTERN HIT: $p"
    echo "$HITS"
    FAIL=1
  fi
done

if [ -f "$BLACKLIST_FILE" ]; then
  while IFS= read -r term; do
    [ -z "$term" ] && continue
    case "$term" in \#*) continue ;; esac
    HITS=$(grep -rIni --binary-files=without-match \
      --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist \
      --exclude=package-lock.json \
      -- "$term" "$ROOT" | grep -v 'anon-blacklist.local' || true)
    if [ -n "$HITS" ]; then
      echo "BLACKLIST TERM HIT: $term"
      echo "$HITS"
      FAIL=1
    fi
  done < "$BLACKLIST_FILE"
else
  echo "note: no $BLACKLIST_FILE found (create it with one personal term per line; it is gitignored)"
fi

if [ "$FAIL" -eq 1 ]; then
  echo; echo "FAILED: fix the hits above before committing."
  exit 1
fi
echo "anon-check: clean."
