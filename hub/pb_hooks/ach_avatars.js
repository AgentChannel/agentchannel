/// <reference path="../pb_data/types.d.ts" />
// Avatars (one-line onboarding round). Loaded with require() from
// ach_routes.pb.js. The panel loads every avatar from the hub only.
//
// People: the first available of the admin's priority list (default
//   upload > feishu > github > gravatar), else initials (drawn by the panel).
//   - upload: the person's own (PUT /api/ach/me/avatar).
//   - feishu: uploaded by `ach admin` (client side, from lark-cli) via
//     POST /api/ach/admin/avatars/users/{id}.
//   - github: the hub fetches https://github.com/<login>.png.
//   - gravatar: the hub fetches gravatar.com/avatar/<md5(email)>?d=404.
//   A source not in the priority list is never fetched (an admin who removes
//   "gravatar" stops the hub from sending email hashes to Gravatar).
//   Images are cached as files (<= 200 KB, PNG/JPEG/GIF/WebP; the JSVM cannot
//   resize, so PocketBase serves a 128x128 thumbnail). Hub-fetched rows are
//   refreshed weekly by the ach_avatars cron (every 10 minutes it also picks
//   up people never tried). ACH_AVATAR_FETCH=0 turns hub fetching off.
// Agents: the owner's avatar plus a runtime badge (the panel draws it).
//
// Also: GET /api/ach/admin/access-check?email= (Cloudflare Access reminder for
// `ach admin invite`).

var SOURCES = ["upload", "feishu", "github", "gravatar"]
var DEFAULT_PRIORITY = ["upload", "feishu", "github", "gravatar"]
var PRIORITY_KEY = "avatar_priority"
var MAX_BYTES = 200 * 1024
var STALE_MS = 7 * 86400 * 1000
var RETRY_ERROR_MS = 86400 * 1000
var EXT = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" }

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
function arr(v) { return Array.isArray(v) ? v : [] }
function find(app, coll, filter, sort, limit, params) {
  return app.findRecordsByFilter(coll, filter, sort || "", limit || 1000, 0, params || {})
}
function nowIso() { return new Date().toISOString() }
function ms(s) { var t = Date.parse(str(s)); return isNaN(t) ? 0 : t }

// ---------------------------------------------------------------- settings

function priority(app) {
  var p
  try { p = L().readSetting(app, PRIORITY_KEY) } catch (err) { p = null }
  if (!Array.isArray(p)) return DEFAULT_PRIORITY.slice()
  var out = []
  p.forEach(function (s) { s = str(s).toLowerCase(); if (SOURCES.indexOf(s) >= 0 && out.indexOf(s) < 0) out.push(s) })
  return out
}

function parsePriority(v) {
  var list = Array.isArray(v) ? v : str(v).split(",")
  var out = []
  list.forEach(function (s) {
    s = str(s).trim().toLowerCase()
    if (!s) return
    if (SOURCES.indexOf(s) < 0) throw E(400, "invalid", "unknown avatar source '" + s + "' (use " + SOURCES.join(", ") + ")")
    if (out.indexOf(s) < 0) out.push(s)
  })
  return out
}

// Off with ACH_AVATAR_FETCH=0. Test hubs (ACH_TEST_HOOKS=1) fetch only from
// a configured local base, never from github.com or gravatar.com.
function fetchEnabled() {
  if (str($os.getenv("ACH_AVATAR_FETCH")).trim() === "0") return false
  if ($os.getenv("ACH_TEST_HOOKS") === "1") return !!(str($os.getenv("ACH_AVATAR_GITHUB_BASE")).trim() && str($os.getenv("ACH_AVATAR_GRAVATAR_BASE")).trim())
  return true
}
function githubBase() { return (str($os.getenv("ACH_AVATAR_GITHUB_BASE")).trim() || "https://github.com").replace(/\/+$/, "") }
function gravatarBase() { return (str($os.getenv("ACH_AVATAR_GRAVATAR_BASE")).trim() || "https://www.gravatar.com/avatar").replace(/\/+$/, "") }

