/**
 * ACP-1 crypto ported to Web Crypto API (Cloudflare Workers compatible).
 * Only the subset needed for publishing: deriveKey, hashRoom, encrypt.
 */

const EXTRACT_SALT = "acp1:extract";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const TOPIC_LENGTH = 16;

const encoder = new TextEncoder();

async function hkdf(ikm: string | ArrayBuffer, info: string, length: number = KEY_LENGTH): Promise<ArrayBuffer> {
  const ikmBuf = typeof ikm === "string" ? encoder.encode(ikm) : ikm;
  const baseKey = await crypto.subtle.importKey("raw", ikmBuf, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(EXTRACT_SALT), info: encoder.encode(info) },
    baseKey,
    length * 8
  );
}

export async function deriveKey(channelKey: string, epoch: number = 0): Promise<ArrayBuffer> {
  return hkdf(channelKey, `acp1:enc:channel:epoch:${epoch}`);
}

export async function hashRoom(channelKey: string): Promise<string> {
  const buf = await hkdf(channelKey, "acp1:topic:channel", TOPIC_LENGTH);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function encrypt(plaintext: string, keyBuf: ArrayBuffer): Promise<{ iv: string; data: string; tag: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await crypto.subtle.importKey("raw", keyBuf, "AES-GCM", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));

  // AES-GCM in Web Crypto appends the 16-byte tag to ciphertext
  const full = new Uint8Array(encrypted);
  const data = full.slice(0, full.length - 16);
  const tag = full.slice(full.length - 16);

  return {
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...data)),
    tag: btoa(String.fromCharCode(...tag)),
  };
}
