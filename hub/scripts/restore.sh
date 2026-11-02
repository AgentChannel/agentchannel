#!/bin/sh
# Restore a snapshot made by backup.sh into pb_data (docs/deploy.md "Restore").
#
#   restore.sh <ach-...name | path/to/snapshot-dir | path/to/ach-....tar.gz> --yes
#
# STOP THE HUB FIRST (systemctl stop / docker compose stop hub / fly scale count 0).
# The current database and storage are moved aside to
# $ACH_BACKUP_DIR/pre-restore-<time>/ (nothing is deleted). Run the hub version
# that made the snapshot (its VERSION file) or a newer one: migrations only go
# forward, so an older hub cannot open a newer database.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PB_DATA="${ACH_DATA_DIR:-$HERE/../pb_data}"
BACKUP_DIR="${ACH_BACKUP_DIR:-$PB_DATA/../pb_data_backups}"
SRC=""
YES=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) SRC="$a" ;;
  esac
done
if [ -z "$SRC" ]; then
  echo "usage: restore.sh <snapshot> --yes   (snapshots in $BACKUP_DIR:)" >&2
  for s in "$BACKUP_DIR"/ach-*; do [ -e "$s" ] && basename "$s" >&2; done
  exit 2
fi
[ "$YES" = 1 ] || { echo "restore: stop the hub first, then re-run with --yes" >&2; exit 2; }

if [ ! -e "$SRC" ] && [ -e "$BACKUP_DIR/$SRC" ]; then SRC="$BACKUP_DIR/$SRC"; fi
WORK=""
case "$SRC" in
  *.tar.gz)
    WORK="$BACKUP_DIR/.restore-$$"
    mkdir -p "$WORK"
    tar -xzf "$SRC" -C "$WORK"
    SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
    ;;
esac
[ -f "$SRC/data.db" ] || { echo "restore: $SRC has no data.db" >&2; exit 1; }
check="$(sqlite3 "$SRC/data.db" "PRAGMA integrity_check;")"
[ "$check" = "ok" ] || { echo "restore: snapshot integrity check failed: $check" >&2; exit 1; }

ASIDE="$BACKUP_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ASIDE" "$PB_DATA"
for f in data.db data.db-wal data.db-shm auxiliary.db auxiliary.db-wal auxiliary.db-shm storage; do
  if [ -e "$PB_DATA/$f" ]; then mv "$PB_DATA/$f" "$ASIDE/"; fi
done
cp "$SRC/data.db" "$PB_DATA/data.db"
if [ -f "$SRC/auxiliary.db" ]; then cp "$SRC/auxiliary.db" "$PB_DATA/auxiliary.db"; fi
if [ -d "$SRC/storage" ]; then
  cp -al "$SRC/storage" "$PB_DATA/storage" 2>/dev/null || { rm -rf "$PB_DATA/storage"; cp -R "$SRC/storage" "$PB_DATA/storage"; }
fi
VERSION_RESTORED="$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)"
if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
echo "restored $(basename "$SRC") (version $VERSION_RESTORED); previous data moved to $ASIDE"
echo "start the hub again."
