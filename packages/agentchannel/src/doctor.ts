import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client, type FetchLike } from './client.js';
import { achHome, DEFAULT_HOME_DIR, loadAgentKey, loadConfig, readFileConfig } from './config.js';
import { hubTransportOk, identifyAch, npmSpec, isV2, thisCliPath, userBin, whichAll } from './invite.js';
import { openKeyStore } from './keystore.js';
import { VERSION } from './version.js';

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecLike = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<ExecResult>;

export type DoctorSection = 'hub' | 'front door' | 'key' | 'machine';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  /** Report section (default: machine). */
  section?: DoctorSection;
  /** One line: what to do about a warn/fail. */
  fix?: string;
}

/** Ask-the-admin fix: a fresh join line carries a new key and whatever the hub needs to let you in. */
export const NEW_LINE_FIX = 'ask your admin to run `ach admin invite <your agent>` again and paste the new line';

/** Allowed clock difference with the hub before warning (login links and tokens are time-bound). */
export const CLOCK_SKEW_WARN_MS = 5 * 60_000;

export type Probe =
  | { kind: 'ok'; status: number; date?: string }
  | { kind: 'gate'; status: number; where: string }
  | { kind: 'http'; status: number }
  | { kind: 'dns' | 'refused' | 'timeout' | 'tls' | 'network'; message: string };

function causeCode(e: any): string {
  return String(e?.cause?.code ?? e?.code ?? '');
}

/** GET /api/health without following redirects, and classify what came back. */
export async function probeHub(hub: string, headers: Record<string, string>, fetchFn: FetchLike): Promise<Probe> {
  let res: Response;
  try {
    res = await fetchFn(`${hub}/api/health`, { method: 'GET', headers, redirect: 'manual' });
  } catch (e: any) {
    const code = causeCode(e);
    const message = String(e?.cause?.message ?? e?.message ?? e);
    if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(code)) return { kind: 'dns', message };
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(code)) return { kind: 'refused', message };
    if (/TIMEOUT|ETIMEDOUT|ABORT/i.test(code) || /timeout/i.test(message)) return { kind: 'timeout', message };
    if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code + message)) return { kind: 'tls', message };
    return { kind: 'network', message };
  }
  const loc = res.headers.get('location') ?? '';
  if (res.status >= 300 && res.status < 400 && /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(loc)) return { kind: 'gate', status: res.status, where: loc };
  if ((res.status === 401 || res.status === 403) && (res.headers.get('cf-ray') || /cloudflare/i.test(res.headers.get('server') ?? '')) && !/application\/json/.test(res.headers.get('content-type') ?? '')) {
    return { kind: 'gate', status: res.status, where: 'the hub address' };
  }
  if (res.status >= 300 && res.status < 400) return { kind: 'gate', status: res.status, where: loc || 'a sign-in page' };
  if (!res.ok) return { kind: 'http', status: res.status };
  return { kind: 'ok', status: res.status, date: res.headers.get('date') ?? undefined };
}

function probeText(p: Probe, host: string): { detail: string; fix: string } {
  switch (p.kind) {
    case 'dns': return { detail: `cannot find ${host} (${p.message})`, fix: 'check the hub address in the line from your admin, and that you are on the right network or VPN' };
    case 'refused': return { detail: `${host} refused the connection (${p.message})`, fix: 'the hub may be down: ask your admin whether it is running' };
    case 'timeout': return { detail: `${host} did not answer in time`, fix: 'check your network or VPN; if others can reach it, ask your admin' };
    case 'tls': return { detail: `the secure connection to ${host} failed (${p.message})`, fix: 'check the date and time on this machine; otherwise ask your admin to check the hub certificate' };
    case 'http': return { detail: `${host} answered HTTP ${p.status}`, fix: 'ask your admin to check the hub' };
    default: return { detail: (p as any).message ?? String(p.kind), fix: 'check your network, then run ach doctor again' };
  }
}

