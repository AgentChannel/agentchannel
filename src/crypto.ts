/**
 * ACP-1 Cryptographic Layer
 * AgentChannel Protocol v1 — LOCKED, no breaking changes after release.
 *
 * Key derivation: HKDF-SHA256 (RFC 5869)
 * Encryption: AES-256-GCM
 * Topic IDs: derived from PRK (not raw key) — 128-bit
 */

import { createHmac, hkdfSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { EncryptedPayload } from "./types.js";

const EXTRACT_SALT = "acp1:extract";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const TOPIC_LENGTH = 16; // 128-bit topic IDs

// Subchannel name validation: [a-zA-Z0-9._-]{1,64}
const SUBCHANNEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export function validateSubchannelName(name: string): boolean {
  return SUBCHANNEL_RE.test(name);
}

/**
 * Single HKDF call: Extract + Expand in one step.
 * hkdfSync(digest, ikm, salt, info, keylen)
 */
function hkdf(ikm: string | Buffer, info: string, length: number = KEY_LENGTH): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, EXTRACT_SALT, info, length));
}

// ── Channel key derivation ─────────────────────────────

/**
 * Derive channel encryption key (epoch 0).
 */
export function deriveKey(channelKey: string): Buffer {
  return hkdf(channelKey, "acp1:enc:channel:epoch:0");
}

/**
 * Derive subchannel encryption key (epoch 0).
 */
export function deriveSubKey(channelKey: string, subName: string): Buffer {
  return hkdf(channelKey, `acp1:enc:sub:${subName}:epoch:0`);
}

// ── Topic ID derivation (128-bit, from HKDF) ──────────

/**
 * Derive channel topic ID (32 hex chars, 128 bits).
 * Not computable without the channel key.
 */
export function hashRoom(channelKey: string): string {
  return hkdf(channelKey, "acp1:topic:channel", TOPIC_LENGTH).toString("hex");
}

/**
 * Derive subchannel topic ID (32 hex chars, 128 bits).
 */
export function hashSub(channelKey: string, subName: string): string {
  return hkdf(channelKey, `acp1:topic:sub:${subName}`, TOPIC_LENGTH).toString("hex");
}

// ── DM key derivation ────────────────────────────────

/**
 * Derive DM encryption key from two fingerprints.
 * Fingerprints are sorted alphabetically so both sides derive the same key.
 */
export function deriveDmKey(fpA: string, fpB: string): Buffer {
  const sorted = [fpA, fpB].sort();
  const ikm = sorted[0] + sorted[1];
  return hkdf(ikm, "acp1:dm");
}

/**
 * Derive DM topic ID from two fingerprints (32 hex chars, 128 bits).
 */
export function hashDm(fpA: string, fpB: string): string {
  const sorted = [fpA, fpB].sort();
  const ikm = sorted[0] + sorted[1];
  return hkdf(ikm, "acp1:topic:dm", TOPIC_LENGTH).toString("hex");
}

// ── AES-256-GCM encryption ────────────────────────────

export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const iv = Buffer.from(payload.iv, "base64");
  const data = Buffer.from(payload.data, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
