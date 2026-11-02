/// <reference path="../pb_data/types.d.ts" />
// Feishu/Lark as the human front door (optional adapter; API.md "Feishu adapter").
// Loaded with require() from ach_routes.pb.js (the "feishu" block) and
// ach_hooks.js (delivery target "feishu:<user id>"). ES5-style (goja).
//
// Without configuration nothing here runs: the routes answer 404 feishu_off,
// personal targets never include Feishu and no flow branches on it.
//
// Inbound (POST /api/ach/feishu/events, the app's event + card callback URL):
//  - the Encrypt Key is required: every body is AES-256-CBC encrypted (key =
//    SHA-256 of the Encrypt Key, IV = first 16 bytes) and every callback but
//    url_verification is signed: X-Lark-Signature = hex SHA-256(timestamp +
//    nonce + encrypt_key + raw body). The decrypted header.token must equal the
//    Verification Token and header.app_id this app. Event ids are deduped.
//  - im.message.receive_v1 (direct messages to the bot): stored as queued, the
//    200 goes out first, then the command runs (a cron retries leftovers).
//  - card.action.trigger (a button on a decision card): answered within the
//    3 s budget with a toast and the updated card (local work only).
// Identity: the operator/sender open_id of a verified callback maps to a person
// (admin-confirmed, the importer's users.feishu_open_id, or a Feishu directory
// email match); nothing in a message body or card value names who acts. A card
// value is additionally HMAC-bound to the person it was sent to.
// Everything a mapped person does here goes through the same routes as the
// panel, as that person (human, no admin overrides): an agent has no way in.
// Outbound: notifications to a mapped person's DM through the app bot (titles
// and links only; decision requests as interactive cards with their options).

var SETTINGS_KEY = "feishu"
var CARD_KEY = "feishu_card_key"
var TOKEN_STORE = "ach_feishu_tat"
var BASES = { feishu: "https://open.feishu.cn", lark: "https://open.larksuite.com" }
var MAX_SKEW_S = 3600
var RL_PER_MIN = 20
var LIST_MAX = 10
var EVENT_KEEP_MS = 7 * 24 * 3600 * 1000
var OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{5,90}$/
var MSG_ID_RE = /^om_[A-Za-z0-9_-]{5,90}$/

function LIB() { return require(__hooks + "/ach_lib.js") }
function L() { return LIB().wikiDeps() }
function N() { return require(__hooks + "/ach_notify.js") }
function AchError(status, code, message) { this.achError = true; this.status = status; this.code = code; this.message = message }
function E(status, code, message) { return new AchError(status, code, message) }
function str(v) { return v === undefined || v === null ? "" : String(v) }
function lower(s) { return str(s).trim().toLowerCase() }
function parseJSON(s) { if (!s) return null; try { return typeof s === "string" ? JSON.parse(s) : s } catch (err) { return null } }
function find(app, coll, filter, sort, limit, params) { return app.findRecordsByFilter(coll, filter, sort || "", limit || 1000, 0, params || {}) }
function byId(app, coll, id) { if (!id) return null; try { return app.findRecordById(coll, id) } catch (err) { return null } }
function iso(ms) { return new Date(ms).toISOString().replace("T", " ") }
function nowMs() { return Date.now() }
function oneLine(s, max) { return str(s).replace(/\s+/g, " ").trim().slice(0, max || 200) }
function publicUrl() { return str($os.getenv("ACH_PUBLIC_URL")).trim().replace(/\/+$/, "") }
function link(path) { return publicUrl() + "/#/" + path }
function userName(u) { var n = u.getString("name"); if (n) return n; var em = u.getString("email"); return em ? em.split("@")[0] : u.id }
function taskRef(t) { var n = t.getInt("seq"); return n > 0 ? "T-" + n : t.id }
function langOf(u) { return u && u.getString("lang") ? (u.getString("lang") === "zh" ? "zh" : "en") : (lower($os.getenv("ACH_DEFAULT_LANG")) === "zh" ? "zh" : "en") }
/** Constant-time string compare. */
function same(a, b) {
  a = str(a); b = str(b)
  if (!a || a.length !== b.length) return false
  var d = 0
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// ---------------------------------------------------------------- config

function settings(app) {
  var s = null
  try { s = L().readSetting(app, SETTINGS_KEY) } catch (err) {}
  return s && typeof s === "object" ? s : {}
}

/** Effective config: each field from env (ACH_FEISHU_*) when set, else from admin settings. */
function cfg(app) {
  var s = settings(app)
  var src = {}
  var pick = function (env, k) {
    var v = str($os.getenv(env)).trim()
    if (v) { src[k] = "env"; return v }
    v = str(s[k]).trim()
    src[k] = v ? "settings" : ""
    return v
  }
  var c = {
    app_id: pick("ACH_FEISHU_APP_ID", "app_id"),
    app_secret: pick("ACH_FEISHU_APP_SECRET", "app_secret"),
    verification_token: pick("ACH_FEISHU_VERIFICATION_TOKEN", "verification_token"),
    encrypt_key: pick("ACH_FEISHU_ENCRYPT_KEY", "encrypt_key"),
    region: lower(pick("ACH_FEISHU_REGION", "region")) === "lark" ? "lark" : "feishu",
    email_match: $os.getenv("ACH_FEISHU_EMAIL_MATCH") ? $os.getenv("ACH_FEISHU_EMAIL_MATCH") !== "0" : s.email_match !== false,
    // Only the directory's enterprise_email matches unless personal emails are allowed
    email_match_personal: $os.getenv("ACH_FEISHU_EMAIL_MATCH_PERSONAL") ? $os.getenv("ACH_FEISHU_EMAIL_MATCH_PERSONAL") === "1" : s.email_match_personal === true,
    tenant_key: str(s.tenant_key),
    src: src,
  }
  c.base = BASES[c.region]
  // tests point the API at a local stub; never in production
  if ($os.getenv("ACH_TEST_HOOKS") === "1" && $os.getenv("ACH_FEISHU_BASE_URL")) c.base = str($os.getenv("ACH_FEISHU_BASE_URL")).replace(/\/+$/, "")
  c.configured = !!(c.app_id && c.app_secret && c.verification_token && c.encrypt_key)
  c.ready = c.configured && !!publicUrl()
  return c
}

// ---------------------------------------------------------------- crypto (pure JS; goja has no AES-CBC)

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
function b64decode(s) {
  s = str(s).replace(/[\s=]+/g, "").replace(/-/g, "+").replace(/_/g, "/")
  if (!/^[A-Za-z0-9+\/]*$/.test(s)) return null
  var out = []
  var buf = 0, bits = 0
  for (var i = 0; i < s.length; i++) {
    buf = (buf << 6) | B64.indexOf(s[i])
    bits += 6
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff) }
  }
  return out
}
function hexBytes(h) { var o = []; for (var i = 0; i + 1 < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16)); return o }
/** Strict UTF-8: null on a truncated sequence, a bad continuation byte, an overlong form, a surrogate or > U+10FFFF. */
function utf8Decode(b) {
  var out = ""
  var cont = function (x) { return x !== undefined && (x & 0xc0) === 0x80 }
  for (var i = 0; i < b.length;) {
    var c = b[i++]
    var cp
    if (c < 0x80) cp = c
    else if (c >= 0xc2 && c < 0xe0) {
      if (!cont(b[i])) return null
      cp = ((c & 0x1f) << 6) | (b[i++] & 0x3f)
    } else if (c >= 0xe0 && c < 0xf0) {
      if (!cont(b[i]) || !cont(b[i + 1])) return null
      cp = ((c & 0x0f) << 12) | ((b[i] & 0x3f) << 6) | (b[i + 1] & 0x3f)
      i += 2
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) return null
    } else if (c >= 0xf0 && c < 0xf5) {
      if (!cont(b[i]) || !cont(b[i + 1]) || !cont(b[i + 2])) return null
      cp = ((c & 0x07) << 18) | ((b[i] & 0x3f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)
      i += 3
      if (cp < 0x10000 || cp > 0x10ffff) return null
    } else return null
    if (cp > 0xffff) { cp -= 0x10000; out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)) }
    else out += String.fromCharCode(cp)
  }
  return out
}

var SBOX = null, INV = null
function aesTables() {
  if (SBOX) return
  SBOX = []; INV = []
  var rotl = function (x, s) { return ((x << s) | (x >> (8 - s))) & 0xff }
  var p = 1, q = 1
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff
    if (q & 0x80) q ^= 0x09
    SBOX[p] = (q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63) & 0xff
  } while (p !== 1)
  SBOX[0] = 0x63
  for (var i = 0; i < 256; i++) INV[SBOX[i]] = i
}
function gmul(a, b) {
  var r = 0
  while (b) { if (b & 1) r ^= a; a = (a << 1) ^ (a & 0x80 ? 0x11b : 0); b >>= 1 }
  return r & 0xff
}
function expandKey(key) {
  var nk = key.length / 4, nr = nk + 6, w = []
  for (var i = 0; i < nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]])
  var rcon = 1
  for (var j = nk; j < 4 * (nr + 1); j++) {
    var t = w[j - 1].slice()
    if (j % nk === 0) {
      t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]
      rcon = gmul(rcon, 2)
    } else if (nk > 6 && j % nk === 4) t = [SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]]
    w.push([w[j - nk][0] ^ t[0], w[j - nk][1] ^ t[1], w[j - nk][2] ^ t[2], w[j - nk][3] ^ t[3]])
  }
  return { w: w, nr: nr }
}
function decryptBlock(ks, inp) {
  var s = inp.slice()
  var ark = function (round) { for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) s[r + 4 * c] ^= ks.w[round * 4 + c][r] }
  var invShiftSub = function () {
    var o = s.slice()
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) s[r + 4 * c] = INV[o[r + 4 * ((c - r + 4) % 4)]]
  }
  ark(ks.nr)
  for (var round = ks.nr - 1; round >= 1; round--) {
    invShiftSub()
    ark(round)
    for (var c = 0; c < 4; c++) {
      var a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3]
      s[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9)
      s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13)
      s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11)
      s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14)
    }
  }
  invShiftSub()
  ark(0)
  return s
}
/** Feishu "encrypt" field -> plaintext string, or null when it does not decrypt cleanly. */
function decrypt(encrypt, encryptKey) {
  aesTables()
  var buf = b64decode(encrypt)
  if (!buf || buf.length < 32 || buf.length % 16 !== 0) return null
  var ks = expandKey(hexBytes($security.sha256(str(encryptKey))))
  var prev = buf.slice(0, 16)
  var out = []
  for (var i = 16; i < buf.length; i += 16) {
    var blk = buf.slice(i, i + 16)
    var d = decryptBlock(ks, blk)
    for (var j = 0; j < 16; j++) out.push(d[j] ^ prev[j])
    prev = blk
  }
  var pad = out[out.length - 1]
  if (pad < 1 || pad > 16) return null
  for (var k = out.length - pad; k < out.length; k++) if (out[k] !== pad) return null
  return utf8Decode(out.slice(0, out.length - pad))
}
/** X-Lark-Signature of a callback: hex SHA-256(timestamp + nonce + encrypt_key + raw body). */
function signature(ts, nonce, encryptKey, raw) { return $security.sha256(str(ts) + str(nonce) + str(encryptKey) + str(raw)) }

