/// <reference path="../pb_data/types.d.ts" />
// Deployment helpers (docs/deploy.md), the same on every platform:
//
// 1. First-run setup link. While the hub has no active admin, every start
//    mints a new one-time setup token ("ach_su_" + 40 base62), stores only its
//    SHA-256 in hub_settings ("ach_setup") and prints
//    "First-run setup: <url>/#/setup/<token>" to stdout only (once per start,
//    with a warning; the hub's stored log gets a redacted line). The link
//    expires after ACH_SETUP_TTL_MIN minutes (default 60; a restart prints a
//    new one). ACH_SETUP_TOKEN (32-128 chars of [A-Za-z0-9_-]) sets the token
//    yourself instead, so it never has to be printed at all. Opening it
//    creates the first admin (name, optional email) and returns a normal
//    session. After that (or as soon as any active admin exists, e.g. made by
//    the superuser) the token is dead and the routes answer 410 setup_done.
// 2. GET /api/ach/admin/deploy-check (admins): a checklist with one impact
//    sentence per item.
// 3. GET /api/ach/version (public): the image/build version, for upgrade and
//    update-check scripts. The hub itself never calls out (no telemetry).
//
// Shared helpers come from ach_lib.js (wikiDeps); handlers run in isolated
// contexts, so this module keeps no top-level state.

var SETUP_KEY = "ach_setup"
var SETUP_TOKEN_RE = /^(ach_su_[A-Za-z0-9]{40}|[A-Za-z0-9_-]{32,128})$/
var BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
var PB_VERSION = "0.40.6"

function L() { return require(__hooks + "/ach_lib.js").wikiDeps() }

function AchError(status, code, message, extra) {
  this.achError = true
  this.status = status
  this.code = code
  this.message = message
  this.extra = extra || null
}
function E(status, code, message, extra) { return new AchError(status, code, message, extra) }
function str(v) { return v === undefined || v === null ? "" : String(v) }
function env(k) { return str($os.getenv(k)).trim() }

function activeAdmins(app) {
  return app.findRecordsByFilter("users", "is_admin = true && deactivated != true", "", 1, 0, {}).length
}

// The URL people open. ACH_PUBLIC_URL first; then what the platform tells us
// (Render, Railway, Fly); else the listen address (local trial).
function detectedBase(listenAddr) {
  var u = env("ACH_PUBLIC_URL").replace(/\/+$/, "")
  if (u) return u
  if (env("RENDER_EXTERNAL_URL")) return env("RENDER_EXTERNAL_URL").replace(/\/+$/, "")
  if (env("RAILWAY_PUBLIC_DOMAIN")) return "https://" + env("RAILWAY_PUBLIC_DOMAIN")
  if (env("FLY_APP_NAME")) return "https://" + env("FLY_APP_NAME") + ".fly.dev"
  var a = str(listenAddr) || "127.0.0.1:8090"
  a = a.replace(/^0\.0\.0\.0:/, "localhost:").replace(/^\[::\]:/, "localhost:").replace(/^:/, "localhost:")
  return "http://" + a
}

// onServe: (re)mint the setup token while there is no active admin.
function announceSetup(app, listenAddr) {
  var deps = L()
  if (activeAdmins(app) > 0) {
    var st = deps.readSetting(app, SETUP_KEY)
    if (st && st.token_hash) deps.writeSetting(app, SETUP_KEY, { done_at: new Date().toISOString() })
    return null
  }
  var ttlMin = parseFloat(env("ACH_SETUP_TTL_MIN"))
  if (!(ttlMin > 0)) ttlMin = 60
  var fromEnv = env("ACH_SETUP_TOKEN")
  if (fromEnv && !SETUP_TOKEN_RE.test(fromEnv)) {
    console.log("ACH_SETUP_TOKEN is ignored: use 32-128 characters of A-Z a-z 0-9 _ -")
    fromEnv = ""
  }
  var tok = fromEnv || "ach_su_" + $security.randomStringWithAlphabet(40, BASE62)
  var now = Date.now()
  deps.writeSetting(app, SETUP_KEY, { token_hash: $security.sha256(tok), created_at: new Date(now).toISOString(), expires_at: new Date(now + ttlMin * 60000).toISOString() })
  var base = detectedBase(listenAddr)
  var mins = Math.round(ttlMin)
  if (fromEnv) {
    console.log("\nFirst-run setup: " + base + "/#/setup/<ACH_SETUP_TOKEN> (the token you set; valid " + mins + " min; restart prints a new one)\n")
  } else {
    // stdout only, once: never into the hub's stored logs
    console.log("\nFirst-run setup: " + base + "/#/setup/" + tok + "\n" +
      "WARNING: anyone who can read these logs can claim admin with this link: open it now.\n" +
      "(one-time link, valid " + mins + " min; restart prints a new one. Set ACH_SETUP_TOKEN to avoid printing it.)\n")
  }
  app.logger().warn("First-run setup link is active (printed to stdout; valid " + mins + " min; restart prints a new one)")
  return tok
}

