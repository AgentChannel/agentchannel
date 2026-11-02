import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitCommonDir } from '../adapters/index.js';
import { toolchainReadRoots } from '../adapters/paths.js';
import type { AdapterResult, RuntimeAdapter } from '../adapters/types.js';
import { Client as HubClient, HubError, isTerminal, type Agent, type Client, type MentionItem, type Message, type Task, type TaskBundle } from '../client.js';
import { taskFiles } from '../attachments.js';
import { buildAgentEnv } from '../env.js';
import { effectivePerm, type Perm } from '../perm.js';
import { ANSWER_SCHEMA, buildAnswerPrompt, buildMentionPrompt, buildResumePrompt, buildTaskPrompt, postUrl, refOf, taskUrl, type ChannelContext, type PromptFile } from '../prompts.js';
import type { RunMode } from '../adapters/types.js';
import { RunnerState, type ReadRepo, type RunRecord } from './state.js';
import type { Workspace } from './workspace.js';

export type RunnerClient = Pick<
  Client,
  'me' | 'inbox' | 'claim' | 'getTask' | 'postMessage' | 'complete' | 'fail' | 'usage' | 'heartbeat' | 'answerRun' | 'endRun'
> &
  Partial<Pick<Client, 'download' | 'channelPosts' | 'mentionRun' | 'mentionEnd' | 'mentionUsage' | 'promptSize'>>;

export interface RunnerOptions {
  client: RunnerClient;
  adapter: RuntimeAdapter;
  workspace: Workspace;
  home: string;
  hub: string;
  /** --dir: cwd for answer runs on tasks without a worktree. */
  dir: string;
  max?: number;
  perm?: Perm;
  intervalMs?: number;
  heartbeatMs?: number;
  idleMs?: number;
  cfId?: string;
  cfSecret?: string;
  /** Extra env var names passed to spawned agents (`--pass-env`). */
  passEnv?: string[];
  baseEnv?: NodeJS.ProcessEnv;
  log?: (s: string) => void;
  newRunId?: () => string;
  /**
   * P1: leave new tasks alone for this long after they were sent, so the
   * owner can claim them interactively first (default 0: claim at once).
   */
  claimDelayMs?: number;
  /** Client acting with a run token (posts structured answers for codex). Default: a hub Client. */
  tokenClient?: (token: string) => Pick<Client, 'postMessage' | 'reply'>;
  /** Base URL for links in prompts (ACH_PUBLIC_URL); default the hub URL. */
  publicUrl?: string;
  /** B1: where per-task scratch HOMEs for spawned agents live (default <tmpdir>/ach-homes). */
  agentHomesDir?: string;
  /** How many recent channel posts work prompts carry (default 15; 0 = none). */
  channelContext?: number;
}

export type Job =
  | { kind: 'work'; taskId: string }
  /** nudge: the agent stopped without finishing; ask it once to complete, fail or ask. */
  | { kind: 'resume'; taskId: string; replies: Message[]; nudge?: boolean }
  | { kind: 'answer'; taskId: string; question: Message }
  | { kind: 'mention'; item: MentionItem };

export function jobKey(j: Job): string {
  if (j.kind === 'mention') return `mention:${j.item.mention.id}`;
  return j.kind === 'answer' ? `answer:${j.question.id}` : `task:${j.taskId}`;
}

interface Active {
  job: Job;
  controller: AbortController;
  /** lost: the hub says this run no longer owns the task (heartbeat 409, C3). */
  reason?: 'cancel' | 'idle' | 'stop' | 'lost' | 'auth';
  done: Promise<void>;
  /** Job to start right after this one frees its slot (e.g. resume on replies that arrived mid-run). */
  followUp?: Job;
}

const TOKEN_REFRESH_MS = 20 * 3600_000;
const PRUNE_EVERY_MS = 10 * 60_000;

/** A gate decision that lets the run go ahead (S1). Anything else rejects. */
export function approves(decision: string): boolean {
  return /^\s*(approve[ds]?|yes|ok|okay|allow(ed)?|go ahead)\b/i.test(decision);
}

export function newRunId(): string {
  return `run_${randomBytes(9).toString('base64url')}`;
}

function is409(e: unknown): boolean {
  return e instanceof HubError && e.status === 409;
}

function is401(e: unknown): boolean {
  return e instanceof HubError && e.status === 401;
}

/**
 * What the worker is still waiting on: its own open questions, blocking decision
 * requests, and (non-blocking) decision requests that replace one of its questions.
 */
export function openRequests(messages: Message[], myId: string): Message[] {
  const myQuestions = new Set(messages.filter((m) => m.kind === 'question' && m.author_agent === myId).map((m) => m.id));
  return messages.filter((m) => {
    if (m.resolved) return false;
    if (m.kind === 'question') return m.author_agent === myId;
    if (m.kind !== 'decision_request') return false;
    if (m.blocking === false) return !!m.reply_to && myQuestions.has(m.reply_to);
    return true;
  });
}

/** A human note addressed to me (panel composer / `ach admin note`): wakes a parked run. */
export function isHumanNoteTo(m: Message, myId: string): boolean {
  return m.kind === 'note' && m.author_type === 'human' && m.to_agent === myId;
}

/** Answers / decisions replying to something I asked, and human notes to me, that the worker has not been shown yet. */
export function unseenReplies(messages: Message[], myId: string, seen: string[]): Message[] {
  const mine = new Set(messages.filter((m) => m.author_agent === myId).map((m) => m.id));
  // A decision request that replaced one of my questions: its decision answers me.
  for (const m of messages) if (m.kind === 'decision_request' && m.reply_to && mine.has(m.reply_to)) mine.add(m.id);
  const seenSet = new Set(seen);
  return messages.filter(
    (m) =>
      !seenSet.has(m.id) &&
      (((m.kind === 'answer' || m.kind === 'decision') && ((m.reply_to && mine.has(m.reply_to)) || m.to_agent === myId)) || isHumanNoteTo(m, myId)),
  );
}

/**
 * Runner files a spawned agent must never read: the agent key (config.json), other
 * runs' tokens (runs.json), session ids and logs. Not the whole home: the per-task
 * worktrees live in <home>/work and must stay readable.
 */
export function secretPaths(home: string): string[] {
  return ['config.json', 'agent-key', 'admin-session', 'cf-secret', 'runs.json', 'sessions.json', 'logs'].map((f) => join(home, f));
}

