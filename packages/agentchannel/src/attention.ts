/**
 * Reminders, never content. Two pieces shared by `ach mcp` (an open Claude
 * Code / Codex session) and `ach run --notify` (the background helper):
 *
 * - ChangeFeed: follows the hub's change stream. GET /api/ach/changes long-poll
 *   (wait ≈ 25 s); when the hub refuses it (older hub: person sessions only) or
 *   it errors, falls back to polling every 15 s.
 * - AttentionNotifier: on a change, counts what needs the owner (questions,
 *   decisions, mentions...) and, when something new arrived, delivers ONE line
 *   ("AgentChannel: 2 items need you (1 question, 1 decision) — say 'check my
 *   inbox'"). At most one notice per 10 minutes; changes inside the window are
 *   coalesced into one notice at its end. Message bodies are never fetched or
 *   sent here: content comes only when the person asks (the inbox tools).
 */
import { execFile } from 'node:child_process';
import { HubError } from './client.js';

export type Request = (method: string, path: string) => Promise<any>;

/** Kinds in notice order. */
export const ATTENTION_KINDS = ['question', 'decision', 'mention', 'reply', 'task', 'item'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export interface Attention {
  total: number;
  counts: Partial<Record<AttentionKind, number>>;
  /** Stable ids of the items (what was already noticed is never noticed again). */
  ids: string[];
}

/** A hub item type / notification event -> a notice kind. Pure. */
export function attentionKind(type: unknown): AttentionKind {
  const t = String(type ?? '').toLowerCase();
  if (/decision/.test(t)) return 'decision';
  if (/question|escalat|ask|memory_held/.test(t)) return 'question';
  if (/mention|assigned/.test(t)) return 'mention';
  if (/repl|change_request|changes_requested/.test(t)) return 'reply';
  if (/task/.test(t)) return 'task';
  return 'item';
}

/**
 * Normalizes what the hub says needs the owner. Accepts GET /me/attention
 * (`{needs_reply_count, by_kind: {decision, question, mention, reply}}`, or a
 * list `{items:[{id,type}]}`) and, as a fallback,
 * GET /me/notifications?all=1 (rows with reply_needed / needs_me). Pure.
 */
export function normalizeAttention(r: any, fromNotifications = false): Attention {
  const counts: Partial<Record<AttentionKind, number>> = {};
  const ids: string[] = [];
  let items: any[] = Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : [];
  if (fromNotifications) items = items.filter((x) => x && (x.reply_needed || x.pending));
  else items = items.filter((x) => x && x.pending !== false);
  for (const x of items) {
    const k = attentionKind(x.type ?? x.kind ?? x.event);
    counts[k] = (counts[k] ?? 0) + 1;
    ids.push(String(x.id ?? x.event_id ?? x.message_id ?? `${k}:${ids.length}`));
  }
  const byKind = r?.by_kind ?? r?.counts;
  if (!items.length && byKind && typeof byKind === 'object') {
    // GET /me/attention: counts only (no ids); "new" = a count went up (AttentionNotifier)
    for (const [key, n] of Object.entries(byKind)) {
      const c = Number(n);
      if (!(c > 0)) continue;
      const k = attentionKind(key);
      counts[k] = (counts[k] ?? 0) + c;
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  return { total, counts, ids };
}

/** What needs the owner now (agent key: the owner's view). */
export async function fetchAttention(request: Request): Promise<Attention> {
  try {
    return normalizeAttention(await request('GET', '/api/ach/me/attention'));
  } catch (e) {
    if (!(e instanceof HubError) || (e.status !== 404 && e.status !== 403 && e.status !== 405)) throw e;
  }
  return normalizeAttention(await request('GET', '/api/ach/me/notifications?all=1&limit=100'), true);
}

const EN: Record<AttentionKind, [string, string]> = {
  question: ['question', 'questions'],
  decision: ['decision', 'decisions'],
  mention: ['mention', 'mentions'],
  reply: ['reply', 'replies'],
  task: ['task', 'tasks'],
  item: ['other', 'other'],
};
const ZH: Record<AttentionKind, string> = { question: '个问题', decision: '个决定', mention: '次提及', reply: '条回复', task: '个任务', item: '项其他' };

/** The one line. Counts only, never content. Pure. */
export function noticeText(a: Attention, lang: 'en' | 'zh' = 'en'): string {
  const parts = ATTENTION_KINDS.filter((k) => (a.counts[k] ?? 0) > 0).map((k) => {
    const n = a.counts[k]!;
    return lang === 'zh' ? `${n} ${ZH[k]}` : `${n} ${EN[k][n === 1 ? 0 : 1]}`;
  });
  if (lang === 'zh') return `AgentChannel：有 ${a.total} 件事等你处理（${parts.join('，')}）— 说「查看我的收件箱」`;
  return `AgentChannel: ${a.total} ${a.total === 1 ? 'item needs' : 'items need'} you (${parts.join(', ')}) — say 'check my inbox'`;
}

export const NOTICE_GAP_MS = 10 * 60_000;

export interface AttentionNotifierOptions {
  fetch: () => Promise<Attention>;
  /** Shows the line; resolves false when it could not (unsupported: stays silent). */
  deliver: (text: string) => Promise<boolean>;
  lang?: 'en' | 'zh';
  gapMs?: number;
  now?: () => number;
  log?: (s: string) => void;
}

export class AttentionNotifier {
  private noticed = new Set<string>();
  private lastCounts: Partial<Record<AttentionKind, number>> = {};
  private lastAt = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<string | null> | null = null;
  readonly sent: string[] = [];
  constructor(private o: AttentionNotifierOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Something changed: notice new items now, or once at the end of the rate window. */
  check(): Promise<string | null> {
    if (this.busy) return this.busy;
    this.busy = this.run().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async run(): Promise<string | null> {
    let a: Attention;
    try {
      a = await this.o.fetch();
    } catch (e: any) {
      this.o.log?.(`notice: ${String(e?.message ?? e).slice(0, 200)}`);
      return null;
    }
    // items that went away may come back as new ones later: keep only current ids
    const freshIds = a.ids.filter((id) => !this.noticed.has(id));
    const rose = ATTENTION_KINDS.some((k) => (a.counts[k] ?? 0) > (this.lastCounts[k] ?? 0));
    if (a.total <= 0 || (!freshIds.length && !(a.ids.length === 0 && rose))) {
      // fewer items now: a later increase is new again
      this.lastCounts = { ...a.counts };
      return null;
    }
    const wait = this.lastAt + (this.o.gapMs ?? NOTICE_GAP_MS) - this.now();
    if (wait > 0) {
      // coalesce: one check when the window ends
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.check();
        }, wait);
        this.timer.unref?.();
      }
      return null;
    }
    const text = noticeText(a, this.o.lang ?? 'en');
    this.lastAt = this.now();
    for (const id of a.ids) this.noticed.add(id);
    this.lastCounts = { ...a.counts };
    let ok = false;
    try {
      ok = await this.o.deliver(text);
    } catch {
      ok = false;
    }
    if (ok) this.sent.push(text);
    return ok ? text : null;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface ChangeFeedOptions {
  request: Request;
  onChange: () => unknown;
  /** Long-poll wait (s), ≤ 25. */
  waitS?: number;
  /** Fallback polling interval. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/**
 * Follows GET /api/ach/changes (long poll). Falls back to polling (onChange
 * every pollMs) when the hub refuses the route (403/404: an older hub, or
 * person sessions only) — permanently — or after an error (one interval, then
 * the long poll again).
 */
export class ChangeFeed {
  mode: 'longpoll' | 'poll' = 'longpoll';
  private stopped = false;
  private cursor = '';
  constructor(private o: ChangeFeedOptions) {}

  stop(): void {
    this.stopped = true;
  }

  private async fire(): Promise<void> {
    try {
      await this.o.onChange();
    } catch {
      /* the consumer logs its own errors */
    }
  }

  /** Runs until stop(). `rounds` bounds the loop (tests). */
  async run(rounds = Infinity): Promise<void> {
    const sleep = this.o.sleep ?? realSleep;
    const poll = this.o.pollMs ?? 15_000;
    const wait = Math.min(25, this.o.waitS ?? 25);
    let errors = 0;
    for (let i = 0; i < rounds && !this.stopped; i++) {
      if (this.mode === 'poll') {
        await this.fire();
        await sleep(poll);
        continue;
      }
      const t0 = Date.now();
      try {
        const q = new URLSearchParams({ wait: String(wait) });
        if (this.cursor) q.set('since', this.cursor);
        const r = await this.o.request('GET', `/api/ach/changes?${q}`);
        errors = 0;
        const first = !this.cursor;
        if (r?.cursor) this.cursor = String(r.cursor);
        if (r?.changed || first) await this.fire();
        // a hub that ignores `wait` must not be hammered
        if (Date.now() - t0 < 1000) await sleep(1000);
      } catch (e: any) {
        if (e instanceof HubError && (e.status === 403 || e.status === 404 || e.status === 405)) {
          this.mode = 'poll';
          this.o.log?.(`change stream not available (${e.status}); polling every ${Math.round(poll / 1000)} s`);
          continue;
        }
        if (e instanceof HubError && e.status === 401) {
          this.o.log?.('change stream: key refused (401); stopping');
          return;
        }
        errors++;
        if (errors === 1) this.o.log?.(`change stream: ${String(e?.message ?? e).slice(0, 200)}; retrying`);
        await this.fire();
        await sleep(poll);
      }
    }
  }
}

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/** The Codex session this `ach mcp` runs in, when known (env set by Codex, or ACH_CODEX_THREAD_ID). */
export function codexThreadId(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.ACH_CODEX_THREAD_ID || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  return v && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : undefined;
}

/** `codex queue --thread <id> --message <notice>`: the notice as a queued message in that session. */
export async function codexQueue(text: string, env: NodeJS.ProcessEnv, exec: Exec = defaultExec): Promise<boolean> {
  const thread = codexThreadId(env);
  if (!thread) return false;
  const r = await exec(env.ACH_CODEX_BIN || 'codex', ['queue', '--thread', thread, '--message', text]);
  return r.code === 0;
}
