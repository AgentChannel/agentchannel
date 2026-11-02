/**
 * Desktop notifications from `ach run --notify`: the runner polls its owner's
 * notification list on the hub (agent key; `alert` items: things that need the
 * person, important events) and shows an OS notification for each new event.
 * Clicking opens the deep link where the platform supports it.
 *
 * - macOS: terminal-notifier when installed (click opens the link), else osascript.
 * - Linux: notify-send.
 * - Windows: a PowerShell toast (click opens the link).
 * - ACH_NOTIFIER=<command>: run `<command> <title> <message> <url>` instead (tests, custom setups).
 *
 * Decision requests (multiple choice) get option buttons where the OS can
 * return the click: macOS `alerter` (when installed; terminal-notifier and
 * osascript cannot report a click), Linux `notify-send --action` (libnotify
 * 0.7.9+), Windows toast buttons. A click never answers anything: it opens
 * the panel at the decision with that option preselected (`…?pick=<i>`), and
 * the person presses Send there. The helper runs with the agent key, so it
 * must not record the person's reply (no push action tokens, no /decide).
 * Without a click-capable notifier: a plain notification that opens the link.
 *
 * Changes arrive through the hub's change stream (long poll, see attention.ts),
 * with 15 s polling as the fallback.
 *
 * Deduped by event id, also across restarts (<home>/notify-seen.json), so the
 * same event never pops twice. The first run only records what is already
 * there: installing the service never floods the screen with old items.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';

export type NotifyExec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface NotifyOption {
  label: string;
  detail?: string;
  /** Index in the decision's own option list (the panel's `?pick=`); default: position. */
  option?: number;
  /** The hub's panel link with this option preselected (`…?pick=<i>`). */
  url?: string;
  /** Single-use push action token for this option (hub "push actions"). */
  token?: string;
}

export interface NotifyItem {
  event_id?: string;
  id?: string;
  event?: string;
  task_id?: string;
  task_ref?: string;
  message_id?: string;
  question?: string;
  post_id?: string;
  decision?: boolean;
  /** Decision items: still open and addressed to the owner. */
  open?: boolean;
  options?: (string | { option?: number; label?: string; detail?: string; token?: string; action_token?: string; url?: string })[];
  /** ?actions=1: single-use push action tokens per option. */
  actions?: { option?: number; label?: string; detail?: string; token?: string; action_token?: string; url?: string }[];
  text?: string;
  title?: string;
  url?: string;
  path?: string;
  alert?: boolean;
  at?: string;
}

export interface DeskNotifierOptions {
  request: (method: string, path: string, body?: unknown) => Promise<any>;
  home: string;
  hub: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  exec?: NotifyExec;
  intervalMs?: number;
  /** Runs a notifier that waits for the click (alerter, notify-send --wait): long timeout. */
  actionExec?: NotifyExec;
  log?: (s: string) => void;
}

const SEEN_FILE = 'notify-seen.json';
const SEEN_MAX = 1000;

const execWith =
  (timeout: number): NotifyExec =>
  (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout }, (err: any, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
const defaultExec: NotifyExec = execWith(10_000);
/** A decision notification waits up to an hour for the click. */
export const ACTION_TIMEOUT_S = 3600;
const defaultActionExec: NotifyExec = execWith((ACTION_TIMEOUT_S + 60) * 1000);

function whichIn(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const d of String(env.PATH ?? '').split(delimiter)) if (d && existsSync(join(d, name))) return join(d, name);
  return undefined;
}
function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return !!whichIn(name, env);
}
function oneLine(s: unknown, max = 200): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function appleQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** The command that shows one notification on this platform. */
export function notifyCommand(o: { title: string; message: string; url: string; group?: string }, platform: string, env: NodeJS.ProcessEnv): { cmd: string; args: string[] } | null {
  if (env.ACH_NOTIFIER) return { cmd: env.ACH_NOTIFIER, args: [o.title, o.message, o.url] };
  if (platform === 'darwin') {
    if (onPath('terminal-notifier', env)) {
      const args = ['-title', o.title, '-message', o.message, '-open', o.url];
      if (o.group) args.push('-group', o.group);
      return { cmd: 'terminal-notifier', args };
    }
    return { cmd: 'osascript', args: ['-e', `display notification ${appleQuote(o.message)} with title ${appleQuote(o.title)}`] };
  }
  if (platform === 'linux') return { cmd: 'notify-send', args: ['--app-name=AgentChannel', o.title, `${o.message}\n${o.url}`] };
  if (platform === 'win32') {
    const xml =
      `<toast activationType="protocol" launch="${xmlEscape(o.url)}"><visual><binding template="ToastGeneric">` +
      `<text>${xmlEscape(o.title)}</text><text>${xmlEscape(o.message)}</text></binding></visual></toast>`;
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$x.LoadXml('${xml.replace(/'/g, "''")}')`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AgentChannel').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
    ].join('; ');
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', ps] };
  }
  return null;
}


