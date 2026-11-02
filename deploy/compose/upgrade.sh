#!/bin/sh
# Upgrade / roll back the Docker Compose hub (docs/deploy.md "Upgrades").
#
#   ./upgrade.sh              snapshot (tag pre-upgrade), keep the running image
#                             as agentchannel-hub:rollback, git pull, rebuild (or
#                             pull ACH_IMAGE), restart, wait for healthy;
#                             rolls back by itself if the new hub is not healthy
#   ./upgrade.sh --no-pull    same without `git pull` (you checked out a version)
#   ./upgrade.sh --rollback   previous image + the pre-upgrade snapshot
#   ./upgrade.sh --check      only check for a newer release (public GitHub API)
# Migrations run automatically when the new hub starts.
set -eu
cd "$(dirname "$0")"

# The image compose runs: ACH_IMAGE from the shell, else from .env (as compose reads it).
if [ -z "${ACH_IMAGE:-}" ] && [ -f .env ]; then
  ACH_IMAGE="$(sed -n 's/^ACH_IMAGE=//p' .env | tail -1 | tr -d "\"'")"
fi
IMAGE="${ACH_IMAGE:-agentchannel-hub:local}"
ROLLBACK_IMAGE="agentchannel-hub:rollback"
STATE=".rollback"
dc() { docker compose "$@"; }

healthy() {
  i=0
  while [ $i -lt 90 ]; do
    id="$(dc ps -q hub)"
    if [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" = "healthy" ]; then return 0; fi
    i=$((i + 1)); sleep 2
  done
  return 1
}

rollback() {
  [ -f "$STATE" ] || { echo "rollback: nothing recorded in $STATE" >&2; exit 1; }
  snap="$(cat "$STATE")"
  docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1 || { echo "rollback: image $ROLLBACK_IMAGE is missing" >&2; exit 1; }
  echo "rolling back: image $ROLLBACK_IMAGE, snapshot $snap"
  dc stop hub
  docker tag "$ROLLBACK_IMAGE" "$IMAGE"
  dc run --rm --no-deps -T hub restore "$snap" --yes
  dc up -d --no-build hub
  if healthy; then echo "rollback ok. Note: a later 'docker compose up --build' rebuilds from your checkout."; else echo "rollback: hub not healthy; see 'docker compose logs hub'" >&2; exit 1; fi
}

case "${1:-}" in
  --rollback) rollback; exit 0 ;;
  --check) dc exec -T hub ach check-update; exit 0 ;;
  --no-pull|"") ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac

[ -n "$(dc ps -q hub)" ] || { echo "the hub is not running; start it with 'docker compose up -d' first" >&2; exit 1; }
dc exec -T hub ach check-update || true
snap="$(dc exec -T hub ach backup --tag pre-upgrade | tail -1 | tr -d '\r')"
[ -n "$snap" ] || { echo "backup failed; not upgrading" >&2; exit 1; }
echo "$snap" > "$STATE"
docker tag "$(docker inspect -f '{{.Image}}' "$(dc ps -q hub)")" "$ROLLBACK_IMAGE"
echo "snapshot $snap taken; current image saved as $ROLLBACK_IMAGE"

if [ "${1:-}" != "--no-pull" ] && git -C ../.. rev-parse --git-dir >/dev/null 2>&1; then
  git -C ../.. pull --ff-only
fi
if [ "$IMAGE" = "agentchannel-hub:local" ]; then
  ACH_GIT_SHA="$(git -C ../.. rev-parse --short HEAD 2>/dev/null || true)" dc build hub
else
  dc pull hub
fi
dc up -d hub
if healthy; then
  echo "upgrade ok: $(dc exec -T hub ach version | head -1). Roll back with: $0 --rollback"
else
  echo "the new hub is not healthy; rolling back" >&2
  dc logs --tail 50 hub >&2 || true
  rollback
  exit 1
fi
