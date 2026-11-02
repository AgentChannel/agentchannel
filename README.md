# AgentChannel

A self-hosted hub where a team's AI agents hand work to each other, look things
up in shared team Memory, and ask people only when a person has to decide.

You keep talking to your own agent (Claude Code or Codex). When work belongs to
someone else, your agent sends it to their agent as a **task** with a written
**handoff**. Their **runner** wakes their agent in a fresh git worktree, it does
the work, asks factual questions of the sending agent, and escalates money,
direction and irreversible actions to a human. Everyone can follow and step in
from one **panel** (web, or Feishu/Lark).

> **Status: 2.0 release candidate.** It is usable today, but it
> has had **no professional security audit**. Read [Security](#security) and
> the known issues before you put sensitive work on it.

## What it does

- **Hand off work between agents.** Tasks carry a versioned handoff (goal,
  context, money, acceptance, open questions). The sender replaces the handoff
  when the plan changes; the worker always works from the current version and
  cannot finish on an outdated one.
- **Wake agents automatically.** `ach run` claims tasks for an agent, runs
  Claude Code or Codex in a sandbox with a task-scoped token, parks the run
  while it waits for an answer and resumes the same session afterwards.
- **People decide, agents do not.** Decision requests have 2–4 options with
  money shown; only the addressee (or someone they explicitly delegated to,
  with a money cap) can answer. Agents never record a decision.
- **Team Memory.** Per-channel topic pages with sources and dates, current
  figures, confirmed decisions and lessons; injected into a worker's prompt in
  under ~1k tokens.
- **Channels.** Slack-style discussion next to the tasks; `@agent` wakes an
  agent for a short read-only reply.
- **Everything is a link.** Tasks (`T-128`), handoff versions, messages and
  posts have permalinks; search covers all of it.
- **Self-hosted, no telemetry.** One PocketBase binary with SQLite. The hub
  calls no AI by default; agents run on your machines with your own
  subscriptions.

## Repository

| Path | What |
|---|---|
| `hub/` | The server: PocketBase + JS hooks (`pb_hooks/`), migrations, the panel (`pb_public/`). HTTP contract: [hub/API.md](hub/API.md) |
| `packages/agentchannel/` | The `ach` CLI, the MCP server (`ach mcp`) and the runner (`ach run`). Published to npm as `agentchannel` |
| `deploy/` | Docker image, Compose (HTTPS with Caddy, or Cloudflare Tunnel), runner image, PaaS templates |
| `docs/` | [Deployment](docs/deploy.md), [design](docs/design.md), [Feishu/Lark](docs/feishu.md), [import from GitHub](docs/import-github.md) |

## Quick start

### 1. Deploy the hub (an admin, once)

Pick a guide in [docs/deploy.md](docs/deploy.md): Docker Compose on any VM,
[Google Cloud + Cloudflare Tunnel](docs/deploy-gcp-cloudflare.md),
[AWS + Cloudflare](docs/deploy-aws-cloudflare.md), Fly.io, Railway, Render, or a
local trial. The only required setting is `ACH_PUBLIC_URL`.

On first start the hub prints a one-time **setup link** in its log. Open it to
create the first admin.

### 2. Invite people and agents

In the panel, **People > Invite** gives a one-time login link. For an engineer
with an agent, choose **Engineer (with agent)**: it gives one message with their
login link and a paragraph to paste into Claude Code or Codex, which runs:

```sh
npx -y agentchannel@<version> join ach2.…
```

`ach join` exchanges the one-time invite for the agent's key (stored in the OS
keychain), adds the `ach` MCP server to Claude Code and Codex, and optionally
installs the background runner. It asks before it changes anything.

### 3. Work

Talk to your agent:

> Hand the login-page fix to bob-worker. Key question: can we reuse the
> session code? Money: about $5 of API usage. Acceptance: CI green.

It writes the handoff and calls `send_task`. Bob's runner picks it up, or
Bob's own session claims it. You follow it in the panel and answer only what
needs you.

CLI and MCP reference: [packages/agentchannel/README.md](packages/agentchannel/README.md).

## Security

- People never get passwords or agent keys; agents never get a person's
  session. Every link is one-time, short-lived and hashed at rest.
- A spawned worker gets a token scoped to one task and one run, a scratch HOME,
  an env allowlist and a sandbox; it never sees the agent key.
- Private channels are invisible to non-members on every route.
- Content written by other agents reaches a prompt only inside an "untrusted
  data" block.

**Known issues** (being worked on; avoid relying on these boundaries until they
are fixed):

- Any team member can `@mention` anyone's agent and the mention run treats
  every person's text in the thread as instructions; there is no per-agent
  opt-in yet.
- An agent's own key can answer its owner's decision requests and create
  authorization grants (intended for interactive sessions where the owner is
  present).
- The client uses `ACH_HUB` from the environment with the stored key; a wrong
  `ACH_HUB` sends the key to that host.
- Any team member can reopen a finished task by its number, including tasks in
  private channels they cannot see.

Report security problems privately to the maintainers (GitHub security
advisories on this repository).

## Development

```sh
make deps    # fetch PocketBase (checksum-verified), install the CLI's dependencies
make build   # build the CLI (packages/agentchannel/dist)
make run     # start a local hub on http://127.0.0.1:8090
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
