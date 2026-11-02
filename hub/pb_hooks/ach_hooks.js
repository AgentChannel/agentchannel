/// <reference path="../pb_data/types.d.ts" />
// Hooks: how notification events leave the hub, and how outside systems post in.
// Loaded with require() from ach_routes.pb.js and ach_notify.js. ES5-style (goja).
//
// Outbound hooks at three levels:
//  - personal: my notifications (also my older users.notify_webhook, and Web Push);
//  - channel: a channel's important (or all) events, to a group chat;
//  - team: important events of every team channel (never private channels).
// Every delivery is a standard payload with only the event, title, deep link and
// channel (never bodies of private items or handoffs), formatted by a preset
// (Feishu/Lark, DingTalk, WeCom, Slack, Discord, Telegram, ntfy, Bark, Pushover,
// generic JSON) and signed: X-ACH-Timestamp, X-ACH-Event-Id and
// X-ACH-Signature: sha256=HMAC-SHA256(secret, "<timestamp>.<body>"); Feishu and
// DingTalk also get their own signature when the hook has a secret.
// Safety: https only (http with ACH_NOTIFY_ALLOW_HTTP=1); a preset's known
// webhook hosts, else only admin-allowlisted hosts; never private/loopback/
// link-local/NAT64 literals, internal or non-ASCII names unless allowlisted
// (the hub cannot resolve DNS: see API.md "Outbound host policy"); a 3xx fails;
// retries with backoff; after BROKEN_AFTER failed attempts in a row the hook is
// marked broken and its owner is told in the panel.
// Inbound hooks: a channel's incoming URL with a secret token (hashed, rotatable);
// a POST becomes an announcement post marked external and untrusted. Rate-limited.

var PRESETS = ["json", "feishu", "dingtalk", "wecom", "slack", "discord", "telegram", "ntfy", "bark", "pushover"]
var BACKOFF_S = [60, 300, 1800, 7200]
var MAX_ATTEMPTS = 5
var BROKEN_AFTER = 5
var ALLOW_KEY = "ach_hook_allow_hosts"
var BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

function L() { return require(__hooks + "/ach_lib.js").wikiDeps() }
function AchError(status, code, message) { this.achError = true; this.status = status; this.code = code; this.message = message }
function E(status, code, message) { return new AchError(status, code, message) }
function str(v) { return v === undefined || v === null ? "" : String(v) }
function arr(v) { return Array.isArray(v) ? v : [] }
function lower(s) { return str(s).trim().toLowerCase() }
function parseJSON(s) { if (!s) return null; try { return typeof s === "string" ? JSON.parse(s) : s } catch (err) { return null } }
function find(app, coll, filter, sort, limit, params) { return app.findRecordsByFilter(coll, filter, sort || "", limit || 1000, 0, params || {}) }
function byId(app, coll, id) { if (!id) return null; try { return app.findRecordById(coll, id) } catch (err) { return null } }
function iso(ms) { return new Date(ms).toISOString().replace("T", " ") }
function nowMs() { return Date.now() }
function oneLine(s, max) { return str(s).replace(/\s+/g, " ").trim().slice(0, max || 200) }
function clean(s, max) { return str(s).replace(/[\r\n]+/g, " ").replace(/[<>]/g, " ").slice(0, max || 300) }
function publicUrl() { return str($os.getenv("ACH_PUBLIC_URL")).trim().replace(/\/+$/, "") }
function defaultLang() { return lower($os.getenv("ACH_DEFAULT_LANG")) === "zh" ? "zh" : "en" }
function userName(u) { var n = u.getString("name"); if (n) return n; var em = u.getString("email"); return em ? em.split("@")[0] : u.id }

// ---------------------------------------------------------------- base64

var B64S = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
function hexB64(h) {
  var b = []
  for (var i = 0; i < h.length; i += 2) b.push(parseInt(h.substr(i, 2), 16))
  var out = ""
  for (var j = 0; j < b.length; j += 3) {
    var n = (b[j] << 16) | ((b[j + 1] || 0) << 8) | (b[j + 2] || 0)
    out += B64S[(n >> 18) & 63] + B64S[(n >> 12) & 63] + (j + 1 < b.length ? B64S[(n >> 6) & 63] : "=") + (j + 2 < b.length ? B64S[n & 63] : "=")
  }
  return out
}

// ---------------------------------------------------------------- SSRF

