/// <reference path="../pb_data/types.d.ts" />
// Large files, references and retention. Loaded with require()
// from ach_routes.pb.js and ach_lib.js. Keep ES5-style (goja).
//
// - Reference-by-link: messages, posts and handoffs carry `attachment_refs`
//   [{url, name?, mime?, size?}] (https only) or [{upload: id}] (a direct
//   upload). Stored as entries of `attachments_meta` with `ref: "link"|"upload"`.
//   The panel previews link images/videos only from hosts on the link
//   allowlist, which also feeds the CSP's img-src/media-src.
// - Direct upload: with PocketBase's S3 storage enabled (R2, S3, OSS, TOS),
//   POST /uploads/presign returns a presigned PUT URL (AWS SigV4, implemented
//   below in plain JS: goja has no binary HMAC), the client PUTs the bytes to
//   the bucket, POST /uploads/complete checks the object (HEAD) and returns a
//   reference to attach. Without S3, nothing changes (≤ ACH_MAX_FILE_MB via the hub).
// - Retention: per channel `retention_days` (0 = keep everything). A daily cron
//   deletes attachment files and uploaded objects of terminal tasks older than
//   N days, except those flagged `keep`. Link references are never deleted
//   (the hub does not own them).
//
// The SigV4 part has no PocketBase dependencies (tested in node against the
// AWS documentation's vectors and node:crypto).

// ---------------------------------------------------------------- SHA-256 / HMAC (pure JS)

var K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

/** UTF-8 bytes of a JS string (lone surrogates become U+FFFD). */
function utf8(s) {
  s = String(s)
  var out = []
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdfff) {
      var c2 = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (c <= 0xdbff && c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
        i++
        continue
      }
      c = 0xfffd
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

function bytesOf(v) {
  return typeof v === "string" ? utf8(v) : v
}

/** SHA-256 (FIPS 180-4) of a string (UTF-8) or a byte array; returns a byte array. */
function sha256(input) {
  var msg = bytesOf(input).slice()
  var bitLen = msg.length * 8
  msg.push(0x80)
  while (msg.length % 64 !== 56) msg.push(0)
  // 64-bit big-endian length (inputs here are far below 2^53 bits)
  var hi = Math.floor(bitLen / 0x100000000)
  var lo = bitLen >>> 0
  msg.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  var W = new Array(64)
  for (var off = 0; off < msg.length; off += 64) {
    for (var t = 0; t < 16; t++) {
      var j = off + t * 4
      W[t] = ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) >>> 0
    }
    for (t = 16; t < 64; t++) {
      var x = W[t - 15]
      var y = W[t - 2]
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (t = 0; t < 64; t++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      var ch = (e & f) ^ (~e & g)
      var t1 = (h + S1 + ch + K256[t] + W[t]) >>> 0
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      var maj = (a & b) ^ (a & c) ^ (b & c)
      var t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  var out = []
  for (var k = 0; k < 8; k++) out.push((H[k] >>> 24) & 255, (H[k] >>> 16) & 255, (H[k] >>> 8) & 255, H[k] & 255)
  return out
}

/** HMAC-SHA256 (RFC 2104); key and data are strings (UTF-8) or byte arrays. */
function hmac(key, data) {
  var k = bytesOf(key)
  if (k.length > 64) k = sha256(k)
  var ipad = []
  var opad = []
  for (var i = 0; i < 64; i++) {
    var b = i < k.length ? k[i] : 0
    ipad.push(b ^ 0x36)
    opad.push(b ^ 0x5c)
  }
  return sha256(opad.concat(sha256(ipad.concat(bytesOf(data)))))
}

function hex(bytes) {
  var s = ""
  for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16)
  return s
}

// ---------------------------------------------------------------- AWS SigV4 (query-string presign)

/** RFC 3986 encoding as SigV4 wants it: only A-Z a-z 0-9 - _ . ~ stay; `/` too when keepSlash. */
function uriEncode(s, keepSlash) {
  var b = utf8(s)
  var out = ""
  for (var i = 0; i < b.length; i++) {
    var c = b[i]
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 46 || c === 126 || (keepSlash && c === 47)) {
      out += String.fromCharCode(c)
    } else {
      out += "%" + (c < 16 ? "0" : "") + c.toString(16).toUpperCase()
    }
  }
  return out
}

/** "20130524T000000Z" for a time in ms. */
function amzDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}

/** The derived SigV4 signing key (bytes). */
function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, date), region), service), "aws4_request")
}

/** {scheme, host, basePath} of an endpoint URL; throws on anything else. */
function parseEndpoint(endpoint) {
  var m = /^(https?):\/\/([A-Za-z0-9.-]+(?::[0-9]{1,5})?)(\/[^?#]*)?$/.exec(String(endpoint || "").trim())
  if (!m) throw new Error("invalid S3 endpoint")
  return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), basePath: (m[3] || "").replace(/\/+$/, "") }
}

/**
 * A presigned S3 URL (AWS Signature Version 4, query-string auth).
 * o: {method, endpoint, bucket, region, accessKey, secret, key, pathStyle,
 *     expires (s, 1..604800), now (ms), headers: {name: value} (signed besides host),
 *     query: {name: value} (extra signed query params, e.g. response-content-type)}
 * Returns {url, headers (to send), signedHeaders, canonicalRequest, stringToSign, signature}.
 */