function cardKey(app) {
  var k = null
  try { k = L().readSetting(app, CARD_KEY) } catch (err) {}
  if (typeof k === "string" && k.length >= 32) return k
  k = $security.randomString(48)
  L().writeSetting(app, CARD_KEY, k)
  return k
}
function cardSig(app, kind, req, opt, uid) { return $security.hs256(kind + "|" + req + "|" + opt + "|" + uid, cardKey(app)).slice(0, 32) }

// ---------------------------------------------------------------- Feishu API

function tenantToken(app, c, force) {
  var cached = parseJSON(app.store().get(TOKEN_STORE))
  if (!force && cached && cached.app_id === c.app_id && cached.base === c.base && cached.exp > nowMs() + 60000) return cached.token
  var res = $http.send({
    url: c.base + "/open-apis/auth/v3/tenant_access_token/internal", method: "POST", timeout: 8,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: c.app_id, app_secret: c.app_secret }),
  })
  var j = res.json || parseJSON(toString(res.body)) || {}
  if (res.statusCode !== 200 || j.code !== 0 || !j.tenant_access_token) throw E(502, "feishu_auth", "Feishu rejected the app credentials (code " + str(j.code) + ": " + oneLine(j.msg, 120) + ")")
  var exp = nowMs() + Math.max(60, (Number(j.expire) || 7200) - 120) * 1000
  app.store().set(TOKEN_STORE, JSON.stringify({ app_id: c.app_id, base: c.base, token: j.tenant_access_token, exp: exp }))
  return j.tenant_access_token
}

/** {ok, code, msg, data, status} for a Feishu Open API call (refreshes the token once on 99991663/99991661). */
function api(app, c, method, path, bodyObj) {
  var call = function (tok) {
    var res = $http.send({
      url: c.base + path, method: method, timeout: 8,
      headers: { "content-type": "application/json; charset=utf-8", authorization: "Bearer " + tok },
      body: bodyObj === undefined ? "" : JSON.stringify(bodyObj),
    })
    var j = res.json || parseJSON(toString(res.body)) || {}
    return { ok: res.statusCode >= 200 && res.statusCode < 300 && j.code === 0, code: j.code, msg: oneLine(j.msg, 200), data: j.data || {}, status: res.statusCode }
  }
  var r = call(tenantToken(app, c, false))
  if (!r.ok && (r.code === 99991663 || r.code === 99991661 || r.code === 99991668)) r = call(tenantToken(app, c, true))
  return r
}

function sendDm(app, c, openId, msgType, content) {
  return api(app, c, "POST", "/open-apis/im/v1/messages?receive_id_type=open_id", { receive_id: openId, msg_type: msgType, content: JSON.stringify(content) })
}
function replyMsg(app, c, messageId, text) {
  if (!MSG_ID_RE.test(str(messageId))) return { ok: false }
  return api(app, c, "POST", "/open-apis/im/v1/messages/" + messageId + "/reply", { msg_type: "text", content: JSON.stringify({ text: text }) })
}
/** The Feishu directory's emails for an open_id (needs contact:user.email:readonly). */
function contactEmails(app, c, openId) {
  try {
    var r = api(app, c, "GET", "/open-apis/contact/v3/users/" + openId + "?user_id_type=open_id")
    if (!r.ok || !r.data.user) return { emails: [], name: "" }
    var u = r.data.user
    // enterprise_email is set by the tenant admin; email is editable by the user
    var emails = [lower(u.enterprise_email)]
    if (c.email_match_personal) emails.push(lower(u.email))
    return { emails: emails.filter(function (x) { return x }), name: oneLine(u.name, 200), personal: lower(u.email) }
  } catch (err) {
    return { emails: [], name: "" }
  }
}
/** open_id for an email (contact v3 batch_get_id). */
function openIdForEmail(app, c, email) {
  var r = api(app, c, "POST", "/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id", { emails: [email] })
  if (!r.ok) throw E(502, "feishu_api", "Feishu lookup failed (code " + str(r.code) + ": " + r.msg + ")")
  var list = Array.isArray(r.data.user_list) ? r.data.user_list : []
  var hit = list.filter(function (x) { return lower(x.email) === lower(email) && x.user_id })[0]
  return hit ? str(hit.user_id) : ""
}

// ---------------------------------------------------------------- identity

function identityOut(app, r) {
  var u = byId(app, "users", r.getString("user"))
  return {
    id: r.id, open_id: r.getString("open_id"), name: r.getString("name"), email: r.getString("email"),
    user: r.getString("user"), user_name: u ? userName(u) : "", user_email: u ? u.getString("email") : "",
    how: r.getString("how"), status: r.getString("status"), last_seen: r.getString("last_seen"), created: r.getString("created"),
    wants_user: r.getString("wants_user"), wants_user_name: (function () { var w = byId(app, "users", r.getString("wants_user")); return w ? userName(w) : "" })(),
  }
}

function upsertIdentity(app, openId, f) {
  var r = find(app, "feishu_ids", "open_id = {:o}", "", 1, { o: openId })[0]
  if (!r) { r = new Record(app.findCollectionByNameOrId("feishu_ids")); r.set("open_id", openId); r.set("status", "pending") }
  for (var k in f) if (f[k] !== undefined) r.set(k, f[k])
  app.save(r)
  return r
}

/** The mapped identity row of a person, or null. */
function mappedRow(app, uid) {
  return find(app, "feishu_ids", "user = {:u} && status = 'mapped'", "-updated", 1, { u: uid })[0] || null
}

/**
 * Who a verified callback's sender is: {user} (an active mapped person),
 * {deactivated: true}, {blocked: true} or {} (unknown: recorded as pending).
 * lookup: may ask the Feishu directory for the sender's email (messages only).
 */
function resolve(app, c, sid, tenant, lookup) {
  var openId = str(sid && sid.open_id)
  if (!OPEN_ID_RE.test(openId)) return {}
  var unionId = oneLine(sid.union_id, 100)
  var now = iso(nowMs())
  var row = find(app, "feishu_ids", "open_id = {:o}", "", 1, { o: openId })[0] || null
  if (row && row.getString("status") === "blocked") return { blocked: true }
  var done = function (u) {
    if (u.getBool("deactivated")) return { deactivated: true }
    return { user: u, row: row }
  }
  if (row && row.getString("status") === "mapped") {
    var u = byId(app, "users", row.getString("user"))
    if (u) {
      if (row.getString("last_seen") < iso(nowMs() - 600000)) { row.set("last_seen", now); app.save(row) }
      return done(u)
    }
  }
  // the importer's users.feishu_open_id (set by an admin through `ach admin`)
  var imp = find(app, "users", "feishu_open_id = {:o}", "", 1, { o: openId })[0]
  if (imp) {
    row = upsertIdentity(app, openId, { user: imp.id, how: "import", status: "mapped", union_id: unionId, tenant_key: oneLine(tenant, 100), last_seen: now })
    return done(imp)
  }
  if (lookup && c.email_match) {
    var info = contactEmails(app, c, openId)
    for (var i = 0; i < info.emails.length; i++) {
      var cand = null
      try { cand = app.findAuthRecordByEmail("users", info.emails[i]) } catch (err) { cand = null }
      // one Feishu identity per person: an email match never replaces an existing mapping
      if (cand && !mappedRow(app, cand.id)) {
        // An admin is never mapped automatically; an admin confirms it
        if (cand.getBool("is_admin")) {
          var held = row && row.getString("wants_user") === cand.id
          row = upsertIdentity(app, openId, { status: "pending", wants_user: cand.id, email: info.emails[i], name: info.name, union_id: unionId, tenant_key: oneLine(tenant, 100), last_seen: now })
          if (!held) logMapping(app, "held for admin approval: " + (info.name || openId) + " <" + info.emails[i] + "> matches admin " + userName(cand), cand.id)
          return { held: true }
        }
        row = upsertIdentity(app, openId, { user: cand.id, how: "email", status: "mapped", email: info.emails[i], name: info.name, union_id: unionId, tenant_key: oneLine(tenant, 100), last_seen: now })
        logMapping(app, "mapped by email: " + (info.name || openId) + " <" + info.emails[i] + "> → " + userName(cand), cand.id)
        return done(cand)
      }
    }
    row = upsertIdentity(app, openId, { status: "pending", email: info.emails[0] || "", name: info.name || (row ? row.getString("name") : ""), union_id: unionId, tenant_key: oneLine(tenant, 100), last_seen: now })
    return heldOf(row)
  }
  return heldOf(upsertIdentity(app, openId, { union_id: unionId, tenant_key: oneLine(tenant, 100), last_seen: now }))
}
/** A pending row that matched an admin is waiting for an admin to confirm it (not "unknown"). */
function heldOf(row) {
  return row && row.getString("status") === "pending" && row.getString("wants_user") ? { held: true } : {}
}