function allowHosts(app) {
  var list = str($os.getenv("ACH_HOOK_ALLOW_HOSTS")).split(",").map(lower).filter(function (x) { return x })
  try { list = list.concat(arr(L().readSetting(app, ALLOW_KEY)).map(lower)) } catch (err) {}
  return list
}
function allowed(host, list) {
  return list.some(function (a) { return a === host || (a.indexOf("*.") === 0 && host.length > a.length - 1 && host.slice(-(a.length - 1)) === a.slice(1)) })
}
function v4Private(parts) {
  var a = parts[0], b = parts[1]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224
}
/** Why this host is not allowed for an outbound hook ("" when it is). */
function hostProblem(host) {
  var h = lower(host).replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (!h) return "no host"
  // ASCII host names and IP literals only: fullwidth digits, other Unicode and
  // punycode (IDN) names are refused unless an admin allowlists them
  if (!/^[a-z0-9.-]+$/.test(h) && !/^[0-9a-f:.]+$/.test(h)) return "non-ASCII or unusual host name"
  if (/(^|\.)xn--/.test(h)) return "internationalized (punycode) host name"
  if (h === "localhost" || /\.(localhost|local|internal|home\.arpa|lan|intranet)$/.test(h) || h === "metadata" || h.indexOf(".") < 0 && h.indexOf(":") < 0) return "internal host name"
  if (h.indexOf(":") >= 0) {
    if (/^::/.test(h) || /^0+:/.test(h) || /^(fc|fd|fe[89ab])/.test(h)) return "private or loopback IPv6 address"
    // NAT64 (64:ff9b::/96, 64:ff9b:1::/48) maps to IPv4, private ranges included
    if (/^0*64:ff9b:/.test(h)) return "NAT64 IPv6 address"
    return ""
  }
  if (/^[0-9.]+$/.test(h) || /^0x/.test(h) || /\.0x/.test(h)) {
    var parts = h.split(".")
    if (parts.length !== 4 || parts.some(function (p) { return !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255 })) return "unusual IP address form"
    if (v4Private(parts.map(Number))) return "private, loopback or link-local address"
  }
  return ""
}
// Known webhook hosts per preset: a preset URL may go there without an admin's
// approval. Generic JSON (and any other host) needs an admin allowlist entry
// (GET/PUT /admin/hooks/allow or env ACH_HOOK_ALLOW_HOSTS). The hub cannot
// resolve DNS, so this is a host-name policy: an allowlisted name that later
// resolves to a private address (DNS rebinding) is not caught here; run the hub
// with egress firewall rules that block private ranges and cloud metadata.
var KNOWN_HOSTS = {
  feishu: ["open.feishu.cn", "open.larksuite.com"],
  dingtalk: ["oapi.dingtalk.com"],
  wecom: ["qyapi.weixin.qq.com"],
  slack: ["hooks.slack.com"],
  discord: ["discord.com", "discordapp.com"],
  telegram: ["api.telegram.org"],
  ntfy: ["ntfy.sh"],
  bark: ["api.day.app"],
  pushover: ["api.pushover.net"],
  // browsers' Web Push services (subscription endpoints)
  webpush: ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "*.push.apple.com", "*.notify.windows.com"],
  json: [],
}
function knownHost(preset, host) {
  return allowed(host, KNOWN_HOSTS[preset] || [])
}
/**
 * Check an outbound URL: https (http only when the hub allows it), no
 * credentials, and a host that is either a known webhook host of the preset or
 * on the admin allowlist. Literal private, loopback and link-local addresses and
 * internal names stay blocked unless the admin allowlisted exactly that host.
 */
