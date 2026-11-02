# Runbook: GCP VM + Cloudflare Tunnel + Access

One small Compute Engine VM runs the hub (and optionally a server-side runner)
with Docker Compose. Cloudflare Tunnel publishes it, so the VM has **no open
inbound ports**, and Cloudflare Access decides who reaches it. About 30 minutes
the first time. You need a GCP project with billing, and a domain on Cloudflare.

## 1. Create the VM

- **Machine:** `e2-small` (2 vCPU shared, 2 GB) is enough for a team; `e2-medium`
  if you also run the server-side runner on it.
- **Image:** Ubuntu 24.04 LTS. **Disk:** 30 GB balanced persistent disk
  (sizing: [deploy.md](deploy.md#disk-sizing)).
- **Firewall:** do not tick "Allow HTTP/HTTPS traffic". Keep only SSH, and prefer
  SSH through IAP (`gcloud compute ssh --tunnel-through-iap`) so port 22 is not
  open to the internet either.
- **Startup:** leave empty; you install over SSH below (the cloud-init file in
  `deploy/cloud-init/` assumes open ports 80/443 with Caddy, which this runbook
  does not use).

## 2. Install the hub

```sh
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git sqlite3
sudo git clone https://github.com/AgentChannel/agentchannel.git /opt/agentchannel
cd /opt/agentchannel/deploy/compose
sudo cp .env.example .env && sudo chmod 600 .env
```

Edit `.env`:

```sh
ACH_PUBLIC_URL=https://hub.example.com   # the address people will open
COMPOSE_PROFILES=tunnel                  # hub + cloudflared, no Caddy
TUNNEL_TOKEN=                            # step 3
```

## 3. Cloudflare Tunnel

In Cloudflare **Zero Trust > Networks > Tunnels**, create a tunnel (type
*Cloudflared*), copy its token into `TUNNEL_TOKEN`, and add a public hostname:
`hub.example.com` → service `http://hub:8090`. Then:

```sh
sudo docker compose up -d
sudo docker compose logs hub | grep "First-run setup"
```

Open the printed setup link (it is valid for 60 minutes; a restart prints a new
one) and create the first admin.

## 4. Cloudflare Access (who may open the hub)

**Zero Trust > Access > Applications > Add > Self-hosted**, domain
`hub.example.com`. Policy: *Allow* your company email domain or a list of
emails (a GitHub organization works too). Then set in `.env` and restart:

```sh
ACH_CF_TEAM_DOMAIN=yourteam.cloudflareaccess.com
ACH_CF_AUD=<the application's AUD tag>
```

People still need an invite from the panel: Access is the front door, the
hub's own membership is the permission. A runner outside Access needs a
service token: tick the Cloudflare option when you create its invite.

Settings in Cloudflare for this hostname: SSL/TLS mode **Full** is not needed
(the tunnel is already encrypted); leave the defaults. Do not proxy an A record
to the VM's IP: with the tunnel there is no origin IP to reach.

## 5. Backups that leave the VM

The hub keeps 7 daily snapshots in `/data/backups` on the VM's own disk. Add
both of these:

1. **Disk snapshots:** Compute Engine > Snapshots > *Create snapshot schedule*
   (daily, keep 14 days) and attach it to the VM's disk.
2. **Offsite copies (optional, for a second provider):** install and configure
   rclone **as root** on the VM (`sudo rclone config`, e.g. a GCS or R2 remote)
   and add a root cron entry:

   ```sh
   17 3 * * * rclone copy /opt/agentchannel/deploy/compose/data/backups gcs:my-bucket/ach-backups --include 'ach-*Z/**' >> /var/log/ach-offsite.log 2>&1
   ```

   `rclone copy` (not `move`) leaves local retention to the hub. The Deployment
   check in the panel shows the age of the newest local snapshot.

## 6. Server-side runner (optional)

To run one team agent on this VM (24/7), create the agent in the panel, copy its
join line into `deploy/compose/secrets/ach_join` (`chmod 600`), set
`ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) and `ACH_RUNNER_REPOS` in `.env`, and
add `runner` to `COMPOSE_PROFILES` (`tunnel,runner`). Details and the agent
sandbox requirements: [deploy.md](deploy.md#server-side-runner).

Ubuntu 24.04 restricts unprivileged user namespaces, which the agent sandbox
(bubblewrap) needs. The runner prints a warning when the sandbox cannot start;
agents then cannot run shell commands. Read the sandbox section in deploy.md
before loosening container isolation.

## 7. Upgrades

```sh
cd /opt/agentchannel/deploy/compose
sudo git pull && sudo ./upgrade.sh
```

`upgrade.sh` snapshots the data first and rolls back by itself if the new hub
does not become healthy.
