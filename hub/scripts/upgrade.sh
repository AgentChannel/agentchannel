#!/bin/sh
# Upgrade a hub that runs from a git checkout + systemd/launchd (no Docker).
# Docker Compose installs use deploy/compose/upgrade.sh instead.
#
#   upgrade.sh             backup, git pull, fetch PocketBase, restart, health check
#   upgrade.sh --rollback  stop, back to the previous commit, restore the
#                          pre-upgrade snapshot, start
#
# ACH_SERVICE (default agentchannel) is the systemd unit; ACH_RESTART may
# override the restart command, ACH_STOP / ACH_START the stop/start commands
# (e.g. launchctl). ACH_HUB_URL (default http://127.0.0.1:8090) for the check.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
HUB="$(cd "$HERE/.." && pwd)"
export ACH_DATA_DIR="${ACH_DATA_DIR:-$HUB/pb_data}"
export ACH_BACKUP_DIR="${ACH_BACKUP_DIR:-$HUB/pb_data_backups}"
SERVICE="${ACH_SERVICE:-agentchannel}"
URL="${ACH_HUB_URL:-http://127.0.0.1:8090}"
STATE="$ACH_BACKUP_DIR/.rollback"
SUDO=""
[ "$(id -u)" = 0 ] || SUDO="sudo"

stop_hub() { if [ -n "${ACH_STOP:-}" ]; then sh -c "$ACH_STOP"; else $SUDO systemctl stop "$SERVICE"; fi; }
start_hub() { if [ -n "${ACH_START:-}" ]; then sh -c "$ACH_START"; else $SUDO systemctl start "$SERVICE"; fi; }
restart_hub() { if [ -n "${ACH_RESTART:-}" ]; then sh -c "$ACH_RESTART"; else $SUDO systemctl restart "$SERVICE"; fi; }
healthy() {
  i=0
  while [ $i -lt 60 ]; do
    if curl -fsS --max-time 3 "$URL/api/health" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 2
  done
  return 1
}

rollback() {
  [ -f "$STATE" ] || { echo "rollback: no $STATE (no upgrade recorded)" >&2; exit 1; }
  rev="$(sed -n 1p "$STATE")"; snap="$(sed -n 2p "$STATE")"
  echo "rolling back to $rev with snapshot $snap"
  stop_hub
  git -C "$HUB" checkout --quiet "$rev"
  "$HERE/fetch-pocketbase.sh"
  "$HERE/restore.sh" "$snap" --yes
  start_hub
  healthy && echo "rollback ok (checkout is detached at $rev; 'git checkout <branch>' later to upgrade again)"
}

if [ "${1:-}" = "--rollback" ]; then rollback; exit 0; fi

"$HERE/check-update.sh" || true
rev="$(git -C "$HUB" rev-parse HEAD)"
snap="$("$HERE/backup.sh" --tag pre-upgrade | tail -1)"
printf '%s\n%s\n' "$rev" "$snap" > "$STATE"
echo "backup $snap taken; previous commit $rev"
git -C "$HUB" pull --ff-only
"$HERE/fetch-pocketbase.sh"
restart_hub
if healthy; then
  echo "upgrade ok: $(git -C "$HUB" rev-parse --short HEAD). Roll back with: $0 --rollback"
else
  echo "hub is not healthy after the upgrade; rolling back" >&2
  rollback
  exit 1
fi
