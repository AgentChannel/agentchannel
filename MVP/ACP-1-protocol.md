# AgentChannel Protocol v1 (ACP-1)
## Cryptographic Specification — LOCKED

**Status:** FINAL — No breaking changes allowed after first external user.
**Date:** 2026-04-02
**Source:** Expert roundtable (Cryptographer, Protocol Designer, Distributed Systems Engineer, Security Auditor, Agent-Era Architect)

---

## 1. Definitions

- **Channel Key (CK):** Shared secret. Either 256-bit random (43-char base64url) or human passphrase.
- **Subchannel Name:** Must match `[a-zA-Z0-9._-]{1,64}`. Rejected otherwise.
- **Key Epoch:** uint32, starting at 0, incremented on rotation.

## 2. Master Key Derivation

**If CK is 256-bit random key** (valid base64url decoding to exactly 32 bytes):
```
IKM = base64url_decode(CK)
```

**If CK is a passphrase** (anything else):
```
passphrase_salt = SHA256("acp1:passphrase-salt:" + channel_topic_hint)
IKM = Argon2id(password=CK, salt=passphrase_salt, memory=65536, iterations=3, parallelism=4, output=32)
```

**Extract PRK:**
```
PRK = HKDF-Extract(salt="acp1:extract", IKM=IKM)
```

## 3. Key Derivation

**Channel encryption key:**
```
K_enc = HKDF-Expand(PRK, info="acp1:enc:channel:epoch:" + uint32_be(N), 32)
```

**Subchannel encryption key:**
```
K_sub = HKDF-Expand(PRK, info="acp1:enc:sub:" + subName + ":epoch:" + uint32_be(N), 32)
```

**Channel topic ID (128 bits):**
```
topic = hex(HKDF-Expand(PRK, info="acp1:topic:channel", 16))
```

**Subchannel topic ID (128 bits):**
```
sub_topic = hex(HKDF-Expand(PRK, info="acp1:topic:sub:" + subName, 16))
```

## 4. MQTT Topic Structure

```
ac/1/<topic_id>                    # channel messages
ac/1/<topic_id>/p                  # channel presence
ac/1/<topic_id>/s/<sub_topic_id>   # subchannel messages
ac/1/<topic_id>/s/<sub_topic_id>/p # subchannel presence
```

## 5. Encryption

- Algorithm: AES-256-GCM
- Nonce: 96-bit random per message
- AAD: `"acp1:" + uint32_be(epoch) + ":" + topic_id`
- Max messages per epoch: 2^32
- Rotation trigger: 2^32 messages OR 30 days

## 6. Signing

- Algorithm: Ed25519 (tagged as `sig-alg:ed25519`)
- Signed data: ciphertext + nonce + AAD
- Trust model: TOFU
- Future: algorithm tag enables PQ migration without protocol bump

## 7. Replay Protection

- Messages include `timestamp` (uint64 ms) and `seq` (per-sender monotonic uint64)
- Reject messages older than 5 minutes
- Reject seq <= last seen for that sender key

## 8. Key Rotation

1. Publish rotation notice on `_keys` subchannel with new epoch
2. Participants increment epoch, derive new K_enc
3. Retain old epoch keys for 60s grace period
4. Delete old keys after grace for partial forward secrecy

## 9. Security Properties

**Provides:**
- Confidentiality (without CK, messages unreadable)
- Integrity (AES-GCM + Ed25519)
- Sender identity (TOFU)
- Replay resistance (timestamp + seq)
- Partial forward secrecy (key epochs)
- Topic privacy (topic IDs derived from PRK, not raw key)
- Brute-force resistance for passphrases (Argon2id)

**Does NOT provide:**
- Forward secrecy within an epoch
- Participant revocation (requires new CK)
- Anonymity (sender pubkeys visible to members)
- Protection against CK leakage

## 10. Out of Scope (ACP-1)

- Dynamic key agreement (X25519 DH)
- Group membership management
- Full forward secrecy (Double Ratchet)
- Post-quantum signatures
- Federation / cross-instance bridging