function presign(o) {
  var ep = parseEndpoint(o.endpoint)
  var method = String(o.method || "GET").toUpperCase()
  var region = String(o.region || "us-east-1")
  // A number of seconds 1..604800; anything else is the default 900
  var ex = typeof o.expires === "number" && isFinite(o.expires) ? Math.floor(o.expires) : 900
  var expires = Math.max(1, Math.min(604800, ex))
  var stamp = amzDate(o.now === undefined ? Date.now() : o.now)
  var date = stamp.slice(0, 8)
  var host = o.pathStyle ? ep.host : String(o.bucket) + "." + ep.host
  // S3 does not normalize the path: each key segment is encoded once, "/" kept.
  var path = ep.basePath + (o.pathStyle ? "/" + uriEncode(o.bucket, false) : "") + "/" + uriEncode(o.key, true)
  var hdrs = { host: host }
  var extra = o.headers || {}
  Object.keys(extra).forEach(function (k) { hdrs[k.toLowerCase()] = String(extra[k]).trim().replace(/\s+/g, " ") })
  var names = Object.keys(hdrs).sort()
  var signedHeaders = names.join(";")
  var scope = date + "/" + region + "/s3/aws4_request"
  var q = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": String(o.accessKey) + "/" + scope,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signedHeaders,
  }
  var more = o.query || {}
  Object.keys(more).forEach(function (k) { q[k] = String(more[k]) })
  var pairs = Object.keys(q).map(function (k) { return [uriEncode(k, false), uriEncode(q[k], false)] })
  pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0 })
  var query = pairs.map(function (p) { return p[0] + "=" + p[1] }).join("&")
  var canonicalHeaders = names.map(function (n) { return n + ":" + hdrs[n] + "\n" }).join("")
  var canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n")
  var stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(sha256(canonicalRequest))].join("\n")
  var signature = hex(hmac(signingKey(String(o.secret), date, region, "s3"), stringToSign))
  var send = {}
  Object.keys(extra).forEach(function (k) { send[k.toLowerCase()] = String(extra[k]) })
  return {
    url: ep.scheme + "://" + host + path + "?" + query + "&X-Amz-Signature=" + signature,
    headers: send,
    signedHeaders: signedHeaders,
    canonicalRequest: canonicalRequest,
    stringToSign: stringToSign,
    signature: signature,
  }
}

// ---------------------------------------------------------------- hub side

var MEDIA_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" }
var REF_MAX = 10
var URL_MAX = 2048
var LINK_STORE_KEY = "ach_link_hosts"
var PENDING_MAX = 10
var PENDING_TTL_MS = 3600 * 1000
var PUT_TTL_S = 900
var GET_TTL_S = 3600
var RETENTION_MAX_DAYS = 3650
var RETENTION_BATCH = 500
var UPLOAD_ID_RE = /^[a-z0-9]{15}$/
var MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/

function L() { return require(__hooks + "/ach_lib.js").storageDeps() }
function AchError(status, code, message, extra) { this.achError = true; this.status = status; this.code = code; this.message = message; this.extra = extra || null }
function E(status, code, message, extra) { return new AchError(status, code, message, extra) }
function str(v) { return v === undefined || v === null ? "" : String(v) }
function arr(v) { return Array.isArray(v) ? v : [] }
function parseJSON(s) { if (!s) return null; try { return typeof s === "string" ? JSON.parse(s) : s } catch (err) { return null } }
function envNum(name, def) { var v = parseFloat($os.getenv(name) || ""); return isNaN(v) ? def : v }
function find(app, coll, filter, sort, limit, params) { return app.findRecordsByFilter(coll, filter, sort || "", limit || 1000, 0, params || {}) }
function extOf(name) { var m = /\.([A-Za-z0-9]+)$/.exec(str(name)); return m ? m[1].toLowerCase() : "" }
function cleanText(s, max) { return str(s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) }
function metaOf(rec) { var m = parseJSON(rec.getString("attachments_meta")); return Array.isArray(m) ? m : [] }

/** The S3 settings when PocketBase stores files in S3-compatible storage, else null. */
function s3Config(app) {
  var s
  try { s = app.settings().s3 } catch (err) { return null }
  if (!s || !s.enabled || !s.bucket || !s.endpoint) return null
  var ep
  try { ep = parseEndpoint(s.endpoint) } catch (err) { return null }
  // plain http only for a local endpoint (MinIO on the same box, tests)
  if (ep.scheme !== "https" && !/^(127\.0\.0\.1|localhost)(:|$)/.test(ep.host)) return null
  return { endpoint: str(s.endpoint), bucket: str(s.bucket), region: str(s.region) || "auto", accessKey: str(s.accessKey), secret: str(s.secret), pathStyle: !!s.forcePathStyle, ep: ep }
}

function directEnabled(app) {
  if ($os.getenv("ACH_DIRECT_UPLOAD") === "0") return null
  return s3Config(app)
}

function directMaxBytes() { return Math.floor(envNum("ACH_DIRECT_MAX_MB", 5120) * 1024 * 1024) }
// Files above this go direct (CLI and panel). Cloudflare's free plan caps request bodies at 100 MB.
function directThresholdMb() { return Math.max(5, envNum("ACH_DIRECT_THRESHOLD_MB", 90)) }

/** The origin the browser talks to for presigned URLs (CSP connect/img/media). */
function storageOrigin(cfg) {
  return cfg.ep.scheme + "://" + (cfg.pathStyle ? cfg.ep.host : cfg.bucket + "." + cfg.ep.host)
}

function s3Url(cfg, method, key, expires, headers, query) {
  return presign({
    method: method, endpoint: cfg.endpoint, bucket: cfg.bucket, region: cfg.region, accessKey: cfg.accessKey,
    secret: cfg.secret, key: key, pathStyle: cfg.pathStyle, expires: expires, now: L().nowMs(), headers: headers, query: query,
  })
}

// ---- link allowlist

/** {hosts: [domain], only: bool}. hosts: previews (and the CSP) allow them and their subdomains; only: reject other hosts. */
function linkSettings(app) {
  var cached = app.store().get(LINK_STORE_KEY)
  if (cached) {
    var c = parseJSON(cached)
    if (c && Array.isArray(c.hosts)) return c
  }
  var D = L()
  var hosts = []
  var only = false
  try { var v = D.readSetting(app, "link_hosts"); if (Array.isArray(v)) hosts = v.map(String) } catch (err) {}
  try { only = D.readSetting(app, "link_hosts_only") === true } catch (err) {}
  var out = { hosts: hosts, only: only }
  app.store().set(LINK_STORE_KEY, JSON.stringify(out))
  return out
}

function parseHosts(v) {
  var D = L()
  var list = typeof v === "string" ? v.split(/[\s,]+/) : v
  if (!Array.isArray(list)) throw E(400, "invalid", "link_hosts must be a list of domains")
  var out = []
  list.forEach(function (d) {
    d = str(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^\*\./, "")
    if (!d) return
    if (d.length > 253 || !D.DOMAIN_RE.test(d) || d.indexOf(".") < 0) throw E(400, "invalid", "link host '" + d + "' is not a domain")
    if (D.isPublicSuffix(d)) throw E(400, "public_suffix", "link host '" + d + "' is a public suffix (anyone can host under it); name the bucket's host")
    if (out.indexOf(d) < 0) out.push(d)
  })
  if (out.length > 50) throw E(400, "invalid", "at most 50 link hosts")
  return out
}

