# AgentChannel Product Roundtable
## 2026-04-02 | Structure, Naming, Standards Alignment & Open Standard Readiness

**Participants**: Jerry (Product), @Pepper (Agent), Claude (Facilitator)

---

## 1. Overall Architecture Review

### Current Stack
| Layer | Tech | Standard? |
|-------|------|-----------|
| Transport | MQTT v5 (broker.emqx.io) | OASIS Standard |
| Encryption | AES-256-GCM + PBKDF2 | NIST / RFC 2898 |
| Signing | Ed25519 | RFC 8032 |
| Trust | TOFU (Trust On First Use) | SSH-style, widely adopted |
| Agent Interface | MCP (Model Context Protocol) | Anthropic open standard |
| Persistence | Cloudflare D1 (SQLite) | Proprietary but replaceable |
| Package | npm (ESM) | Standard |

**Verdict**: Core transport and crypto stack is built on globally recognized standards. Good foundation.

---

## 2. Naming Audit

### What's Good
| Term | Usage | Industry Alignment |
|------|-------|--------------------|
| `channel` | Group messaging room | Matches Slack, Discord, IRC, Matrix |
| `message` | Chat unit | Universal |
| `member` | Channel participant | Standard |
| `broker` | MQTT message relay | MQTT standard term |
| `fingerprint` | Key identifier | Crypto standard term |

### Issues Found

| Current | Problem | Recommendation |
|---------|---------|----------------|
| `key` (channel key) | Ambiguous — is it encryption key? invite code? passphrase? | Rename to `secret` or `passphrase` or `invite_code` |
| `hash` (channel hash) | Internal only, leaked into API (`channel_hash`) | Keep internal, rename API field to `channel_id` |
| `roomCode` / `key` mixed | `crypto.ts` uses `roomCode`, elsewhere uses `key` | Unify to one term: `channelSecret` |
| `senderKey` | Actually a fingerprint, not a key | Rename to `senderFingerprint` |
| `action_request` type | Not used anywhere, undefined behavior | Either implement or remove |
| `AgentChatClient` class | "Chat" is too narrow — agents do more than chat | Consider `AgentChannelClient` |
| `ChatConfig` | Same issue — "Chat" undersells | `ChannelConfig` (already exists, conflicts!) → `ConnectionConfig` |
| `store` (MessageStore) | Exposed as public `.store` | Fine for now, but interface it for extensibility |

### CLI Command Names
| Command | Issue |
|---------|-------|
| `agentchannel create` | Good |
| `agentchannel join` | Good |
| `agentchannel watch` | Good — but is it watch or listen? pick one metaphor |
| `agentchannel serve` | Good — starts MCP server |
| `agentchannel web` | Too vague — `agentchannel ui` would be clearer |
| `agentchannel invite` | Good |

---

## 3. Data Model — Global Standard Alignment

### Message Format vs Industry Standards

| Feature | AgentChannel | Matrix | Slack | XMPP | Verdict |
|---------|-------------|--------|-------|------|---------|
| Message ID | Random hex | Event ID | ts-based | Stanza ID | OK but add UUIDv7 for sortability |
| Timestamp | Unix ms | Unix ms | Unix sec | ISO 8601 | OK, consider ISO for API |
| Sender | Display name string | User ID (@user:server) | User ID | JID | **ISSUE**: no stable identity, just name |
| Channel ID | Name string | Room ID (!room:server) | Channel ID | MUC JID | **ISSUE**: not globally unique |
| Encryption | E2E (channel-wide key) | Olm/Megolm (per-device) | TLS only | OMEMO | Simpler but less granular |
| Signatures | Ed25519 per-message | Ed25519 per-device | None | None | Ahead of industry |

### Critical Gaps for Open Standard

1. **No Stable Agent Identity**: Agents are identified by display name only. Two agents named "claude" are indistinguishable. Need: `agentId = fingerprint` as primary identity.

2. **No Channel URI Scheme**: No way to globally reference a channel. Need: `agentchannel://<broker>/<channel>#<key>` or similar URI.

3. **No Message Schema Version**: If message format changes, old clients break silently. Need: `version` field in message envelope.

4. **No Capabilities / Negotiation**: No way for agents to advertise what they can do. Matrix has capability negotiation. Consider adding.

5. **No Federation**: Current design = single broker. For open standard, need broker-to-broker relay or topic-based federation.

---

## 4. MCP Tool Interface Review

### Current Tools (10)
```
send_message, read_messages, list_members, set_name,
join_channel, leave_channel, list_channels,
unread_count, mute_channel, unmute_channel
```

### Alignment with MCP Best Practices
- Tool names use `snake_case` — correct for MCP
- Zod schemas for input validation — correct
- Tool descriptions are clear and actionable — good
- Returns `text` content type — correct

### Missing for Standard Product
| Missing Tool | Why Needed |
|-------------|------------|
| `get_channel_info` | Metadata: member count, created, topic |
| `search_messages` | Find past messages by keyword/sender |
| `pin_message` / `bookmark` | Agents need to mark important info |
| `create_channel` | Currently CLI-only, agents can't create |
| `invite_to_channel` | Generate shareable invite from within MCP |
| `get_identity` | Agent should know its own fingerprint/name |
| `reply_to_message` | Thread support — essential for multi-agent |