// ---------------------------------------------------------------- images

// The image type from the first bytes (never trust Content-Type; no SVG).
function sniff(b) {
  if (!b || b.length < 12) return ""
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp"
  return ""
}

function toByteArray(body) {
  if (!body) return []
  if (typeof body === "string") {
    var out = []
    for (var i = 0; i < body.length; i++) out.push(body.charCodeAt(i) & 0xff)
    return out
  }
  return body
}

// GET an image: {bytes, kind} | {missing: true} | {error}
function fetchImage(url) {
  var res
  try {
    res = $http.send({ url: url, method: "GET", timeout: 10, headers: { "user-agent": "AgentChannel-hub (avatars)", accept: "image/*" } })
  } catch (err) {
    return { error: String(err).slice(0, 200) }
  }
  if (res.statusCode === 404) return { missing: true }
  if (res.statusCode < 200 || res.statusCode >= 300) return { error: "HTTP " + res.statusCode }
  var bytes = toByteArray(res.body)
  if (bytes.length > MAX_BYTES) return { error: "larger than 200 KB" }
  var kind = sniff(bytes)
  if (!kind) return { error: "not a PNG/JPEG/GIF/WebP image" }
  return { bytes: bytes, kind: kind }
}

function rowOf(app, userId, source) {
  var r = find(app, "avatars", "user = {:u} && source = {:s}", "", 1, { u: userId, s: source })
  return r.length ? r[0] : null
}

function saveRow(app, userId, source, img, note) {
  var rec = rowOf(app, userId, source) || new Record(app.findCollectionByNameOrId("avatars"))
  rec.set("user", userId)
  rec.set("source", source)
  rec.set("fetched_at", nowIso())
  if (img && img.bytes) {
    rec.set("file", $filesystem.fileFromBytes(img.bytes, source + "." + EXT[img.kind]))
    rec.set("status", "ok")
    rec.set("note", "")
  } else {
    rec.set("file", null)
    rec.set("status", img && img.missing ? "missing" : "error")
    rec.set("note", str(note || (img && img.error)).slice(0, 300))
  }
  app.save(rec)
  return rec
}

function dropRow(app, userId, source) {
  var r = rowOf(app, userId, source)
  if (r) app.delete(r)
  return !!r
}

function sourceUrl(u, source) {
  if (source === "github") {
    var login = str(u.getString("github_login")).trim()
    return login ? githubBase() + "/" + encodeURIComponent(login) + ".png?size=128" : ""
  }
  if (source === "gravatar") {
    var email = str(u.getString("email")).trim().toLowerCase()
    return email ? gravatarBase() + "/" + $security.md5(email) + "?s=128&d=404" : ""
  }
  return ""
}

// Walk the priority list: stop at the first source with an image; fetch the
// hub-fetchable ones (github, gravatar) when never tried or stale (weekly;
// errors retry daily). Returns the source in use ("" = initials).
function refreshUser(app, u, force) {
  var list = priority(app)
  for (var i = 0; i < list.length; i++) {
    var s = list[i]
    var row = rowOf(app, u.id, s)
    if (s === "github" || s === "gravatar") {
      var url = sourceUrl(u, s)
      if (!url) {
        if (row) app.delete(row)
        continue
      }
      var age = row ? Date.now() - ms(row.getString("fetched_at")) : Infinity
      var due = force || !row || age >= (row.getString("status") === "error" ? RETRY_ERROR_MS : STALE_MS)
      if (due && fetchEnabled()) row = saveRow(app, u.id, s, fetchImage(url))
    }
    if (row && row.getString("status") === "ok" && row.getString("file")) return s
  }
  return ""
}

function refreshAll(app, o) {
  o = o || {}
  var users = find(app, "users", "deactivated = false", "created", o.limit || 200, {})
  var n = 0
  users.forEach(function (u) {
    try {
      refreshUser(app, u, !!o.force)
      n++
    } catch (err) {
      app.logger().warn("ach avatar refresh failed", "user", u.id, "error", String(err))
    }
  })
  return n
}