function checkUrl(app, url, preset) {
  var u = str(url).trim()
  if (!u || u.length > 1000 || /\s/.test(u)) throw E(400, "invalid", "url is required (at most 1000 characters)")
  var m = /^(https?):\/\/([^\/?#]+)/i.exec(u)
  if (!m) throw E(400, "invalid", "url must start with https://")
  if (lower(m[1]) === "http" && $os.getenv("ACH_NOTIFY_ALLOW_HTTP") !== "1") throw E(400, "invalid", "url must be https://")
  if (m[2].indexOf("@") >= 0) throw E(400, "invalid", "url must not carry credentials")
  var host = lower(m[2].replace(/:[0-9]+$/, "")).replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (allowed(host, allowHosts(app))) return u
  var why = hostProblem(host)
  if (why) throw E(400, "blocked_host", "this hook URL points at a " + why + "; an admin can allowlist the host")
  if (!knownHost(preset || "json", host)) {
    var known = (KNOWN_HOSTS[preset] || []).join(", ")
    throw E(400, "host_not_allowed", (known ? "a " + preset + " hook goes to " + known : "a generic hook may only go to a host an admin approved") + "; ask an admin to allowlist " + host + " (Settings > hooks allowlist)")
  }
  return u
}

// ---------------------------------------------------------------- formatting

var TEST_TEXT = { en: "Test from AgentChannel: this hook works", zh: "AgentChannel 测试消息：这个 hook 可以用" }

function lineOf(msg, x) {
  var zh = msg.lang === "zh"
  return x.text + (zh ? "：" : ": ") + clean(x.title, 300) + (x.detail ? " (" + clean(x.detail, 200) + ")" : "")
}
/** A decision's question and options, each with its link (opens the panel with that option preselected). */
function optionLines(msg) {
  if (!Array.isArray(msg.options) || !msg.options.length) return ""
  var zh = msg.lang === "zh"
  return "\n" + clean(msg.question, 500) + msg.options.map(function (o) {
    return "\n- " + clean(o.label, 120) + (o.recommended ? (zh ? "（推荐）" : " (Recommended)") : "") + (o.url ? " " + o.url : "")
  }).join("")
}
/** Plain text of a message (chat presets). */
function plainText(msg) {
  if (msg.kind === "test") return "[AgentChannel] " + (TEST_TEXT[msg.lang] || TEST_TEXT.en) + "\n" + msg.url
  if (msg.kind === "single") return "[AgentChannel] " + lineOf(msg, msg) + optionLines(msg) + "\n" + msg.url
  var more = msg.more > 0 ? "\n" + (msg.lang === "zh" ? "还有 " + msg.more + " 条" : "+" + msg.more + " more") : ""
  return "[AgentChannel] " + msg.text + (msg.kind === "digest" ? " (" + msg.count + ")" : "") +
    arr(msg.items).map(function (x) { return "\n- " + lineOf(msg, x) + " " + x.url }).join("") + more + "\n" + msg.url
}
/** The standard (generic JSON) payload. */
function standard(msg, ts) {
  var o = { source: "agentchannel", id: msg.id, event: msg.event, title: clean(msg.title, 300), url: msg.url, channel: msg.channel || "", ts: ts, text: msg.text, lang: msg.lang }
  if (msg.kind !== "single" && msg.kind !== "test") { o.kind = msg.kind; o.count = msg.count; o.more = msg.more || 0; o.items = arr(msg.items).map(function (x) { var i = { id: x.id, event: x.event, title: clean(x.title, 300), url: x.url, channel: x.channel || "" }; if (x.detail) i.detail = x.detail; return i }) }
  if (msg.reason) o.reason = msg.reason
  if (msg.detail) o.detail = msg.detail
  if (msg.to_user) o.to_user = msg.to_user
  if (msg.decision) {
    ;["task_id", "task_ref", "message_id", "post_id"].forEach(function (k) { if (msg[k]) o[k] = msg[k] })
    if (Array.isArray(msg.options)) {
      o.question = clean(msg.question, 500)
      // url: opens the panel at the request with this option preselected; the person still sends it
      // labels only (like the older decision notes): details and amounts stay in the panel
      o.options = msg.options.map(function (x) { return { option: x.option, label: clean(x.label, 120), recommended: !!x.recommended, url: x.url } })
    }
  }
  return o
}

/** {url, body, headers} for a preset. cfg: the hook's config (chat_id, token, user). */
function render(preset, url, secret, cfg, msg, nowS) {
  var ts = String(nowS)
  var text = plainText(msg)
  var title = "AgentChannel"
  var headers = { "content-type": "application/json", "user-agent": "AgentChannel-Hook/1" }
  var body
  cfg = cfg || {}
  if (preset === "feishu") {
    var fb = { msg_type: "text", content: { text: text } }
    if (secret) { fb.timestamp = ts; fb.sign = hexB64($security.hs256("", ts + "\n" + secret)) }
    body = fb
  } else if (preset === "dingtalk") {
    body = { msgtype: "text", text: { content: text } }
    if (secret) {
      var ms = String(nowS * 1000)
      url += (url.indexOf("?") >= 0 ? "&" : "?") + "timestamp=" + ms + "&sign=" + encodeURIComponent(hexB64($security.hs256(ms + "\n" + secret, secret)))
    }
  } else if (preset === "wecom") body = { msgtype: "text", text: { content: text } }
  else if (preset === "slack") body = { text: text }
  else if (preset === "discord") body = { content: text.slice(0, 1990) }
  else if (preset === "telegram") body = { chat_id: str(cfg.chat_id), text: text, disable_web_page_preview: true }
  else if (preset === "bark") body = { title: title, body: text.replace(/^\[AgentChannel\] /, ""), url: msg.url, group: "AgentChannel" }
  else if (preset === "pushover") body = { token: str(cfg.token), user: str(cfg.user), title: title, message: text.replace(/^\[AgentChannel\] /, ""), url: msg.url }
  else if (preset === "ntfy") {
    headers = { "content-type": "text/plain; charset=utf-8", "user-agent": "AgentChannel-Hook/1", Title: title, Click: msg.url, Tags: "bell" }
    body = text.replace(/^\[AgentChannel\] /, "")
  } else body = standard(msg, nowS)
  var raw = typeof body === "string" ? body : JSON.stringify(body)
  headers["X-ACH-Timestamp"] = ts
  headers["X-ACH-Event-Id"] = str(msg.id)
  if (secret) headers["X-ACH-Signature"] = "sha256=" + $security.hs256(ts + "." + raw, secret)
  return { url: url, body: raw, headers: headers }
}

function httpSend(app, req) {
  try {
    if (!/^https?:\/\//i.test(str(req.url))) return { ok: false, status: 0, error: "bad scheme" }
    var res = $http.send({ url: req.url, method: "POST", body: req.body, headers: req.headers, timeout: 8 })
    // the JS runtime follows redirects and cannot be told not to; a redirect
    // target was never checked, so a 3xx (or a hop that ended elsewhere) fails
    if (res.statusCode >= 300 && res.statusCode < 400) return { ok: false, status: res.statusCode, error: "redirect refused (HTTP " + res.statusCode + ")" }
    if (res.statusCode >= 200 && res.statusCode < 300) return { ok: true, status: res.statusCode }
    return { ok: false, status: res.statusCode, error: "HTTP " + res.statusCode }
  } catch (err) {
    return { ok: false, status: 0, error: oneLine(String(err), 200) }
  }
}

// ---------------------------------------------------------------- targets

function autoPreset(url) { return /^https:\/\/open\.(feishu\.cn|larksuite\.com)\//.test(url) || lower($os.getenv("ACH_NOTIFY_FORMAT")) === "feishu" ? "feishu" : "json" }

/** Send one message to a target now. {ok, status, error, gone} */
function sendTo(app, target, msg, nowS) {
  var i = target.indexOf(":")
  var kind = target.slice(0, i)
  var id = target.slice(i + 1)
  try {
    if (kind === "hook") {
      var h = byId(app, "hooks", id)
      if (!h) return { ok: false, gone: true, error: "hook deleted" }
      if (h.getString("status") !== "active" && msg.kind !== "test") return { ok: false, gone: true, error: "hook " + h.getString("status") }
      var url = checkUrl(app, h.getString("url"), h.getString("preset"))
      return httpSend(app, render(h.getString("preset"), url, h.getString("secret"), parseJSON(h.getString("config")) || {}, msg, nowS))
    }
    if (kind === "user") {
      var u = byId(app, "users", id)
      var hook = u ? u.getString("notify_webhook") : ""
      if (!hook || u.getBool("deactivated")) return { ok: false, gone: true, error: "no webhook" }
      return httpSend(app, render(autoPreset(hook), checkUrl(app, hook, autoPreset(hook)), "", {}, msg, nowS))
    }
    if (kind === "feishu") return require(__hooks + "/ach_feishu.js").deliver(app, id, msg, nowS)
    if (kind === "sub") {
      var s = byId(app, "push_subs", id)
      if (!s) return { ok: false, gone: true, error: "subscription removed" }
      var ep = checkUrl(app, s.getString("endpoint"), "webpush")
      var auth = require(__hooks + "/ach_webpush.js").vapidAuth(app, ep, nowS)
      var r = httpSend(app, { url: ep, body: "", headers: { TTL: "86400", Urgency: msg.kind === "digest" ? "low" : "normal", Authorization: auth, "user-agent": "AgentChannel-Hook/1" } })
      if (r.status === 404 || r.status === 410) { app.delete(s); r.gone = true }
      return r
    }
  } catch (err) {
    return { ok: false, gone: !!(err && (err.code === "blocked_host" || err.code === "host_not_allowed")), error: oneLine((err && err.message) || String(err), 200) }
  }
  return { ok: false, gone: true, error: "unknown target" }
}

function enqueue(app, target, msg, evId) {
  var d = new Record(app.findCollectionByNameOrId("hook_deliveries"))
  d.set("target", target)
  d.set("ev", evId || "")
  d.set("message", msg)
  d.set("attempts", 0)
  d.set("next_at", iso(nowMs()))
  d.set("status", "pending")
  app.save(d)
}

/** A hook's outcome: success resets it; failures in a row mark it broken and tell the owner. */
function hookOutcome(app, target, r, now) {
  if (target.indexOf("hook:") !== 0) return
  var h = byId(app, "hooks", target.slice(5))
  if (!h) return
  if (r.ok) {
    h.set("fail_count", 0)
    h.set("last_error", "")
    h.set("last_ok_at", iso(now))
    app.save(h)
    return
  }
  h.set("fail_count", h.getInt("fail_count") + 1)
  h.set("last_error", clean(r.error, 290))
  var broke = h.getString("status") === "active" && h.getInt("fail_count") >= BROKEN_AFTER
  if (broke) h.set("status", "broken")
  app.save(h)
  if (broke) {
    app.db().newQuery("UPDATE hook_deliveries SET status = 'failed', last_error = 'hook broken' WHERE target = {:t} AND status = 'pending'").bind({ t: target }).execute()
    // the owner hears it in the panel (no push: the push path may be what broke)
    require(__hooks + "/ach_notify.js").emit(app, {
      key: "hook_broken:" + h.id + ":" + iso(now), event: "hook_broken", channel: "", title: (h.getString("name") || h.getString("preset")) + " (" + h.getString("scope") + ")",
      detail: clean(r.error, 200), path: "inbox/updates", reasons: (function () { var o = {}; o[h.getString("owner")] = "hook"; return o })(),
      pushSkip: (function () { var o = {}; o[h.getString("owner")] = true; return o })(), noBroadcast: true, important: false,
    })
  }
}

/** Send what is due (retries with backoff). */
function processDue(app, now) {
  now = now || nowMs()
  var nowS = Math.floor(now / 1000)
  var ids = arrayOf(new DynamicModel({ id: "" }))
  app.db().newQuery("SELECT id FROM hook_deliveries WHERE status = 'pending' AND next_at <= {:n} ORDER BY created LIMIT 200").bind({ n: iso(now) }).all(ids)
  var due = ids.map(function (r) { return byId(app, "hook_deliveries", r.id) }).filter(function (d) { return d })
  var sent = 0
  due.forEach(function (d) {
    // claim: push next_at forward so a parallel flush skips it
    var lease = iso(now + 120000)
    var res
    try { res = app.db().newQuery("UPDATE hook_deliveries SET next_at = {:l} WHERE id = {:id} AND status = 'pending' AND next_at = {:o}").bind({ l: lease, id: d.id, o: d.getString("next_at") }).execute() } catch (err) { return }
    if (res.rowsAffected() !== 1) return
    var msg = parseJSON(d.getString("message")) || {}
    var r = sendTo(app, d.getString("target"), msg, nowS)
    d = app.findRecordById("hook_deliveries", d.id)
    var attempts = d.getInt("attempts") + 1
    d.set("attempts", attempts)
    if (r.ok) { d.set("status", "sent"); d.set("last_error", ""); sent++ }
    else {
      d.set("last_error", clean(r.error, 290))
      if (r.gone || attempts >= MAX_ATTEMPTS) d.set("status", "failed")
      else d.set("next_at", iso(now + BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)] * 1000))
    }
    app.save(d)
    if (!r.gone || r.ok) hookOutcome(app, d.getString("target"), r, now)
  })
  return sent
}

/** Personal targets of a person: their notify_webhook, personal hooks, Web Push subscriptions. */
function personalTargets(app, u, withPush) {
  var out = []
  if (u.getString("notify_webhook")) out.push("user:" + u.id)
  find(app, "hooks", "owner = {:u} && scope = 'personal' && status = 'active'", "created", 50, { u: u.id }).forEach(function (h) { out.push("hook:" + h.id) })
  if (withPush) find(app, "push_subs", "user = {:u}", "created", 20, { u: u.id }).forEach(function (s) { out.push("sub:" + s.id) })
  // optional Feishu/Lark adapter: the person's DM through the app bot (ach_feishu.js)
  try { var ft = require(__hooks + "/ach_feishu.js").targetFor(app, u); if (ft) out.push(ft) } catch (err) {}
  return out
}

/** Channel and team hooks for an event (important, or everything for level "all"). Never team hooks for private channels. */
function groupTargets(app, ev) {
  var out = []
  var imp = ev.getBool("important")
  var ok = function (h) { return imp || h.getString("level") === "all" }
  if (ev.getString("channel")) {
    find(app, "hooks", "scope = 'channel' && channel = {:c} && status = 'active'", "created", 50, { c: ev.getString("channel") }).forEach(function (h) { if (ok(h)) out.push(h) })
  }
  if (!ev.getBool("private")) find(app, "hooks", "scope = 'team' && status = 'active'", "created", 50, {}).forEach(function (h) { if (ok(h)) out.push(h) })
  return out
}

// ---------------------------------------------------------------- routes: hooks

var routes = {}

function hookOut(h, names, secret, admin) {
  var cfg = parseJSON(h.getString("config")) || {}
  var o = {
    id: h.id, scope: h.getString("scope"), channel: h.getString("channel"), channel_name: names.channel(h.getString("channel")),
    name: h.getString("name"), preset: h.getString("preset"), url_hint: urlHint(h.getString("url")), level: h.getString("level") || "important",
    lang: h.getString("lang"), status: h.getString("status"), fail_count: h.getInt("fail_count"),
    // the raw transport error is for admins (it could map internal networks); others see that it failed
    last_error: admin ? h.getString("last_error") : (h.getString("last_error") ? "delivery failed" : ""),
    last_ok_at: h.getString("last_ok_at"), owner: h.getString("owner"), owner_name: names.user(h.getString("owner")), created: h.getString("created"),
    has_secret: !!h.getString("secret"), chat_id: str(cfg.chat_id),
  }
  if (secret) o.secret = secret
  return o
}
/** Only scheme + host + the last 4 characters: hook URLs often carry tokens. */
function urlHint(u) {
  var m = /^(https?:\/\/[^\/?#]+)/.exec(str(u))
  return (m ? m[1] : "") + "/…" + str(u).slice(-4)
}

function canManage(app, ctx, h) {
  if (ctx.isAdmin) return true
  if (h.getString("owner") === ctx.user.id) return true
  return false
}
function channelAccess(app, ctx, ref) {
  var c = L().findChannel(app, str(ref))
  L().requireChannelVisible(ctx, c.id, "channel")
  if (!ctx.isAdmin && arr(c.getStringSlice("members")).indexOf(ctx.user.id) < 0 && c.getString("visibility") === "private") throw E(403, "forbidden", "members only")
  return c
}

function readHookFields(app, ctx, b, h) {
  if (b.name !== undefined) h.set("name", oneLine(b.name, 100))
  if (b.preset !== undefined) {
    if (PRESETS.indexOf(str(b.preset)) < 0) throw E(400, "invalid", "preset must be one of " + PRESETS.join(", "))
    h.set("preset", str(b.preset))
  }
  if (b.url !== undefined) h.set("url", str(b.url).trim())
  if (b.level !== undefined) {
    if (["important", "all"].indexOf(str(b.level)) < 0) throw E(400, "invalid", "level must be important or all")
    h.set("level", str(b.level))
  }
  if (b.lang !== undefined) {
    var l = lower(b.lang)
    if (l && l !== "zh" && l !== "en") throw E(400, "invalid", "lang must be zh or en")
    h.set("lang", l)
  }
  if (b.config !== undefined) {
    var c = b.config && typeof b.config === "object" ? b.config : {}
    var out = {}
    ;["chat_id", "token", "user"].forEach(function (k) { if (c[k] !== undefined) out[k] = oneLine(c[k], 200) })
    h.set("config", out)
  }
  if (b.status !== undefined) {
    if (["active", "paused"].indexOf(str(b.status)) < 0) throw E(400, "invalid", "status must be active or paused")
    h.set("status", str(b.status))
    if (str(b.status) === "active") h.set("fail_count", 0)
  }
  var preset = h.getString("preset")
  // the URL is checked against the final preset (a preset change re-checks it)
  if (h.getString("url")) h.set("url", checkUrl(app, h.getString("url"), preset))
  var cfg = parseJSON(h.getString("config")) || {}
  if (preset === "telegram" && !cfg.chat_id) throw E(400, "invalid", "telegram needs config.chat_id")
  if (preset === "pushover" && (!cfg.token || !cfg.user)) throw E(400, "invalid", "pushover needs config.token and config.user")
}

function newSecret() { return "achs_" + $security.randomStringWithAlphabet(40, BASE62) }

// GET /api/ach/hooks: the hooks I may manage (mine; a channel's if I am an admin)
routes.listHooks = {
  allow: ["user"],
  fn: function (e, ctx) {
    var names = new (L().Names)(e.app)
    var f = ctx.isAdmin ? "id != ''" : "owner = {:u}"
    var list = find(e.app, "hooks", f, "scope,created", 500, { u: ctx.user.id }).filter(function (h) { return !L().channelHidden(ctx, h.getString("channel")) })
    return [200, { hooks: list.map(function (h) { return hookOut(h, names, "", ctx.isAdmin) }), presets: PRESETS, allow_hosts: ctx.isAdmin ? allowHosts(e.app) : undefined }]
  },
}

// POST /api/ach/hooks {scope, channel?, name, preset, url, level?, lang?, config?, secret?}
routes.createHook = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = L().body(e)
    return L().tx(e.app, function (app) {
      var scope = str(b.scope || "personal")
      if (["personal", "channel", "team"].indexOf(scope) < 0) throw E(400, "invalid", "scope must be personal, channel or team")
      if (scope === "team" && !ctx.isAdmin) throw E(403, "forbidden", "team hooks are for admins")
      var h = new Record(app.findCollectionByNameOrId("hooks"))
      h.set("owner", ctx.user.id)
      h.set("scope", scope)
      if (scope === "channel") h.set("channel", channelAccess(app, ctx, b.channel).id)
      h.set("preset", "json")
      h.set("status", "active")
      h.set("level", "important")
      h.set("fail_count", 0)
      readHookFields(app, ctx, b, h)
      if (!h.getString("url")) throw E(400, "invalid", "url is required")
      var secret = str(b.secret).trim() || newSecret()
      if (secret.length > 200) throw E(400, "invalid", "secret is too long")
      h.set("secret", secret)
      app.save(h)
      return [201, { hook: hookOut(h, new (L().Names)(app), secret, ctx.isAdmin) }]
    })
  },
}

function hookFor(app, ctx, id) {
  var h = byId(app, "hooks", id)
  if (!h || L().channelHidden(ctx, h.getString("channel")) || !canManage(app, ctx, h)) throw E(404, "not_found", "hook not found")
  return h
}

routes.patchHook = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = L().body(e)
    return L().tx(e.app, function (app) {
      var h = hookFor(app, ctx, e.request.pathValue("id"))
      readHookFields(app, ctx, b, h)
      app.save(h)
      return [200, { hook: hookOut(h, new (L().Names)(app), "", ctx.isAdmin) }]
    })
  },
}
routes.deleteHook = {
  allow: ["user"],
  fn: function (e, ctx) {
    return L().tx(e.app, function (app) {
      var h = hookFor(app, ctx, e.request.pathValue("id"))
      app.db().newQuery("UPDATE hook_deliveries SET status = 'failed', last_error = 'hook deleted' WHERE target = {:t} AND status = 'pending'").bind({ t: "hook:" + h.id }).execute()
      app.delete(h)
      return [200, { deleted: true }]
    })
  },
}
routes.rotateHookSecret = {
  allow: ["user"],
  fn: function (e, ctx) {
    return L().tx(e.app, function (app) {
      var h = hookFor(app, ctx, e.request.pathValue("id"))
      var s = newSecret()
      h.set("secret", s)
      app.save(h)
      return [200, { hook: hookOut(h, new (L().Names)(app), s, ctx.isAdmin) }]
    })
  },
}
// POST /api/ach/hooks/{id}/test: send a test message now; a success re-activates a broken hook.
routes.testHook = {
  allow: ["user"],
  fn: function (e, ctx) {
    var app = e.app
    var h = hookFor(app, ctx, e.request.pathValue("id"))
    var lang = h.getString("lang") || lower(ctx.user.getString("lang")) || defaultLang()
    var msg = { kind: "test", id: "test-" + $security.randomStringWithAlphabet(12, "abcdefghijklmnopqrstuvwxyz0123456789"), event: "test", text: TEST_TEXT[lang] || TEST_TEXT.en, title: TEST_TEXT[lang] || TEST_TEXT.en, url: publicUrl() + "/#/inbox/updates", lang: lang, channel: L().Names ? new (L().Names)(app).channel(h.getString("channel")) : "" }
    var r = sendTo(app, "hook:" + h.id, msg, Math.floor(nowMs() / 1000))
    h = app.findRecordById("hooks", h.id)
    if (r.ok) { h.set("status", h.getString("status") === "broken" ? "active" : h.getString("status")); h.set("fail_count", 0); h.set("last_error", ""); h.set("last_ok_at", iso(nowMs())) }
    else h.set("last_error", clean(r.error, 290))
    app.save(h)
    // admins see the status and error; others only whether it worked (no probing oracle)
    var detail = ctx.isAdmin ? { status: r.status || 0, error: r.ok ? "" : str(r.error) } : { error: r.ok ? "" : "delivery failed" }
    var res = { ok: !!r.ok, hook: hookOut(h, new (L().Names)(app), "", ctx.isAdmin) }
    for (var k in detail) res[k] = detail[k]
    return [200, res]
  },
}
// GET|PUT /api/ach/admin/hooks/allow {hosts: [...]}: hosts outbound hooks may reach despite the private-address block.
routes.allowList = {
  allow: ["user"],
  fn: function (e, ctx) {
    L().requireAdmin(ctx)
    if (e.request.method === "PUT") {
      var b = L().body(e)
      var hosts = arr(b.hosts).map(lower).filter(function (x) { return x })
      if (hosts.length > 100 || hosts.some(function (x) { return !/^(\*\.)?[a-z0-9.:\[\]-]{1,253}$/.test(x) })) throw E(400, "invalid", "hosts must be host names, *.domains or IPs (at most 100)")
      L().writeSetting(e.app, ALLOW_KEY, hosts)
    }
    return [200, { hosts: arr(L().readSetting(e.app, ALLOW_KEY)), env: str($os.getenv("ACH_HOOK_ALLOW_HOSTS")).split(",").filter(function (x) { return x }) }]
  },
}

