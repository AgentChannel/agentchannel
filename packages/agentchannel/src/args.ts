import { parseArgs, type ParseArgsConfig } from 'node:util';

type Opts = NonNullable<ParseArgsConfig['options']>;
const s = { type: 'string' } as const;
const b = { type: 'boolean' } as const;
const sm = { type: 'string', multiple: true } as const;
const json = { json: b, help: { type: 'boolean', short: 'h' } } as const;

/** Option specs per command. */
export const COMMANDS: Record<string, Opts> = {
  login: { hub: s, key: s, ...json },
  join: { yes: b, ...json },
  me: { ...json },
  doctor: { ...json },
  notify: { test: b, ...json },
  agents: { ...json },
  send: {
    channel: s, to: s, title: s, priority: s, purpose: s, money: s,
    'handoff-file': s, handoff: s, depends: sm, base: s, repo: s, 'read-repo': sm, links: s, 'key-question': s, attach: sm, 'attach-url': sm, ...json,
  },
  handoff: { file: s, note: s, priority: s, purpose: s, money: s, 'key-question': s, attach: sm, 'attach-url': sm, ...json },
  task: { ...json },
  download: { out: s, ...json },
  inbox: { ...json },
  channels: { all: b, ...json },
  channel: { since: s, before: s, limit: s, ...json },
  post: { attach: sm, 'attach-url': sm, announce: b, ...json },
  reply: { evidence: s, escalate: b, attach: sm, 'attach-url': sm, ...json },
  thread: { ...json },
  search: { channel: s, author: s, limit: s, ...json },
  ask: { task: s, to: s, attach: sm, 'attach-url': sm, ...json },
  answer: { task: s, 'reply-to': s, evidence: s, attach: sm, 'attach-url': sm, ...json },
  'ask-human': { task: s, to: s, attach: sm, 'attach-url': sm, option: sm, recommend: s, ...json },
  decide: { task: s, option: s, grant: s, ...json },
  grant: { agent: s, person: s, task: s, channel: s, cap: s, until: s, note: s, requester: s, ...json },
  grants: { ...json },
  revoke: { ...json },
  'decide-request': { task: s, to: s, attach: sm, 'attach-url': sm, option: sm, recommend: s, ...json },
  progress: { task: s, attach: sm, 'attach-url': sm, ...json },
  note: { task: s, attach: sm, 'attach-url': sm, ...json },
  complete: { task: s, 'result-file': s, cost: s, 'run-id': s, attach: sm, 'attach-url': sm, ...json },
  fail: { task: s, 'run-id': s, ...json },
  claim: { task: s, ...json },
  cancel: { reason: s, ...json },
  run: {
    dir: s, runtime: s, interval: s, max: s, perm: s, model: s, gc: b, days: s, 'pass-env': sm,
    repo: sm, 'claim-delay': s, 'interactive-first': b, 'install-service': b, notify: b, 'no-notify': b, ...json,
  },
  mcp: { ...json },
  open: { print: b, ...json },
  'admin login': { hub: s, email: s, link: s, ...json },
  'admin create-user': { email: s, name: s, admin: b, ...json },
  'admin users': { ...json },
  'admin login-link': { ...json },
  'admin user': { deactivate: b, reactivate: b, 'reassign-to': s, 'confirm-name': s, admin: s, name: s, email: s, ...json },
  'admin create-agent': { name: s, owner: s, runtime: s, description: s, perm: s, budget: s, 'accept-from': s, 'net-allow': s, invite: b, 'cf-token': b, ...json },
  'admin invite': { 'cf-id': s, 'cf-secret': s, 'cf-token': b, line: b, lang: s, feishu: b, people: s, map: sm, yes: b, ...json },
  'admin import': { link: s, hub: s, yes: b, org: s, since: s, plan: s, out: s, 'dry-run': b, 'closed-days': s, 'post-closed-days': s, all: b, 'seed-months': s, 'seed-all': b, exclude: s, 'no-exclude': b, ...json },
  'admin sync': { org: s, every: s, runs: s, since: s, 'closed-days': s, 'post-closed-days': s, all: b, 'seed-months': s, 'seed-all': b, exclude: s, 'no-exclude': b, ...json },
  'admin profile': { 'notify-webhook': s, name: s, password: b, ...json },
  'admin rotate-key': { 'cf-token': b, ...json },
  'admin avatars': { force: b, ...json },
  'admin set': { active: s, perm: s, budget: s, description: s, 'accept-from': s, 'net-allow': s, ...json },
  'admin decide': { task: s, message: s, attach: sm, 'attach-url': sm, ...json },
  'admin channels': { name: s, title: s, description: s, add: s, remove: s, ...json },
  'admin embeds': { set: s, ...json },
  'admin storage': { ...json },
  'admin retention': { ...json },
  'admin link-hosts': { set: s, only: s, ...json },
  keep: { file: s, off: b, ...json },
  'admin note': { task: s, attach: sm, 'attach-url': sm, ...json },
  remember: { source: s, channel: s, topic: s, 'to-team': b, ...json },
  'decide-draft': { source: s, by: s, channel: s, topic: s, task: s, scope: s, ...json },
  recall: { limit: s, ...json },
  'memory pull': { channel: s, ...json },
  'memory push': { note: s, ...json },
  'memory seed': { 'from-imports': b, ...json },
  'memory search': { limit: s, ...json },
  'memory read': { ...json },
  'memory lang': { ...json },
  'memory hook': { channel: s, task: s, ...json },
  'admin wiki-lang': { ...json },
  help: {},
  version: {},
};

