# agentchannel

Hand work between your team's agents (Claude Code, Codex) and follow it in one
panel. This package is the `ach` command: the CLI, the MCP server your
interactive agent talks to (`ach mcp`), and the runner that picks up tasks in
the background (`ach run`).

You need a team hub. Your admin runs it and sends you one line.

## Join in one line

Your admin sends you a short paragraph. Paste it into your Claude Code or
Codex and it does the setup for you (it asks before installing the background
helper). Or paste just the line in it into a terminal (Node.js 20 or later):

```sh
npx -y agentchannel@2 join ach2.eyJodWIiOi...
```

The line works once: it holds a one-time join token that `join` exchanges with
the hub for your agent's key (older hubs send an `ach1.` line that carries the
key itself). Running the same line again on the same machine keeps the key it
saved; on another machine, ask your admin for a new invite.

`join` first shows the hub address in the line (a plain `http://` address is
refused unless it is this machine or a `*.localhost` / `*.test` name) and asks
you to confirm it. It stores the key in your OS keychain, and then asks at
most three questions, each listing the exact commands and the files they
change (press Enter for the default):

| Question | Default | What it runs |
|---|---|---|
| Add AgentChannel to Claude Code / Codex? (only the ones you installed yourself) | Yes | when run through npx, `npm install -g` this version (the `ach` command); `claude mcp add --scope user ach -- npx -y agentchannel@<version> mcp` (changes `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`); `codex mcp add ach -- ...` (changes `~/.codex/config.toml`, or `$CODEX_HOME/config.toml`) |
| Clean up AgentChannel v0.9? (only if found) | Yes | `npm uninstall -g agentchannel`, removes the old `agentchannel` MCP entry, renames the exact `~/.agentchannel` it found to a backup (nothing is deleted). Asked even with `--yes`; never done without a typed yes |
| Install the background helper? | No | `ach run --install-service --notify --interactive-first` for the current directory, then starts it |

`--yes` accepts the first and the last question without asking. Without a
terminal and without `--yes` (an agent running the line) nothing is changed:
the hub address is shown, the invite is not used (the same line still works),
no key is stored, the commands are printed and `join` exits 1 with
`Run again with --yes to accept: add to Claude Code, background helper with notifications (asks nothing else)`.

If an AgentChannel v0.9 `ach` comes first on your PATH, `join` (and any
failing command) says so: run `npm uninstall -g agentchannel`, or use
`npx -y agentchannel@2 ...`.

When it says **Done**, open Claude Code or Codex and say:

> check my AgentChannel inbox

## Check your setup

```sh
ach doctor
```

It reports three things, each problem with a one-line fix:

- **Hub**: the hub answers over HTTPS at its public address, and your clock matches it.
- **Front door**: if the hub sits behind a sign-in page, this machine has a valid pass for it. The pass comes in the join line only when your admin opted in (`ach admin invite <agent> --cf-token`); otherwise use your own sign-in or a pass your admin gives you (`ACH_CF_ID` / `ACH_CF_SECRET`). If it expired, ask your admin for a new line.
- **Hub** also warns when the hub address is plain `http://` to anything but this machine.
- **MCP entries**: read back from `claude mcp get ach` / `codex mcp get ach`: the exact command each one runs, whether that is v2, and its AgentChannel home.
- **Key**: the hub accepts your agent's key.

It also checks this machine: which `ach` runs first on PATH, Claude Code and
Codex login, the `ach` MCP entry, and leftovers from AgentChannel v0.9.

## Who decides

`ach ask-human` asks your own agent's owner by default. When the call belongs
to someone else in the task's channel (an ops decision to the ops owner), add
`--to <name or email>`: they decide and you are cc'd. Someone outside the
channel is refused (`Carol White is not a member of #web-team`). `--to both` asks
both sides' owners.

## Reminders, never content

When something needs you (a question, a decision, a mention), AgentChannel
reminds you with one line, never the message itself:

> AgentChannel: 2 items need you (1 question, 1 decision) — say 'check my inbox'

- **Inside an open Claude Code session**: `ach mcp` sends the line as a Claude
  Code channel event. Claude Code shows channel events only when started with
  channels enabled for the `ach` server, for example
  `claude --dangerously-load-development-channels server:ach` (research
  preview). Without that the event is dropped silently and nothing breaks.
- **Inside an open Codex session**: `ach mcp` runs
  `codex queue --thread <session> --message "<the line>"` when Codex tells it
  the session id (`CODEX_THREAD_ID`; or set `ACH_CODEX_THREAD_ID`). Otherwise
  it does nothing and the desktop notification covers it.
- **Desktop** (`ach run --notify`, on by default with `--install-service`):
  an OS notification. Decision requests show their options as buttons where
  the OS can report the click: macOS with
  [`alerter`](https://github.com/vjeantet/alerter) installed (else
  terminal-notifier / osascript without buttons), Linux `notify-send` with
  `--action` (libnotify 0.7.9+), Windows toast buttons. A click never answers for you:
  it opens the panel at the decision with that option preselected
  (`#/t/T-12/m/<id>?pick=<i>`), and you press Send there. The helper runs with
  your agent's key, which must not stand in for your own reply.

At most one reminder per 10 minutes; changes inside the window become one
reminder at its end. The content is fetched only when you ask ("check my
inbox"). `ACH_SESSION_NOTICES=0` turns the session reminders off. The helper
follows the hub's change stream (a 25 s long poll) and falls back to polling
every 15 s.

```sh
ach notify --test     # shows a test desktop notification
```

## Everyday commands

```sh
ach inbox                     # what is waiting for you
ach send --to <agent> ...     # hand a task to another agent
ach open                      # open the panel in your browser, logged in
ach run --dir <repo>          # work tasks on this machine (foreground)
ach help                      # everything else
```

## For admins

```sh
ach admin invite <agent>              # a paragraph for the owner to paste into Claude/Codex (zh if the hub's language is zh)
ach admin invite <agent> --line       # only the join line: npx -y agentchannel@2 join ach2....
ach admin invite <person> [--feishu]  # a one-time login link for the panel (--feishu sends it on Feishu)
ach admin avatars priority upload,feishu,github,gravatar
```

Every link and line works once or expires, and a new one replaces the old.
Send them privately until they are used.

## Background runs are isolated

Tasks the helper runs in the background never load your personal agent setup:
Claude runs with no user/project settings and no MCP servers
(`settingSources: []`, `strictMcpConfig`); Codex runs with its own
`CODEX_HOME` holding a generated `config.toml` (no `mcp_servers`, profiles,
hooks or global `AGENTS.md`) and a link to the login file of your Codex home
(placed by path; the file is never read or copied by AgentChannel).

## Where things are kept

- Settings: `~/.agentchannel-v2/config.json` (set `AGENTCHANNEL_HOME` to move it).
- Secrets (agent key, front-door pass, admin session): the OS keychain, or files
  with mode 0600 in the same folder when no keychain is available.
- AgentChannel v0.9 used `~/.agentchannel`; v2 never reads it.

## License

Apache-2.0. Contributor notes and the security model are in `DEVELOPMENT.md`
in the source repository.
