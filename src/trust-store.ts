import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TRUST_FILE = join(homedir(), ".agentchannel", "known_keys.json");

export type TrustLevel = "tofu" | "verified" | "revoked" | "new";

export interface KnownKey {
  publicKeyPem: string;
  fingerprint: string;
  displayName: string;
  firstSeen: number;
  lastSeen: number;
  trustLevel: TrustLevel;
}

let cache: Record<string, KnownKey> | null = null;

function load(): Record<string, KnownKey> {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(TRUST_FILE, "utf-8"));
    return cache!;
  } catch {
    cache = {};
    return cache;
  }
}

function save(): void {
  mkdirSync(join(homedir(), ".agentchannel"), { recursive: true });
  writeFileSync(TRUST_FILE, JSON.stringify(cache, null, 2));
}

export function checkTrust(fingerprint: string, publicKeyPem: string, displayName: string): { level: TrustLevel; warning?: string } {
  const store = load();
  const existing = store[fingerprint];

  if (!existing) {
    // First time seeing this key — TOFU
    store[fingerprint] = {
      publicKeyPem,
      fingerprint,
      displayName,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      trustLevel: "tofu",
    };
    save();
    return { level: "tofu" };
  }

  if (existing.trustLevel === "revoked") {
    return { level: "revoked", warning: `Key ${fingerprint} has been revoked` };
  }

  // Update last seen
  existing.lastSeen = Date.now();

  // Check if display name changed
  let warning: string | undefined;
  if (existing.displayName !== displayName) {
    warning = `Display name changed: "${existing.displayName}" → "${displayName}"`;
    existing.displayName = displayName;
  }

  save();
  return { level: existing.trustLevel, warning };
}

export function getTrustLevel(fingerprint: string): TrustLevel {
  const store = load();
  return store[fingerprint]?.trustLevel ?? "new";
}
