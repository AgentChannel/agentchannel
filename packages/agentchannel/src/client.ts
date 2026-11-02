import type { Config } from './config.js';
import { openAsBlob, statSync } from 'node:fs';
import { basename } from 'node:path';
import { attachmentForm, bigFiles, downloadFile, isLinkRef, linkRef, taskFiles, typeOf, uploadTarget, type Attachment, type StorageConfig, type TaskFile } from './attachments.js';

export type TaskStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';
export const TERMINAL: readonly TaskStatus[] = ['completed', 'failed', 'canceled'];
export function isTerminal(s: string | undefined): boolean {
  return !!s && (TERMINAL as readonly string[]).includes(s);
}

export type MessageKind = 'question' | 'answer' | 'decision_request' | 'decision' | 'progress' | 'result' | 'note';

export interface Agent {
  id: string;
  name: string;
  owner?: string;
  owner_name?: string;
  runtime?: string;
  description?: string;
  perm_level?: string;
  budget_usd?: number;
  spent_usd?: number;
  active?: boolean;
  last_seen?: string;
  /** P2: domains the agent's sandbox may reach ("*" = any; admin-only). */
  net_allow?: string[];
}

export interface Task {
  id: string;
  title: string;
  priority?: string;
  purpose?: string;
  money?: string;
  status: TaskStatus;
  from_agent?: string;
  to_agent?: string;
  owner_user?: string;
  handoff?: string;
  handoff_version?: number;
  waiting_on?: string;
  depends_on?: string[];
  cost_usd?: number;
  links?: Record<string, unknown> | null;
  run_id?: string;
  /** P1: who holds the claim: a runner, or a person's interactive agent. */
  claim_mode?: '' | 'runner' | 'interactive';
  /** P6: the one question this task must answer. */
  key_question?: string;
  result?: string;
  created?: string;
  updated?: string;
  /** Human-friendly number ("T-128" = ref) and permalink. */
  seq?: number;
  ref?: string;
  url?: string;
  /** The task's channel. */
  channel?: string;
  channel_name?: string;
  /** Optional expansions some routes add. */
  from_agent_name?: string;
  to_agent_name?: string;
  [k: string]: unknown;
}

export interface Message {
  id: string;
  task: string;
  author_type?: 'agent' | 'human' | 'system';
  author_agent?: string;
  author_user?: string;
  kind: MessageKind | string;
  body: string;
  to_agent?: string;
  to_user?: string;
  reply_to?: string;
  evidence?: string;
  resolved?: boolean;
  created?: string;
  [k: string]: unknown;
}

export interface HandoffVersion {
  version: number;
  body: string;
  change_note?: string;
  author_agent?: string;
  created?: string;
  attachments?: Attachment[];
}

export interface TaskBundle {
  task: Task;
  handoff: string;
  messages: Message[];
  history: HandoffVersion[];
  /** Attachments of the current handoff version. */
  handoffAttachments?: Attachment[];
  /** The hub's wiki context for this task's worker prompt (claim / get as the worker). */
  wiki?: WikiContext | null;
}

/** What the hub picked from the team wiki for a worker prompt (≤ ~1k tokens). */
export interface WikiContext {
  budget_chars?: number;
  decisions: { id: string; text: string; decider?: string; as_of?: string; url?: string; human_confirmed?: boolean; use?: string }[];
  figures: { topic: string; metric: string; value: string; unit?: string; env?: string; as_of: string; source: string; stale?: boolean; use?: string }[];
  lessons: { page: string; text: string; stale?: boolean; use?: string }[];
  overview?: string[];
  used_chars?: number;
  pages: { slug: string; title: string; url?: string }[];
  truncated?: boolean;
  /** Values Memory marks superseded (never injected; used to redact them from channel posts). */
  superseded?: { topic?: string; metric: string; value: string; unit?: string; env?: string }[];
}

export interface ClaimResult extends TaskBundle {
  /** Empty for interactive claims (no spawned agent). */
  run_token: string;
}

export type ClaimMode = 'runner' | 'interactive';

export interface Inbox {
  tasks_to_me: Task[];
  questions_to_me: Message[];
  answers_to_me: Message[];
  decisions_for_me: Message[];
  /** Human notes on tasks I work (author_type human), addressed to me. */
  notes_for_me: Message[];
  /** Open @mentions of me in channel posts; each wakes a read-only mention run. */
  mentions_for_me: MentionItem[];
  updates_on_my_tasks: unknown[];
  server_time: string;
}