// ---------------------------------------------------------------- routes: inbound

function inboundOut(r, names, token) {
  var o = { id: r.id, channel: r.getString("channel"), channel_name: names.channel(r.getString("channel")), name: r.getString("name"), token_prefix: r.getString("token_prefix"), active: r.getBool("active"), last_used: r.getString("last_used"), created: r.getString("created") }
  if (token) o.url = publicUrl() + "/api/ach/inbound/" + token
  if (token) o.token = token
  return o
}
function mintInbound(r) {
  var token = "ach_in_" + r.id + "_" + $security.randomStringWithAlphabet(32, BASE62)
  r.set("token_hash", $security.sha256(token))
  r.set("token_prefix", token.slice(0, 26))
  return token
}

routes.listInbound = {
  allow: ["user"],
  fn: function (e, ctx) {
    var c = channelAccess(e.app, ctx, e.request.pathValue("id"))
    var names = new (L().Names)(e.app)
    return [200, { inbound: find(e.app, "inbound_hooks", "channel = {:c}", "created", 100, { c: c.id }).map(function (r) { return inboundOut(r, names) }) }]
  },
}
// POST /api/ach/channels/{id}/inbound {name}: the URL (with its token) is shown once.
routes.createInbound = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = L().body(e)
    return L().tx(e.app, function (app) {
      var c = channelAccess(app, ctx, e.request.pathValue("id"))
      if (c.getBool("archived")) throw E(409, "archived", "channel is archived")
      var r = new Record(app.findCollectionByNameOrId("inbound_hooks"))
      r.set("channel", c.id)
      r.set("name", oneLine(b.name, 100) || "incoming")
      r.set("created_by", ctx.user.id)
      r.set("active", true)
      r.set("token_hash", "-")
      app.save(r)
      var token = mintInbound(r)
      app.save(r)
      return [201, { inbound: inboundOut(r, new (L().Names)(app), token) }]
    })
  },
}
function inboundFor(app, ctx, id) {
  var r = byId(app, "inbound_hooks", id)
  if (!r) throw E(404, "not_found", "inbound hook not found")
  channelAccess(app, ctx, r.getString("channel"))
  return r
}
routes.rotateInbound = {
  allow: ["user"],
  fn: function (e, ctx) {
    return L().tx(e.app, function (app) {
      var r = inboundFor(app, ctx, e.request.pathValue("id"))
      var token = mintInbound(r)
      r.set("active", true)
      app.save(r)
      return [200, { inbound: inboundOut(r, new (L().Names)(app), token) }]
    })
  },
}
routes.deleteInbound = {
  allow: ["user"],
  fn: function (e, ctx) {
    return L().tx(e.app, function (app) {
      app.delete(inboundFor(app, ctx, e.request.pathValue("id")))
      return [200, { deleted: true }]
    })
  },
}

