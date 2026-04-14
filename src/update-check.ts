import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_PATH = join(homedir(), ".agentchannel", "update-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheEntry {
  checkedAt: number;
  latest: string;
}

interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function readCache(): CacheEntry | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const data = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (typeof data.checkedAt === "number" && typeof data.latest === "string") return data;
  } catch {}
  return null;
}

function writeCache(latest: string): void {
  try {
    const dir = join(homedir(), ".agentchannel");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ checkedAt: Date.now(), latest }));
  } catch {}
}

/**
 * Check npm registry for latest agentchannel version. Returns null on any failure.
 * Caches for 24h so startup doesn't hammer npm.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    const cache = readCache();
    let latest: string | null = null;
    if (cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) {
      latest = cache.latest;
    } else {
      const res = await fetch("https://registry.npmjs.org/agentchannel/latest", {
        signal: AbortSignal.timeout(3000),
      });
      const data = (await res.json()) as { version?: string };
      if (!data.version) return null;
      latest = data.version;
      writeCache(latest);
    }
    if (!latest) return null;
    return {
      current: currentVersion,
      latest,
      updateAvailable: compareSemver(latest, currentVersion) > 0,
    };
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: check for update and print a banner to stderr if one is available.
 * Uses stderr so it doesn't pollute stdout (important for piped/JSON-RPC usage).
 * Non-blocking — resolves immediately, logs the banner asynchronously.
 */
export function notifyIfUpdate(currentVersion: string): void {
  checkForUpdate(currentVersion).then((info) => {
    if (info && info.updateAvailable) {
      // Box-drawing banner — friendly but low-noise
      const msg = `  Update available: v${info.current} → v${info.latest}\n  Run 'ach update' or 'npx agentchannel@latest' to upgrade.`;
      const width = 68;
      const top = "┌" + "─".repeat(width) + "┐";
      const bottom = "└" + "─".repeat(width) + "┘";
      process.stderr.write(`\n${top}\n${msg.split("\n").map((l) => "│" + l.padEnd(width) + "│").join("\n")}\n${bottom}\n\n`);
    }
  }).catch(() => {});
}
