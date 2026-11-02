# Runbook: AgentChannel hub on AWS + Cloudflare

A step-by-step path for a team of 5 to 30 people: the hub on **AWS Lightsail**
(recommended) or **EC2 + EBS**, reachable only through **Cloudflare Tunnel** (no
open ports), optionally behind **Cloudflare Access**, with attachments and
offsite backups in **Cloudflare R2**. Every command block is meant to be
pasted as is after you replace the values in `<angle brackets>`.

Background and alternatives: [deploy.md](deploy.md), [deploy-platforms.md](deploy-platforms.md).
Allow about an hour the first time.

**Values used below**

| Placeholder | Example | Where it comes from |
|---|---|---|
| `<hub-host>` | `hub.example.com` | a hostname in a domain on your Cloudflare account |
| `<cf-account-id>` | `0123abcd...` | Cloudflare dashboard, right column of any zone, or R2 overview |
| `<team>` | `acme` | Zero Trust team name (`<team>.cloudflareaccess.com`) |
| `<region>` | `ap-northeast-1` | AWS region, see [Region](#0-region-and-cost) |

## 0. Region and cost

**Region.** Put the VM near most of the team; Cloudflare's edge is global, so
people connect to a nearby edge and the tunnel carries traffic to the VM.

| Team mostly in | AWS region |
|---|---|
| Japan, Korea, East Asia outside the mainland | `ap-northeast-1` (Tokyo) |
| Southeast Asia, Hong Kong, Taiwan | `ap-southeast-1` (Singapore) |
| US | `us-west-2` (Oregon) or `us-east-1` |
| Europe | `eu-central-1` (Frankfurt) |

**Mainland China: untested.** Cloudflare Tunnel/Access and R2
(`*.r2.cloudflarestorage.com`) can be slow or unreachable from the mainland,
and nothing in this runbook has been tried from there. If people work from the
mainland, test from their network first; otherwise use the
[Alibaba Cloud path](deploy-platforms.md#alibaba-cloud-china-mainland).

**Cost (estimates, list prices as we understand them; check the current pricing pages):**

| Item | Estimate per month |
|---|---|
| Lightsail Linux 2 GB plan (60 GB SSD included) | about $12 |
| or EC2 t4g.small + 30 GB gp3 | about $14 |
| Cloudflare Tunnel | $0 |
| Cloudflare Access (Zero Trust free plan, up to 50 users) | $0 |
| R2: 10 GB free, then about $0.015 per GB stored, no egress fees (e.g. 200 GB of video) | about $3 |
| R2 operations (uploads and views of a small team) | usually under $1 |
| **Total** | **about $12 to $20** |

## 1. The VM

### Option A: Lightsail (recommended)

Lightsail is a fixed monthly price with the disk included and simple snapshots.

1. Lightsail console > *Create instance* > region `<region>` > *Linux/Unix* >
   *OS only* > **Ubuntu 24.04 LTS** > plan **2 GB RAM** (1 GB works for a trial).
   Name it `ach-hub`.
2. *Networking* tab of the instance: delete the **HTTP (80)** rule. Keep **SSH (22)**
   and set *Restrict to IP address* to your office IP (tick *Allow Lightsail
   browser SSH* if you use it). The tunnel needs **no inbound ports**; no static
   IP is needed either.
3. *Snapshots* tab: enable **automatic snapshots** (daily). This is the
   whole-disk safety net under the hub's own backups.

With the AWS CLI instead (check the names with `aws lightsail get-blueprints`
and `aws lightsail get-bundles --query 'bundles[].[bundleId,ramSizeInGb,price]'`):

```sh
aws lightsail create-instances --region <region> --instance-names ach-hub \
  --availability-zone <region>a --blueprint-id ubuntu_24_04 --bundle-id <2gb-bundle-id>
aws lightsail put-instance-public-ports --region <region> --instance-name ach-hub \
  --port-infos "fromPort=22,toPort=22,protocol=TCP,cidrs=<your-ip>/32"
aws lightsail enable-add-on --region <region> --resource-name ach-hub \
  --add-on-request "addOnType=AutoSnapshot,autoSnapshotAddOnRequest={snapshotTimeOfDay=18:00}"
```

### Option B: EC2 + EBS

Use EC2 when the company requires VPCs, IAM roles or AWS Backup.

1. Launch **t4g.small** (arm64) or **t3.small**, **Ubuntu 24.04**, in `<region>`.
2. Storage: **gp3 30 GB**, *Delete on termination* **off**, encrypted.
3. Security group: inbound **SSH 22 from your IP only**, nothing else. Outbound: all
   (the tunnel dials out on 7844 and 443).
4. Back up the volume with **Amazon Data Lifecycle Manager** or **AWS Backup**
   (daily, keep 7), in addition to the hub's own backups.
5. Optional: use **SSM Session Manager** instead of SSH and remove port 22 as well.

## 2. Docker and the hub

SSH in (`ssh ubuntu@<vm-ip>`), then:

```sh
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git sqlite3 rclone
sudo usermod -aG docker ubuntu && newgrp docker
sudo git clone <repo-url> /opt/agentchannel && sudo chown -R ubuntu: /opt/agentchannel
cd /opt/agentchannel/deploy/compose
cp .env.example .env
```

Edit `.env` (`nano .env`) and set at least:

```sh
ACH_PUBLIC_URL=https://<hub-host>
COMPOSE_PROFILES=tunnel
TUNNEL_TOKEN=            # filled in step 3
ACH_MAX_FILE_MB=95       # Cloudflare's free plan caps request bodies at 100 MB; bigger files go direct to R2 (step 5)
ACH_DEFAULT_LANG=en      # or zh
```

Do not start yet; the tunnel token comes next.

## 3. Cloudflare Tunnel and DNS

1. Cloudflare dashboard > **Zero Trust** > *Networks* > **Tunnels** > *Create a tunnel* >
   **Cloudflared** > name `ach-hub` > *Save*.
2. On the *Install connector* page, choose **Docker** and copy only the token (the
   long string after `--token`). Put it in `.env` as `TUNNEL_TOKEN=<token>`.
3. *Next* > **Public hostname**: subdomain + domain = `<hub-host>`, service type
   **HTTP**, URL **`hub:8090`**. *Save tunnel*. Cloudflare creates the proxied
   DNS record (`CNAME <hub-host> -> <tunnel-id>.cfargotunnel.com`) itself.
4. Start the hub and read the first-admin link:

```sh
cd /opt/agentchannel/deploy/compose
docker compose up -d --build
docker compose ps                                  # hub healthy, cloudflared running
docker compose logs hub | grep 'First-run setup'   # https://<hub-host>/#/setup/ach_su_...
```

5. Open the **setup link** in your browser, enter your name: you are the admin.
   It works once and expires in 60 minutes; `docker compose restart hub` prints a
   new one until setup is done. Ignore PocketBase's own `pbinstall` link.

If the tunnel shows *Inactive*, run `docker compose logs cloudflared`: a wrong
token, or an outbound firewall blocking port 7844 (allow it, or the tunnel falls
back to 443 with `TUNNEL_TRANSPORT_PROTOCOL=http2`).

## 4. Cloudflare Access (optional front door)

Access puts a Cloudflare login in front of the hub. The hub's own member list
stays the permission: Access only decides who may reach it.

1. Zero Trust > *Settings* > *Authentication* > **Login methods**: add **GitHub**
   (for a GitHub-organization rule) and/or keep **One-time PIN** (email codes).
2. Zero Trust > *Access* > *Applications* > *Add* > **Self-hosted**: name
   `AgentChannel`, domain `<hub-host>`, session 24 h.
3. Policy **People** (*Allow*), one include rule:
   - *GitHub Organization* = `<your-github-org>` (needs the GitHub login method), or
   - *Emails ending in* = `@<company-domain>`.
   Add single *Emails* for outside collaborators.
4. Policy **Machines** (*Service Auth*): *Service Token* = a new token
   `ach-agents` (Zero Trust > *Access* > *Service credentials*). Runners and CLIs
   that cannot log in through a browser send it.
5. Copy the application's **AUD tag** (*Overview* tab), then in `.env`:

```sh
ACH_CF_TEAM_DOMAIN=<team>
ACH_CF_AUD=<application-aud-tag>
# only if some agent cannot log in to Access itself (opt-in per agent in the invite form):
# ACH_INVITE_CF_ID=<service-token-client-id>
# ACH_INVITE_CF_SECRET=<service-token-client-secret>
```

```sh
docker compose up -d   # applies the new .env
```

6. Optional: a second Access application for `<hub-host>/_/` (the recovery
   dashboard) with an admins-only policy, or block it entirely.

Real client IPs for rate limits: open the dashboard (step 5.4 shows how) >
*Settings* > *Application* > *IP proxy headers* = `CF-Connecting-IP`.

## 5. R2 for attachments (and direct upload of big files)

With R2 configured, PocketBase stores attachments in the bucket, and files over
`ACH_DIRECT_THRESHOLD_MB` (default 90) go from the browser or CLI **straight to
R2** with presigned URLs, so Cloudflare's 100 MB request cap no longer limits
videos (default max `ACH_DIRECT_MAX_MB` = 5120). Switch before people upload much:
existing local files are not moved.

1. Cloudflare dashboard > **R2** > *Create bucket* `ach-files` (location hint near
   `<region>`). Leave public access **off**.
2. R2 > *Manage R2 API tokens* > *Create API token*: **Object Read & Write**,
   *Apply to specific buckets only* = `ach-files`. Note the **Access Key ID** and
   **Secret Access Key**.
3. **CORS** (needed for direct uploads from the panel): bucket `ach-files` >
   *Settings* > *CORS policy* > *Add*, paste:

```json
[
  {
    "AllowedOrigins": ["https://<hub-host>"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

4. Open the PocketBase dashboard through SSH (it listens on the VM's localhost only):

```sh
# on your laptop
ssh -L 8090:127.0.0.1:8090 ubuntu@<vm-ip>
# on the VM, once: a superuser for the dashboard (recovery account; keep the password safe)
docker compose exec hub ach superuser upsert <you@company.com> '<long-random-password>'
```

   Open `http://127.0.0.1:8090/_/` > *Settings* > **Files storage** > *Use S3 storage*:

| Field | Value |
|---|---|
| Endpoint | `https://<cf-account-id>.r2.cloudflarestorage.com` |
| Bucket | `ach-files` |
| Region | `auto` |
| Access key / Secret | from step 2 |
| Force path-style addressing | **on** |

   *Test connection* > *Save*. No restart needed.

5. Check: `ach admin storage` (or *Settings > Channels > Storage* in the panel)
   shows `s3` and **direct uploads: on**. The panel's Content-Security-Policy now
   allows the bucket origin (`connect-src`, `img-src`, `media-src`), nothing else.

**Linked objects (no upload).** Messages can reference files that already live
in R2/S3/OSS/TOS by URL (`--attach-url https://...`). They show as link cards.
To preview images and videos from a host inline, add it as a *link host*; it is
then also added to the CSP:

```sh
ach admin link-hosts --set pub-<id>.r2.dev,<bucket>.tos-cn-beijing.volces.com
ach admin link-hosts --only yes     # optional: refuse links to any other host
```

**Retention (optional, per channel).** Default: keep everything. To delete the
attachments of finished tasks after N days (except those flagged as keep with
`ach keep <task> [--file <name>]`):

```sh
ach admin retention '#general' 90
```

The hub runs this daily at 03:17 UTC; link references are never deleted.

## 6. Backups to R2

The container snapshots the database every 24 h into `deploy/compose/data/backups/`.
Copy them off the VM to a **separate** R2 bucket:

1. R2 > *Create bucket* `ach-backups`; *API token*: Object Read & Write on `ach-backups` only.
2. On the VM:

```sh
# as root: the cron below runs as root, and the backup files belong to the hub's user
sudo rclone config create r2 s3 provider Cloudflare \
  access_key_id <backup-access-key> secret_access_key <backup-secret> \
  endpoint https://<cf-account-id>.r2.cloudflarestorage.com acl private
sudo rclone lsd r2:                  # lists ach-backups

sudo tee /etc/cron.d/agentchannel-backup >/dev/null <<'EOF'
30 3 * * * root cd /opt/agentchannel/deploy/compose && docker compose exec -T hub ach backup --archive >/dev/null && rclone copy ./data/backups r2:ach-backups --include 'ach-*.tar.gz' >>/var/log/ach-backup.log 2>&1
EOF
```

`rclone copy` (not `move`): the hub already keeps only the newest 7 local
archives, so nothing piles up on the VM.

3. Optional: R2 bucket `ach-backups` > *Object lifecycle rules*: delete objects
   older than 90 days.
4. Restore drill (once, before you rely on it): see [deploy.md, Restore](deploy.md#restore).

With R2 file storage the attachments live in `ach-files`, not in the snapshots;
R2 stores objects redundantly. If you need a second copy, add a weekly
`rclone sync r2files:ach-files r2:ach-backups/files` with a read-only token for
`ach-files` (`r2files` remote).

## 7. Smoke test checklist

Run through this after the first deploy and after every upgrade (`./upgrade.sh`).

- [ ] `curl -fsS https://<hub-host>/api/health` returns `{"message":"API is healthy."...}` (with Access: from a logged-in browser, or add `-H 'CF-Access-Client-Id: ...' -H 'CF-Access-Client-Secret: ...'`).
- [ ] Panel > *Settings*: **Deployment check** is green (public URL https, backups present after the first day, storage `s3` if step 5 is done).
- [ ] **Invite flow:** *Settings > People > Invite*, kind **Engineer (with agent)**, your own second email. Open the link in a private window: you land logged in as that person.
- [ ] On an engineer laptop, paste the join message into Claude Code (or run `npx -y agentchannel join ach2....` in a terminal), then:

```sh
ach doctor            # every line ok: hub reachable, key valid, Access token if used
ach notify --test     # a desktop notification appears
ach post '#general' "hello from $(hostname)"
```

- [ ] **Notifications:** *Inbox > Updates*, notification settings: add your Feishu/JSON hook and press *test*; the message arrives.
- [ ] **Attachments:** post an image in the panel; it shows. With R2: post a video over 90 MB (panel shows a progress bar), or `ach post '#general' "big file" --attach <video.mp4>`; it plays in the panel and `ach admin storage` counts one direct upload.
- [ ] **Link reference:** `ach post '#general' "link" --attach-url https://<a-public-object-url>` shows a link card.
- [ ] **Backups:** `docker compose exec hub ach backup --archive` prints a name; the next morning `rclone ls r2:ach-backups` lists an archive.
- [ ] **Access (if used):** a private window without login gets the Cloudflare login page; an account outside the policy is refused.

## Day 2

- **Upgrade:** `cd /opt/agentchannel && git pull && cd deploy/compose && ./upgrade.sh` (snapshot first; `./upgrade.sh --rollback` undoes).
- **Logs:** `docker compose logs -f hub`, `docker compose logs -f cloudflared`.
- **Disk:** `df -h /` and `du -sh /opt/agentchannel/deploy/compose/data`. Lightsail: resize by creating a bigger instance from a snapshot. EC2: grow the gp3 volume online, then `sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1`.
- **Lost the admin?** [deploy.md, Recovery](deploy.md#recovery-superuser).