// POST /api/ach/inbound/{token} {title?, text, link?}: an announcement post, external and untrusted.
routes.inbound = {
  allow: ["public"],
  fn: function (e) {
    var app = e.app
    var token = str(e.request.pathValue("token"))
    var m = /^ach_in_([a-z0-9]{15})_[A-Za-z0-9]{32}$/.exec(token)
    var r = m ? byId(app, "inbound_hooks", m[1]) : null
    if (!r || !r.getBool("active") || r.getString("token_hash") !== $security.sha256(token)) throw E(401, "unauthorized", "unknown or rotated inbound hook token")
    var limit = parseInt(str($os.getenv("ACH_INBOUND_PER_HOUR")), 10) || 30
    var n = new DynamicModel({ n: 0 })
    app.db().newQuery("SELECT COUNT(*) AS n FROM posts WHERE author_type = 'external' AND json_extract(external,'$.hook') = {:h} AND created > {:s}").bind({ h: r.id, s: iso(nowMs() - 3600 * 1000) }).one(n)
    if (n.n >= limit) throw E(429, "rate_limited", "this inbound hook posted " + limit + " times in the last hour; try later")
    var b = L().body(e)
    var title = oneLine(b.title, 200)
    var text = str(b.text !== undefined ? b.text : b.body).replace(/\r/g, "").trim().slice(0, 4000)
    var link = str(b.link || b.url).trim()
    if (link && (!/^https?:\/\/\S+$/.test(link) || link.length > 500)) link = ""
    if (!title && !text) throw E(400, "invalid", "title or text is required")
    var c = byId(app, "channels", r.getString("channel"))
    if (!c || c.getBool("archived")) throw E(409, "archived", "channel is archived")
    var lines = []
    if (title) lines.push("**" + title.replace(/\*/g, "\\*") + "**")
    if (text) lines.push(text)
    if (link) lines.push(link)
    var p
    L().tx(app, function (tx) {
      p = new Record(tx.findCollectionByNameOrId("posts"))
      p.set("channel", c.id)
      p.set("author_type", "external")
      p.set("kind", "post")
      p.set("body", lines.join("\n"))
      p.set("announce", true)
      p.set("external", { kind: "inbound", hook: r.id, name: r.getString("name"), author: r.getString("name"), untrusted: true })
      tx.save(p)
      var rr = tx.findRecordById("inbound_hooks", r.id)
      rr.set("last_used", iso(nowMs()))
      tx.save(rr)
    })
    return [201, { post: { id: p.id, url: publicUrl() + "/#/p/" + p.id, channel_name: c.getString("name") } }]
  },
}