// ---------------------------------------------------------------- output

function fileUrl(row) {
  return "/api/files/avatars/" + row.id + "/" + row.getString("file") + "?thumb=128x128"
}

function chosen(rows, list) {
  for (var i = 0; i < list.length; i++) {
    var r = rows[list[i]]
    if (r && r.getString("status") === "ok" && r.getString("file")) return r
  }
  return null
}

function avatarsOut(app) {
  var list = priority(app)
  var byUser = {}
  find(app, "avatars", "status = 'ok'", "", 100000, {}).forEach(function (r) {
    var u = r.getString("user")
    ;(byUser[u] = byUser[u] || {})[r.getString("source")] = r
  })
  var users = find(app, "users", "id != ''", "created", 100000, {}).map(function (u) {
    var r = chosen(byUser[u.id] || {}, list)
    return { id: u.id, name: L().userName(u), url: r ? fileUrl(r) : null, source: r ? r.getString("source") : null }
  })
  var agents = find(app, "agents", "id != ''", "created", 100000, {}).map(function (a) {
    return { id: a.id, name: a.getString("name"), owner: a.getString("owner"), runtime: a.getString("runtime") || "other" }
  })
  return { priority: list, users: users, agents: agents }
}

function sourcesOf(app, userId) {
  var out = {}
  find(app, "avatars", "user = {:u}", "", 20, { u: userId }).forEach(function (r) {
    out[r.getString("source")] = { status: r.getString("status"), fetched_at: r.getString("fetched_at"), note: r.getString("note") }
  })
  return out
}

// ---------------------------------------------------------------- uploads

function uploadedImage(e) {
  var files
  try { files = arr(e.findUploadedFiles("file")) } catch (err) { files = [] }
  if (files.length !== 1) throw E(400, "invalid", "send one image as multipart field 'file'")
  var f = files[0]
  if (f.size > MAX_BYTES) throw E(413, "too_large", "avatar is larger than 200 KB", { max_kb: 200 })
  if (!/\.(png|jpe?g|gif|webp)$/i.test(str(f.originalName))) throw E(400, "invalid", "avatar must be a PNG, JPEG, GIF or WebP image")
  return f
}

function storeUpload(app, userId, source, f) {
  var rec = rowOf(app, userId, source) || new Record(app.findCollectionByNameOrId("avatars"))
  rec.set("user", userId)
  rec.set("source", source)
  rec.set("file", f)
  rec.set("status", "ok")
  rec.set("note", "")
  rec.set("fetched_at", nowIso())
  try {
    app.save(rec)
  } catch (err) {
    throw E(400, "invalid", "avatar must be a PNG, JPEG, GIF or WebP image of at most 200 KB")
  }
  return rec
}

// ---------------------------------------------------------------- Cloudflare Access

// ACH_CF_ALLOW: comma list mirroring the Access policy (emails, "@domain" or
// "domain" for everyone at a domain, "*" for everyone). Unset = unknown.
function accessCheck(email) {
  var on = !!str($os.getenv("ACH_CF_TEAM_DOMAIN")).trim()
  var raw = str($os.getenv("ACH_CF_ALLOW")).trim()
  if (!on) return { cf: false, covered: true, policy_known: false }
  if (!raw) return { cf: true, covered: null, policy_known: false }
  var em = str(email).trim().toLowerCase()
  var dom = em.split("@")[1] || ""
  var covered = raw.split(",").map(function (s) { return s.trim().toLowerCase() }).filter(Boolean).some(function (r) {
    if (r === "*") return true
    if (r.indexOf("@") > 0) return r === em
    return dom && r.replace(/^@/, "").replace(/^\*\./, "") === dom
  })
  return { cf: true, covered: !!em && covered, policy_known: true }
}

// ---------------------------------------------------------------- routes

var routes = {}

routes.list = {
  allow: ["user", "agent"],
  fn: function (e) { return [200, avatarsOut(e.app)] },
}