/**
 * Runtime config a spawned agent's CLI needs from the real home: linked into the
 * scratch home. Claude only: its user settings, hooks and MCP servers are not
 * loaded anyway (settingSources [], strictMcpConfig). Codex is NOT linked: it
 * gets its own CODEX_HOME (see prepareCodexHome).
 */
export const RUNTIME_HOME_LINKS = ['.claude', '.claude.json'];

/**
 * macOS (live test): Claude Code keeps its login in the login keychain, which
 * `security` finds through $HOME/Library/Keychains. Without this link a worker
 * with a scratch HOME reports "Not logged in". Only the folder is linked; the
 * sandbox still denies the worker's tools every path under the real home.
 */
export function runtimeHomeLinks(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? [...RUNTIME_HOME_LINKS, 'Library/Keychains'] : RUNTIME_HOME_LINKS;
}

/** The config.toml of a worker's own CODEX_HOME: nothing from the user's global config (no mcp_servers, profiles, notify hooks). */
export const CODEX_WORKER_CONFIG = [
  '# Written by agentchannel for background worker runs. The user\'s global Codex',
  '# config (MCP servers, profiles, hooks, AGENTS.md) is deliberately not used here.',
  '# Model and sandbox are set per run by the runner.',
  '',
].join('\n');

/**
 * Codex isolation (live test): a worker run must not load the user's global
 * Codex config (~/.codex/config.toml: MCP servers with their own credentials,
 * profiles, notify hooks, AGENTS.md). The run gets its own CODEX_HOME holding
 * only a generated config.toml and a symlink to the login file (auth.json) of
 * the user's Codex home. The login file is placed by path only: it is never
 * opened or copied here. Codex rewrites it in place through the link, so a
 * refreshed login stays the user's. Sessions of the run stay in this home, so
 * a resumed run of the same task finds its thread.
 */