/** Every mapping change is an Updates item for each admin (no push). */
function logMapping(app, line, uid) {
  try {
    var admins = find(app, "users", "is_admin = true && deactivated = false", "", 100, {})
    var reasons = {}, skip = {}
    admins.forEach(function (a) { reasons[a.id] = "admin"; skip[a.id] = true })
    if (!admins.length) return
    N().emit(app, {
      key: "feishu_map:" + $security.randomString(12), event: "feishu_mapping", channel: "", title: oneLine(line, 300),
      path: "admin", reasons: reasons, pushSkip: skip, noBroadcast: true, important: false, detail: uid ? "user " + uid : "",
    })
  } catch (err) { app.logger().warn("ach feishu mapping log failed", "error", String(err)) }
}

/** Per-sender limit: RL_PER_MIN callbacks a minute. */
function limited(app, openId) {
  var key = "ach_feishu_rl:" + openId
  var minute = Math.floor(nowMs() / 60000)
  var cur = parseJSON(app.store().get(key)) || {}
  if (cur.m !== minute) cur = { m: minute, n: 0 }
  cur.n++
  app.store().set(key, JSON.stringify(cur))
  return cur.n > RL_PER_MIN ? (cur.n === RL_PER_MIN + 1 ? "first" : "again") : ""
}

// ---------------------------------------------------------------- words

var T = {
  en: {
    unknown: "You are not on this AgentChannel team yet. Ask your admin for an invite.",
    deactivated: "Your AgentChannel account is deactivated. Ask your admin.",
    limited: "Too many messages; wait a minute.",
    help: "AgentChannel commands:\n- inbox: what waits for you (numbered)\n- reply <n> <text>: reply to item n of the last inbox list\n- post #channel <text>: post in a channel (@agent wakes that agent)\n- follow T-12 / unfollow T-12\nOr reply in the thread of a notification to answer it.\nPanel: ",
    empty: "Nothing waits for you. Panel: ",
    inbox: "Waiting for you:",
    list_first: "Send \"inbox\" first, then \"reply <n> <text>\".",
    no_item: "There is no item {n} in your last inbox list. Send \"inbox\" again.",
    recorded: "Recorded as your reply: ",
    posted: "Posted: ",
    following: "Following {ref}. ",
    unfollowed: "No longer following {ref}. ",
    failed: "Not recorded: ",
    thread_none: "That message is not something you can reply to here. Send \"help\".",
    decision: "Decision needed", answered: "Answered", chosen: "You chose: {x} (via Feishu)", already: "Already answered; nothing was recorded.",
    closed: "This request is closed; nothing was recorded.", gone: "This request no longer exists.", not_yours: "This card is for someone else; nothing was recorded.",
    open_panel: "Open panel", card_hint: "A button replies as you. You can also reply in this thread.", rec: " (Recommended)",
    kinds: { decision: "decide", assigned: "new task", escalation: "question", mention: "mention", reply: "reply", assigned_external: "GitHub" },
    invite: "{admin} invited you to AgentChannel. Open this one-time link within 24 hours: {url}",
    answered_by: "{name} already chose: {x}", answered_line: "{name} chose: {x}",
    answered_short: "{name} already chose {x}", sep: "; ", already_short: "This was already answered; ",
    late_noted: "your words were saved as a note.", late_forbidden: "your words were not saved: only members of the task's channel may leave notes.",
    late_closed: "the task is closed, so notes are no longer accepted; your words were not saved.",
    admin_held: "Your Feishu account needs an admin to confirm it before you can use it (admin accounts are never linked automatically). The admins have been notified.",
    noted: "Saved as your note on {ref} (not a decision): {url}\nTo decide, reply with the option letter (A/B/…) or tap a button.",
    short: "You can say: inbox / login / post #channel … / reply n …  (help: all commands)",
    login: "Your one-time login link (10 minutes, works once): {url}",
    no_channel: "There is no channel #{ch} you can post in.", your_channels: " Your channels: ",
    no_agent: "\nNote: there is no agent called @{x}.", did_you_mean: " Did you mean @{y}?",
    report: "Open report", options: "Options:",
    err: { forbidden: "You are not allowed to do that here.", not_found: "Not found (it does not exist or you cannot see it).", invalid: "That did not look right: ", resolved: "Already answered.", terminal: "This task is already closed.", rate_limited: "Too many requests; wait a minute.", deactivated: "Your account is deactivated.", not_member: "That person is not in this channel.", error: "Something went wrong; try again or use the panel." },
  },
  // Chinese localization (selected by the person's lang, else the language they wrote in)
  zh: {
    unknown: "你还不在这个 AgentChannel 团队里，请找管理员要邀请。",
    deactivated: "你的 AgentChannel 账号已停用，请联系管理员。",
    limited: "消息太多了，请稍等一分钟。",
    help: "AgentChannel 指令：\n- 收件箱：等你处理的事（带编号）\n- 回复 <编号> <内容>：回复上一份收件箱里的第 n 条\n- 发到 #频道 <内容>：在频道发帖（@智能体 会叫醒它）\n- 关注 T-12 / 取消关注 T-12\n也可以直接在通知消息下回复来作答。\n面板：",
    empty: "没有等你处理的事。面板：",
    inbox: "等你处理：",
    list_first: "先发「收件箱」，再发「回复 <编号> <内容>」。",
    no_item: "上一份收件箱里没有第 {n} 条，请重新发「收件箱」。",
    recorded: "已记录为你的回复：",
    posted: "已发出：",
    following: "已关注 {ref}。",
    unfollowed: "已取消关注 {ref}。",
    failed: "没有记录：",
    thread_none: "这条消息不能在这里回复。发「帮助」看指令。",
    decision: "需要你决定", answered: "已回复", chosen: "你选择了：{x}（通过飞书）", already: "已经有人回复过了，这次没有记录。",
    closed: "这个请求已关闭，没有记录。", gone: "这个请求已不存在。", not_yours: "这张卡片是发给别人的，没有记录。",
    open_panel: "打开面板", card_hint: "点按钮即以你的名义回复；也可以在本消息下直接回复文字。", rec: "（推荐）",
    kinds: { decision: "决定", assigned: "新任务", escalation: "问题", mention: "提到", reply: "回复", assigned_external: "GitHub" },
    invite: "{admin} 邀请你加入 AgentChannel。请在 24 小时内打开这个一次性链接：{url}",
    answered_by: "已由 {name} 选择了 {x}", answered_line: "已由 {name} 选择了 {x}",
    answered_short: "这个已由 {name} 选了 {x}", sep: "；", already_short: "这个已经有人回复过了；",
    late_noted: "你的话已记为备注。", late_forbidden: "你的话没有记录：只有这个任务所在频道的成员才能留备注。",
    late_closed: "这个任务已结束，不能再留备注，你的话没有记录。",
    admin_held: "你的飞书账号需要管理员确认后才能使用（管理员账号不会自动关联）。已通知管理员。",
    noted: "已记为你在 {ref} 上的备注（不是决定）：{url}\n要做决定，请回复选项字母（A/B/…）或点卡片按钮。",
    short: "可以说：收件箱 / 登录 / 发到 #频道 … / 回复 n …（发「帮助」看全部）",
    login: "你的一次性登录链接（10 分钟内有效，只能用一次）：{url}",
    no_channel: "没有你能发帖的频道 #{ch}。", your_channels: "你的频道：",
    no_agent: "\n注意：没有叫 @{x} 的智能体。", did_you_mean: "你是说 @{y} 吗？",
    report: "看报告", options: "选项：",
    err: { forbidden: "你没有权限在这里这样做。", not_found: "没找到（不存在，或者你看不到）。", invalid: "格式不对：", resolved: "已经有人回复过了。", terminal: "这个任务已经结束了。", rate_limited: "太频繁了，请稍等一分钟。", deactivated: "你的账号已停用。", not_member: "这个人不在这个频道里。", error: "出错了，请重试或打开面板。" },
  },
}
function tr(lang, k, vars) {
  var s = (T[lang] || T.en)[k]
  for (var v in (vars || {})) s = s.replace("{" + v + "}", vars[v])
  return s
}
/** The person's own language when set, else the language of what they wrote. */
function textLang(u, text) {
  if (u && u.getString("lang")) return langOf(u)
  return /[㐀-鿿]/.test(str(text)) ? "zh" : /^[\x00-\x7f]+$/.test(str(text)) && str(text).trim() ? "en" : langOf(u)
}
/** A route error in the person's language. */
function errText(lang, r) {
  var tb = (T[lang] || T.en).err
  var k = r && r.code
  var msg = tb[k] || tb.error
  if (k === "invalid" && lang !== "zh") msg += oneLine(r.error, 160)
  else if (k === "invalid") msg = msg.replace(/：$/, "。")
  return tr(lang, "failed") + msg
}

// ---------------------------------------------------------------- outbound: notifications + decision cards

/** Money only when the label does not already say it. */
function moneyPart(o) {
  var m = oneLine(o.money, 40)
  if (!m) return ""
  var bare = m.replace(/\s+/g, "")
  return str(o.label).replace(/\s+/g, "").indexOf(bare) >= 0 ? "" : " · " + m
}
/** Option text: label · money + recommended mark. */
function optionLabel(o, lang) {
  return oneLine(o.label, 80) + moneyPart(o) + (o.recommended ? tr(lang, "rec") : "")
}
/** The asking agent's newest top-level post in the task's channel since the task began (its report), or "". */
function reportUrl(app, msg) {
  try {
    if (!msg.message_id || !msg.task_id) return ""
    var m = byId(app, "messages", msg.message_id)
    var t = byId(app, "tasks", msg.task_id)
    if (!m || !t || !m.getString("author_agent")) return ""
    var p = find(app, "posts", "author_agent = {:a} && channel = {:c} && parent = '' && kind != 'task' && created >= {:s}", "-created", 1, { a: m.getString("author_agent"), c: t.getString("channel"), s: t.getString("created") })[0]
    return p ? link("p/" + p.id) : ""
  } catch (err) { return "" }
}

