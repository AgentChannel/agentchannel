import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Where the agent key lives (S2). Default: the OS keychain via @napi-rs/keyring
 * (macOS Keychain, Windows Credential Manager, Linux Secret Service). When the
 * keychain is unavailable (e.g. Linux without a secret service) or
 * ACH_KEYSTORE=file is set, the key goes to <home>/agent-key with mode 0600.
 * The key is never written to config.json any more.
 */
export interface KeyStore {
  readonly kind: 'keychain' | 'file';
  get(): string | undefined;
  set(key: string): void;
  delete(): void;
}

export const KEYCHAIN_SERVICE = 'agentchannel';

export function keyFilePath(home: string): string {
  return join(home, 'agent-key');
}

export class FileKeyStore implements KeyStore {
  readonly kind = 'file' as const;
  constructor(readonly path: string) {}
  get(): string | undefined {
    try {
      const v = readFileSync(this.path, 'utf8').trim();
      return v || undefined;
    } catch {
      return undefined;
    }
  }
  set(key: string): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, key + '\n', { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
  delete(): void {
    rmSync(this.path, { force: true });
  }
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(p: string): void;
  deletePassword(): boolean;
}

export class KeychainKeyStore implements KeyStore {
  readonly kind = 'keychain' as const;
  constructor(private entry: KeyringEntry) {}
  get(): string | undefined {
    return this.entry.getPassword() ?? undefined;
  }
  set(key: string): void {
    this.entry.setPassword(key);
  }
  delete(): void {
    try {
      this.entry.deletePassword();
    } catch {
      /* already gone */
    }
  }
}

/** The keychain entry for this AGENTCHANNEL_HOME, or undefined if no usable keychain. */
export function openKeychain(home: string, account = `agent-key:${home}`): KeychainKeyStore | undefined {
  try {
    const req = createRequire(import.meta.url);
    const { Entry } = req('@napi-rs/keyring') as { Entry: new (service: string, account: string) => KeyringEntry };
    const entry = new Entry(KEYCHAIN_SERVICE, account);
    entry.getPassword(); // probe: throws when no credential store is reachable
    return new KeychainKeyStore(entry);
  } catch {
    return undefined;
  }
}

/** Keychain unless ACH_KEYSTORE=file or the keychain is unavailable. */
export function openKeyStore(home: string, env: NodeJS.ProcessEnv = process.env): KeyStore {
  if (env.ACH_KEYSTORE !== 'file') {
    const k = openKeychain(home);
    if (k) return k;
  }
  return new FileKeyStore(keyFilePath(home));
}

/**
 * B1: the human session of `ach admin` (a PocketBase user token). Kept out of
 * config.json: the OS keychain (account "admin-session:<home>"), else
 * <home>/admin-session (0600), a file the runner denies to spawned agents.
 */
export function adminSessionPath(home: string): string {
  return join(home, 'admin-session');
}

export function openAdminSessionStore(home: string, env: NodeJS.ProcessEnv = process.env): KeyStore {
  if (env.ACH_KEYSTORE !== 'file') {
    const k = openKeychain(home, `admin-session:${home}`);
    if (k) return k;
  }
  return new FileKeyStore(adminSessionPath(home));
}

/**
 * The secret half of the hub's front-door service token (from the `ach join`
 * line): OS keychain (account "cf-secret:<home>"), else <home>/cf-secret
 * (0600). The id stays in config.json; the secret never does.
 */
export function cfSecretPath(home: string): string {
  return join(home, 'cf-secret');
}

export function openCfSecretStore(home: string, env: NodeJS.ProcessEnv = process.env): KeyStore {
  if (env.ACH_KEYSTORE !== 'file') {
    const k = openKeychain(home, `cf-secret:${home}`);
    if (k) return k;
  }
  return new FileKeyStore(cfSecretPath(home));
}
