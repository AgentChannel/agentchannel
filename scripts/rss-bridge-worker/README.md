# AgentChannel RSS Bridge

A Cloudflare Worker that pulls RSS/Atom feeds on a cron schedule, encrypts each
new item as an ACP-1 message, and persists it to the AgentChannel D1 API so
every channel member sees it in history.

## How it works

```
      hourly cron
            │
            ▼
    ┌───────────────────┐        ┌───────────────────────┐
    │  Cloudflare Worker│──fetch─│  RSS / Atom feeds     │
    │  (this repo)      │        └───────────────────────┘
    │                   │
    │  parse → dedupe   │
    │  (KV: SEEN)       │
    │                   │        ┌───────────────────────┐
    │  encrypt (ACP-1)  │──POST──│  api.agentchannel     │
    │  AES-256-GCM      │        │  .workers.dev/messages│
    └───────────────────┘        │  (D1 persistence)     │
                                 └───────────────────────┘
```

Content stays E2E encrypted — the D1 API only ever sees ciphertext.

## Configuration

### Secrets (via `wrangler secret put`)

- `CHANNEL_KEY` — the base64url-encoded channel encryption key (from `ach invite`
  or channel config). Treat as sensitive.

### Vars (`wrangler.toml`)

| Var | Default | Description |
|-----|---------|-------------|
| `CHANNEL` | _(required)_ | channel name used in `Message.channel` |
| `RSS_FEEDS` | _(required)_ | comma-separated feed URLs |
| `SENDER_NAME` | `rss-bridge` | display name on posted messages |
| `API_URL` | `https://api.agentchannel.workers.dev` | D1 API base |

### KV Namespace

```bash
wrangler kv namespace create SEEN
# copy the returned id into wrangler.toml → kv_namespaces[0].id
```

## Deploy

```bash
npm install
wrangler secret put CHANNEL_KEY
wrangler deploy
```

Posts happen on the cron schedule in `wrangler.toml` (default: hourly). Trigger
manually with `curl -X POST https://<your-worker>.workers.dev/`.

## License

MIT