function decisionCard(app, uid, msg, lang) {
  var kind = msg.message_id ? "task" : "post"
  var req = msg.message_id || msg.post_id
  // the recommended option first, then the rest in their order
  var opts = msg.options.slice().sort(function (a, b) { return (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0) })
  var buttons = opts.map(function (o) {
    return {
      tag: "button", type: o.recommended ? "primary" : "default",
      text: { tag: "plain_text", content: optionLabel(o, lang) },
      value: { ach: "d", k: kind, r: req, o: o.option, u: uid, s: cardSig(app, kind, req, o.option, uid) },
    }
  })
  buttons.push({ tag: "button", type: "default", text: { tag: "plain_text", content: tr(lang, "open_panel") }, url: msg.url })
  var rep = reportUrl(app, msg)
  if (rep) buttons.push({ tag: "button", type: "default", text: { tag: "plain_text", content: tr(lang, "report") }, url: rep })
  // each option with its detail (what the button alone cannot say)
  var details = opts.map(function (o, i) {
    var L0 = String.fromCharCode(65 + i)
    return (new RegExp("^" + L0 + "[\\s.、:：]").test(str(o.label)) ? "" : L0 + ". ") + oneLine(o.label, 80) + (o.recommended ? tr(lang, "rec") : "") + (o.detail ? " — " + oneLine(o.detail, 200) : "") + moneyPart(o)
  }).join("\n")
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: "orange", title: { tag: "plain_text", content: tr(lang, "decision") } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: oneLine(msg.title, 300) } },
      msg.question ? { tag: "div", text: { tag: "plain_text", content: oneLine(msg.question, 500) } } : null,
      { tag: "div", text: { tag: "plain_text", content: tr(lang, "options") + "\n" + details } },
      { tag: "action", actions: buttons },
      { tag: "note", elements: [{ tag: "plain_text", content: tr(lang, "card_hint") }] },
    ].filter(function (x) { return x }),
  }
}

/** The card after an answer: no option buttons, a line saying what happened, the panel button. */
function settledCard(card, line, url, lang) {
  var c = card && typeof card === "object" ? JSON.parse(JSON.stringify(card)) : { config: { wide_screen_mode: true, update_multi: true }, elements: [] }
  c.header = { template: "green", title: { tag: "plain_text", content: tr(lang, "answered") } }
  var els = (c.elements || []).filter(function (e) { return e.tag !== "action" && e.tag !== "note" })
  els.push({ tag: "div", text: { tag: "plain_text", content: line } })
  if (url) els.push({ tag: "action", actions: [{ tag: "button", type: "default", text: { tag: "plain_text", content: tr(lang, "open_panel") }, url: url }] })
  c.elements = els
  return c
}

/** What an item notification points at (for replies in its thread). */
function evTarget(app, msg) {
  var o = { kind: "other", task: "", post: "", request: "" }
  if (msg.decision) {
    o.kind = "card"
    o.task = str(msg.task_id)
    o.post = str(msg.post_id)
    o.request = str(msg.message_id || msg.post_id)
    return o
  }
  var ev = msg.kind === "single" ? byId(app, "notify_events", str(msg.id)) : null
  if (!ev) {
    if (msg.post_id) { o.kind = "post"; o.post = str(msg.post_id) }
    else if (msg.task_id) { o.kind = "task"; o.task = str(msg.task_id) }
    return o
  }
  var path = ev.getString("path")
  if (/^p\/[a-z0-9]{15}$/.test(path)) { o.kind = "post"; o.post = path.slice(2) }
  else if (ev.getString("target_kind") === "task" && ev.getString("target_id")) { o.kind = "task"; o.task = ev.getString("target_id") }
  return o
}

/** sendNotes (ach_lib.js): an older-style task note (received, completed, escalated...) for a mapped person. */
function queueNote(app, n, text, url, lang) {
  if (!n || !n.to_user || n.event === "decision_request" || n.event === "memory_question") return
  var u = byId(app, "users", n.to_user)
  var target = targetFor(app, u)
  if (!target) return
  var msg = { kind: "single", id: "note-" + str(n.message_id || n.task_id || n.post_id) + "-" + n.event, event: n.event, text: text, title: (n.ref ? n.ref + " " : "") + oneLine(n.title, 200), url: url, lang: lang, task_id: str(n.task_id), post_id: str(n.post_id) }
  require(__hooks + "/ach_hooks.js").enqueue(app, target, msg, "")
  try { app.store().set("ach_notify_dirty", "1") } catch (err) {}
}

function plainText(msg) {
  try { return require(__hooks + "/ach_hooks.js").plainText(msg) } catch (err) { return "[AgentChannel] " + oneLine(msg.title, 300) + "\n" + str(msg.url) }
}

/** Personal target "feishu:<uid>" when the adapter is ready and the person is mapped. */
function targetFor(app, u) {
  if (!u || u.getBool("deactivated")) return ""
  if (!cfg(app).ready) return ""
  return mappedRow(app, u.id) ? "feishu:" + u.id : ""
}

/** Delivery (ach_hooks.js sendTo): one message to a person's Feishu DM. {ok, status, error, gone} */
function deliver(app, uid, msg, nowS) {
  var c = cfg(app)
  if (!c.ready) return { ok: false, gone: true, error: "Feishu adapter not configured" }
  var u = byId(app, "users", uid)
  var row = u && !u.getBool("deactivated") ? mappedRow(app, uid) : null
  if (!row) return { ok: false, gone: true, error: "not mapped to Feishu" }
  var lang = msg.lang === "zh" ? "zh" : langOf(u)
  if (msg.kind === "settle") return settleOne(app, c, msg.fm)
  var r, card = null
  if (msg.kind === "single" && msg.decision && Array.isArray(msg.options) && msg.options.length) {
    card = decisionCard(app, uid, msg, lang)
    r = sendDm(app, c, row.getString("open_id"), "interactive", card)
  } else {
    // a report/announcement in a private channel: this member's own DM may carry a short excerpt
    var ex = msg.kind === "single" && !msg.decision ? N().memberExcerpt(app, msg.id, u) : ""
    var m2 = msg
    if (ex) { m2 = {}; for (var k in msg) m2[k] = msg[k]; m2.title = str(msg.title) + (msg.lang === "zh" ? "：" : ": ") + ex }
    r = sendDm(app, c, row.getString("open_id"), "text", { text: plainText(m2) })
  }
  if (!r.ok) {
    // 230013: the bot is not available to this user; 230006: the bot is off
    return { ok: false, status: r.status, gone: r.code === 230013 || r.code === 99992361, error: "Feishu " + str(r.code) + ": " + r.msg }
  }
  var mid = str(r.data.message_id)
  if (MSG_ID_RE.test(mid) && msg.kind !== "test") {
    var tg = evTarget(app, msg)
    var fm = new Record(app.findCollectionByNameOrId("feishu_messages"))
    fm.set("message_id", mid)
    fm.set("user", uid)
    fm.set("kind", tg.kind)
    fm.set("task", tg.task)
    fm.set("post", tg.post)
    fm.set("request", tg.request)
    if (card) fm.set("card", card)
    app.save(fm)
  }
  return { ok: true, status: r.status }
}

// ---------------------------------------------------------------- cards settle when answered anywhere

/** The settled line for a request state: "X chose: Y" (localized). */
function answeredLine(st, lang) {
  if (st && st.answered_by) return tr(lang, "answered_line", { name: st.answered_by, x: oneLine(st.answer, 120) })
  return tr(lang, "already")
}

/**
 * A decision request (task message id or question post id) was answered:
 * every unsettled card sent for it is updated in place (through the delivery
 * queue: retries, never inside the answering transaction).
 */
function onAnswered(app, requestIds) {
  try {
    if (!cfg(app).ready) return
    var n = 0
    requestIds.filter(function (x) { return /^[a-z0-9]{15}$/.test(str(x)) }).forEach(function (rid) {
      find(app, "feishu_messages", "request = {:r} && kind = 'card' && settled = false", "", 100, { r: rid }).forEach(function (fm) {
        require(__hooks + "/ach_hooks.js").enqueue(app, "feishu:" + fm.getString("user"), { kind: "settle", fm: fm.id, id: "settle-" + fm.id }, "")
        n++
      })
    })
    if (n) app.store().set("ach_notify_dirty", "1")
  } catch (err) { app.logger().warn("ach feishu settle enqueue failed", "error", String(err)) }
}

/** A record hook: a human decision on a task request, or a human reply in a question's thread. */
function onRecord(app, coll, rec) {
  if (coll === "messages") {
    if (rec.getString("kind") === "decision" && rec.getString("reply_to")) onAnswered(app, [rec.getString("reply_to")])
    return
  }
  if (coll === "posts" && rec.getString("author_type") === "human") {
    var root = rec.getString("parent")
    if (!root) return
    var ids = [root]
    find(app, "posts", "parent = {:r} && to_user != ''", "", 50, { r: root }).forEach(function (x) { ids.push(x.id) })
    onAnswered(app, ids)
  }
}

function settleOne(app, c, fmId) {
  var fm = byId(app, "feishu_messages", fmId)
  if (!fm || fm.getBool("settled")) return { ok: true }
  var u = byId(app, "users", fm.getString("user"))
  var lang = langOf(u)
  var req = fm.getString("request")
  var st = N().decisionState(app, fm.getString("task") ? { kind: "task", message_id: req } : { kind: "post", post_id: req }, fm.getString("user"))
  if (st && st.open) return { ok: true }
  var url = link("inbox")
  var t = fm.getString("task") ? byId(app, "tasks", fm.getString("task")) : null
  if (t) url = link("t/" + taskRef(t) + "/m/" + req)
  else if (fm.getString("post")) url = link("p/" + req)
  var card = settledCard(parseJSON(fm.getString("card")), st ? answeredLine(st, lang) : tr(lang, "gone"), url, lang)
  var r = api(app, c, "PATCH", "/open-apis/im/v1/messages/" + fm.getString("message_id"), { content: JSON.stringify(card) })
  if (!r.ok) return { ok: false, status: r.status, gone: r.code === 230001 || r.code === 230011, error: "Feishu " + str(r.code) + ": " + r.msg }
  fm.set("settled", true)
  app.save(fm)
  return { ok: true, status: r.status }
}

