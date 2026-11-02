# syntax=docker/dockerfile:1
# agentchannel-runner: an always-on `ach run` for team/shared agents, so they
# wake without anyone's laptop. Same version as the hub: the CLI is built from
# packages/agentchannel in this checkout. Includes git, the Claude Code CLI and
# the Codex CLI. Runs as uid 10002 ("runner"); /work is its persistent volume
# (repos, worktrees, the runner's state).
# Build from the repo root:
#   docker build -f deploy/runner/Dockerfile -t agentchannel-runner .
ARG NODE_IMAGE=node:22.21.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY packages/agentchannel/package.json packages/agentchannel/package-lock.json packages/agentchannel/tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/agentchannel/src ./src
RUN npx tsc -p tsconfig.json \
 && node -e "const p=require('./package.json');p.scripts={};require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))" \
 && mkdir -p /out && npm pack --pack-destination /out \
 && mv /out/agentchannel-*.tgz /out/agentchannel.tgz

FROM ${NODE_IMAGE}
ARG CLAUDE_CODE_VERSION=2.1.314
ARG CODEX_VERSION=0.166.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client bubblewrap socat ripgrep tini procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10002 runner \
 && useradd -u 10002 -g runner -m -d /home/runner -s /bin/bash runner \
 && mkdir -p /work && chown runner:runner /work
COPY --from=build /out/agentchannel.tgz /tmp/agentchannel.tgz
RUN npm install -g --no-audit --no-fund /tmp/agentchannel.tgz \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && rm /tmp/agentchannel.tgz && npm cache clean --force \
 && ach version && claude --version && codex --version
COPY deploy/runner/entrypoint.sh /usr/local/bin/runner-entrypoint
RUN chmod 0755 /usr/local/bin/runner-entrypoint

ENV AGENTCHANNEL_HOME=/work/.agentchannel \
    ACH_KEYSTORE=file \
    ACH_RUNTIME=claude \
    ACH_MAX=2 \
    ACH_PERM=workdir
WORKDIR /work
# Liveness: the runner process is up (it has no HTTP port).
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 CMD pgrep -f "ach.* run" >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/runner-entrypoint"]
CMD ["run"]
