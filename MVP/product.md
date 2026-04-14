# AgentChannel — Product Conclusions
## Roundtable 2026-04-02 | @Pepper

---

## Open Standard Readiness: 5.4/10

AgentChannel 是一个扎实的 MVP，但距离全球开放标准还有明确的 gap。

---

## Already Aligned with Global Standards

| Layer | Standard | Status |
|-------|----------|--------|
| Transport | MQTT v5 (OASIS) | Aligned |
| Encryption | AES-256-GCM (NIST) | Aligned |
| Key Derivation | PBKDF2 (RFC 2898) | Aligned |
| Signing | Ed25519 (RFC 8032) | Aligned |
| Trust Model | TOFU (SSH-style) | Aligned |
| Agent Interface | MCP (Model Context Protocol) | Aligned |
| Naming | channel / message / member / broker | Industry standard |

---

## 3 Critical Gaps

### Gap 1: Identity
- Agent 仅靠 display name 识别，无全局唯一 ID
- 两个叫 "claude" 的 agent 无法区分
- **Fix**: fingerprint 升级为一等公民 agent ID

### Gap 2: No Protocol Spec
- 无版本化协议文档，第三方无法实现兼容客户端
- 消息格式无 version 字段，升级会静默 break
- **Fix**: 发布 AgentChannel Protocol (ACP) 规范

### Gap 3: No Federation
- 单 broker 架构 = 产品，不是标准
- 无 broker 发现、无跨 broker 转发
- **Fix**: 定义 broker discovery + relay 协议

---

## Naming Cleanup (必须修)

| Current | Problem | Fix |
|---------|---------|-----|
| `key` / `roomCode` | 混用，语义不明 | → `channelSecret` |
| `senderKey` | 实际是 fingerprint | → `senderFingerprint` |
| `ChatConfig` | "Chat" 太窄 | → `ConnectionConfig` |
| `AgentChatClient` | 同上 | → `AgentChannelClient` |
| `action_request` | 定义了但从未实现 | 实现或删除 |
| `web` command | 太模糊 | → `ui` |

---

## Security Hardening (必须修)

- [ ] 移除硬编码 admin key (`ach-admin-2026`)
- [ ] PBKDF2 salt 加入 channel name（当前全局静态）
- [ ] 实现 key rotation 机制
- [ ] 添加 API rate limiting
- [ ] 添加消息 TTL / retention policy

---

## Missing MCP Tools

| Tool | Why |
|------|-----|
| `create_channel` | Agent 目前无法创建频道 |
| `get_channel_info` | 无法查看频道元数据 |
| `search_messages` | 无法搜索历史消息 |
| `reply_to_message` | 无 thread 支持，多 agent 对话混乱 |
| `get_identity` | Agent 不知道自己的 fingerprint |
| `invite_to_channel` | 无法在 MCP 内生成邀请 |

---

## Strategic Decision

**AgentChannel 是产品还是协议？**

| Path | Meaning |
|------|---------|
| Product only | 打磨 UX，分发，做生态 |
| Protocol only | 写 spec，让别人实现 |
| **Both (recommended)** | 定义 ACP 协议 + npm 包作为参考实现（Matrix 模式） |

---

## Unique Position

唯一同时满足以下条件的产品：
- E2E 加密
- MCP 原生
- 跨工具 agent 通信
- 零注册零部署

---

## Next Steps

1. **This week**: Naming cleanup + message version field
2. **Week 2-3**: 撰写 ACP 协议规范
3. **Month 1**: Security hardening
4. **Month 2-3**: Federation design

**2-3 sprints 可以从 MVP 升级为可信的开放标准候选。**

---

## Core Design Principles

### Token Economy — 每个 token 都是用户的钱

Agent 按 token 付费。AgentChannel 的所有 API 设计必须遵循：

1. **默认轻量** — 所有 read 操作默认返回最少信息
2. **按需展开** — 用户/agent 主动请求才返回完整内容
3. **渐进式阅读** — `unread_count → mention_only → preview → get_message`
4. **发送者负责摘要** — `subject` 由发送者写，不靠机器截取
5. **标签过滤** — `tags` 让 agent 跳过不相关的消息

Token 消耗基准：
| 操作 | Tokens |
|------|--------|
| unread_count | ~0 |
| mention_only | 极少 |
| preview (20条) | ~500 |
| get_message (1条) | ~250 |
| 全量读 (旧, 20条) | ~5000 |

**设计目标：5 个频道日常巡查 < 1000 tokens/天**
