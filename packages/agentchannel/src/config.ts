import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { cfSecretPath, FileKeyStore, keyFilePath, openAdminSessionStore, openCfSecretStore, openKeyStore } from './keystore.js';

export interface FileConfig {
  hub?: string;
  /** Legacy: migrated into the key store on first read. */
  key?: string;
  /** Legacy: the `ach admin` session, moved to the admin-session store (B1) on first read. */
  admin_token?: string;
  admin_email?: string;
  /** Cloudflare Access service token (from `ach join`); env ACH_CF_ID / ACH_CF_SECRET win. */
  cf_id?: string;
  cf_secret?: string;
  /** P3: repo name -> local path for `ach run` (merged with --repo name=path). */
  repos?: Record<string, string>;
  /** `ach run` default: hold new tasks for INTERACTIVE_FIRST_DELAY_SEC so the owner can claim them first. */
  interactive_first?: boolean;
}

export interface Config {
  hub?: string;
  key?: string;
  runToken?: string;
  taskId?: string;
  agent?: string;
  cfId?: string;
  cfSecret?: string;
  adminToken?: string;
  repos?: Record<string, string>;
  interactiveFirst?: boolean;
}

/** Claim delay used by `ach run --interactive-first` (or "interactive_first": true in config.json). */
export const INTERACTIVE_FIRST_DELAY_SEC = 600;

/**
 * `ach run` claim delay in seconds: an explicit --claim-delay wins; else 600 with
 * --interactive-first (flag or config); else 0 (claim at once: nobody is
 * expected to work tasks interactively on this agent).
 */
export function resolveClaimDelay(o: { claimDelay?: number; interactiveFirst?: boolean }): number {
  if (o.claimDelay !== undefined) return o.claimDelay;
  return o.interactiveFirst ? INTERACTIVE_FIRST_DELAY_SEC : 0;
}

/**
 * Default home. v2 uses ~/.agentchannel-v2 so it never reads or writes the
 * ~/.agentchannel of an AgentChannel v0.9 (v1) install on the same machine.
 */
export const DEFAULT_HOME_DIR = '.agentchannel-v2';

/** Root dir for config and runner state. AGENTCHANNEL_HOME overrides (used by tests). */
export function achHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTCHANNEL_HOME || join(homedir(), DEFAULT_HOME_DIR);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(achHome(env), 'config.json');
}

/** Write JSON atomically with mode 0600 (dir 0700). */
export function writeJsonPrivate(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function readFileConfig(env: NodeJS.ProcessEnv = process.env): FileConfig {
  return readJson<FileConfig>(configPath(env), {});
}

export function writeFileConfig(cfg: FileConfig, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonPrivate(configPath(env), cfg);
}

/**
 * The agent key: OS keychain (or the 0600 agent-key fallback file). A key still
 * sitting in config.json from an older version is moved into the key store.
 */
export function loadAgentKey(env: NodeJS.ProcessEnv = process.env, file: FileConfig = readFileConfig(env)): string | undefined {
  const home = achHome(env);
  const store = openKeyStore(home, env);
  let key = store.get();
  if (!key && store.kind === 'keychain') key = new FileKeyStore(keyFilePath(home)).get();
  if (!key && file.key) {
    key = file.key;
    try {
      saveAgentKey(key, env);
    } catch {
      /* leave the legacy file alone if the store cannot be written */
    }
  }
  return key;
}

/** Store the agent key in the key store and make sure config.json no longer holds it. */
export function saveAgentKey(key: string, env: NodeJS.ProcessEnv = process.env): 'keychain' | 'file' {
  const store = openKeyStore(achHome(env), env);
  store.set(key);
  const file = readFileConfig(env);
  if (file.key !== undefined) {
    delete file.key;
    writeFileConfig(file, env);
  }
  return store.kind;
}

/**
 * The front-door service token secret: the key store (keychain or
 * <home>/cf-secret). A secret still in config.json (older joins) is moved there.
 */
export function loadCfSecret(env: NodeJS.ProcessEnv = process.env, file: FileConfig = readFileConfig(env)): string | undefined {
  const home = achHome(env);
  const store = openCfSecretStore(home, env);
  let v = store.get();
  if (!v && store.kind === 'keychain') v = new FileKeyStore(cfSecretPath(home)).get();
  if (!v && file.cf_secret) {
    v = file.cf_secret;
    try {
      saveCfSecret(v, env);
    } catch {
      /* leave the legacy file alone if the store cannot be written */
    }
  }
  return v;
}

/** Store the service token secret (or remove it: undefined) and drop any copy from config.json. */
export function saveCfSecret(secret: string | undefined, env: NodeJS.ProcessEnv = process.env): 'keychain' | 'file' {
  const store = openCfSecretStore(achHome(env), env);
  if (secret) store.set(secret);
  else store.delete();
  const file = readFileConfig(env);
  if (file.cf_secret !== undefined) {
    delete file.cf_secret;
    writeFileConfig(file, env);
  }
  return store.kind;
}

/** B1: the `ach admin` session token (keychain or <home>/admin-session; never config.json). */
export function loadAdminToken(env: NodeJS.ProcessEnv = process.env, file: FileConfig = readFileConfig(env)): string | undefined {
  const home = achHome(env);
  const store = openAdminSessionStore(home, env);
  let tok = store.get();
  if (!tok && file.admin_token) {
    tok = file.admin_token;
    try {
      saveAdminToken(tok, env);
    } catch {
      /* leave the legacy file alone if the store cannot be written */
    }
  }
  return tok;
}

/** Store the admin session and drop any copy from config.json. */
export function saveAdminToken(token: string, env: NodeJS.ProcessEnv = process.env, email?: string): 'keychain' | 'file' {
  const store = openAdminSessionStore(achHome(env), env);
  store.set(token);
  const file = readFileConfig(env);
  if (file.admin_token !== undefined || (email && file.admin_email !== email)) {
    delete file.admin_token;
    if (email) file.admin_email = email;
    writeFileConfig(file, env);
  }
  return store.kind;
}

/**
 * Effective config: env wins over the file. Inside a spawned agent (ACH_RUN_TOKEN
 * set) nothing is read from disk or the keychain: the run token and ACH_HUB are
 * the only credentials, so the agent key can never be loaded or re-pointed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const runToken = env.ACH_RUN_TOKEN || undefined;
  const common = {
    taskId: env.ACH_TASK_ID || undefined,
    agent: env.ACH_AGENT || undefined,
    cfId: env.ACH_CF_ID || undefined,
    cfSecret: env.ACH_CF_SECRET || undefined,
  };
  if (runToken) {
    return { hub: (env.ACH_HUB || '').replace(/\/+$/, '') || undefined, runToken, ...common };
  }
  const file = readFileConfig(env);
  return {
    hub: (env.ACH_HUB || file.hub || '').replace(/\/+$/, '') || undefined,
    key: env.ACH_KEY || loadAgentKey(env, file),
    ...common,
    cfId: common.cfId ?? (file.cf_id || undefined),
    cfSecret: common.cfSecret ?? (file.cf_id ? loadCfSecret(env, file) : undefined),
    adminToken: loadAdminToken(env, file),
    ...(file.repos && typeof file.repos === 'object' ? { repos: file.repos } : {}),
    ...(file.interactive_first === true ? { interactiveFirst: true } : {}),
  };
}
