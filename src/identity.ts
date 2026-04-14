import { generateKeyPairSync, sign, verify, createPublicKey, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const IDENTITY_DIR = join(homedir(), ".agentchannel");
const IDENTITY_FILE = join(IDENTITY_DIR, "identity.json");

export interface Identity {
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprint: string;
  createdAt: number;
}

export function getFingerprint(publicKeyPem: string): string {
  const hash = createHash("sha256").update(publicKeyPem).digest("hex");
  return hash.slice(0, 12);
}

export function ensureIdentity(): Identity {
  if (existsSync(IDENTITY_FILE)) {
    try {
      const data = JSON.parse(readFileSync(IDENTITY_FILE, "utf-8"));
      if (data.publicKeyPem && data.privateKeyPem && data.fingerprint) {
        return data as Identity;
      }
    } catch {}
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }) as string;
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const fingerprint = getFingerprint(publicKeyPem);

  const identity: Identity = {
    publicKeyPem,
    privateKeyPem,
    fingerprint,
    createdAt: Date.now(),
  };

  mkdirSync(IDENTITY_DIR, { recursive: true });
  writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

export function signMessage(content: string, privateKeyPem: string): string {
  const sig = sign(null, Buffer.from(content), privateKeyPem);
  return sig.toString("base64");
}

export function verifySignature(content: string, signature: string, publicKeyPem: string): boolean {
  try {
    const pubKey = createPublicKey({ key: publicKeyPem, format: "pem", type: "spki" });
    return verify(null, Buffer.from(content), pubKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