/** A channel post or thread reply. */
export interface Post {
  id: string;
  url?: string;
  channel: string;
  channel_name?: string;
  kind: 'post' | 'task' | 'system' | string;
  parent?: string;
  author_type?: 'agent' | 'human' | 'system';
  author_name?: string;
  body: string;
  evidence?: string;
  escalated?: boolean;
  mentions?: string[];
  task?: string;
  task_info?: Record<string, unknown> | null;
  reply_count?: number;
  attachments?: Attachment[];
  created?: string;
  [k: string]: unknown;
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  archived?: boolean;
  post_count?: number;
  last_post_at?: string;
  url?: string;
}

export interface Thread {
  post: Post;
  replies: Post[];
  focus?: string;
}

export interface MentionItem {
  mention: { id: string; post: string; thread: string; status: string; by: string; by_type: 'agent' | 'human'; created?: string };
  post: Post;
  thread: Post;
  channel_name: string;
}

export interface MentionRun extends MentionItem {
  replies: Post[];
  recent: Post[];
  run_token: string;
}

export interface SearchResult {
  type: 'post' | 'task' | 'message' | 'handoff';
  id: string;
  url: string;
  snippet: string;
  channel_name?: string;
  author_name?: string;
  task_ref?: string;
  task_title?: string;
  created?: string;
  [k: string]: unknown;
}

export interface SendTaskInput {
  to: string;
  title: string;
  priority: string;
  purpose: string;
  money: string;
  handoff: string;
  key_question?: string;
  depends_on?: string[];
  links?: Record<string, unknown>;
  /** Channel name; default = the channel named like links.repo, else #general. */
  channel?: string;
}

/** Header fields the sender may change after send. */
export interface TaskHeaderPatch {
  priority?: string;
  purpose?: string;
  money?: string;
  key_question?: string;
}

/** A sender-chosen extra repo (read-only for the worker). */
export interface LinkRepo {
  repo: string;
  base?: string;
}

/** Parse `name` or `name@base` (CLI `--read-repo`). */
export function parseLinkRepo(v: string): LinkRepo {
  const i = v.indexOf('@');
  const repo = (i >= 0 ? v.slice(0, i) : v).trim();
  const base = i >= 0 ? v.slice(i + 1).trim() : '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(repo)) throw new Error(`repo must be a name, got "${v}"`);
  if (i >= 0 && (!/^[A-Za-z0-9._\/-]{1,200}$/.test(base) || base.startsWith('-'))) throw new Error(`bad base in "${v}"`);
  return base ? { repo, base } : { repo };
}

export interface PostMessageInput {
  kind: MessageKind | string;
  body: string;
  to?: string;
  /** A decision request for a named person (user id, email or name; a member of the task's channel). */
  to_user?: string;
  evidence?: string;
  reply_to?: string;
  /** Tag, e.g. 'budget' for the runner's budget decision_request. */
  topic?: string;
  /** A structured decision request: one question, 2–3 options (recommended first). */
  question?: string;
  options?: DecisionOption[];
  recommended?: number;
}

export interface DecisionOption {
  label: string;
  detail?: string;
  money?: string;
}

export class HubError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: unknown) {
    super(message);
    this.name = 'HubError';
  }
}

/** A one-time login link: open `<hub><path>` (the token is in the URL fragment). */
export interface LoginLink {
  token: string;
  path: string;
  url: string;
  expires_at: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  hub: string;
  /** Agent key (ach_sk_...), run token (ach_rt_...) or a PocketBase user token. */
  token?: string;
  cfId?: string;
  cfSecret?: string;
  fetch?: FetchLike;
}

/** Human-facing CLI text in Chinese when LANG/LC_ALL starts with zh. */
export function isZh(env: NodeJS.ProcessEnv): boolean {
  return /^zh/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '');
}

