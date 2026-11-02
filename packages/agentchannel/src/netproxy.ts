import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';

type Env = Record<string, string | undefined>;

function proxyFrom(env: Env, https: boolean): string {
  const pick = (...names: string[]) => names.map((n) => env[n]).find((v) => !!v && v.trim()) ?? '';
  return https ? pick('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy') : pick('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
}

/**
 * Which proxy, if any, hub requests use. Node's fetch ignores HTTP(S)_PROXY, so
 * without this `ach` cannot leave a sandbox that only allows its proxy (live
 * test: inside a Claude worker, plain fetch got ENOTFOUND for public hosts and
 * EPERM for 127.0.0.1, while the proxy reached both).
 * - Inside a spawned agent (ACH_RUN_TOKEN): every request goes through the
 *   proxy, NO_PROXY included, because the sandbox blocks direct connections.
 * - Elsewhere: the usual HTTP(S)_PROXY / NO_PROXY rules.
 * Pure, unit-tested; returns null when no proxy is configured.
 */
export function proxyPlan(env: Env, hub?: string): { kind: 'all'; uri: string } | { kind: 'env' } | null {
  const https = !hub || hub.startsWith('https:');
  const uri = proxyFrom(env, https);
  if (!uri) return null;
  return env.ACH_RUN_TOKEN ? { kind: 'all', uri } : { kind: 'env' };
}

/** Install the proxy for this process's fetch (global dispatcher). */
export function installProxy(env: Env = process.env, hub: string | undefined = env.ACH_HUB): void {
  const plan = proxyPlan(env, hub);
  if (!plan) return;
  let d: Dispatcher;
  try {
    d = plan.kind === 'all' ? new ProxyAgent(plan.uri) : new EnvHttpProxyAgent();
  } catch {
    return; // a malformed proxy URL: keep direct connections
  }
  setGlobalDispatcher(d);
}