function hostAllowed(host, list) {
  host = str(host).toLowerCase()
  for (var i = 0; i < list.length; i++) {
    var d = list[i]
    if (host === d || (host.length > d.length && host.slice(-(d.length + 1)) === "." + d)) return true
  }
  return false
}

/** Extra CSP sources: link preview hosts (img/media) and the bucket origin (img/media/connect). */
function cspSources(app) {
  var out = { img: [], media: [], connect: [] }
  linkSettings(app).hosts.forEach(function (h) {
    out.img.push("https://" + h, "https://*." + h)
    out.media.push("https://" + h, "https://*." + h)
  })
  var cfg = directEnabled(app)
  if (cfg) {
    var o = storageOrigin(cfg)
    out.img.push(o)
    out.media.push(o)
    out.connect.push(o)
  }
  return out
}

/** A link reference's URL, or throws 400. */
function checkLinkUrl(app, u) {
  u = str(u).trim()
  if (!u || u.length > URL_MAX) throw E(400, "invalid_attachment", "attachment link must be an https URL up to " + URL_MAX + " characters")
  var m = /^https:\/\/([A-Za-z0-9.-]+)(:[0-9]{1,5})?(\/[^\s"'<>\\^`{|}]*)?$/.exec(u)
  if (!m) throw E(400, "invalid_attachment", "attachment link must be an https URL (no credentials, spaces or quotes)")
  var host = m[1].toLowerCase()
  if (host.indexOf(".") < 0 || /^[0-9.]+$/.test(host)) throw E(400, "invalid_attachment", "attachment link needs a domain name")
  var ls = linkSettings(app)
  if (ls.only && !hostAllowed(host, ls.hosts)) throw E(400, "link_host_not_allowed", "links to '" + host + "' are not allowed on this hub", { link_hosts: ls.hosts })
  return { url: u, host: host, path: (m[3] || "/").split(/[?#]/)[0] }
}

// ---- references on records

function principalOf(ctx) {
  if (ctx.type === "user") return "user:" + ctx.user.id
  if (ctx.agent) return "agent:" + ctx.agent.id
  return ""
}

/**
 * Called by ach_lib uploads(e): the request's `attachment_refs`, checked for
 * shape; ownership and target are checked when they are applied to a record.
 * Returns {refs: [...], principal} or null.
 */
function parseRefs(e) {
  var b
  try { b = L().body(e) } catch (err) { return null }
  var raw = b && b.attachment_refs
  if (raw === undefined || raw === null || raw === "") return null
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string") raw = raw[0]
  if (typeof raw === "string") raw = parseJSON(raw)
  if (!Array.isArray(raw)) throw E(400, "invalid_attachment", "attachment_refs must be a list of {url, name?, mime?, size?} or {upload}")
  if (!raw.length) return null
  if (raw.length > REF_MAX) throw E(400, "invalid", "at most " + REF_MAX + " attachment references per request")
  var app = e.app
  var refs = raw.map(function (r) {
    if (!r || typeof r !== "object") throw E(400, "invalid_attachment", "attachment reference must be an object")
    if (r.upload !== undefined) {
      var id = str(r.upload)
      if (!UPLOAD_ID_RE.test(id)) throw E(400, "invalid_attachment", "unknown upload")
      return { upload: id, keep: r.keep === true }
    }
    var link = checkLinkUrl(app, r.url)
    var seg = link.path.split("/").pop() || link.host
    var name = cleanText(r.name, 255)
    if (!name) {
      try { name = cleanText(decodeURIComponent(seg), 255) } catch (err) { name = cleanText(seg, 255) }
    }
    var mime = str(r.mime).toLowerCase().trim()
    if (mime && !MIME_RE.test(mime)) throw E(400, "invalid_attachment", "attachment mime '" + mime.slice(0, 80) + "' is not a MIME type")
    if (!mime) mime = MEDIA_EXT[extOf(link.path)] || ""
    var size = r.size === undefined || r.size === null || r.size === "" ? null : Number(r.size)
    if (size !== null && (!isFinite(size) || size < 0 || Math.floor(size) !== size)) throw E(400, "invalid_attachment", "attachment size must be a whole number of bytes")
    var out = { ref: "link", url: link.url, name: name || "link", original: name || "link", type: mime || "application/octet-stream", keep: r.keep === true }
    if (size !== null) out.size = size
    return out
  })
  var principal = ""
  try {
    var ctx = L().authenticate(e)
    principal = principalOf(ctx)
  } catch (err) {}
  return { refs: refs, principal: principal }
}

/** Where a record lives: {task, channel, root}. */
function mayFlag(app, ctx, rec, place) {
  if (ctx.type === "user" && ctx.isAdmin) return true
  var uid = ctx.type === "user" ? ctx.user.id : ""
  var aid = ctx.agent ? ctx.agent.id : ""
  var owner = function (agentId) { try { return app.findRecordById("agents", agentId).getString("owner") } catch (err) { return "" } }
  if (uid && rec.getString("author_user") === uid) return true
  if (aid && rec.getString("author_agent") === aid) return true
  if (uid && rec.getString("author_agent") && owner(rec.getString("author_agent")) === uid) return true
  if (place.task) {
    var t = null
    try { t = app.findRecordById("tasks", place.task) } catch (err) { t = null }
    if (t) {
      if (aid && (t.getString("from_agent") === aid || t.getString("to_agent") === aid)) return true
      if (uid && (t.getString("owner_user") === uid || owner(t.getString("from_agent")) === uid || owner(t.getString("to_agent")) === uid)) return true
    }
  }
  return false
}

function placeOf(app, coll, rec) {
  if (coll === "posts") {
    var root = rec.getString("parent") || rec.id
    var task = rec.getString("task")
    if (!task && rec.getString("parent")) {
      try { task = app.findRecordById("posts", rec.getString("parent")).getString("task") } catch (err) {}
    }
    return { task: task, channel: rec.getString("channel"), root: root }
  }
  var t = rec.getString("task")
  var ch = ""
  try { ch = app.findRecordById("tasks", t).getString("channel") } catch (err) {}
  return { task: t, channel: ch, root: "" }
}

function targetMatches(app, up, coll, place) {
  var kind = up.getString("target_kind")
  if (kind === "task") return !!place.task && up.getString("task") === place.task
  if (kind === "channel") return coll === "posts" && up.getString("channel") === place.channel
  if (kind === "post") return coll === "posts" && up.getString("post") === place.root
  if (kind === "new_task") return coll === "handoff_versions"
  return false
}

/** Merges parsed references into rec.attachments_meta (and saves rec). Uploads are bound to the record. */
function applyRefs(app, rec, parsed) {
  if (!parsed || !parsed.refs || !parsed.refs.length) return
  var coll = rec.collection().name
  var place = placeOf(app, coll, rec)
  var meta = metaOf(rec)
  parsed.refs.forEach(function (r) {
    if (r.ref === "link") {
      meta.push(r)
      return
    }
    var up
    try { up = app.findRecordById("ach_uploads", r.upload) } catch (err) { throw E(400, "invalid_attachment", "unknown upload") }
    if (!parsed.principal || up.getString("principal") !== parsed.principal) throw E(400, "invalid_attachment", "unknown upload")
    if (up.getString("status") !== "complete") throw E(409, "upload_not_ready", "upload " + up.id + " is " + (up.getString("status") === "attached" ? "already attached" : "not complete (call /uploads/complete)"))
    if (!targetMatches(app, up, coll, place)) throw E(400, "upload_target_mismatch", "upload " + up.id + " was presigned for another target")
    up.set("status", "attached")
    up.set("record", coll + "/" + rec.id)
    up.set("task", place.task || up.getString("task"))
    up.set("channel", place.channel || up.getString("channel"))
    if (r.keep) up.set("keep", true)
    app.save(up)
    meta.push({ ref: "upload", upload: up.id, name: up.getString("name"), original: up.getString("name"), type: up.getString("mime"), size: up.getInt("size"), keep: up.getBool("keep") })
  })
  rec.set("attachments_meta", meta)
  app.save(rec)
}

/** Reference entries of a record as API attachment objects (ach_lib attOut). */
function refsOut(meta) {
  var out = []
  arr(meta).forEach(function (x) {
    if (!x || !x.ref || x.purged) return
    if (x.ref === "link") {
      var o = { ref: "link", name: str(x.name), original: str(x.original || x.name), type: str(x.type), url: str(x.url) }
      if (x.size !== undefined) o.size = Number(x.size) || 0
      if (x.keep) o.keep = true
      out.push(o)
    } else if (x.ref === "upload" && UPLOAD_ID_RE.test(str(x.upload))) {
      out.push({ ref: "upload", upload: x.upload, name: str(x.name), original: str(x.original || x.name), type: str(x.type), size: Number(x.size) || 0, url: "/api/ach/uploads/" + x.upload + "/raw", keep: !!x.keep })
    }
  })
  return out
}

// ---- targets and scoping

/** "task:<ref>" | "channel:<id|name>" | "post:<id>" | "new_task" -> {kind, task, channel, post}, authorized for ctx. */
function resolveTarget(app, ctx, target) {
  var D = L()
  var s = str(target).trim()
  var m = /^(task|channel|post):(.{1,100})$/.exec(s)
  if (s === "new_task") {
    if (ctx.type !== "agent") throw E(403, "forbidden", "only an agent key can upload for a new task")
    return { kind: "new_task", task: "", channel: "", post: "" }
  }
  if (!m) throw E(400, "invalid", "target must be task:<id>, channel:<name>, post:<id> or new_task")
  if (m[1] === "task") {
    var t = D.findTask(app, m[2], "task")
    D.requireChannelVisible(ctx, t.getString("channel"), "task")
    if (ctx.type === "run") {
      if (["work", "answer"].indexOf(ctx.mode) < 0) throw E(403, "forbidden", "run token mode '" + ctx.mode + "' may not upload to a task")
      D.checkRunTask(ctx, t)
    } else if (ctx.type === "agent" && !D.isParty(ctx.agent.id, t)) {
      throw E(403, "forbidden", "agents upload only to tasks they are a party to")
    }
    if (D.TERMINAL[t.getString("status")]) throw E(409, "terminal", "task is " + t.getString("status"), { status: t.getString("status") })
    return { kind: "task", task: t.id, channel: t.getString("channel"), post: "" }
  }
  if (m[1] === "channel") {
    if (ctx.type === "run") throw E(403, "forbidden", "run tokens cannot post to a channel")
    var c = D.findChannel(app, m[2])
    D.requireChannelVisible(ctx, c.id)
    if (c.getBool("archived")) throw E(409, "archived", "channel is archived")
    return { kind: "channel", task: "", channel: c.id, post: "" }
  }
  var p = D.findOr404(app, "posts", m[2], "post")
  D.requireChannelVisible(ctx, p.getString("channel"), "post")
  var root = D.threadRoot(app, p)
  D.requireRunThread(app, ctx, root)
  return { kind: "post", task: root.getString("task"), channel: root.getString("channel"), post: root.id }
}

/** Can ctx read an upload (download redirect)? */
function canRead(app, ctx, up) {
  var D = L()
  if (up.getString("principal") === principalOf(ctx)) return true
  if (up.getString("status") !== "attached") return false
  var ch = up.getString("channel")
  if (ch && D.channelHidden(ctx, ch)) return false
  var task = up.getString("task")
  if (ctx.type === "user") return true
  if (ctx.type === "run") {
    var sc = D.runScope(app, ctx)
    if (task) return !!sc.task && sc.task.id === task
    return sc.channel === ch
  }
  if (task && up.getString("record").indexOf("posts/") !== 0) {
    try { return D.isParty(ctx.agent.id, app.findRecordById("tasks", task)) } catch (err) { return false }
  }
  return true
}

function safeName(name, mime) {
  var base = str(name).split(/[\\/]/).pop()
  var ext = extOf(base)
  var stem = base.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(0, 100) || "file"
  return stem + "." + ext
}

function uploadOut(up) {
  return { id: up.id, name: up.getString("name"), mime: up.getString("mime"), size: up.getInt("size"), status: up.getString("status"), target: up.getString("target"), keep: up.getBool("keep") }
}

// ---------------------------------------------------------------- routes

var routes = {}

routes.config = {
  allow: ["agent", "run", "user"],
  runModes: ["work", "answer", "mention"],
  fn: function (e) {
    var cfg = directEnabled(e.app)
    var ls = linkSettings(e.app)
    return [200, {
      direct_upload: !!cfg,
      direct_threshold_mb: directThresholdMb(),
      direct_max_mb: Math.round(directMaxBytes() / 1048576),
      direct_mime: Object.keys(MEDIA_EXT).map(function (k) { return MEDIA_EXT[k] }).filter(function (v, i, a) { return a.indexOf(v) === i }),
      storage_origin: cfg ? storageOrigin(cfg) : "",
      link_hosts: ls.hosts,
      link_hosts_only: ls.only,
    }]
  },
}

routes.presign = {
  allow: ["agent", "run", "user"],
  runModes: ["work", "answer", "mention"],
  fn: function (e, ctx) {
    var app = e.app
    var cfg = directEnabled(app)
    if (!cfg) throw E(409, "direct_upload_disabled", "direct upload needs S3-compatible storage (PocketBase settings > Files storage); send the file to the hub instead", { max_file_mb: Math.round(envNum("ACH_MAX_FILE_MB", 200)) })
    var b = L().body(e)
    var name = cleanText(b.name, 255)
    var mime = str(b.mime).toLowerCase().trim()
    var size = Number(b.size)
    if (!name) throw E(400, "invalid", "name is required")
    if (!MEDIA_EXT[extOf(name)] || MEDIA_EXT[extOf(name)] !== mime) {
      throw E(400, "invalid_attachment", "direct upload takes images and videos (png, jpg, webp, gif, mp4, webm, mov) whose mime matches the extension")
    }
    if (!isFinite(size) || size <= 0 || Math.floor(size) !== size) throw E(400, "invalid", "size must be the file's size in bytes")
    var max = directMaxBytes()
    if (size > max) throw E(413, "too_large", "'" + name + "' is larger than " + Math.round(max / 1048576) + " MB", { max_direct_mb: Math.round(max / 1048576) })
    var tg = resolveTarget(app, ctx, b.target)
    var principal = principalOf(ctx)
    // Unfinished uploads per principal are capped by count and bytes, and expire after an hour
    var pending = find(app, "ach_uploads", "principal = {:p} && status = 'pending' && created > {:cut}", "", PENDING_MAX + 1, { p: principal, cut: L().iso(L().nowMs() - PENDING_TTL_MS).replace("T", " ") })
    var pendingBytes = pending.reduce(function (n, x) { return n + x.getInt("size") }, 0)
    if (pending.length >= PENDING_MAX || pendingBytes + size > 2 * max) throw E(429, "too_many_uploads", "too many unfinished uploads; complete or wait for them to expire", { pending: pending.length, pending_mb: Math.round(pendingBytes / 1048576) })
    var key = (str($os.getenv("ACH_UPLOAD_PREFIX")) || "ach-uploads").replace(/^\/+|\/+$/g, "") + "/" + L().iso(L().nowMs()).slice(0, 7) + "/" + $security.randomStringWithAlphabet(24, "abcdefghijklmnopqrstuvwxyz0123456789") + "/" + safeName(name, mime)
    var up = new Record(app.findCollectionByNameOrId("ach_uploads"))
    up.set("key", key)
    up.set("name", name)
    up.set("mime", mime)
    up.set("size", size)
    up.set("status", "pending")
    up.set("principal", principal)
    up.set("target", str(b.target).trim().slice(0, 120))
    up.set("target_kind", tg.kind)
    up.set("task", tg.task)
    up.set("channel", tg.channel)
    up.set("post", tg.post)
    app.save(up)
    // The size and "no overwrite" are part of the signature
    var p = s3Url(cfg, "PUT", key, PUT_TTL_S, { "content-type": mime, "content-length": String(size), "if-none-match": "*" })
    return [201, { upload: uploadOut(up), put: { url: p.url, method: "PUT", headers: p.headers, expires_in: PUT_TTL_S } }]
  },
}

/** HEAD the object: {status, size, type}. */
function headObject(cfg, key) {
  var p = s3Url(cfg, "HEAD", key, 300)
  var res = $http.send({ url: p.url, method: "HEAD", timeout: 20 })
  var h = res.headers || {}
  var get = function (n) {
    for (var k in h) if (k.toLowerCase() === n) { var v = h[k]; return str(Array.isArray(v) ? v[0] : v) }
    return ""
  }
  return { status: res.statusCode, size: parseInt(get("content-length") || "-1", 10), type: get("content-type").split(";")[0].trim().toLowerCase() }
}

function deleteObject(cfg, key) {
  var p = s3Url(cfg, "DELETE", key, 300)
  var res = $http.send({ url: p.url, method: "DELETE", timeout: 20 })
  return res.statusCode >= 200 && res.statusCode < 300 || res.statusCode === 404
}

routes.complete = {
  allow: ["agent", "run", "user"],
  runModes: ["work", "answer", "mention"],
  fn: function (e, ctx) {
    var app = e.app
    var cfg = directEnabled(app)
    if (!cfg) throw E(409, "direct_upload_disabled", "direct upload is not configured")
    var b = L().body(e)
    var id = str(b.upload || b.id)
    var up
    try { up = UPLOAD_ID_RE.test(id) ? app.findRecordById("ach_uploads", id) : null } catch (err) { up = null }
    if (!up || up.getString("principal") !== principalOf(ctx)) throw E(404, "not_found", "upload not found")
    if (up.getString("status") === "complete" || up.getString("status") === "attached") return [200, { upload: uploadOut(up), ref: { upload: up.id, name: up.getString("name"), mime: up.getString("mime"), size: up.getInt("size") } }]
    if (up.getString("status") !== "pending") throw E(409, "upload_failed", "upload is " + up.getString("status"))
    if (Date.parse(up.getString("created").replace(" ", "T")) < L().nowMs() - PENDING_TTL_MS - PUT_TTL_S * 1000) throw E(409, "upload_failed", "upload expired; start again")
    var h
    try { h = headObject(cfg, up.getString("key")) } catch (err) { throw E(502, "storage_unreachable", "could not reach the storage bucket: " + String(err).slice(0, 200)) }
    if (h.status === 404 || h.status === 403) throw E(409, "not_uploaded", "the object is not in the bucket yet (PUT it to the presigned URL first)")
    if (h.status < 200 || h.status >= 300) throw E(502, "storage_error", "storage answered HTTP " + h.status)
    var bad = ""
    if (h.size !== up.getInt("size")) bad = "size " + h.size + " does not match the declared " + up.getInt("size")
    else if (h.type && h.type !== up.getString("mime")) bad = "content type " + h.type + " does not match " + up.getString("mime")
    if (bad) {
      try { deleteObject(cfg, up.getString("key")) } catch (err) {}
      up.set("status", "failed")
      app.save(up)
      throw E(400, "upload_mismatch", "upload rejected: " + bad)
    }
    up.set("status", "complete")
    app.save(up)
    return [200, { upload: uploadOut(up), ref: { upload: up.id, name: up.getString("name"), mime: up.getString("mime"), size: up.getInt("size") } }]
  },
}

// GET /uploads/{id}/raw: a redirect to a short-lived presigned GET. Credentials:
// Authorization (agent key, run token, user) or ?token=<PocketBase file token>
// (the panel's <img>/<video>, like protected files).
routes.raw = {
  allow: ["public"],
  fn: function (e) {
    var app = e.app
    var D = L()
    var ctx
    var ft = str(e.request.url.query().get("token"))
    if (D.bearerOf(e)) {
      ctx = D.authenticate(e)
      D.requireAuth(ctx, ["agent", "run", "user"], ["work", "answer", "mention"])
    } else if (ft) {
      var u
      try { u = app.findAuthRecordByToken(ft, "file") } catch (err) { u = null }
      if (!u || u.collection().name !== "users" || u.getBool("deactivated")) throw E(401, "unauthorized", "invalid file token")
      ctx = { type: "user", user: u, scope: "", adminRole: u.getBool("is_admin"), isAdmin: false }
    } else {
      throw E(401, "unauthorized", "missing credentials")
    }
    D.hiddenChannels(app, ctx)
    var id = str(e.request.pathValue("id"))
    var up
    try { up = UPLOAD_ID_RE.test(id) ? app.findRecordById("ach_uploads", id) : null } catch (err) { up = null }
    if (!up || up.getString("status") === "deleted" || up.getString("status") === "failed" || !canRead(app, ctx, up)) throw E(404, "not_found", "file not found")
    var cfg = directEnabled(app)
    if (!cfg) throw E(409, "direct_upload_disabled", "storage is not configured")
    var p = s3Url(cfg, "GET", up.getString("key"), GET_TTL_S)
    e.response.header().set("Cache-Control", "private, no-store")
    e.response.header().set("Referrer-Policy", "no-referrer")
    e.redirect(302, p.url)
    return null
  },
}

// POST /attachments/keep {task | collection+record} + optional {name | upload | url}, keep: true|false.
// With only `task`, every attachment of the task (handoffs, messages, its thread) is flagged.
routes.keep = {
  allow: ["agent", "user"],
  fn: function (e, ctx) {
    var D = L()
    var b = D.body(e)
    var keep = b.keep !== false
    return D.tx(e.app, function (app) {
      var recs = []
      var task = null
      if (b.task) {
        task = D.findTask(app, b.task, "task")
        find(app, "handoff_versions", "task = {:t}", "", 1000, { t: task.id }).forEach(function (r) { recs.push(r) })
        find(app, "messages", "task = {:t}", "", 5000, { t: task.id }).forEach(function (r) { recs.push(r) })
        var anchor = find(app, "posts", "task = {:t} && kind = 'task'", "", 1, { t: task.id })
        if (anchor.length) find(app, "posts", "id = {:a} || parent = {:a}", "", 5000, { a: anchor[0].id }).forEach(function (r) { recs.push(r) })
      } else {
        var coll = str(b.collection)
        if (["messages", "handoff_versions", "posts"].indexOf(coll) < 0) throw E(400, "invalid", "collection must be messages, handoff_versions or posts (or pass task)")
        recs.push(D.findOr404(app, coll, b.record, "record"))
      }
      if (!recs.length) return [200, { kept: 0 }]
      var place = placeOf(app, recs[0].collection().name, recs[0])
      D.requireChannelVisible(ctx, place.channel, "record")
      if (ctx.type === "agent" && place.task && recs[0].collection().name !== "posts") {
        if (!D.isParty(ctx.agent.id, app.findRecordById("tasks", place.task))) throw E(403, "forbidden", "agents can flag only attachments of their own tasks")
      }
      // Only the uploader/poster, a party (or party owner) of the task, or an admin
      if (!mayFlag(app, ctx, recs[0], place)) throw E(403, "forbidden", "only the uploader, the task's parties or an admin may change keep flags")
      // which entries: one (name | upload | url) or, with only `task`, all of them
      var pick = b.name ? function (x) { return !x.ref && x.name === str(b.name) }
        : b.upload ? function (x) { return x.ref === "upload" && x.upload === str(b.upload) }
        : b.url ? function (x) { return x.ref === "link" && x.url === str(b.url) }
        : task ? function () { return true } : null
      if (!pick) throw E(400, "invalid", "name, upload or url is required (or pass task to flag all its attachments)")
      var n = 0
      recs.forEach(function (rec) {
        var names = arr(rec.getStringSlice("attachments"))
        var meta = metaOf(rec)
        var changed = false
        // files without a meta row (older records) get one so the flag sticks
        names.forEach(function (nm) {
          if (!meta.some(function (x) { return x && !x.ref && x.name === nm })) { meta.push({ name: nm, original: nm, size: 0, type: "" }); changed = true }
        })
        meta.forEach(function (x) {
          if (!x || x.purged || !pick(x)) return
          if (!x.ref && names.indexOf(x.name) < 0) return
          n++
          if (!!x.keep !== keep) { x.keep = keep; changed = true }
          if (x.ref === "upload") {
            try { var up = app.findRecordById("ach_uploads", x.upload); up.set("keep", keep); app.save(up) } catch (err) {}
          }
        })
        if (changed) {
          rec.set("attachments_meta", meta)
          app.save(rec)
        }
      })
      if (!n) throw E(404, "not_found", "attachment not found")
      return [200, { kept: keep ? n : 0, unkept: keep ? 0 : n }]
    })
  },
}

routes.getRetention = {
  allow: ["agent", "user"],
  fn: function (e, ctx) {
    var D = L()
    var c = D.findChannel(e.app, e.request.pathValue("id"))
    D.requireChannelVisible(ctx, c.id)
    return [200, { channel: c.getString("name"), retention_days: c.getInt("retention_days") }]
  },
}

routes.putRetention = {
  allow: ["user"],
  fn: function (e, ctx) {
    var D = L()
    D.requireAdmin(ctx)
    var b = D.body(e)
    var days = Number(b.days !== undefined ? b.days : b.retention_days)
    if (!isFinite(days) || days < 0 || days > RETENTION_MAX_DAYS || Math.floor(days) !== days) throw E(400, "invalid", "days must be 0 (keep everything) to " + RETENTION_MAX_DAYS)
    return D.tx(e.app, function (app) {
      var c = D.findChannel(app, e.request.pathValue("id"))
      c.set("retention_days", days)
      app.save(c)
      return [200, { channel: c.getString("name"), retention_days: days }]
    })
  },
}

routes.adminSettings = {
  allow: ["user"],
  fn: function (e, ctx) {
    var D = L()
    D.requireAdmin(ctx)
    var app = e.app
    if (e.request.method !== "GET") {
      var b = D.body(e)
      if (b.link_hosts === undefined && b.link_hosts_only === undefined) throw E(400, "invalid", "nothing to change (link_hosts, link_hosts_only)")
      var hosts = b.link_hosts === undefined ? null : parseHosts(b.link_hosts)
      D.tx(app, function (txa) {
        if (hosts) D.writeSetting(txa, "link_hosts", hosts)
        if (b.link_hosts_only !== undefined) D.writeSetting(txa, "link_hosts_only", b.link_hosts_only === true)
      })
      app.store().remove(LINK_STORE_KEY)
    }
    var ls = linkSettings(app)
    return [200, { link_hosts: ls.hosts, link_hosts_only: ls.only }]
  },
}

function sumRows(app, sql) {
  var rows = arrayOf(new DynamicModel({ ch: "", n: 0, bytes: 0 }))
  app.db().newQuery(sql).all(rows)
  return rows
}

var META_EACH = function (t) {
  return "json_each(CASE WHEN json_valid(" + t + ".attachments_meta) THEN " + t + ".attachments_meta ELSE '[]' END) j"
}
var HUB_FILE = "json_extract(j.value, '$.ref') IS NULL AND json_extract(j.value, '$.purged') IS NULL"

// GET /admin/storage/detail: hub-stored files and direct uploads per channel, links, retention.
routes.adminDetail = {
  allow: ["user"],
  fn: function (e, ctx) {
    var D = L()
    D.requireAdmin(ctx)
    var app = e.app
    var by = {}
    var add = function (ch, kind, n, bytes) {
      var k = ch || ""
      if (!by[k]) by[k] = { files: 0, bytes: 0, direct_files: 0, direct_bytes: 0 }
      if (kind === "direct") { by[k].direct_files += n; by[k].direct_bytes += bytes } else { by[k].files += n; by[k].bytes += bytes }
    }
    var SZ = "COALESCE(SUM(CAST(json_extract(j.value, '$.size') AS INTEGER)), 0)"
    sumRows(app, "SELECT p.channel AS ch, COUNT(*) AS n, " + SZ + " AS bytes FROM posts p, " + META_EACH("p") + " WHERE " + HUB_FILE + " GROUP BY p.channel").forEach(function (r) { add(r.ch, "hub", r.n, r.bytes) })
    ;["messages", "handoff_versions"].forEach(function (c) {
      sumRows(app, "SELECT t.channel AS ch, COUNT(*) AS n, " + SZ + " AS bytes FROM " + c + " m JOIN tasks t ON t.id = m.task, " + META_EACH("m") + " WHERE " + HUB_FILE + " GROUP BY t.channel").forEach(function (r) { add(r.ch, "hub", r.n, r.bytes) })
    })
    sumRows(app, "SELECT channel AS ch, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM ach_uploads WHERE status IN ('attached', 'complete', 'pending') GROUP BY channel").forEach(function (r) { add(r.ch, "direct", r.n, r.bytes) })
    var links = 0
    ;["posts", "messages", "handoff_versions"].forEach(function (c) {
      var row = new DynamicModel({ n: 0 })
      app.db().newQuery("SELECT COUNT(*) AS n FROM " + c + " p, " + META_EACH("p") + " WHERE json_extract(j.value, '$.ref') = 'link'").one(row)
      links += row.n
    })
    var kept = new DynamicModel({ n: 0 })
    app.db().newQuery("SELECT COUNT(*) AS n FROM ach_uploads WHERE keep = TRUE AND status = 'attached'").one(kept)
    var channels = find(app, "channels", "id != ''", "name", 1000, {}).map(function (c) {
      var u = by[c.id] || { files: 0, bytes: 0, direct_files: 0, direct_bytes: 0 }
      return { id: c.id, name: c.getString("name"), retention_days: c.getInt("retention_days"), files: u.files, bytes: u.bytes, direct_files: u.direct_files, direct_bytes: u.direct_bytes }
    })
    var direct = { files: 0, bytes: 0 }
    var hub = { files: 0, bytes: 0 }
    Object.keys(by).forEach(function (k) { direct.files += by[k].direct_files; direct.bytes += by[k].direct_bytes; hub.files += by[k].files; hub.bytes += by[k].bytes })
    var cfg = directEnabled(app)
    var last = null
    try { last = D.readSetting(app, "retention_last_run") || null } catch (err) {}
    return [200, {
      storage: s3Config(app) ? "s3" : "local", direct_upload: !!cfg, direct_threshold_mb: directThresholdMb(), direct_max_mb: Math.round(directMaxBytes() / 1048576),
      hub_files: hub, direct_uploads: direct, link_refs: links, kept_uploads: kept.n, channels: channels, retention_last_run: last,
    }]
  },
}

// ---------------------------------------------------------------- retention

/**
 * Deletes attachments of terminal tasks older than their channel's
 * retention_days (by the task's last update), except entries flagged keep.
 * Hub files leave the record's file field; uploaded objects are deleted from
 * the bucket. Link references stay. Also expires unfinished uploads (> 24 h).
 * Returns counts.
 */
function sweepRetention(app, now) {
  var D = L()
  var out = { tasks: 0, files: 0, uploads: 0, bytes: 0, expired_uploads: 0, errors: 0 }
  var cfg = directEnabled(app)
  var channels = find(app, "channels", "retention_days > 0", "", 1000, {})
  channels.forEach(function (c) {
    var cutoff = D.iso(now - c.getInt("retention_days") * 86400000).replace("T", " ")
    var tasks = find(app, "tasks", "channel = {:c} && (status = 'completed' || status = 'failed' || status = 'canceled') && updated < {:cut}", "updated", RETENTION_BATCH, { c: c.id, cut: cutoff })
    tasks.forEach(function (t) {
      var recs = []
      find(app, "handoff_versions", "task = {:t}", "", 1000, { t: t.id }).forEach(function (r) { recs.push(r) })
      find(app, "messages", "task = {:t}", "", 5000, { t: t.id }).forEach(function (r) { recs.push(r) })
      var anchor = find(app, "posts", "task = {:t} && kind = 'task'", "", 1, { t: t.id })
      if (anchor.length) find(app, "posts", "id = {:a} || parent = {:a}", "", 5000, { a: anchor[0].id }).forEach(function (r) { recs.push(r) })
      var touched = false
      recs.forEach(function (rec) {
        var names = arr(rec.getStringSlice("attachments"))
        var meta = metaOf(rec)
        var keepNames = {}
        meta.forEach(function (x) { if (x && !x.ref && x.keep) keepNames[x.name] = true })
        var drop = names.filter(function (n) { return !keepNames[n] })
        var changed = false
        meta.forEach(function (x) {
          if (!x || x.purged || x.keep) return
          if (!x.ref && drop.indexOf(x.name) >= 0) {
            out.bytes += Number(x.size) || 0
            x.purged = D.iso(now)
            changed = true
          } else if (x.ref === "upload") {
            var ok = false
            try {
              var up = app.findRecordById("ach_uploads", x.upload)
              if (up.getBool("keep")) return
              ok = !cfg || deleteObject(cfg, up.getString("key"))
              if (ok) {
                up.set("status", "deleted")
                app.save(up)
                out.uploads++
                out.bytes += up.getInt("size")
              }
            } catch (err) { ok = false }
            if (!ok) { out.errors++; return }
            x.purged = D.iso(now)
            changed = true
          }
        })
        if (drop.length) {
          rec.set("attachments-", drop)
          out.files += drop.length
          changed = true
        }
        if (changed) {
          rec.set("attachments_meta", meta)
          app.save(rec)
          touched = true
        }
      })
      if (touched) out.tasks++
    })
  })
  // unfinished uploads older than an hour, never-attached ones older than a day
  var stale = find(app, "ach_uploads", "((status = 'complete' || status = 'failed') && created < {:cut}) || (status = 'pending' && created < {:pcut})", "", RETENTION_BATCH, { cut: D.iso(now - 86400000).replace("T", " "), pcut: D.iso(now - PENDING_TTL_MS - PUT_TTL_S * 1000).replace("T", " ") })
  stale.forEach(function (up) {
    try {
      if (!cfg || deleteObject(cfg, up.getString("key"))) {
        up.set("status", "deleted")
        app.save(up)
        out.expired_uploads++
      }
    } catch (err) { out.errors++ }
  })
  try { D.writeSetting(app, "retention_last_run", { at: D.iso(now), result: out }) } catch (err) {}
  return out
}

routes.testRetention = {
  allow: ["superuser"],
  fn: function (e) {
    var b = L().body(e)
    var off = Number(b.offset_days) || 0
    return [200, sweepRetention(e.app, L().nowMs() + off * 86400000)]
  },
}

// ---------------------------------------------------------------- dispatch

function run(e, name) {
  var r = routes[name]
  try {
    var D = L()
    var ctx
    if (r.allow[0] === "public") {
      ctx = { type: "public" }
    } else if (r.allow[0] === "superuser") {
      if ($os.getenv("ACH_TEST_HOOKS") !== "1") throw E(404, "not_found", "not found")
      if (!e.hasSuperuserAuth()) throw E(401, "unauthorized", "superuser only")
      ctx = { type: "superuser" }
    } else {
      ctx = D.authenticate(e)
      D.requireAuth(ctx, r.allow, r.runModes)
      D.hiddenChannels(e.app, ctx)
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
    if (/validation|cannot be blank|must be/i.test(msg)) return e.json(400, { error: msg, code: "invalid" })
    e.app.logger().error("ach storage route error", "route", name, "error", msg)
    return e.json(500, { error: "internal error" + ($os.getenv("ACH_TEST_HOOKS") === "1" ? ": " + msg : ""), code: "internal" })
  }
}

/** Unfinished uploads expire after an hour (hourly cron), not only in the daily sweep. */
function expirePending(app, now) {
  var D = L()
  var cfg = directEnabled(app)
  var n = 0
  find(app, "ach_uploads", "status = 'pending' && created < {:pcut}", "", RETENTION_BATCH, { pcut: D.iso(now - PENDING_TTL_MS - PUT_TTL_S * 1000).replace("T", " ") }).forEach(function (up) {
    try {
      if (!cfg || deleteObject(cfg, up.getString("key"))) { up.set("status", "deleted"); app.save(up); n++ }
    } catch (err) {}
  })
  return n
}

module.exports = {
  run: run, expirePending: expirePending,
  // pure (tested in node)
  utf8: utf8, sha256: sha256, hmac: hmac, hex: hex, uriEncode: uriEncode, amzDate: amzDate, signingKey: signingKey, presign: presign, hostAllowed: hostAllowed,
  // used by ach_lib.js
  parseRefs: parseRefs, applyRefs: applyRefs, refsOut: refsOut, cspSources: cspSources,
  sweepRetention: sweepRetention,
}