/** Runs a status command with a timeout; never throws. */
export const defaultExec: ExecLike = (file, args, env) =>
  new Promise((res) => {
    execFile(file, args, { env, timeout: 15_000, encoding: 'utf8', maxBuffer: 1 << 20 }, (err: any, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/** The Codex CLI the runner's SDK uses when `codex` is not on PATH. */
function bundledCodex(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const f = join(dirname(req.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
    return existsSync(f) ? f : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 160);
}

/**
 * `ach doctor`: a read-only setup check for v2 next to v1. Never prints the key
 * or the CF secret, and never reads Claude/Codex credential files: login state
 * comes from `claude auth status` and `codex login status`.
 */
export async function runDoctor(o: { env: NodeJS.ProcessEnv; fetch?: FetchLike; exec?: ExecLike; self?: string }): Promise<DoctorCheck[]> {
  const env = o.env;
  const exec = o.exec ?? defaultExec;
  const out: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck['status'], detail: string, section?: DoctorSection, fix?: string) =>
    out.push({ name, status, detail, ...(section && section !== 'machine' ? { section } : {}), ...(fix && status !== 'ok' && status !== 'info' ? { fix } : {}) });

  add('version', 'info', `ach ${VERSION} (${o.self ?? thisCliPath()})`);

  // Home
  const home = achHome(env);
  add('home', existsSync(home) ? 'ok' : 'warn', `${home}${env.AGENTCHANNEL_HOME ? ' (AGENTCHANNEL_HOME)' : ''}${existsSync(home) ? '' : ' does not exist yet: run the `ach join ...` line'}`);
  const { detectV1Home } = await import('./onboard.js');
  const v1Home = detectV1Home(env);
  if (v1Home) add('v1 home', 'info', `${v1Home} exists (AgentChannel v0.9); v2 does not use it (run the join line in a terminal to have it renamed to a backup; it asks first)`);

  // Config and key
  const file = readFileConfig(env);
  const cfg = loadConfig(env);
  add('hub', cfg.hub ? 'ok' : 'fail', cfg.hub ? `${cfg.hub}${env.ACH_HUB ? ' (ACH_HUB)' : ''}` : 'no hub configured', 'hub', 'paste the join line from your admin (npx -y agentchannel@2 join ach1....)');
  let key: string | undefined;
  let keyErr = '';
  try {
    key = env.ACH_KEY || loadAgentKey(env, file);
  } catch (e: any) {
    keyErr = String(e?.message ?? e);
  }
  const where = env.ACH_KEY ? 'ACH_KEY' : openKeyStore(home, env).kind === 'keychain' ? 'OS keychain' : 'agent-key file';
  add('agent key', key ? 'ok' : 'fail', key ? `present (${where}; not shown)` : `missing${keyErr ? ` (${keyErr})` : ''}`, 'key', key ? undefined : 'paste the join line from your admin again');

  // Hub: reachable over HTTPS; front door (if any); the key works; clock
  let runtime: string | undefined;
  let agentName: string | undefined;
  if (cfg.hub) {
    const fetchFn: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));
    let host = cfg.hub;
    try {
      const u = new URL(cfg.hub);
      host = u.host;
      if (!hubTransportOk(cfg.hub)) {
        add('hub https', 'warn', `${cfg.hub} is plain http:// to ${u.host} (not this machine): your key and every task travel unencrypted`, 'hub', 'ask your admin for the https:// address of the hub, then paste the new join line');
      } else if (u.protocol !== 'https:') add('hub https', 'info', `${cfg.hub} is plain http:// to a local address (${u.host})`, 'hub');
    } catch {
      add('hub', 'fail', `${cfg.hub} is not a valid address`, 'hub', 'paste the join line from your admin again');
    }
    const hasPass = !!(cfg.cfId && cfg.cfSecret);
    const pass: Record<string, string> = hasPass ? { 'CF-Access-Client-Id': cfg.cfId!, 'CF-Access-Client-Secret': cfg.cfSecret! } : {};
    const bare = await probeHub(cfg.hub, { accept: 'application/json' }, fetchFn);
    const withPass = hasPass && bare.kind === 'gate' ? await probeHub(cfg.hub, { accept: 'application/json', ...pass }, fetchFn) : bare;
    let reachable = false;
    let date: string | undefined;
    if (bare.kind === 'gate') {
      add('hub reachable', 'ok', `${host} answers (behind a front door)`, 'hub');
      const passSrc = env.ACH_CF_ID && env.ACH_CF_SECRET ? 'from ACH_CF_ID/ACH_CF_SECRET' : 'stored by join; not shown';
      if (withPass.kind === 'ok') {
        reachable = true;
        date = withPass.date;
        add('front door', 'ok', `the hub's front door lets this machine in (${passSrc})`, 'front door');
      } else if (!hasPass) {
        add('front door', 'fail', `the hub's front door (sign-in page at ${shortWhere(bare.where)}) blocks this machine: no pass for it is stored`, 'front door', NEW_LINE_FIX);
      } else {
        add('front door', 'fail', `the hub's front door refused this machine's pass (HTTP ${(withPass as any).status ?? '?'}): it expired or was revoked`, 'front door', NEW_LINE_FIX);
      }
    } else if (bare.kind === 'ok') {
      reachable = true;
      date = bare.date;
      add('hub reachable', 'ok', `${cfg.hub}/api/health`, 'hub');
      if (hasPass) add('front door', 'info', 'a front-door pass is stored, but the hub does not ask for one', 'front door');
    } else {
      const t = probeText(bare, host);
      add('hub reachable', 'fail', t.detail, 'hub', t.fix);
    }
    if (date) {
      const skew = Date.parse(date) - Date.now();
      if (Number.isFinite(skew) && Math.abs(skew) > CLOCK_SKEW_WARN_MS) {
        add('clock', 'warn', `this machine's clock is ${Math.round(Math.abs(skew) / 60_000)} min ${skew > 0 ? 'behind' : 'ahead of'} the hub`, 'hub', 'turn on automatic date and time (login links and tokens are time-limited)');
      } else if (Number.isFinite(skew)) add('clock', 'ok', 'in sync with the hub', 'hub');
    }
    if (key && reachable) {
      const c = new Client({ hub: cfg.hub, token: key, cfId: cfg.cfId, cfSecret: cfg.cfSecret, fetch: o.fetch });
      try {
        const me = await c.me();
        runtime = typeof me.runtime === 'string' ? me.runtime : undefined;
        agentName = me.name;
        add('hub login', 'ok', `agent ${me.name}${me.owner_name ? ` (owner ${me.owner_name})` : ''}, runtime ${me.runtime ?? '?'}`, 'key');
      } catch (e: any) {
        const st = e?.status;
        const why = st === 401 ? (e?.code === 'owner_deactivated' ? "the agent's owner is deactivated" : 'the key was replaced or the agent was turned off') : `${st ?? ''} ${e?.message ?? e}`.trim();
        add('hub login', 'fail', `the hub refused the key: ${why}`, 'key', NEW_LINE_FIX);
      }
    }
  }

  // Which `ach` runs
  const self = o.self ?? thisCliPath();
  const achs = whichAll('ach', env).map((p) => identifyAch(p, self));
  if (!achs.length) {
    add('ach on PATH', 'warn', 'no `ach` command on PATH', 'machine', `npm install -g agentchannel@${VERSION} (or run the join line again and answer yes to installing it)`);
  } else {
    const desc = (a: (typeof achs)[number]) => `${a.path}${a.real && a.real !== a.path ? ` -> ${a.real}` : ''} (${a.ours ? 'this CLI' : `${a.name ?? 'unknown'} ${a.version ?? ''}`.trim()})`;
    const first = achs[0];
    if (isV2(first)) add('ach on PATH', 'ok', desc(first));
    else {
      // only a v0.x agentchannel is uninstalled by name: `npm uninstall -g agentchannel` would remove a v2 global too
      const v1 = first.name === 'agentchannel' && /^0\./.test(first.version ?? '');
      add(
        'ach on PATH',
        'fail',
        v1
          ? `${desc(first)} is not v2 and shadows it. Uninstall v1 (\`npm uninstall -g agentchannel\`) or put v2 first on PATH; MCP entries printed by \`ach join\` use the absolute v2 path meanwhile.`
          : `${desc(first)} is not v2 and shadows it. Remove it or put v2 first on PATH; MCP entries printed by \`ach join\` use the absolute v2 path meanwhile.`,
        'machine',
        v1 ? `npm uninstall -g agentchannel (or use npx -y ${npmSpec()} …), or follow the steps below` : `put v2 first on PATH (or use npx -y ${npmSpec()} …), or follow the steps below`,
      );
      add('fix', 'info', shadowFix(first, achs.find((a) => isV2(a)), self));
    }
    for (const a of achs.slice(1)) add('ach (shadowed)', isV2(a) ? 'info' : 'warn', desc(a));
  }

  if (/[\\/]_npx[\\/]/.test(self)) {
    add('install', 'warn', 'this `ach` runs from the npx cache, which npm may clear', 'machine', `npm install -g agentchannel@${VERSION}`);
  }
  // Background runner (ach run --install-service): is a unit file there?
  if (agentName) {
    try {
      const { serviceFile } = await import('./service.js');
      const platform = (env.ACH_SERVICE_PLATFORM || process.platform) as string;
      if (platform === 'darwin' || platform === 'linux') {
        const f = serviceFile({ platform, agentName, node: '', cli: '', args: [], env: {}, logFile: '' }, env.ACH_SERVICE_DIR || undefined);
        add('background', 'info', existsSync(f.path) ? `tasks are picked up in the background (${f.path})` : 'no background runner on this machine (optional: ach run --dir <repo> --install-service --interactive-first)');
      }
    } catch {
      /* informational only */
    }
  }

  // Claude / Codex login (their own status commands; credential files are never read)
  const claude = userBin('claude', env);
  if (!claude) add('claude', 'info', 'not on PATH (needed only for the claude runtime or Claude Code)');
  else {
    const r = await exec(claude, ['auth', 'status'], env);
    let detail = firstLine(r.stdout || r.stderr);
    let ok = r.code === 0;
    try {
      const j = JSON.parse(r.stdout);
      ok = ok && j.loggedIn === true;
      detail = j.loggedIn ? `logged in (${j.authMethod ?? 'unknown method'})` : 'not logged in: run `claude auth login`';
    } catch {
      /* text output */
    }
    // Only the agent's own runtime login matters; the other is informational
    add('claude login', ok ? 'ok' : runtime && runtime !== 'claude' ? 'info' : 'warn', detail || `exit ${r.code}`);
    await mcpCheck('claude', claude);
  }
  // a codex that npx put on PATH (this package's SDK dependency) is not the user's Codex
  const codexPath = userBin('codex', env);
  const bundled = codexPath ? undefined : bundledCodex();
  if (!codexPath && !bundled) add('codex', 'info', 'not found (needed only for the codex runtime)');
  else {
    const r = codexPath ? await exec(codexPath, ['login', 'status'], env) : await exec(process.execPath, [bundled!, 'login', 'status'], env);
    const detail = firstLine(r.stdout || r.stderr) || `exit ${r.code}`;
    add('codex login', r.code === 0 ? 'ok' : runtime && runtime !== 'codex' ? 'info' : 'warn', `${detail}${codexPath ? '' : ' (bundled codex)'}`);
    if (codexPath) await mcpCheck('codex', codexPath);
  }
  return out;

  /**
   * The `ach` MCP entry as the runtime itself reports it (`<runtime> mcp get
   * ach`): what command it runs and whether that is v2. Never assumed from
   * what join did.
   */
  async function mcpCheck(name: 'claude' | 'codex', bin: string): Promise<void> {
    const mine = !runtime || runtime === name;
    const r = await exec(bin, ['mcp', 'get', 'ach'], env);
    const fix = `run the join line again and answer yes to adding it to ${name === 'claude' ? 'Claude Code' : 'Codex'} (or add --yes)`;
    if (r.code !== 0) {
      add(`${name} mcp`, mine ? 'warn' : 'info', `no \`ach\` MCP entry (\`${name} mcp get ach\` exit ${r.code})`, 'machine', fix);
    } else {
      const e = parseMcpEntry(r.stdout, 'ach');
      if (!e.command) add(`${name} mcp`, 'warn', `an \`ach\` entry exists but \`${name} mcp get ach\` did not show its command: ${firstLine(r.stdout) || '(no output)'}`, 'machine', fix);
      else {
        const v = entryVersion(e, env, o.self ?? thisCliPath());
        const shown = `runs \`${[e.command, ...e.args].join(' ')}\`${e.home ? ` with AGENTCHANNEL_HOME=${e.home}` : ''}`;
        if (!v.ok) add(`${name} mcp`, 'warn', `\`ach\` entry ${shown}: ${v.why}`, 'machine', fix);
        else if (e.home && !e.home.includes('*') && e.home !== achHome(env)) add(`${name} mcp`, 'warn', `\`ach\` entry ${shown}, but this machine's AgentChannel home is ${achHome(env)}`, 'machine', fix);
        else add(`${name} mcp`, 'ok', `\`ach\` entry ${shown} (${v.why})`);
      }
    }
    const old = await exec(bin, ['mcp', 'get', 'agentchannel'], env);
    if (old.code === 0) {
      add(`${name} mcp v0.9`, 'warn', `an old AgentChannel v0.9 MCP server "agentchannel" is still registered in ${name}`, 'machine', `${name} mcp remove ${name === 'claude' ? '--scope user ' : ''}agentchannel`);
    }
  }
}

/**
 * Command, args and AGENTCHANNEL_HOME of an MCP entry from `claude mcp get`
 * ("Command: npx" / "Args: -y agentchannel@2 mcp" / "AGENTCHANNEL_HOME=...")
 * or `codex mcp get` ("command: npx" / "args: ..." / "env: AGENTCHANNEL_HOME=..."),
 * or a `name: command args` line (mcp list style).
 */
export function parseMcpEntry(text: string, name: string): { command?: string; args: string[]; home?: string } {
  const cmd = /^\s*command:\s*(.+?)\s*$/im.exec(text)?.[1];
  const args = /^\s*args:\s*(.*?)\s*$/im.exec(text)?.[1];
  const home = /AGENTCHANNEL_HOME=([^\s,}]+)/.exec(text)?.[1];
  if (cmd) return { command: cmd, args: args && args !== '-' && args !== '[]' ? args.replace(/^\[|\]$/g, '').split(/[\s,]+/).map((x) => x.replace(/^"|"$/g, '')).filter(Boolean) : [], home };
  const line = new RegExp(`^\\s*${name}:\\s+(\\S.*?)(?:\\s+-\\s+[✓✗!].*)?$`, 'm').exec(text)?.[1];
  if (!line) return { args: [], home };
  const parts = line.split(/\s+/);
  return { command: parts[0], args: parts.slice(1), home };
}

/** Whether an MCP entry starts AgentChannel v2, and why (or why not). */
function entryVersion(e: { command?: string; args: string[] }, env: NodeJS.ProcessEnv, self: string): { ok: boolean; why: string } {
  const all = [e.command!, ...e.args];
  if (all.at(-1) !== 'mcp') return { ok: false, why: 'it does not end with `mcp`' };
  const spec = all.find((a) => /^agentchannel(@|$)/.test(a));
  if (/(^|[\\/])npx$/.test(e.command!)) {
    if (!spec || spec === 'agentchannel') return { ok: false, why: 'unpinned `npx agentchannel` starts AgentChannel v0.9' };
    const v = spec.slice('agentchannel@'.length);
    return /^(2|next)\b|^2\./.test(v) ? { ok: true, why: `v2 through npx (${spec})` } : { ok: false, why: `${spec} is not AgentChannel v2` };
  }
  // node <path>/cli.js mcp, or an ach executable
  const target = /(^|[\\/])node(\.exe)?$/.test(e.command!) ? e.args[0] : e.command!;
  if (!target) return { ok: false, why: 'no CLI path' };
  const path = target.includes('/') || target.includes('\\') ? target : whichAll(target, env)[0];
  if (!path) return { ok: false, why: `\`${target}\` is not on PATH` };
  if (!existsSync(path)) return { ok: false, why: `${path} does not exist` };
  const i = identifyAch(path, self);
  return isV2(i) ? { ok: true, why: i.ours ? 'this CLI' : `agentchannel ${i.version}` } : { ok: false, why: `${path} is ${i.name ?? 'not AgentChannel'} ${i.version ?? ''}`.trim() + ', not v2' };
}

/** The v2 package directory of a CLI path (…/<pkg>/dist/src/cli.js -> …/<pkg>). */
function packageDirOf(cli: string): string {
  let d = dirname(cli);
  for (let i = 0; i < 6; i++, d = dirname(d)) {
    if (existsSync(join(d, 'package.json'))) return d;
    if (dirname(d) === d) break;
  }
  return dirname(dirname(dirname(cli)));
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact commands that make v2 the \`ach\` on PATH when a v1 (0.9) \`ach\`
 * shadows it. v1 and v2 share the npm name "agentchannel", so the v1 global
 * install is removed and v2 installed from its package directory (or, if a v2
 * \`ach\` already sits later on PATH, that directory is moved first).
 */
export function shadowFix(v1: { path: string; real?: string; version?: string }, v2: { path: string } | undefined, self: string): string {
  const lines = ['to make v2 the `ach` on PATH, run:'];
  // a known non-0.x version is never uninstalled by name (it could be a v2 global)
  const v1Global = (!v1.version || /^0\./.test(v1.version)) && (!v1.real || /[\\/]node_modules[\\/]agentchannel[\\/]/.test(v1.real));
  const install = `  npm install -g ${shellQuote(packageDirOf(self))}        # installs this v2 CLI as \`ach\``;
  if (v1Global) {
    lines.push(`  npm uninstall -g agentchannel        # removes v1 (${v1.path})`);
    if (!v2) lines.push(install);
  } else {
    lines.push(`  # v1 is ${v1.path} -> ${v1.real}: remove that link, or put v2 first:`);
    lines.push(v2 ? `  export PATH=${shellQuote(dirname(v2.path))}:"$PATH"        # add this line to ~/.zshrc or ~/.bashrc` : install);
  }
  lines.push('  hash -r');
  lines.push('  ach doctor        # should now show v2 first');
  return lines.join('\n');
}

function shortWhere(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

const SECTIONS: { id: DoctorSection; title: string }[] = [
  { id: 'hub', title: 'Hub (reachable over HTTPS)' },
  { id: 'front door', title: 'Front door' },
  { id: 'key', title: 'Key' },
  { id: 'machine', title: 'This machine' },
];

/** Grouped report: hub, front door (only when there is one), key, this machine; each problem with a one-line fix. */
export function formatDoctor(checks: DoctorCheck[]): string {
  const mark = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]', info: '[info]' } as const;
  const out: string[] = [];
  for (const s of SECTIONS) {
    const list = checks.filter((c) => (c.section ?? 'machine') === s.id);
    if (!list.length) continue;
    if (out.length) out.push('');
    out.push(s.title);
    for (const c of list) {
      out.push(`${mark[c.status]} ${c.name}: ${c.detail}`);
      if (c.fix) out.push(`       fix: ${c.fix}`);
    }
  }
  return out.join('\n');
}

export { DEFAULT_HOME_DIR };