// Throws 410 when setup is finished, 401 when the token is not the current one.
function checkSetupToken(app, tok) {
  var deps = L()
  if (activeAdmins(app) > 0) throw E(410, "setup_done", "this hub already has an admin; ask them for an invite link")
  var st = deps.readSetting(app, SETUP_KEY)
  if (!st || !st.token_hash) throw E(410, "setup_done", "no setup link is active; restart the hub to print a new one")
  if (!SETUP_TOKEN_RE.test(tok) || !$security.equal($security.sha256(tok), str(st.token_hash))) {
    throw E(401, "invalid_setup_link", "this setup link is not valid; use the newest link from the hub's log")
  }
  if (st.expires_at && Date.parse(st.expires_at) <= Date.now()) {
    throw E(410, "setup_link_expired", "This setup link expired — restart the hub to print a new one")
  }
}

var routes = {}

// POST /api/ach/setup/check {token}: is this link usable? (the panel asks
// first). The token is only ever in a POST body, never a URL (request logs).
// email: the verified Cloudflare Access identity, to prefill the form.
routes.setupState = {
  allow: ["public"],
  fn: function (e) {
    var deps = L()
    checkSetupToken(e.app, str(deps.body(e).token).trim())
    var out = { ok: true }
    var email = deps.cfIdentity(e)
    if (email) out.email = email
    return [200, out]
  },
}

// POST /api/ach/setup {token, name, email?}: create the first admin, log in.
routes.setup = {
  allow: ["public"],
  fn: function (e) {
    var deps = L()
    var b = deps.body(e)
    var tok = str(b.token).trim()
    var name = str(b.name).trim()
    var email = str(b.email).trim().toLowerCase()
    if (!name || name.length > 80) throw E(400, "invalid", "name is required (at most 80 characters)")
    if (email && !EMAIL_RE.test(email)) throw E(400, "invalid", "email is not valid")
    var user = deps.tx(e.app, function (app) {
      checkSetupToken(app, tok)
      var u = new Record(app.findCollectionByNameOrId("users"))
      if (email) u.setEmail(email)
      u.setPassword($security.randomStringWithAlphabet(48, BASE62)) // never shown: no password login
      u.setVerified(true)
      u.set("name", name)
      u.set("is_admin", true)
      u.set("deactivated", false)
      app.save(u)
      deps.writeSetting(app, SETUP_KEY, { done_at: new Date().toISOString(), admin: u.id })
      return u
    })
    e.app.logger().info("ach first-run setup done", "admin", user.id)
    $apis.recordAuthResponse(e, user, "", null)
    return null
  },
}

routes.version = {
  allow: ["public"],
  fn: function () {
    return [200, { version: env("ACH_VERSION") || "dev", pocketbase: PB_VERSION }]
  },
}

// ---- deployment check

// Sections: "public_url" (required: the only required setting), "delivery"
// (how one-time links reach people: copy always works; Feishu and email are
// optional adapters), "front_door" (optional trusted identity in front of the
// hub, e.g. Cloudflare Access), "hygiene" (test hooks, backup, storage).
var SECTION = { public_url: "public_url", https: "public_url", copy: "delivery", feishu: "delivery", smtp: "delivery", cf_access: "front_door", test_hooks: "hygiene", backup: "hygiene", storage: "hygiene" }

function item(id, status, value, en, zh) {
  return { id: id, section: SECTION[id], status: status, value: value, impact: { en: en, zh: zh } }
}

function requestOrigin(e) {
  var proto = str(e.request.header.get("X-Forwarded-Proto")).split(",")[0].trim()
  if (!proto) proto = e.request.tls ? "https" : "http"
  var host = str(e.request.header.get("X-Forwarded-Host")).split(",")[0].trim() || str(e.request.host)
  return proto + "://" + host
}