/** Picks the bearer: run token (spawned agent) beats agent key. */
export function clientFromConfig(cfg: Config, opts: { admin?: boolean; fetch?: FetchLike } = {}): Client {
  if (!cfg.hub) {
    throw new Error(
      isZh(process.env)
        ? '还没有连接 hub：运行管理员发给你的 `ach join ach1....` 那一行（或设置 ACH_HUB）。'
        : 'No hub configured: run the `ach join ach1....` line your admin sent you (or set ACH_HUB).',
    );
  }
  const token = opts.admin ? cfg.adminToken : cfg.runToken || cfg.key;
  return new Client({ hub: cfg.hub, token, cfId: cfg.cfId, cfSecret: cfg.cfSecret, fetch: opts.fetch });
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Accept either `{task, handoff, messages, history}` or a bare task record. */
export function normalizeBundle(raw: any): TaskBundle {
  const task: Task = raw?.task ?? raw;
  return {
    task,
    handoff: typeof raw?.handoff === 'string' ? raw.handoff : raw?.handoff?.body ?? task?.handoff ?? '',
    messages: arr<Message>(raw?.messages),
    history: arr<HandoffVersion>(raw?.handoff_history ?? raw?.history ?? raw?.handoff_versions),
    handoffAttachments: arr<Attachment>(raw?.handoff?.attachments),
    wiki: raw?.wiki_context && typeof raw.wiki_context === 'object' ? (raw.wiki_context as WikiContext) : null,
  };
}

export class Client {
  readonly hub: string;
  private token?: string;
  private cfId?: string;
  private cfSecret?: string;
  private fetchFn: FetchLike;

  constructor(o: ClientOptions) {
    this.hub = o.hub.replace(/\/+$/, '');
    this.token = o.token;
    this.cfId = o.cfId;
    this.cfSecret = o.cfSecret;
    this.fetchFn = o.fetch ?? ((u, i) => fetch(u, i));
  }

  headers(json = true): Record<string, string> {
    const h: Record<string, string> = json ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' };
    if (this.token) {
      // Agent keys and run tokens use Bearer; PocketBase user tokens are sent raw.
      h.authorization = /^ach_(sk|rt)_/.test(this.token) ? `Bearer ${this.token}` : this.token;
    }
    if (this.cfId && this.cfSecret) {
      h['CF-Access-Client-Id'] = this.cfId;
      h['CF-Access-Client-Secret'] = this.cfSecret;
    }
    return h;
  }

  /** `files`: local paths (already checked by resolveAttachments) sent as multipart with the JSON in field "json". */
  async request<T = any>(method: string, path: string, body?: unknown, files?: string[]): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.hub}${path}`;
    if (files?.length) ({ body, files } = await this.splitAttachments(path, body, files));
    const multipart = !!files?.length;
    const res = await this.fetchFn(url, {
      method,
      headers: this.headers(!multipart),
      body: multipart ? await attachmentForm(body, files!) : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `${res.status} ${res.statusText}`;
      throw new HubError(res.status, `${method} ${path}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, data?.code, data);
    }
    return data as T;
  }

  private storageCfg?: Promise<StorageConfig | null>;
  /** GET /storage/config once per client (null on hubs without it). */
  storageConfig(): Promise<StorageConfig | null> {
    this.storageCfg ??= this.request<StorageConfig>('GET', '/api/ach/storage/config').catch(() => null);
    return this.storageCfg;
  }

  /**
   * Https entries become link references; media files over the hub's
   * direct-upload threshold go straight to its bucket (presign, PUT, complete)
   * and become upload references. The rest is sent as multipart, as before.
   */
  private async splitAttachments(path: string, body: unknown, files: string[]): Promise<{ body: unknown; files: string[] }> {
    const refs: unknown[] = files.filter(isLinkRef).map((f) => linkRef(f));
    let local = files.filter((f) => !isLinkRef(f));
    const target = uploadTarget(path);
    // only ask the hub when a file could be over any threshold (>= 5 MB)
    if (target && local.some((f) => statSync(f).size > 5 * 1048576)) {
      const big = bigFiles(local, await this.storageConfig());
      for (const f of big) refs.push(await this.directUpload(f, target));
      local = local.filter((f) => !big.includes(f));
    }
    if (!refs.length) return { body, files: local };
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const prior = Array.isArray(b.attachment_refs) ? b.attachment_refs : [];
    return { body: { ...b, attachment_refs: [...prior, ...refs] }, files: local };
  }

  /** Upload one file directly to the hub's bucket; returns the reference to attach ({upload}). */
  async directUpload(file: string, target: string): Promise<{ upload: string }> {
    const mime = typeOf(file);
    const size = statSync(file).size;
    const p = await this.request<any>('POST', '/api/ach/uploads/presign', { name: basename(file), mime, size, target });
    const put = p?.put;
    if (!put?.url || !p?.upload?.id) throw new HubError(502, `presign ${basename(file)}: unexpected answer`);
    const res = await this.fetchFn(put.url, { method: 'PUT', headers: put.headers ?? { 'content-type': mime }, body: (await openAsBlob(file, { type: mime })) as any });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HubError(res.status, `upload ${basename(file)} to storage: ${res.status} ${res.statusText} ${text.slice(0, 200)}`.trim());
    }
    const done = await this.request<any>('POST', '/api/ach/uploads/complete', { upload: p.upload.id });
    return { upload: String(done?.ref?.upload ?? p.upload.id) };
  }

  /** Avatars: send one image as multipart field "file" (plus plain fields). */
  async sendImage<T = any>(method: string, path: string, bytes: Uint8Array, filename: string, fields: Record<string, string> = {}): Promise<T> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const type = /\.png$/i.test(filename) ? 'image/png' : /\.gif$/i.test(filename) ? 'image/gif' : /\.webp$/i.test(filename) ? 'image/webp' : 'image/jpeg';
    fd.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), filename);
    const res = await this.fetchFn(`${this.hub}${path}`, { method, headers: this.headers(false), body: fd as any });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) throw new HubError(res.status, `${method} ${path}: ${(data && (data.error || data.message)) || res.status}`, data?.code, data);
    return data as T;
  }

  private ach<T = any>(method: string, path: string, body?: unknown, files?: string[]): Promise<T> {
    return this.request<T>(method, `/api/ach${path}`, body, files);
  }

  /** All attachments on a task (handoff versions and messages), with hub download URLs. */
  async taskFiles(taskId: string): Promise<TaskFile[]> {
    return taskFiles(await this.getTask(taskId));
  }
  /** Download one attachment into `dir`; returns the local path. */
  async download(a: Attachment, dir: string): Promise<string> {
    const h = this.headers(false);
    delete h.accept;
    return downloadFile(this.fetchFn, `${this.hub}${a.url}`, h, dir, a);
  }

  // ---- agent routes ----
  async me(): Promise<Agent> {
    const r = await this.ach<any>('GET', '/me');
    const a = r?.agent ?? r;
    if (r?.owner_name && !a.owner_name) a.owner_name = r.owner_name;
    return a;
  }
  async agents(): Promise<Agent[]> {
    const r = await this.ach<any>('GET', '/agents');
    return Array.isArray(r) ? r : arr<Agent>(r?.agents ?? r?.items);
  }
  async sendTask(input: SendTaskInput, files?: string[]): Promise<Task> {
    const r = await this.ach<any>('POST', '/tasks', input, files);
    return r?.task ?? r;
  }
  /** New handoff body (+ optional header fields, same version). Sender's agent key only. */
  async updateHandoff(taskId: string, body: string, change_note: string, header: TaskHeaderPatch = {}, files?: string[]): Promise<any> {
    return this.ach('PUT', `/tasks/${enc(taskId)}/handoff`, { ...header, body, change_note }, files);
  }
  /** Header fields only (priority, purpose, money, key_question). Sender's agent key only. */
  async updateHeader(taskId: string, header: TaskHeaderPatch, change_note?: string): Promise<any> {
    return this.ach('PATCH', `/tasks/${enc(taskId)}`, { ...header, ...(change_note ? { change_note } : {}) });
  }
  async getTask(taskId: string): Promise<TaskBundle> {
    return normalizeBundle(await this.ach('GET', `/tasks/${enc(taskId)}`));
  }
  async claim(taskId: string, run_id: string, mode: ClaimMode = 'runner'): Promise<ClaimResult> {
    const r = await this.ach<any>('POST', `/tasks/${enc(taskId)}/claim`, { run_id, ...(mode === 'interactive' ? { mode } : {}) });
    const b = normalizeBundle(r);
    return { ...b, run_token: r?.run_token ?? r?.token ?? '' };
  }
  /** Mint an answer-mode run token for a question addressed to me. */
  async answerRun(taskId: string, question_id: string, run_id: string): Promise<{ run_token: string; [k: string]: unknown }> {
    const r = await this.ach<any>('POST', `/tasks/${enc(taskId)}/answer-run`, { question_id, run_id });
    return { ...r, run_token: r?.run_token ?? r?.token ?? '' };
  }
  async postMessage(taskId: string, m: PostMessageInput, files?: string[]): Promise<Message> {
    const r = await this.ach<any>('POST', `/tasks/${enc(taskId)}/messages`, m, files);
    // A request addressed to someone else cc's the asking agent's owner
    if (r?.message && r.cc_user && !r.message.cc_user) r.message.cc_user = r.cc_user;
    return r?.message ?? r;
  }
  /** With an agent key the hub requires the task's current run_id (C3); run tokens carry their own. */
  async complete(taskId: string, result: string, run_id?: string, files?: string[], handoff_version?: number): Promise<any> {
    return this.ach('POST', `/tasks/${enc(taskId)}/complete`, { result, ...(run_id ? { run_id } : {}), ...(handoff_version ? { handoff_version } : {}) }, files);
  }
  async fail(taskId: string, reason: string, run_id?: string): Promise<any> {
    return this.ach('POST', `/tasks/${enc(taskId)}/fail`, { reason, ...(run_id ? { run_id } : {}) });
  }
  /** A grantee agent answers the part of a request its grant covers. */
  async grantDecide(taskId: string, message_id: string, option: number, grant: string): Promise<any> {
    return this.ach('POST', `/tasks/${enc(taskId)}/grant-decide`, { message_id, option, grant });
  }
  async createGrant(input: { agent?: string; person?: string; task?: string; channel?: string; cap?: number; until?: string; note?: string; requester?: string }): Promise<any> {
    return this.ach('POST', '/grants', input);
  }
  async listGrants(): Promise<{ given: any[]; received: any[] }> {
    return this.ach('GET', '/grants');
  }
  async revokeGrant(id: string): Promise<any> {
    return this.ach('POST', `/grants/${enc(id)}/revoke`, {});
  }
  async cancel(taskId: string, reason: string): Promise<any> {
    return this.ach('POST', `/tasks/${enc(taskId)}/cancel`, { reason });
  }
  /** The total size of a work prompt (Memory trial metrics). */
  async promptSize(taskId: string, run_id: string, chars: number, parts: Record<string, number> = {}): Promise<any> {
    return this.ach('POST', '/memory/prompt-size', { task: taskId, run_id, chars, parts });
  }
  async usage(taskId: string, run_id: string, cost_usd: number, estimated: boolean): Promise<any> {
    return this.ach('POST', `/tasks/${enc(taskId)}/usage`, { run_id, cost_usd, estimated });
  }
  /** 409 when the run lost the task. Carries a fresh `run_token` when the old one is near expiry (C5). */
  async heartbeat(taskId: string, run_id: string): Promise<{ ok: boolean; status: string; run_token?: string }> {
    return this.ach('POST', `/tasks/${enc(taskId)}/heartbeat`, { run_id });
  }
  /** Revoke the answer token(s) of a finished answer run (C4). */
  async endRun(taskId: string, run_id: string): Promise<any> {
    return this.ach('POST', `/tasks/${enc(taskId)}/end-run`, { run_id });
  }
  async inbox(): Promise<Inbox> {
    const r = await this.ach<any>('GET', '/inbox');
    return {
      tasks_to_me: arr(r?.tasks_to_me),
      questions_to_me: flatMsgs(r?.questions_to_me),
      answers_to_me: flatMsgs(r?.answers_to_me),
      decisions_for_me: flatMsgs(r?.decisions_for_me),
      notes_for_me: flatMsgs(r?.notes_for_me),
      mentions_for_me: arr<MentionItem>(r?.mentions_for_me),
      updates_on_my_tasks: arr(r?.updates_on_my_tasks),
      server_time: r?.server_time ?? new Date().toISOString(),
    };
  }

  // ---- Channels, posts, mentions, search ----
  async channels(all = false): Promise<Channel[]> {
    return arr<Channel>(await this.ach('GET', `/channels${all ? '?all=1' : ''}`));
  }
  async channelPosts(channel: string, o: { since?: string; before?: string; limit?: number } = {}): Promise<{ channel: Channel; posts: Post[] }> {
    const q = new URLSearchParams();
    if (o.since) q.set('since', o.since);
    if (o.before) q.set('before', o.before);
    if (o.limit) q.set('limit', String(o.limit));
    const qs = q.toString();
    return this.ach('GET', `/channels/${enc(channelRef(channel))}/posts${qs ? `?${qs}` : ''}`);
  }
  async post(channel: string, body: string, files?: string[], o: { announce?: boolean } = {}): Promise<Post> {
    const r = await this.ach<any>('POST', `/channels/${enc(channelRef(channel))}/posts`, { body, ...(o.announce ? { announce: true } : {}) }, files);
    return r?.post ?? r;
  }
  async reply(postId: string, body: string, o: { evidence?: string; escalate?: boolean } = {}, files?: string[]): Promise<Post> {
    const r = await this.ach<any>('POST', `/posts/${enc(postId)}/replies`, { body, ...(o.evidence ? { evidence: o.evidence } : {}), ...(o.escalate ? { escalate: true } : {}) }, files);
    return r?.post ?? r;
  }
  async thread(postId: string): Promise<Thread> {
    return this.ach('GET', `/posts/${enc(postId)}`);
  }
  async search(q: string, o: { channel?: string; author?: string; limit?: number } = {}): Promise<{ query: string; mode: string; results: SearchResult[] }> {
    const p = new URLSearchParams({ q });
    if (o.channel) p.set('channel', channelRef(o.channel));
    if (o.author) p.set('author', o.author);
    if (o.limit) p.set('limit', String(o.limit));
    return this.ach('GET', `/search?${p.toString()}`);
  }
  /** Take an @mention: a read-only "mention" run token for its thread. */
  async mentionRun(mentionId: string, run_id: string): Promise<MentionRun> {
    return this.ach('POST', `/mentions/${enc(mentionId)}/run`, { run_id });
  }
  async mentionEnd(mentionId: string, run_id: string): Promise<any> {
    return this.ach('POST', `/mentions/${enc(mentionId)}/end`, { run_id });
  }
  async mentionUsage(mentionId: string, run_id: string, cost_usd: number, estimated: boolean): Promise<any> {
    return this.ach('POST', `/mentions/${enc(mentionId)}/usage`, { run_id, cost_usd, estimated });
  }
  async agentProfile(name: string): Promise<any> {
    return this.ach('GET', `/profiles/agents/${enc(name)}`);
  }

  // ---- Team Memory (routes /api/ach/memory/*, formerly /wiki/*) ----
  /** `ach remember`: a fact or lesson with its source (hub permalink or GitHub URL); toTeam promotes it to the team overview. */
  async remember(text: string, source: string, o: { channel?: string; topic?: string; toTeam?: boolean } = {}): Promise<any> {
    return this.ach('POST', '/memory/contributions', { text, source, ...(o.channel ? { channel: channelRef(o.channel) } : {}), ...(o.topic ? { topic: o.topic } : {}), ...(o.toTeam ? { to_team: true } : {}) });
  }
  /** `ach decide-draft`: ask the person (a decision request); their reply records the decision. */
  async decideDraft(input: { text: string; source: string; by?: string; channel?: string; topic?: string; task?: string; scope?: string }): Promise<any> {
    return this.ach('POST', '/memory/decisions', { ...input, ...(input.channel ? { channel: channelRef(input.channel) } : {}) });
  }
  async wikiIndex(channel?: string): Promise<any> {
    return this.ach('GET', `/memory${channel ? `?channel=${enc(channelRef(channel))}` : ''}`);
  }
  async wikiPage(slug: string): Promise<any> {
    return this.ach('GET', `/memory/pages/${enc(slug)}`);
  }
  async wikiSearch(q: string, limit?: number): Promise<{ query: string; results: any[] }> {
    return this.ach('GET', `/memory/search?q=${enc(q)}${limit ? `&limit=${limit}` : ''}`);
  }
  async wikiExport(channel?: string): Promise<{ files: { name: string; slug: string; version: number; content: string }[]; template: string }> {
    return this.ach('GET', `/memory/export${channel ? `?channel=${enc(channelRef(channel))}` : ''}`);
  }
  async wikiPush(input: { pages: unknown[]; figures?: unknown[]; note: string }): Promise<{ held?: boolean; id?: string; conflicts?: { reason: string }[]; message?: string; pages: { slug: string; version: number; note?: string }[]; figures: unknown[]; warnings?: { slug: string; line: number; problem: string; text: string }[] }> {
    return this.ach('POST', '/memory/push', input);
  }
  async wikiSeed(): Promise<any> {
    return this.ach('POST', '/memory/seed', { from: 'imports' });
  }
  /** A bounded Memory summary for an interactive session (MCP instructions, SessionStart hook). */
  async memoryBrief(o: { channel?: string; task?: string } = {}): Promise<{ channel: string; text: string; chars: number }> {
    const q = o.task ? `?task=${enc(o.task)}` : o.channel ? `?channel=${enc(channelRef(o.channel))}` : '';
    return this.ach('GET', `/memory/brief${q}`);
  }

  // ---- User routes (decide: also an agent key speaking for its own owner) ----
  async decide(taskId: string, message_id: string, decision: string, files?: string[]): Promise<any> {
    return this.ach('POST', `/tasks/${enc(taskId)}/decide`, { message_id, decision }, files);
  }
  /** A human note on a task (user token; admins and the owners of either agent). */
  async note(taskId: string, body: string, files?: string[]): Promise<any> {
    return this.ach('POST', `/tasks/${enc(taskId)}/note`, { body }, files);
  }
  async panel(): Promise<any> {
    return this.ach('GET', '/panel');
  }
  /** A person (email optional) plus a one-time join link (24 h). No password. */
  async adminCreateUser(input: { email?: string; name: string; is_admin?: boolean }): Promise<LoginLink & { user: any }> {
    return this.ach('POST', '/admin/users', input);
  }
  async adminListUsers(): Promise<any[]> {
    return this.ach('GET', '/admin/users');
  }
  /** A fresh one-time login link (24 h) for a person's new device. */
  async adminUserLoginLink(ref: string): Promise<LoginLink & { user: any }> {
    return this.ach('POST', `/admin/users/${enc(ref)}/login-link`, {});
  }
  async adminPatchUser(ref: string, patch: Record<string, unknown>): Promise<any> {
    return this.ach('PATCH', `/admin/users/${enc(ref)}`, patch);
  }
  /** `ach open`: the agent key mints a 60 s single-use login link for its owner. */
  async loginLink(): Promise<LoginLink> {
    return this.ach('POST', '/login-link', {});
  }
  /** Exchange a one-time login link token for a PocketBase user session. */
  async exchangeLoginLink(token: string): Promise<{ token: string; record: any }> {
    return this.ach('POST', '/auth/link', { token });
  }
  /** P4/P5: the logged-in human's own profile (notify_webhook, password, name). */
  async patchMe(patch: Record<string, unknown>): Promise<any> {
    return this.ach('PATCH', '/me', patch);
  }
  async adminCreateAgent(input: Record<string, unknown>): Promise<any> {
    return this.ach('POST', '/admin/agents', input);
  }
  /** `cf_token`: put the hub's shared front-door token in the invites (opt-in; default false). */
  async adminRotateKey(agentId: string, o: { cf_token?: boolean } = {}): Promise<any> {
    return this.ach('POST', `/admin/agents/${enc(agentId)}/rotate-key`, { cf_token: !!o.cf_token });
  }
  async adminPatchAgent(agentId: string, patch: Record<string, unknown>): Promise<any> {
    return this.ach('PATCH', `/admin/agents/${enc(agentId)}`, patch);
  }
  /** PocketBase built-in password auth for humans. */
  async userLogin(email: string, password: string): Promise<{ token: string; record: any }> {
    return this.request('POST', '/api/collections/users/auth-with-password', { identity: email, password });
  }
}

/** Inbox message entries are `{message, task}`; flatten to the message (task id stays in `message.task`). */
export function flatMsgs(v: unknown): Message[] {
  return arr<any>(v).map((e) => {
    if (e && e.message && typeof e.message === 'object') {
      const m = { ...e.message } as Message;
      if (e.task && typeof e.task === 'object') (m as any).task_info = e.task;
      return m;
    }
    return e as Message;
  });
}

/** "#general" -> "general". */
export function channelRef(c: string): string {
  return String(c).trim().replace(/^#/, '');
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
