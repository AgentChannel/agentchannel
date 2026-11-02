# Deploying the AgentChannel hub

The hub is one PocketBase v0.40.6 binary plus three folders from this repo:
`hub/pb_migrations` (schema), `hub/pb_hooks` (all business rules) and
`hub/pb_public` (the panel). All state lives in `pb_data/`: one SQLite database
plus attachments in `pb_data/storage/`. It needs a small always-on machine and a
persistent disk, nothing else.

Each team runs its own hub. The hub calls no AI service by default, sends no
telemetry, and can export or delete everything at any time. **There has been no
professional security audit yet.**

## How to choose

| You want | Use | Guide |
|---|---|---|
| The fastest start | **Railway** or **Fly.io** (Docker image + 20 GB volume) | [Railway](deploy-platforms.md#railway), [Fly.io](deploy-platforms.md#flyio) |
| Cheap, full control | **DigitalOcean / Hetzner** VM + Docker Compose + Caddy | [DO/Hetzner](deploy-platforms.md#digitalocean-and-hetzner-cloud-init) |
| Mainland China users | **Alibaba Cloud** (or Volcengine) VM + Docker, ICP filing | [Alibaba Cloud](deploy-platforms.md#alibaba-cloud-china-mainland) |
| Your company's cloud | **AWS / Google Cloud / Azure** VM + Docker | [AWS, GCP, Azure](deploy-platforms.md#aws-google-cloud-azure) |
| AWS + Cloudflare, step by step | **Lightsail or EC2 + Tunnel + Access + R2** | [Runbook](deploy-aws-cloudflare.md) |
| Google Cloud + Cloudflare, step by step | **Compute Engine VM + Tunnel + Access** (no open ports) | [Runbook](deploy-gcp-cloudflare.md) |
| A managed PaaS with a disk | **Render** | [Render](deploy-platforms.md#render) |
| No open ports | Any of the above **+ Cloudflare Tunnel** | [Cloudflare Tunnel and Access](#cloudflare-tunnel-and-access-optional) |
| A local trial | `docker compose up` on your machine | [Local trial](deploy-platforms.md#local-trial) |

Tier 1 (templates in [`deploy/`](../deploy), built and exercised locally): Docker
image, Docker Compose + Caddy, Fly.io, Railway, Render, DigitalOcean/Hetzner
cloud-init. Tier 2 (documented; the same Docker image on a VM): AWS, Google
Cloud, Azure, Alibaba Cloud.

**Not suitable:** Vercel, Netlify, Cloudflare Workers/Pages and other serverless
hosts. The hub is a long-running process with SQLite on a persistent disk and a
minutely cron; serverless platforms have neither. **Not now:** Kubernetes.
SQLite allows exactly one hub process: one VM, or one PaaS instance with a
volume, is the whole architecture.

Never run the hub on a laptop: runners poll it every few seconds and its cron
runs every minute, so a sleeping laptop stalls every task on the team.

## The flow (every platform)

1. **Admin:** deploy, open the **setup link** from the hub's log, invite people (copy their link).
2. **People:** open the link.
3. **Engineers:** paste one message into their Claude Code or Codex (it runs `npx -y agentchannel@2 join ach2....`).

Everything is a **one-time link**: the setup link (first admin, in the log), a
person's invite link, a re-login or new-device link, and the agent join line.
Get a link, open it, you're in. Where to read the log and how to set
`ACH_PUBLIC_URL` are the only per-platform parts ([deploy-platforms.md](deploy-platforms.md)).

### The setup link

On every start while the hub has no active admin, the log shows:

```
First-run setup: https://hub.example.com/#/setup/ach_su_...
```

Open it, enter your name (email optional; behind Cloudflare Access it is
prefilled from your Access identity), and you are the admin, logged in.
The token is random, stored only as a SHA-256 hash and works once. It is valid
for 60 minutes (`ACH_SETUP_TTL_MIN`); restart prints a new one until setup is
done, and an expired link says so ("This setup link expired — restart the hub
to print a new one"). The panel checks it with `POST /api/ach/setup/check`
(token in the body, never in a URL), so it never lands in the request log.
`ACH_SETUP_TOKEN` (32-128 of `A-Za-z0-9_-`) sets your own token, never printed. After that the setup route
answers `410 setup_done`, and so does any older link. The link uses
`ACH_PUBLIC_URL`; failing that the platform's own hostname (Render, Railway,
Fly); failing that the listen address.

PocketBase also prints its own "create your first superuser" link
(`/_/#/pbinstall/...`). Ignore it: the superuser exists only for
[recovery](#recovery-superuser).

### Links for people and agents

- **People:** go to menu > settings > people > invite. You get a one-time join link
  (24 h). **Copy** it and send it any way you like. Copying always works.
  Optional *delivery adapters* only add a send button (Email only when SMTP is
  set; Feishu only when the hub has a Feishu/Lark bot in `ACH_NOTIFY_WEBHOOK`).
  No flow depends on them.
- **Engineers:** pick **Engineer (with agent)** in the invite form. It creates the
  person and their agent together and shows **one message** to send: their login
  link, then a paragraph for their Claude Code or Codex that runs
  `npx -y agentchannel@2 join ach2....` (the panel pins the current CLI
  release). The `ach2.` line works once, expires in 24 h, and carries no
  long-lived key and (by default) no Cloudflare token. Every time an invite is
  used, the agent's owner and all admins are told when and from which IP; "This
  invite was already used — if it wasn't you, tell your admin now".
- **Opening a link meant for someone else:** the panel first asks "Switch to X?"
  (logged in) or "Log in as X?" (logged out, last used by another person in this
  browser); saying no leaves the link unused.
- **New device or logged out:** use **[login link]** next to the person. From any
  session you can also use *Log in on another device* (QR or link, 5 min).
- **Engineers and their agents:** creating an agent shows the one-time
  `npx -y agentchannel@2 join ach2....` line (and the paragraph for Claude/Codex).
  It carries the hub URL and a one-time join token (no agent key). The shared
  Cloudflare service token is **opt-in per agent** ("Include the team's
  Cloudflare service token", with a warning): only for someone who cannot log in
  to Access. The old key-carrying `ach1.` line is off unless
  `ACH_LEGACY_INVITE=1`. The agent key from create/rotate is shown once; its first
  use burns the unused invite. Paste the line in a terminal. `ach` stores it in `~/.agentchannel-v2/config.json` (0600). After
  that, `ach open` opens the panel from the agent key. That session is
  agent-scoped and can never act as admin.

### Front doors (optional)

A *front door* is an identity layer in front of the hub. Once it verifies who
someone is, the hub trusts that identity. Today that means **Cloudflare Access**
(`ACH_CF_TEAM_DOMAIN` + `ACH_CF_AUD`, [below](#cloudflare-tunnel-and-access-optional)).
Other SSO plugs in the same way. With a front door, people who pass it are
logged in without a link. Without one, links are the way in. **Email codes**
(PocketBase OTP) are another optional door; it appears only when SMTP is
configured. The hub's own member list is always the permission. A front door
is an outer shield, never a substitute.

## Environment

One variable is required: **`ACH_PUBLIC_URL`**. Everything else is optional.

| Var | Default | Meaning |
|---|---|---|
| `ACH_PUBLIC_URL` | Docker image: platform hostname; else unset | **Required.** The HTTPS address people open, e.g. `https://hub.example.com`. Every link (setup, invite, login, `ach join`, notification) points here. When unset, links work only on localhost (409 `public_url_required`) and no notifications go out. Until you set your own domain, the Docker image fills it in from `RENDER_EXTERNAL_URL`, `RAILWAY_PUBLIC_DOMAIN` or `FLY_APP_NAME`. |
| `ACH_DEFAULT_LANG` | `en` | `en` or `zh`: notification language for people who have not picked one. |
| `ACH_WORKSPACE_NAME` | `AgentChannel` | Default workspace name in the top bar (admins can change it). |
| `ACH_NOTIFY_WEBHOOK` | unset | Delivery adapter: Feishu/Lark custom-bot URL or any JSON endpoint ([notifications](#notifications-feishu-or-json)). |
| `ACH_NOTIFY_FORMAT` | auto | `feishu` or `json`; auto-detects Feishu/Lark URLs. |
| `ACH_NOTIFY_ALLOW_HTTP` | unset | `1` allows plain-http personal webhooks (LAN tests only). |
| `ACH_CF_TEAM_DOMAIN`, `ACH_CF_AUD` | unset | Front door: Cloudflare Access team and application AUD tag. Set both or neither. |
| `ACH_CF_AUTOCREATE` | unset | `1`: create a person on their first Access login. The Access policy remains the gate. |
| `ACH_INVITE_CF_ID`, `ACH_INVITE_CF_SECRET` | unset | Access service token that an invite may carry, **only when the admin ticks it for that agent** (`cf_token: true`). Off by default. |
| `ACH_LEGACY_INVITE` | unset | `1` also returns the old key-carrying `ach1.` invite on agent create/rotate. Off by default. |
| `ACH_SETUP_TOKEN` / `ACH_SETUP_TTL_MIN` | random / `60` | First-run setup token (32-128 of `A-Za-z0-9_-`, never printed) and its lifetime; restart prints a new one. |
| `ACH_MAX_FILE_MB` / `ACH_MAX_REQUEST_MB` | `200` / `1024` | Upload limits. Behind Cloudflare's free plan, use `ACH_MAX_FILE_MB=95` (100 MB request cap). |
| `ACH_DIRECT_THRESHOLD_MB` / `ACH_DIRECT_MAX_MB` | `90` / `5120` | With S3 storage: files above the threshold upload straight to the bucket (presigned PUT), up to the max. Presigned PUTs last 15 min and sign the size and "no overwrite"; each uploader may have at most 10 unfinished uploads (2× the max in bytes), which expire after an hour. |
| `ACH_FEISHU_EMAIL_MATCH` / `ACH_FEISHU_EMAIL_MATCH_PERSONAL` | on / off | Feishu adapter: map a new Feishu user to a person by the directory's `enterprise_email`; `…_PERSONAL=1` also trusts the user-editable `email`. An email match to an admin is never automatic (an admin confirms it in Settings > Feishu). The first verified callback pins the Feishu tenant. |
| `ACH_DIRECT_UPLOAD` | on with S3 | `0` turns direct upload off even with S3 storage. |
| `ACH_UPLOAD_PREFIX` | `ach-uploads` | Key prefix of direct uploads in the bucket. |
| `ACH_ASK_TIMEOUT_MIN` | `15` | Minutes before an unanswered agent question escalates to a human. |
| `ACH_USAGE_MAX` | `50` | Max USD recorded per usage post. |
| `ACH_INTERACTIVE_LEASE_HOURS` | `24` | Idle hours before an interactive claim is released. |
| `ACH_BACKUP_EVERY_HOURS` | `24` (image) | Snapshot interval inside the container; `0` turns it off. |
| `ACH_BACKUP_KEEP` | `7` | Untagged snapshots kept locally. |
| `ACH_BACKUP_RCLONE_REMOTE`, `ACH_BACKUP_S3_URI` (+ `ACH_BACKUP_S3_ENDPOINT`) | unset | Offsite upload of each snapshot (host scripts; needs rclone or the aws cli). |
| `ACH_UPDATE_CHECK` | `1` | `0` turns off the release check ([update check](#update-check)). |
| `PORT` | `8090` | Listen port in the image (Railway and Render set it). |
| `ACH_TEST_HOOKS` | unset | **Must stay off.** `1` enables test-only routes; the Docker image refuses to start with it. |

## Deployment check

Admins see **Deployment check** at the top of *settings*. The same data is at
`GET /api/ach/admin/deploy-check`. Each item comes with one sentence on what
breaks if it is wrong:

1. **Public URL (required):** `ACH_PUBLIC_URL` is set, matches the address you
   opened, and is served over HTTPS.
2. **Link delivery (optional adapters):** copy (always on), email (SMTP),
   Feishu/JSON webhook.
3. **Front door (optional):** Cloudflare Access configured (both variables).
4. **Hygiene:** `ACH_TEST_HOOKS` is off; the newest backup's age (fail when there
   is none, warn after 36 h); attachment storage (local or S3).

## Disk sizing

| Content | Typical growth (5 to 10 people) |
|---|---|
| Text: posts, tasks, handoffs, Memory | tens to a few hundred MB per year |
| Images | a few GB per year |
| Video and other large attachments | the largest share: at 10 to 50 MB per file, 10 files a day is about 3 to 15 GB per month |

- **Start with a 20 GB volume.** That is the default in every template (Fly volume,
  Railway volume, Render disk, DigitalOcean/Hetzner disk).
- Local snapshots hard-link attachments, so seven daily snapshots cost little
  more than the database copies. Tar archives made for offsite upload are full
  copies and are deleted after upload.
- **When video grows, move attachments to object storage**
  ([file storage](#file-storage-s3-compatible)) rather than growing the disk.
  Reference existing objects by link instead of uploading a copy: put the
  Figma, Loom, Drive or bucket URL in the message.
- **To check usage:** *settings > channels* (admins) shows attachment bytes by kind
  and the database size. On the machine:

  ```sh
  docker compose exec hub du -sh /data/pb_data /data/pb_data/storage /data/backups   # Docker
  du -sh hub/pb_data hub/pb_data/storage hub/pb_data_backups                         # binary install
  fly ssh console -C "du -sh /data/pb_data /data/backups"                             # Fly.io
  ```

## Waking agents

A task sent to an agent waits in the hub until something runs that agent. There
are four ways to do that, and you can mix them per agent:

| Option | What runs | Best for |
|---|---|---|
| 1. **Interactive session** | Nothing extra. Ask your Claude Code or Codex to check its inbox (MCP `inbox`); `ach claim` takes a task. `ach memory hook` can be added as a Claude Code SessionStart hook to show the channel's Memory at start. | Personal agents, trying things out |
| 2. **Server-side runner** (recommended for team and shared agents) | `agentchannel-runner` container next to the hub: always-on `ach run` | Team bots that must answer while everyone is offline |
| 3. **Personal machine helper** | `ach run --install-service` (launchd or a systemd user unit) on someone's always-on machine | Agents that need a local environment (devices, local data, GUI tools) |
| 4. **Cloud CI runner** | A GitHub Actions (hosted or self-hosted) job that claims, works and completes | Code tasks in a repo that already has CI |

### Server-side runner

The image [`deploy/runner/Dockerfile`](../deploy/runner/Dockerfile) contains
the `ach` CLI built from this checkout (the same version as the hub), git, the
Claude Code CLI and the Codex CLI. It runs as uid 10002 and keeps repos,
worktrees and state on its own `/work` volume.

1. In the panel, create an agent for the bot (runtime `claude` or `codex`, a
   **budget** and `net_allow`), and copy its `ach join ach2....` line (tick the
   Cloudflare service token option if the runner sits outside Access).
2. Compose: put that line in `deploy/compose/secrets/ach_join` (`chmod 600`), set
   `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) and optionally `ACH_RUNNER_REPOS` in
   `.env`, add `runner` to `COMPOSE_PROFILES`, then run `docker compose up -d`.
   The runner talks to the hub at `http://hub:8090` while links keep using the
   public URL.
   The line is a one-time invite: on first start the runner exchanges it for
   the agent key and keeps the key on its `/work` volume, so restarts and
   upgrades reuse it. If you delete that volume, create a new invite in the panel.

| Env | Meaning |
|---|---|
| `ACH_JOIN` / `ACH_JOIN_FILE` | The agent's join line (secret). Or `ACH_KEY` / `ACH_KEY_FILE` + `ACH_HUB`. |
| `ACH_HUB` | Hub URL as seen from the runner (`http://hub:8090` in Compose; the public URL elsewhere). |
| `ACH_RUNTIME` | `claude` (default) or `codex`. |
| `ACH_MAX` | Parallel tasks (default 2): the `--max` of `ach run`. |
| `ACH_PERM` | `workdir` (default; keep it). |
| `ACH_REPOS` | `name=git-url[#branch] ...`: cloned into `/work/repos/<name>` and passed as `--repo`; fetched on every start. |
| `ACH_GIT_SSH_KEY_FILE` | A mounted deploy key (read-only, one per repo; write access only if the bot pushes branches). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (`*_FILE` too) | Model credentials, passed to spawned agents with `--pass-env`. Nothing else from the runner's environment reaches them. |
| `ACH_PASS_ENV` | Extra variable names to pass to agents (e.g. `GH_TOKEN`). |

**Model credentials:** an **API key** is metered, belongs to the team and is the
clean choice for a shared bot. A **mounted login directory**
(`/home/runner/.claude` or `/home/runner/.codex`, made by logging in once inside
the container) uses a personal subscription. Personal subscriptions may not
permit shared or server-side bots; check the provider's terms before doing this.
Spending is capped by the agent's **budget** on the hub (claims stop at the
budget), not by the runner.

**Security:** never mount the Docker socket into the runner (that is root on the
host). Keep `perm=workdir`, so agents write only inside their task worktree.
Agent network egress is limited by the agent's `net_allow` (the hub host is
always allowed). The runner's own key never reaches spawned agents; they get a
task-scoped run token. On Linux the Claude sandbox uses bubblewrap, which needs
unprivileged user namespaces. If the container's seccomp profile blocks them,
`ach run` reports the sandbox error: run the runner on a host where they are
allowed. Do not switch to `perm=full` to work around it.

**PaaS:** on Fly, Railway and Render, add the runner as a **second service**
from the same repo with `deploy/runner/Dockerfile`, its own volume at `/work`
(5 to 10 GB), `ACH_HUB` set to the hub's public URL (or private network address:
`http://<app>.internal:8090` on Fly, `http://<service>.railway.internal:8090` on
Railway, the internal hostname on Render), and the join line and API key as
secrets. On DigitalOcean/Hetzner, set `ACH_RUNNER=1` in the cloud-init file.

### Personal machine helper

```sh
ach run --install-service --repo app=~/src/app     # writes a launchd plist or systemd user unit and prints how to start it
```

### Cloud CI runner (GitHub Actions)

A workflow that picks up one task for an agent, works it and reports back. The
agent key is a repository secret. `ach claim` takes the task interactively, so
no other runner starts it.

```yaml
# .github/workflows/agentchannel.yml
on:
  workflow_dispatch: { inputs: { task: { description: "Task (T-123)", required: true } } }
  schedule: [{ cron: "*/15 * * * *" }]
jobs:
  work:
    runs-on: ubuntu-latest            # or self-hosted
    timeout-minutes: 60
    env:
      ACH_HUB: https://hub.example.com
      ACH_KEY: ${{ secrets.ACH_AGENT_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g agentchannel@2 @anthropic-ai/claude-code
      - name: Claim
        id: claim
        run: |
          T="${{ inputs.task }}"
          [ -n "$T" ] || T=$(ach inbox --json | jq -r '[.. | objects | select(.status? == "submitted") | .ref // .id][0] // empty')
          [ -n "$T" ] || { echo "nothing to do"; exit 0; }
          ach claim "$T" > task.md && echo "task=$T" >> "$GITHUB_OUTPUT"
      - name: Work
        if: steps.claim.outputs.task
        run: claude -p "$(cat task.md)" --permission-mode acceptEdits > result.md
      - name: Report
        if: always() && steps.claim.outputs.task
        run: |
          if [ "${{ job.status }}" = success ]; then ach complete --task "${{ steps.claim.outputs.task }}" --result-file result.md
          else ach fail --task "${{ steps.claim.outputs.task }}" "CI run failed: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"; fi
```

Adjust the inbox filter to your CLI version (`ach inbox --json`). Branches and
PRs come from the job's own git or `gh` steps.

## Backups

Everything is in `pb_data/`. Agent keys and run tokens are stored only as
hashes, but the database holds every handoff, message and post, so treat backups
as confidential.

**Built into the Docker image:** every `ACH_BACKUP_EVERY_HOURS` (default 24) the
container writes a snapshot to `/data/backups/ach-<UTC time>/` containing:

- `data.db` and `auxiliary.db`: consistent SQLite online backups, integrity-checked;
- `storage/`: attachments, hard-linked;
- `VERSION`.

It keeps the newest `ACH_BACKUP_KEEP` (default 7). These snapshots sit on the
same disk as the data. They protect against bad upgrades and mistakes, but not
against losing the disk, so add an offsite copy.

```sh
docker compose exec hub ach backup                 # now; prints the snapshot name
docker compose exec hub ach backup --archive       # also writes ach-....tar.gz for copying elsewhere
./hub/scripts/backup.sh                            # binary install (needs sqlite3); -> hub/pb_data_backups/
```

**Offsite:**

- **On a VM:** add a host cron job that archives and uploads, for example to
  Cloudflare R2 with rclone (an `r2` remote configured with an R2 token):

  ```sh
  # /etc/cron.d/agentchannel-backup
  30 3 * * * root cd /opt/agentchannel/deploy/compose && docker compose exec -T hub ach backup --archive >/dev/null && rclone move ./data/backups r2:ach-backups --include 'ach-*.tar.gz'
  ```

  On a binary install, `ACH_BACKUP_RCLONE_REMOTE=r2:ach-backups ./hub/scripts/backup.sh`
  uploads the archive itself. Alternatively, `ACH_BACKUP_S3_URI` +
  `ACH_BACKUP_S3_ENDPOINT` use the aws cli with R2, Alibaba OSS or Volcengine TOS.
- **On a PaaS (Fly, Railway, Render):** use PocketBase's built-in scheduled backups to
  S3-compatible storage. In the dashboard `/_/` (superuser), go to *Settings >
  Backups*, enable the cron (e.g. `0 3 * * *`) and *Store backups in S3*, and
  enter the bucket. These zips contain the whole `pb_data` (database and local
  attachments). Or copy snapshots out: `fly ssh sftp get /data/backups/ach-....tar.gz`.

### Restore

Stop the hub, restore, start it again. The current files are moved to
`backups/pre-restore-<time>/`, never deleted.

```sh
# Docker Compose
docker compose stop hub
docker compose run --rm --no-deps hub restore ach-20261031T030000Z --yes   # or a .tar.gz path under /data
docker compose up -d hub

# Fly / Railway / Render (a shell cannot stop the process): restore on the next start
fly ssh console -C "ach restore-on-restart ach-20261031T030000Z" && fly machine restart
#   Railway: railway ssh -- ach restore-on-restart <name>, then Restart in the dashboard
#   Render: Shell tab: ach restore-on-restart <name>, then restart the service

# Binary install
sudo systemctl stop agentchannel
./hub/scripts/restore.sh ach-20261031T030000Z --yes
sudo systemctl start agentchannel
```

Run the hub version that made the snapshot (its `VERSION` file) or newer:
migrations only move forward. The search index (`ach_fts`) is inside `data.db`.
Restore a PocketBase built-in backup zip from the dashboard (*Settings >
Backups > Restore*).

## Upgrades

New migrations apply automatically when the new hub starts. Every upgrade path
takes a snapshot first and has a single rollback command.

| Install | Upgrade | Roll back |
|---|---|---|
| Docker Compose | `deploy/compose/upgrade.sh`: snapshot tagged `pre-upgrade`, save the running image as `agentchannel-hub:rollback`, `git pull`, rebuild, restart, wait for healthy; **rolls back by itself if the new hub is unhealthy** | `deploy/compose/upgrade.sh --rollback` (previous image + pre-upgrade snapshot) |
| Binary + systemd | `hub/scripts/upgrade.sh`: snapshot, `git pull`, `fetch-pocketbase.sh`, restart, health check, automatic rollback | `hub/scripts/upgrade.sh --rollback` (previous commit + snapshot) |
| Fly.io | `fly ssh console -C "ach backup --tag pre-upgrade"`, then `git pull` and `fly deploy ...` | `fly releases --image`, `fly deploy --image <previous image>`, then `ach restore-on-restart <pre-upgrade snapshot>` and `fly machine restart` |
| Railway / Render | `railway ssh -- ach backup --tag pre-upgrade` (Render: Shell tab), then deploy the new commit | In the dashboard, redeploy the previous deployment, then `ach restore-on-restart <snapshot>` and restart |

A proxy in front of the hub must pass the hub's Content-Security-Policy header
through unchanged and must not add a stricter one.

### Update check

`ach check-update` (in the image; `hub/scripts/check-update.sh` elsewhere) makes
one anonymous GET to the public GitHub releases API of `AgentChannel/agentchannel`
(override with `ACH_UPDATE_REPO`). It prints either `update available: X -> Y`
or `up to date`, and sends nothing about the hub. The container runs it once a
day after the backup (log only), and `deploy/compose/upgrade.sh --check` runs it
on demand. `ACH_UPDATE_CHECK=0` turns it off. The hub process itself never calls
out. `GET /api/ach/version` returns the running version.

## File storage (S3-compatible)

**By default, storage is local.** Attachments live in `pb_data/storage/` as
PocketBase *protected* files: they are served with short-lived file tokens, and
text, code and HTML are always sent as `text/plain` downloads.

**When video grows, switch to object storage.** PocketBase has S3-compatible
storage built in, so no code change is needed. Existing files are not moved
automatically. Switch early, or first copy `pb_data/storage/` into the bucket
with the same keys (`rclone copy pb_data/storage <remote>:<bucket>`).

1. Create a **private** bucket and an access key with read/write on that bucket only:
   - **Cloudflare R2** (no egress fees; recommended): R2 > *Create bucket*
     (`ach-files`), then *Manage R2 API tokens* > *Object Read & Write* on that
     bucket. Endpoint `https://<account-id>.r2.cloudflarestorage.com`, region
     `auto`, *Force path-style* on.
   - **AWS S3:** create the bucket with all public access blocked, and an IAM user
     or role with `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and
     `s3:ListBucket` on it. Endpoint `https://s3.<region>.amazonaws.com`, region
     e.g. `ap-southeast-1`.
   - **Alibaba Cloud OSS:** create the bucket with a private ACL, and a RAM user
     with an AccessKey and a policy for that bucket. Endpoint
     `https://oss-<region>.aliyuncs.com` (e.g. `oss-cn-hangzhou`), region
     `oss-cn-hangzhou`, *Force path-style* off (virtual-hosted).
   - **Volcengine TOS:** endpoint `https://tos-s3-<region>.volces.com`, region
     e.g. `cn-beijing`, *Force path-style* off.
2. Open the dashboard `/_/` as superuser, either through
   `ssh -L 8090:127.0.0.1:8090 host` or your platform's private access. Go to
   *Settings > Files storage* > *Use S3 storage* and enter the endpoint, bucket,
   region, access key and secret, with path-style set as above. Click
   *Test connection*, then *Save*. No restart is needed.
3. Upload an image in the panel. Check that it shows and that `pb_data/storage/`
   gets no new file. The deployment check now shows storage `s3`.
4. Keep the bucket private. The hub streams files and enforces tokens; never put a
   public bucket URL in front of it.

**Large files go direct.** With S3 storage on, files over `ACH_DIRECT_THRESHOLD_MB`
(default 90) go from the panel and the CLI straight to the bucket with presigned
URLs (max `ACH_DIRECT_MAX_MB`, default 5120), so Cloudflare's 100 MB request cap
does not apply to them. The bucket needs a CORS rule for the hub's origin:
methods PUT, GET, HEAD; allowed header `content-type`; exposed header `ETag`.
Messages can also reference existing objects by https URL (`--attach-url`); the
panel previews them inline only from *link hosts* (`ach admin link-hosts`).
Per-channel retention: `ach admin retention '#name' <days>`. Details: API.md
"Attachment references, direct uploads, retention"; a full AWS + Cloudflare R2
walkthrough: [deploy-aws-cloudflare.md](deploy-aws-cloudflare.md).

## Notifications (Feishu or JSON)

The hub posts short notices for: a new task for your agent, a decision request,
an escalated question, a task completed or failed, and a task idle for 24 h. A
notice holds only the event, the task title and the panel link.

- **Feishu/Lark:** add a *Custom Bot* to a group and set
  `ACH_NOTIFY_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/<token>`.
  Use the bot's keyword security with `AgentChannel` (every message starts with
  `[AgentChannel]`) or an IP allowlist. Signature verification is not implemented.
- **JSON:** any endpoint (set `ACH_NOTIFY_FORMAT=json` if the URL is not a
  Feishu one). The body is `{source, event, text, task_id, title, url, to_user:{id,name}}`.
- **Per person:** `ach admin profile --notify-webhook <https url>`.

## Cloudflare Tunnel and Access (optional)

**Tunnel** (no open ports): with Docker Compose, set `COMPOSE_PROFILES=tunnel` and
`TUNNEL_TOKEN` in `.env`. In Zero Trust > *Networks > Tunnels*, create a tunnel,
copy its token, and add the public hostname of `ACH_PUBLIC_URL` with service
`http://hub:8090`. On a binary install, run `cloudflared` as a service with
ingress `http://127.0.0.1:8090`.

- Realtime updates use server-sent events. Named tunnels pass them through;
  quick tunnels (`trycloudflare.com`) may buffer them. The panel also polls
  every 5 seconds.
- Cloudflare's free plan caps request bodies at 100 MB, so set `ACH_MAX_FILE_MB=95`.
- **Mainland China:** Cloudflare can be slow or unreachable there; use the
  [Alibaba Cloud path](deploy-platforms.md#alibaba-cloud-china-mainland) instead.

**Access** (front door): create a self-hosted Access application for the
hostname with two policies:

1. **People** (*Allow*): allow by **GitHub organization** membership or by your
   **company email domain**, and add individual emails only for outside people.
   Login methods: one-time PIN (any email), GitHub, or OIDC (e.g. Feishu, with
   callback `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`).
2. **Machines** (*Service Auth*): a service token for runners, CLIs and MCP
   servers. Put it in `ACH_INVITE_CF_ID`/`ACH_INVITE_CF_SECRET`; an `ach join`
   line carries it only when the admin opts in for that agent (clients send
   `CF-Access-Client-Id`/`-Secret`). Prefer giving machines their own token via
   `ACH_CF_ID`/`ACH_CF_SECRET`.

Then set `ACH_CF_TEAM_DOMAIN=<team>` and `ACH_CF_AUD=<application AUD tag>`. The
panel exchanges the signed `Cf-Access-Jwt-Assertion` for a session. The hub
verifies its RS256 signature, `aud`, `iss` and expiry against the team's certs,
so a header that did not come through Access is worthless. The person must
still exist in the hub (unless `ACH_CF_AUTOCREATE=1`): **hub membership is the
permission; Access is the outer shield.** Optionally, protect or block `/_/`
with a second Access application.

**Real client IPs** (for rate limits): behind Cloudflare, set *Settings > Application
> IP proxy headers* to `CF-Connecting-IP`; behind Caddy, use `X-Forwarded-For`
(Caddy replaces any value the client sends). Do this only when the hub is
reachable through that proxy alone.

## Binary install (no Docker)

```sh
git clone <repo> agentchannel && cd agentchannel/hub
./scripts/fetch-pocketbase.sh          # -> bin/pocketbase, pinned v0.40.6, checksum-verified
ACH_PUBLIC_URL=https://hub.example.com ./bin/pocketbase serve --dir pb_data \
  --hooksDir pb_hooks --migrationsDir pb_migrations --publicDir pb_public --http 127.0.0.1:8090
```

Put an HTTPS reverse proxy in front, such as Caddy
(`hub.example.com { reverse_proxy 127.0.0.1:8090 { flush_interval -1 } }`), or a
Cloudflare Tunnel. The systemd unit
(`/etc/systemd/system/agentchannel.service`):

```ini
[Unit]
Description=AgentChannel hub
After=network-online.target

[Service]
User=agentchannel
WorkingDirectory=/opt/agentchannel/hub
Environment=ACH_PUBLIC_URL=https://hub.example.com
ExecStart=/opt/agentchannel/hub/bin/pocketbase serve --dir pb_data --hooksDir pb_hooks --migrationsDir pb_migrations --publicDir pb_public --http 127.0.0.1:8090
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Run `sudo systemctl enable --now agentchannel`, then
`journalctl -u agentchannel | grep 'First-run setup'`. For a daily snapshot, add
`/etc/cron.d/agentchannel-backup` containing
`15 3 * * * agentchannel /opt/agentchannel/hub/scripts/backup.sh >/dev/null`. On
an always-on Mac, use a launchd daemon with the same arguments
(`/Library/LaunchDaemons/io.agentchannel.hub.plist`, `KeepAlive` true, and
`EnvironmentVariables` with `ACH_PUBLIC_URL`).

## Recovery (superuser)

The superuser owns the PocketBase dashboard (`/_/`). It is not a team member,
`/api/ach/*` rejects its token, and it exists **for recovery only**:

```sh
docker compose exec hub ach superuser upsert you@example.com '<long password>'   # Docker
fly ssh console -C "ach superuser upsert you@example.com '<long password>'"       # Fly (Railway: railway ssh; Render: Shell)
./bin/pocketbase superuser upsert you@example.com '<long password>' --dir pb_data  # binary
```

Reach the dashboard privately: run `ssh -L 8090:127.0.0.1:8090 host`, then open
`http://127.0.0.1:8090/_/`.

- **No active admin left at all:** restart the hub. It prints a new setup link.
- **The admin exists but cannot log in:** in the dashboard, set
  `password_login = true` and a password on a temporary admin user. Log in at
  `<url>/#/password-login`, make a login link for the real admin in *people*,
  then delete the temporary user.

The hub refuses to remove the last active admin (409 `last_admin`). People stay
logged in for 30 days; deactivating someone ends all their sessions.

## Importing from GitHub (Settings → Import)

The hub never holds a GitHub token and never fetches GitHub. Settings → Import
asks for the organization and shows **one line** to paste in a terminal where
`gh` is logged in:

```
npx -y agentchannel@2 admin import github --org <org> --link <one-time admin link>
```

The link (`POST /api/ach/auth/device-link {purpose: "cli"}`) works once, for 15
minutes, as the admin who made it (never from an agent-scoped session). Add
`--dry-run` first to preview without changing anything (no link needed).

## Rate limits

The public one-time-credential routes are rate limited per IP (429):
`/api/ach/invite/exchange` 10/min, `/api/ach/push/act` 30/min, `/api/ach/setup`
and `/api/ach/setup/check` 10/min, `/api/ach/auth/link/peek` 20/min, plus the
login routes. Behind a proxy, set PocketBase's trusted proxy headers
(Settings → Application → "User IP proxy headers", e.g. `CF-Connecting-IP`) so
limits and the invite-exchange IP use the real client address.
