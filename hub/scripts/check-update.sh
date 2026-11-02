#!/bin/sh
# Is there a newer hub release? Reads only the public GitHub releases API
# (one anonymous GET; nothing about this hub is sent). No telemetry.
#
#   check-update.sh [current-version]
#
# Disable with ACH_UPDATE_CHECK=0. Repo: ACH_UPDATE_REPO (default
# AgentChannel/agentchannel). Current version: argument, else $ACH_VERSION,
# else /app/VERSION, else GET $ACH_HUB_URL/api/ach/version.
# Exit 0 always (it only prints); prints "update available: X -> Y" when newer.
set -u

[ "${ACH_UPDATE_CHECK:-1}" = "0" ] && exit 0
REPO="${ACH_UPDATE_REPO:-AgentChannel/agentchannel}"

fetch() { # url
  if command -v curl >/dev/null 2>&1; then curl -fsSL --max-time 10 -H 'Accept: application/vnd.github+json' "$1"
  else wget -q -T 10 -O - "$1"; fi
}

CUR="${1:-${ACH_VERSION:-}}"
if [ -z "$CUR" ] && [ -r /app/VERSION ]; then CUR="$(cat /app/VERSION)"; fi
if [ -z "$CUR" ]; then
  CUR="$(fetch "${ACH_HUB_URL:-http://127.0.0.1:8090}/api/ach/version" 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')"
fi
CUR="${CUR%%+*}"
CUR="${CUR#v}"
[ -n "$CUR" ] || { echo "check-update: current version unknown" >&2; exit 0; }

LATEST="$(fetch "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
LATEST="${LATEST#v}"
[ -n "$LATEST" ] || { echo "check-update: could not read releases of $REPO" >&2; exit 0; }

# 1 when $1 > $2 (numeric major.minor.patch; a pre-release sorts before its release)
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, x, "-"); nb = split(b, y, "-")
    split(x[1], p, "."); split(y[1], q, ".")
    for (i = 1; i <= 3; i++) { if (p[i] + 0 > q[i] + 0) { print 1; exit } if (p[i] + 0 < q[i] + 0) { print 0; exit } }
    if (na == 1 && nb > 1) { print 1; exit }
    if (na > 1 && nb > 1 && x[2] > y[2]) { print 1; exit }
    print 0 }'
}
if [ "$(newer "$LATEST" "$CUR")" = 1 ]; then
  echo "update available: $CUR -> $LATEST (https://github.com/$REPO/releases/tag/v$LATEST); see docs/deploy.md \"Upgrades\""
else
  echo "up to date ($CUR; latest release $LATEST)"
fi
exit 0
