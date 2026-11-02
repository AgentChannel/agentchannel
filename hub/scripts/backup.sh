#!/bin/sh
# Snapshot the hub's pb_data while it runs (docs/deploy.md "Backups").
#
#   backup.sh [--tag NAME] [--archive]
#
# Writes $ACH_BACKUP_DIR/ach-<UTC time>[-NAME]/ with:
#   data.db, auxiliary.db  consistent SQLite online backups (sqlite3 .backup)
#   storage/               attachments, hard-linked when on the same disk
#                          (PocketBase never rewrites a stored file, so a
#                          snapshot costs almost no space)
#   VERSION                hub version at backup time (migrations only go forward)
# --archive (or an upload target) also writes ach-....tar.gz next to it.
# Upload (optional): ACH_BACKUP_RCLONE_REMOTE=r2:bucket/path (rclone), or
# ACH_BACKUP_S3_URI=s3://bucket/path [+ ACH_BACKUP_S3_ENDPOINT for R2/OSS/TOS]
# (aws cli). Local retention: ACH_BACKUP_KEEP untagged snapshots (default 7),
# 3 per tag. Prints the snapshot name on the last line.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PB_DATA="${ACH_DATA_DIR:-$HERE/../pb_data}"
BACKUP_DIR="${ACH_BACKUP_DIR:-$PB_DATA/../pb_data_backups}"
KEEP="${ACH_BACKUP_KEEP:-7}"
TAG=""
ARCHIVE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --archive) ARCHIVE=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$TAG" in *[!A-Za-z0-9_-]*) echo "--tag: letters, digits, - and _ only" >&2; exit 2 ;; esac

command -v sqlite3 >/dev/null 2>&1 || { echo "backup: sqlite3 is required" >&2; exit 1; }
[ -f "$PB_DATA/data.db" ] || { echo "backup: no $PB_DATA/data.db" >&2; exit 1; }

NAME="ach-$(date -u +%Y%m%dT%H%M%SZ)${TAG:+-$TAG}"
mkdir -p "$BACKUP_DIR"
TMP="$BACKUP_DIR/.$NAME.partial"
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

for db in data.db auxiliary.db; do
  [ -f "$PB_DATA/$db" ] || continue
  sqlite3 "$PB_DATA/$db" ".timeout 10000" ".backup '$TMP/$db'"
done
check="$(sqlite3 "$TMP/data.db" "PRAGMA integrity_check;")"
[ "$check" = "ok" ] || { echo "backup: integrity check failed: $check" >&2; exit 1; }

if [ -d "$PB_DATA/storage" ]; then
  # hard links where possible (same disk, own files); else a plain copy
  cp -al "$PB_DATA/storage" "$TMP/storage" 2>/dev/null || { rm -rf "$TMP/storage"; cp -R "$PB_DATA/storage" "$TMP/storage"; }
fi
if [ -r /app/VERSION ]; then cp /app/VERSION "$TMP/VERSION"; else echo "${ACH_VERSION:-unknown}" > "$TMP/VERSION"; fi
mv "$TMP" "$BACKUP_DIR/$NAME"
trap - EXIT

if [ -n "${ACH_BACKUP_RCLONE_REMOTE:-}${ACH_BACKUP_S3_URI:-}" ]; then ARCHIVE=1; fi
if [ "$ARCHIVE" = 1 ]; then
  tar -czf "$BACKUP_DIR/$NAME.tar.gz" -C "$BACKUP_DIR" "$NAME"
  # An offsite copy that fails (tool missing, network, credentials) must not
  # skip retention below, or every daily run would leave another full archive
  # and fill the disk. It keeps the archive for the next attempt and reports it.
  OFFSITE_FAILED=""
  if [ -n "${ACH_BACKUP_RCLONE_REMOTE:-}" ]; then
    if command -v rclone >/dev/null 2>&1 && rclone copy "$BACKUP_DIR/$NAME.tar.gz" "$ACH_BACKUP_RCLONE_REMOTE"; then
      rm -f "$BACKUP_DIR/$NAME.tar.gz"
    else
      OFFSITE_FAILED="rclone copy to $ACH_BACKUP_RCLONE_REMOTE failed (is rclone installed and configured where this runs?)"
    fi
  elif [ -n "${ACH_BACKUP_S3_URI:-}" ]; then
    if command -v aws >/dev/null 2>&1 && aws s3 cp ${ACH_BACKUP_S3_ENDPOINT:+--endpoint-url "$ACH_BACKUP_S3_ENDPOINT"} "$BACKUP_DIR/$NAME.tar.gz" "${ACH_BACKUP_S3_URI%/}/$NAME.tar.gz"; then
      rm -f "$BACKUP_DIR/$NAME.tar.gz"
    else
      OFFSITE_FAILED="aws s3 cp to $ACH_BACKUP_S3_URI failed (is the aws CLI installed and configured where this runs?)"
    fi
  fi
fi

# Retention: newest $KEEP untagged snapshots, newest 3 per tag; old archives too.
prune() { # $1 = name pattern (glob), $2 = how many to keep
  # shellcheck disable=SC2012,SC2086 # $1 is a glob on purpose; names are ours
  ls -1d "$BACKUP_DIR"/$1 2>/dev/null | sort -r | awk -v k="$2" 'NR > k' | while IFS= read -r old; do rm -rf "$old"; done
}
prune 'ach-[0-9]*Z' "$KEEP"
prune 'ach-[0-9]*Z.tar.gz' "$KEEP"
# shellcheck disable=SC2012
for t in $(ls -1 "$BACKUP_DIR" 2>/dev/null | sed -n 's/^ach-[0-9]*T[0-9]*Z-\([A-Za-z0-9_-]*\)$/\1/p' | sort -u); do
  prune "ach-[0-9]*Z-$t" 3
done

echo "backup ok: $BACKUP_DIR/$NAME ($(du -sh "$BACKUP_DIR/$NAME" | awk '{print $1}'))" >&2
if [ -n "${OFFSITE_FAILED:-}" ]; then
  echo "backup: OFFSITE COPY FAILED: $OFFSITE_FAILED; the archive stays in $BACKUP_DIR" >&2
  echo "$NAME"
  exit 3
fi
echo "$NAME"