/** "A (Recommended)" (or the Chinese form, from a zh hub) -> "A". */
function stripRec(s: string): string {
  return s.replace(/\s*\((recommended)\)\s*$/i, '').replace(/\s*（推荐）\s*$/, '').trim();
}

/** The options a decision item offers (labels/details from `options`, tokens from `actions` by option index). Pure. */
export function itemOptions(x: NotifyItem): NotifyOption[] {
  const raw = Array.isArray(x.options) && x.options.length ? x.options : Array.isArray(x.actions) ? x.actions : [];
  const tokens = new Map<number, string>();
  (Array.isArray(x.actions) ? x.actions : []).forEach((a, i) => {
    const t = a && (a.token || a.action_token);
    if (t) tokens.set(typeof a.option === 'number' ? a.option : i, String(t));
  });
  const out: NotifyOption[] = [];
  raw.forEach((o, i) => {
    let opt: NotifyOption | null = null;
    if (typeof o === 'string') {
      const [label, ...rest] = o.split(' — ');
      if (stripRec(label)) opt = { label: stripRec(label), ...(rest.length ? { detail: rest.join(' — ') } : {}) };
    } else if (o && typeof o === 'object' && o.label) {
      const own = o.token || o.action_token;
      opt = { label: stripRec(String(o.label)), ...(o.detail ? { detail: String(o.detail) } : {}), ...(own ? { token: String(own) } : {}), ...(typeof o.url === 'string' && /^https?:\/\//.test(o.url) ? { url: o.url } : {}) };
    }
    if (!opt) return;
    const idx = typeof o === 'object' && o && typeof o.option === 'number' ? o.option : i;
    if (!opt.token && tokens.has(idx)) opt.token = tokens.get(idx);
    opt.option = idx;
    out.push(opt);
  });
  return out.slice(0, 4);
}

/** Task ref and message id of a decision item: fields, else its link `t/T-12/m/<id>`. Pure. */
export function itemTarget(x: NotifyItem): { task?: string; message?: string } {
  const m = /(?:^|#\/|\/)t\/([^/?#]+)\/m\/([A-Za-z0-9_-]+)/.exec(String(x.path ?? '') || String(x.url ?? ''));
  return { task: x.task_id || x.task_ref || (m ? decodeURIComponent(m[1]) : undefined), message: x.message_id || (m ? m[2] : undefined) };
}

function isDecision(x: NotifyItem): boolean {
  if (x.open === false) return false;
  return x.decision === true || /decision_request|memory_question/.test(String(x.event ?? '')) || itemOptions(x).length > 0;
}

/**
 * The panel link with option `i` preselected: `…/#/t/T-12/m/<id>?pick=<i>`
 * (the query goes inside the hash route, where the panel reads it). Pure.
 */
export function pickUrl(url: string, i: number): string {
  const u = url.replace(/([?&])pick=\d+(&|$)/, (_m, a, b) => (b ? a : ''));
  const hash = u.indexOf('#');
  const route = hash >= 0 ? u.slice(hash) : '';
  const sep = (hash >= 0 ? route : u).includes('?') ? '&' : '?';
  return `${u}${sep}pick=${i}`;
}

/** The reply text of an option: "label — detail" (the panel's buttons send the same words). */
export function optionReply(o: NotifyOption): string {
  return o.detail ? `${o.label} — ${o.detail}` : o.label;
}

/** A button label: one line, short; no commas (alerter separates actions with them). */
function buttonLabel(s: string, i: number): string {
  const t = oneLine(s, 40).replace(/,/g, ' ').trim();
  return t || `Option ${i + 1}`;
}

export interface ActionCommand {
  cmd: string;
  args: string[];
  /** The clicked option's index, 'open' (the notification body), or null (closed / timed out). */
  parse: (stdout: string) => number | 'open' | null;
}

/**
 * The command that shows a notification with option buttons and reports the
 * click on stdout, or null when this platform/setup cannot (then the caller
 * shows a plain notification). `linuxActions`: notify-send supports --action.
 */
export function actionCommand(
  o: { title: string; message: string; url: string; labels: string[]; group?: string },
  platform: string,
  env: NodeJS.ProcessEnv,
  linuxActions = false,
): ActionCommand | null {
  const labels = o.labels.map(buttonLabel);
  const byLabel = (out: string): number | 'open' | null => {
    const t = out.trim();
    if (!t) return null;
    const m = /^o(\d)$/.exec(t);
    if (m && Number(m[1]) < labels.length) return Number(m[1]);
    const i = labels.indexOf(t);
    if (i >= 0) return i;
    if (t === '@CONTENTCLICKED' || t === 'default' || t === 'open') return 'open';
    return null;
  };
  if (platform === 'darwin') {
    const alerter = whichIn('alerter', env);
    if (!alerter) return null;
    const args = ['-title', o.title, '-message', o.message, '-actions', labels.join(','), '-closeLabel', 'Later', '-timeout', String(ACTION_TIMEOUT_S)];
    if (labels.length > 1) args.push('-dropdownLabel', 'Reply');
    if (o.group) args.push('-group', o.group);
    return { cmd: alerter, args, parse: byLabel };
  }
  if (platform === 'linux') {
    if (!linuxActions) return null;
    const args = ['--app-name=AgentChannel', '--wait', `--expire-time=${ACTION_TIMEOUT_S * 1000}`, ...labels.map((l, i) => `--action=o${i}=${l}`), '--action=default=Open', o.title, o.message];
    return { cmd: 'notify-send', args, parse: byLabel };
  }
  if (platform === 'win32') {
    const actions = labels.map((l, i) => `<action content="${xmlEscape(l)}" arguments="o${i}" activationType="foreground"/>`).join('');
    const xml =
      `<toast launch="open" duration="long"><visual><binding template="ToastGeneric">` +
      `<text>${xmlEscape(o.title)}</text><text>${xmlEscape(o.message)}</text></binding></visual><actions>${actions}</actions></toast>`;
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$x.LoadXml('${xml.replace(/'/g, "''")}')`,
      '$t = [Windows.UI.Notifications.ToastNotification]::new($x)',
      '$global:r = $null',
      '$t.add_Activated({ param($s, $e) $global:r = ([Windows.UI.Notifications.ToastActivatedEventArgs]$e).Arguments })',
      '$t.add_Dismissed({ param($s, $e) $global:r = "" })',
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AgentChannel').Show($t)",
      `$end = (Get-Date).AddSeconds(${ACTION_TIMEOUT_S})`,
      'while ($global:r -eq $null -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 300 }',
      'if ($global:r) { Write-Output $global:r }',
    ].join('; ');
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', ps], parse: byLabel };
  }
  return null;
}

/** Opens a link in the default browser. */
function openCommand(url: string, platform: string): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [url] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return null;
}