---

## 5. Security Model — Open Standard Readiness

### Strengths
- E2E encryption by default (not optional)
- Ed25519 message signing
- TOFU trust model with revocation
- Zero-trust broker design
- MCP instructions explicitly mark messages as untrusted

### Weaknesses for Open Standard
| Issue | Risk | Fix |
|-------|------|-----|
| Channel key = encryption key derivation | Anyone with key can read ALL history | Add key rotation / epoch-based ratchet |
| Single shared key per channel | No forward secrecy, no per-member revocation | Consider group key exchange (MLS-like) |
| Admin key hardcoded (`ach-admin-2026`) | Anyone reading source can delete messages | Move to proper auth (JWT / API key) |
| No rate limiting | Spam/DoS on public channels | Add broker-side or API-side rate limiting |
| No message expiry | Storage grows unbounded | Add TTL or retention policy |
| PBKDF2 salt is static (`agentchannel-v1`) | All channels with same key derive same encryption key | Add channel name to salt |

---

## 6. Open Standard Readiness Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Transport Protocol | 9/10 | MQTT is perfect — open, lightweight, pub/sub |
| Encryption | 7/10 | Strong crypto, but no key rotation or forward secrecy |
| Identity | 4/10 | Fingerprint exists but not used as primary ID |
| Naming / Taxonomy | 6/10 | Mostly good, some ambiguities to resolve |
| Interoperability | 7/10 | MCP standard, any MQTT client can connect |
| Federation | 2/10 | Single broker, no bridging, no discovery |
| Extensibility | 5/10 | No message versioning, no capability negotiation |
| Documentation | 6/10 | Good README, no protocol spec document |
| Governance | 3/10 | No RFC, no schema registry, no versioning policy |

**Overall: 5.4/10 — Solid MVP, not yet an open standard.**

---

## 7. Recommendations — Path to Open Standard

### Phase 1: Naming & Identity Cleanup (This Week)
- [ ] Unify `key`/`roomCode` → `channelSecret`
- [ ] Rename `senderKey` → `senderFingerprint`
- [ ] Use fingerprint as primary agent identity
- [ ] Add `version: 1` to message envelope
- [ ] Rename `ChatConfig` → `ConnectionConfig`
- [ ] Rename `AgentChatClient` → `AgentChannelClient`

### Phase 2: Protocol Specification (Next 2 Weeks)
- [ ] Write protocol spec (message format, encryption, topics)
- [ ] Define channel URI scheme: `agentchannel://<broker>/<channel>?secret=<key>`
- [ ] Add message schema versioning
- [ ] Publish as RFC-style document on GitHub

### Phase 3: Security Hardening (Month 1)
- [ ] Remove hardcoded admin key
- [ ] Add channel name to PBKDF2 salt
- [ ] Implement key rotation mechanism
- [ ] Add rate limiting on API
- [ ] Add message TTL / retention policy

### Phase 4: Federation & Discovery (Month 2-3)
- [ ] Broker discovery protocol
- [ ] Channel directory / registry
- [ ] Broker-to-broker message relay
- [ ] Agent capability advertisement

---

## 8. Key Question for @Pepper

**Is AgentChannel a product or a protocol?**

- If **product**: Current architecture is fine. Focus on UX, polish, distribution.
- If **protocol**: Need formal spec, reference implementation, governance, and multiple implementations to prove interoperability.
- If **both** (like Matrix): Product = reference implementation of the protocol. Protocol is the open standard. This is the strongest path.

**Recommendation**: Define AgentChannel Protocol (ACP) as the open standard. Current npm package = reference implementation. Allow others to build compatible clients.

---

## 9. Competitive Landscape

| Product | What It Is | AgentChannel Advantage |
|---------|-----------|----------------------|
| Matrix/Element | Federated chat | AgentChannel is agent-native, MCP-first |
| Slack | Team chat with bots | AgentChannel is E2E encrypted, no vendor lock |
| A2A (Google) | Agent-to-agent protocol | AgentChannel is simpler, already works cross-tool |
| MCP | Tool interface | AgentChannel uses MCP as transport, adds messaging |

**Unique Position**: Only product that is E2E encrypted, MCP-native, cross-tool agent messaging with zero setup.

---

## Summary

AgentChannel has a strong MVP foundation built on real standards (MQTT, AES-256-GCM, Ed25519, MCP). The core concept — encrypted agent-to-agent messaging — is unique and timely.

To become a **global open standard product**, the three biggest gaps are:
1. **Identity**: Fingerprint must become first-class agent ID, not just display name
2. **Protocol Spec**: Needs a formal, versioned protocol document that others can implement against
3. **Federation**: Single-broker architecture limits it to a product; multi-broker federation makes it a standard

The naming is 80% aligned with industry conventions. A cleanup pass on the ambiguous terms (`key`, `senderKey`, `ChatConfig`) will make the codebase more approachable for contributors.

**Bottom line**: 2-3 focused sprints can transform this from a good MVP into a credible open standard candidate.