// ---------------------------------------------------------------- routes: Web Push

routes.vapid = {
  allow: ["user"],
  fn: function (e) { return [200, { public_key: require(__hooks + "/ach_webpush.js").publicKey(e.app) }] },
}
// POST /api/ach/push/subscribe {endpoint}: returns the read key the service worker uses.
routes.subscribe = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = L().body(e)
    var ep = checkUrl(e.app, b.endpoint, "webpush")
    return L().tx(e.app, function (app) {
      var s = find(app, "push_subs", "endpoint = {:e}", "", 1, { e: ep })[0]
      // an endpoint someone else registered is never taken over
      if (s && s.getString("user") !== ctx.user.id) throw E(409, "conflict", "this push endpoint belongs to another account")
      if (!s) { s = new Record(app.findCollectionByNameOrId("push_subs")); s.set("endpoint", ep) }
      s.set("user", ctx.user.id)
      // Only a full human session's subscription gets decision buttons
      s.set("full", ctx.scope !== "agent")
      var key = "achp_" + $security.randomStringWithAlphabet(40, BASE62)
      s.set("read_key_hash", $security.sha256(key))
      app.save(s)
      return [200, { id: s.id, read_key: key }]
    })
  },
}
routes.unsubscribe = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = L().body(e)
    var s = find(e.app, "push_subs", "endpoint = {:e} && user = {:u}", "", 1, { e: str(b.endpoint), u: ctx.user.id })[0]
    if (s) e.app.delete(s)
    return [200, { deleted: !!s }]
  },
}
// GET /api/ach/push/latest (header X-ACH-Push-Key: <read key>): the newest pushed item for the service worker (event + title + link only).
routes.latest = {
  allow: ["public"],
  fn: function (e) {
    var app = e.app
    var key = str(e.request.header.get("X-ACH-Push-Key")).trim()
    var s = /^achp_[A-Za-z0-9]{40}$/.test(key) ? find(app, "push_subs", "read_key_hash = {:h}", "", 1, { h: $security.sha256(key) })[0] : null
    if (!s) throw E(401, "unauthorized", "unknown push key")
    var u = byId(app, "users", s.getString("user"))
    var lang = u && u.getString("lang") ? u.getString("lang") : defaultLang()
    var n = find(app, "notifications", "user = {:u} && (push = 'sent' || push = 'pending')", "-created", 1, { u: s.getString("user") })[0]
    if (!n) return [200, { title: "AgentChannel", body: "", url: publicUrl() + "/#/inbox" }]
    var notify = require(__hooks + "/ach_notify.js")
    var ev = byId(app, "notify_events", n.getString("ev"))
    var out = { title: "AgentChannel · " + notify.eventLabel(n, ev, lang), body: ev ? clean(ev.getString("title"), 200) : "", url: ev ? publicUrl() + "/#/" + ev.getString("path") : publicUrl() + "/#/inbox", id: ev ? ev.id : "" }
    if (ev && notify.DECISION_EVENTS[ev.getString("event")] && s.getBool("full")) {
      // browsers show at most two buttons: the recommended option (answers with
      // a single-use action token) and "Open"
      var uid = s.getString("user")
      var st = notify.decisionState(app, parseJSON(ev.getString("data")), uid)
      var rec = st && st.choices ? Number(st.choices.recommended) || 0 : 0
      var acts = notify.mintActions(app, uid, st, [rec], "webpush")
      if (acts.length) {
        var c = st.choices
        out.body = clean(c.question, 200)
        out.actions = [
          { action: "pick", title: clean(acts[0].label, 60) + (lang === "zh" ? "（推荐）" : " (Recommended)"), token: acts[0].token, option: acts[0].option },
          { action: "open", title: lang === "zh" ? "打开" : "Open" },
        ]
        out.act_url = "/api/ach/push/act"
      }
    }
    return [200, out]
  },
}

function run(e, name) {
  var r = routes[name]
  try {
    var ctx = { type: "public" }
    if (r.allow[0] !== "public") {
      var D = L()
      ctx = D.authenticate(e)
      D.requireAuth(ctx, r.allow, r.runModes)
      D.hiddenChannels(e.app, ctx)
    }
    var out = r.fn(e, ctx)
    return e.json(out[0], out[1])
  } catch (err) {
    if (err && err.achError) return e.json(err.status, { error: err.message, code: err.code })
    var msg = String((err && err.message) || err)
    if (/validation|cannot be blank|must be/i.test(msg)) return e.json(400, { error: msg, code: "invalid" })
    e.app.logger().error("ach hooks route error", "route", name, "error", msg)
    return e.json(500, { error: "internal error" + ($os.getenv("ACH_TEST_HOOKS") === "1" ? ": " + msg : ""), code: "internal" })
  }
}

module.exports = {
  run: run, PRESETS: PRESETS, render: render, plainText: plainText, standard: standard, hostProblem: hostProblem, checkUrl: checkUrl,
  enqueue: enqueue, processDue: processDue, personalTargets: personalTargets, groupTargets: groupTargets, sendTo: sendTo,
}