/** `ach notify --test`: one test notification through the same path the helper uses. */
export async function testNotification(o: { hub?: string; env?: NodeJS.ProcessEnv; platform?: string; exec?: NotifyExec; lang?: 'en' | 'zh' }): Promise<{ ok: boolean; cmd?: string; error?: string }> {
  const env = o.env ?? process.env;
  const zh = o.lang === 'zh';
  const c = notifyCommand(
    {
      title: zh ? 'AgentChannel · 测试通知' : 'AgentChannel · test notification',
      message: zh ? '能看到这条，说明后台小助手可以提醒你。' : 'If you can see this, the background helper can reach you.',
      url: `${String(o.hub ?? '').replace(/\/+$/, '')}/#/inbox`,
      group: 'ach-test',
    },
    o.platform ?? process.platform,
    env,
  );
  if (!c) return { ok: false, error: `no desktop notifier for platform ${o.platform ?? process.platform}` };
  const r = await (o.exec ?? defaultExec)(c.cmd, c.args);
  return r.code === 0 ? { ok: true, cmd: c.cmd } : { ok: false, cmd: c.cmd, error: oneLine(r.stderr, 300) || `exit ${r.code}` };
}

export class DeskNotifier {
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private baseline: boolean;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private feed: { stop(): void } | null = null;
  private linuxActions?: boolean;
  /** Click handlers still waiting (tests await them). */
  readonly pending: Promise<void>[] = [];
  private readonly o: Required<Pick<DeskNotifierOptions, 'intervalMs'>> & DeskNotifierOptions;

