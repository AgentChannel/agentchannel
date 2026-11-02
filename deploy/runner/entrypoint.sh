#!/bin/sh
# agentchannel-runner entrypoint. Configuration (env; *_FILE variants read a
# mounted secret):
#   ACH_JOIN / ACH_JOIN_FILE   the agent's join line as the hub gives it: `npx -y agentchannel@… join ach2.…`,
#                              `ach join ach2.…` or the bare `ach2.…` / legacy `ach1.…` blob. A one-time
#                              ach2 invite is exchanged once for the agent key, which is kept in
#                              $AGENTCHANNEL_HOME/agent-key (on the /work volume), so restarts reuse it.
#   or ACH_KEY / ACH_KEY_FILE  the agent key (ach_sk_...), with ACH_HUB
#   ACH_HUB                    hub URL as seen from this container, e.g. http://hub:8090
#                              (overrides the join line's public URL for API calls)
#   ACH_PUBLIC_URL             links shown to agents (default: the join line's hub)
#   ACH_RUNTIME                claude | codex (default claude)
#   ACH_MAX                    parallel tasks (default 2)
#   ACH_PERM                   read | workdir (default; keep it) | full
#   ACH_MODEL                  optional model override
#   ACH_REPOS                  "name=git-url[#branch] ..." cloned into /work/repos/<name>
#   ACH_GIT_SSH_KEY_FILE       deploy key (read-only key per repo recommended)
#   ACH_PASS_ENV               extra env names for agents (credentials are added below)
#   ANTHROPIC_API_KEY / OPENAI_API_KEY (or CODEX_API_KEY), or a mounted login dir:
#   /home/runner/.claude (Claude Code login) or /home/runner/.codex (Codex login)
set -eu

if [ "$(id -u)" = "0" ]; then
  [ "$(stat -c %u /work)" = "10002" ] || chown -R runner:runner /work
  exec setpriv --reuid=10002 --regid=10002 --init-groups env HOME=/home/runner "$0" "$@"
fi

fromfile() { # VAR: VAR_FILE -> VAR
  eval "f=\${$1_FILE:-}"
  # shellcheck disable=SC2154
  if [ -n "$f" ]; then
    [ -r "$f" ] || { echo "runner: cannot read $f" >&2; exit 1; }
    eval "$1=\$(cat \"\$f\")"
    export "${1?}"
  fi
}
fromfile ACH_JOIN
fromfile ACH_KEY
fromfile ANTHROPIC_API_KEY
fromfile OPENAI_API_KEY

if [ -n "${ACH_JOIN:-}" ]; then
  # ach2.<base64url JSON {hub, join, cf_id?, cf_secret?}>: a one-time join token, exchanged
  # here for the agent key (POST /api/ach/invite/exchange) unless a key was saved earlier.
  # ach1.<base64url JSON {hub, key, cf_id?, cf_secret?}>: legacy, carries the key itself.
  mkdir -p "$AGENTCHANNEL_HOME"
  join_env="$(node -e '
    const fs = require("fs");
    const [line, keyFile, hubOverride] = process.argv.slice(1);
    const blob = line.trim().split(/\s+/).find((w) => /^ach[12]\./.test(w));
    if (!blob) { console.error("runner: ACH_JOIN has no ach2. (or ach1.) invite in it"); process.exit(1) }
    const o = JSON.parse(Buffer.from(blob.slice(5), "base64url").toString("utf8"));
    const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    const emit = (key) => {
      const out = ["JOIN_HUB=" + q(o.hub), "JOIN_KEY=" + q(key)];
      if (o.cf_id && o.cf_secret) out.push("JOIN_CF_ID=" + q(o.cf_id), "JOIN_CF_SECRET=" + q(o.cf_secret));
      console.log(out.join("\n"));
    };
    let saved = "";
    try { saved = fs.readFileSync(keyFile, "utf8").trim() } catch {}
    if (blob.startsWith("ach1.")) emit(o.key);
    else if (saved) emit(saved);
    else exchange();
    function exchange() {
    const base = (hubOverride || o.hub).replace(/\/+$/, "");
    const headers = { "Content-Type": "application/json" };
    if (o.cf_id && o.cf_secret) Object.assign(headers, { "CF-Access-Client-Id": o.cf_id, "CF-Access-Client-Secret": o.cf_secret });
    fetch(base + "/api/ach/invite/exchange", { method: "POST", headers, body: JSON.stringify({ join: o.join }) })
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok || !b.key) {
          console.error("runner: the hub refused the invite (" + r.status + " " + (b.code || "") + "): " + (b.error || "") +
            ". A one-time invite works once; mint a new one in the panel (agent -> invite) if it was used or expired.");
          process.exit(1);
        }
        fs.writeFileSync(keyFile, b.key + "\n", { mode: 0o600 });
        emit(b.key);
      })
      .catch((e) => { console.error("runner: cannot reach " + base + " to exchange the invite: " + e.message); process.exit(1) });
    }
  ' "$ACH_JOIN" "$AGENTCHANNEL_HOME/agent-key" "${ACH_HUB:-}")" || exit 1
  eval "$join_env"
  : "${ACH_KEY:=$JOIN_KEY}"
  : "${ACH_HUB:=$JOIN_HUB}"
  : "${ACH_PUBLIC_URL:=$JOIN_HUB}"
  : "${ACH_CF_ID:=${JOIN_CF_ID:-}}"
  : "${ACH_CF_SECRET:=${JOIN_CF_SECRET:-}}"
  export ACH_KEY ACH_HUB ACH_PUBLIC_URL ACH_CF_ID ACH_CF_SECRET
  unset ACH_JOIN
