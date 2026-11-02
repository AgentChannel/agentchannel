import { join } from 'node:path';
import { readJson, writeJsonPrivate } from '../config.js';

export interface RunRecord {
  taskId: string;
  runId: string;
  phase: 'running' | 'parked';
  workdir: string;
  runToken: string;
  tokenAt: number;
  handoffVersion?: number;
  /** The agent stopped once without finishing and was asked to finish (runner afterWork). */
  nudged?: boolean;
  /** Message ids the worker has already been shown. */
  seen: string[];
  /** S1: waiting for the worker owner to approve agent-config changes in links.base. */
  gate?: { requestId: string; files: string[] };
  /** Cross-repo: other repos readable for this task (links.repos). */
  readRepos?: ReadRepo[];
  /** Attachment URLs the worker has already been shown. */
  files?: string[];
}

/** A read-only repo of a cross-repo task: shown to the agent at `path`; `roots` are made readable. */
export interface ReadRepo {
  name: string;
  path: string;
  roots: string[];
}

export interface RunsFile {
  runs: Record<string, RunRecord>;
  /** Question ids we already ran (or permanently skipped) an answer run for, with their task. */
  handledQuestions: Record<string, { task: string; at: string } | string>;
  /** Tasks that already got the one budget decision_request. */
  budgetNotified: Record<string, string>;
}

export interface SessionRef {
  id: string;
  cwd: string;
}
export interface SessionsFile {
  [taskId: string]: { work?: SessionRef; answer?: SessionRef };
}

/** Persisted runner state: runs.json and sessions.json, both mode 0600. */
export class RunnerState {
  readonly runsPath: string;
  readonly sessionsPath: string;
  runs: RunsFile;
  sessions: SessionsFile;

  constructor(readonly home: string) {
    this.runsPath = join(home, 'runs.json');
    this.sessionsPath = join(home, 'sessions.json');
    const r = readJson<Partial<RunsFile>>(this.runsPath, {});
    this.runs = { runs: r.runs ?? {}, handledQuestions: r.handledQuestions ?? {}, budgetNotified: r.budgetNotified ?? {} };
    this.sessions = readJson<SessionsFile>(this.sessionsPath, {});
  }

  saveRuns(): void {
    writeJsonPrivate(this.runsPath, this.runs);
  }
  saveSessions(): void {
    writeJsonPrivate(this.sessionsPath, this.sessions);
  }

  get(taskId: string): RunRecord | undefined {
    return this.runs.runs[taskId];
  }
  put(rec: RunRecord): void {
    this.runs.runs[rec.taskId] = rec;
    this.saveRuns();
  }
  drop(taskId: string): void {
    if (this.runs.runs[taskId]) {
      delete this.runs.runs[taskId];
      this.saveRuns();
    }
  }
  /** Task ids referenced by bookkeeping entries (handled questions, budget notices). */
  bookkeepingTasks(): string[] {
    const ids = new Set<string>(Object.keys(this.runs.budgetNotified));
    for (const v of Object.values(this.runs.handledQuestions)) if (typeof v === 'object' && v?.task) ids.add(v.task);
    return [...ids];
  }
  /** C8: forget bookkeeping (and sessions) of tasks that are terminal or gone. */
  pruneTasks(taskIds: string[]): void {
    if (!taskIds.length) return;
    const drop = new Set(taskIds);
    for (const id of taskIds) {
      delete this.runs.budgetNotified[id];
      delete this.runs.runs[id];
    }
    for (const [q, v] of Object.entries(this.runs.handledQuestions)) {
      if (typeof v === 'object' && drop.has(v.task)) delete this.runs.handledQuestions[q];
    }
    this.saveRuns();
    let sessions = false;
    for (const id of taskIds) {
      if (this.sessions[id]) {
        delete this.sessions[id];
        sessions = true;
      }
    }
    if (sessions) this.saveSessions();
  }
  setSession(taskId: string, kind: 'work' | 'answer', ref: SessionRef): void {
    const cur = this.sessions[taskId] ?? {};
    if (cur[kind]?.id === ref.id && cur[kind]?.cwd === ref.cwd) return;
    cur[kind] = ref;
    this.sessions[taskId] = cur;
    this.saveSessions();
  }
  session(taskId: string, kind: 'work' | 'answer'): SessionRef | undefined {
    return this.sessions[taskId]?.[kind];
  }
}