  constructor(o: DeskNotifierOptions) {
    this.o = { intervalMs: 15_000, ...o };
    const f = join(o.home, SEEN_FILE);
    this.baseline = !existsSync(f);
    if (!this.baseline) {
      try {
        const v = JSON.parse(readFileSync(f, 'utf8'));
        if (Array.isArray(v)) for (const id of v) if (typeof id === 'string') this.remember(id, false);
      } catch {
        /* a broken file: start over (no flood: the baseline below) */
        this.baseline = true;
      }
    }
  }

  private remember(id: string, save = true) {
    if (this.seenSet.has(id)) return;
    this.seenSet.add(id);
    this.seen.push(id);
    while (this.seen.length > SEEN_MAX) this.seenSet.delete(this.seen.shift()!);
    if (save) this.persist();
  }
  private persist() {
    try {
      mkdirSync(this.o.home, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.o.home, SEEN_FILE), JSON.stringify(this.seen), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  /** One poll: show new alert items (oldest first). Returns how many were shown. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const r = await this.o.request('GET', '/api/ach/me/notifications?all=1&limit=50');
      const items: NotifyItem[] = Array.isArray(r?.items) ? r.items : [];
      const fresh = items.filter((x) => x && x.alert && (x.event_id || x.id)).reverse();
      if (this.baseline) {
        for (const x of items) if (x && (x.event_id || x.id)) this.remember(String(x.event_id || x.id), false);
        this.baseline = false;
        this.persist();
        return 0;
      }
      let shown = 0;
      for (const x of fresh) {
        const id = String(x.event_id || x.id);
        if (this.seenSet.has(id)) continue;
        this.remember(id);
        const url = x.url && /^https?:\/\//.test(x.url) ? x.url : `${this.o.hub.replace(/\/+$/, '')}/#/${String(x.path ?? 'inbox').replace(/^\/+/, '')}`;
        const title = `AgentChannel · ${oneLine(x.text, 60) || 'update'}`;
        const message = oneLine(x.question || x.title) || 'update';
        if (isDecision(x) && (await this.showActions(x, { title, message, url, id }))) {
          shown++;
          continue;
        }
        const c = notifyCommand({ title, message: oneLine(x.title) || 'update', url, group: id }, this.o.platform ?? process.platform, this.o.env ?? process.env);
        if (!c) continue;
        const res = await (this.o.exec ?? defaultExec)(c.cmd, c.args);
        if (res.code !== 0) this.o.log?.(`ach run --notify: ${c.cmd} failed (${res.code}): ${oneLine(res.stderr, 200)}`);
        shown++;
      }
      return shown;
    } catch (e: any) {
      this.o.log?.(`ach run --notify: ${oneLine(e?.message ?? e, 200)}`);
      return 0;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Options of a decision item: from the notification row, else (older hubs)
   * from the task's request message. Never asks the hub for push action
   * tokens: the helper does not answer, it only opens the panel.
   */
  private async optionsFor(x: NotifyItem): Promise<NotifyOption[]> {
    const opts = itemOptions(x).map(({ label, detail, option, url }) => ({ label, option, ...(detail ? { detail } : {}), ...(url ? { url } : {}) }));
    if (opts.length) return opts;
    const t = itemTarget(x);
    if (!t.task || !t.message) return [];
    try {
      const b = await this.o.request('GET', `/api/ach/tasks/${encodeURIComponent(t.task)}`);
      const msgs: any[] = Array.isArray(b?.messages) ? b.messages : [];
      const m = msgs.find((y) => y && y.id === t.message);
      if (!m || m.kind !== 'decision_request' || m.resolved) return [];
      const ch = m.choices;
      return Array.isArray(ch?.options) ? itemOptions({ options: ch.options }).map(({ label, detail, option }) => ({ label, option, ...(detail ? { detail } : {}) })) : [];
    } catch {
      return [];
    }
  }

  /** Whether this notifier can report clicks (Linux: notify-send --action). */
  private async canAct(platform: string): Promise<boolean> {
    if (platform !== 'linux') return true;
    if (this.linuxActions === undefined) {
      const r = await (this.o.exec ?? defaultExec)('notify-send', ['--help']);
      this.linuxActions = r.code === 0 && /--action/.test(r.stdout + r.stderr);
    }
    return this.linuxActions;
  }

  /**
   * A decision request with option buttons. Returns false when the platform
   * cannot report clicks (the caller shows a plain notification). The click is
   * handled in the background: the notifier keeps polling meanwhile.
   */
  private async showActions(x: NotifyItem, n: { title: string; message: string; url: string; id: string }): Promise<boolean> {
    const env = this.o.env ?? process.env;
    if (env.ACH_NOTIFIER) return false;
    const platform = this.o.platform ?? process.platform;
    const opts = await this.optionsFor(x);
    if (opts.length < 2) return false;
    const ac = actionCommand({ title: n.title, message: n.message, url: n.url, labels: opts.map((o) => o.label), group: n.id }, platform, env, await this.canAct(platform));
    if (!ac) return false;
    const p = (async () => {
      const r = await (this.o.actionExec ?? defaultActionExec)(ac.cmd, ac.args);
      const pick = ac.parse(r.stdout);
      if (pick === null) return;
      // a button opens the panel at the decision with that option preselected; the person sends it there
      const url = pick === 'open' ? n.url : opts[pick].url ?? pickUrl(n.url, opts[pick].option ?? pick);
      const oc = openCommand(url, platform);
      if (oc) await (this.o.exec ?? defaultExec)(oc.cmd, oc.args);
      if (pick !== 'open') this.o.log?.(`ach run --notify: opened the panel with "${oneLine(opts[pick].label, 80)}" preselected (desktop click)`);
    })().catch((e: any) => this.o.log?.(`ach run --notify: could not open the panel: ${oneLine(e?.message ?? e, 200)}`));
    this.pending.push(p);
    p.finally(() => {
      const i = this.pending.indexOf(p);
      if (i >= 0) this.pending.splice(i, 1);
    });
    return true;
  }

  /** Follows the hub's change stream (long poll; 15 s polling fallback). */
  start() {
    void import('./attention.js').then(({ ChangeFeed }) => {
      if (this.stopped) return;
      const feed = new ChangeFeed({ request: (m, p) => this.o.request(m, p), onChange: () => this.tick(), pollMs: this.o.intervalMs, log: this.o.log });
      this.feed = feed;
      void feed.run();
    });
  }
  private stopped = false;
  stop() {
    this.stopped = true;
    this.feed?.stop();
    this.feed = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