export function prepareCodexHome(home: string, realCodexHome?: string): string {
  const dir = join(home, '.codex');
  try {
    // an older scratch home linked the whole ~/.codex: replace the link
    if (lstatSync(dir).isSymbolicLink()) rmSync(dir);
  } catch {
    /* not there */
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.toml'), CODEX_WORKER_CONFIG, { mode: 0o600 });
  if (realCodexHome) {
    const src = join(realCodexHome, 'auth.json');
    const dst = join(dir, 'auth.json');
    let have = false;
    try {
      lstatSync(dst);
      have = true;
    } catch {
      /* not there */
    }
    if (!have && existsSync(src)) {
      try {
        symlinkSync(src, dst);
      } catch {
        /* best effort: codex then reports "not logged in" */
      }
    }
  }
  return dir;
}

/**
 * B1: a per-task scratch HOME for spawned agents, so `~/.agentchannel-v2`
 * (agent key file, admin session, runner state) is not reachable through
 * $HOME. Runtime config (.claude, .codex) is linked, the git identity
 * (.gitconfig) copied; npm keeps the real cache via npm_config_cache.
 */
export function prepareAgentHome(root: string, agentName: string, key: string, realHome?: string, realCodexHome?: string): { home: string; env: Record<string, string> } {
  const safe = (x: string) => x.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const home = join(root, safe(agentName), safe(key));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = { HOME: home };
  if (!realHome) {
    env.CODEX_HOME = prepareCodexHome(home, realCodexHome);
    return { home, env };
  }
  for (const name of runtimeHomeLinks()) {
    const src = join(realHome, name);
    const dst = join(home, name);
    if (!existsSync(src)) continue;
    try {
      lstatSync(dst);
    } catch {
      try {
        mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
        symlinkSync(src, dst);
      } catch {
        /* best effort */
      }
    }
  }
  const git = join(realHome, '.gitconfig');
  if (existsSync(git)) {
    try {
      copyFileSync(git, join(home, '.gitconfig'));
    } catch {
      /* best effort */
    }
  }
  const npmCache = join(realHome, '.npm');
  if (existsSync(npmCache)) env.npm_config_cache = npmCache;
  env.CODEX_HOME = prepareCodexHome(home, realCodexHome || join(realHome, '.codex'));
  return { home, env };
}

export function budgetBlocked(me: Agent): boolean {
  const budget = Number(me.budget_usd ?? 0);
  return budget > 0 && Number(me.spent_usd ?? 0) >= budget;
}

export class Runner {
  readonly state: RunnerState;
  readonly queue: Job[] = [];
  readonly active = new Map<string, Active>();
  me?: Agent;
  private o: Required<Pick<RunnerOptions, 'max' | 'perm' | 'intervalMs' | 'heartbeatMs' | 'idleMs'>> & RunnerOptions;
  private stopped = false;
  private waiters: (() => void)[] = [];
  private lastPrune = 0;
  /** Last heartbeat sent for each parked run. */
  private parkedHb = new Map<string, number>();
  /** B7: set when the hub answered 401 (key rotated, agent or owner deactivated): the runner stops. */
  fatal?: 'unauthorized';
  private wake?: () => void;

  constructor(opts: RunnerOptions) {
    this.o = { max: 2, perm: 'workdir', intervalMs: 3000, heartbeatMs: 30_000, idleMs: 60 * 60_000, ...opts };
    this.state = new RunnerState(opts.home);
  }

  private log(s: string): void {
    (this.o.log ?? ((x: string) => console.error(x)))(`[ach run] ${s}`);
  }

  private taskLog(taskId: string, line: string): void {
    try {
      const dir = join(this.o.home, 'logs');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, `${taskId}.log`), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      /* logging must never break a run */
    }
  }

  private isQueuedOrActive(key: string): boolean {
    return this.active.has(key) || this.queue.some((j) => jobKey(j) === key);
  }

  enqueue(job: Job, front = false): boolean {
    const key = jobKey(job);
    if (this.isQueuedOrActive(key)) {
      // Merge new replies into an already queued resume.
      if (job.kind === 'resume') {
        const q = this.queue.find((j) => jobKey(j) === key && j.kind === 'resume') as Extract<Job, { kind: 'resume' }> | undefined;
        if (q) for (const r of job.replies) if (!q.replies.some((x) => x.id === r.id)) q.replies.push(r);
      }
      return false;
    }
    if (front) this.queue.unshift(job);
    else this.queue.push(job);
    return true;
  }

  /** Re-claim runs that were active when the runner died. */
  recover(): void {
    for (const rec of Object.values(this.state.runs.runs)) {
      if (rec.phase === 'running') this.enqueue({ kind: 'work', taskId: rec.taskId });
    }
  }

  /**
   * B7: a 401 from inbox, heartbeat or claim means the key no longer works.
   * Abort every job without posting anything (no fail, no usage) and stop.
   */
  authFailed(where: string): void {
    if (this.fatal) return;
    this.fatal = 'unauthorized';
    this.stopped = true;
    this.log(`${where}: 401 from the hub; stopping`);
    this.queue.length = 0;
    for (const a of this.active.values()) {
      a.reason = 'auth';
      a.controller.abort();
    }
    this.wake?.();
  }

  /** One poll cycle. */
  async tick(): Promise<void> {
    let inbox;
    try {
      inbox = await this.o.client.inbox();
    } catch (e) {
      if (is401(e)) return this.authFailed('inbox');
      throw e;
    }
    await this.checkActive();
    await this.prune();
    if (!this.me || inbox.tasks_to_me.length) this.me = await this.o.client.me();
    const me = this.me;

    // New tasks.
    const blocked = budgetBlocked(me);
    const now = Date.now();
    for (const t of inbox.tasks_to_me) {
      if (this.isQueuedOrActive(`task:${t.id}`)) continue;
      const sentAt = Date.parse(String(t.created ?? '').replace(' ', 'T'));
      if (this.o.claimDelayMs && sentAt && now - sentAt < this.o.claimDelayMs) continue;
      if (blocked) {
        await this.notifyBudget(t, me);
        continue;
      }
      this.enqueue({ kind: 'work', taskId: t.id });
    }

    // Replies for parked runs.
    const byTask = new Map<string, Message[]>();
    for (const m of [...inbox.answers_to_me, ...inbox.decisions_for_me, ...(inbox.notes_for_me ?? [])]) {
      const rec = this.state.get(m.task);
      if (!rec || rec.phase !== 'parked' || rec.seen.includes(m.id)) continue;
      if (!byTask.has(m.task)) byTask.set(m.task, []);
      byTask.get(m.task)!.push(m);
    }
    for (const [taskId, replies] of byTask) this.enqueue({ kind: 'resume', taskId, replies });

    // Questions addressed to me.
    for (const q of inbox.questions_to_me) {
      if (this.state.runs.handledQuestions[q.id]) continue;
      // P1: a task I am working interactively: my own session answers its questions.
      const ti = (q as any).task_info as Task | undefined;
      if (ti && ti.claim_mode === 'interactive' && ti.to_agent === me.id) continue;
      this.enqueue({ kind: 'answer', taskId: q.task, question: q });
    }

    // @mentions in channel posts wake a read-only mention run.
    if (this.o.client.mentionRun) {
      for (const m of inbox.mentions_for_me ?? []) this.enqueue({ kind: 'mention', item: m });
    }
    this.pump();
  }

  private async notifyBudget(t: Task, me: Agent): Promise<void> {
    if (this.state.runs.budgetNotified[t.id]) return;
    try {
      await this.o.client.postMessage(t.id, {
        kind: 'decision_request',
        topic: 'budget',
        body: `Budget reached for agent ${me.name}: spent $${Number(me.spent_usd ?? 0).toFixed(2)} of $${Number(me.budget_usd).toFixed(2)}. The task was not started. An admin must raise the budget (this decision is informational).`,
      });
    } catch (e: any) {
      this.log(`budget notice for ${t.id} failed: ${e?.message ?? e}`);
    }
    this.state.runs.budgetNotified[t.id] = new Date().toISOString();
    this.state.saveRuns();
  }

  /**
   * Cancel running jobs whose task went terminal; forget parked runs of
   * terminal tasks; keep parked leases alive; and (C1) resume a parked run
   * whose task is back to `working` with nothing left to wait for.
   */
  async checkActive(): Promise<void> {
    for (const a of this.active.values()) {
      if (a.job.kind === 'answer' || a.job.kind === 'mention') continue;
      try {
        const { task } = await this.o.client.getTask(a.job.taskId);
        // Only a cancel (sender / human) stops a run. completed / failed come from
        // the worker itself (usually the agent's own `ach complete`); aborting then
        // would drop the turn's usage, which Codex reports only at turn end.
        // The run token is already revoked and the idle watchdog still applies.
        if (task.status === 'canceled' && !a.reason) {
          a.reason = 'cancel';
          this.taskLog(a.job.taskId, `task is ${task.status}; aborting run`);
          a.controller.abort();
        }
        // A handoff update does not interrupt a running worker (that would drop
        // the turn's usage): its `ach complete` carries ACH_HANDOFF_VERSION and
        // the hub refuses an outdated one, and afterWork resumes on the new version.
      } catch (e: any) {
        this.log(`status check ${a.job.taskId}: ${e?.message ?? e}`);
      }
    }
    const now = Date.now();
    for (const rec of Object.values(this.state.runs.runs)) {
      if (rec.phase !== 'parked' || this.isQueuedOrActive(`task:${rec.taskId}`)) continue;
      try {
        const bundle = await this.o.client.getTask(rec.taskId);
        const task = bundle.task;
        if (isTerminal(task.status)) {
          this.state.drop(rec.taskId);
          continue;
        }
        // A parked run still holds the claim lease: keep it alive so the
        // hub's lease cron cannot hand the task to another run between an answer
        // arriving and the resume starting. If the runner dies, heartbeats stop.
        if (task.run_id === rec.runId && now - (this.parkedHb.get(rec.taskId) ?? 0) >= this.o.heartbeatMs) {
          this.parkedHb.set(rec.taskId, now);
          await this.heartbeat(rec).catch((e) => this.log(`heartbeat ${rec.taskId}: ${e?.message ?? e}`));
        }
        const me0 = await this.ensureMe();
        // A new handoff version reaches a parked worker at once, even while it
        // waits for an answer: the change may settle or replace its question.
        // Not while the S1 gate waits for the owner: the full prompt shown when
        // it opens carries the current handoff anyway.
        if (!rec.gate && (task.handoff_version ?? 0) > (rec.handoffVersion ?? 0)) {
          this.enqueue({ kind: 'resume', taskId: rec.taskId, replies: unseenReplies(bundle.messages, me0.id, rec.seen) });
          continue;
        }
        if (task.status === 'working') {
          const me = me0;
          if (!openRequests(bundle.messages, me.id).length) {
            this.enqueue({ kind: 'resume', taskId: rec.taskId, replies: unseenReplies(bundle.messages, me.id, rec.seen) });
          }
        }
      } catch (e: any) {
        if (e instanceof HubError && (e.status === 404 || e.status === 403)) this.state.drop(rec.taskId);
      }
    }
  }

  /** Heartbeat a run; adopt a refreshed run token (C5). Throws HubError 409 when the run lost the task. */
  private async heartbeat(rec: RunRecord): Promise<void> {
    let r;
    try {
      r = await this.o.client.heartbeat(rec.taskId, rec.runId);
    } catch (e) {
      if (is401(e)) this.authFailed(`heartbeat ${rec.taskId}`);
      throw e;
    }
    if (r?.run_token) {
      rec.runToken = r.run_token;
      rec.tokenAt = Date.now();
      if (this.state.get(rec.taskId)) this.state.put(rec);
      this.taskLog(rec.taskId, 'run token refreshed by heartbeat');
    }
  }

  /** C8: drop runs.json bookkeeping for terminal (or vanished) tasks, every 10 minutes. */
  async prune(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    const dead: string[] = [];
    for (const id of this.state.bookkeepingTasks()) {
      if (this.state.get(id)) continue;
      try {
        const { task } = await this.o.client.getTask(id);
        if (isTerminal(task.status)) dead.push(id);
      } catch (e) {
        if (e instanceof HubError && (e.status === 404 || e.status === 403)) dead.push(id);
      }
    }
    // Entries from older versions carry no task id: expire them after a week.
    for (const [q, v] of Object.entries(this.state.runs.handledQuestions)) {
      if (typeof v === 'string' && now - Date.parse(v) > 7 * 86_400_000) delete this.state.runs.handledQuestions[q];
    }
    this.state.pruneTasks(dead);
    for (const id of dead) rmSync(this.filesDir(id), { recursive: true, force: true });
  }

  pump(): void {
    while (!this.stopped && this.active.size < this.o.max && this.queue.length) {
      const job = this.queue.shift()!;
      const controller = new AbortController();
      const entry: Active = { job, controller, done: Promise.resolve() };
      this.active.set(jobKey(job), entry);
      entry.done = this.runJob(job, entry)
        .catch((e) => this.log(`job ${jobKey(job)} crashed: ${e?.stack ?? e}`))
        .finally(() => {
          this.active.delete(jobKey(job));
          if (entry.followUp && !this.stopped) this.enqueue(entry.followUp, true);
          this.pump();
          if (!this.active.size && !this.queue.length) this.waiters.splice(0).forEach((w) => w());
        });
    }
  }

  /** Resolves when nothing is queued or running (tests). */
  async drain(): Promise<void> {
    if (!this.active.size && !this.queue.length) return;
    await new Promise<void>((r) => this.waiters.push(r));
  }

  private async runJob(job: Job, entry: Active): Promise<void> {
    if (job.kind === 'work') return this.runWork(job.taskId, entry);
    if (job.kind === 'resume') return this.runResume(job.taskId, job.replies, entry, job.nudge);
    if (job.kind === 'mention') return this.runMention(job.item, entry);
    return this.runAnswer(job.question, entry);
  }

  private async ensureMe(): Promise<Agent> {
    if (!this.me) this.me = await this.o.client.me();
    return this.me;
  }

  private async runWork(taskId: string, entry: Active): Promise<void> {
    const me = await this.ensureMe();
    const prev = this.state.get(taskId);
    const runId = prev?.runId ?? (this.o.newRunId ?? newRunId)();
    let claim;
    try {
      claim = await this.o.client.claim(taskId, runId);
    } catch (e) {
      if (is401(e)) return this.authFailed(`claim ${taskId}`);
      if (e instanceof HubError && e.code === 'budget_exceeded') {
        this.me = await this.o.client.me();
        const t = (await this.o.client.getTask(taskId)).task;
        await this.notifyBudget(t, this.me);
        return;
      }
      if (is409(e)) {
        this.log(`claim ${taskId}: taken by another run, skipping`);
        this.state.drop(taskId);
        return;
      }
      throw e;
    }
    // C2: a workspace that cannot be prepared fails the task instead of
    // leaving it claimed (and re-claimed after every lease expiry).
    let workdir: string;
    let sensitive: string[] = [];
    let readRepos: ReadRepo[] = [];
    try {
      // Other repos first: an unknown repo name fails the task before any worktree exists.
      readRepos = (await this.o.workspace.readRepos?.(claim.task)) ?? [];
      workdir = await this.o.workspace.prepare(claim.task, me.name);
      sensitive = (await this.o.workspace.sensitiveChanges?.(claim.task)) ?? [];
    } catch (e: any) {
      const reason = `workspace: ${e?.message ?? e}`;
      this.taskLog(taskId, `prepare failed: ${reason}`);
      await this.o.client.fail(taskId, reason, runId).catch((x) => this.log(`fail ${taskId}: ${x?.message ?? x}`));
      this.state.drop(taskId);
      return;
    }
    const rec: RunRecord = {
      taskId,
      runId,
      phase: 'running',
      workdir,
      runToken: claim.run_token,
      tokenAt: Date.now(),
      handoffVersion: claim.task.handoff_version,
      seen: Array.from(new Set([...(prev?.seen ?? []), ...claim.messages.map((m) => m.id)])),
      ...(prev?.gate ? { gate: prev.gate } : {}),
      ...(readRepos.length ? { readRepos } : {}),
    };
    this.state.put(rec);
    this.taskLog(taskId, `claimed run_id=${runId} workdir=${workdir}`);
    // S1: a sender-chosen base that adds or changes agent config needs the
    // worker owner's approval before any agent runs in that directory.
    if (sensitive.length && !rec.gate) {
      const m = await this.o.client.postMessage(taskId, {
        kind: 'decision_request',
        topic: 'sensitive_base',
        body:
          `links.base adds or changes agent configuration that the agent would load: ${sensitive.join(', ')}. ` +
          'Reply "approve" to run the agent in this worktree anyway, or anything else to fail the task.',
      });
      rec.gate = { requestId: m.id, files: sensitive };
      rec.phase = 'parked';
      rec.seen = Array.from(new Set([...rec.seen, m.id]));
      this.state.put(rec);
      this.taskLog(taskId, `gated on owner approval for ${sensitive.join(', ')}`);
      return;
    }
    if (rec.gate) {
      rec.phase = 'parked';
      this.state.put(rec);
      return;
    }
    const files = await this.fetchFiles(taskId, claim);
    rec.files = files.map((f) => f.key);
    this.state.put(rec);
    const prompt = buildTaskPrompt({
      agentName: me.name,
      ownerName: me.owner_name,
      senderName: claim.task.from_agent_name,
      task: claim.task,
      handoff: claim.handoff,
      messages: claim.messages,
      taskUrl: this.linkOf(claim.task),
      readRepos: rec.readRepos?.map((r) => ({ name: r.name, path: r.path })),
      files: files.map(promptFile),
      channel: await this.channelContext(claim.task),
      wiki: claim.wiki,
    });
    this.reportPromptSize(taskId, rec.runId, prompt);
    const sess = this.state.session(taskId, 'work');
    const resume = sess && sess.cwd === workdir ? sess.id : undefined;
    const result = await this.execute(rec, entry, prompt, resume, 'work');
    await this.afterWork(rec, entry, result, claim.task);
  }

  private async runResume(taskId: string, replies: Message[], entry: Active, nudge?: boolean): Promise<void> {
    const me = await this.ensureMe();
    const rec = this.state.get(taskId);
    if (!rec) return;
    const bundle = await this.o.client.getTask(taskId);
    if (isTerminal(bundle.task.status)) {
      this.state.drop(taskId);
      return;
    }
    // Lease lost while parked (runner was down): re-claim with the same run_id.
    const leaseLost = bundle.task.status === 'submitted' || (bundle.task.run_id ?? '') !== rec.runId;
    if (leaseLost || Date.now() - rec.tokenAt > TOKEN_REFRESH_MS) {
      try {
        const c = await this.o.client.claim(taskId, rec.runId);
        rec.runToken = c.run_token;
        rec.tokenAt = Date.now();
      } catch (e: any) {
        this.log(`${leaseLost ? 're-claim' : 'token refresh'} ${taskId}: ${e?.message ?? e}`);
        if (leaseLost) {
          if (is409(e)) this.state.drop(taskId);
          return;
        }
      }
    }
    let fresh = replies.filter((r) => !rec.seen.includes(r.id));
    for (const r of unseenReplies(bundle.messages, me.id, rec.seen)) if (!fresh.some((x) => x.id === r.id)) fresh.push(r);
    let fullPrompt = false;
    if (rec.gate) {
      const gate = rec.gate;
      const decision = bundle.messages.find((m) => m.kind === 'decision' && m.author_type === 'human' && m.reply_to === gate.requestId);
      if (!decision) {
        // Notes that arrive meanwhile are shown with the full task prompt once the gate opens.
        rec.seen = Array.from(new Set([...rec.seen, ...fresh.map((r) => r.id)]));
        this.state.put(rec);
        return; // still waiting for the owner
      }
      if (!approves(decision.body)) {
        this.taskLog(taskId, 'owner rejected the gated base');
        await this.o.client
          .fail(taskId, `owner did not approve agent-config changes in links.base (${gate.files.join(', ')}): ${decision.body}`, rec.runId)
          .catch((x) => this.log(`fail ${taskId}: ${x?.message ?? x}`));
        this.state.drop(taskId);
        return;
      }
      rec.gate = undefined;
      fullPrompt = true;
      fresh = fresh.filter((r) => r.id !== decision.id);
      rec.seen.push(decision.id);
    }
    const handoffChanged =
      (bundle.task.handoff_version ?? 0) > (rec.handoffVersion ?? 0) ? bundle.handoff : undefined;
    rec.seen = Array.from(new Set([...rec.seen, ...fresh.map((r) => r.id)]));
    rec.handoffVersion = bundle.task.handoff_version ?? rec.handoffVersion;
    // New work (a new handoff or new replies) earns a fresh nudge if it stops silently again.
    if (!nudge && (handoffChanged !== undefined || fresh.length)) rec.nudged = false;
    rec.phase = 'running';
    const files = await this.fetchFiles(taskId, bundle);
    const shown = new Set(rec.files ?? []);
    rec.files = files.map((f) => f.key);
    this.state.put(rec);
    const sess = this.state.session(taskId, 'work');
    const resume = !fullPrompt && sess && sess.cwd === rec.workdir ? sess.id : undefined;
    const prompt = resume
      ? buildResumePrompt({
          task: bundle.task,
          replies: fresh,
          handoffVersion: bundle.task.handoff_version,
          handoffChanged,
          files: files.filter((f) => !shown.has(f.key)).map(promptFile),
          nudge,
        })
      : buildTaskPrompt({
          agentName: me.name,
          ownerName: me.owner_name,
          senderName: bundle.task.from_agent_name,
          task: bundle.task,
          handoff: bundle.handoff,
          messages: bundle.messages,
          taskUrl: this.linkOf(bundle.task),
          readRepos: rec.readRepos?.map((r) => ({ name: r.name, path: r.path })),
          files: files.map(promptFile),
          channel: await this.channelContext(bundle.task),
          wiki: bundle.wiki,
        });
    if (!resume) this.reportPromptSize(taskId, rec.runId, prompt);
    this.taskLog(taskId, `resume with ${fresh.length} replies (session ${resume ?? 'new'})`);
    const result = await this.execute(rec, entry, prompt, resume, 'work');
    await this.afterWork(rec, entry, result, bundle.task);
  }

  /** S10: the agent cannot write .git, so the runner commits its changes after every work run. */
  private async commitWork(rec: RunRecord, task: Task): Promise<void> {
    if (!this.o.workspace.commit) return;
    try {
      const sha = await this.o.workspace.commit(rec.taskId, `ach: ${task.title ?? rec.taskId} (task ${rec.taskId})`.slice(0, 200));
      if (sha) this.taskLog(rec.taskId, `runner committed ${sha}`);
    } catch (e: any) {
      this.taskLog(rec.taskId, `commit failed: ${e?.message ?? e}`);
    }
  }

  private async afterWork(rec: RunRecord, entry: Active, result: AdapterResult, task0: Task): Promise<void> {
    const { client } = this.o;
    const taskId = rec.taskId;
    const me = await this.ensureMe();
    if (entry.reason === 'auth' || this.fatal) return; // B7: post nothing
    await this.commitWork(rec, task0);
    if (entry.reason === 'cancel' || entry.reason === 'stop' || entry.reason === 'lost') {
      if (entry.reason !== 'stop') this.state.drop(taskId);
      return;
    }
    if (entry.reason === 'idle') {
      await client.fail(taskId, 'idle timeout', rec.runId).catch((e) => this.log(`fail ${taskId}: ${e?.message ?? e}`));
      this.state.drop(taskId);
      return;
    }
    const bundle = await client.getTask(taskId);
    const task = bundle.task;
    if (isTerminal(task.status)) {
      this.taskLog(taskId, `run ended; task already ${task.status}`);
      this.state.drop(taskId);
      return;
    }
    // C3: never finish a task another run now owns.
    if ((task.run_id ?? '') !== rec.runId) {
      this.taskLog(taskId, `run ended but the task now belongs to run ${task.run_id || '(none)'}; leaving it`);
      this.state.drop(taskId);
      return;
    }
    const open = openRequests(bundle.messages, me.id);
    if (task.status === 'input-required' || open.length) {
      rec.phase = 'parked';
      this.state.put(rec);
      this.taskLog(taskId, `parked: ${open.length} open request(s), status ${task.status}`);
      return;
    }
    // Replies that arrived while the run was still going: resume instead of completing.
    const unseen = unseenReplies(bundle.messages, me.id, rec.seen);
    if (unseen.length && task.status === 'working') {
      rec.phase = 'parked';
      this.state.put(rec);
      entry.followUp = { kind: 'resume', taskId, replies: unseen };
      return;
    }
    // The sender replaced the handoff (the run was interrupted for it, or it
    // arrived just as the run ended): resume with the new version, never finish on the old one.
    if (task.status === 'working' && (task.handoff_version ?? 0) > (rec.handoffVersion ?? 0)) {
      rec.phase = 'parked';
      this.state.put(rec);
      entry.followUp = { kind: 'resume', taskId, replies: [] };
      return;
    }
    if (!result.ok) {
      await client.fail(taskId, `runtime error: ${result.error ?? 'unknown'}`, rec.runId).catch((e) => this.log(`fail ${taskId}: ${e?.message ?? e}`));
      this.state.drop(taskId);
      return;
    }
    if (task.status === 'working') {
      // The agent stopped without `ach complete`, `ach fail` or a question. That
      // is not a finished task: ask it once to finish properly; if it stops
      // silently again, fail the task with its last output so the sender sees
      // what happened (it was recorded as completed before).
      if (!rec.nudged) {
        rec.nudged = true;
        rec.phase = 'parked';
        this.state.put(rec);
        this.taskLog(taskId, 'the agent stopped without completing; asking it once to finish');
        entry.followUp = { kind: 'resume', taskId, replies: [], nudge: true };
        return;
      }
      const last = result.finalText?.trim().slice(0, 4000) || '(no output)';
      await client
        .fail(taskId, `the agent stopped twice without calling ach complete or ach fail. Its last output:\n${last}`, rec.runId)
        .catch((e) => this.log(`fail ${taskId}: ${e?.message ?? e}`));
      this.taskLog(taskId, 'failed: the agent stopped twice without completing');
    }
    this.state.drop(taskId);
  }

  /** Base URL for links shown to agents. */
  private base(): string {
    return this.o.publicUrl || this.o.hub;
  }

  /** The task's absolute permalink: the hub's (ACH_PUBLIC_URL on the hub), else built here. */
  private linkOf(t: Task): string {
    if (!this.o.publicUrl && typeof t.url === 'string' && /^https?:\/\//.test(t.url)) return t.url;
    return taskUrl(this.base(), refOf(t));
  }

  /** Memory trial metrics: the total size of a full work prompt (best effort, never blocks the run). */
  private reportPromptSize(taskId: string, runId: string, prompt: string): void {
    if (!this.o.client.promptSize) return;
    this.o.client.promptSize(taskId, runId, prompt.length).catch((e: any) => this.taskLog(taskId, `prompt size: ${e?.message ?? e}`));
  }

  /** The latest posts of the task's channel (best effort). */
  private async channelContext(task: Task): Promise<ChannelContext | undefined> {
    const n = this.o.channelContext ?? 15;
    const name = typeof task.channel_name === 'string' ? task.channel_name : '';
    if (!n || !name || !this.o.client.channelPosts) return undefined;
    try {
      const r = await this.o.client.channelPosts(name, { limit: n });
      return { name, posts: r.posts ?? [] };
    } catch (e: any) {
      this.taskLog(task.id, `channel context: ${e?.message ?? e}`);
      return undefined;
    }
  }

  /**
   * Mention run: read-only, in --dir, with a run token that may only read
   * the channel and reply in this thread. The hub hands each mention out once.
   */
  private async runMention(item: MentionItem, entry: Active): Promise<void> {
    const me = await this.ensureMe();
    const client = this.o.client;
    const mid = item.mention.id;
    const runId = (this.o.newRunId ?? newRunId)();
    let run;
    try {
      run = await client.mentionRun!(mid, runId);
    } catch (e: any) {
      this.log(`mention-run ${mid}: ${e?.message ?? e}`);
      return;
    }
    const key = `mention-${mid}`;
    const threadId = run.thread.id;
    const rec: RunRecord = { taskId: key, runId, phase: 'running', workdir: this.o.dir, runToken: run.run_token, tokenAt: Date.now(), seen: [] };
    const structured = !!this.o.adapter.structuredAnswers;
    try {
      const prompt = buildMentionPrompt({
        agentName: me.name,
        ownerName: me.owner_name,
        channel: run.channel_name,
        mention: run.mention,
        post: run.post,
        thread: run.thread,
        replies: run.replies ?? [],
        recent: run.recent ?? [],
        threadUrl: !this.o.publicUrl && typeof run.thread.url === 'string' && /^https?:\/\//.test(run.thread.url) ? run.thread.url : postUrl(this.base(), threadId),
        structured,
      });
      const result = await this.execute(rec, entry, prompt, undefined, 'mention', structured ? ANSWER_SCHEMA : undefined, {
        threadId,
        usage: (cost, est) => client.mentionUsage!(mid, runId, cost, est),
      });
      if (structured && result.ok && !entry.reason) await this.postStructuredReply(threadId, run.run_token, result.finalText, key);
    } finally {
      if (!this.fatal) await client.mentionEnd?.(mid, runId).catch((e) => this.log(`mention-end ${mid}: ${e?.message ?? e}`));
    }
  }

  /** Codex mention runs: the runner posts the reply the agent returned. */
  private async postStructuredReply(threadId: string, token: string, text: string, logKey: string): Promise<void> {
    let out: { action?: string; text?: string; evidence?: string };
    try {
      out = JSON.parse(text.trim());
    } catch {
      this.taskLog(logKey, 'mention run returned no JSON; nothing posted');
      return;
    }
    const c = (this.o.tokenClient ?? ((t: string) => new HubClient({ hub: this.o.hub, token: t, cfId: this.o.cfId, cfSecret: this.o.cfSecret })))(token);
    try {
      if (out.action === 'answer' && String(out.text ?? '').trim() && String(out.evidence ?? '').trim()) {
        await c.reply(threadId, String(out.text), { evidence: String(out.evidence) });
      } else if (String(out.text ?? '').trim()) {
        await c.reply(threadId, String(out.text), { escalate: true });
      }
    } catch (e: any) {
      this.taskLog(logKey, `posting the reply failed: ${e?.message ?? e}`);
    }
  }

  private markHandled(q: Message): void {
    this.state.runs.handledQuestions[q.id] = { task: q.task, at: new Date().toISOString() };
    this.state.saveRuns();
  }

  private async runAnswer(q: Message, entry: Active): Promise<void> {
    const me = await this.ensureMe();
    const taskId = q.task;
    const runId = (this.o.newRunId ?? newRunId)();
    let token: string;
    try {
      token = (await this.o.client.answerRun(taskId, q.id, runId)).run_token;
    } catch (e: any) {
      // C4: transient errors (network, 5xx) leave the question unhandled so the
      // next poll retries; a hub refusal (4xx) is final.
      this.log(`answer-run ${q.id}: ${e?.message ?? e}`);
      if (e instanceof HubError && e.status >= 400 && e.status < 500) this.markHandled(q);
      return;
    }
    // C4: handled only once the token exists.
    this.markHandled(q);
    try {
      const bundle = await this.o.client.getTask(taskId);
      const cwd = this.state.get(taskId)?.workdir ?? this.o.dir;
      const rec: RunRecord = { taskId, runId, phase: 'running', workdir: cwd, runToken: token, tokenAt: Date.now(), seen: [] };
      const structured = !!this.o.adapter.structuredAnswers;
      const prompt = buildAnswerPrompt({
        agentName: me.name,
        ownerName: me.owner_name,
        task: bundle.task,
        handoff: bundle.handoff,
        messages: bundle.messages,
        question: q,
        structured,
        files: (await this.fetchFiles(taskId, bundle)).map(promptFile),
      });
      const sess = this.state.session(taskId, 'answer');
      const result = await this.execute(rec, entry, prompt, sess && sess.cwd === cwd ? sess.id : undefined, 'answer', structured ? ANSWER_SCHEMA : undefined);
      if (structured && result.ok && !entry.reason) await this.postStructuredAnswer(q, token, result.finalText);
    } finally {
      // C4: revoke the answer token as soon as the run ends.
      if (!this.fatal) await this.o.client.endRun(taskId, runId).catch((e) => this.log(`end-run ${taskId}: ${e?.message ?? e}`));
    }
  }

  /** Codex answer runs (S4): read-only and offline; the runner posts what the agent returned. */
  private async postStructuredAnswer(q: Message, token: string, text: string): Promise<void> {
    let out: { action?: string; text?: string; evidence?: string };
    try {
      out = JSON.parse(text.trim());
    } catch {
      this.taskLog(q.task, 'answer run returned no JSON; the question will escalate');
      return;
    }
    const c = (this.o.tokenClient ?? ((t: string) => new HubClient({ hub: this.o.hub, token: t, cfId: this.o.cfId, cfSecret: this.o.cfSecret })))(token);
    try {
      if (out.action === 'answer' && String(out.text ?? '').trim() && String(out.evidence ?? '').trim()) {
        await c.postMessage(q.task, { kind: 'answer', body: String(out.text), evidence: String(out.evidence), reply_to: q.id });
      } else if (String(out.text ?? '').trim()) {
        await c.postMessage(q.task, { kind: 'decision_request', body: String(out.text), reply_to: q.id });
      }
    } catch (e: any) {
      this.taskLog(q.task, `posting the answer failed: ${e?.message ?? e}`);
    }
  }

  /** Readable roots for the spawned agent besides its cwd (S4). */
  private readRoots(cwd: string, readRepos: ReadRepo[] = [], taskId?: string): string[] {
    const home = (this.o.baseEnv ?? process.env).HOME;
    return [
      ...toolchainReadRoots(home || undefined),
      ...gitCommonDir(cwd),
      join(this.o.home, 'bin'),
      ...readRepos.flatMap((r) => r.roots),
      ...(taskId ? [this.filesDir(taskId)] : []),
    ];
  }

  /** Where a task's attachments are downloaded for its agents (readable, outside the worktree). */
  filesDir(taskId: string): string {
    return join(this.o.home, 'files', taskId.replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  /** The task's attachments, downloaded into filesDir (best effort: a failed download is listed without a path). */
  private async fetchFiles(taskId: string, bundle: TaskBundle): Promise<(PromptFile & { key: string })[]> {
    const out: (PromptFile & { key: string })[] = [];
    for (const f of taskFiles(bundle)) {
      let path: string | undefined;
      if (this.o.client.download) {
        try {
          path = await this.o.client.download(f, this.filesDir(taskId));
        } catch (e: any) {
          this.taskLog(taskId, `download ${f.name} failed: ${e?.message ?? e}`);
        }
      }
      out.push({ key: f.url, name: f.original, type: f.type, size: f.size, from: f.from, ...(path ? { path } : {}) });
    }
    return out;
  }

  /** Run the adapter with heartbeat, idle watchdog, session persistence and usage posting. */
  private async execute(
    rec: RunRecord,
    entry: Active,
    prompt: string,
    resume: string | undefined,
    mode: RunMode,
    outputSchema?: unknown,
    extra: { threadId?: string; usage?: (cost: number, estimated: boolean) => Promise<unknown> } = {},
  ): Promise<AdapterResult> {
    const { client } = this.o;
    const me = await this.ensureMe();
    const taskId = rec.taskId;
    const perm: Perm = mode === 'work' ? effectivePerm(me.perm_level, this.o.perm) : 'read';
    const env = buildAgentEnv(this.o.baseEnv ?? process.env, {
      hub: this.o.hub,
      runToken: rec.runToken,
      taskId: mode === 'mention' ? '' : taskId,
      agentName: me.name,
      threadId: extra.threadId,
      handoffVersion: mode === 'work' ? rec.handoffVersion : undefined,
      publicUrl: this.o.publicUrl,
      cfId: this.o.cfId,
      cfSecret: this.o.cfSecret,
      passEnv: this.o.passEnv,
    });
    // B1: HOME is a per-task scratch dir (never the runner's own home).
    const baseEnv = this.o.baseEnv ?? process.env;
    const realHome = baseEnv.HOME || undefined;
    Object.assign(env, prepareAgentHome(this.o.agentHomesDir ?? join(tmpdir(), 'ach-homes'), me.name, taskId, realHome, baseEnv.CODEX_HOME || undefined).env);
    // C6: heartbeats are not activity. The watchdog fires after idleMs without
    // adapter events, unless a tool call is still in flight.
    let lastEvent = Date.now();
    const inflight = new Set<string>();
    const hb =
      mode === 'work'
        ? setInterval(() => {
            this.heartbeat(rec).catch((e) => {
              this.log(`heartbeat ${taskId}: ${e?.message ?? e}`);
              // C3: 409 = this run no longer owns the task; stop working on it.
              // Except when the task is completed / failed: that is the agent's own
              // `ach complete` / `ach fail`; let the turn end so its usage is recorded.
              const st = e instanceof HubError ? String((e.body as any)?.status ?? '') : '';
              if (is409(e) && !entry.reason && st !== 'completed' && st !== 'failed') {
                entry.reason = 'lost';
                this.taskLog(taskId, 'heartbeat 409: run lost the task; aborting');
                entry.controller.abort();
              }
            });
          }, this.o.heartbeatMs)
        : undefined;
    const idle = setInterval(() => {
      if (!inflight.size && Date.now() - lastEvent > this.o.idleMs && !entry.reason) {
        entry.reason = 'idle';
        this.taskLog(taskId, 'idle timeout; aborting');
        entry.controller.abort();
      }
    }, Math.max(10, Math.min(60_000, Math.floor(this.o.idleMs / 4))));
    this.taskLog(taskId, `${mode} run start perm=${perm} resume=${resume ?? '-'} cwd=${rec.workdir}`);
    let result: AdapterResult;
    try {
      result = await this.o.adapter.run({
        prompt,
        cwd: rec.workdir,
        resume,
        perm,
        mode,
        env,
        signal: entry.controller.signal,
        hub: this.o.hub,
        denyReadPaths: secretPaths(this.o.home),
        ...(realHome ? { realHome } : {}),
        achHome: this.o.home,
        readRoots: this.readRoots(rec.workdir, rec.readRepos, rec.taskId),
        ...(Array.isArray(me.net_allow) ? { netAllow: me.net_allow } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        onEvent: (e) => {
          lastEvent = Date.now();
          const id = e.data && typeof e.data === 'object' ? String((e.data as any).id ?? '') : '';
          if (e.type === 'tool_start' && id) inflight.add(id);
          if (e.type === 'tool_end' && id) inflight.delete(id);
          if (e.type === 'session' && e.data && mode !== 'mention') {
            this.state.setSession(taskId, mode, { id: String(e.data), cwd: rec.workdir });
          }
          this.taskLog(taskId, `${e.type} ${typeof e.data === 'string' ? e.data.slice(0, 500) : JSON.stringify(e.data)?.slice(0, 500)}`);
        },
      });
    } catch (e: any) {
      result = { finalText: '', ok: false, error: String(e?.message ?? e) };
    } finally {
      if (hb) clearInterval(hb);
      clearInterval(idle);
    }
    if (result.sessionId && mode !== 'mention') this.state.setSession(taskId, mode, { id: result.sessionId, cwd: rec.workdir });
    // Usage after every adapter run, success or failure.
    const usage = extra.usage ?? ((cost: number, est: boolean) => client.usage(taskId, rec.runId, cost, est));
    if (!this.fatal) await usage(Number(result.costUsd ?? 0), !!result.estimated).catch((e) => this.log(`usage ${taskId}: ${e?.message ?? e}`));
    this.taskLog(taskId, `${mode} run end ok=${result.ok} cost=${result.costUsd ?? 0} err=${result.error ?? ''}`);
    return result;
  }

  /** Polls until stop() or a 401 (B7: resolves 'unauthorized' after aborting every job). */
  async start(): Promise<'stopped' | 'unauthorized'> {
    this.recover();
    this.pump();
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (e: any) {
        this.log(`poll: ${e?.message ?? e}`);
      }
      if (this.stopped) break;
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.o.intervalMs);
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
    if (this.fatal) {
      await Promise.all([...this.active.values()].map((a) => a.done));
      return 'unauthorized';
    }
    return 'stopped';
  }

  /** Stop polling; abort running jobs without failing their tasks (they resume on restart). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const a of this.active.values()) {
      a.reason = a.reason ?? 'stop';
      a.controller.abort();
    }
    await Promise.all([...this.active.values()].map((a) => a.done));
  }
}

/** `ach run --gc`: remove work dirs of tasks terminal for more than `days` (branches are kept). */
export async function gcWorktrees(
  client: Pick<Client, 'getTask'>,
  ws: Workspace,
  o: { days?: number; now?: number; log?: (s: string) => void } = {},
): Promise<string[]> {
  const cutoff = (o.now ?? Date.now()) - (o.days ?? 7) * 86_400_000;
  const removed: string[] = [];
  for (const id of ws.list()) {
    try {
      const { task } = await client.getTask(id);
      if (!isTerminal(task.status)) continue;
      const when = Date.parse(String(task.updated ?? '').replace(' ', 'T')) || ws.mtime(id);
      if (when > cutoff) continue;
      await ws.remove(id);
      removed.push(id);
    } catch (e: any) {
      o.log?.(`gc ${id}: ${e?.message ?? e}`);
    }
  }
  return removed;
}

function promptFile(f: PromptFile & { key: string }): PromptFile {
  const { key: _key, ...rest } = f;
  return rest;
}
