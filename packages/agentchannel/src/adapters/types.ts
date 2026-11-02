import type { Perm } from '../perm.js';

/**
 * `tool_start` / `tool_end` (data: {id}) bracket one tool call; the runner's
 * idle watchdog is suspended while any call is in flight (C6).
 */
export type AdapterEventType = 'text' | 'tool' | 'tool_start' | 'tool_end' | 'session' | 'usage' | 'error';
export interface AdapterEvent {
  type: AdapterEventType;
  data: any;
}

export type RunMode = 'work' | 'answer' | 'mention';

export interface AdapterRunOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  perm: Perm;
  /** Work: the task's worker run; answer: a short read-only run answering one question; mention: a read-only run replying in a channel thread. */
  mode?: RunMode;
  env: Record<string, string>;
  signal: AbortSignal;
  onEvent: (e: AdapterEvent) => void;
  /** Hub base URL; used to allow network to the hub in sandboxed modes. */
  hub?: string;
  /**
   * B1: the runner's real $HOME. The spawned agent's env.HOME is a per-task
   * scratch dir, so path policies use this one.
   */
  realHome?: string;
  /** B1: the AgentChannel home (~/.agentchannel-v2): denied to the sandbox except the read roots under it. */
  achHome?: string;
  /** Paths the agent must never read (runner config / state with secrets). */
  denyReadPaths?: string[];
  /** Extra paths readable under $HOME besides cwd (toolchain, git common dir). See readRoots(). */
  readRoots?: string[];
  /**
   * P2: the agent's hub `net_allow` (domains the sandbox may reach; "*" = any).
   * The hub host is always added. Undefined = hub host + api.anthropic.com only.
   */
  netAllow?: string[];
  /** JSON schema the final message must follow (codex answer runs). */
  outputSchema?: unknown;
}

export interface AdapterResult {
  finalText: string;
  sessionId?: string;
  costUsd?: number;
  /** True when cost is estimated from tokens (codex). */
  estimated?: boolean;
  ok: boolean;
  error?: string;
}

export interface RuntimeAdapter {
  readonly name: string;
  /** True when answer runs return JSON (ANSWER_SCHEMA) and the runner posts it (codex). */
  readonly structuredAnswers?: boolean;
  run(opts: AdapterRunOptions): Promise<AdapterResult>;
}