// ---------------------------------------------------------------- inbound

function rawBody(e) {
  try { return toString(e.request.body) } catch (err) { return "" }
}
function hdr(e, k) { return str(e.request.header.get(k)).trim() }

var UNSIGNED_MAX = 1024

/**
 * Verify and open a callback: {body} | {challenge} | {status, code, error}.
 * The signature is checked before anything is decrypted. Only a
 * small body (<= 1 KB) may come unsigned, and only a url_verification (which
 * changes nothing) is accepted that way. Every refusal of an unsigned body has
 * the same answer (no padding/format oracle).
 */
function openCallback(e, app, c) {
  var raw = rawBody(e)
  var outer = parseJSON(raw)
  if (!outer || typeof outer !== "object") return { status: 400, code: "bad_json", error: "body must be JSON" }
  if (typeof outer.encrypt !== "string") return { status: 400, code: "encryption_required", error: "set an Encrypt Key in the Feishu app; plain callbacks are refused" }
  var ts = hdr(e, "X-Lark-Request-Timestamp"), nonce = hdr(e, "X-Lark-Request-Nonce"), sig = lower(hdr(e, "X-Lark-Signature"))
  var badEnc = { status: 400, code: "bad_encrypt", error: "the body does not decrypt with this Encrypt Key" }
  if (!sig) {
    if (raw.length > UNSIGNED_MAX) return { status: 401, code: "bad_signature", error: "signature required" }
    var pv = parseJSON(decrypt(outer.encrypt, c.encrypt_key))
    if (!pv || typeof pv !== "object") return badEnc
    if (pv.type !== "url_verification") return { status: 401, code: "bad_signature", error: "signature required" }
    if (!same(pv.token, c.verification_token)) return { status: 403, code: "bad_token", error: "verification token mismatch" }
    return { challenge: str(pv.challenge) }
  }
  if (!ts || !nonce || !same(sig, signature(ts, nonce, c.encrypt_key, raw))) return { status: 401, code: "bad_signature", error: "signature does not match" }
  var tsn = parseInt(ts, 10)
  if (!(tsn > 0) || Math.abs(Math.floor(nowMs() / 1000) - tsn) > MAX_SKEW_S) return { status: 401, code: "stale", error: "timestamp too old" }
  var b = parseJSON(decrypt(outer.encrypt, c.encrypt_key))
  if (!b || typeof b !== "object") return badEnc
  if (b.type === "url_verification") {
    if (!same(b.token, c.verification_token)) return { status: 403, code: "bad_token", error: "verification token mismatch" }
    return { challenge: str(b.challenge) }
  }
  var h = b.header || {}
  if (b.schema !== "2.0" || !same(h.token, c.verification_token)) return { status: 403, code: "bad_token", error: "verification token mismatch" }
  // The app id is required, and the tenant is pinned on first use
  if (str(h.app_id) !== c.app_id) return { status: 403, code: "bad_app", error: "callback for another app" }
  var tk = str(h.tenant_key)
  if (!tk || tk.length > 100) return { status: 403, code: "bad_tenant", error: "tenant_key missing" }
  if (!c.tenant_key) pinTenant(app, tk)
  else if (!same(tk, c.tenant_key)) return { status: 403, code: "bad_tenant", error: "callback from another Feishu tenant" }
  if (!str(h.event_id) || str(h.event_id).length > 200) return { status: 400, code: "invalid", error: "event_id missing" }
  return { body: b }
}

function pinTenant(app, tk) {
  var s = settings(app)
  if (s.tenant_key) return
  s.tenant_key = tk
  L().writeSetting(app, SETTINGS_KEY, s)
  logMapping(app, "tenant pinned: " + tk, "")
}

function saveEvent(app, b, status, openId) {
  var r = new Record(app.findCollectionByNameOrId("feishu_events"))
  r.set("event_id", str(b.header.event_id))
  r.set("event_type", oneLine(b.header.event_type, 100))
  r.set("open_id", oneLine(openId, 100))
  r.set("status", status)
  r.set("payload", b)
  app.save(r)
  return r
}
function finishEvent(app, id, status, result) {
  var r = byId(app, "feishu_events", id)
  if (!r) return
  r.set("status", status)
  r.set("result", result || {})
  app.save(r)
}

/** POST /api/ach/feishu/events: event subscription + card callback URL. */
function handleEvents(e) {
  var app = e.app
  var c = cfg(app)
  if (!c.ready) return e.json(404, { code: "feishu_off", error: "the Feishu adapter is not configured" })
  var o = openCallback(e, app, c)
  if (o.challenge !== undefined) return e.json(200, { challenge: o.challenge })
  if (!o.body) return e.json(o.status, { code: o.code, error: o.error })
  var b = o.body
  var type = str(b.header.event_type)
  var prior = find(app, "feishu_events", "event_id = {:i}", "", 1, { i: str(b.header.event_id) })[0]
  if (type === "card.action.trigger") {
    if (prior) {
      // a retry of the same click: the same answer, never a second reply
      var pr = parseJSON(prior.getString("result")) || {}
      return e.json(200, pr.response || {})
    }
    var op = (b.event && b.event.operator) || {}
    var row = null
    try { row = saveEvent(app, b, "working", op.open_id) } catch (err) { return e.json(200, {}) } // a parallel retry got there first
    var resp
    try {
      resp = cardAction(app, c, b)
    } catch (err) {
      app.logger().error("ach feishu card failed", "error", String(err))
      resp = { toast: { type: "error", content: "error" } }
    }
    finishEvent(app, row.id, "done", { response: resp })
    return e.json(200, resp)
  }
  if (prior) return e.json(200, {})
  if (type !== "im.message.receive_v1") {
    try { saveEvent(app, b, "ignored", "") } catch (err) {}
    return e.json(200, {})
  }
  var sender = (b.event && b.event.sender) || {}
  var sid = sender.sender_id || {}
  var queued
  try { queued = saveEvent(app, b, "queued", sid.open_id) } catch (err) { return e.json(200, {}) }
  // answer Feishu first (its 3 s budget), then do the work in this request
  e.response.header().set("Content-Type", "application/json")
  e.response.header().set("Content-Length", "2")
  e.string(200, "{}")
  try { e.flush() } catch (err) {}
  try { processMessage(app, queued.id) } catch (err) { app.logger().error("ach feishu message failed", "error", String(err)) }
  return null
}

/** Work a queued message event once (claimed by an UPDATE so the cron and the request never both run it). */
function processMessage(app, rowId) {
  var res = app.db().newQuery("UPDATE feishu_events SET status = 'working' WHERE id = {:id} AND status = 'queued'").bind({ id: rowId }).execute()
  if (res.rowsAffected() !== 1) return
  var row = app.findRecordById("feishu_events", rowId)
  var b = parseJSON(row.getString("payload")) || {}
  var c = cfg(app)
  var ev = b.event || {}
  var sender = ev.sender || {}
  var msg = ev.message || {}
  // only people, only direct messages to the bot
  if (sender.sender_type !== "user" || msg.chat_type !== "p2p" || !c.ready) return finishEvent(app, rowId, "ignored", { why: "not a direct message from a person" })
  var openId = str(sender.sender_id && sender.sender_id.open_id)
  var rl = limited(app, openId)
  if (rl) {
    if (rl === "first") replyMsg(app, c, msg.message_id, tr("zh", "limited") + "\n" + tr("en", "limited"))
    return finishEvent(app, rowId, "ignored", { why: "rate limited" })
  }
  var text = ""
  if (msg.message_type === "text") text = str((parseJSON(msg.content) || {}).text)
  text = text.replace(/@_user_\d+/g, " ").replace(/ /g, " ").trim()
  var who = resolve(app, c, sender.sender_id, b.header && b.header.tenant_key, true)
  if (!who.user) {
    var lang0 = /[㐀-鿿]/.test(text) || !text ? "zh" : "en"
    if (!who.blocked) replyMsg(app, c, msg.message_id, tr(lang0, who.deactivated ? "deactivated" : who.held ? "admin_held" : "unknown"))
    return finishEvent(app, rowId, "done", { result: who.deactivated ? "deactivated" : who.blocked ? "blocked" : who.held ? "held" : "unknown" })
  }
  var out
  try {
    out = command(app, c, who, msg, text)
  } catch (err) {
    app.logger().error("ach feishu command failed", "error", String(err))
    out = { text: errText(textLang(who.user, text), { code: "error" }), result: "error" }
  }
  if (out.text) replyMsg(app, c, msg.message_id, out.text)
  finishEvent(app, rowId, "done", { result: out.result || "" })
}

// ---------------------------------------------------------------- commands

