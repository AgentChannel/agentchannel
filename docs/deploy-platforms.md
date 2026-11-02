# Hub deployment per platform

The flow is the same everywhere ([deploy.md](deploy.md#the-flow-every-platform)):
deploy, open the **setup link** from the log, invite people by copying their
links. This page covers only what differs between platforms: how to deploy,
where the log is, how to set `ACH_PUBLIC_URL`, and where the 20 GB of data
lives. All templates are in [`deploy/`](../deploy) and use the same Docker image
([`deploy/docker/Dockerfile`](../deploy/docker/Dockerfile)): multi-arch
(amd64/arm64), PocketBase pinned and checksum-verified, server running as a
non-root user, data on a `/data` volume, a health check on `/api/health`, and
daily snapshots in `/data/backups`.

| Platform | Deploy | Setup link in | `ACH_PUBLIC_URL` | Data |
|---|---|---|---|---|
| Local trial | `docker compose up -d` | `docker compose logs hub` | unset (localhost) | `deploy/compose/data` |
| DigitalOcean / Hetzner | cloud-init user data | `docker compose logs hub` on the VM | install.env | VM disk (or a block volume) |
| Fly.io | `fly deploy` | `fly logs` | defaults to `https://<app>.fly.dev`; `fly secrets set` | Fly volume `ach_data`, 20 GB |
| Railway | GitHub repo + `railway.json` | *Deployments > Logs* | defaults to the Railway domain; *Variables* | Railway volume at `/data`, 20 GB |
| Render | Blueprint `render.yaml` | *Logs* tab | defaults to `onrender.com`; *Environment* | Render disk, 20 GB |
| AWS / GCP / Azure / Alibaba | VM + Docker Compose | `docker compose logs hub` | `.env` | VM disk |

## Local trial

```sh
cd deploy/compose
docker compose up -d --build          # no .env needed: the hub only, on http://127.0.0.1:8090
docker compose logs hub | grep 'First-run setup'
```

Open the link. A trial on localhost cannot send links to other people (they
point at localhost); deploy for real when you want to invite anyone.

## Docker Compose on any VM

This is the base for DigitalOcean, Hetzner, AWS, GCP, Azure and Alibaba Cloud.

```sh
git clone <repo> /opt/agentchannel && cd /opt/agentchannel/deploy/compose
cp .env.example .env    # set ACH_PUBLIC_URL=https://hub.example.com; COMPOSE_PROFILES=https
docker compose up -d --build
docker compose logs hub | grep 'First-run setup'
```

- **HTTPS:** the `https` profile runs Caddy, which gets and renews the
  certificate for the host in `ACH_PUBLIC_URL`. Point the DNS A/AAAA record at
  the VM and open ports 80 and 443. Caddy passes server-sent events through
  unbuffered.
- **No open ports:** use `COMPOSE_PROFILES=tunnel` and set `TUNNEL_TOKEN` instead
  ([Cloudflare Tunnel](deploy.md#cloudflare-tunnel-and-access-optional)).
- **Data:** `deploy/compose/data/` (`pb_data/` and `backups/`). Move it with
  `ACH_DATA_PATH=/mnt/volume/agentchannel` to put it on a separate block volume.
- **Dashboard (recovery):** the hub also listens on `127.0.0.1:8090` on the VM.
  Run `ssh -L 8090:127.0.0.1:8090 vm`, then open `http://127.0.0.1:8090/_/`.
- **Backups, upgrades, rollback:** `docker compose exec hub ach backup`,
  `./upgrade.sh`, `./upgrade.sh --rollback` ([deploy.md](deploy.md#upgrades)).
- **Server-side runner:** add `runner` to `COMPOSE_PROFILES`
  ([waking agents](deploy.md#server-side-runner)).
- **Size:** 1 vCPU / 1 GB RAM / 20 GB disk is enough for a team of 10.

## DigitalOcean and Hetzner (cloud-init)

[`deploy/cloud-init/cloud-init.yaml`](../deploy/cloud-init/cloud-init.yaml)
works on Ubuntu 24.04. It installs Docker and Compose from Ubuntu's packages,
enables the ufw firewall (22, 80, 443), clones the repo, writes `.env` and
starts the hub with Caddy.

1. Point your domain's A record at the server (you can do this after creation;
   Caddy keeps retrying).
2. Create the server:
   - **DigitalOcean:** *Create > Droplets*, Ubuntu 24.04, Basic $6 (1 GB, 25 GB disk).
     Under *Advanced options > Add initialized data*, paste the file after editing
     `ACH_PUBLIC_URL` (and `ACH_REPO`/`ACH_REF`).
   - **Hetzner:** *Add server*, Ubuntu 24.04, CX22 (2 vCPU, 4 GB, 40 GB) or
     CAX11 (arm64). Paste the file into *Cloud config*.
3. About 3 minutes later, `ssh root@server`, then
   `cd /opt/agentchannel/deploy/compose && docker compose logs hub | grep 'First-run setup'`.
4. **Optional runner:** after setup, create the bot agent in the panel. Then on
   the VM, set `ACH_RUNNER=1` and the API key in `/etc/agentchannel/install.env`,
   save the join line in `/etc/agentchannel/ach_join`, and run
   `/usr/local/sbin/agentchannel-install` again.

If install.env still holds the example URL, the install stops with a message.
Edit the file and run `/usr/local/sbin/agentchannel-install`. For more disk
later, attach a volume (DigitalOcean Volumes, Hetzner Volumes), then move
`deploy/compose/data` onto it and set `ACH_DATA_PATH`.

## Fly.io

[`deploy/fly/fly.toml`](../deploy/fly/fly.toml) defines one machine
(shared-cpu-1x, 512 MB), a 20 GB volume at `/data`, a health check, and
`auto_stop_machines = "off"`. The hub's cron must never sleep.

```sh
# from the repo root
fly launch --no-deploy --copy-config --config deploy/fly/fly.toml --name <app>
fly volumes create ach_data --size 20 --region <region> --config deploy/fly/fly.toml
fly deploy --config deploy/fly/fly.toml --dockerfile deploy/docker/Dockerfile
fly logs --config deploy/fly/fly.toml | grep 'First-run setup'
```

- `ACH_PUBLIC_URL` defaults to `https://<app>.fly.dev`. For your own domain, run
  `fly certs add hub.example.com`, then `fly secrets set ACH_PUBLIC_URL=https://hub.example.com`.
- Never scale above one machine (`fly scale count 1`): SQLite on one volume.
- Shell: `fly ssh console -C "ach backup"`, `-C "du -sh /data/pb_data"`.
  Copy a file out with `fly ssh sftp get`.
- Runner: create a second app from `deploy/runner/Dockerfile` with its own
  volume at `/work`, `ACH_HUB=http://<hub-app>.internal:8090`, and
  `fly secrets set ACH_JOIN=... ANTHROPIC_API_KEY=...`.

## Railway

[`deploy/railway/railway.json`](../deploy/railway/railway.json) builds
`deploy/docker/Dockerfile` with one replica, a health check on `/api/health`,
and no sleeping.

1. *New project > Deploy from GitHub repo*. In the service's *Settings > Config-as-code*,
   set the path to `deploy/railway/railway.json`.
2. *Settings > Volumes > Add volume*, mount path **`/data`**, size **20 GB**
   (volume size limits depend on your plan). With the CLI:
   `railway volume add --mount-path /data`.
3. *Settings > Networking > Generate domain* (or add your own).
4. *Deployments > View logs* shows the `First-run setup:` line.

- `ACH_PUBLIC_URL` defaults to `https://$RAILWAY_PUBLIC_DOMAIN`. For your own
  domain, set it in *Variables*.
- The container starts as root only to make the root-owned volume writable, then
  runs the hub as uid 10001. No `RAILWAY_RUN_UID` is needed.
- Shell: `railway ssh -- ach backup`.
- Runner: add a second service from the same repo with Dockerfile path
  `deploy/runner/Dockerfile`, a volume at `/work`,
  `ACH_HUB=http://<hub-service>.railway.internal:8090`, and `ACH_JOIN` plus
  `ANTHROPIC_API_KEY` as variables.

## Render

[`deploy/render/render.yaml`](../deploy/render/render.yaml) is a Blueprint: a
Docker web service (*starter* plan; a disk needs a paid instance), a 20 GB disk
at `/data`, and a health check.

1. *New > Blueprint*, pick the repo, set *Blueprint Path* to `deploy/render/render.yaml`.
2. Leave `ACH_PUBLIC_URL` empty at first; it defaults to the `onrender.com` URL.
   For your own domain, add it under *Settings > Custom Domains* and set
   `ACH_PUBLIC_URL` under *Environment*.
3. The *Logs* tab shows the `First-run setup:` line.

- A service with a disk runs one instance, and deploys stop the old one before
  starting the new one (a short downtime per deploy).
- Shell: the *Shell* tab (`ach backup`, `du -sh /data/pb_data`).
- `autoDeploy` is off: upgrade deliberately ([deploy.md](deploy.md#upgrades)).
- Runner: add a *Background Worker* with runtime Docker,
  `dockerfilePath: ./deploy/runner/Dockerfile`, a disk at `/work`, `ACH_HUB` set
  to the hub's internal address (`http://agentchannel-hub:8090`, from *Connect >
  Internal*), and the join line and API key as secret env vars.

## AWS, Google Cloud, Azure

Use a small Linux VM with Docker, then follow [Docker Compose on any VM](#docker-compose-on-any-vm).
The cloud-init file also works as *user data* on all three.

| Cloud | VM | Disk | Firewall | Notes |
|---|---|---|---|---|
| **AWS Lightsail** | Ubuntu 24.04, $7 plan (1 GB) | 40 GB included | *Networking*: open 80, 443 | Attach a static IP. Simplest AWS path. |
| **AWS EC2** | t4g.small (arm64) or t3.small, Ubuntu 24.04 | gp3 20 GB, *delete on termination* off | Security group: 22 (your IP), 80, 443 | Elastic IP; snapshots via AWS Backup or DLM in addition to `ach backup`. |
| **Google Cloud** | Compute Engine e2-small, Ubuntu 24.04 | balanced persistent disk 20 GB | VPC firewall: allow 80, 443 (tags `http-server`, `https-server`) | Reserve a static external IP; paste cloud-init into *Metadata > user-data*. |
| **Azure** | B1ms, Ubuntu 24.04 | Standard SSD 32 GB | NSG: allow 80, 443 | *Advanced > Custom data* takes the cloud-init file. |

For a company setup, keep the hub in a private subnet with a load balancer or
Cloudflare Tunnel in front. Pass the load balancer's `X-Forwarded-For`
(see "Real client IPs" in [deploy.md](deploy.md#cloudflare-tunnel-and-access-optional)),
and do not cache or buffer `/api/realtime`.

## Alibaba Cloud (China mainland)

Cloudflare Tunnel and Access can be slow or blocked from mainland China, so use
domestic hosting with the hub's own one-time links (no front door) or email
codes over a domestic SMTP service.

1. **ICP filing (beian).** A website served from a mainland region on ports 80/443
   with a domain must have an ICP filing for that domain, done through Alibaba
   Cloud's filing service. It takes about 1 to 3 weeks. Until it is approved, the
   ports are blocked for the domain. Without a filing, use the Hong Kong or
   Singapore region (no filing needed, but slower from the mainland).
2. **ECS:** 2 vCPU / 2 GB, Ubuntu 24.04, 40 GB ESSD. Security group: open 80
   and 443. The cloud-init file works as *Instance user data*.
3. **Docker:** Ubuntu's `docker.io` package (as in the cloud-init file). Docker Hub
   can be slow, so configure a registry mirror (Alibaba Container Registry gives
   each account an accelerator address) in `/etc/docker/daemon.json` as
   `"registry-mirrors"`.
4. **Downloads during the build:** the PocketBase download comes from GitHub. If
   that is slow, build with a mirror:
   `docker compose build --build-arg PB_DOWNLOAD_BASE=https://<mirror>/pocketbase/releases/download`.
   The pinned SHA-256 checksums still apply, so a mirror cannot change the binary.
   Alternatively, build the image elsewhere and push it to Alibaba Container
   Registry, then set `ACH_IMAGE` in `.env`.
5. **HTTPS:** Caddy's automatic certificates (Let's Encrypt or ZeroSSL) work
   from Alibaba Cloud once the filing allows 80/443. Alternatively, use an
   Alibaba Cloud certificate (free DV certificates via *Certificate Management
   Service*) on an SLB/ALB in front of the hub, with plain HTTP from the load
   balancer to port 8090.
6. **Files:** for video, use **Alibaba Cloud OSS** in the same region
   ([file storage](deploy.md#file-storage-s3-compatible)). Volcengine TOS
   works the same way.
7. **Notifications:** a Feishu custom bot (`ACH_NOTIFY_WEBHOOK`) works from
   mainland servers.

Volcengine ECS follows the same steps: filing, a registry mirror, and TOS for files.

## Cloudflare Tunnel (any platform with a VM)

Use `COMPOSE_PROFILES=tunnel` and `TUNNEL_TOKEN` (the `https` profile is not
needed; no ports are open). Add Access as a front door if you want one
([deploy.md](deploy.md#cloudflare-tunnel-and-access-optional)). Quick tunnels
(`cloudflared tunnel --url`) are for demos only. They may buffer server-sent
events (the panel falls back to polling), and their URL changes on every start,
which breaks every link already sent.