fi
cmd="${1:-run}"
[ $# -gt 0 ] && shift
if [ "$cmd" != "run" ]; then exec "$cmd" "$@"; fi

[ -n "${ACH_KEY:-}" ] || { echo "runner: set ACH_JOIN (the join line from the panel) or ACH_KEY + ACH_HUB" >&2; exit 1; }
[ -n "${ACH_HUB:-}" ] || { echo "runner: set ACH_HUB (e.g. http://hub:8090)" >&2; exit 1; }
mkdir -p /work/repos /work/tasks "$AGENTCHANNEL_HOME"

if [ -n "${ACH_GIT_SSH_KEY_FILE:-}" ]; then
  mkdir -p /work/.ssh && chmod 700 /work/.ssh
  cp "$ACH_GIT_SSH_KEY_FILE" /work/.ssh/deploy_key && chmod 600 /work/.ssh/deploy_key
  export GIT_SSH_COMMAND="ssh -i /work/.ssh/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/work/.ssh/known_hosts"
fi

set -- --dir /work/tasks --runtime "${ACH_RUNTIME:-claude}" --max "${ACH_MAX:-2}" --perm "${ACH_PERM:-workdir}"
[ -n "${ACH_MODEL:-}" ] && set -- "$@" --model "$ACH_MODEL"

for spec in ${ACH_REPOS:-}; do
  name="${spec%%=*}"; url="${spec#*=}"; branch=""
  case "$url" in *#*) branch="${url##*#}"; url="${url%#*}" ;; esac
  case "$name" in ''|*[!A-Za-z0-9._-]*) echo "runner: bad repo name in ACH_REPOS: $spec" >&2; exit 1 ;; esac
  dest="/work/repos/$name"
  if [ -d "$dest/.git" ]; then
    git -C "$dest" fetch --quiet --all --prune || echo "runner: fetch of $name failed (continuing with the local copy)" >&2
  else
    echo "runner: cloning $name"
    if [ -n "$branch" ]; then git clone --quiet --branch "$branch" "$url" "$dest"; else git clone --quiet "$url" "$dest"; fi
  fi
  set -- "$@" --repo "$name=$dest"
done

# Model credentials reach the spawned agent only when named (the runner drops
# every other env var: S4).
for n in ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY ${ACH_PASS_ENV:-}; do
  eval "v=\${$n:-}"
  # shellcheck disable=SC2154
  [ -n "$v" ] && set -- "$@" --pass-env "$n"
done

# Both Claude Code and Codex sandbox agent commands with bubblewrap, which needs
# unprivileged user namespaces. The runner never falls back to unsandboxed
# commands, so say it loudly when they are unavailable.
if [ "${ACH_PERM:-workdir}" != "full" ] && ! bwrap --ro-bind / / --unshare-user --unshare-net --dev /dev --proc /proc true >/dev/null 2>&1; then
  echo "runner: WARNING: the agent sandbox (bubblewrap) cannot start in this container: $(bwrap --ro-bind / / --unshare-user --unshare-net --dev /dev --proc /proc true 2>&1 | head -1)" >&2
  echo "runner: agents will not be able to run shell commands. See docs/deploy.md \"Server-side runner\" (sandbox)." >&2
fi
echo "agentchannel-runner: $(ach version), hub $ACH_HUB, runtime ${ACH_RUNTIME:-claude}, max ${ACH_MAX:-2}, perm ${ACH_PERM:-workdir}"
exec ach run "$@"