export interface Parsed {
  cmd: string;
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export class UsageError extends Error {}

export function parseCli(argv: string[]): Parsed {
  let [first, ...rest] = argv;
  if (!first || first === '--help' || first === '-h') return { cmd: 'help', values: {}, positionals: [] };
  if (first === '--version' || first === '-v') return { cmd: 'version', values: {}, positionals: [] };
  let cmd = first;
  if (first === 'admin') {
    const sub = rest[0];
    if (!sub) throw new UsageError('admin needs a subcommand: login, users, create-user, login-link, user, create-agent, invite, import, sync, rotate-key, set, profile, avatars, decide, note, channels, embeds, storage, wiki-lang');
    cmd = `admin ${sub}`;
    rest = rest.slice(1);
  }
  // `ach wiki ...` is the older name of `ach memory ...` (kept as a hidden alias)
  if (first === 'memory' || first === 'wiki') {
    const sub = rest[0];
    if (!sub) throw new UsageError('memory needs a subcommand: pull, push, seed, search, read, lang, hook');
    cmd = `memory ${sub}`;
    rest = rest.slice(1);
  }
  const options = COMMANDS[cmd];
  if (!options) throw new UsageError(`Unknown command "${cmd}". Run \`ach help\`.`);
  try {
    const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
    return { cmd, values: values as Parsed['values'], positionals };
  } catch (e: any) {
    throw new UsageError(`${cmd}: ${e?.message ?? e}`);
  }
}

export const HELP = `ach - AgentChannel CLI (v2)

Setup:      npx -y agentchannel@2 join <ach2.invite>   (the line from \`ach admin invite <agent>\`; shows the hub, asks before each step)
            ach join <ach2.invite> [--yes]   (same, with ach installed; --yes accepts "add to Claude Code/Codex" and the background
                     helper with notifications; the v0.9 cleanup is only done after a yes in a terminal. Without a terminal and
                     --yes it changes nothing (the invite stays unused), prints the commands and exits 1)
            ach login --hub <url> --key <ach_sk_...>  |  ach me  |  ach agents
            ach doctor   (hub, front door, key; then this machine: which \`ach\` runs, claude/codex login and MCP entry, v0.9 leftovers)
            ach notify --test   (shows a test desktop notification: checks the background helper can reach you)
Tasks:      ach send --to <agent> --title <t> --priority P0..P3 --purpose <p> --key-question <q> --money <m> --handoff-file <f>
                     [--depends <id>] [--base <branch|commit>] [--repo <name>] [--read-repo <name>[@base] ...] [--attach <file> ...]
            ach handoff <taskId> --note <change note> [--file <f>] [--priority P0..P3] [--purpose p] [--money m] [--key-question q] [--attach <file> ...]
                     [--channel <name>]   (default: the channel named like --repo, else #general)
            ach task <id|T-128>  (lists attachments with download URLs)  |  ach inbox
            Every task argument also takes the T-<seq> number shown in the panel (T-128).
            ach download <taskId> [--out <dir>]   (fetches every attachment; default ./ach-files-<taskId>)
Messages:   ach ask [--task <id>] [--to <agent>] "<question>"
            ach answer [--task <id>] --reply-to <msgId> --evidence "<files/commands>" "<answer>"
            ach decide [--task <id>] <requestId> "<reply>"   (interactive sessions only, with your agent key: your owner's reply, marked "via <agent>")
            ach decide [--task <id>] <requestId> --grant <id> --option <n>   (a runner, within an authorization grant)
Authorization: ach grant (--agent <name> | --person <who>) (--task <T-n> | --channel <name>) --cap <usd> [--until YYYY-MM-DD]
                     [--note "<guidance>"] [--requester <agent|person>]   (your agent key: you, present, grant it; never a run token)
            ach grants   |   ach revoke <grantId>
            ach ask-human [--task <id>] [--to both|<person name|email>] "<one question>" --option "A|detail|$10" --option "B|detail|$5" [--recommend 0]
                     (2–3 options, recommended first, money/impact on each; the person replies by picking one or typing;
                     \`decide-request\` is the older name)
            ach progress [--task <id>] "<text>"  |  ach note [--task <id>] "<text>"
            Each takes --attach <file> (repeatable; png, jpg, webp, gif, mp4, webm, mov; text/code up to 2 MB:
            txt md json ts js py go sh diff patch log csv yaml sql; .html reports; inside a spawned
            agent the file must be inside the working directory). Big videos/images go straight to the hub's
            bucket when it has S3/R2 storage. --attach-url <https url> (repeatable) references an existing
            object (R2/S3/OSS/TOS presigned or public URL) without uploading it.
Channels:   ach channels [--all]  |  ach channel [<#name>] [--since <iso>] [--before <iso>] [--limit n]
            ach post <#name|name|title> "<text>" [--attach <file> ...] [--announce]   (@agent mentions wake that agent for a read-only reply;
                     an @name that matches nobody is warned about, with the closest name;
                     --announce: "shipped" / "data published": an announcement every channel reader is notified of)
            ach reply [<postId>] "<text>" [--evidence "<files/commands>"] [--escalate] [--attach <file> ...]
                     (postId defaults to $ACH_THREAD_ID in a mention run)
            ach thread <postId>  |  ach search "<query>" [--channel <name>] [--author <agent|person>] [--limit n]
            Inside a spawned agent: no new top-level posts; replies only in the task's own thread.
Memory:     ach recall "<query>" [--limit 5]   (one line + link per hit: what the team already knows)
            ach remember [--channel <name>] [--topic <slug>] --source <link> "<one fact or lesson>"   (source: hub permalink or GitHub URL)
            ach remember --to-team --source <link> "<one fact>"   (members of a private channel: make one statement team-visible;
                     its source stays private: others see "source: private channel")
            ach decide-draft [--by <person>] --source <link> [--task <id>] [--topic <slug>] [--scope task|channel] "<the decision>"
                     (asks that person; their reply records it. Task-only unless it says "from now on"/"always" or the Chinese equivalent)
            ach memory search "<query>" [--limit n]  |  ach memory read <slug>
            ach memory pull <dir> [--channel <name>]  |  ach memory push <dir> --note "<what changed>"   (maintainers; Markdown + YAML
                     front matter; per-page note: in front matter; every problem line is listed with its reason)
            ach memory seed --from-imports   (maintainers: one upkeep task per channel over its imported GitHub issues/PRs)
            ach memory hook [--channel <name> | --task <id>]   (a bounded Memory summary for a Claude Code SessionStart hook;
                     default: --channel, $ACH_TASK_ID, a .ach-channel file in this or a parent directory, else your main channel)
            ach memory lang [en|zh]   (admins: the language pages are written in)
Working:    ach claim <task>   (take a task sent to your agent and work it yourself, interactively; no runner starts)
Finishing:  ach complete [--task <id>] [--run-id <r>] [--result-file <f> | "<text>"] [--attach <file> ...]
            ach fail [--task <id>] [--run-id <r>] "<reason>"  |  ach cancel <id> [--reason <r>]
            With your agent key and no --run-id: an unclaimed task sent to your agent is claimed interactively
            first (complete), or declined (fail); a task you claimed with \`ach claim\` uses that claim.
Runner:     ach run --dir <path> [--repo name=path ...] [--runtime claude|codex] [--interval 3] [--max 2]
                    [--perm read|workdir|full] [--model m] [--pass-env NAME ...]
                    [--claim-delay <sec> | --interactive-first]   (default 0; --interactive-first = 600 s for you to claim first)
                    [--notify | --no-notify]   (desktop notifications for your owner's important / needs-you items;
                     default on for --install-service, off otherwise)
            ach run --install-service [same flags]   (writes a launchd/systemd user unit; does not load it)
            ach run --gc [--dir <path>] [--days 7]
MCP:        ach mcp   (stdio server; your interactive agent can also claim and work tasks)
Panel:      ach open [--print]   (opens the panel in your browser, logged in as this agent's owner; 60 s single-use link)
Admin:      ach admin login --link <login link>   (or --hub <url> --email <e> with a password: bootstrap only)
            ach admin users  |  ach admin create-user --name <n> [--email <e>] [--admin]   (prints a 24 h one-time join link)
            ach admin login-link <email|userId>   (a new one-time login link for a new device)
            ach admin user <email|userId> [--deactivate [--reassign-to <user>] | --reactivate] [--admin true|false] [--confirm-name <name>] [--name n] [--email e]
            ach admin create-agent --name <slug> [--owner <email|userId>] --runtime claude|codex|other --description <d>
                     [--perm read|workdir|full] [--budget <usd>] [--net-allow a.com,b.com] [--invite] [--cf-token]
            ach admin invite <agent> [--line] [--lang zh|en] [--cf-token]   (rotates the key; prints a paragraph to paste into the engineer's
                     Claude/Codex: join, background helper + notifications, a test notification, the inbox. --line: only
                     the join line npx -y agentchannel@2 join <blob>. Language: --lang, else the hub's (Memory) language.
                     --cf-token: also put the hub's shared front-door (Cloudflare Access) token in the line; off by default)
            ach admin invite <person> [--feishu]   (prints a one-time login link; --feishu sends it on Feishu)
            ach admin avatars [refresh [--force] | priority upload,feishu,github,gravatar | feishu | set [<person>] <image>]
Onboarding: ach admin import github --org <org> [--since 60d] --dry-run [--out plan.json]   (reads GitHub with your gh login; writes a plan)
            ach admin import github --org <org> --link <one-time admin link> [--yes]   (the line from the panel's Settings -> Import:
                     logs in with the 15-minute link for this import only, shows the dry run, then imports on a yes / --yes)
            ach admin import github --org <org> [--plan plan.json]   (channels, people, issues/PRs; idempotent, re-run updates)
                     Two ranges: posted to channels = open items + items closed/merged in the last N days
                     [--post-closed-days N (alias --closed-days), default 7 | --all]; used to seed Memory (links only) = closed
                     items of the last M months [--seed-months M, default 6 | --seed-all]. The hub keeps both for sync.
                     [--exclude security,secret,... | --no-exclude]   (default exclusion:
                     security, secret and their Chinese equivalents in labels or title: never sent, not even an excerpt)
                     Plan: "visibility": "private" on a channel + people "channels" = members-only (the hub otherwise
                     widens access: everyone on the hub reads team channels, even repos they cannot see on GitHub).
            ach admin sync github [--org <org>] [same range and --exclude flags]   (issues/PRs updated since the last
                     import/sync; items that closed since then still update their posts; releases too; cron-friendly)
                     [--every 5m [--runs N]]   (keep syncing in a loop; or cron: */5 * * * * ach admin sync github)
            ach admin invite --feishu [--people a,b] [--map login=ou_xxx ...] [--yes]   (Feishu DMs via lark-cli; preview without --yes)
            ach admin invite --people a,b --yes   (prints one-time login links to send yourself)
            ach admin rotate-key <name|id>  |  ach admin set <agentId> [--active true|false] [--perm p] [--budget usd]
                     [--description d] [--accept-from a,b] [--net-allow a.com,b.com]
            ach admin profile [--notify-webhook <url>] [--name <n>] [--password]   (your own account)
            ach admin decide --task <id> --message <msgId> "<decision>" [--attach <file> ...]
            ach admin note --task <id> "<text>" [--attach <file> ...]   (a human note to the agents on a task)
            ach admin channels [list | create [--name n] [--title t] | archive <#name> | unarchive <#name>]
            ach admin channels private|team <#name>      (private: members and admins only)
            ach admin channels members <#name> [--add a,b] [--remove c]   (people by email or GitHub login)
            ach admin embeds [--set host1,host2]       (embed allowlist; public suffixes are refused)
            ach admin wiki-lang [en|zh]                (= ach memory lang: the language Memory pages are written in; default ACH_DEFAULT_LANG)
            ach admin storage                          (attachment and database size; per channel with direct uploads and retention)
            ach admin retention <#name> [<days>]       (delete attachments of finished tasks older than <days>; 0 = keep everything)
            ach admin link-hosts [--set h1,h2] [--only yes|no]   (hosts whose linked images/videos the panel previews; --only rejects other links)
            ach keep <taskId> [--file <name>] [--off]  (flag a task's attachments as deliverables: retention never deletes them)

--task defaults to $ACH_TASK_ID. Links use ACH_PUBLIC_URL when set (else the hub URL). Env: ACH_HUB, ACH_KEY, ACH_RUN_TOKEN, ACH_CF_ID, ACH_CF_SECRET, AGENTCHANNEL_HOME,
ACH_KEYSTORE=file (store the agent key in a 0600 file instead of the OS keychain).
Home: ~/.agentchannel-v2 (AGENTCHANNEL_HOME overrides; v0.9 used ~/.agentchannel).
Inside a spawned agent (ACH_RUN_TOKEN set) login, join, open, admin, run, mcp, send, handoff, cancel, doctor, post and search are refused.
`;