// Command words: English, plus Chinese equivalents (language support for Chinese input,
// including full-width punctuation such as "＃" and "：").
var RE_INBOX = /^(收件箱|待办|inbox|todo)$/i
var RE_REPLY = /^(回复|reply)\s*(\d{1,2})\s*[\s:：，,]\s*([\s\S]+)$/i
// "post build-stats …", "post#build-stats …", and the Chinese form with full-width "#" and ":" all post
var RE_POST = /^(发到|发送到|发去|post(?:\s+to)?)\s*[#＃]?\s*([^\s#＃:：，,]{1,80})\s*[\s:：，,]\s*([\s\S]+)$/i
var RE_FOLLOW = /^(关注|follow)\s*((?:T-?)?\d{1,9})$/i
var RE_UNFOLLOW = /^(取消关注|unfollow)\s*((?:T-?)?\d{1,9})$/i
var RE_LOGIN = /^(登录|登陆|面板|打开面板|login|log\s*in|panel|sign\s*in)$/i
var RE_HELP = /^(帮助|help|指令|命令|\?|？|menu|菜单)$/i

/** A channel the person may post in by name, title, any case, with or without "#" and dashes. */
function channelFor(app, ctx, ref) {
  var want = lower(ref).replace(/^[#＃]/, "")
  if (!want) return null
  var squash = function (x) { return lower(x).replace(/[\s_-]+/g, "") }
  var all = find(app, "channels", "archived = false", "created", 1000, {}).filter(function (c) { return !LIB().wikiDeps().channelHidden(ctx, c.id) })
  var by = function (f) { var h = all.filter(f); return h.length === 1 ? h[0] : null }
  return by(function (c) { return lower(c.getString("name")) === want })
    || by(function (c) { return lower(c.getString("title")) === want })
    || by(function (c) { return squash(c.getString("name")) === squash(want) })
    || by(function (c) { return squash(c.getString("title")) === squash(want) })
}

function editDistance(a, b) {
  var d = []
  for (var i = 0; i <= a.length; i++) { d[i] = [i]; for (var j = 1; j <= b.length; j++) d[i][j] = i === 0 ? j : 0 }
  for (var i2 = 1; i2 <= a.length; i2++) for (var j2 = 1; j2 <= b.length; j2++) {
    d[i2][j2] = Math.min(d[i2 - 1][j2] + 1, d[i2][j2 - 1] + 1, d[i2 - 1][j2 - 1] + (a[i2 - 1] === b[j2 - 1] ? 0 : 1))
  }
  return d[a.length][b.length]
}

/** Warnings for @names in a post that are no agent ("there is no agent called @databot. Did you mean @data-bot?"). */
function unknownMentions(app, lang, text) {
  var names = find(app, "agents", "active = true", "", 2000, {}).map(function (a) { return lower(a.getString("name")) })
  var seen = {}
  var out = ""
  var re = /(^|[^A-Za-z0-9_.\/-])@([A-Za-z0-9][A-Za-z0-9_-]{0,40})/g
  var m
  while ((m = re.exec(str(text)))) {
    var n = lower(m[2])
    if (seen[n] || names.indexOf(n) >= 0) continue
    seen[n] = true
    var best = "", bd = 99
    names.forEach(function (x) {
      var dd = editDistance(n.replace(/[-_]/g, ""), x.replace(/[-_]/g, ""))
      if (dd < bd) { bd = dd; best = x }
    })
    out += tr(lang, "no_agent", { x: m[2] }) + (best && bd <= Math.max(2, Math.floor(n.length / 3)) ? tr(lang, "did_you_mean", { y: best }) : "")
  }
  return out
}

function command(app, c, who, msg, text) {
  var u = who.user
  var lang = textLang(u, text)
  var ctx = LIB().humanCtx(app, u)
  var parentId = str(msg.parent_id) || str(msg.root_id)
  if (parentId && MSG_ID_RE.test(parentId)) {
    // a reply in the thread of a bot message: answers that item, as this person
    var fm = find(app, "feishu_messages", "message_id = {:m} || message_id = {:r}", "", 1, { m: str(msg.parent_id), r: str(msg.root_id) })[0]
    if (fm && fm.getString("user") === u.id && text) return answerItem(app, ctx, lang, fm, text)
    if (fm && fm.getString("user") !== u.id) return { text: tr(lang, "not_yours"), result: "not_yours" }
  }
  // a command word may carry trailing punctuation, ASCII or full-width ("follow T-1.")
  var cmd = text.replace(/[。．.!！?？~～\s]+$/, "").trim() || text
  var m
  if (RE_INBOX.test(cmd)) return inbox(app, ctx, who, lang)
  if (RE_LOGIN.test(cmd)) {
    var ll = LIB().chatLoginLink(app, u, "feishu")
    return { text: tr(lang, "login", { url: ll.url }), result: "login" }
  }
  if (RE_HELP.test(cmd)) return { text: tr(lang, "help") + link("inbox"), result: "help" }
  if ((m = RE_REPLY.exec(text))) {
    var list = parseJSON(who.row ? who.row.getString("last_list") : "") || null
    if (!Array.isArray(list)) return { text: tr(lang, "list_first"), result: "no_list" }
    var it = list[parseInt(m[2], 10) - 1]
    if (!it) return { text: tr(lang, "no_item", { n: m[2] }), result: "no_item" }
    return replyItem(app, ctx, lang, it, m[3].trim())
  }
  if ((m = RE_POST.exec(text))) {
    var ch = channelFor(app, ctx, m[2])
    if (!ch) {
      var mine = find(app, "channels", "archived = false", "created", 1000, {}).filter(function (x) { return !LIB().wikiDeps().channelHidden(ctx, x.id) && (x.getString("visibility") !== "private" || arr0(x.getStringSlice("members")).indexOf(u.id) >= 0) }).slice(0, 8).map(function (x) { return "#" + x.getString("name") })
      return { text: tr(lang, "no_channel", { ch: oneLine(m[2], 40) }) + (mine.length ? tr(lang, "your_channels") + mine.join(" ") : ""), result: "not_found" }
    }
    var body = m[3].trim()
    var r = LIB().callRoute(app, ctx, "createChannelPost", ch.id, { body: body })
    if (r.error) return { text: errText(lang, r), result: r.code }
    return { text: tr(lang, "posted") + link("p/" + r.body.post.id) + unknownMentions(app, lang, body), result: "posted" }
  }
  var fol = RE_FOLLOW.exec(cmd), unf = RE_UNFOLLOW.exec(cmd)
  if (fol || unf) {
    var ref = (fol || unf)[2].toUpperCase().replace(/^(\d)/, "T-$1").replace(/^T(\d)/, "T-$1")
    var fr = LIB().callRoute(app, ctx, "putFollow", ref, { on: !!fol }, { kind: "task", method: "PUT", table: N().routes })
    if (fr.error) return { text: errText(lang, fr), result: fr.code }
    return { text: tr(lang, fol ? "following" : "unfollowed", { ref: ref }) + link("t/" + ref), result: fol ? "follow" : "unfollow" }
  }
  return { text: tr(lang, "short"), result: "short_help" }
}
function arr0(v) { return Array.isArray(v) ? v : [] }

function itemTitle(app, ctx, x) {
  if (x.task_ref) return x.task_ref + " " + oneLine(x.title, 80)
  if (x.type === "assigned_external") return oneLine(x.ref + " " + x.title, 100)
  var p = byId(app, "posts", x.post_id || x.id)
  var ch = p ? byId(app, "channels", p.getString("channel")) : null
  // a private channel's text never leaves the hub (titles and links only)
  if (!ch || ch.getString("visibility") === "private") return "#" + (ch ? ch.getString("name") : "")
  return "#" + ch.getString("name") + ": " + oneLine(x.text, 60)
}

function inbox(app, ctx, who, lang) {
  var r = LIB().callRoute(app, ctx, "myInbox", "", {}, { method: "GET" })
  if (r.error) return { text: tr(lang, "failed") + r.error, result: r.code }
  var items = (r.body.items || []).filter(function (x) { return x.type !== "memory_digest" })
  items.sort(function (a, b) { return (b.pending ? 1 : 0) - (a.pending ? 1 : 0) })
  items = items.slice(0, LIST_MAX)
  var saved = items.map(function (x) {
    return { type: x.type, id: str(x.id), task_id: str(x.task_id), message_id: str(x.message_id), post_id: str(x.post_id), url: str(x.url) }
  })
  if (who.row) { who.row.set("last_list", saved); app.save(who.row) }
  if (!items.length) return { text: tr(lang, "empty") + link("inbox"), result: "inbox" }
  var kinds = (T[lang] || T.en).kinds
  var lines = items.map(function (x, i) { return (i + 1) + ". [" + (kinds[x.type] || x.type) + "] " + itemTitle(app, ctx, x) + "\n   " + x.url })
  return { text: tr(lang, "inbox") + "\n" + lines.join("\n") + "\n" + tr(lang, "help").split("\n")[2].replace(/^- /, ""), result: "inbox" }
}

/**
 * Which option free text names, or -1. Only an unambiguous match:
 * the option letter (A..D by position) or number, the label, or the label
 * without its leading letter; optionally "choose/pick/option" (or a Chinese
 * equivalent) before it and punctuation or a Chinese sentence particle after it.
 * Anything else is not a decision. The Chinese words below are language support
 * for Chinese input.
 */
function matchOption(choices, text) {
  var opts = choices && Array.isArray(choices.options) ? choices.options : []
  if (!opts.length) return -1
  var norm = function (x) { return str(x).toLowerCase().replace(/[\s\u3000]+/g, "") }
  var t = norm(text).replace(/[\uff01-\uff5e]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0) })
  t = t.replace(/^(我)?(选择|选|choose|pick|option|就)/, "").replace(/[。.!！?？~～,，;；吧呗啊哈]+$/, "").replace(/^(选项|方案)/, "")
  if (!t) return -1
  var hits = []
  opts.forEach(function (o, i) {
    var letter = String.fromCharCode(97 + i)
    var label = norm(o.label)
    var bare = label.replace(new RegExp("^" + letter + "[.、:：-]?"), "")
    var full = norm(str(o.label) + (o.detail ? " — " + str(o.detail) : ""))
    var cands = [letter, String(i + 1), label, bare, full].filter(function (x) { return x })
    if (cands.indexOf(t) >= 0) hits.push(i)
  })
  return hits.length === 1 ? hits[0] : -1
}

/** A free-text answer to a task decision request: the decision when it names an option, else a note on the task. */
function textToDecision(app, ctx, lang, taskId, reqId, text, url) {
  var req = byId(app, "messages", reqId)
  var choices = req ? parseJSON(req.getString("choices")) : null
  var hasOpts = choices && Array.isArray(choices.options) && choices.options.length
  var t0 = byId(app, "tasks", taskId)
  var closed = t0 && ["completed", "failed", "canceled"].indexOf(t0.getString("status")) >= 0
  if (req && (req.getBool("resolved") || closed)) return lateWords(app, ctx, lang, t0, reqId, text, url, closed)
  if (!hasOpts) {
    var r0 = LIB().callRoute(app, ctx, "decide", taskId, { message_id: reqId, decision: text })
    if (r0.error) return { text: r0.code === "resolved" ? tr(lang, "already") : errText(lang, r0), result: r0.code }
    return { text: tr(lang, "recorded") + url, result: "recorded" }
  }
  var i = matchOption(choices, text)
  if (i >= 0) {
    var r = LIB().callRoute(app, ctx, "decide", taskId, { message_id: reqId, decision: optionReply(choices.options[i]) })
    if (r.error) return { text: r.code === "resolved" ? tr(lang, "already") : errText(lang, r), result: r.code }
    return { text: tr(lang, "recorded") + url, result: "recorded", chosen: choices.options[i].label }
  }
  // not a decision: the person's words stay on the task as a note (never a money decision)
  var t = byId(app, "tasks", taskId)
  var n = LIB().callRoute(app, ctx, "note", taskId, { body: text })
  if (n.error) return { text: errText(lang, n), result: n.code }
  return { text: tr(lang, "noted", { ref: t ? taskRef(t) : "", url: t ? link("t/" + taskRef(t) + "/m/" + n.body.message.id) : url }), result: "noted" }
}

/**
 * Words typed after a decision was answered (or its task closed) are never
 * lost silently: they become the person's note on the task when they may
 * leave one (a channel member, an owner, an admin), else the reply says why.
 */
function lateWords(app, ctx, lang, t, reqId, text, url, closed) {
  var st = N().decisionState(app, { kind: "task", message_id: reqId }, ctx.user.id)
  var head = st && st.answered_by ? tr(lang, "answered_short", { name: st.answered_by, x: oneLine(st.answer, 120) }) : ""
  if (closed || !t) return { text: (head ? head + tr(lang, "sep") : "") + tr(lang, "late_closed"), result: "terminal" }
  var n = LIB().callRoute(app, ctx, "note", t.id, { body: text })
  if (n.error) {
    var why = n.code === "forbidden" || n.code === "not_found" ? tr(lang, "late_forbidden") : n.code === "terminal" ? tr(lang, "late_closed") : errText(lang, n)
    return { text: (head ? head + tr(lang, "sep") : tr(lang, "already_short")) + why, result: n.code }
  }
  var nurl = link("t/" + taskRef(t) + "/m/" + n.body.message.id)
  return { text: (head ? head + tr(lang, "sep") : tr(lang, "already_short")) + tr(lang, "late_noted") + " " + nurl, result: "noted_late" }
}

/** "reply <n>": a reply to an Inbox item, through the panel's routes. */
function replyItem(app, ctx, lang, it, text) {
  var r
  if (it.type === "decision" && it.message_id && it.task_id) return textToDecision(app, ctx, lang, it.task_id, it.message_id, text, it.url)
  if (it.type === "assigned" && it.task_id) r = LIB().callRoute(app, ctx, "note", it.task_id, { body: text })
  else if (it.id || it.post_id) r = LIB().callRoute(app, ctx, "replyPost", it.type === "assigned_external" ? it.post_id : it.id, { body: text })
  else return { text: tr(lang, "thread_none"), result: "none" }
  if (r.error) return { text: r.code === "resolved" ? tr(lang, "already") : errText(lang, r), result: r.code }
  return { text: tr(lang, "recorded") + it.url, result: "recorded" }
}

/** A reply in the thread of a notification or card. */
function answerItem(app, ctx, lang, fm, text) {
  var r, url
  var req = fm.getString("request")
  if (req && fm.getString("task")) {
    var t = byId(app, "tasks", fm.getString("task"))
    url = t ? link("t/" + taskRef(t) + "/m/" + req) : link("inbox")
    var out = textToDecision(app, ctx, lang, fm.getString("task"), req, text, url)
    if (out.chosen) { fm.set("chosen", oneLine(out.chosen, 300)); app.save(fm) }
    return out
  } else if (req && fm.getString("post")) {
    url = link("p/" + req)
    r = LIB().callRoute(app, ctx, "replyPost", req, { body: text })
  } else if (fm.getString("post")) {
    url = link("p/" + fm.getString("post"))
    r = LIB().callRoute(app, ctx, "replyPost", fm.getString("post"), { body: text })
  } else if (fm.getString("task")) {
    var t2 = byId(app, "tasks", fm.getString("task"))
    url = t2 ? link("t/" + taskRef(t2)) : link("inbox")
    r = LIB().callRoute(app, ctx, "note", fm.getString("task"), { body: text })
  } else return { text: tr(lang, "thread_none"), result: "none" }
  if (r.error) return { text: r.code === "resolved" ? tr(lang, "already") : errText(lang, r), result: r.code }
  if (req) { fm.set("chosen", oneLine(text, 300)); app.save(fm) }
  return { text: tr(lang, "recorded") + url, result: "recorded" }
}

// ---------------------------------------------------------------- card actions

function optionReply(o) { return (str(o.label) + (o.detail ? " — " + str(o.detail) : "")).slice(0, 700) }

function cardAction(app, c, b) {
  var ev = b.event || {}
  var op = ev.operator || {}
  // Card callbacks are rate-limited per operator too
  if (OPEN_ID_RE.test(str(op.open_id)) && limited(app, "card:" + str(op.open_id))) return { toast: { type: "error", content: tr("zh", "limited") + " / " + tr("en", "limited") } }
  var val = ev.action && ev.action.value
  if (typeof val === "string") val = parseJSON(val)
  var mid = str(ev.context && ev.context.open_message_id)
  var fm = MSG_ID_RE.test(mid) ? find(app, "feishu_messages", "message_id = {:m}", "", 1, { m: mid })[0] || null : null
  var who = resolve(app, c, op, ev.operator && ev.operator.tenant_key, false)
  var lang = who.user ? langOf(who.user) : "zh"
  var toast = function (type, k, x) { return { type: type, content: x !== undefined ? x : tr(lang, k) } }
  if (!who.user) return { toast: toast("error", who.deactivated ? "deactivated" : who.held ? "admin_held" : "unknown") }
  if (!val || val.ach !== "d" || (val.k !== "task" && val.k !== "post") || !/^[a-z0-9]{15}$/.test(str(val.r)) || !(Number(val.o) >= 0 && Number(val.o) <= 9)) return { toast: toast("info", "thread_none") }
  var o = Number(val.o)
  // the card was minted for exactly one person; anyone else (a forwarded card) is refused
  if (str(val.u) !== who.user.id || !same(str(val.s), cardSig(app, val.k, val.r, o, who.user.id))) return { toast: toast("error", "not_yours") }
  var uid = who.user.id
  var st = N().decisionState(app, val.k === "task" ? { kind: "task", message_id: val.r } : { kind: "post", post_id: val.r }, uid)
  var url = link("inbox")
  if (st && st.kind === "task") { var t = byId(app, "tasks", st.task); if (t) url = link("t/" + taskRef(t) + "/m/" + st.target) }
  if (st && st.kind === "post") url = link("p/" + st.target)
  var settle = function (line) { return { type: "raw", data: settledCard(fm ? parseJSON(fm.getString("card")) : null, line, url, lang) } }
  if (!st) return { toast: toast("warning", "gone"), card: settle(tr(lang, "gone")) }
  // Answered (here, in the panel or on another card) comes before "not yours"
  if (!st.open) { var al = answeredLine(st, lang); if (fm) { fm.set("settled", true); app.save(fm) } return { toast: toast("info", "", al), card: settle(al) } }
  if (!st.addressed) return { toast: toast("error", "not_yours") }
  var opt = st.choices && Array.isArray(st.choices.options) ? st.choices.options[o] : null
  if (!opt) return { toast: toast("error", "gone") }
  var reply = optionReply(opt)
  var ctx = LIB().humanCtx(app, who.user)
  var r = st.kind === "task"
    ? LIB().callRoute(app, ctx, "decide", st.task, { message_id: st.target, decision: reply })
    : LIB().callRoute(app, ctx, "replyPost", st.target, { body: reply })
  if (r.error) {
    var k = r.code === "resolved" ? "already" : r.code === "terminal" ? "closed" : ""
    return { toast: toast("error", k || "failed", k ? undefined : errText(lang, r)), card: k ? settle(tr(lang, k)) : undefined }
  }
  if (fm) { fm.set("chosen", oneLine(opt.label, 300)); fm.set("settled", true); app.save(fm) }
  var line = tr(lang, "chosen", { x: oneLine(opt.label, 120) + moneyPart(opt) })
  return { toast: toast("success", "", tr(lang, "recorded") + oneLine(opt.label, 60)), card: settle(line) }
}

// ---------------------------------------------------------------- cron

function cron(app) {
  var now = nowMs()
  // leftovers: a request that died after answering Feishu
  find(app, "feishu_events", "status = 'queued' && created < {:t}", "created", 20, { t: iso(now - 20000) }).forEach(function (r) {
    try { processMessage(app, r.id) } catch (err) { app.logger().warn("ach feishu retry failed", "error", String(err)) }
  })
  try {
    app.db().newQuery("UPDATE feishu_events SET status = 'failed' WHERE status = 'working' AND created < {:t}").bind({ t: iso(now - 600000) }).execute()
    app.db().newQuery("DELETE FROM feishu_events WHERE created < {:t}").bind({ t: iso(now - EVENT_KEEP_MS) }).execute()
    app.db().newQuery("DELETE FROM feishu_messages WHERE created < {:t}").bind({ t: iso(now - 90 * 24 * 3600 * 1000) }).execute()
  } catch (err) {}
}

// ---------------------------------------------------------------- admin routes

var routes = {}

function statusOut(app) {
  var c = cfg(app)
  var ids = find(app, "feishu_ids", "", "-updated", 500, {}).map(function (r) { return identityOut(app, r) })
  var s = settings(app)
  return {
    configured: c.configured, ready: c.ready, region: c.region, app_id: c.app_id, email_match: c.email_match,
    email_match_personal: c.email_match_personal, tenant_key: c.tenant_key,
    set: { app_id: !!c.app_id, app_secret: !!c.app_secret, verification_token: !!c.verification_token, encrypt_key: !!c.encrypt_key },
    source: c.src, public_url: !!publicUrl(),
    callback_url: publicUrl() ? publicUrl() + "/api/ach/feishu/events" : "",
    mappings: ids.filter(function (x) { return x.status === "mapped" }),
    pending: ids.filter(function (x) { return x.status !== "mapped" }),
    region_setting: str(s.region),
  }
}

routes.adminGet = { fn: function (e, ctx) { return [200, statusOut(e.app)] } }

// PUT {app_id?, app_secret?, verification_token?, encrypt_key?, region?, email_match?}: "" clears a value; secrets are write-only.
routes.adminPut = {
  fn: function (e, ctx) {
    var b = L().body(e)
    var s = settings(e.app)
    var changed = false
    ;["app_id", "app_secret", "verification_token", "encrypt_key"].forEach(function (k) {
      if (b[k] === undefined) return
      var v = str(b[k]).trim()
      if (v.length > 300 || /\s/.test(v)) throw E(400, "invalid", k + " must be one word (at most 300 characters)")
      if (k === "app_id" && v && !/^cli_[A-Za-z0-9]{4,60}$/.test(v)) throw E(400, "invalid", "app_id looks like cli_xxxxxxxx")
      if (v) s[k] = v
      else delete s[k]
      changed = true
    })
    if (b.region !== undefined) {
      if (["feishu", "lark", ""].indexOf(str(b.region)) < 0) throw E(400, "invalid", "region must be feishu (China) or lark (international)")
      s.region = str(b.region)
      changed = true
    }
    if (b.email_match_personal !== undefined) {
      if (typeof b.email_match_personal !== "boolean") throw E(400, "invalid", "email_match_personal must be boolean")
      s.email_match_personal = b.email_match_personal
      changed = true
    }
    if (b.tenant_key !== undefined) {
      var tk = str(b.tenant_key).trim()
      if (tk.length > 100 || /\s/.test(tk)) throw E(400, "invalid", "tenant_key must be one word")
      if (tk) s.tenant_key = tk
      else delete s.tenant_key
      changed = true
    }
    if (b.email_match !== undefined) {
      if (typeof b.email_match !== "boolean") throw E(400, "invalid", "email_match must be boolean")
      s.email_match = b.email_match
      changed = true
    }
    if (!changed) throw E(400, "invalid", "nothing to change")
    L().writeSetting(e.app, SETTINGS_KEY, s)
    e.app.store().remove(TOKEN_STORE)
    return [200, statusOut(e.app)]
  },
}

/** POST /admin/feishu/check: can the hub get a tenant token with these credentials? */
routes.adminCheck = {
  fn: function (e, ctx) {
    var c = cfg(e.app)
    if (!c.configured) throw E(409, "feishu_off", "set app_id, app_secret, verification_token and encrypt_key first")
    tenantToken(e.app, c, true)
    return [200, { ok: true }]
  },
}

/** POST /admin/feishu/mappings {user, open_id? | email?}: an admin-confirmed mapping. */
routes.adminMap = {
  fn: function (e, ctx) {
    var app = e.app
    var b = L().body(e)
    var c = cfg(app)
    var u = byId(app, "users", str(b.user))
    if (!u) {
      try { u = app.findAuthRecordByEmail("users", lower(b.user)) } catch (err) { u = null }
    }
    if (!u) throw E(404, "not_found", "person not found")
    var openId = str(b.open_id).trim()
    var email = lower(b.email)
    if (!openId) {
      if (!c.configured) throw E(409, "feishu_off", "configure the Feishu app first (or give open_id)")
      if (!email) email = lower(u.getString("email"))
      if (!email) throw E(400, "invalid", "give the person's Feishu email or open_id")
      openId = openIdForEmail(app, c, email)
      if (!openId) throw E(404, "not_found", "no Feishu user with this email in your tenant (or the app lacks contact permissions)")
    }
    if (!OPEN_ID_RE.test(openId)) throw E(400, "invalid", "open_id looks like ou_xxxxxxxx")
    var r = L().tx(app, function (txa) {
      // one Feishu identity per person, one person per identity
      find(txa, "feishu_ids", "user = {:u} && open_id != {:o}", "", 100, { u: u.id, o: openId }).forEach(function (x) { x.set("user", ""); x.set("status", "pending"); x.set("how", ""); txa.save(x) })
      return upsertIdentity(txa, openId, { user: u.id, how: "admin", status: "mapped", email: email || undefined, wants_user: "" })
    })
    logMapping(app, "mapped by " + userName(ctx.user) + ": " + openId + " → " + userName(u), u.id)
    return [200, { mapping: identityOut(app, r), status: statusOut(app) }]
  },
}

/** DELETE /admin/feishu/mappings/{id}: unmap (the identity stays pending); ?block=1 blocks it. */
routes.adminUnmap = {
  fn: function (e, ctx) {
    var app = e.app
    var r = byId(app, "feishu_ids", e.request.pathValue("id"))
    if (!r) throw E(404, "not_found", "mapping not found")
    var uid = r.getString("user")
    if (uid) {
      var u = byId(app, "users", uid)
      if (u && u.getString("feishu_open_id") === r.getString("open_id")) { u.set("feishu_open_id", ""); app.save(u) }
    }
    r.set("user", "")
    r.set("how", "")
    r.set("status", e.request.url.query().get("block") === "1" ? "blocked" : "pending")
    r.set("wants_user", "")
    app.save(r)
    logMapping(app, (r.getString("status") === "blocked" ? "blocked" : "unmapped") + " by " + userName(ctx.user) + ": " + r.getString("open_id"), uid)
    return [200, statusOut(app)]
  },
}

/** POST /admin/feishu/invite {user, email?}: a fresh one-time login link sent to the person's Feishu DM. */
routes.adminInvite = {
  fn: function (e, ctx) {
    var app = e.app
    var b = L().body(e)
    var c = cfg(app)
    if (!c.ready) throw E(409, "feishu_off", "the Feishu adapter is not configured")
    var u = byId(app, "users", str(b.user))
    if (!u) throw E(404, "not_found", "person not found")
    var row = mappedRow(app, u.id)
    var openId = row ? row.getString("open_id") : ""
    var email = lower(b.email || u.getString("email"))
    if (!openId) {
      if (!email) throw E(400, "invalid", "this person has no Feishu mapping and no email to look up")
      openId = openIdForEmail(app, c, email)
      if (!openId) throw E(404, "not_found", "no Feishu user with this email in your tenant")
    }
    var minted = LIB().callRoute(app, ctx, "adminUserLoginLink", u.id, {})
    if (minted.error) throw E(minted.status, minted.code, minted.error)
    var lang = langOf(u)
    var r = sendDm(app, c, openId, "text", { text: tr(lang, "invite", { admin: userName(ctx.user), url: minted.body.url }) })
    if (!r.ok) throw E(502, "feishu_api", "Feishu did not deliver the message (code " + str(r.code) + ": " + r.msg + ")")
    // the admin chose this Feishu user for this person: that is a confirmed mapping
    if (!row) {
      upsertIdentity(app, openId, { user: u.id, how: "admin", status: "mapped", email: email, wants_user: "" })
      logMapping(app, "mapped by " + userName(ctx.user) + " (invite): " + openId + " → " + userName(u), u.id)
    }
    return [200, { sent: true, expires_at: minted.body.expires_at, mapping: identityOut(app, find(app, "feishu_ids", "open_id = {:o}", "", 1, { o: openId })[0]) }]
  },
}

/** Test-only: decrypt/sign with the hub's implementation (known vectors). */
routes.testCrypto = {
  test: true,
  fn: function (e, ctx) {
    var b = L().body(e)
    var out = {}
    if (b.encrypt !== undefined) out.plain = decrypt(b.encrypt, b.key)
    if (b.ts !== undefined) out.signature = signature(b.ts, b.nonce, b.key, b.body)
    return [200, out]
  },
}

function run(e, name) {
  var r = routes[name]
  try {
    var ctx
    if (r.test) {
      if ($os.getenv("ACH_TEST_HOOKS") !== "1") throw E(404, "not_found", "not found")
      if (!e.hasSuperuserAuth()) throw E(401, "unauthorized", "superuser only")
      ctx = { type: "superuser" }
    } else {
      ctx = LIB().authenticate(e)
      LIB().requireAuth(ctx, ["user"])
      LIB().requireAdmin(ctx)
    }
    var out = r.fn(e, ctx)
    return e.json(out[0], out[1])
  } catch (err) {
    if (err && err.achError) return e.json(err.status, { error: err.message, code: err.code })
    var msg = String((err && err.message) || err)
    if (/UNIQUE constraint/i.test(msg)) return e.json(409, { error: "conflict", code: "conflict" })
    e.app.logger().error("ach feishu route error", "route", name, "error", msg)
    return e.json(500, { error: "internal error" + ($os.getenv("ACH_TEST_HOOKS") === "1" ? ": " + msg : ""), code: "internal" })
  }
}

function events(e) {
  try {
    return handleEvents(e)
  } catch (err) {
    e.app.logger().error("ach feishu events error", "error", String((err && err.message) || err))
    return e.json(500, { code: "internal", error: "internal error" })
  }
}

module.exports = {
  run: run, events: events, cron: cron, deliver: deliver, targetFor: targetFor, cfg: cfg, queueNote: queueNote, onRecord: onRecord,
  // pure helpers (tests)
  decrypt: decrypt, signature: signature, b64decode: b64decode, utf8Decode: utf8Decode, matchOption: matchOption,
}
