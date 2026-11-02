#!/bin/sh
# AgentChannel hub container entrypoint, also installed as `ach` in the image:
#   ach serve                      start the hub (default)
#   ach backup [--tag t] [--archive]   snapshot pb_data (see hub/scripts/backup.sh)
#   ach restore <name|file> --yes  restore a snapshot (stop the hub first)
#   ach restore-on-restart <name>  restore at the next start (PaaS: then restart)
#   ach superuser upsert <email> <password>   recovery only (dashboard /_/)
#   ach version | ach check-update
# Started as root, it fixes /data ownership and re-executes itself as "ach".
set -eu

: "${ACH_DATA_DIR:=/data/pb_data}"
: "${ACH_BACKUP_DIR:=/data/backups}"
: "${PORT:=8090}"
export ACH_DATA_DIR ACH_BACKUP_DIR PORT

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$ACH_DATA_DIR" "$ACH_BACKUP_DIR"
  for d in /data "$ACH_DATA_DIR" "$ACH_BACKUP_DIR"; do
    if [ "$(stat -c %u "$d")" != "10001" ]; then chown -R ach:ach "$d"; fi
  done
  exec su-exec ach "$0" "$@"
fi

if [ -z "${ACH_VERSION:-}" ] && [ -r /app/VERSION ]; then
  ACH_VERSION="$(cat /app/VERSION)"
  export ACH_VERSION
fi

# The one required setting. Platforms that publish their default hostname
# fill it in until you set your own domain.
if [ -z "${ACH_PUBLIC_URL:-}" ]; then
  if [ -n "${RENDER_EXTERNAL_URL:-}" ]; then ACH_PUBLIC_URL="$RENDER_EXTERNAL_URL"
  elif [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then ACH_PUBLIC_URL="https://$RAILWAY_PUBLIC_DOMAIN"
  elif [ -n "${FLY_APP_NAME:-}" ]; then ACH_PUBLIC_URL="https://$FLY_APP_NAME.fly.dev"
  fi
  if [ -n "${ACH_PUBLIC_URL:-}" ]; then
    export ACH_PUBLIC_URL
    echo "ACH_PUBLIC_URL not set; using the platform hostname $ACH_PUBLIC_URL"
  fi
fi

pb() {
  pocketbase "$@" --dir "$ACH_DATA_DIR" --hooksDir /app/pb_hooks --migrationsDir /app/pb_migrations
}

backup_loop() {
  hours="${ACH_BACKUP_EVERY_HOURS:-24}"
  case "$hours" in ''|0|*[!0-9]*) return 0 ;; esac
  sleep 300 # let the hub finish starting and migrating
  while :; do
    ach-backup || echo "ach: scheduled backup failed" >&2
    ach-check-update || true
    sleep $((hours * 3600))
  done
}

cmd="${1:-serve}"
[ $# -gt 0 ] && shift
case "$cmd" in
  serve)
    if [ "${ACH_TEST_HOOKS:-}" = "1" ] && [ "${ACH_ALLOW_TEST_HOOKS:-}" != "1" ]; then
      echo "refusing to start: ACH_TEST_HOOKS=1 enables test-only routes. Unset it (production must never set it)." >&2
      exit 1
    fi
    if [ -f /data/RESTORE ]; then
      snap="$(cat /data/RESTORE)"
      echo "restoring snapshot $snap before start (requested with restore-on-restart)"
      ach-restore "$snap" --yes
      rm -f /data/RESTORE
    fi
    echo "AgentChannel hub ${ACH_VERSION:-dev} (pocketbase $(pocketbase --version | awk '{print $NF}')), data in $ACH_DATA_DIR"
    backup_loop &
    exec pocketbase serve --dir "$ACH_DATA_DIR" --hooksDir /app/pb_hooks \
      --migrationsDir /app/pb_migrations --publicDir /app/pb_public \
      --hooksWatch=false --http "0.0.0.0:$PORT" "$@"
    ;;
  backup) exec ach-backup "$@" ;;
  restore) exec ach-restore "$@" ;;
  restore-on-restart)
    if [ -z "${1:-}" ] || [ ! -e "$ACH_BACKUP_DIR/$1" ]; then echo "usage: ach restore-on-restart <snapshot in $ACH_BACKUP_DIR>" >&2; ls -1 "$ACH_BACKUP_DIR" >&2; exit 2; fi
    echo "$1" > /data/RESTORE
    echo "restart the hub now (fly machine restart / Railway or Render: Restart); it restores $1 before starting"
    ;;
  check-update) exec ach-check-update "$@" ;;
  superuser) pb superuser "$@" ;;
  migrate) pb migrate "$@" ;;
  version) echo "${ACH_VERSION:-dev}"; pocketbase --version ;;
  pocketbase) exec pocketbase "$@" ;;
  *) exec "$cmd" "$@" ;;
esac