// Newest modification time (ms) among the entries of dir, or 0.
function newestIn(dir) {
  var best = 0
  try {
    $os.readDir(dir).forEach(function (d) {
      try {
        var ms = d.info().modTime().unixMilli()
        if (ms > best) best = ms
      } catch (err) {}
    })
  } catch (err) {}
  return best
}

// How long this hub has existed: since the first person account (or the
// setup link when nobody exists yet).
function hubAgeMs(app) {
  var first = 0
  try {
    var r = app.findRecordsByFilter("users", "id != ''", "created", 1, 0, {})
    if (r.length) first = Date.parse(str(r[0].getString("created")).replace(" ", "T"))
  } catch (err) {}
  if (!first) {
    var st = L().readSetting(app, SETUP_KEY)
    first = st && st.created_at ? Date.parse(st.created_at) : Date.now()
  }
  return Date.now() - (first || Date.now())
}

routes.deployCheck = {
  allow: ["user"],
  fn: function (e, ctx) {
    L().requireAdmin(ctx)
    var app = e.app
    var out = []
    var pub = env("ACH_PUBLIC_URL").replace(/\/+$/, "")
    var origin = requestOrigin(e)
    if (!pub) {
      out.push(item("public_url", "fail", "", "ACH_PUBLIC_URL is not set: invite, login and notification links will not open for anyone but localhost.", "未设置 ACH_PUBLIC_URL：邀请、登录和通知链接只在本机可用，别人打不开。"))
    } else if (pub.toLowerCase() !== origin.toLowerCase()) {
      out.push(item("public_url", "warn", pub, "ACH_PUBLIC_URL (" + pub + ") differs from the address you opened (" + origin + "): links you send will point to " + pub + ".", "ACH_PUBLIC_URL（" + pub + "）与当前访问地址（" + origin + "）不一致：发出的链接会指向 " + pub + "。"))
    } else {
      out.push(item("public_url", "ok", pub, "Links point to " + pub + ".", "链接指向 " + pub + "。"))
    }
    var https = /^https:\/\//i.test(pub || origin)
    out.push(https
      ? item("https", "ok", true, "Served over HTTPS.", "已启用 HTTPS。")
      : item("https", "fail", false, "Not HTTPS: sessions and login links travel in clear text, and browsers block copy-to-clipboard and camera.", "未启用 HTTPS：会话和登录链接明文传输，浏览器也会禁用复制和摄像头。"))
    out.push(item("copy", "ok", true, "Copy a one-time link and send it any way you like (always available).", "复制一次性链接，用任何方式发出（始终可用）。"))
    var smtp = false
    try { smtp = !!app.settings().smtp.enabled } catch (err) {}
    out.push(smtp
      ? item("smtp", "ok", true, "Email adapter on: links and login codes can be sent by email.", "邮件适配器已启用：链接和验证码可以通过邮件发送。")
      : item("smtp", "info", false, "Optional: no SMTP, so no email button and no email codes. Copying links works without it.", "可选：未配置 SMTP，没有邮件发送和验证码；复制链接不受影响。"))
    var hook = env("ACH_NOTIFY_WEBHOOK")
    var fmt = env("ACH_NOTIFY_FORMAT") || (/^https:\/\/open\.(feishu\.cn|larksuite\.com)\//.test(hook) ? "feishu" : "json")
    out.push(!hook
      ? item("feishu", "info", "", "Optional: no Feishu/Lark webhook, so nobody is pinged about new tasks, decisions or escalations (unless they set a personal webhook).", "可选：未配置飞书 Webhook，新任务、待决策和升级不会推送（除非个人配置了 Webhook）。")
      : item("feishu", "ok", fmt, fmt === "feishu" ? "Notifications go to a Feishu/Lark bot." : "Notifications go to a JSON webhook.", fmt === "feishu" ? "通知发送到飞书机器人。" : "通知发送到 JSON Webhook。"))
    var cfTeam = env("ACH_CF_TEAM_DOMAIN")
    var cfAud = env("ACH_CF_AUD")
    if (cfTeam && cfAud) out.push(item("cf_access", "ok", cfTeam, "Cloudflare Access is the trusted front door: its verified identity opens a session (hub membership is still the permission). Use an Access policy for your whole email domain or identity-provider group, so inviting someone in the panel is enough (no per-email allow-list edits).", "Cloudflare Access 作为可信前门：验证过的身份直接登录（权限仍以 hub 成员为准）。建议 Access 策略按整个邮箱域名或身份提供方的组放行，这样在面板里邀请即可，不用逐个添加邮箱。"))
    else if (cfTeam || cfAud) out.push(item("cf_access", "fail", false, "Only one of ACH_CF_TEAM_DOMAIN / ACH_CF_AUD is set: Access logins will not reach the panel.", "ACH_CF_TEAM_DOMAIN 和 ACH_CF_AUD 只设置了一个：Access 登录无法进入面板。"))
    else out.push(item("cf_access", "info", false, "Optional: no trusted front door. One-time links are the way in; anyone who finds the URL sees only the login page.", "可选：未配置可信前门。一次性链接即入口；别人打开网址只能看到登录页。"))
    out.push(env("ACH_TEST_HOOKS") === "1"
      ? item("test_hooks", "fail", true, "ACH_TEST_HOOKS=1: test-only routes are on. Never run production like this.", "ACH_TEST_HOOKS=1：测试专用接口已开启，生产环境必须关闭。")
      : item("test_hooks", "ok", false, "Test-only routes are off.", "测试接口已关闭。"))
    var newest = Math.max(newestIn(env("ACH_BACKUP_DIR") || app.dataDir() + "/../pb_data_backups"), newestIn(app.dataDir() + "/backups"))
    if (!newest && hubAgeMs(app) < 3600 * 1000) {
      out.push(item("backup", "info", null, "No backup yet (this hub is less than an hour old): set up daily backups before your team relies on it.", "还没有备份（这个 hub 刚启动不到一小时）：团队开始使用前请配置每日备份。"))
    } else if (!newest) {
      out.push(item("backup", "fail", null, "No backup found: if the disk is lost, every task, message and Memory page is gone.", "没有找到备份：磁盘丢失时所有任务、消息和 Memory 都会丢失。"))
    } else {
      var hours = Math.floor((Date.now() - newest) / 3600000)
      out.push(hours <= 36
        ? item("backup", "ok", hours, "Last backup " + hours + " h ago.", "最近备份在 " + hours + " 小时前。")
        : item("backup", "warn", hours, "Last backup " + hours + " h ago: a disk failure would lose everything since then.", "最近备份在 " + hours + " 小时前：磁盘故障会丢失之后的全部数据。"))
    }
    var s3 = false
    try { s3 = !!app.settings().s3.enabled } catch (err) {}
    out.push(s3
      ? item("storage", "ok", "s3", "Attachments are in S3-compatible storage.", "附件存放在 S3 兼容存储。")
      : item("storage", "info", "local", "Attachments are on the hub's disk: watch disk usage, and move to S3/R2/OSS when videos grow.", "附件存放在 hub 本地磁盘：注意磁盘用量，视频多了以后迁移到 S3/R2/OSS。"))
    return [200, { ok: !out.some(function (i) { return i.section === "public_url" && i.status !== "ok" }), items: out, version: env("ACH_VERSION") || "dev", origin: origin }]
  },
}

function run(e, name) {
  var r = routes[name]
  try {
    var ctx = { type: "public" }
    if (r.allow[0] !== "public") {
      var deps = L()
      ctx = deps.authenticate(e)
      deps.requireAuth(ctx, r.allow)
    }
    var out = r.fn(e, ctx)
    if (out === null) return
    return e.json(out[0], out[1])
  } catch (err) {
    if (err && err.achError) {
      var payload = { error: err.message, code: err.code }
      if (err.extra) for (var k in err.extra) payload[k] = err.extra[k]
      return e.json(err.status, payload)
    }
    var msg = String((err && err.message) || err)
    if (/UNIQUE constraint|must be unique/i.test(msg)) return e.json(409, { error: "that email is already used", code: "conflict" })
    if (/validation|cannot be blank|must be/i.test(msg)) return e.json(400, { error: msg, code: "invalid" })
    e.app.logger().error("ach deploy route error", "route", name, "error", msg)
    return e.json(500, { error: "internal error", code: "internal" })
  }
}

module.exports = { run: run, announceSetup: announceSetup }
