# syntax=docker/dockerfile:1
# AgentChannel hub image: PocketBase (pinned, checksum-verified) + hub/pb_*.
# Build from the repo root:
#   docker build -f deploy/docker/Dockerfile -t agentchannel-hub .
# Multi-arch:
#   docker buildx build --platform linux/amd64,linux/arm64 -f deploy/docker/Dockerfile .
# Data: mount a persistent volume at /data (pb_data in /data/pb_data,
# snapshots in /data/backups). The server runs as uid 10001 (user "ach"); the
# entrypoint starts as root only to fix /data ownership on platforms that mount
# volumes root-owned (Fly, Railway, Render), then drops privileges.

ARG ALPINE_IMAGE=alpine:3.20.3

FROM ${ALPINE_IMAGE} AS fetch
ARG TARGETARCH
ARG PB_VERSION=0.40.6
# sha256 of pocketbase_${PB_VERSION}_linux_<arch>.zip (from the release's checksums.txt).
ARG PB_SHA256_AMD64=0e1f609158ed945f809f8a02ae012aa0427129c66ebb63c1aee76f2c0309373f
ARG PB_SHA256_ARM64=d22c66ceb67ca92b7d767f36d826e848a276bcfa3c197ead20bf87c42208984f
# A mirror may be used (e.g. in mainland China); the pinned checksum still applies.
ARG PB_DOWNLOAD_BASE=https://github.com/pocketbase/pocketbase/releases/download
RUN apk add --no-cache ca-certificates curl unzip
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) sum="$PB_SHA256_AMD64"; arch=amd64 ;; \
      arm64) sum="$PB_SHA256_ARM64"; arch=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/pb.zip "$PB_DOWNLOAD_BASE/v$PB_VERSION/pocketbase_${PB_VERSION}_linux_${arch}.zip"; \
    echo "$sum  /tmp/pb.zip" | sha256sum -c -; \
    mkdir -p /out; unzip -q /tmp/pb.zip pocketbase -d /out; chmod 0755 /out/pocketbase

FROM ${ALPINE_IMAGE}
ARG ACH_GIT_SHA=""
RUN apk add --no-cache ca-certificates tzdata sqlite su-exec tini \
 && addgroup -S -g 10001 ach \
 && adduser -S -D -H -u 10001 -G ach -h /data ach \
 && mkdir -p /data/pb_data /data/backups \
 && chown -R ach:ach /data
COPY --from=fetch /out/pocketbase /usr/local/bin/pocketbase
COPY hub/pb_migrations /app/pb_migrations
COPY hub/pb_hooks /app/pb_hooks
COPY hub/pb_public /app/pb_public
COPY hub/package.json /app/package.json
COPY hub/scripts/backup.sh /usr/local/bin/ach-backup
COPY hub/scripts/restore.sh /usr/local/bin/ach-restore
COPY hub/scripts/check-update.sh /usr/local/bin/ach-check-update
COPY deploy/docker/entrypoint.sh /usr/local/bin/ach
RUN chmod 0755 /usr/local/bin/ach /usr/local/bin/ach-backup /usr/local/bin/ach-restore /usr/local/bin/ach-check-update; \
    v="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /app/package.json | head -1)"; \
    echo "${v:-dev}${ACH_GIT_SHA:++$ACH_GIT_SHA}" > /app/VERSION; cat /app/VERSION

ENV ACH_DATA_DIR=/data/pb_data \
    ACH_BACKUP_DIR=/data/backups \
    ACH_BACKUP_EVERY_HOURS=24 \
    ACH_BACKUP_KEEP=7 \
    PORT=8090
WORKDIR /data
EXPOSE 8090
# PocketBase's own health route; also used by Fly, Railway and Render.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/ach"]
CMD ["serve"]