routes.putMine = {
  allow: ["user"],
  fn: function (e, ctx) {
    if (ctx.scope === "agent") throw E(403, "forbidden", "an agent session cannot change the avatar")
    var f = uploadedImage(e)
    var rec = storeUpload(e.app, ctx.user.id, "upload", f)
    return [200, { source: "upload", url: fileUrl(rec) }]
  },
}

routes.deleteMine = {
  allow: ["user"],
  fn: function (e, ctx) {
    if (ctx.scope === "agent") throw E(403, "forbidden", "an agent session cannot change the avatar")
    dropRow(e.app, ctx.user.id, "upload")
    return [200, { source: refreshUser(e.app, ctx.user, false) || null }]
  },
}

function targetUser(e) {
  var id = str(e.request.pathValue("id"))
  try { return e.app.findRecordById("users", id) } catch (err) { throw E(404, "not_found", "no such person") }
}

routes.adminPut = {
  allow: ["user"],
  fn: function (e, ctx) {
    L().requireAdmin(ctx)
    var u = targetUser(e)
    var source = str(e.request.formValue ? e.request.formValue("source") : "").trim() || "feishu"
    if (source !== "feishu" && source !== "upload") throw E(400, "invalid", "source must be feishu or upload")
    var rec = storeUpload(e.app, u.id, source, uploadedImage(e))
    return [200, { user: u.id, source: source, url: fileUrl(rec) }]
  },
}

routes.adminDelete = {
  allow: ["user"],
  fn: function (e, ctx) {
    L().requireAdmin(ctx)
    var u = targetUser(e)
    var source = str(e.request.url.query().get("source")).trim()
    if (SOURCES.indexOf(source) < 0) throw E(400, "invalid", "?source= must be one of " + SOURCES.join(", "))
    return [200, { removed: dropRow(e.app, u.id, source) }]
  },
}

routes.adminRefresh = {
  allow: ["user"],
  fn: function (e, ctx) {
    L().requireAdmin(ctx)
    var b = L().body(e)
    if (b.user) {
      var u
      try { u = e.app.findRecordById("users", str(b.user)) } catch (err) { throw E(404, "not_found", "no such person") }
      var s = refreshUser(e.app, u, !!b.force)
      return [200, { refreshed: 1, user: u.id, source: s || null, sources: sourcesOf(e.app, u.id) }]
    }
    return [200, { refreshed: refreshAll(e.app, { force: !!b.force }) }]
  },
}

routes.adminSettings = {
  allow: ["user"],
  fn: function (e, ctx) {
    L().requireAdmin(ctx)
    if (e.request.method === "PUT") {
      var b = L().body(e)
      if (b.priority === undefined) throw E(400, "invalid", "nothing to change (priority)")
      var p = parsePriority(b.priority)
      L().tx(e.app, function (app) { L().writeSetting(app, PRIORITY_KEY, p) })
    }
    return [200, { priority: priority(e.app), sources: SOURCES.slice(), fetch: fetchEnabled() }]
  },
}

routes.accessCheck = {
  allow: ["user"],
  fn: function (e, ctx) {
    L().requireAdmin(ctx)
    return [200, accessCheck(e.request.url.query().get("email"))]
  },
}

function run(e, name) {
  var r = routes[name]
  try {
    var D = L()
    var ctx = D.authenticate(e)
    D.requireAuth(ctx, r.allow, r.runModes)
    var out = r.fn(e, ctx)
    return e.json(out[0], out[1])
  } catch (err) {
    if (err && err.achError) {
      var payload = { error: err.message, code: err.code }
      if (err.extra) for (var k in err.extra) payload[k] = err.extra[k]
      return e.json(err.status, payload)
    }
    var msg = String((err && err.message) || err)
    e.app.logger().error("ach avatars route error", "route", name, "error", msg)
    return e.json(500, { error: "internal error" + ($os.getenv("ACH_TEST_HOOKS") === "1" ? ": " + msg : ""), code: "internal" })
  }
}

module.exports = {
  run: run,
  refreshAll: refreshAll,
  sniff: sniff,
  accessCheck: accessCheck,
}
