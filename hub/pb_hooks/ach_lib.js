// AgentChannel hub business rules. Loaded from each route/cron handler with
// require(`${__hooks}/ach_lib.js`) because every pb_hooks handler runs in an
// isolated JS context. Keep this file ES5/ES2015-compatible (goja).

var HOP_LIMIT = 8
var LEASE_MIN = 10
// A runner claim that loses its lease this many times fails the task (sweep).
var LEASE_BREAKER = 3
// app.store() key: when this hub process started (set in ach_routes.pb.js).
var BOOT_KEY = "ach_boot_at"
var RUN_TOKEN_HOURS = 24
var TERMINAL = { completed: true, failed: true, canceled: true }
var OPEN = ["submitted", "working", "input-required"]
var BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
var IDCHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
var NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
// A name shaped like a record id could shadow another agent's id (S7).
var ID_LIKE_RE = /^[a-z0-9]{15}$/
var USAGE_MAX_DEFAULT = 50
var TOKEN_REFRESH_BEFORE_MS = 2 * 3600 * 1000
// P1: an interactive claim (a person's own Claude Code / Codex via MCP) keeps
// its lease until this many hours pass without activity on the task.
var INTERACTIVE_LEASE_HOURS_DEFAULT = 24
var CLAIM_MODES = ["runner", "interactive"]
// P5: a non-terminal task idle this long notifies its owner once per idle spell.
var IDLE_NOTIFY_MS = 24 * 3600 * 1000
// P2: default sandbox network allowlist (the runner always adds the hub host).
var DEFAULT_NET_ALLOW = ["github.com", "api.github.com", "registry.npmjs.org", "api.anthropic.com", "api.openai.com"]
var DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
// P3: links.repo is a repo *name* the worker's runner maps to a local path.
var REPO_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/
// links.base / links.repos[].base: a branch, tag or commit (no leading "-").
var REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/
var MAX_LINK_REPOS = 10
// Header fields the sender may change after send (PATCH /tasks/{id}).
var HEADER_FIELDS = ["priority", "purpose", "money", "key_question"]
// Attachments (images and videos): MIME allowlist (enforced by the file field,
// which detects the type from the content), files per request, per-file size.
var ATTACH_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"]
var ATTACH_MAX_FILES = 10
var ATTACH_MAX_FILE_MB_DEFAULT = 200
var ATTACH_NAME_RE = /^[A-Za-z0-9._-]{1,255}$/
var ATTACH_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" }
// Text and code attachments (previewed as escaped text) and .html agent
// artifacts (previewed only in a sandboxed iframe). The file field still checks
// the type from the content; these must sniff as text. Max 2 MB each.
var TEXT_EXT = {
  txt: "txt", md: "md", json: "json", ts: "ts", js: "js", py: "py", go: "go", sh: "sh", diff: "diff", patch: "diff",
  log: "log", csv: "csv", yaml: "yaml", yml: "yaml", sql: "sql", html: "html", htm: "html",
}
var TEXT_MIME = ["text/plain", "text/csv", "application/json", "text/x-python", "text/x-shellscript", "text/javascript", "text/html"]
var TEXT_MAX_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------- utilities

function AchError(status, code, message, extra) {
  this.achError = true
  this.status = status
  this.code = code
  this.message = message
  this.extra = extra || null
}

function E(status, code, message, extra) {
  return new AchError(status, code, message, extra)
}

function iso(ms) {
  return new Date(ms).toISOString().replace("T", " ")
}

function nowMs() {
  return Date.now()
}

function parseTime(s) {
  if (!s) return 0
  var t = Date.parse(String(s).replace(" ", "T"))
  return isNaN(t) ? 0 : t
}

function str(v) {
  if (v === null || v === undefined) return ""
  return String(v)
}

function arr(v) {
  if (v === null || v === undefined || v === "") return []
  if (typeof v === "string") return [v]
  var out = []
  for (var i = 0; i < v.length; i++) out.push(v[i])
  return out
}

function envInt(name, def) {
  var v = $os.getenv(name)
  if (!v) return def
  var n = parseFloat(v)
  return isNaN(n) ? def : n
}

function sha(s) {
  return $security.sha256(s)
}

// JSON body, or a multipart form whose "json" field holds the JSON body (plus
// "attachments" files). Plain multipart fields are accepted as strings too.
function body(e) {
  var b
  try {
    b = e.requestInfo().body || {}
  } catch (err) {
    throw E(400, "bad_json", "request body must be JSON")
  }
  var j = b.json
  if (j !== undefined && j !== null && typeof j !== "object") {
    var parsed = parseJSON(String(j))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw E(400, "bad_json", "multipart field 'json' must be a JSON object")
    return parsed
  }
  if (Array.isArray(j) && j.length === 1) {
    var p1 = parseJSON(String(j[0]))
    if (!p1 || typeof p1 !== "object" || Array.isArray(p1)) throw E(400, "bad_json", "multipart field 'json' must be a JSON object")
    return p1
  }
  return b
}

// ---------------------------------------------------------------- attachments

function maxFileBytes() {
  return envInt("ACH_MAX_FILE_MB", ATTACH_MAX_FILE_MB_DEFAULT) * 1024 * 1024
}

// Files uploaded as multipart field "attachments" ([] for JSON requests).
function uploads(e) {
  // `attachment_refs` (links, direct uploads; ach_storage.js) ride
  // along with the files; attachFiles applies them to the record it saves.
  pendingRefs = require(__hooks + "/ach_storage.js").parseRefs(e)
  var files
  try {
    files = e.findUploadedFiles("attachments")
  } catch (err) {
    return []
  }
  files = arr(files)
  if (files.length > ATTACH_MAX_FILES) throw E(400, "invalid", "at most " + ATTACH_MAX_FILES + " attachments per request")
  var max = maxFileBytes()
  files.forEach(function (f) {
    var ext = extOf(f.originalName)
    if (!ATTACH_EXT[ext] && !TEXT_EXT[ext]) {
      throw E(400, "invalid_attachment", "attachment '" + f.originalName + "': file type not allowed (images, videos, " + Object.keys(TEXT_EXT).join(", ") + ")")
    }
    if (TEXT_EXT[ext] && f.size > TEXT_MAX_BYTES) throw E(413, "too_large", "text attachment '" + f.originalName + "' is larger than 2 MB", { max_text_mb: 2 })
    if (f.size > max) throw E(413, "too_large", "attachment '" + f.originalName + "' is larger than " + Math.round(max / 1048576) + " MB", { max_file_mb: Math.round(max / 1048576) })
  })
  return files
}

function extOf(name) {
  var m = /\.([A-Za-z0-9]+)$/.exec(str(name))
  return m ? m[1].toLowerCase() : ""
}

// {type, lang} for a stored text attachment, or null.
function textKind(name) {
  var lang = TEXT_EXT[extOf(name)]
  if (!lang) return null
  return { type: lang === "html" ? "text/html" : "text/plain", lang: lang }
}

function isMediaType(t) {
  return ATTACH_MIME.indexOf(t) >= 0
}

function extType(name) {
  var m = /\.([A-Za-z0-9]+)$/.exec(str(name))
  return (m && ATTACH_EXT[m[1].toLowerCase()]) || ""
}

// Stores files on a saved messages / handoff_versions record and records
// {name, original, size, type}. The file field validates the MIME type from the
// content (no SVG, no HTML); a rejected file fails the whole request (400).
var pendingRefs = null
function hasRefs() {
  return !!(pendingRefs && pendingRefs.refs && pendingRefs.refs.length)
}

function attachFiles(app, rec, files) {
  var refs = pendingRefs
  pendingRefs = null
  attachUploaded(app, rec, files)
  if (refs) require(__hooks + "/ach_storage.js").applyRefs(app, rec, refs)
}

function attachUploaded(app, rec, files) {
  if (!files || !files.length) return
  rec.set("attachments", files)
  try {
    app.save(rec)
  } catch (err) {
    var msg = String((err && err.message) || err)
    throw E(400, "invalid_attachment", "attachment rejected (allowed: images, videos, text/code, .html; max " + ATTACH_MAX_FILES + " files): " + msg)
  }
  var names = arr(rec.getStringSlice("attachments"))
  var fsys = null
  try {
    fsys = app.newFilesystem()
  } catch (err) {}
  var meta = names.map(function (n, i) {
    var f = files[i] || {}
    var detected = ""
    if (fsys) {
      try {
        detected = str(fsys.attributes(rec.baseFilesPath() + "/" + n).contentType).split(";")[0].trim()
      } catch (err) {}
    }
    var tk = textKind(n)
    if (tk) {
      // text by name: the content must be text too (never an image/binary renamed .txt)
      if (detected && TEXT_MIME.indexOf(detected) < 0 && detected.indexOf("text/") !== 0) {
        throw E(400, "invalid_attachment", "attachment '" + str(f.originalName) + "' is not a text file")
      }
      return { name: n, original: str(f.originalName).slice(0, 255), size: f.size || 0, type: tk.type, lang: tk.lang }
    }
    var type = extType(n)
    // media by name: the content must be that kind of media (no text renamed .png)
    if (detected && !isMediaType(detected)) throw E(400, "invalid_attachment", "attachment '" + str(f.originalName) + "' content does not match its type")
    if (isMediaType(detected)) type = detected
    return { name: n, original: str(f.originalName).slice(0, 255), size: f.size || 0, type: type || "application/octet-stream" }
  })
  // B14: the text of text/code/HTML attachments is indexed for search (tags
  // stripped, 200 KB per file).
  var texts = []
  if (fsys) {
    meta.forEach(function (x) {
      if (!x.lang) return
      try {
        var r = fsys.getReader(rec.baseFilesPath() + "/" + x.name)
        try {
          var t = toString(toBytes(r, ATTACH_INDEX_MAX))
          if (x.lang === "html") t = t.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")
          texts.push(t.slice(0, ATTACH_INDEX_MAX))
        } finally {
          try { r.close() } catch (err) {}
        }
      } catch (err) {}
    })
  }
  if (fsys) {
    try { fsys.close() } catch (err) {}
  }
  rec.set("attachments_meta", meta)
  if (texts.length) rec.set("attachments_text", texts.join("\n"))
  app.save(rec)
}

var ATTACH_INDEX_MAX = 200 * 1024

function attOut(coll, rec) {
  var names = arr(rec.getStringSlice("attachments"))
  var meta = parseJSON(rec.getString("attachments_meta"))
  // Link / direct-upload references (entries with `ref`) follow the files
  var refs = Array.isArray(meta) && meta.some(function (x) { return x && x.ref }) ? require(__hooks + "/ach_storage.js").refsOut(meta) : []
  if (!names.length) return refs
  var byName = {}
  if (Array.isArray(meta)) meta.forEach(function (x) { if (x && x.name && !x.ref) byName[x.name] = x })
  return names.map(function (n) {
    var x = byName[n] || {}
    var tk = textKind(n)
    var out = {
      name: n,
      original: str(x.original || n),
      size: Number(x.size) || 0,
      type: tk ? tk.type : str(x.type || extType(n)),
      url: "/api/ach/files/" + coll + "/" + rec.id + "/" + n,
    }
    if (tk) out.lang = tk.lang
    return out
  }).concat(refs)
}

function tx(app, fn) {
  var result
  var achErr = null
  try {
    app.runInTransaction(function (txApp) {
      try {
        result = fn(txApp)
      } catch (err) {
        achErr = err
        throw err
      }
    })
  } catch (err) {
    if (achErr) throw achErr
    throw err
  }
  return result
}

function findOr404(app, coll, id, what) {
  if (!id) throw E(404, "not_found", what + " not found")
  try {
    return app.findRecordById(coll, String(id))
  } catch (err) {
    throw E(404, "not_found", what + " not found")
  }
}

// A task is addressed by its record id or by "T-<seq>" (also "t-128", "128").
var TASK_REF_RE = /^[Tt]-?([0-9]{1,9})$/

function findTask(app, ref, what) {
  ref = str(ref).trim()
  var m = TASK_REF_RE.exec(ref)
  if (m) {
    var list = app.findRecordsByFilter("tasks", "seq = {:s}", "", 1, 0, { s: parseInt(m[1], 10) })
    if (list.length) return list[0]
    throw E(404, "not_found", (what || "task") + " not found")
  }
  return findOr404(app, "tasks", ref, what || "task")
}

function taskRef(t) {
  var n = t.getInt("seq")
  return n > 0 ? "T-" + n : t.id
}

function find(app, coll, filter, sort, limit, params) {
  return app.findRecordsByFilter(coll, filter, sort || "", limit || 1000, 0, params || {})
}

// ---------------------------------------------------------------- output

function parseJSON(s) {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch (err) {
    return null
  }
}

function Names(app) {
  this.app = app
  this.agents = {}
  this.users = {}
}
Names.prototype.agent = function (id) {
  if (!id) return ""
  if (this.agents[id] === undefined) {
    try {
      this.agents[id] = this.app.findRecordById("agents", id).getString("name")
    } catch (err) {
      this.agents[id] = ""
    }
  }
  return this.agents[id]
}
Names.prototype.user = function (id) {
  if (!id) return ""
  if (this.users[id] === undefined) {
    try {
      this.users[id] = userName(this.app.findRecordById("users", id))
    } catch (err) {
      this.users[id] = ""
    }
  }
  return this.users[id]
}

// C: quiet agents (data bots): their posts are flagged so the panel collapses them.
Names.prototype.quiet = function (id) {
  if (!id) return false
  if (!this.quiets) this.quiets = {}
  if (this.quiets[id] === undefined) {
    try {
      this.quiets[id] = this.app.findRecordById("agents", id).getBool("quiet")
    } catch (err) {
      this.quiets[id] = false
    }
  }
  return this.quiets[id]
}

// a person's display name by GitHub login ("" when nobody on the hub has it)
Names.prototype.login = function (login) {
  var k = str(login).trim().toLowerCase()
  if (!k) return ""
  if (!this.logins) this.logins = {}
  if (this.logins[k] === undefined) {
    var n = new DynamicModel({ id: "" })
    try {
      this.app.db().newQuery("SELECT id FROM users WHERE github_login != '' AND lower(github_login) = {:l} LIMIT 1").bind({ l: k }).one(n)
    } catch (err) {}
    this.logins[k] = n.id ? this.user(n.id) : ""
  }
  return this.logins[k]
}

Names.prototype.channel = function (id) {
  if (!id) return ""
  if (!this.channels) this.channels = {}
  if (this.channels[id] === undefined) {
    try {
      this.channels[id] = this.app.findRecordById("channels", id).getString("name")
    } catch (err) {
      this.channels[id] = ""
    }
  }
  return this.channels[id]
}

// The permalink of an object, absolute when ACH_PUBLIC_URL is set
// ("<base>/#/t/T-128"), else the fragment alone ("#/t/T-128").
function linkUrl(path) {
  var base = str($os.getenv("ACH_PUBLIC_URL")).trim().replace(/\/+$/, "")
  return base + "/#/" + path
}

function userName(u) {
  var n = u.getString("name")
  if (n) return n
  var em = u.getString("email")
  return em ? em.split("@")[0] : u.id
}

// B16: where a bare "#335" in this task's text points: the issues URL of the
// repo named by links.issue / links.pr (GitHub/GitLab-style URLs), else "".
function issueBase(links) {
  if (!links || typeof links !== "object") return ""
  var cands = [links.issue, links.pr, links.repo_url]
  for (var i = 0; i < cands.length; i++) {
    var m = /^(https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(\/|$)/.exec(str(cands[i]))
    if (m) return m[1] + "/issues/"
  }
  return ""
}

function taskOut(t, names) {
  return {
    id: t.id,
    seq: t.getInt("seq"),
    ref: taskRef(t),
    url: linkUrl("t/" + taskRef(t)),
    channel: t.getString("channel"),
    channel_name: names.channel(t.getString("channel")),
    title: t.getString("title"),
    priority: t.getString("priority"),
    purpose: t.getString("purpose"),
    money: t.getString("money"),
    status: t.getString("status"),
    from_agent: t.getString("from_agent"),
    from_agent_name: names.agent(t.getString("from_agent")),
    to_agent: t.getString("to_agent"),
    to_agent_name: names.agent(t.getString("to_agent")),
    owner_user: t.getString("owner_user"),
    owner_name: names.user(t.getString("owner_user")),
    handoff_version: t.getInt("handoff_version"),
    waiting_on: t.getString("waiting_on"),
    depends_on: arr(t.getStringSlice("depends_on")),
    cost_usd: t.getFloat("cost_usd"),
    cost_estimated: t.getBool("cost_estimated"),
    links: parseJSON(t.getString("links")),
    issue_base: issueBase(parseJSON(t.getString("links"))),
    run_id: t.getString("run_id"),
    claimed_at: t.getString("claimed_at"),
    last_activity: t.getString("last_activity"),
    parked_at: t.getString("parked_at"),
    claim_mode: t.getString("claim_mode"),
    key_question: t.getString("key_question"),
    agent_hops: t.getInt("agent_hops"),
    result: t.getString("result"),
    created: t.getString("created"),
    updated: t.getString("updated"),
  }
}

function msgOut(m, names) {
  return {
    id: m.id,
    task: m.getString("task"),
    author_type: m.getString("author_type"),
    author_agent: m.getString("author_agent"),
    author_user: m.getString("author_user"),
    author_name:
      m.getString("author_type") === "agent"
        ? names.agent(m.getString("author_agent"))
        : m.getString("author_type") === "human"
          ? names.user(m.getString("author_user"))
          : "system",
    kind: m.getString("kind"),
    topic: m.getString("topic"),
    body: m.getString("body"),
    to_agent: m.getString("to_agent"),
    to_agent_name: names.agent(m.getString("to_agent")),
    to_user: m.getString("to_user"),
    to_user_name: names.user(m.getString("to_user")),
    reply_to: m.getString("reply_to"),
    evidence: m.getString("evidence"),
    resolved: m.getBool("resolved"),
    prev_status: m.getString("prev_status"),
    escalated: m.getBool("escalated"),
    blocking: m.getBool("blocking"),
    dr_group: m.getString("dr_group"),
    sys_code: m.getString("sys_code"),
    sys_params: m.getString("sys_code") ? parseJSON(m.getString("sys_params")) || {} : null,
    choices: parseJSON(m.getString("choices")) || null,
    also_to: parseJSON(m.getString("also_to")) || [],
    delegated_grant: m.getString("delegated_grant"),
    grant: m.getString("grant"),
    on_behalf_of: m.getString("on_behalf_of"),
    on_behalf_of_name: names.user(m.getString("on_behalf_of")),
    via_agent: m.getString("via_agent"),
    via_agent_name: names.agent(m.getString("via_agent")),
    attachments: attOut("messages", m),
    created: m.getString("created"),
  }
}

function hvOut(h, names) {
  return {
    version: h.getInt("version"),
    body: h.getString("body"),
    change_note: h.getString("change_note"),
    author_agent: h.getString("author_agent"),
    author_name: names.agent(h.getString("author_agent")),
    attachments: attOut("handoff_versions", h),
    created: h.getString("created"),
  }
}

function agentOut(a, names) {
  return {
    id: a.id,
    name: a.getString("name"),
    owner: a.getString("owner"),
    owner_name: names.user(a.getString("owner")),
    runtime: a.getString("runtime"),
    description: a.getString("description"),
    perm_level: a.getString("perm_level"),
    budget_usd: a.getFloat("budget_usd"),
    spent_usd: a.getFloat("spent_usd"),
    active: a.getBool("active"),
    disabled_by_admin: a.getBool("disabled_by_admin"),
    quiet: a.getBool("quiet"),
    accept_from_locked: a.getBool("accept_from_admin"),
    key_prefix: a.getString("key_prefix"),
    accept_from: acceptFrom(a),
    net_allow: netAllow(a),
    last_seen: a.getString("last_seen"),
    created: a.getString("created"),
  }
}

function acceptFrom(a) {
  var v = parseJSON(a.getString("accept_from"))
  return Array.isArray(v) ? v.map(String) : []
}

// accept_from input: array of agent names (or a comma-separated string); [] = anyone.
function parseAcceptFrom(v) {
  if (v === null || v === undefined || v === "") return []
  var list = typeof v === "string" ? v.split(",") : v
  if (!Array.isArray(list)) throw E(400, "invalid", "accept_from must be a list of agent names")
  var out = []
  list.forEach(function (n) {
    n = str(n).trim()
    if (!n) return
    if (!NAME_RE.test(n)) throw E(400, "invalid", "accept_from entry '" + n + "' is not an agent name")
    if (out.indexOf(n) < 0) out.push(n)
  })
  if (out.length > 200) throw E(400, "invalid", "accept_from has too many entries")
  return out
}

// P2: the agent's sandbox network allowlist. Unset (null) = the default list.
function netAllow(a) {
  var v = parseJSON(a.getString("net_allow"))
  return Array.isArray(v) ? v.map(String) : DEFAULT_NET_ALLOW.slice()
}

// B8: wildcards (and embed hosts) may not cover a bare TLD or a public suffix
// where anyone can register a subdomain. Small built-in list; extend as needed.
var PUBLIC_SUFFIXES = [
  "com", "net", "org", "io", "dev", "app", "cn", "co", "uk", "us", "de", "jp", "ai", "me", "xyz", "info", "biz", "cloud", "site", "online", "tech",
  "co.uk", "org.uk", "ac.uk", "com.cn", "net.cn", "org.cn", "com.hk", "com.tw", "co.jp", "com.au",
  "github.io", "githubusercontent.com", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "now.sh", "netlify.app", "netlify.com",
  "cloudfront.net", "herokuapp.com", "fly.dev", "onrender.com", "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net",
  "blob.core.windows.net", "s3.amazonaws.com", "amazonaws.com", "r2.dev", "trycloudflare.com", "ngrok.io", "ngrok-free.app", "glitch.me", "repl.co", "surge.sh",
]

function isPublicSuffix(d) {
  return d.indexOf(".") < 0 || PUBLIC_SUFFIXES.indexOf(d) >= 0
}

// net_allow input: array of domains (or comma-separated); "*" = any host, admin-only.
function parseNetAllow(v, isAdmin) {
  if (v === null || v === undefined) return DEFAULT_NET_ALLOW.slice()
  var list = typeof v === "string" ? v.split(",") : v
  if (!Array.isArray(list)) throw E(400, "invalid", "net_allow must be a list of domains")
  var out = []
  list.forEach(function (d) {
    d = str(d).trim().toLowerCase()
    if (!d) return
    if (d === "*") {
      if (!isAdmin) throw E(403, "forbidden", "only admins may set net_allow \"*\"")
    } else if (d.length > 253 || !DOMAIN_RE.test(d)) {
      throw E(400, "invalid", "net_allow entry '" + d + "' is not a domain")
    } else if (d.indexOf("*.") === 0 && isPublicSuffix(d.slice(2))) {
      throw E(400, "public_suffix", "net_allow entry '" + d + "' covers a whole public suffix; name the domain")
    }
    if (out.indexOf(d) < 0) out.push(d)
  })
  if (out.length > 100) throw E(400, "invalid", "net_allow has too many entries")
  return out
}

function directoryOut(a, names) {
  return {
    id: a.id,
    name: a.getString("name"),
    owner_name: names.user(a.getString("owner")),
    runtime: a.getString("runtime"),
    description: a.getString("description"),
    active: a.getBool("active"),
    quiet: a.getBool("quiet"),
    last_seen: a.getString("last_seen"),
  }
}

function fullTask(app, t) {
  var names = new Names(app)
  var msgs = find(app, "messages", "task = {:t}", "created,id", 5000, { t: t.id })
  var hist = find(app, "handoff_versions", "task = {:t}", "version", 1000, { t: t.id })
  var cur = hist.filter(function (h) { return h.getInt("version") === t.getInt("handoff_version") })[0]
  return {
    task: taskOut(t, names),
    handoff: { version: t.getInt("handoff_version"), body: t.getString("handoff"), attachments: cur ? attOut("handoff_versions", cur) : [] },
    messages: msgs.map(function (m) { return msgOut(m, names) }),
    handoff_history: hist.map(function (h) { return hvOut(h, names) }),
  }
}

// ---------------------------------------------------------------- auth

function genKeySecret(n) {
  return $security.randomStringWithAlphabet(n, BASE62)
}

function agentAuth(app, tok) {
  var rest = tok.slice(7)
  var idx = rest.indexOf("_")
  if (idx <= 0) throw E(401, "unauthorized", "invalid agent key")
  var id = rest.slice(0, idx)
  var agent
  try {
    agent = app.findRecordById("agents", id)
  } catch (err) {
    throw E(401, "unauthorized", "invalid agent key")
  }
  var stored = agent.getString("key_hash")
  if (!stored || !$security.equal(stored, sha(tok))) throw E(401, "unauthorized", "invalid agent key")
  if (!agent.getBool("active")) throw E(401, "unauthorized", "agent is inactive")
  requireOwnerActive(app, agent)
  // The key from create / rotate-key is in use, so the agent's unused
  // one-time join tokens (the "ach2." invites minted with it) are burned.
  if (agent.getBool("key_unused")) {
    try {
      app.db().newQuery("UPDATE agents SET key_unused = FALSE WHERE id = {:a}").bind({ a: agent.id }).execute()
      app.db().newQuery("DELETE FROM agent_joins WHERE agent = {:a} AND used_at = ''").bind({ a: agent.id }).execute()
      agent.set("key_unused", false)
    } catch (err) {}
  }
  return { type: "agent", agent: agent }
}

// B6: an agent whose owner is deactivated (or gone) fails auth everywhere:
// agent key, run tokens, mention runs.
function requireOwnerActive(app, agent) {
  var owner
  try {
    owner = app.findRecordById("users", agent.getString("owner"))
  } catch (err) {
    throw E(401, "unauthorized", "the agent's owner no longer exists")
  }
  if (owner.getBool("deactivated")) throw E(401, "owner_deactivated", "the agent's owner is deactivated")
}

function runAuth(app, tok) {
  var h = sha(tok)
  var rt
  try {
    rt = app.findFirstRecordByData("run_tokens", "token_hash", h)
  } catch (err) {
    throw E(401, "unauthorized", "invalid run token")
  }
  if (!$security.equal(rt.getString("token_hash"), h)) throw E(401, "unauthorized", "invalid run token")
  if (rt.getBool("revoked")) throw E(401, "unauthorized", "run token revoked")
  if (parseTime(rt.getString("expires_at")) <= nowMs()) throw E(401, "unauthorized", "run token expired")
  var agent
  try {
    agent = app.findRecordById("agents", rt.getString("agent"))
  } catch (err) {
    throw E(401, "unauthorized", "invalid run token")
  }
  if (!agent.getBool("active")) throw E(401, "unauthorized", "agent is inactive")
  requireOwnerActive(app, agent)
  return { type: "run", agent: agent, token: rt, mode: rt.getString("mode") }
}

function bearerOf(e) {
  var h = str(e.request.header.get("Authorization")).trim()
  return h.toLowerCase().indexOf("bearer ") === 0 ? h.slice(7).trim() : h
}

// B1: the ach_scope claim of a (PocketBase-verified) user token. "agent" =
// a session minted from an agent key (`ach open`), never admin-scoped.
function tokenScope(tok) {
  if (!tok || tok.indexOf("ach_") === 0) return ""
  try {
    var c = $security.parseUnverifiedJWT(tok)
    return str(c && c.ach_scope)
  } catch (err) {
    return ""
  }
}

function authenticate(e) {
  var app = e.app
  var tok = bearerOf(e)
  if (tok.indexOf("ach_sk_") === 0) return agentAuth(app, tok)
  if (tok.indexOf("ach_rt_") === 0) return runAuth(app, tok)
  if (e.auth && e.auth.collection().name === "users") {
    if (e.auth.getBool("deactivated")) throw E(401, "deactivated", "this account is deactivated")
    // PocketBase verified the token's signature, so its claims are authentic.
    var scope = tokenScope(tok)
    var role = e.auth.getBool("is_admin")
    return { type: "user", user: e.auth, scope: scope, adminRole: role, isAdmin: role && scope !== "agent" }
  }
  if (tok) throw E(401, "session_ended", "your session ended; log in again")
  throw E(401, "unauthorized", "missing or invalid credentials")
}

// ctx.type must be in allow; run tokens additionally need mode in runModes
// and (for task routes) the token's own task.
function requireAuth(ctx, allow, runModes) {
  if (allow.indexOf(ctx.type) < 0) {
    throw E(403, "forbidden", "this route does not accept " + ctx.type + " credentials")
  }
  if (ctx.type === "run" && (runModes || []).indexOf(ctx.mode) < 0) {
    throw E(403, "forbidden", "run token mode '" + ctx.mode + "' may not call this route")
  }
}

function checkRunTask(ctx, task) {
  if (ctx.type !== "run") return
  if (ctx.token.getString("task") !== task.id) throw E(403, "forbidden", "run token is scoped to another task")
  if (ctx.mode === "work" && ctx.token.getString("run_id") !== task.getString("run_id")) {
    throw E(403, "forbidden", "run token belongs to a stale run")
  }
}

function isParty(agentId, task) {
  return task.getString("from_agent") === agentId || task.getString("to_agent") === agentId
}

// ---------------------------------------------------------------- channel visibility
// Private channels are seen by their members and admins only. An agent (key or
// run token) sees what its owner sees; a party to a task always sees that task. run() computes ctx.hidden (ids of private
// channels this caller may not see) before the route runs.
// An admin's agents act for that admin and see what the admin sees (the wiki
// maintainer is one); other agents see what their owner sees as a member.
function viewerOf(ctx) {
  if (ctx.type === "user") return { uid: ctx.user.id, admin: ctx.user.getBool("is_admin") }
  if (ctx.agent) return { uid: ctx.agent.getString("owner"), admin: !!ctx.ownerAdmin }
  return { uid: "", admin: true }
}

function hiddenChannels(app, ctx) {
  if (ctx.hidden) return ctx.hidden
  if (ctx.agent && ctx.ownerAdmin === undefined) {
    try { ctx.ownerAdmin = app.findRecordById("users", ctx.agent.getString("owner")).getBool("is_admin") } catch (err) { ctx.ownerAdmin = false }
  }
  var v = viewerOf(ctx)
  var out = []
  // A Memory upkeep run (one per channel) sees team channels plus its own
  // channel only, whoever owns the maintainer agent: what it writes is read by
  // that channel's readers (everyone, for #general and the team overview), so it
  // must never have read another private channel.
  if (ctx.type === "run" && ctx.token.getString("task")) {
    try {
      var rt = app.findRecordById("tasks", ctx.token.getString("task"))
      if (rt.getString("system_kind") === "wiki_upkeep") v = { uid: "", admin: false, onlyChannel: rt.getString("channel") || "-" }
    } catch (err) {}
  }
  if (v.onlyChannel) {
    var all = arrayOf(new DynamicModel({ id: "" }))
    app.db().newQuery("SELECT id FROM channels WHERE visibility = 'private'").all(all)
    all.forEach(function (r) { if (r.id !== v.onlyChannel) out.push(r.id) })
  } else if (!v.admin) {
    var rows = arrayOf(new DynamicModel({ id: "", members: "" }))
    app.db().newQuery("SELECT id, members FROM channels WHERE visibility = 'private'").all(rows)
    rows.forEach(function (r) {
      var m = arr(parseJSON(r.members))
      if (m.indexOf(v.uid) < 0) out.push(r.id)
    })
  }
  ctx.hidden = out
  if (ctx.type === "user" && out.length) {
    ctx.myAgents = {}
    find(app, "agents", "owner = {:u}", "", 10000, { u: ctx.user.id }).forEach(function (a) { ctx.myAgents[a.id] = true })
  }
  return out
}

function channelHidden(ctx, id) {
  return !!id && arr(ctx.hidden).indexOf(id) >= 0
}

function requireChannelVisible(ctx, id, what) {
  if (channelHidden(ctx, id)) throw E(404, "not_found", (what || "channel") + " not found")
}

// PocketBase filter fragment: path not in the hidden channels ("" when none).
function hiddenFilter(path, ctx, params) {
  var h = arr(ctx.hidden)
  if (!h.length) return ""
  return "(" + h.map(function (id, i) {
    params["hv" + i] = id
    return path + " != {:hv" + i + "}"
  }).join(" && ") + ")"
}
function andHidden(filter, path, ctx, params) {
  var f = hiddenFilter(path, ctx, params)
  return f ? "(" + filter + ") && " + f : filter
}

// SQL fragment: col NOT IN (hidden) ("1=1" when none).
function hiddenSql(col, ctx, params) {
  var h = arr(ctx.hidden)
  if (!h.length) return "1=1"
  return col + " NOT IN (" + h.map(function (id, i) {
    params["hs" + i] = id
    return "{:hs" + i + "}"
  }).join(",") + ")"
}

// A person sees a task in a private channel they are not in only when it is
// theirs (they own it, or one of their agents sent or holds it).
function userTaskVisible(ctx, task) {
  if (!channelHidden(ctx, task.getString("channel"))) return true
  var mine = ctx.myAgents || {}
  return task.getString("owner_user") === ctx.user.id || !!mine[task.getString("from_agent")] || !!mine[task.getString("to_agent")]
}

function requireParty(ctx, task) {
  if (ctx.type === "user") {
    if (!userTaskVisible(ctx, task)) throw E(404, "not_found", "task not found")
    return
  }
  if (!isParty(ctx.agent.id, task)) throw E(403, "forbidden", "not a party to this task")
  checkRunTask(ctx, task)
}

// C3: with an agent key, /complete and /fail need the task's current run_id
// (a stale runner cannot finish a task another run now owns). A task that was
// never claimed (decline) has no run_id and needs none. Run tokens are already
// bound to their run by checkRunTask.
function requireCurrentRun(ctx, task, b) {
  if (ctx.type !== "agent") return
  var cur = task.getString("run_id")
  if (!cur) return
  if (str(b.run_id) !== cur) throw E(409, "stale_run", "run_id does not match the task's current run", { status: task.getString("status") })
}

function requireOpen(task) {
  if (TERMINAL[task.getString("status")]) {
    throw E(409, "terminal", "task is " + task.getString("status"), { status: task.getString("status") })
  }
}

// ---------------------------------------------------------------- task helpers

function openOf(app, taskId, kind) {
  return find(app, "messages", "task = {:t} && kind = {:k} && resolved = false", "-created,-id", 1000, {
    t: taskId,
    k: kind,
  })
}

// Open decision requests that block the worker (worker-side ones, C1).
function openBlocking(app, taskId) {
  return find(app, "messages", "task = {:t} && kind = 'decision_request' && resolved = false && blocking = true", "-created,-id", 1000, { t: taskId })
}

function recomputeWaiting(app, task) {
  var st = task.getString("status")
  if (TERMINAL[st]) return task.set("waiting_on", "")
  var dr = openBlocking(app, task.id)
  if (dr.length) return task.set("waiting_on", "human:" + dr[0].getString("to_user"))
  var q = openOf(app, task.id, "question")
  if (q.length && q[0].getString("to_agent")) return task.set("waiting_on", "agent:" + q[0].getString("to_agent"))
  task.set("waiting_on", "agent:" + task.getString("to_agent"))
}

function revokeTokens(app, filter, params) {
  var toks = find(app, "run_tokens", "revoked = false && (" + filter + ")", "", 10000, params)
  toks.forEach(function (rt) {
    rt.set("revoked", true)
    app.save(rt)
  })
}

function addMsg(app, task, fields) {
  var m = new Record(app.findCollectionByNameOrId("messages"))
  m.set("task", task.id)
  for (var k in fields) m.set(k, fields[k])
  app.save(m)
  return m
}

// P3 + cross-repo: links.repo is the primary repo name; links.repos lists more
// repos ({repo, base?}) the worker's runner makes readable for the task.
function validateLinks(links) {
  if (links === null) return
  if (typeof links !== "object" || Array.isArray(links)) throw E(400, "invalid", "links must be an object")
  if (links.repo !== undefined && (typeof links.repo !== "string" || !REPO_NAME_RE.test(links.repo))) {
    throw E(400, "invalid", "links.repo must be a repo name (letters, digits, . _ -)")
  }
  if (links.base !== undefined && (typeof links.base !== "string" || !REF_RE.test(links.base) || links.base.charAt(0) === "-")) {
    throw E(400, "invalid", "links.base must be a branch, tag or commit")
  }
  if (links.repos === undefined) return
  if (!Array.isArray(links.repos) || links.repos.length > MAX_LINK_REPOS) {
    throw E(400, "invalid", "links.repos must be a list of at most " + MAX_LINK_REPOS + " {repo, base?}")
  }
  var seen = {}
  links.repos.forEach(function (r) {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw E(400, "invalid", "links.repos entries must be {repo, base?}")
    if (typeof r.repo !== "string" || !REPO_NAME_RE.test(r.repo)) throw E(400, "invalid", "links.repos[].repo must be a repo name (letters, digits, . _ -)")
    if (r.base !== undefined && (typeof r.base !== "string" || !REF_RE.test(r.base) || r.base.charAt(0) === "-")) {
      throw E(400, "invalid", "links.repos[].base must be a branch, tag or commit")
    }
    for (var k in r) if (k !== "repo" && k !== "base") throw E(400, "invalid", "links.repos[] has unknown field '" + k + "'")
    if (seen[r.repo]) throw E(400, "invalid", "links.repos lists '" + r.repo + "' twice")
    seen[r.repo] = true
  })
}

// A system line: English body (agents, CLI) plus a code + params the panel
// renders in the reader's language (sys_code / sys_params).
function sysNote(app, task, text, code, params) {
  var fields = { author_type: "system", kind: "note", body: text }
  if (code) {
    fields.sys_code = code
    fields.sys_params = params || {}
  }
  return addMsg(app, task, fields)
}

// ---------------------------------------------------------------- notifications (P5)

// Notifications collected during a request (or a sweep transaction) and sent
// only after the transaction committed: a rolled-back change never notifies.
// Each handler call runs in one JS VM at a time, so a module-level list is safe;
// run() and sweep() reset it.
var pendingNotes = []

var NOTE_TEXT = {
  decision_request: "Decision needed",
  question_escalated: "Question escalated to you (no agent answer)",
  task_completed: "Task completed",
  task_failed: "Task failed",
  task_idle: "Task idle for more than 24h",
  task_received: "New task for your agent",
  mention_escalated: "An agent you mentioned needs a human",
  memory_question: "Memory has a question for you",
  changes_requested: "Changes requested on a finished task",
  decision_request_fyi: "The worker on your task asked its owner for a decision",
  decision_request_cc: "Your agent asked {name} to decide",
}
// B12: zh text for people whose users.lang is zh (default ACH_DEFAULT_LANG).
var NOTE_TEXT_ZH = {
  decision_request: "需要你决定",
  question_escalated: "问题已升级给你（智能体未回答）",
  task_completed: "任务已完成",
  task_failed: "任务失败",
  task_idle: "任务超过 24 小时没有进展",
  task_received: "你的智能体收到新任务",
  mention_escalated: "你提到的智能体需要人来处理",
  memory_question: "记忆有个问题要你回答",
  changes_requested: "已完成的任务被要求修改",
  decision_request_fyi: "你的任务的执行方在等它的主人决定",
  decision_request_cc: "你的智能体请 {name} 决定",
}

// Only the event, the task title and the panel link ever leave the hub:
// never the handoff, message bodies, evidence or results. B12: the link
// points at the exact item (#/t/T-n/m/<messageId> when there is one).
// choices: a structured decision request; the note carries its question and option labels only (never the handoff).
function notify(event, task, toUser, msg, choices, vars) {
  if (!toUser) return
  var path = "t/" + taskRef(task) + (msg ? "/m/" + msg.id : "")
  pendingNotes.push({ event: event, task_id: task.id, ref: taskRef(task), title: task.getString("title"), to_user: toUser, path: path, message_id: msg ? msg.id : "", choices: choices || null, vars: vars || null })
}

// Post notifications (mention escalations, channel questions): the post's permalink, never its body.
function notifyPost(event, post, title, toUser, choices) {
  if (!toUser) return
  pendingNotes.push({ event: event, task_id: "", post_id: post.id, title: title, to_user: toUser, path: "p/" + post.id, choices: choices || null })
}

function panelUrl(path) {
  return configuredPublicUrl() + "/#/" + path
}

/** A link that opens the panel at a decision with option i preselected (a GET never answers anything). */
function pickUrl(path, i) {
  return panelUrl(path) + "?pick=" + i
}

function noteText(n, lang) {
  var t = (lang === "zh" ? NOTE_TEXT_ZH[n.event] : NOTE_TEXT[n.event]) || n.event
  var v = n.vars || {}
  for (var k in v) t = t.replace("{" + k + "}", str(v[k]).replace(/[\r\n<>]+/g, " ").slice(0, 100))
  return t
}

function notifyFormat(url) {
  var f = str($os.getenv("ACH_NOTIFY_FORMAT")).trim().toLowerCase()
  if (f === "feishu" || f === "json") return f
  return /^https:\/\/open\.(feishu\.cn|larksuite\.com)\//.test(url) ? "feishu" : "json"
}

function notePayload(n, format, toName, lang) {
  var title = str(n.title).replace(/[\r\n]+/g, " ").slice(0, 200)
  var url = panelUrl(n.path)
  var text = noteText(n, lang)
  var c = n.choices && n.choices.question ? n.choices : null
  var clean = function (x, max) { return str(x).replace(/[\r\n]+/g, " ").replace(/[<>]/g, " ").slice(0, max) }
  var labels = c ? c.options.map(function (o, i) { return clean(o.label, 120) + (i === c.recommended ? recMark(lang) : "") }) : []
  // per-option links open the panel at the request with that option preselected (the person still sends it)
  var links = c ? c.options.map(function (o, i) { return pickUrl(n.path, i) }) : []
  if (format === "feishu") {
    // Agent-written titles must not carry Feishu markup such as <at user_id="all">.
    var safe = title.replace(/[<>]/g, " ")
    var q = c ? "\n" + clean(c.question, 500) + labels.map(function (l, i) { return "\n- " + l + " " + links[i] }).join("") : ""
    return { msg_type: "text", content: { text: "[AgentChannel] " + text + (toName ? " (" + toName + ")" : "") + (lang === "zh" ? "：" : ": ") + safe + q + "\n" + url } }
  }
  var out = { source: "agentchannel", event: n.event, text: text, lang: lang, task_id: n.task_id, title: title, url: url, to_user: { id: n.to_user, name: toName } }
  if (c) {
    out.question = clean(c.question, 500)
    out.options = labels
    out.option_links = c.options.map(function (o, i) { return { option: i, label: clean(o.label, 120), recommended: i === c.recommended, url: links[i] } })
  }
  if (n.ref) out.task_ref = n.ref
  if (n.message_id) out.message_id = n.message_id
  if (n.post_id) out.post_id = n.post_id
  return out
}

function sendNotes(app) {
  var list = pendingNotes
  pendingNotes = []
  if (!list.length) return
  // decision requests also become notification rows (Web Push and desktop
  // notifiers carry their options as action buttons; ach_notify.js)
  list.forEach(function (n) {
    if (n.event !== "decision_request" && n.event !== "memory_question") return
    try { require(__hooks + "/ach_notify.js").decisionEvent(app, n) } catch (err) { app.logger().warn("ach decision event failed", "error", String(err)) }
  })
  // B5: links in notifications must be absolute and real.
  if (!configuredPublicUrl()) {
    app.logger().warn("ach notify skipped: ACH_PUBLIC_URL is not set", "count", list.length)
    return
  }
  var hubHook = str($os.getenv("ACH_NOTIFY_WEBHOOK")).trim()
  list.forEach(function (n) {
    var hook = hubHook
    var name = ""
    var lang = defaultLang()
    try {
      var u = app.findRecordById("users", n.to_user)
      name = userName(u)
      if (u.getString("lang")) lang = u.getString("lang") === "zh" ? "zh" : "en"
      if (u.getString("notify_webhook")) {
        hook = u.getString("notify_webhook")
        // a person's own webhook: known webhook hosts or the admin allowlist only (SSRF)
        var H = require(__hooks + "/ach_hooks.js")
        H.checkUrl(app, hook, notifyFormat(hook) === "feishu" ? "feishu" : "json")
      }
    } catch (err) {
      if (err && err.achError) { app.logger().warn("ach notify skipped: webhook host not allowed", "error", String(err.message)); return }
    }
    // optional Feishu adapter: the mapped person's DM through the app bot (decisions go as cards via ach_notify)
    try { require(__hooks + "/ach_feishu.js").queueNote(app, n, noteText(n, lang), panelUrl(n.path), lang) } catch (ferr) {}
    if (!hook) return
    var format = notifyFormat(hook)
    try {
      var res = $http.send({
        url: hook,
        method: "POST",
        body: JSON.stringify(notePayload(n, format, name, lang)),
        headers: { "content-type": "application/json" },
        timeout: 5,
      })
      if (res.statusCode >= 300) app.logger().warn("ach notify non-2xx", "event", n.event, "status", res.statusCode)
    } catch (err) {
      app.logger().warn("ach notify failed", "event", n.event, "error", String(err))
    }
  })
}

// P5: a per-user webhook must be https (http only with ACH_NOTIFY_ALLOW_HTTP=1,
// for tests and LAN setups): users must not point the hub at internal plain-http services.
function parseWebhook(app, v) {
  var u = str(v).trim()
  if (!u) return ""
  if (u.length > 500) throw E(400, "invalid", "notify_webhook is too long")
  var ok = /^https:\/\/[^\s]+$/.test(u) || ($os.getenv("ACH_NOTIFY_ALLOW_HTTP") === "1" && /^http:\/\/[^\s]+$/.test(u))
  if (!ok) throw E(400, "invalid", "notify_webhook must be an https:// URL")
  // SSRF: Feishu/Lark bot hosts are known; any other host needs the admin allowlist
  return require(__hooks + "/ach_hooks.js").checkUrl(app, u, notifyFormat(u) === "feishu" ? "feishu" : "json")
}

function setTerminal(app, task, status) {
  task.set("status", status)
  task.set("waiting_on", "")
  task.set("last_activity", iso(nowMs()))
  revokeTokens(app, "task = {:t}", { t: task.id })
}

function mintRunToken(app, task, agent, runId, mode, questionId) {
  var tok = "ach_rt_" + genKeySecret(40)
  var rt = new Record(app.findCollectionByNameOrId("run_tokens"))
  rt.set("token_hash", sha(tok))
  rt.set("task", task.id)
  rt.set("agent", agent.id)
  rt.set("run_id", runId)
  rt.set("mode", mode)
  if (questionId) rt.set("question", questionId)
  var exp = iso(nowMs() + RUN_TOKEN_HOURS * 3600 * 1000)
  rt.set("expires_at", exp)
  rt.set("revoked", false)
  app.save(rt)
  return { token: tok, expires_at: exp }
}

// Id first, then name (S7). Names shaped like ids are rejected at creation,
// so an id can never be shadowed by another agent's name.
function resolveAgent(app, ref) {
  ref = str(ref).trim()
  if (!ref) throw E(400, "invalid", "'to' is required")
  var a = null
  try {
    a = app.findRecordById("agents", ref)
  } catch (err) {
    try {
      a = app.findFirstRecordByData("agents", "name", ref)
    } catch (err2) {
      a = null
    }
  }
  if (!a) throw E(404, "not_found", "agent '" + ref + "' not found")
  return a
}

function requireRunId(b) {
  var r = str(b.run_id).trim()
  if (!r || r.length > 200) throw E(400, "invalid", "run_id is required")
  return r
}

// ---------------------------------------------------------------- routes

var routes = {}

routes.me = {
  allow: ["agent", "user"],
  fn: function (e, ctx) {
    var app = e.app
    var names = new Names(app)
    if (ctx.type === "user") {
      return [200, userMe(app, ctx.user, ctx)]
    }
    var a = app.findRecordById("agents", ctx.agent.id)
    a.set("last_seen", iso(nowMs()))
    app.save(a)
    var out = agentOut(a, names)
    out.type = "agent"
    out.limits = attachLimits()
    return [200, out]
  },
}

function attachLimits() {
  return {
    max_file_mb: Math.round(maxFileBytes() / 1048576),
    max_files: ATTACH_MAX_FILES,
    mime_types: ATTACH_MIME.slice(),
    // Text/code and .html artifacts are accepted by extension (≤ 2 MB each)
    text_ext: Object.keys(TEXT_EXT),
    max_text_mb: TEXT_MAX_BYTES / 1048576,
  }
}

// GET /me for people. is_admin is the role; admin_session says whether this
// session may use it (false for agent-minted sessions, B1). has_agents drives
// onboarding and button visibility (C).
function userMe(app, u, ctx) {
  var n = new DynamicModel({ n: 0 })
  app.db().newQuery("SELECT COUNT(*) AS n FROM agents WHERE owner = {:u}").bind({ u: u.id }).one(n)
  var scope = (ctx && ctx.scope) || ""
  return {
    type: "user",
    id: u.id,
    name: u.getString("name"),
    email: u.getString("email"),
    is_admin: u.getBool("is_admin"),
    admin_session: u.getBool("is_admin") && scope !== "agent",
    session_scope: scope === "agent" ? "agent" : "full",
    has_agents: n.n > 0,
    invite_cf_available: inviteCfAvailable(),
    role: u.getString("role"),
    github_login: u.getString("github_login"),
    lang: u.getString("lang") || defaultLang(),
    lang_set: !!u.getString("lang"),
    notify_webhook_set: !!u.getString("notify_webhook"),
    limits: attachLimits(),
  }
}

function defaultLang() {
  var l = str($os.getenv("ACH_DEFAULT_LANG")).trim().toLowerCase()
  return l === "zh" ? "zh" : "en"
}

// P4/P5: a human changes their own notification webhook or password.
routes.patchMe = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = body(e)
    return tx(e.app, function (app) {
      var u = app.findRecordById("users", ctx.user.id)
      var changed = false
      if (b.notify_webhook !== undefined) {
        u.set("notify_webhook", parseWebhook(app, b.notify_webhook))
        changed = true
      }
      if (b.password !== undefined) {
        if (ctx.scope === "agent") throw E(403, "needs_admin_login", "an agent-minted session cannot change the password")
        var pw = str(b.password)
        if (pw.length < 10) throw E(400, "invalid", "password must be at least 10 characters")
        if (!u.validatePassword(str(b.old_password))) throw E(403, "forbidden", "old_password is wrong")
        u.setPassword(pw)
        changed = true
      }
      if (b.name !== undefined) {
        var n = str(b.name).trim()
        if (!n || n.length > 200) throw E(400, "invalid", "name must be 1..200 characters")
        u.set("name", n)
        changed = true
      }
      if (b.lang !== undefined) {
        // B12: notification language (the panel's zh/en toggle)
        var lang = str(b.lang).trim().toLowerCase()
        if (lang !== "zh" && lang !== "en") throw E(400, "invalid", "lang must be zh or en")
        u.set("lang", lang)
        changed = true
      }
      if (!changed) throw E(400, "invalid", "nothing to change (notify_webhook, password, name, lang)")
      app.save(u)
      return [200, userMe(app, u, ctx)]
    })
  },
}

routes.agents = {
  allow: ["agent", "user"],
  fn: function (e, ctx) {
    var names = new Names(e.app)
    var list = find(e.app, "agents", "id != ''", "name", 10000, {})
    return [200, list.map(function (a) { return directoryOut(a, names) })]
  },
}

routes.createTask = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var files = uploads(e)
    return tx(e.app, function (app) {
      var from = app.findRecordById("agents", ctx.agent.id)
      var to = resolveAgent(app, b.to)
      if (!to.getBool("active")) throw E(400, "inactive_agent", "agent '" + to.getString("name") + "' is inactive")
      if (to.id === from.id) throw E(400, "invalid", "cannot send a task to yourself")
      var allowFrom = acceptFrom(to)
      if (allowFrom.length && allowFrom.indexOf(from.getString("name")) < 0) {
        throw E(403, "not_accepted", "agent '" + to.getString("name") + "' does not accept work from '" + from.getString("name") + "'")
      }
      var title = str(b.title).trim()
      if (!title) throw E(400, "invalid", "title is required")
      var money = str(b.money).trim()
      if (!money) throw E(400, "invalid", "money is required (may be 'n/a')")
      var handoff = str(b.handoff)
      if (!handoff.trim()) throw E(400, "invalid", "handoff is required")
      var priority = str(b.priority || "P2")
      if (["P0", "P1", "P2", "P3"].indexOf(priority) < 0) throw E(400, "invalid", "priority must be P0..P3")
      var deps = arr(b.depends_on).map(function (d) {
        var dt = findTask(app, d, "dependency task")
        if (!isParty(from.id, dt)) throw E(403, "forbidden", "depends_on must reference tasks you are a party to")
        return dt.id
      })
      var links = b.links === undefined ? null : b.links
      validateLinks(links)
      var channel = taskChannel(app, b.channel, links, ctx)
      var channelNote = archivedRepoNote(app, b.channel, links)
      var now = iso(nowMs())
      var t = new Record(app.findCollectionByNameOrId("tasks"))
      // T-<seq>, allocated inside the write transaction (writes are
      // serialized; the unique index on seq is the backstop).
      t.set("seq", nextSeq(app))
      t.set("channel", channel.id)
      t.set("title", title)
      t.set("priority", priority)
      t.set("purpose", str(b.purpose))
      t.set("key_question", str(b.key_question).trim())
      t.set("money", money)
      t.set("status", "submitted")
      t.set("from_agent", from.id)
      t.set("to_agent", to.id)
      t.set("owner_user", from.getString("owner"))
      t.set("handoff", handoff)
      t.set("handoff_version", 1)
      t.set("waiting_on", "agent:" + to.id)
      t.set("depends_on", deps)
      if (links !== null) t.set("links", links)
      t.set("last_activity", now)
      t.set("agent_hops", 0)
      t.set("cost_usd", 0)
      app.save(t)
      var hv = new Record(app.findCollectionByNameOrId("handoff_versions"))
      hv.set("task", t.id)
      hv.set("version", 1)
      hv.set("body", handoff)
      hv.set("change_note", "initial")
      hv.set("author_agent", from.id)
      app.save(hv)
      attachFiles(app, hv, files)
      // The task's anchor post in its channel.
      var anchor = new Record(app.findCollectionByNameOrId("posts"))
      anchor.set("channel", channel.id)
      anchor.set("author_type", "agent")
      anchor.set("author_agent", from.id)
      anchor.set("kind", "task")
      anchor.set("task", t.id)
      anchor.set("body", title)
      app.save(anchor)
      if (channelNote) sysNote(app, t, channelNote, "archived_repo", { repo: String(links && links.repo || "").toLowerCase() })
      // The worker's owner hears about new work (not when they sent it to their own agent).
      var workerOwner = to.getString("owner")
      if (workerOwner && workerOwner !== from.getString("owner")) notify("task_received", t, workerOwner)
      return [201, fullTask(app, t)]
    })
  },
}

function nextSeq(app) {
  var row = new DynamicModel({ n: 0 })
  app.db().newQuery("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tasks").one(row)
  return row.n
}

// An explicit channel (name or id, not archived); else the channel named
// like links.repo if it exists; else #general.
function taskChannel(app, ref, links, ctx) {
  ref = str(ref).trim().replace(/^#/, "")
  if (ref) {
    var c = findChannel(app, ref)
    if (ctx) requireChannelVisible(ctx, c.id)
    if (c.getBool("archived")) throw E(409, "archived", "channel #" + c.getString("name") + " is archived")
    return c
  }
  var repo = links && typeof links.repo === "string" ? links.repo.toLowerCase() : ""
  if (repo) {
    var byRepo = find(app, "channels", "name = {:n}", "", 1, { n: repo })
    if (byRepo.length && !byRepo[0].getBool("archived") && !(ctx && channelHidden(ctx, byRepo[0].id))) return byRepo[0]
    // B17: the repo's channel is archived: #general, said out loud (not silently)
  }
  return generalChannel(app)
}

// B17: the system note for a task whose links.repo channel is archived.
function archivedRepoNote(app, ref, links) {
  if (str(ref).trim()) return ""
  var repo = links && typeof links.repo === "string" ? links.repo.toLowerCase() : ""
  if (!repo) return ""
  var byRepo = find(app, "channels", "name = {:n} && archived = true", "", 1, { n: repo })
  return byRepo.length ? "channel #" + repo + " (links.repo) is archived; this task was posted in #general" : ""
}

function generalChannel(app) {
  var g = find(app, "channels", "name = 'general'", "", 1, {})
  if (g.length) return g[0]
  var c = new Record(app.findCollectionByNameOrId("channels"))
  c.set("name", "general")
  c.set("visibility", "team")
  c.set("archived", false)
  app.save(c)
  return c
}

// A channel by name ("general", "#general") or record id.
function findChannel(app, ref) {
  ref = str(ref).trim().replace(/^#/, "")
  if (!ref) throw E(400, "invalid", "channel is required")
  var byName = find(app, "channels", "name = {:n}", "", 1, { n: ref.toLowerCase() })
  if (byName.length) return byName[0]
  return findOr404(app, "channels", ref, "channel")
}

routes.getTask = {
  allow: ["agent", "run", "user"],
  runModes: ["work", "answer"],
  fn: function (e, ctx) {
    var t = findTask(e.app, e.request.pathValue("id"), "task")
    requireParty(ctx, t)
    var out = fullTask(e.app, t)
    if (ctx.type !== "user" && ctx.agent.id === t.getString("to_agent")) {
      try { out.wiki_context = require(__hooks + "/ach_wiki.js").promptContext(e.app, t, ctx.hidden) } catch (werr) { out.wiki_context = null }
    }
    return [200, out]
  },
}

// Header fields from a request body: only the keys present, validated.
function headerPatch(b) {
  var out = {}
  HEADER_FIELDS.forEach(function (f) {
    if (b[f] === undefined) return
    if (typeof b[f] !== "string") throw E(400, "invalid", f + " must be a string")
    var v = b[f].trim()
    if (f === "priority" && ["P0", "P1", "P2", "P3"].indexOf(v) < 0) throw E(400, "invalid", "priority must be P0..P3")
    if (f === "money" && !v) throw E(400, "invalid", "money may not be empty (may be 'n/a')")
    if (v.length > 2000) throw E(400, "invalid", f + " is too long")
    out[f] = v
  })
  return out
}

// One sender update: a new handoff body and/or header fields. Bumps the handoff
// version (history keeps the body and a change note naming the header changes),
// resets the hop counter and leaves a note in the timeline.
function senderUpdate(e, ctx, o) {
  return tx(e.app, function (app) {
    var t = findTask(app, e.request.pathValue("id"), "task")
    requireParty(ctx, t)
    if (t.getString("from_agent") !== ctx.agent.id) throw E(403, "forbidden", "only the sender may update the " + (o.body === undefined ? "task" : "handoff"))
    requireOpen(t)
    var changes = []
    for (var f in o.header) {
      var old = t.getString(f)
      if (old === o.header[f]) continue
      changes.push(f + ": " + JSON.stringify(old) + " -> " + JSON.stringify(o.header[f]))
      t.set(f, o.header[f])
    }
    var text = o.body === undefined ? t.getString("handoff") : o.body
    if (o.body === undefined && !changes.length) throw E(400, "invalid", "nothing changed")
    var note = o.note
    if (changes.length) note = (note ? note + "; " : "") + "header " + changes.join(", ")
    var v = t.getInt("handoff_version") + 1
    t.set("handoff", text)
    t.set("handoff_version", v)
    t.set("agent_hops", 0)
    t.set("last_activity", iso(nowMs()))
    app.save(t)
    var hv = new Record(app.findCollectionByNameOrId("handoff_versions"))
    hv.set("task", t.id)
    hv.set("version", v)
    hv.set("body", text)
    hv.set("change_note", note)
    hv.set("author_agent", ctx.agent.id)
    app.save(hv)
    attachFiles(app, hv, o.files)
    addMsg(app, t, { author_type: "agent", author_agent: ctx.agent.id, kind: "note", body: "handoff v" + v + ": " + note })
    return [200, fullTask(app, t)]
  })
}

// PUT /tasks/{id}/handoff: new body (+ optional header fields). Agent key of
// the sender only (run tokens are rejected by allow).
routes.handoff = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var text = str(b.body)
    if (!text.trim()) throw E(400, "invalid", "body is required")
    var note = str(b.change_note).trim()
    if (!note) throw E(400, "invalid", "change_note is required")
    return senderUpdate(e, ctx, { body: text, note: note, header: headerPatch(b), files: uploads(e) })
  },
}

// PATCH /tasks/{id}: header fields only (priority, purpose, money, key_question).
routes.patchTask = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    for (var k in b) {
      if (HEADER_FIELDS.indexOf(k) < 0 && k !== "change_note") throw E(400, "invalid", "unknown field '" + k + "' (allowed: " + HEADER_FIELDS.join(", ") + ", change_note)")
    }
    var header = headerPatch(b)
    if (!Object.keys(header).length) throw E(400, "invalid", "nothing to change (" + HEADER_FIELDS.join(", ") + ")")
    return senderUpdate(e, ctx, { note: str(b.change_note).trim(), header: header })
  },
}

routes.claim = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var runId = requireRunId(b)
    var mode = str(b.mode || "runner")
    if (CLAIM_MODES.indexOf(mode) < 0) throw E(400, "invalid", "mode must be runner|interactive")
    var id = e.request.pathValue("id")
    return tx(e.app, function (app) {
      var t = findTask(app, id, "task")
      requireParty(ctx, t)
      if (t.getString("to_agent") !== ctx.agent.id) throw E(403, "forbidden", "only the receiving agent may claim")
      var agent = app.findRecordById("agents", ctx.agent.id)
      var budget = agent.getFloat("budget_usd")
      if (budget > 0 && agent.getFloat("spent_usd") >= budget) {
        throw E(409, "budget_exceeded", "agent budget reached", { budget_usd: budget, spent_usd: agent.getFloat("spent_usd") })
      }
      var now = iso(nowMs())
      // Atomic conditional update: the WHERE clause is the claim rule.
      var res = app
        .db()
        .newQuery(
          "UPDATE tasks SET status = 'working', run_id = {:run}, claim_mode = {:mode}, claimed_at = {:now}, last_activity = {:now}, updated = {:now} " +
            "WHERE id = {:id} AND to_agent = {:agent} AND (status = 'submitted' OR (status = 'working' AND run_id = {:run}))"
        )
        .bind({ run: runId, mode: mode, now: now, id: t.id, agent: ctx.agent.id })
        .execute()
      if (res.rowsAffected() !== 1) {
        var cur = app.findRecordById("tasks", t.id)
        throw E(409, "conflict", "task cannot be claimed (status " + cur.getString("status") + ")", { status: cur.getString("status") })
      }
      t = app.findRecordById("tasks", t.id)
      // a re-claim replaces the previous work token of this run
      revokeTokens(app, "task = {:t} && mode = 'work'", { t: t.id })
      recomputeWaiting(app, t)
      app.save(t)
      var out = fullTask(app, t)
      // ≤ ~1k tokens of wiki for the worker prompt
      try {
        var wikiMod = require(__hooks + "/ach_wiki.js")
        out.wiki_context = wikiMod.promptContext(app, t, ctx.hidden)
        wikiMod.logInject(app, t, out.wiki_context, agent.id)
      } catch (werr) { out.wiki_context = null }
      // An interactive claim (P1) has no spawned agent: the person's own agent
      // acts with the agent key, so no run token is minted.
      if (mode === "runner") {
        var tok = mintRunToken(app, t, agent, runId, "work", "")
        out.run_token = tok.token
        out.run_token_expires_at = tok.expires_at
      }
      return [200, out]
    })
  },
}

routes.heartbeat = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var runId = requireRunId(b)
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      requireParty(ctx, t)
      if (t.getString("to_agent") !== ctx.agent.id) throw E(403, "forbidden", "only the receiving agent may heartbeat")
      var st = t.getString("status")
      if ((st !== "working" && st !== "input-required") || t.getString("run_id") !== runId) {
        throw E(409, "not_running", "task is not running under this run_id (status " + st + ")", { status: st })
      }
      t.set("last_activity", iso(nowMs()))
      app.save(t)
      var out = { ok: true, status: st }
      // C5: hand the runner a fresh work token when the newest one for this run
      // expires within 2h. Older tokens stay valid until their own expiry.
      var nowM = nowMs()
      var toks = find(app, "run_tokens", "task = {:t} && run_id = {:r} && mode = 'work' && revoked = false", "-expires_at", 1, { t: t.id, r: runId })
      var left = toks.length ? parseTime(toks[0].getString("expires_at")) - nowM : 0
      if (left < TOKEN_REFRESH_BEFORE_MS) {
        var tok = mintRunToken(app, t, app.findRecordById("agents", ctx.agent.id), runId, "work", "")
        out.run_token = tok.token
        out.run_token_expires_at = tok.expires_at
      }
      return [200, out]
    })
  },
}

// S8: usage must belong to a real run of the caller. Work-run usage: only the
// to_agent, with the task's current run_id. Answer-run usage: a run_id of an
// answer token this agent was issued on this task. Each post is clamped to
// ACH_USAGE_MAX (default $50) and stored as a usage row (cost_week sums rows).
routes.usage = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var runId = requireRunId(b)
    var cost = Number(b.cost_usd)
    if (typeof b.cost_usd !== "number" || isNaN(cost) || cost < 0) {
      throw E(400, "invalid", "cost_usd must be a non-negative number")
    }
    var max = envInt("ACH_USAGE_MAX", USAGE_MAX_DEFAULT)
    var clamped = cost > max
    if (clamped) cost = max
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      requireParty(ctx, t)
      var mode = ""
      if (t.getString("to_agent") === ctx.agent.id && t.getString("run_id") && t.getString("run_id") === runId) {
        mode = "work"
      } else {
        var ans = find(app, "run_tokens", "task = {:t} && agent = {:a} && run_id = {:r} && mode = 'answer'", "", 1, {
          t: t.id,
          a: ctx.agent.id,
          r: runId,
        })
        if (ans.length) mode = "answer"
      }
      if (!mode) throw E(403, "forbidden", "run_id is not a run of yours on this task")
      t.set("cost_usd", t.getFloat("cost_usd") + cost)
      if (b.estimated === true) t.set("cost_estimated", true)
      app.save(t)
      var a = app.findRecordById("agents", ctx.agent.id)
      a.set("spent_usd", a.getFloat("spent_usd") + cost)
      app.save(a)
      var u = new Record(app.findCollectionByNameOrId("usage"))
      u.set("task", t.id)
      u.set("agent", a.id)
      u.set("run_id", runId)
      u.set("mode", mode)
      u.set("cost_usd", cost)
      u.set("estimated", b.estimated === true)
      app.save(u)
      return [
        200,
        {
          task_cost_usd: t.getFloat("cost_usd"),
          agent_spent_usd: a.getFloat("spent_usd"),
          cost_estimated: t.getBool("cost_estimated"),
          recorded_usd: cost,
          clamped: clamped,
          mode: mode,
        },
      ]
    })
  },
}

routes.answerRun = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var runId = requireRunId(b)
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      requireParty(ctx, t)
      requireOpen(t)
      var q = findOr404(app, "messages", b.question_id, "question")
      if (q.getString("task") !== t.id || q.getString("kind") !== "question") throw E(400, "invalid", "question_id is not a question on this task")
      if (q.getBool("resolved")) throw E(409, "resolved", "question already resolved")
      if (q.getString("to_agent") !== ctx.agent.id) throw E(403, "forbidden", "question is not addressed to you")
      var active = find(app, "run_tokens", "question = {:q} && mode = 'answer' && revoked = false && expires_at > {:now}", "", 1, {
        q: q.id,
        now: iso(nowMs()),
      })
      if (active.length) throw E(409, "conflict", "an answer run is already active for this question")
      var agent = app.findRecordById("agents", ctx.agent.id)
      var tok = mintRunToken(app, t, agent, runId, "answer", q.id)
      var out = fullTask(app, t)
      out.question = msgOut(q, new Names(app))
      out.run_token = tok.token
      out.run_token_expires_at = tok.expires_at
      return [200, out]
    })
  },
}

function ownerOf(app, agentId, fallback) {
  try {
    return app.findRecordById("agents", agentId).getString("owner") || fallback
  } catch (err) {
    return fallback
  }
}

// S6: a decision request goes to the requesting side's owner: worker side ->
// the worker agent's owner, sender side -> the sender's owner. to:"both" adds
// the other side's owner; both must decide (an admin may decide for both).
// C4: the runner revokes an answer token as soon as its run ends.
routes.endRun = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var runId = requireRunId(b)
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      requireParty(ctx, t)
      var toks = find(app, "run_tokens", "task = {:t} && agent = {:a} && run_id = {:r} && mode = 'answer' && revoked = false", "", 100, {
        t: t.id,
        a: ctx.agent.id,
        r: runId,
      })
      toks.forEach(function (rt) {
        rt.set("revoked", true)
        app.save(rt)
      })
      return [200, { revoked: toks.length }]
    })
  },
}

// B11: the task states a money stake, or the request talks about money
// (currency signs and Chinese money words: language support for Chinese input).
var MONEY_RE = /[$¥￥]|元|成本|费用|花费|预算|\bcosts?\b|\bbudget\b/i
function moneyImpact(task, text) {
  var money = str(task.getString("money")).trim().toLowerCase()
  if (money && money !== "n/a" && money !== "na" && money !== "none") return true
  return MONEY_RE.test(str(text))
}

/** Is person uid a member of the task's channel? (#general / no channel: any active person) */
function channelMemberOf(app, channelId, uid, strict) {
  if (!channelId) return !strict
  var c = null
  try { c = app.findRecordById("channels", channelId) } catch (err) { return false }
  if (c.getString("name") === "general" && !strict) return true
  return arr(c.getStringSlice("members")).indexOf(uid) >= 0
}

/** A person named by id, email or (unique, case-insensitive) name; active only. */
function personByRef(app, ref) {
  ref = str(ref).trim().replace(/^@/, "")
  if (!ref || ref.length > 200) throw E(400, "invalid", "to_user must name a person (id, email or name)")
  var u = null
  if (/^[a-z0-9]{15}$/.test(ref)) { try { u = app.findRecordById("users", ref) } catch (err) { u = null } }
  if (!u && ref.indexOf("@") > 0) { try { u = app.findAuthRecordByEmail("users", ref.toLowerCase()) } catch (err) { u = null } }
  if (!u) {
    var lc = ref.toLowerCase()
    var hits = find(app, "users", "deactivated = false", "", 100000, {}).filter(function (x) { return str(x.getString("name")).trim().toLowerCase() === lc })
    if (hits.length > 1) throw E(400, "ambiguous", "more than one person is called '" + ref + "': use their email", { candidates: hits.map(function (x) { return { id: x.id, name: x.getString("name"), email: x.getString("email") } }) })
    u = hits[0] || null
  }
  if (!u || u.getBool("deactivated")) throw E(404, "not_found", "no active person '" + ref + "'")
  return u
}

function decisionTargets(app, task, actorAgent, toOpt, toUser) {
  if (toUser) return [toUser]
  if (toOpt && toOpt !== "self" && toOpt !== "both") throw E(400, "invalid", "'to' for a decision request must be omitted or \"both\"")
  var isWorker = task.getString("to_agent") === actorAgent.id
  var mine = actorAgent.getString("owner")
  var out = [mine]
  if (toOpt === "both") {
    var other = isWorker
      ? ownerOf(app, task.getString("from_agent"), task.getString("owner_user"))
      : ownerOf(app, task.getString("to_agent"), "")
    if (other && other !== mine) out.push(other)
  }
  return out
}

function prevStatusFor(app, task) {
  var st = task.getString("status")
  if (st !== "input-required") return st
  var open = openBlocking(app, task.id)
  return open.length ? open[0].getString("prev_status") || "working" : "working"
}

// ---- structured decision requests (replies only)
// A decision request reads like a terminal multiple-choice question:
// {question, options:[{label, detail, money}], recommended} with 2–4 options
// (2–3 is the rule for agents), the recommended one first. People answer by
// replying (a button just sends "label — detail"); the reply is the decision.

/** " (Recommended)" or its Chinese form: plain text after the recommended option's label. */
function recMark(lang) { return lang === "zh" ? "（推荐）" : " (Recommended)" }

/** Question marks in a question (URLs and code ignored). */
function questionCount(text) {
  var t = str(text).replace(/https?:\/\/\S+/g, " ").replace(/`[^`]*`/g, " ")
  return (t.match(/[?？]/g) || []).length // ASCII or full-width question mark
}

/** "A|detail|$10" or {label, detail, money}. */
function cleanOption(o) {
  if (typeof o === "string") {
    var parts = o.split("|")
    o = { label: parts[0], detail: parts[1], money: parts.slice(2).join("|") }
  }
  if (!o || typeof o !== "object") throw E(400, "invalid", "each option is {label, detail?, money?} or \"label|detail|money\"")
  var out = { label: str(o.label).replace(/\s+/g, " ").trim().slice(0, 120), detail: str(o.detail).replace(/\s+/g, " ").trim().slice(0, 400), money: str(o.money).replace(/\s+/g, " ").trim().slice(0, 80) }
  if (!out.label) throw E(400, "invalid", "every option needs a label")
  // never-delegable flags: declared, plus what the option's words say (deterministic)
  var flags = require(__hooks + "/ach_grants.js").optionFlags(o)
  if (flags.length) out.flags = flags
  return out
}

/**
 * Validates a decision request: one question (at most one question mark), and
 * when options are given 2–4 of them (recommended one moved first). Returns
 * the choices object, or null for a plain one-question request.
 */
function parseChoices(b, bodyText) {
  var q = str(b.question).replace(/\s+/g, " ").trim().slice(0, 1000)
  var opts = b.options
  if (opts === undefined || opts === null || (Array.isArray(opts) && !opts.length)) {
    if (questionCount(q || bodyText) > 1) throw E(400, "invalid", "one question per decision request: split it, and ask only what you cannot verify yourself")
    return null
  }
  if (!Array.isArray(opts)) throw E(400, "invalid", "options must be a list")
  if (opts.length > 4) throw E(400, "invalid", "a decision request has at most 4 options (2–3, recommended first)")
  if (opts.length < 2) throw E(400, "invalid", "a decision request needs 2–3 options (or none: a plain question)")
  if (!q) q = str(bodyText).split("\n")[0].trim().slice(0, 1000)
  if (!q) throw E(400, "invalid", "question is required")
  if (questionCount(q) > 1) throw E(400, "invalid", "one question per decision request: split it, and ask only what you cannot verify yourself")
  var list = opts.map(cleanOption)
  var rec = b.recommended === undefined || b.recommended === null || b.recommended === "" ? 0 : parseInt(b.recommended, 10)
  if (!(rec >= 0 && rec < list.length)) throw E(400, "invalid", "recommended must be the index of an option")
  var first = list.splice(rec, 1)[0]
  list.unshift(first)
  return { question: q, options: list, recommended: 0 }
}

/** One option as text: "A (Recommended) — detail · $10" (the panel buttons and replies use the same words). */
function optionText(o, recommended, lang) {
  return o.label + (recommended ? recMark(lang) : "") + (o.detail ? " — " + o.detail : "") + (o.money ? " · " + o.money : "")
}

/** The message body of a structured request (people and agents without a panel read it). */
function choicesBody(c, lang) {
  return [c.question].concat(c.options.map(function (o, i) { return (i + 1) + ". " + optionText(o, i === c.recommended, lang) })).join("\n")
}

// Adds one decision_request per target owner. Only worker-side requests block:
// they move the task to input-required (C1). Sender-side requests are attached
// for the human without stopping the worker.
//
// Authorization: per target person, an agent grant to the asking
// agent splits off the options it covers (a request part the agent answers
// under the grant, never shown to people); person-grants route the rest to the
// grantee person's Inbox too (also_to). lastDelegated: the split-off parts.
var lastDelegated = []
function splitChoices(c, idx, keep) {
  var opts = []
  var rec = 0
  c.options.forEach(function (o, i) {
    if ((idx.indexOf(i) >= 0) !== keep) return
    if (i === c.recommended) rec = opts.length
    opts.push(o)
  })
  return opts.length ? { question: c.question, options: opts, recommended: rec } : null
}
function addDecisionRequests(app, t, me, fields, targets) {
  var G = require(__hooks + "/ach_grants.js")
  var blocking = t.getString("to_agent") === me.id
  var prev = blocking ? prevStatusFor(app, t) : ""
  var group = targets.length > 1 ? $security.randomStringWithAlphabet(15, IDCHARS) : ""
  var first = null
  var human = false
  lastDelegated = []
  targets.forEach(function (u) {
    var f = { author_type: "agent", author_agent: me.id, kind: "decision_request", to_user: u, prev_status: prev, blocking: blocking, dr_group: group }
    for (var k in fields) f[k] = fields[k]
    var plan = G.planRequest(app, t, me, u, f.choices || null)
    if (plan.agentGrant) {
      var dc = splitChoices(f.choices, plan.delegable, true)
      var dm = addMsg(app, t, { author_type: "agent", author_agent: me.id, kind: "decision_request", to_user: u, topic: f.topic || "", body: choicesBody(dc, defaultLang()), choices: dc, delegated_grant: plan.agentGrant.id, blocking: false })
      lastDelegated.push({ message_id: dm.id, grant: plan.agentGrant.id, options: dc.options, guidance: plan.agentGrant.getString("guidance"), remaining: G.grantOut(app, plan.agentGrant, new Names(app)).remaining })
      var hc = splitChoices(f.choices, plan.delegable, false)
      if (!hc) { if (!first) first = dm; return }
      f.choices = hc
      f.body = choicesBody(hc, defaultLang())
      plan = G.planRequest(app, t, me, u, hc)
    }
    if (plan.people.length) f.also_to = plan.people
    var m = addMsg(app, t, f)
    human = true
    if (!first) first = m
    notify("decision_request", t, u, m, f.choices || null)
    plan.people.forEach(function (p) { notify("decision_request", t, p, m, f.choices || null) })
  })
  if (blocking && human) t.set("status", "input-required")
  return first
}

routes.postMessage = {
  allow: ["agent", "run"],
  runModes: ["work", "answer"],
  fn: function (e, ctx) {
    var b = body(e)
    var files = uploads(e)
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      requireParty(ctx, t)
      requireOpen(t)
      var me = app.findRecordById("agents", ctx.agent.id)
      var kind = str(b.kind)
      var text = str(b.body)
      if (kind === "decision_request" && Array.isArray(b.options) && b.options.length) {
        // structured: the money of each option counts for the money check
        text = [str(b.body).trim() || str(b.question)].concat(b.options.map(function (o) { return typeof o === "string" ? o : [str(o && o.label), str(o && o.detail), str(o && o.money)].join(" ") })).join("\n")
      }
      if (!text.trim()) throw E(400, "invalid", "body is required")
      var allowedRun = { work: ["progress", "note", "question", "decision_request"], answer: ["answer", "decision_request"] }
      if (ctx.type === "run" && allowedRun[ctx.mode].indexOf(kind) < 0) {
        throw E(403, "forbidden", "run token mode '" + ctx.mode + "' may not post '" + kind + "'")
      }
      var now = iso(nowMs())
      var isWorker = t.getString("to_agent") === me.id
      var converted = false
      var ccUser = ""
      var m

      if (kind === "progress" || kind === "note") {
        m = addMsg(app, t, { author_type: "agent", author_agent: me.id, kind: kind, body: text })
      } else if (kind === "question") {
        var other = isWorker ? t.getString("from_agent") : t.getString("to_agent")
        var toId = other
        if (b.to) {
          var target = resolveAgent(app, b.to)
          if (!isParty(target.id, t) || target.id === me.id) throw E(400, "invalid", "'to' must be the other party of this task")
          toId = target.id
        }
        var hops = t.getInt("agent_hops") + 1
        t.set("agent_hops", hops)
        if (hops > HOP_LIMIT) {
          converted = true
          m = addDecisionRequests(
            app,
            t,
            me,
            { topic: "hop_limit", body: "[hop limit " + HOP_LIMIT + " reached; question converted to a decision request] " + text },
            [me.getString("owner") || t.getString("owner_user")]
          )
        } else {
          m = addMsg(app, t, { author_type: "agent", author_agent: me.id, kind: "question", body: text, to_agent: toId })
        }
        if (isWorker) t.set("parked_at", now)
      } else if (kind === "answer") {
        var q = findOr404(app, "messages", b.reply_to, "question")
        if (q.getString("task") !== t.id || q.getString("kind") !== "question") throw E(400, "invalid", "reply_to must be a question on this task")
        if (q.getBool("resolved")) throw E(409, "resolved", "question already resolved")
        if (q.getString("to_agent") !== me.id) throw E(403, "forbidden", "question is not addressed to you")
        if (ctx.type === "run" && ctx.token.getString("question") !== q.id) throw E(403, "forbidden", "answer token is scoped to another question")
        if (!str(b.evidence).trim()) throw E(400, "evidence_required", "answers require non-empty evidence")
        m = addMsg(app, t, {
          author_type: "agent",
          author_agent: me.id,
          kind: "answer",
          body: text,
          evidence: str(b.evidence),
          reply_to: q.id,
          to_agent: q.getString("author_agent"),
        })
        q.set("resolved", true)
        app.save(q)
        revokeTokens(app, "question = {:q}", { q: q.id })
        t.set("agent_hops", t.getInt("agent_hops") + 1)
      } else if (kind === "decision_request") {
        var replyQ = null
        var replyId = str(b.reply_to)
        if (ctx.type === "run" && ctx.mode === "answer") {
          if (replyId && replyId !== ctx.token.getString("question")) throw E(403, "forbidden", "answer token is scoped to another question")
          replyId = ctx.token.getString("question")
        }
        if (replyId) {
          replyQ = findOr404(app, "messages", replyId, "message")
          if (replyQ.getString("task") !== t.id) throw E(400, "invalid", "reply_to must be on this task")
          if (replyQ.getString("kind") === "question") {
            if (replyQ.getString("to_agent") !== me.id) throw E(403, "forbidden", "question is not addressed to you")
            if (replyQ.getBool("resolved")) throw E(409, "resolved", "question already resolved")
          }
        }
        var topic = str(b.topic).slice(0, 40)
        if (topic === "budget") {
          var dup = find(app, "messages", "task = {:t} && kind = 'decision_request' && topic = 'budget' && resolved = false", "", 1, { t: t.id })
          if (dup.length) throw E(409, "duplicate", "an open budget decision request already exists", { message_id: dup[0].id })
        }
        // A decision addressed to a named person (a member of the task's channel)
        var named = null
        if (b.to_user !== undefined && b.to_user !== null && str(b.to_user).trim()) {
          if (str(b.to).trim()) throw E(400, "invalid", "give either 'to' or 'to_user', not both")
          named = personByRef(app, b.to_user)
          if (!channelMemberOf(app, t.getString("channel"), named.id)) throw E(403, "not_member", userName(named) + " is not a member of this task's channel")
          if (named.id === me.getString("owner")) named = null
        }
        // B11: a worker's request with money impact goes to both owners by default.
        var toOpt = str(b.to)
        // (topic "budget" is the runner's own budget notice: the worker side decides.)
        if (!named && !toOpt && isWorker && topic !== "budget" && moneyImpact(t, text)) toOpt = "both"
        var choices = topic === "budget" || topic === "hop_limit" ? null : parseChoices(b, text)
        var targets = decisionTargets(app, t, me, toOpt, named ? named.id : "")
        var drf = { topic: topic, body: choices ? choicesBody(choices, defaultLang()) : text, reply_to: replyQ ? replyQ.id : "" }
        if (choices) drf.choices = choices
        m = addDecisionRequests(app, t, me, drf, targets)
        // B11: the sender's owner always hears about the worker's decision requests.
        if (isWorker) {
          var senderOwner = ownerOf(app, t.getString("from_agent"), t.getString("owner_user"))
          if (senderOwner && targets.indexOf(senderOwner) < 0 && senderOwner !== me.getString("owner")) notify("decision_request_fyi", t, senderOwner, m)
        }
        if (named && me.getString("owner")) {
          ccUser = me.getString("owner")
          notify("decision_request_cc", t, ccUser, m, null, { name: userName(named) })
        }
        if (replyQ && replyQ.getString("kind") === "question") {
          replyQ.set("resolved", true)
          app.save(replyQ)
          revokeTokens(app, "question = {:q}", { q: replyQ.id })
        }
        if (isWorker) t.set("parked_at", now)
      } else if (kind === "result") {
        throw E(400, "invalid", "results are posted via /complete")
      } else if (kind === "decision") {
        throw E(403, "forbidden", "decisions are human-only (/decide)")
      } else {
        throw E(400, "invalid", "unknown kind '" + kind + "'")
      }
      attachFiles(app, m, files)
      t.set("last_activity", now)
      app.save(t)
      recomputeWaiting(app, t)
      app.save(t)
      var names = new Names(app)
      var mo = msgOut(m, names)
      if (kind === "decision_request" && lastDelegated.length) mo.delegated = lastDelegated
      var out201 = { message: mo, task: taskOut(t, names), converted: converted }
      if (ccUser) out201.cc_user = ccUser
      return [201, out201]
    })
  },
}

routes.complete = {
  allow: ["agent", "run"],
  runModes: ["work"],
  fn: function (e, ctx) {
    var b = body(e)
    var files = uploads(e)
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      requireParty(ctx, t)
      if (t.getString("to_agent") !== ctx.agent.id) throw E(403, "forbidden", "only the receiving agent may complete")
      requireOpen(t)
      requireCurrentRun(ctx, t, b)
      if (t.getString("status") !== "working") throw E(409, "bad_state", "can only complete a working task (status " + t.getString("status") + ")", { status: t.getString("status") })
      // A worker that names the handoff it worked from cannot finish on an
      // outdated one: the sender replaced it meanwhile (runner sets ACH_HANDOFF_VERSION).
      var shown = parseInt(b.handoff_version, 10)
      var current = t.getInt("handoff_version")
      if (shown > 0 && shown < current) {
        throw E(409, "handoff_updated", "the sender updated the handoff to v" + current + " since you started (you worked from v" + shown + "). Read it (`ach show`) and continue; complete when the new version is done.", { handoff_version: current })
      }
      var result = str(b.result)
      if (!result.trim()) throw E(400, "invalid", "result is required")
      t.set("result", result)
      var rm = addMsg(app, t, { author_type: "agent", author_agent: ctx.agent.id, kind: "result", body: result })
      attachFiles(app, rm, files)
      setTerminal(app, t, "completed")
      app.save(t)
      notify("task_completed", t, t.getString("owner_user"), rm)
      require(__hooks + "/ach_wiki.js").onTaskTerminal(app, t, "completed")
      return [200, fullTask(app, t)]
    })
  },
}

routes.fail = {
  allow: ["agent", "run"],
  runModes: ["work"],
  fn: function (e, ctx) {
    var b = body(e)
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      requireParty(ctx, t)
      if (t.getString("to_agent") !== ctx.agent.id) throw E(403, "forbidden", "only the receiving agent may fail")
      requireOpen(t)
      requireCurrentRun(ctx, t, b)
      var reason = str(b.reason).trim()
      if (!reason) throw E(400, "invalid", "reason is required")
      t.set("result", "failed: " + reason)
      var fm = addMsg(app, t, { author_type: "agent", author_agent: ctx.agent.id, kind: "note", body: "failed: " + reason })
      setTerminal(app, t, "failed")
      app.save(t)
      notify("task_failed", t, t.getString("owner_user"), fm)
      require(__hooks + "/ach_wiki.js").onTaskTerminal(app, t, "failed")
      return [200, fullTask(app, t)]
    })
  },
}

routes.cancel = {
  allow: ["agent", "user"],
  fn: function (e, ctx) {
    var b = body(e)
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      requireParty(ctx, t)
      if (ctx.type === "agent" && t.getString("from_agent") !== ctx.agent.id) throw E(403, "forbidden", "only the sender may cancel")
      if (ctx.type === "user" && !ctx.isAdmin && t.getString("owner_user") !== ctx.user.id) throw adminDenied(ctx, "only the task owner or an admin may cancel")
      requireOpen(t)
      var reason = str(b.reason).trim()
      var who = ctx.type === "agent" ? "agent " + ctx.agent.getString("name") : "user " + userName(ctx.user)
      if (ctx.type === "agent") {
        addMsg(app, t, { author_type: "agent", author_agent: ctx.agent.id, kind: "note", body: "canceled" + (reason ? ": " + reason : "") })
      } else {
        addMsg(app, t, { author_type: "human", author_user: ctx.user.id, kind: "note", body: "canceled" + (reason ? ": " + reason : "") })
      }
      // resolve anything still open so nobody keeps waiting on it
      openOf(app, t.id, "question").concat(openOf(app, t.id, "decision_request")).forEach(function (m) {
        m.set("resolved", true)
        app.save(m)
      })
      setTerminal(app, t, "canceled")
      app.save(t)
      require(__hooks + "/ach_wiki.js").onTaskTerminal(app, t, "canceled")
      return [200, fullTask(app, t)]
    })
  },
}

// POST /tasks/{id}/decide {message_id, decision, grant?}: a reply to a decision
// request is the decision. Who may reply: the person it is addressed
// to (or an admin); that person's own agent with its agent key ("via <agent>",
// an interactive session where the person is present; never a run token, never
// for anyone else); a grantee person a person-grant routed it to (within the
// grant: "on behalf of <grantor> per #id", the cap is debited). The first valid
// reply wins; the addressee may still override a grantee's or a grant's answer
// by replying. `grant` {agent|person, cap, until, note}: the addressee grants
// authorization for this task in the same reply.
routes.decide = {
  allow: ["user", "agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var files = uploads(e)
    return tx(e.app, function (app) {
      var G = require(__hooks + "/ach_grants.js")
      var W = require(__hooks + "/ach_wiki.js")
      var t = findTask(app, e.request.pathValue("id"), "task")
      var req = findOr404(app, "messages", b.message_id, "decision request")
      if (req.getString("task") !== t.id || req.getString("kind") !== "decision_request") throw E(400, "invalid", "message_id is not a decision request on this task")
      var speakerUser
      var viaAgent = ""
      if (ctx.type === "agent") {
        var ag = app.findRecordById("agents", ctx.agent.id)
        speakerUser = app.findRecordById("users", ag.getString("owner"))
        if (req.getString("to_user") !== speakerUser.id) throw E(403, "forbidden", "an agent may only speak for its own owner: this request is addressed to someone else")
        viaAgent = ag.id
      } else speakerUser = ctx.user
      var isAddressee = req.getString("to_user") === speakerUser.id
      var adminAct = ctx.type === "user" && ctx.isAdmin
      var decision = str(b.decision).trim()
      if (!decision) throw E(400, "invalid", "decision is required")
      var toAgent = req.getString("author_agent") || t.getString("to_agent")
      if (req.getString("reply_to")) {
        try {
          var orig = app.findRecordById("messages", req.getString("reply_to"))
          if (orig.getString("kind") === "question" && orig.getString("author_agent")) toAgent = orig.getString("author_agent")
        } catch (err) {}
      }
      var names = new Names(app)
      if (req.getBool("resolved")) {
        // override: the addressee replies to what a grantee person or a grant answered
        var prior = find(app, "messages", "reply_to = {:r} && kind = 'decision'", "-created", 1, { r: req.id })
        var overridable = prior.length && (prior[0].getString("grant") || prior[0].getString("on_behalf_of"))
        if (!overridable || !(isAddressee || adminAct)) throw E(409, "resolved", "decision request already resolved")
        var om = addMsg(app, t, { author_type: "human", author_user: speakerUser.id, kind: "decision", body: decision, reply_to: req.id, to_agent: toAgent, via_agent: viaAgent })
        attachFiles(app, om, files)
        W.onHumanDecision(app, t, req, om, speakerUser, { override: true })
        t.set("last_activity", iso(nowMs()))
        app.save(t)
        return [200, { message: msgOut(om, names), task: taskOut(t, names), override: true }]
      }
      // a Memory question (decide-draft) can still be answered after its task ended: the answer is for Memory only
      var memoryOnly = req.getString("topic") === "memory_decision"
      if (!memoryOnly) requireOpen(t)
      if (req.getString("delegated_grant") && !isAddressee && !adminAct) throw E(403, "forbidden", "this part is answered under a grant by its agent")
      var grantUse = null
      if (!isAddressee && !adminAct) {
        var also = parseJSON(req.getString("also_to")) || []
        if (ctx.type !== "user" || also.indexOf(ctx.user.id) < 0) throw adminDenied(ctx, "this decision is addressed to someone else")
        grantUse = G.personGrantFor(app, t, req, ctx.user.id, W.pickedOption(parseJSON(req.getString("choices")), decision))
        if (!grantUse) throw E(403, "forbidden", "outside your authorization (an option over the remaining cap or never delegable, or the grant ended): " + names.user(req.getString("to_user")) + " decides")
      }
      // to:"both" (S6): every owner must decide; an admin's decision settles the
      // whole group. The agent is woken only once the group is settled.
      var resolveNow = [req]
      var group = req.getString("dr_group")
      if (group && ctx.type === "user" && ctx.isAdmin) {
        find(app, "messages", "task = {:t} && dr_group = {:g} && resolved = false && id != {:id}", "", 100, { t: t.id, g: group, id: req.id }).forEach(function (x) {
          resolveNow.push(x)
        })
      }
      resolveNow.forEach(function (x) {
        x.set("resolved", true)
        app.save(x)
      })
      var groupOpen = group
        ? find(app, "messages", "task = {:t} && dr_group = {:g} && resolved = false", "", 1, { t: t.id, g: group }).length > 0
        : false
      var m = addMsg(app, t, {
        author_type: "human",
        author_user: speakerUser.id,
        kind: "decision",
        body: decision,
        reply_to: req.id,
        to_agent: groupOpen ? "" : toAgent,
        via_agent: viaAgent,
        on_behalf_of: grantUse ? req.getString("to_user") : "",
        grant: grantUse ? grantUse.grant.id : "",
      })
      attachFiles(app, m, files)
      if (grantUse) G.debit(app, grantUse.grant, grantUse.money)
      W.onHumanDecision(app, t, req, m, speakerUser, { grant: grantUse ? grantUse.grant : null })
      var granted = null
      if (b.grant && typeof b.grant === "object" && isAddressee) {
        var gb = {}
        for (var gk in b.grant) gb[gk] = b.grant[gk]
        if (!gb.agent && !gb.person) gb.agent = names.agent(req.getString("author_agent"))
        if (!gb.task && !gb.channel) gb.task = t.id
        granted = G.grantOut(app, G.createGrant(app, speakerUser, gb, "reply", linkUrl("t/" + taskRef(t) + "/m/" + m.id)), names)
      }
      if (TERMINAL[t.getString("status")]) return [200, { message: msgOut(m, names), task: taskOut(t, names), group_open: groupOpen, grant: granted }]
      if (!openBlocking(app, t.id).length && t.getString("status") === "input-required") {
        var prev = req.getBool("blocking") ? req.getString("prev_status") : "working"
        if (["submitted", "working"].indexOf(prev) < 0) prev = "working"
        if (prev === "working" && !t.getString("run_id")) prev = "submitted"
        t.set("status", prev)
      }
      t.set("agent_hops", 0)
      t.set("last_activity", iso(nowMs()))
      recomputeWaiting(app, t)
      app.save(t)
      return [200, { message: msgOut(m, names), task: taskOut(t, names), group_open: groupOpen, grant: granted }]
    })
  },
}

// POST /push/act {token}: a tap on a notification's option button (Web Push
// service worker, desktop notifier). The token (ach_notify.js mintActions) is
// the credential: random, hashed at rest, single use, bound to one person, one
// decision request and one option, ~24 h. It records that person's reply
// exactly like the panel button: a task request through /decide (author_type
// human, the reply is the decision's source), a channel question through a
// thread reply. Outcomes (HTTP 200 unless noted), stored on the token so a
// retry returns the same answer and never records twice (`replay: true`):
// recorded | already_answered | deactivated | not_addressed | closed | gone |
// refused; 410 expired; 401 unknown token; 403 wrong_user when the request
// also carries credentials of someone else.
routes.pushAct = {
  allow: ["public"],
  fn: function (e) {
    var app = e.app
    var N = require(__hooks + "/ach_notify.js")
    var b = body(e)
    var token = str(b.token).trim()
    var row = N.ACTION_RE.test(token) ? find(app, "push_actions", "token_hash = {:h}", "", 1, { h: $security.sha256(token) })[0] : null
    if (!row) throw E(401, "invalid_token", "unknown or removed action token")
    var uid = row.getString("user")
    var who = ""
    var c0 = null
    if (bearerOf(e) || e.auth) {
      try {
        c0 = authenticate(e)
        who = c0.type === "user" ? c0.user.id : c0.agent ? c0.agent.getString("owner") : ""
      } catch (err) { who = "" }
    }
    // An agent never answers as its human (agent key, run token or an
    // agent-scoped `ach open` session): the token stays unused.
    if (c0 && (c0.type !== "user" || c0.scope === "agent")) throw E(403, "human_only", "only the person can answer this; open the panel to reply")
    if (who && who !== uid) throw E(403, "wrong_user", "this action belongs to someone else")
    var replay = function (r) { var prev = parseJSON(r.getString("result")) || { ok: false, result: "used" }; prev.replay = true; return [200, prev] }
    if (row.getString("used_at")) return replay(row)
    if (parseTime(row.getString("expires_at")) <= nowMs()) return [410, { ok: false, result: "expired", error: "this action expired; open the panel to reply" }]
    // single use: claim the token before acting (a parallel tap gets the replay)
    var claimed = app.db().newQuery("UPDATE push_actions SET used_at = {:n} WHERE id = {:id} AND used_at = ''").bind({ n: iso(nowMs()), id: row.id }).execute()
    if (claimed.rowsAffected() !== 1) return replay(app.findRecordById("push_actions", row.id))
    var finish = function (status, res) {
      var r2 = app.findRecordById("push_actions", row.id)
      r2.set("result", res)
      app.save(r2)
      return [status, res]
    }
    var u = null
    try { u = app.findRecordById("users", uid) } catch (err) { u = null }
    if (!u || u.getBool("deactivated")) return finish(200, { ok: false, result: "deactivated", error: "this account is deactivated; nothing was recorded" })
    var kind = row.getString("kind")
    var st = N.decisionState(app, kind === "task" ? { kind: "task", message_id: row.getString("target") } : { kind: "post", post_id: row.getString("target") }, uid)
    if (!st) return finish(200, { ok: false, result: "gone", error: "the request no longer exists" })
    var link = kind === "task" ? (function () { try { return linkUrl("t/" + taskRef(app.findRecordById("tasks", st.task)) + "/m/" + st.target) } catch (err) { return linkUrl("inbox") } })() : linkUrl("p/" + st.target)
    if (!st.addressed) return finish(200, { ok: false, result: "not_addressed", error: "this request is no longer addressed to you", url: link })
    if (!st.open) return finish(200, { ok: false, result: "already_answered", error: "this request was already answered; nothing was recorded", url: link })
    var reply = row.getString("reply")
    var ctx = { type: "user", user: u, scope: "", adminRole: u.getBool("is_admin"), isAdmin: false }
    hiddenChannels(app, ctx)
    var payload = kind === "task" ? { message_id: st.target, decision: reply } : { body: reply }
    var fake = {
      app: app, auth: null,
      request: { pathValue: function (k) { return k === "id" ? (kind === "task" ? st.task : st.target) : "" }, url: e.request.url, header: e.request.header, method: "POST" },
      requestInfo: function () { return { body: payload } },
      findUploadedFiles: function () { throw new Error("no files") },
    }
    var out
    try {
      out = (kind === "task" ? routes.decide : routes.replyPost).fn(fake, ctx)
    } catch (err) {
      if (err && err.achError) {
        var why = err.code === "resolved" ? "already_answered" : err.code === "terminal" ? "closed" : "refused"
        return finish(200, { ok: false, result: why, error: String(err.message), url: link })
      }
      throw err
    }
    var res = { ok: true, result: "recorded", reply: reply, url: link, option: row.getInt("option") }
    if (kind === "task" && out[1] && out[1].message) res.message_id = out[1].message.id
    if (kind === "post" && out[1] && out[1].post) res.post_id = out[1].post.id
    return finish(200, res)
  },
}

// POST /tasks/{id}/note: a human jumps into the thread. Trusted (author_type
// human is set here, never by agents); addressed to the worker, so a parked
// runner resumes on it (inbox notes_for_me). Admins and the owners of either agent.
// POST /tasks/{id}/request-changes {body} + attachments: any
// team user re-engages a completed or failed task. A human note to the
// worker, a system note, and the task goes back to `submitted` (no new
// handoff needed): the worker's runner picks it up like new work.
routes.requestChanges = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = body(e)
    var files = uploads(e)
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      var st = t.getString("status")
      if (st !== "completed" && st !== "failed") throw E(409, "bad_state", "only completed or failed tasks can be reopened (status " + st + ")", { status: st })
      var text = str(b.body)
      if (!text.trim() && !files.length && !hasRefs()) throw E(400, "invalid", "body or attachments required")
      if (text.length > 100000) throw E(400, "invalid", "body is too long")
      var uid = ctx.user.id
      var worker = t.getString("to_agent")
      try {
        var w = app.findRecordById("agents", worker)
        if (!w.getBool("active")) throw E(409, "inactive_agent", "agent '" + w.getString("name") + "' is inactive")
      } catch (err) {
        if (err && err.achError) throw err
      }
      var m = addMsg(app, t, { author_type: "human", author_user: uid, kind: "note", topic: "request_changes", body: text, to_agent: worker })
      attachFiles(app, m, files)
      sysNote(app, t, "changes requested by " + userName(ctx.user) + "; reopened (was " + st + ")", "changes_requested", { name: userName(ctx.user), was: st })
      var now = iso(nowMs())
      t.set("status", "submitted")
      t.set("run_id", "")
      t.set("claim_mode", "")
      t.set("claimed_at", "")
      t.set("parked_at", "")
      t.set("agent_hops", 0)
      t.set("idle_notified_at", "")
      t.set("last_activity", now)
      recomputeWaiting(app, t)
      app.save(t)
      var senderOwner = ownerOf(app, t.getString("from_agent"), t.getString("owner_user"))
      var workerOwner = ownerOf(app, worker, "")
      if (senderOwner && uid !== senderOwner && uid !== workerOwner) notify("changes_requested", t, senderOwner, m)
      if (workerOwner && uid !== workerOwner && workerOwner !== senderOwner) notify("changes_requested", t, workerOwner, m)
      var names = new Names(app)
      return [201, { message: msgOut(m, names), task: taskOut(t, names) }]
    })
  },
}

routes.note = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = body(e)
    var files = uploads(e)
    return tx(e.app, function (app) {
      var t = findTask(app, e.request.pathValue("id"), "task")
      var uid = ctx.user.id
      // Members of the task's channel may leave notes too (never a decision)
      if (!ctx.isAdmin && ownerOf(app, t.getString("from_agent"), "") !== uid && ownerOf(app, t.getString("to_agent"), "") !== uid && t.getString("owner_user") !== uid && !(channelMemberOf(app, t.getString("channel"), uid, true) && !channelHidden(ctx, t.getString("channel")))) {
        throw E(403, "forbidden", "only admins, the task's owners and members of its channel may post notes")
      }
      requireOpen(t)
      var text = str(b.body)
      if (!text.trim() && !files.length && !hasRefs()) throw E(400, "invalid", "body or attachments required")
      if (text.length > 100000) throw E(400, "invalid", "body is too long")
      var m = addMsg(app, t, { author_type: "human", author_user: uid, kind: "note", body: text, to_agent: t.getString("to_agent") })
      attachFiles(app, m, files)
      t.set("last_activity", iso(nowMs()))
      app.save(t)
      var names = new Names(app)
      return [201, { message: msgOut(m, names), task: taskOut(t, names) }]
    })
  },
}

// GET /files/{coll}/{rid}/{name}: download an attachment with ach credentials
// (agent key / run token of the task / user). Users can also use PocketBase's
// /api/files/... with a file token.
routes.file = {
  allow: ["agent", "run", "user"],
  runModes: ["work", "answer", "mention"],
  fn: function (e, ctx) {
    var coll = e.request.pathValue("coll")
    var name = e.request.pathValue("name")
    if (coll !== "messages" && coll !== "handoff_versions" && coll !== "posts") throw E(404, "not_found", "file not found")
    if (!ATTACH_NAME_RE.test(str(name))) throw E(404, "not_found", "file not found")
    var rec = findOr404(e.app, coll, e.request.pathValue("rid"), "file")
    if (coll === "posts") {
      // posts follow channel visibility; a run token only sees its own scope
      requireChannelVisible(ctx, rec.getString("channel"), "file")
      if (ctx.type === "run") requireRunChannel(e.app, ctx, rec.getString("channel"))
    } else {
      if (ctx.type === "run" && ctx.mode === "mention") throw E(403, "forbidden", "mention runs may not read task files")
      var t = findOr404(e.app, "tasks", rec.getString("task"), "file")
      requireParty(ctx, t)
    }
    var names = arr(rec.getStringSlice("attachments"))
    if (names.indexOf(name) < 0) throw E(404, "not_found", "file not found")
    var meta = attOut(coll, rec).filter(function (x) { return x.name === name && !x.ref })[0]
    serveAttachment(e, rec, name, meta)
    return null
  },
}

// Media is served by PocketBase's file server (range requests). Everything
// else (text, code, .html artifacts) is served as text/plain + attachment, so
// it can never render on the hub origin.
function serveAttachment(e, rec, name, meta) {
  // a hook event (onFileDownloadRequest) wraps the request event
  var re = e.requestEvent || e
  var hdr = re.response.header()
  hdr.set("X-Content-Type-Options", "nosniff")
  hdr.set("Content-Security-Policy", "default-src 'none'; sandbox")
  hdr.set("Cache-Control", "private, no-store")
  var fsys = e.app.newFilesystem()
  try {
    var key = rec.baseFilesPath() + "/" + name
    if (meta && isMediaType(meta.type)) {
      fsys.serve(re.response, re.request, key, meta.original || name)
      return
    }
    var r = fsys.getReader(key)
    var bytes
    try {
      bytes = toBytes(r, TEXT_MAX_BYTES + 1024)
    } finally {
      try { r.close() } catch (err) {}
    }
    var fname = str((meta && meta.original) || name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "file.txt"
    hdr.set("Content-Disposition", 'attachment; filename="' + fname + '"')
    e.blob(200, "text/plain; charset=utf-8", bytes)
  } finally {
    fsys.close()
  }
}

routes.inbox = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var app = e.app
    var me = app.findRecordById("agents", ctx.agent.id)
    var nowM = nowMs()
    if (nowM - parseTime(me.getString("last_seen")) > 60000) {
      me.set("last_seen", iso(nowM))
      app.save(me)
    }
    var names = new Names(app)
    // State-based; the old ?since= parameter is gone (C8).
    var floor = iso(nowM - 24 * 3600 * 1000)
    var taskCache = {}
    function taskOf(id) {
      if (!taskCache[id]) taskCache[id] = app.findRecordById("tasks", id)
      return taskCache[id]
    }

    var toMe = find(app, "tasks", "to_agent = {:me} && status = 'submitted'", "priority,created", 1000, { me: me.id })

    var qs = find(app, "messages", "kind = 'question' && resolved = false && to_agent = {:me}", "created", 1000, { me: me.id })
    var questions = []
    qs.forEach(function (q) {
      var t = taskOf(q.getString("task"))
      if (TERMINAL[t.getString("status")]) return
      var active = find(app, "run_tokens", "question = {:q} && mode = 'answer' && revoked = false && expires_at > {:now}", "", 1, {
        q: q.id,
        now: iso(nowM),
      })
      if (active.length) return
      questions.push({ message: msgOut(q, names), task: taskOut(t, names) })
    })

    function replies(kind, extra) {
      var out = []
      var list = find(app, "messages", "kind = {:k} && to_agent = {:me} && created > {:floor}" + (extra || ""), "created", 1000, { k: kind, me: me.id, floor: floor })
      list.forEach(function (m) {
        var t = taskOf(m.getString("task"))
        if (TERMINAL[t.getString("status")]) return
        if (t.getString("to_agent") === me.id) {
          var parked = parseTime(t.getString("parked_at"))
          if (parked && parseTime(m.getString("created")) < parked) return
        }
        out.push({ message: msgOut(m, names), task: taskOut(t, names) })
      })
      return out
    }

    var updates = find(
      app,
      "tasks",
      "from_agent = {:me} && (status = 'submitted' || status = 'working' || status = 'input-required' || updated > {:floor})",
      "-updated",
      1000,
      { me: me.id, floor: floor }
    )

    return [
      200,
      {
        tasks_to_me: toMe.map(function (t) { return taskOut(t, names) }),
        questions_to_me: questions,
        answers_to_me: replies("answer"),
        decisions_for_me: replies("decision"),
        notes_for_me: replies("note", " && author_type = 'human'"),
        mentions_for_me: mentionsForMe(app, me, names),
        updates_on_my_tasks: updates.map(function (t) { return taskOut(t, names) }),
        server_time: iso(nowM),
      },
    ]
  },
}

// Mention runs that escalated to a person and got no human reply since.
function openEscalations(app, ctx, names) {
  var list = find(app, "posts", "escalated = true" + (ctx.isAdmin ? "" : " && to_user = {:u}"), "-created", 100, { u: ctx.user.id })
  var out = []
  list.forEach(function (p) {
    var root = p.getString("parent") || p.id
    var later = find(app, "posts", "(parent = {:r} || id = {:r}) && author_type = 'human' && created > {:c}", "", 1, { r: root, c: p.getString("created") })
    if (later.length) return
    out.push(postOut(app, p, names, false))
  })
  return out
}

routes.panel = {
  allow: ["user"],
  fn: function (e, ctx) {
    var app = e.app
    var names = new Names(app)
    var uid = ctx.user.id
    var scope = ctx.isAdmin ? "" : "(owner_user = {:u} || to_agent.owner = {:u} || from_agent.owner = {:u}) && "
    var nowM = nowMs()
    var weekAgo = iso(nowM - 7 * 24 * 3600 * 1000)

    var drFilter = "kind = 'decision_request' && resolved = false && delegated_grant = ''" + (ctx.isAdmin ? "" : " && (to_user = {:u} || also_to ~ {:u})")
    var drs = find(app, "messages", drFilter, "-created", 1000, { u: uid })
    var needs = drs.map(function (m) {
      return { message: msgOut(m, names), task: taskOut(app.findRecordById("tasks", m.getString("task")), names) }
    })

    var running = find(app, "tasks", scope + "(status = 'submitted' || status = 'working' || status = 'input-required')", "priority,-last_activity", 1000, { u: uid })

    var myAgents = {}
    find(app, "agents", "owner = {:u}", "", 1000, { u: uid }).forEach(function (a) {
      myAgents["agent:" + a.id] = true
    })
    var waiting = running.filter(function (t) {
      var w = t.getString("waiting_on")
      var waitingElsewhere = w && !myAgents[w] && w !== "human:" + uid
      var deps = arr(t.getStringSlice("depends_on"))
      var depOpen = deps.some(function (d) {
        try {
          return app.findRecordById("tasks", d).getString("status") !== "completed"
        } catch (err) {
          return false
        }
      })
      return waitingElsewhere || depOpen
    })

    var done = find(app, "tasks", scope + "(status = 'completed' || status = 'failed' || status = 'canceled') && updated > {:w}", "-updated", 100, { u: uid, w: weekAgo })

    // C8: cost_week = usage rows posted in the last 7 days (rolling).
    var uscope = ctx.isAdmin ? "" : "(task.owner_user = {:u} || task.to_agent.owner = {:u} || task.from_agent.owner = {:u} || (task = '' && agent.owner = {:u})) && "
    var rows = find(app, "usage", uscope + "created > {:w}", "", 100000, { u: uid, w: weekAgo })
    var cost = 0
    var est = false
    rows.forEach(function (r) {
      cost += r.getFloat("cost_usd")
      if (r.getBool("estimated") && r.getFloat("cost_usd") > 0) est = true
    })

    return [
      200,
      {
        needs_decision: needs,
        escalations: openEscalations(app, ctx, names),
        running: running.map(function (t) { return taskOut(t, names) }),
        waiting_on_others: waiting.map(function (t) { return taskOut(t, names) }),
        recent_done: done.map(function (t) { return taskOut(t, names) }),
        cost_week: Math.round(cost * 1e6) / 1e6,
        cost_week_estimated: est,
        server_time: iso(nowM),
      },
    ]
  },
}

function newAgentKey(agentId) {
  return "ach_sk_" + agentId + "_" + genKeySecret(32)
}

function setKey(a, key) {
  a.set("key_hash", sha(key))
  a.set("key_prefix", key.slice(0, 12))
  a.set("key_unused", true)
}

routes.adminCreateAgent = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = body(e)
    return tx(e.app, function (app) {
      var name = str(b.name).trim()
      if (!NAME_RE.test(name)) throw E(400, "invalid_name", "name must match ^[a-z0-9][a-z0-9-]{1,40}$")
      if (ID_LIKE_RE.test(name)) throw E(400, "invalid_name", "name must not look like a record id (15 lowercase letters/digits); add a hyphen")
      var owner = resolveUser(app, str(b.owner).trim() || ctx.user.id)
      if (!ctx.isAdmin && owner !== ctx.user.id) throw adminDenied(ctx, "non-admins may only create agents for themselves")
      if (app.findRecordById("users", owner).getBool("deactivated")) throw E(409, "owner_deactivated", "the owner is deactivated; reactivate them or pick another owner")
      var perm = str(b.perm_level || "workdir")
      if (["read", "workdir", "full"].indexOf(perm) < 0) throw E(400, "invalid", "perm_level must be read|workdir|full")
      if (perm === "full" && !ctx.isAdmin) throw adminDenied(ctx, "only admins may set perm_level=full")
      var runtime = str(b.runtime || "other")
      if (["claude", "codex", "other"].indexOf(runtime) < 0) throw E(400, "invalid", "runtime must be claude|codex|other")
      var budget = b.budget_usd === undefined || b.budget_usd === null ? 0 : Number(b.budget_usd)
      if (isNaN(budget) || budget < 0) throw E(400, "invalid", "budget_usd must be >= 0")
      if (budget !== 0 && !ctx.isAdmin) throw adminDenied(ctx, "only admins may set budgets")
      var exists = find(app, "agents", "name = {:n}", "", 1, { n: name })
      if (exists.length) throw E(409, "conflict", "agent name already taken")
      var a = new Record(app.findCollectionByNameOrId("agents"))
      var id = $security.randomStringWithAlphabet(15, IDCHARS)
      a.set("id", id)
      a.set("name", name)
      a.set("owner", owner)
      a.set("runtime", runtime)
      a.set("description", str(b.description))
      a.set("perm_level", perm)
      a.set("budget_usd", budget)
      a.set("spent_usd", 0)
      a.set("active", true)
      var af0 = parseAcceptFrom(b.accept_from)
      a.set("accept_from", af0)
      // B8: an admin creating an agent for someone else locks accept_from
      a.set("accept_from_admin", !!ctx.isAdmin && af0.length > 0 && owner !== ctx.user.id)
      a.set("net_allow", parseNetAllow(b.net_allow, ctx.isAdmin))
      if (b.quiet === true) a.set("quiet", true)
      var key = newAgentKey(id)
      setKey(a, key)
      app.save(a)
      return [201, inviteOut(e, app, ctx, a, key, b)]
    })
  },
}

// P4: an owner may be given as a user id or an email address.
function resolveUser(app, ref) {
  if (ref.indexOf("@") > 0) {
    try {
      return app.findAuthRecordByEmail("users", ref).id
    } catch (err) {
      throw E(404, "not_found", "no user with email " + ref)
    }
  }
  return findOr404(app, "users", ref, "owner").id
}

function adminAgentAccess(app, ctx, id) {
  var a = findOr404(app, "agents", id, "agent")
  if (!ctx.isAdmin && a.getString("owner") !== ctx.user.id) throw adminDenied(ctx, "admin or owner only")
  return a
}

routes.adminRotateKey = {
  allow: ["user"],
  fn: function (e, ctx) {
    return tx(e.app, function (app) {
      var a = adminAgentAccess(app, ctx, e.request.pathValue("id"))
      var key = newAgentKey(a.id)
      setKey(a, key)
      app.save(a)
      revokeTokens(app, "agent = {:a}", { a: a.id })
      app.db().newQuery("DELETE FROM agent_joins WHERE agent = {:a}").bind({ a: a.id }).execute()
      return [200, inviteOut(e, app, ctx, a, key, body(e))]
    })
  },
}

routes.adminPatchAgent = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = body(e)
    return tx(e.app, function (app) {
      var a = adminAgentAccess(app, ctx, e.request.pathValue("id"))
      ;["name", "spent_usd", "key_hash", "key_prefix", "disabled_by_admin", "accept_from_admin"].forEach(function (f) {
        if (b[f] !== undefined) throw E(400, "invalid", "field '" + f + "' cannot be changed here")
      })
      if (b.active !== undefined) {
        if (typeof b.active !== "boolean") throw E(400, "invalid", "active must be boolean")
        if (b.active) {
          // B8: an owner cannot re-enable an agent an admin disabled.
          if (a.getBool("disabled_by_admin") && !ctx.isAdmin) throw E(403, "admin_locked", "an admin disabled this agent; ask an admin to enable it")
          if (ownerDeactivated(app, a)) throw E(409, "owner_deactivated", "the agent's owner is deactivated; reassign the agent first")
          a.set("disabled_by_admin", false)
        } else {
          a.set("disabled_by_admin", !!ctx.isAdmin)
          revokeTokens(app, "agent = {:a}", { a: a.id })
        }
        a.set("active", b.active)
      }
      if (b.perm_level !== undefined) {
        var perm = str(b.perm_level)
        if (["read", "workdir", "full"].indexOf(perm) < 0) throw E(400, "invalid", "perm_level must be read|workdir|full")
        if (perm === "full" && !ctx.isAdmin) throw adminDenied(ctx, "only admins may set perm_level=full")
        a.set("perm_level", perm)
      }
      if (b.budget_usd !== undefined) {
        if (!ctx.isAdmin) throw adminDenied(ctx, "only admins may change budgets")
        var budget = Number(b.budget_usd)
        if (typeof b.budget_usd !== "number" || isNaN(budget) || budget < 0) throw E(400, "invalid", "budget_usd must be >= 0")
        a.set("budget_usd", budget)
      }
      if (b.description !== undefined) a.set("description", str(b.description))
      if (b.accept_from !== undefined) {
        // B8: an accept_from list an admin set is admin-locked (an admin setting [] unlocks it).
        if (a.getBool("accept_from_admin") && !ctx.isAdmin) throw E(403, "admin_locked", "an admin set who may send this agent work; ask an admin to change it")
        var af = parseAcceptFrom(b.accept_from)
        a.set("accept_from", af)
        if (ctx.isAdmin) a.set("accept_from_admin", af.length > 0)
      }
      if (b.net_allow !== undefined) a.set("net_allow", parseNetAllow(b.net_allow, ctx.isAdmin))
      if (b.quiet !== undefined) {
        // C: quiet agents (data bots) are collapsed in the panel and left out of exclude_bots searches.
        if (typeof b.quiet !== "boolean") throw E(400, "invalid", "quiet must be boolean")
        a.set("quiet", b.quiet)
      }
      if (b.owner !== undefined) {
        // B6: reassignment (admin-only) to an active person.
        if (!ctx.isAdmin) throw adminDenied(ctx, "only admins may reassign agents")
        var nu = userByRef(app, str(b.owner))
        if (nu.getBool("deactivated")) throw E(409, "owner_deactivated", "the new owner is deactivated")
        // the old key is burned; the response carries the new owner's key (shown once)
        if (reassignAgent(app, a, nu.id)) {
          var newKey = newAgentKey(a.id)
          setKey(a, newKey)
        }
      }
      app.save(a)
      var aout = agentOut(a, new Names(app))
      if (newKey) aout.key = newKey
      return [200, aout]
    })
  },
}

function ownerDeactivated(app, a) {
  try {
    return app.findRecordById("users", a.getString("owner")).getBool("deactivated")
  } catch (err) {
    return true
  }
}

// B6: a new owner for an agent; open tasks it sent follow (owner_user gets the notifications).
// A new owner burns every credential the old owner held for the agent: the
// key, its run tokens and unused invites (security review: a leaver's key
// kept working). The new owner installs a fresh key. Returns true if it moved.
function reassignAgent(app, a, ownerId) {
  if (a.getString("owner") === ownerId) return false
  a.set("owner", ownerId)
  a.set("key_hash", "")
  a.set("key_prefix", "")
  revokeTokens(app, "agent = {:a}", { a: a.id })
  app.db().newQuery("DELETE FROM agent_joins WHERE agent = {:a}").bind({ a: a.id }).execute()
  find(app, "tasks", "from_agent = {:a} && (status = 'submitted' || status = 'working' || status = 'input-required')", "", 10000, { a: a.id }).forEach(function (t) {
    t.set("owner_user", ownerId)
    app.save(t)
  })
  return true
}

// ---------------------------------------------------------------- human login
// Humans never have passwords or agent keys. They log in by:
// - Cloudflare Access: POST /auth/cf verifies Cf-Access-Jwt-Assertion (RS256,
//   see ach_jwt.js) and maps its email to an active user;
// - a one-time login link (/#/login/<token>, exchanged by POST /auth/link):
//   an admin's invite (24h), an admin's re-login link (24h) or `ach open`
//   (60s, minted with the owner's agent key);
// - PocketBase email OTP (needs SMTP).
// Login tokens are "ach_lt_" + 40 base62, stored as SHA-256 only, single use.

var LOGIN_TOKEN_RE = /^ach_lt_[A-Za-z0-9]{40}$/
var LOGIN_TTL_MS = { invite: 24 * 3600 * 1000, login: 24 * 3600 * 1000, open: 60 * 1000, device: 5 * 60 * 1000 }
var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
var JWKS_TTL_MS = 3600 * 1000
var JWKS_MIN_REFETCH_MS = 10 * 1000
var JWKS_STORE_KEY = "ach_cf_jwks"

function jwtLib() {
  return require(__hooks + "/ach_jwt.js")
}

function configuredPublicUrl() {
  return str($os.getenv("ACH_PUBLIC_URL")).trim().replace(/\/+$/, "")
}

var LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:[0-9]+)?$/i

// Base URL people open (links, invites). B5: ACH_PUBLIC_URL is required in
// production; without it the hub only trusts a localhost Origin/host (a
// forged Origin must never end up in a login link someone else clicks).
function publicBase(e) {
  var base = configuredPublicUrl()
  if (base) return base
  var origin = str(e.request.header.get("Origin")).trim()
  var m = /^(https?):\/\/([A-Za-z0-9.:\[\]-]+)$/.exec(origin)
  if (m && LOCAL_HOST_RE.test(m[2])) return origin
  var host = str(e.request.host)
  if (!origin && LOCAL_HOST_RE.test(host)) return "http://" + host
  throw E(409, "public_url_required", "set ACH_PUBLIC_URL on the hub before creating links (only localhost works without it)")
}

// The `ach join` blob (same format as packages/agentchannel/src/invite.ts):
// "ach1." + base64url(JSON {hub, key, cf_id?, cf_secret?}). The Cloudflare
// service token comes from ACH_INVITE_CF_ID / ACH_INVITE_CF_SECRET when set.
// The blob carries a long-lived agent key: revoking it means rotate-key, and a
// blob pasted into an LLM chat stays in that transcript. Prefer `invite_once`.
// withCf false leaves the shared Cloudflare service token out.
function inviteBlob(e, key, withCf) {
  var j = jwtLib()
  var o = { hub: publicBase(e), key: key }
  addCf(o, withCf)
  return "ach1." + j.b64urlEncode(j.utf8Encode(JSON.stringify(o)))
}
function addCf(o, withCf) {
  var id = str($os.getenv("ACH_INVITE_CF_ID")).trim()
  var secret = str($os.getenv("ACH_INVITE_CF_SECRET")).trim()
  if (withCf !== false && id && secret) {
    o.cf_id = id
    o.cf_secret = secret
  }
}

// One-time invite (see API.md "Invite exchange"): "ach2." + base64url(JSON
// {hub, join, cf_id?, cf_secret?}). `join` ("ach_jt_<agentId>_<40 base62>") is
// stored hashed, works once, expires after ACH_JOIN_TTL_H hours (default 24),
// and is exchanged for a fresh agent key by POST /invite/exchange. Safe to paste
// into an agent chat: once used (or expired) the line is worthless.
var JOIN_RE = /^ach_jt_([a-z0-9]{15})_[A-Za-z0-9]{40}$/
function joinTtlMs() {
  var h = parseFloat(str($os.getenv("ACH_JOIN_TTL_H")))
  return (h > 0 ? h : 24) * 3600 * 1000
}
function mintJoin(app, a, uid) {
  var tok = "ach_jt_" + a.id + "_" + $security.randomStringWithAlphabet(40, BASE62)
  var r = new Record(app.findCollectionByNameOrId("agent_joins"))
  r.set("token_hash", sha(tok))
  r.set("agent", a.id)
  if (uid) r.set("created_by", uid)
  r.set("expires_at", iso(nowMs() + joinTtlMs()))
  app.save(r)
  return tok
}
function joinBlob(e, tok, withCf) {
  var j = jwtLib()
  var o = { hub: publicBase(e), join: tok }
  addCf(o, withCf)
  return "ach2." + j.b64urlEncode(j.utf8Encode(JSON.stringify(o)))
}
function inviteCfAvailable() {
  return !!str($os.getenv("ACH_INVITE_CF_ID")).trim() && !!str($os.getenv("ACH_INVITE_CF_SECRET")).trim()
}
/**
 * Create/rotate response: the key (shown once) and the one-time invite.
 * the shared Cloudflare service token is opt-in per agent (b.cf_token === true);
 * the legacy key-carrying "ach1." invite only with ACH_LEGACY_INVITE=1.
 */
function inviteOut(e, app, ctx, a, key, b) {
  var withCf = !!(b && b.cf_token === true)
  var tok = mintJoin(app, a, ctx.user ? ctx.user.id : "")
  var out = {
    agent: agentOut(a, new Names(app)), key: key,
    invite_once: joinBlob(e, tok, withCf), invite_once_expires_at: iso(nowMs() + joinTtlMs()),
    cf_token_included: withCf && inviteCfAvailable(),
  }
  if (str($os.getenv("ACH_LEGACY_INVITE")).trim() === "1") out.invite = inviteBlob(e, key, withCf)
  return out
}

// POST /invite/exchange {join}: the one-time join token -> a fresh agent key
// (the agent's older key and run tokens stop working; other unused join tokens
// of the agent are burned). 401 unknown, 410 used/expired, 409 inactive agent,
// 403 deactivated owner.
routes.inviteExchange = {
  allow: ["public"],
  fn: function (e) {
    var b = body(e)
    var tok = str(b.join || b.token).trim()
    var m = JOIN_RE.exec(tok)
    return tx(e.app, function (app) {
      var r = m ? find(app, "agent_joins", "token_hash = {:h}", "", 1, { h: sha(tok) })[0] : null
      if (!r || r.getString("agent") !== m[1]) throw E(401, "invalid_join", "unknown join token: ask for a new invite")
      if (r.getString("used_at")) throw E(410, "join_used", "This invite was already used — if it wasn't you, tell your admin now")
      if (parseTime(r.getString("expires_at")) <= nowMs()) throw E(410, "join_expired", "this invite expired: ask for a new one (ach admin invite <agent>)")
      var a = app.findRecordById("agents", r.getString("agent"))
      if (!a.getBool("active")) throw E(409, "inactive_agent", "agent '" + a.getString("name") + "' is inactive")
      var owner = app.findRecordById("users", a.getString("owner"))
      if (owner.getBool("deactivated")) throw E(403, "deactivated", "the agent's owner is deactivated")
      var at = iso(nowMs())
      var ip = clientIp(e)
      var ua = str(e.request.header.get("User-Agent")).slice(0, 300)
      r.set("used_at", at)
      r.set("ip", ip)
      r.set("user_agent", ua)
      app.save(r)
      app.db().newQuery("DELETE FROM agent_joins WHERE agent = {:a} AND used_at = ''").bind({ a: a.id }).execute()
      var key = newAgentKey(a.id)
      setKey(a, key)
      app.save(a)
      revokeTokens(app, "agent = {:a}", { a: a.id })
      notifyAgentJoined(app, a, owner, r, at, ip)
      return [200, { hub: publicBase(e), key: key, agent: agentOut(a, new Names(app)) }]
    })
  },
}

// The client IP for audit lines: PocketBase's realIP (honours the trusted
// proxy headers configured in its settings), else the remote address.
function clientIp(e) {
  try { var ip = str(e.realIP()); if (ip) return ip.slice(0, 100) } catch (err) {}
  try { return str(e.remoteIP()).slice(0, 100) } catch (err) {}
  return ""
}

// Every invite exchange tells the agent's owner and every admin
// (Inbox Updates + their personal hooks) when and from where it happened, so a
// stolen invite line is noticed at once.
function notifyAgentJoined(app, a, owner, join, at, ip) {
  var reasons = {}
  reasons[owner.id] = "agent_joined"
  find(app, "users", "is_admin = true && deactivated = false", "", 1000, {}).forEach(function (u) { reasons[u.id] = "agent_joined" })
  try {
    require(__hooks + "/ach_notify.js").emit(app, {
      key: "agent_joined:" + join.id, event: "agent_joined", channel: "",
      title: a.getString("name") + " (" + (owner.getString("name") || owner.getString("email")) + ")",
      detail: at.replace(" ", "T").replace(/\.\d+Z$/, "Z") + (ip ? " · IP " + ip : ""),
      path: "agents", target_kind: "agent", target_id: a.id,
      reasons: reasons, noBroadcast: true, important: true,
    })
  } catch (err) {
    app.logger().warn("agent_joined notification failed", "error", String(err))
  }
}

function userAdminOut(u, agentCount) {
  return {
    id: u.id,
    name: u.getString("name"),
    email: u.getString("email"),
    is_admin: u.getBool("is_admin"),
    deactivated: u.getBool("deactivated"),
    agents: agentCount === undefined ? undefined : agentCount,
    created: u.getString("created"),
  }
}

// Invalidate a user's unused login links (all kinds, or just invite/login).
function burnLoginTokens(app, userId, kinds) {
  var list = find(app, "login_tokens", "user = {:u} && used_at = ''", "", 1000, { u: userId })
  list.forEach(function (lt) {
    if (kinds && kinds.indexOf(lt.getString("kind")) < 0) return
    lt.set("used_at", iso(nowMs()))
    app.save(lt)
  })
}

function mintLoginToken(app, userId, kind, createdBy, scope, ttlMs) {
  // A new invite/login link replaces the person's older unused ones.
  if (kind === "invite" || kind === "login") burnLoginTokens(app, userId, ["invite", "login"])
  var tok = "ach_lt_" + genKeySecret(40)
  var rec = new Record(app.findCollectionByNameOrId("login_tokens"))
  var exp = iso(nowMs() + (ttlMs || LOGIN_TTL_MS[kind]))
  rec.set("token_hash", sha(tok))
  rec.set("user", userId)
  rec.set("kind", kind)
  rec.set("expires_at", exp)
  rec.set("created_by", createdBy)
  rec.set("scope", scope || "")
  app.save(rec)
  return { token: tok, expires_at: exp }
}

function linkOut(e, minted) {
  var path = "/#/login/" + minted.token
  return { token: minted.token, path: path, url: publicBase(e) + path, expires_at: minted.expires_at }
}

function newHumanRecord(app, name, email, isAdmin) {
  var u = new Record(app.findCollectionByNameOrId("users"))
  if (email) u.setEmail(email)
  // PocketBase requires a password; this one is random and never shown, so
  // nobody can use password login for this person.
  u.setPassword(genKeySecret(48))
  u.setVerified(true)
  u.set("name", name)
  u.set("is_admin", !!isAdmin)
  u.set("deactivated", false)
  return u
}

// Write the standard PocketBase auth response ({token, record}) for user.
// scope "agent" (B1): the session was minted from an agent key; the
// onRecordAuthRequest hook (scopeAuth) swaps in a token carrying ach_scope.
function authResponse(e, user, scope) {
  $apis.recordAuthResponse(e, user, "", scope ? { ach_scope: scope } : null)
  return null
}

// A PocketBase users auth token with the extra ach_scope claim. Signed exactly
// like PocketBase's own (record tokenKey + collection secret), so PocketBase
// validates it; PocketBase ignores the extra claim, the ach routes read it.
function scopedToken(user, scope) {
  var coll = user.collection()
  var payload = { id: user.id, type: "auth", collectionId: coll.id, refreshable: true, ach_scope: scope }
  return $security.createJWT(payload, user.tokenKey() + coll.authToken.secret, coll.authToken.duration)
}

// onRecordAuthRequest (users): keep the "agent" scope on the session, also
// across auth-refresh (a refresh must never upgrade an agent-minted session).
function scopeAuth(e) {
  var scope = ""
  try {
    if (e.meta && e.meta.ach_scope) scope = str(e.meta.ach_scope)
  } catch (err) {}
  var re = e.requestEvent || e
  var path = ""
  try { path = str(re.request.url.path) } catch (err) {}
  if (!scope && /\/auth-refresh$/.test(path)) scope = tokenScope(bearerOf(re))
  if (scope !== "agent") return
  e.token = scopedToken(e.record, scope)
  e.meta = { ach_scope: scope }
}

// Login-link kinds as the panel sees them (B: link errors carry `kind`).
function linkKindOut(k) {
  return k === "login" ? "relogin" : k
}

routes.authConfig = {
  allow: ["public"],
  fn: function (e) {
    var otp = false
    var smtp = false
    try {
      smtp = !!e.app.settings().smtp.enabled
      otp = smtp && !!e.app.findCollectionByNameOrId("users").otp.enabled
    } catch (err) {}
    // Which delivery adapters the panel offers (email needs SMTP; the
    // Feishu button needs a Feishu/Lark bot configured on the hub)
    var hook = str($os.getenv("ACH_NOTIFY_WEBHOOK")).trim()
    var feishu = str($os.getenv("ACH_NOTIFY_FORMAT")).trim() === "feishu" || /^https:\/\/open\.(feishu\.cn|larksuite\.com)\//.test(hook)
    // feishu_bot = the Feishu adapter is ready (the login page says "say \"login\" to the bot in Feishu"); default_lang for a first visit
    var bot = false
    try { bot = !!require(__hooks + "/ach_feishu.js").cfg(e.app).ready } catch (err) {}
    return [200, { cf: cfConfig() !== null, otp: otp, smtp: smtp, feishu: !!hook && feishu, feishu_bot: bot, default_lang: defaultLang() }]
  },
}

// POST /auth/link {token}: exchange a one-time login link for a session.
// Errors carry `kind` (open|invite|relogin|device) so the panel can advise:
// 401 invalid_link (unknown), link_used, link_expired; 403 deactivated.
routes.authLink = {
  allow: ["public"],
  fn: function (e) {
    var b = body(e)
    var tok = str(b.token).trim()
    var bad = E(401, "invalid_link", "this login link is not valid; ask for a new one")
    if (!LOGIN_TOKEN_RE.test(tok)) throw bad
    var h = sha(tok)
    var got = tx(e.app, function (app) {
      var lt
      try {
        lt = app.findFirstRecordByData("login_tokens", "token_hash", h)
      } catch (err) {
        throw bad
      }
      if (!$security.equal(lt.getString("token_hash"), h)) throw bad
      var kind = linkKindOut(lt.getString("kind"))
      if (lt.getString("used_at")) throw E(401, "link_used", "this login link was already used", { kind: kind })
      if (parseTime(lt.getString("expires_at")) <= nowMs()) throw E(401, "link_expired", "this login link has expired", { kind: kind })
      lt.set("used_at", iso(nowMs()))
      app.save(lt)
      var scope = lt.getString("kind") === "open" ? "agent" : lt.getString("scope") === "agent" ? "agent" : ""
      return { user: lt.getString("user"), kind: kind, scope: scope }
    })
    var u
    try {
      u = e.app.findRecordById("users", got.user)
    } catch (err) {
      throw bad
    }
    if (u.getBool("deactivated")) throw E(403, "deactivated", "this account is deactivated", { kind: got.kind })
    return authResponse(e, u, got.scope)
  },
}

// POST /auth/link/peek {token}: whose link is this? {kind, user: {id, name},
// expires_at}, without using it (the panel asks "Log in as <name>?" before an
// exchange for another identity). Same errors as /auth/link.
routes.authLinkPeek = {
  allow: ["public"],
  fn: function (e) {
    var tok = str(body(e).token).trim()
    var bad = E(401, "invalid_link", "this login link is not valid; ask for a new one")
    if (!LOGIN_TOKEN_RE.test(tok)) throw bad
    var lt
    try { lt = e.app.findFirstRecordByData("login_tokens", "token_hash", sha(tok)) } catch (err) { throw bad }
    var kind = linkKindOut(lt.getString("kind"))
    if (lt.getString("used_at")) throw E(401, "link_used", "this login link was already used", { kind: kind })
    if (parseTime(lt.getString("expires_at")) <= nowMs()) throw E(401, "link_expired", "this login link has expired", { kind: kind })
    var u
    try { u = e.app.findRecordById("users", lt.getString("user")) } catch (err) { throw bad }
    if (u.getBool("deactivated")) throw E(403, "deactivated", "this account is deactivated", { kind: kind })
    return [200, { kind: kind, user: { id: u.id, name: u.getString("name") || u.getString("email").split("@")[0] }, expires_at: lt.getString("expires_at") }]
  },
}

// POST /login-link: `ach open`. The agent key (never a run token) mints a
// 60-second single-use login link for the agent's owner. The session it opens
// is agent-scoped (B1): never admin, whatever the owner's role.
routes.loginLink = {
  allow: ["agent"],
  fn: function (e, ctx) {
    return tx(e.app, function (app) {
      var owner
      try {
        owner = app.findRecordById("users", ctx.agent.getString("owner"))
      } catch (err) {
        throw E(404, "not_found", "the agent's owner no longer exists")
      }
      if (owner.getBool("deactivated")) throw E(403, "deactivated", "the agent's owner is deactivated")
      return [201, linkOut(e, mintLoginToken(app, owner.id, "open", "agent:" + ctx.agent.id, "agent"))]
    })
  },
}

// POST /auth/device-link: a 5-minute single-use link for yourself (QR code:
// log in on another device). It keeps the current session's scope, so an
// agent-minted session can never turn itself into a full one.
// {purpose: "cli"}: a 15-minute link for the admin's own CLI (the
// panel's "one paste" import command); full admin sessions only.
routes.deviceLink = {
  allow: ["user"],
  fn: function (e, ctx) {
    var cli = str(body(e).purpose) === "cli"
    if (cli) requireAdmin(ctx)
    return tx(e.app, function (app) {
      var minted = mintLoginToken(app, ctx.user.id, "device", (cli ? "cli:" : "user:") + ctx.user.id, ctx.scope === "agent" ? "agent" : "", cli ? 15 * 60 * 1000 : 0)
      var out = linkOut(e, minted)
      return [201, { url: out.url, path: out.path, expires_at: out.expires_at, scope: ctx.scope === "agent" ? "agent" : "full" }]
    })
  },
}

// POST /auth/logout {everywhere?}: everywhere rotates the tokenKey (every
// session of this person dies, including agent-minted ones). A single session
// is a stateless JWT: the panel forgets it. cf_logout_url when Access is on.
routes.logout = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = body(e)
    var everywhere = b.everywhere === true
    if (everywhere) {
      tx(e.app, function (app) {
        var u = app.findRecordById("users", ctx.user.id)
        u.refreshTokenKey()
        app.save(u)
      })
    }
    var out = { ok: true, everywhere: everywhere }
    if (cfConfig()) {
      var base = configuredPublicUrl()
      out.cf_logout_url = (base || "") + "/cdn-cgi/access/logout"
    }
    return [200, out]
  },
}

// ---- PocketBase auth hooks (B2, B3, B10)

// B3: password auth only for people a superuser flagged (users.password_login,
// the bootstrap admin). Everyone else gets PocketBase's generic failure.
function passwordAuthHook(e) {
  if (e.record && !e.record.getBool("password_login")) throw new BadRequestError("Failed to authenticate.")
  e.next()
}

// B3: nobody resets a password through email (people have no passwords).
function passwordResetHook(e) {
  ;(e.requestEvent || e).json(403, { error: "password reset is disabled; ask an admin for a login link", code: "password_reset_disabled" })
}

var OTP_EMAIL_MAX = 5
var OTP_EMAIL_WINDOW_MS = 10 * 60 * 1000

// B2 + B10: request-otp is limited per email (PocketBase limits per IP), and a
// deactivated person gets the same generic answer as an unknown email: an
// otpId that leads nowhere, and no mail.
function requestOtpHook(e) {
  var email = ""
  try {
    email = str((e.requestEvent || e).requestInfo().body.email).trim().toLowerCase()
  } catch (err) {}
  if (email) {
    var key = "ach_otp_rl:" + email
    var now = nowMs()
    var list = parseJSON(e.app.store().get(key)) || []
    list = list.filter(function (t) { return now - t < OTP_EMAIL_WINDOW_MS })
    if (list.length >= OTP_EMAIL_MAX) {
      ;(e.requestEvent || e).json(429, { error: "too many codes requested for this email; wait a few minutes", code: "rate_limited" })
      return
    }
    list.push(now)
    e.app.store().set(key, JSON.stringify(list))
  }
  if (e.record && e.record.getBool("deactivated")) {
    ;(e.requestEvent || e).json(200, { otpId: $security.randomStringWithAlphabet(15, IDCHARS) })
    return
  }
  e.next()
}

// ---- Cloudflare Access

function cfConfig() {
  var team = str($os.getenv("ACH_CF_TEAM_DOMAIN")).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "")
  var aud = str($os.getenv("ACH_CF_AUD")).trim()
  if (!team || !aud) return null
  if (team.indexOf(".") < 0) team = team + ".cloudflareaccess.com"
  var certs = str($os.getenv("ACH_CF_CERTS_URL")).trim() || "https://" + team + "/cdn-cgi/access/certs"
  return { iss: "https://" + team, aud: aud, certs: certs }
}

function fetchJwks(app, cfg, force) {
  var store = app.store()
  var cached = null
  try {
    cached = JSON.parse(store.get(JWKS_STORE_KEY) || "null")
  } catch (err) {}
  var now = nowMs()
  if (cached && cached.url === cfg.certs) {
    var age = now - cached.at
    if (!force && age < JWKS_TTL_MS) return cached.keys
    // an unknown kid may refetch, but at most once per JWKS_MIN_REFETCH_MS
    if (force && now - (cached.forced || 0) < JWKS_MIN_REFETCH_MS) return cached.keys
  }
  var res = $http.send({ url: cfg.certs, method: "GET", timeout: 10 })
  if (res.statusCode !== 200 || !res.json || !res.json.keys) throw E(502, "cf_certs", "could not fetch the Cloudflare Access certificates")
  var keys = []
  for (var i = 0; i < res.json.keys.length; i++) {
    var k = res.json.keys[i]
    keys.push({ kid: str(k.kid), kty: str(k.kty), alg: str(k.alg), use: str(k.use), n: str(k.n), e: str(k.e) })
  }
  store.set(JWKS_STORE_KEY, JSON.stringify({ url: cfg.certs, at: now, forced: force ? now : (cached && cached.forced) || 0, keys: keys }))
  return keys
}

function verifyCfJwt(app, cfg, token) {
  var j = jwtLib()
  var opts = { aud: cfg.aud, iss: cfg.iss, nowMs: nowMs(), keys: fetchJwks(app, cfg, false) }
  try {
    return j.verifyJWT(token, opts, sha)
  } catch (err) {
    if (String(err.message) !== "unknown key") throw err
  }
  opts.keys = fetchJwks(app, cfg, true) // key rotation: refetch once
  return j.verifyJWT(token, opts, sha)
}

/** The verified Cloudflare Access email of this request, or "" (no Access, no header, bad token). */
function cfIdentity(e) {
  var cfg = cfConfig()
  if (!cfg) return ""
  var token = str(e.request.header.get("Cf-Access-Jwt-Assertion")).trim()
  if (!token) return ""
  try {
    var email = str(verifyCfJwt(e.app, cfg, token).email).trim().toLowerCase()
    return EMAIL_RE.test(email) ? email : ""
  } catch (err) {
    return ""
  }
}

// POST /auth/cf: trust Cloudflare Access (header set by Cloudflare on every
// request that passed the Access policy). Never trusted unverified.
routes.authCf = {
  allow: ["public"],
  fn: function (e) {
    var cfg = cfConfig()
    if (!cfg) throw E(404, "not_configured", "Cloudflare Access login is not configured")
    var token = str(e.request.header.get("Cf-Access-Jwt-Assertion")).trim()
    if (!token) throw E(401, "unauthorized", "no Cloudflare Access token")
    var claims
    try {
      claims = verifyCfJwt(e.app, cfg, token)
    } catch (err) {
      if (err && err.achError) throw err
      throw E(401, "unauthorized", "Cloudflare Access token rejected: " + String((err && err.message) || err))
    }
    var email = str(claims.email).trim().toLowerCase()
    if (!email || !EMAIL_RE.test(email)) throw E(401, "unauthorized", "the Access token has no email (service tokens cannot open the panel)")
    var u = null
    try {
      u = e.app.findAuthRecordByEmail("users", email)
    } catch (err) {}
    if (!u) {
      if ($os.getenv("ACH_CF_AUTOCREATE") !== "1") throw E(403, "not_invited", "You are signed in as " + email + ", but this hub has no account for that email. Ask your admin to invite " + email + ".", { email: email })
      u = tx(e.app, function (app) {
        var nu = newHumanRecord(app, email.split("@")[0], email, false)
        app.save(nu)
        return nu
      })
    }
    if (u.getBool("deactivated")) throw E(403, "deactivated", "this account is deactivated")
    return authResponse(e, u)
  },
}

// ---- people admin

function requireAdmin(ctx) {
  if (ctx.isAdmin) return
  throw adminDenied(ctx, "admin only")
}

// B1: an admin acting through an agent-minted session (`ach open`) gets
// needs_admin_login: log in with a device link from a real admin session.
function adminDenied(ctx, msg) {
  if (ctx && ctx.adminRole && ctx.scope === "agent") {
    return E(403, "needs_admin_login", "this session was opened from an agent key and cannot use admin actions; log in with a device link or login link")
  }
  return E(403, "forbidden", msg)
}

function userByRef(app, ref) {
  ref = str(ref).trim()
  if (ref.indexOf("@") > 0) {
    try {
      return app.findAuthRecordByEmail("users", ref.toLowerCase())
    } catch (err) {
      throw E(404, "not_found", "no user with email " + ref)
    }
  }
  return findOr404(app, "users", ref, "user")
}

routes.adminListUsers = {
  allow: ["user"],
  fn: function (e, ctx) {
    requireAdmin(ctx)
    var counts = {}
    find(e.app, "agents", "id != ''", "", 100000, {}).forEach(function (a) {
      var o = a.getString("owner")
      counts[o] = (counts[o] || 0) + 1
    })
    var list = find(e.app, "users", "id != ''", "name", 100000, {})
    return [200, list.map(function (u) { return userAdminOut(u, counts[u.id] || 0) })]
  },
}

// POST /admin/users {name, email?, is_admin?}: a person plus a one-time join
// link (24h). No password is ever returned.
routes.adminCreateUser = {
  allow: ["user"],
  fn: function (e, ctx) {
    requireAdmin(ctx)
    var b = body(e)
    return tx(e.app, function (app) {
      var email = str(b.email).trim().toLowerCase()
      if (email && (!EMAIL_RE.test(email) || email.length > 200)) throw E(400, "invalid", "email is not valid (leave it empty if the person has none)")
      var name = str(b.name).trim()
      if (!name || name.length > 200) throw E(400, "invalid", "name is required")
      if (b.is_admin !== undefined && typeof b.is_admin !== "boolean") throw E(400, "invalid", "is_admin must be boolean")
      if (email) {
        var exists = null
        try {
          exists = app.findAuthRecordByEmail("users", email)
        } catch (err) {}
        if (exists) throw E(409, "conflict", "a user with this email already exists")
      }
      var u = newHumanRecord(app, name, email, b.is_admin === true)
      app.save(u)
      var out = linkOut(e, mintLoginToken(app, u.id, "invite", "user:" + ctx.user.id))
      out.user = userAdminOut(u, 0)
      return [201, out]
    })
  },
}

// POST /admin/users/{id}/login-link: a fresh one-time link (24h) for a new
// device; older unused links for that person stop working.
routes.adminUserLoginLink = {
  allow: ["user"],
  fn: function (e, ctx) {
    requireAdmin(ctx)
    return tx(e.app, function (app) {
      var u = userByRef(app, e.request.pathValue("id"))
      if (u.getBool("deactivated")) throw E(409, "bad_state", "reactivate this person first")
      var out = linkOut(e, mintLoginToken(app, u.id, "login", "user:" + ctx.user.id))
      out.user = userAdminOut(u)
      return [201, out]
    })
  },
}

// PATCH /admin/users/{id} {name?, email?, is_admin?, deactivated?, deactivate_agents?=true}
routes.adminPatchUser = {
  allow: ["user"],
  fn: function (e, ctx) {
    requireAdmin(ctx)
    var b = body(e)
    return tx(e.app, function (app) {
      var u = userByRef(app, e.request.pathValue("id"))
      var self = u.id === ctx.user.id
      var agentsOff = 0
      if (b.name !== undefined) {
        var n = str(b.name).trim()
        if (!n || n.length > 200) throw E(400, "invalid", "name must be 1..200 characters")
        u.set("name", n)
      }
      if (b.email !== undefined) {
        var em = str(b.email).trim().toLowerCase()
        if (em && (!EMAIL_RE.test(em) || em.length > 200)) throw E(400, "invalid", "email is not valid")
        if (em) {
          var other = null
          try {
            other = app.findAuthRecordByEmail("users", em)
          } catch (err) {}
          if (other && other.id !== u.id) throw E(409, "conflict", "a user with this email already exists")
        }
        u.setEmail(em)
      }
      if (b.is_admin !== undefined && typeof b.is_admin !== "boolean") throw E(400, "invalid", "is_admin must be boolean")
      if (b.deactivated !== undefined && typeof b.deactivated !== "boolean") throw E(400, "invalid", "deactivated must be boolean")
      // B9: removing an admin (demote or deactivate) needs another active admin
      // left, and for someone else, confirm_name matching their name.
      var removesAdmin = u.getBool("is_admin") && !u.getBool("deactivated") && (b.is_admin === false || b.deactivated === true)
      if (removesAdmin) {
        var others = find(app, "users", "is_admin = true && deactivated = false && id != {:u}", "", 1, { u: u.id })
        if (!others.length) throw E(409, "last_admin", "this would leave no active admin; make someone else admin first")
        if (!self && str(b.confirm_name).trim() !== userName(u)) {
          throw E(400, "confirm_required", "type the person's name (confirm_name) to remove an admin", { name: userName(u) })
        }
      }
      if (b.deactivate_agents === false) throw E(400, "invalid", "agents of a deactivated person stop working; reassign them with reassign_agents_to instead")
      if (b.is_admin !== undefined) u.set("is_admin", b.is_admin)
      var reassigned = 0
      if (b.deactivated !== undefined) {
        if (b.deactivated && !u.getBool("deactivated")) {
          var to = null
          if (b.reassign_agents_to !== undefined && str(b.reassign_agents_to).trim()) {
            to = userByRef(app, str(b.reassign_agents_to))
            if (to.id === u.id || to.getBool("deactivated")) throw E(409, "owner_deactivated", "reassign the agents to another active person")
          }
          u.set("deactivated", true)
          // every session token of this person stops validating now
          u.refreshTokenKey()
          burnLoginTokens(app, u.id, null)
          // B6: their agents move to another owner, or stop.
          find(app, "agents", "owner = {:u}", "", 10000, { u: u.id }).forEach(function (a) {
            if (to) {
              reassignAgent(app, a, to.id)
              app.save(a)
              reassigned++
              return
            }
            if (!a.getBool("active")) return
            a.set("active", false)
            app.save(a)
            revokeTokens(app, "agent = {:a}", { a: a.id })
            agentsOff++
          })
        } else if (!b.deactivated) {
          u.set("deactivated", false)
        }
      }
      app.save(u)
      return [200, { user: userAdminOut(u), agents_deactivated: agentsOff, agents_reassigned: reassigned }]
    })
  },
}

// Test-only: expire every login link of a user now.
routes.testExpireLoginTokens = {
  allow: ["superuser"],
  fn: function (e) {
    var b = body(e)
    var list = find(e.app, "login_tokens", "user = {:u}", "", 1000, { u: str(b.user_id) })
    list.forEach(function (lt) {
      lt.set("expires_at", iso(nowMs() - 1000))
      e.app.save(lt)
    })
    return [200, { updated: list.length }]
  },
}

// Test-only: the last OTP code mailed to an email (captured instead of sent
// when the hub runs with ACH_TEST_HOOKS=1 and ACH_TEST_CAPTURE_MAIL=1).
routes.testOtp = {
  allow: ["superuser"],
  fn: function (e) {
    var email = str(e.request.url.query().get("email")).toLowerCase()
    var v = e.app.store().get("ach_test_otp:" + email)
    if (!v) throw E(404, "not_found", "no code captured")
    return [200, JSON.parse(v)]
  },
}

// ---------------------------------------------------------------- cron sweep

// Escalate unanswered questions and expire claim leases.
// nowM lets the test-only route simulate the future; onlyTask limits scope.
// Interactive claims (P1) use a 24h inactivity lease; runner claims 10 min.
// Idle tasks (P5) notify their owner once per idle spell. Notifications go
// out after each transaction commits.
function sweep(app, nowM, onlyTask) {
  pendingNotes = []
  var timeoutMin = envInt("ACH_ASK_TIMEOUT_MIN", 15)
  var cut = iso(nowM - timeoutMin * 60000)
  var leaseCut = iso(nowM - LEASE_MIN * 60000)
  var iLeaseMs = envInt("ACH_INTERACTIVE_LEASE_HOURS", INTERACTIVE_LEASE_HOURS_DEFAULT) * 3600 * 1000
  var iLeaseCut = iso(nowM - iLeaseMs)
  var taskFilter = onlyTask ? " && task = {:only}" : ""
  var escalated = 0
  var expired = 0
  var idle = 0
  // A failed transaction must not leave its notifications queued.
  function guarded(fn) {
    var mark = pendingNotes.length
    try {
      fn()
    } catch (err) {
      pendingNotes.length = mark
      throw err
    }
  }

  var qs = find(app, "messages", "kind = 'question' && resolved = false && created < {:cut}" + taskFilter, "created", 500, { cut: cut, only: onlyTask || "" })
  qs.forEach(function (q0) {
    guarded(function () { tx(app, function (txApp) {
      var q = txApp.findRecordById("messages", q0.id)
      if (q.getBool("resolved") || q.getString("kind") !== "question") return
      var t = txApp.findRecordById("tasks", q.getString("task"))
      if (TERMINAL[t.getString("status")]) {
        q.set("resolved", true)
        txApp.save(q)
        return
      }
      var asker = q.getString("author_agent")
      var toUser = t.getString("owner_user")
      try {
        toUser = txApp.findRecordById("agents", asker).getString("owner") || toUser
      } catch (err) {}
      // Only a worker-side question blocks the task once escalated (C1).
      var blocking = !!asker && asker === t.getString("to_agent")
      var prev = blocking ? prevStatusFor(txApp, t) : ""
      q.set("kind", "decision_request")
      q.set("to_user", toUser)
      q.set("prev_status", prev)
      q.set("blocking", blocking)
      q.set("escalated", true)
      q.set("topic", "escalated_question")
      txApp.save(q)
      revokeTokens(txApp, "question = {:q}", { q: q.id })
      sysNote(txApp, t, "question escalated to a human: no agent answer within " + timeoutMin + " min", "question_escalated", { min: timeoutMin })
      if (blocking) {
        t.set("status", "input-required")
        t.set("parked_at", iso(nowMs()))
      }
      t.set("last_activity", iso(nowMs()))
      recomputeWaiting(txApp, t)
      txApp.save(t)
      notify("question_escalated", t, toUser, q)
      escalated++
    }) })
  })

  var tf = onlyTask ? " && id = {:only}" : ""
  // Right after the hub starts, runner leases are not judged for one lease
  // period: runners were heartbeating into a hub that was down, so a stale
  // last_activity is the hub's outage, not a dead runner (red-team: a hub
  // outage over 10 min re-ran every task in flight).
  var bootAt = Number(app.store().get(BOOT_KEY) || 0)
  var inGrace = !!bootAt && nowM - bootAt < LEASE_MIN * 60000
  var ts = find(
    app,
    "tasks",
    "status = 'working' && ((claim_mode != 'interactive' && last_activity < {:cut}) || (claim_mode = 'interactive' && last_activity < {:icut}))" + tf,
    "",
    500,
    { cut: leaseCut, icut: iLeaseCut, only: onlyTask || "" }
  )
  ts.forEach(function (t0) {
    guarded(function () { tx(app, function (txApp) {
      var t = txApp.findRecordById("tasks", t0.id)
      if (t.getString("status") !== "working") return
      var interactive = t.getString("claim_mode") === "interactive"
      if (!interactive && inGrace) return
      if (parseTime(t.getString("last_activity")) >= parseTime(interactive ? iLeaseCut : leaseCut)) return
      if (openOf(txApp, t.id, "question").length || openOf(txApp, t.id, "decision_request").length) return
      var oldRun = t.getString("run_id")
      // Breaker: a task whose runner keeps dying (it crashes the runner, or
      // hangs it) is not handed out again forever. The third lost run fails
      // it and tells the sender; a person decides what to do next. Counting
      // restarts when a person reopens the task (request-changes) or after
      // the breaker itself fired.
      var reset = find(txApp, "messages", "task = {:t} && (sys_code = 'changes_requested' || sys_code = 'lease_breaker')", "-created", 1, { t: t.id })
      var since = reset.length ? reset[0].getString("created") : ""
      var lost = find(txApp, "messages", "task = {:t} && sys_code = 'lease_expired'" + (since ? " && created > {:s}" : ""), "", LEASE_BREAKER, { t: t.id, s: since }).length
      if (!interactive && lost + 1 >= LEASE_BREAKER) {
        var why = "the runner stopped responding " + (lost + 1) + " times in a row (last run " + oldRun + "); not retried again"
        t.set("result", "failed: " + why)
        revokeTokens(txApp, "task = {:t} && mode = 'work'", { t: t.id })
        var fm = sysNote(txApp, t, "failed: " + why, "lease_breaker", { times: lost + 1, run: oldRun })
        setTerminal(txApp, t, "failed")
        txApp.save(t)
        notify("task_failed", t, t.getString("owner_user"), fm)
        require(__hooks + "/ach_wiki.js").onTaskTerminal(txApp, t, "failed")
        expired++
        return
      }
      t.set("status", "submitted")
      t.set("run_id", "")
      t.set("claim_mode", "")
      t.set("claimed_at", "")
      t.set("last_activity", iso(nowMs()))
      revokeTokens(txApp, "task = {:t} && mode = 'work'", { t: t.id })
      sysNote(
        txApp,
        t,
        interactive
          ? "lease expired: interactive claim inactive for " + iLeaseMs / 3600000 + " h (run " + oldRun + "); returned to submitted"
          : "lease expired: no heartbeat for " + LEASE_MIN + " min (run " + oldRun + "); returned to submitted",
        interactive ? "lease_expired_interactive" : "lease_expired",
        interactive ? { hours: iLeaseMs / 3600000, run: oldRun } : { min: LEASE_MIN, run: oldRun }
      )
      recomputeWaiting(txApp, t)
      txApp.save(t)
      expired++
    }) })
  })

  // P5: idle > 24h (any open status), once per idle spell.
  var idleCut = iso(nowM - IDLE_NOTIFY_MS)
  var its = find(
    app,
    "tasks",
    "(status = 'submitted' || status = 'working' || status = 'input-required') && last_activity < {:cut} && (idle_notified_at = '' || idle_notified_at < last_activity)" + tf,
    "",
    500,
    { cut: idleCut, only: onlyTask || "" }
  )
  its.forEach(function (t0) {
    guarded(function () { tx(app, function (txApp) {
      var t = txApp.findRecordById("tasks", t0.id)
      if (TERMINAL[t.getString("status")]) return
      t.set("idle_notified_at", iso(nowM))
      txApp.save(t)
      notify("task_idle", t, t.getString("owner_user"))
      idle++
    }) })
  })
  // A mention run whose runner died is closed once its token expired, so
  // the thread does not stay "running" (and dedupe does not hide new mentions).
  var stale = find(app, "mentions", "status = 'running' && updated < {:cut}", "", 500, { cut: iso(nowM - MENTION_TOKEN_HOURS * 3600 * 1000) })
  stale.forEach(function (m0) {
    guarded(function () { tx(app, function (txApp) {
      var m = txApp.findRecordById("mentions", m0.id)
      if (m.getString("status") !== "running") return
      m.set("status", "done")
      txApp.save(m)
      revokeTokens(txApp, "mention = {:m}", { m: m.id })
    }) })
  })
  sendNotes(app)
  var out = { escalated: escalated, expired: expired, idle: idle }
  if (stale.length) out.mentions_closed = stale.length
  return out
}

// Test-only: move the expiry of a task's live run tokens to now + minutes.
routes.testTokenExpiry = {
  allow: ["superuser"],
  fn: function (e) {
    var b = body(e)
    var toks = find(e.app, "run_tokens", "task = {:t} && revoked = false", "", 100, { t: str(b.task_id) })
    toks.forEach(function (rt) {
      rt.set("expires_at", iso(nowMs() + Number(b.minutes || 0) * 60000))
      e.app.save(rt)
    })
    return [200, { updated: toks.length }]
  },
}

routes.testSweep = {
  allow: ["superuser"],
  fn: function (e) {
    var b = body(e)
    var off = Number(b.offset_min || 0)
    // boot_ago_min: pretend the hub started that many minutes ago (lease grace tests)
    if (b.boot_ago_min !== undefined) e.app.store().set(BOOT_KEY, String(nowMs() - Number(b.boot_ago_min) * 60000))
    return [200, sweep(e.app, nowMs() + off * 60000, str(b.task_id))]
  },
}

// ---------------------------------------------------------------- channels, posts, mentions

var CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
var POST_MAX = 100000
var MENTION_RE = /(^|[^A-Za-z0-9_.\/-])@([a-z0-9][a-z0-9-]{1,40})(?![A-Za-z0-9-])/g
var MENTION_TOKEN_HOURS = 2
var DEFAULT_EMBED_HOSTS = ["figma.com", "loom.com", "youtube.com", "youtu.be", "feishu.cn", "larksuite.com", "docs.google.com"]
var EMBED_STORE_KEY = "ach_embed_hosts"

function channelOut(c, stats, viewer) {
  var s = (stats && stats[c.id]) || {}
  var members = arr(c.getStringSlice("members"))
  return {
    member: !!viewer && members.indexOf(viewer) >= 0,
    member_count: members.length,
    id: c.id,
    name: c.getString("name"),
    title: c.getString("title") || c.getString("name"),
    description: c.getString("description"),
    visibility: c.getString("visibility") || "team",
    archived: c.getBool("archived"),
    created: c.getString("created"),
    post_count: s.n || 0,
    last_post_at: s.last || "",
    url: linkUrl("c/" + c.getString("name")),
    repos: parseJSON(c.getString("repos")) || [], // GitHub repos mapped here (ach_import.js)
  }
}

function channelStats(app) {
  var rows = arrayOf(new DynamicModel({ channel: "", n: 0, last: "" }))
  app.db().newQuery("SELECT channel, COUNT(*) AS n, MAX(created) AS last FROM posts WHERE parent = '' OR parent IS NULL GROUP BY channel").all(rows)
  var out = {}
  rows.forEach(function (r) { out[r.channel] = { n: r.n, last: r.last } })
  return out
}

function postAuthorName(p, names) {
  var t = p.getString("author_type")
  if (t === "agent") return names.agent(p.getString("author_agent"))
  if (t === "human") return names.user(p.getString("author_user"))
  if (t === "external") {
    var x = parseJSON(p.getString("external")) || {}
    return names.user(p.getString("author_user")) || names.login(str(x.author)) || str(x.author) || "GitHub"
  }
  return "system"
}

// An imported GitHub item as the panel renders it (a card, not a system line).
function externalOut(p, names) {
  var x = parseJSON(p.getString("external")) || {}
  var assignees = arr(x.assignees).map(function (a) { return str(a) })
  return {
    kind: str(x.kind),
    repo: str(x.repo),
    number: x.number || 0,
    url: str(x.url),
    state: str(x.state),
    title: str(x.title),
    author: str(x.author),
    author_name: names.login(str(x.author)) || str(x.author),
    assignees: assignees,
    assignee_names: assignees.map(function (a) { return names.login(a) || a }),
    labels: arr(x.labels).map(function (l) { return str(l) }),
    created_at: str(x.created_at),
    updated_at: str(x.updated_at),
    excerpt: str(x.excerpt),
  }
}

// Task summary for a task's anchor post in the stream.
function taskBrief(app, taskId, names) {
  var t
  try {
    t = app.findRecordById("tasks", taskId)
  } catch (err) {
    return null
  }
  var last = find(app, "messages", "task = {:t} && author_type != 'system'", "-created,-id", 1, { t: t.id })
  var cnt = new DynamicModel({ n: 0 })
  app.db().newQuery("SELECT COUNT(*) AS n FROM messages WHERE task = {:t} AND author_type != 'system'").bind({ t: t.id }).one(cnt)
  var line = last.length ? str(last[0].getString("body")).split("\n")[0].slice(0, 200) : ""
  return {
    id: t.id,
    ref: taskRef(t),
    url: linkUrl("t/" + taskRef(t)),
    title: t.getString("title"),
    status: t.getString("status"),
    priority: t.getString("priority"),
    from_agent: t.getString("from_agent"),
    from_agent_name: names.agent(t.getString("from_agent")),
    to_agent: t.getString("to_agent"),
    to_agent_name: names.agent(t.getString("to_agent")),
    handoff_version: t.getInt("handoff_version"),
    reply_count: cnt.n,
    last_line: line,
    last_activity: t.getString("last_activity"),
  }
}

function postOut(app, p, names, withTask) {
  var out = {
    id: p.id,
    url: linkUrl("p/" + p.id),
    channel: p.getString("channel"),
    channel_name: names.channel(p.getString("channel")),
    kind: p.getString("kind"),
    parent: p.getString("parent"),
    author_type: p.getString("author_type"),
    author_agent: p.getString("author_agent"),
    author_user: p.getString("author_user"),
    author_name: postAuthorName(p, names),
    author_quiet: p.getString("author_type") === "agent" && names.quiet(p.getString("author_agent")),
    body: p.getString("body"),
    evidence: p.getString("evidence"),
    escalated: p.getBool("escalated"),
    to_user: p.getString("to_user"),
    to_user_name: names.user(p.getString("to_user")),
    mentions: arr(p.getStringSlice("mentions")).map(function (id) { return names.agent(id) }),
    task: p.getString("task"),
    reply_count: p.getInt("reply_count"),
    last_reply_at: p.getString("last_reply_at"),
    attachments: attOut("posts", p),
    created: p.getString("created"),
    choices: parseJSON(p.getString("choices")) || null,
  }
  if (p.getBool("announce")) out.announce = true
  // an inbound-hook post (ach_hooks.js): external and untrusted (agents treat it as background only)
  if (p.getString("author_type") === "external" && !p.getString("external_id")) {
    var ix = parseJSON(p.getString("external")) || {}
    if (ix.kind === "inbound") { out.inbound = { name: str(ix.name) }; out.untrusted = true }
  }
  if (p.getString("external_id")) out.external = externalOut(p, names)
  if (p.getString("sys_code")) {
    out.sys_code = p.getString("sys_code")
    out.sys_params = parseJSON(p.getString("sys_params")) || {}
  }
  if (withTask && p.getString("task")) out.task_info = taskBrief(app, p.getString("task"), names)
  return out
}

// Agent ids mentioned as @name in text (code spans and fenced blocks ignored).
function parseMentions(app, text, selfId) {
  var plain = str(text).replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ")
  var out = []
  var m
  MENTION_RE.lastIndex = 0
  while ((m = MENTION_RE.exec(plain))) {
    var name = m[2]
    var a = find(app, "agents", "name = {:n} && active = true", "", 1, { n: name })
    if (!a.length || a[0].id === selfId) continue
    if (out.indexOf(a[0].id) < 0) out.push(a[0].id)
    if (out.length >= 20) break
  }
  return out
}

function threadRoot(app, p) {
  var parent = p.getString("parent")
  return parent ? findOr404(app, "posts", parent, "post") : p
}

// Run tokens: work/answer tokens see their task's channel; mention tokens the
// channel of their thread.
function runScope(app, ctx) {
  var tok = ctx.token
  if (ctx.mode === "mention") {
    var root = findOr404(app, "posts", tok.getString("post"), "post")
    return { channel: root.getString("channel"), thread: root.id }
  }
  var t = findOr404(app, "tasks", tok.getString("task"), "task")
  var anchor = find(app, "posts", "task = {:t} && kind = 'task'", "", 1, { t: t.id })
  return { channel: t.getString("channel"), thread: anchor.length ? anchor[0].id : "", task: t }
}

function requireRunChannel(app, ctx, channelId) {
  if (ctx.type !== "run") return
  if (runScope(app, ctx).channel !== channelId) throw E(403, "forbidden", "run token is scoped to another channel")
}

// Run tokens may reply only under their task's anchor post (work/answer)
// or in the thread they were mentioned in (mention).
function requireRunThread(app, ctx, root) {
  if (ctx.type !== "run") return
  var sc = runScope(app, ctx)
  if (!sc.thread || sc.thread !== root.id) throw E(403, "forbidden", "run token may only reply in its own thread")
  if (ctx.mode !== "mention") checkRunTask(ctx, sc.task)
}

function actorFields(ctx) {
  if (ctx.type === "user") return { author_type: "human", author_user: ctx.user.id }
  return { author_type: "agent", author_agent: ctx.agent.id }
}

// Creates a post or reply, its mention rows and the thread bookkeeping.
// Loop guard: an agent-written post that mentions agents is one hop of its
// thread; past HOP_LIMIT agent mentions in that thread wake nobody until a
// human posts in it (a human post resets the counter).
function createPost(app, ctx, channel, root, b, files) {
  var text = str(b.body)
  if (!text.trim() && !files.length && !hasRefs()) throw E(400, "invalid", "body or attachments required")
  if (text.length > POST_MAX) throw E(400, "invalid", "body is too long")
  if (channel.getBool("archived")) throw E(409, "archived", "channel #" + channel.getString("name") + " is archived")
  var evidence = str(b.evidence)
  var escalate = b.escalate === true
  if (escalate && ctx.type === "user") throw E(400, "invalid", "only agents escalate")
  if (escalate && !root) throw E(400, "invalid", "escalate only in a reply")
  if (ctx.type === "run" && ctx.mode === "mention" && !escalate && !evidence.trim()) {
    throw E(400, "evidence_required", "a mention run replies with evidence, or escalates (escalate: true)")
  }
  var p = new Record(app.findCollectionByNameOrId("posts"))
  var f = actorFields(ctx)
  for (var k in f) p.set(k, f[k])
  p.set("channel", channel.id)
  p.set("kind", "post")
  p.set("body", text)
  if (evidence) p.set("evidence", evidence)
  if (root) p.set("parent", root.id)
  // notifications (ach_notify.js): a top-level post may be an announcement ("shipped", "data published")
  if (!root && (b.announce === true || b.announce === "true")) p.set("announce", true)
  var selfId = ctx.type === "user" ? "" : ctx.agent.id
  var mentioned = parseMentions(app, text, selfId)
  if (channel.getString("visibility") === "private") {
    var cm = arr(channel.getStringSlice("members"))
    mentioned = mentioned.filter(function (aid) {
      try {
        var ow = app.findRecordById("agents", aid).getString("owner")
        return cm.indexOf(ow) >= 0 || app.findRecordById("users", ow).getBool("is_admin")
      } catch (err) { return false }
    })
  }
  p.set("mentions", mentioned)
  var toUser = ""
  if (escalate) {
    toUser = escalationTarget(app, ctx, root)
    p.set("escalated", true)
    p.set("to_user", toUser)
  }
  app.save(p)
  attachFiles(app, p, files)

  var thread = root || p
  var hopsBlocked = false
  if (ctx.type === "user") {
    thread.set("thread_hops", 0)
  } else if (mentioned.length) {
    var hops = thread.getInt("thread_hops") + 1
    thread.set("thread_hops", hops)
    if (hops > HOP_LIMIT) hopsBlocked = true
  }
  if (root) {
    root.set("reply_count", root.getInt("reply_count") + 1)
    root.set("last_reply_at", p.getString("created"))
  }
  if (root || ctx.type === "user" || mentioned.length) app.save(thread)
  var woken = []
  if (hopsBlocked) {
    var sys = new Record(app.findCollectionByNameOrId("posts"))
    sys.set("channel", channel.id)
    sys.set("author_type", "system")
    sys.set("kind", "system")
    sys.set("parent", thread.id)
    sys.set("body", "hop limit " + HOP_LIMIT + " reached in this thread: agent mentions no longer wake agents until a human posts here")
    sys.set("sys_code", "hop_limit")
    sys.set("sys_params", { n: HOP_LIMIT })
    app.save(sys)
    thread.set("reply_count", thread.getInt("reply_count") + 1)
    app.save(thread)
  } else {
    mentioned.forEach(function (aid) {
      var dup = find(app, "mentions", "agent = {:a} && thread = {:t} && status != 'done'", "", 1, { a: aid, t: thread.id })
      if (dup.length) return
      var m = new Record(app.findCollectionByNameOrId("mentions"))
      m.set("post", p.id)
      m.set("thread", thread.id)
      m.set("agent", aid)
      if (ctx.type === "user") m.set("by_user", ctx.user.id)
      else m.set("by_agent", ctx.agent.id)
      m.set("status", "open")
      app.save(m)
      woken.push(aid)
    })
  }
  if (escalate) notifyPost("mention_escalated", p, "#" + channel.getString("name") + ": " + str(root.getString("body")).split("\n")[0].slice(0, 120), toUser)
  // replies only: a person's reply to a Memory question (a decision to record, or which of two values is right) resolves it
  if (root && ctx.type === "user") require(__hooks + "/ach_wiki.js").onHumanPostReply(app, root, p, ctx.user)
  // A task's anchor thread counts as activity on the task.
  if (thread.getString("task")) {
    try {
      var t = app.findRecordById("tasks", thread.getString("task"))
      if (!TERMINAL[t.getString("status")]) {
        t.set("last_activity", iso(nowMs()))
        app.save(t)
      }
    } catch (err) {}
  }
  return { post: p, woken: woken, hop_limited: hopsBlocked }
}

// Who hears an escalation: whoever mentioned the agent (the mentioning
// agent's owner, or the human), else the thread author's side.
function escalationTarget(app, ctx, root) {
  var ownerOfAgent = function (id) { return ownerOf(app, id, "") }
  if (ctx.type === "run" && ctx.mode === "mention") {
    try {
      var m = app.findRecordById("mentions", ctx.token.getString("mention"))
      if (m.getString("by_user")) return m.getString("by_user")
      if (m.getString("by_agent")) return ownerOfAgent(m.getString("by_agent"))
    } catch (err) {}
  }
  if (root.getString("author_user")) return root.getString("author_user")
  if (root.getString("author_agent")) return ownerOfAgent(root.getString("author_agent"))
  return ctx.agent.getString("owner")
}

function threadOut(app, root, names) {
  var replies = find(app, "posts", "parent = {:p}", "created,id", 2000, { p: root.id })
  return {
    post: postOut(app, root, names, true),
    replies: replies.map(function (r) { return postOut(app, r, names, false) }),
  }
}

routes.listChannels = {
  allow: ["agent", "run", "user"],
  runModes: ["work", "answer", "mention"],
  fn: function (e, ctx) {
    var all = str(e.request.url.query().get("all")) === "1"
    var list = find(e.app, "channels", all ? "id != ''" : "archived = false", "name", 1000, {})
    if (ctx.type === "run") {
      var sc = runScope(e.app, ctx)
      list = list.filter(function (c) { return c.id === sc.channel })
    }
    list = list.filter(function (c) { return !channelHidden(ctx, c.id) })
    var stats = channelStats(e.app)
    var uid = viewerOf(ctx).uid
    return [200, list.map(function (c) { return channelOut(c, stats, uid) })]
  },
}

function channelVisibility(v, def) {
  if (v === undefined || v === null || v === "") {
    if (def) return def
    throw E(400, "invalid", "visibility must be team or private")
  }
  var s = str(v).trim().toLowerCase()
  if (s !== "team" && s !== "private") throw E(400, "invalid", "visibility must be team or private")
  return s
}

// people by id, email or github login -> user ids (unknown refs are an error)
function memberIds(app, list) {
  if (!Array.isArray(list)) throw E(400, "invalid", "members must be a list of people (id, email or github login)")
  var out = []
  list.forEach(function (ref) {
    var r = str(ref).trim().replace(/^@/, "")
    if (!r) return
    var u = find(app, "users", "id = {:r} || email = {:r} || github_login = {:r}", "", 1, { r: r })
    if (!u.length) throw E(404, "not_found", "no person '" + r + "'")
    if (out.indexOf(u[0].id) < 0) out.push(u[0].id)
  })
  return out
}

function requireChannelAdmin(ctx) {
  if (ctx.type !== "user" || !ctx.isAdmin) throw adminDenied(ctx, "only admins manage channels")
}

function channelName(v) {
  var n = str(v).trim().replace(/^#/, "").toLowerCase()
  if (!CHANNEL_NAME_RE.test(n)) throw E(400, "invalid_name", "channel name must match ^[a-z0-9][a-z0-9_-]{0,39}$")
  return n
}

// B17: a slug from a display title. ASCII words become the slug ("Web App"
// -> "web-app"); a title with no ASCII letters (Chinese) gets "c-" + random.
function slugFromTitle(app, title) {
  var base = str(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "")
  if (!base || !CHANNEL_NAME_RE.test(base)) base = "c-" + $security.randomStringWithAlphabet(6, IDCHARS)
  var name = base
  for (var i = 2; find(app, "channels", "name = {:n}", "", 1, { n: name }).length; i++) name = base + "-" + i
  return name
}

function channelTitle(v) {
  var t = str(v).replace(/[\r\n\t]+/g, " ").trim()
  if (t.length > 200) throw E(400, "invalid", "title is too long (max 200)")
  return t
}

routes.createChannel = {
  allow: ["user"],
  fn: function (e, ctx) {
    requireChannelAdmin(ctx)
    var b = body(e)
    return tx(e.app, function (app) {
      var title = b.title === undefined ? "" : channelTitle(b.title)
      if (!str(b.name).trim() && !title) throw E(400, "invalid_name", "a channel needs a name or a title")
      var name = str(b.name).trim() ? channelName(b.name) : slugFromTitle(app, title)
      if (find(app, "channels", "name = {:n}", "", 1, { n: name }).length) throw E(409, "conflict", "channel #" + name + " already exists")
      var c = new Record(app.findCollectionByNameOrId("channels"))
      c.set("name", name)
      c.set("title", title)
      c.set("description", str(b.description).slice(0, 2000))
      c.set("visibility", channelVisibility(b.visibility, "team"))
      c.set("created_by", ctx.user.id)
      c.set("archived", false)
      if (b.members !== undefined) c.set("members", memberIds(app, b.members))
      app.save(c)
      return [201, channelOut(c, {}, ctx.user.id)]
    })
  },
}

routes.patchChannel = {
  allow: ["user"],
  fn: function (e, ctx) {
    requireChannelAdmin(ctx)
    var b = body(e)
    return tx(e.app, function (app) {
      var c = findChannel(app, e.request.pathValue("id"))
      var isGeneral = c.getString("name") === "general"
      if (b.name !== undefined) {
        var n = channelName(b.name)
        if (isGeneral && n !== "general") throw E(400, "invalid", "#general cannot be renamed (new tasks default to it)")
        var other = find(app, "channels", "name = {:n} && id != {:id}", "", 1, { n: n, id: c.id })
        if (other.length) throw E(409, "conflict", "channel #" + n + " already exists")
        c.set("name", n)
      }
      if (b.description !== undefined) c.set("description", str(b.description).slice(0, 2000))
      if (b.title !== undefined) c.set("title", channelTitle(b.title))
      if (b.archived !== undefined) {
        if (typeof b.archived !== "boolean") throw E(400, "invalid", "archived must be boolean")
        if (isGeneral && b.archived) throw E(400, "invalid", "#general cannot be archived")
        c.set("archived", b.archived)
      }
      if (b.visibility !== undefined) {
        var vis = channelVisibility(b.visibility, "")
        if (isGeneral && vis === "private") throw E(400, "invalid", "#general is always team-visible")
        c.set("visibility", vis)
      }
      var mem = arr(c.getStringSlice("members"))
      if (b.members !== undefined) mem = memberIds(app, b.members)
      if (b.add_members !== undefined) memberIds(app, b.add_members).forEach(function (id) { if (mem.indexOf(id) < 0) mem.push(id) })
      if (b.remove_members !== undefined) {
        var rm = memberIds(app, b.remove_members)
        mem = mem.filter(function (id) { return rm.indexOf(id) < 0 })
      }
      c.set("members", mem)
      app.save(c)
      return [200, channelOut(c, channelStats(app), ctx.user.id)]
    })
  },
}

routes.channelPosts = {
  allow: ["agent", "run", "user"],
  runModes: ["work", "answer", "mention"],
  fn: function (e, ctx) {
    var app = e.app
    var c = findChannel(app, e.request.pathValue("id"))
    requireChannelVisible(ctx, c.id)
    requireRunChannel(app, ctx, c.id)
    var q = e.request.url.query()
    var limit = Math.max(1, Math.min(200, parseInt(str(q.get("limit")) || "50", 10) || 50))
    var filter = "channel = {:c} && (parent = '' || parent = null)"
    var params = { c: c.id }
    if (q.get("since")) {
      filter += " && created > {:since}"
      params.since = str(q.get("since")).replace("T", " ")
    }
    if (q.get("before")) {
      filter += " && created < {:before}"
      params.before = str(q.get("before")).replace("T", " ")
    }
    var list = arr(find(app, "posts", filter, "-created,-id", limit, params)).reverse()
    var names = new Names(app)
    return [200, { channel: channelOut(c, channelStats(app), viewerOf(ctx).uid), posts: list.map(function (p) { return postOut(app, p, names, true) }) }]
  },
}

routes.createChannelPost = {
  allow: ["agent", "user"],
  fn: function (e, ctx) {
    var b = body(e)
    var files = uploads(e)
    return tx(e.app, function (app) {
      var c = findChannel(app, e.request.pathValue("id"))
      requireChannelVisible(ctx, c.id)
      var r = createPost(app, ctx, c, null, b, files)
      var names = new Names(app)
      return [201, { post: postOut(app, r.post, names, false), woken: r.woken.length, notified: r.woken.map(function (id) { return names.agent(id) }), hop_limited: r.hop_limited }]
    })
  },
}

routes.getPost = {
  allow: ["agent", "run", "user"],
  runModes: ["work", "answer", "mention"],
  fn: function (e, ctx) {
    var app = e.app
    var p = findOr404(app, "posts", e.request.pathValue("id"), "post")
    requireChannelVisible(ctx, p.getString("channel"), "post")
    requireRunChannel(app, ctx, p.getString("channel"))
    var root = threadRoot(app, p)
    var out = threadOut(app, root, new Names(app))
    out.focus = p.id
    return [200, out]
  },
}

routes.replyPost = {
  allow: ["agent", "run", "user"],
  runModes: ["work", "answer", "mention"],
  fn: function (e, ctx) {
    var b = body(e)
    var files = uploads(e)
    return tx(e.app, function (app) {
      var p = findOr404(app, "posts", e.request.pathValue("id"), "post")
      requireChannelVisible(ctx, p.getString("channel"), "post")
      var root = threadRoot(app, p)
      requireRunThread(app, ctx, root)
      var c = app.findRecordById("channels", root.getString("channel"))
      var r = createPost(app, ctx, c, root, b, files)
      var names = new Names(app)
      return [201, { post: postOut(app, r.post, names, false), woken: r.woken.length, notified: r.woken.map(function (id) { return names.agent(id) }), hop_limited: r.hop_limited }]
    })
  },
}

function mentionOut(app, m, names) {
  var p = app.findRecordById("posts", m.getString("post"))
  var root = app.findRecordById("posts", m.getString("thread"))
  return {
    mention: {
      id: m.id,
      post: p.id,
      thread: root.id,
      status: m.getString("status"),
      by: m.getString("by_user") ? "human " + names.user(m.getString("by_user")) : "agent " + names.agent(m.getString("by_agent")),
      by_type: m.getString("by_user") ? "human" : "agent",
      created: m.getString("created"),
    },
    post: postOut(app, p, names, false),
    thread: postOut(app, root, names, true),
    channel_name: names.channel(root.getString("channel")),
  }
}

function mentionsForMe(app, me, names) {
  var list = find(app, "mentions", "agent = {:a} && status = 'open'", "created", 100, { a: me.id })
  var out = []
  list.forEach(function (m) {
    try {
      out.push(mentionOut(app, m, names))
    } catch (err) {}
  })
  return out
}

// POST /mentions/{id}/run {run_id}: the mentioned agent's runner takes the
// mention and gets a read-only "mention" run token for that thread.
routes.mentionRun = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var runId = requireRunId(b)
    return tx(e.app, function (app) {
      var m = findOr404(app, "mentions", e.request.pathValue("id"), "mention")
      if (m.getString("agent") !== ctx.agent.id) throw E(403, "forbidden", "this mention is for another agent")
      if (m.getString("status") !== "open") throw E(409, "conflict", "mention already taken (status " + m.getString("status") + ")")
      m.set("status", "running")
      m.set("run_id", runId)
      app.save(m)
      var tok = "ach_rt_" + genKeySecret(40)
      var rt = new Record(app.findCollectionByNameOrId("run_tokens"))
      rt.set("token_hash", sha(tok))
      rt.set("agent", ctx.agent.id)
      rt.set("run_id", runId)
      rt.set("mode", "mention")
      rt.set("post", m.getString("thread"))
      rt.set("mention", m.id)
      var exp = iso(nowMs() + MENTION_TOKEN_HOURS * 3600 * 1000)
      rt.set("expires_at", exp)
      rt.set("revoked", false)
      app.save(rt)
      var names = new Names(app)
      var out = mentionOut(app, m, names)
      var root = app.findRecordById("posts", m.getString("thread"))
      out.replies = threadOut(app, root, names).replies
      out.recent = arr(find(app, "posts", "channel = {:c} && (parent = '' || parent = null)", "-created,-id", 20, { c: root.getString("channel") }))
        .reverse()
        .map(function (x) { return postOut(app, x, names, true) })
      out.run_token = tok
      out.run_token_expires_at = exp
      return [200, out]
    })
  },
}

routes.mentionEnd = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var runId = requireRunId(b)
    return tx(e.app, function (app) {
      var m = findOr404(app, "mentions", e.request.pathValue("id"), "mention")
      if (m.getString("agent") !== ctx.agent.id) throw E(403, "forbidden", "this mention is for another agent")
      var toks = find(app, "run_tokens", "mention = {:m} && run_id = {:r} && revoked = false", "", 100, { m: m.id, r: runId })
      toks.forEach(function (rt) {
        rt.set("revoked", true)
        app.save(rt)
      })
      m.set("status", "done")
      app.save(m)
      return [200, { revoked: toks.length }]
    })
  },
}

routes.mentionUsage = {
  allow: ["agent"],
  fn: function (e, ctx) {
    var b = body(e)
    var runId = requireRunId(b)
    var cost = Number(b.cost_usd)
    if (typeof b.cost_usd !== "number" || isNaN(cost) || cost < 0) throw E(400, "invalid", "cost_usd must be a non-negative number")
    var max = envInt("ACH_USAGE_MAX", USAGE_MAX_DEFAULT)
    var clamped = cost > max
    if (clamped) cost = max
    return tx(e.app, function (app) {
      var m = findOr404(app, "mentions", e.request.pathValue("id"), "mention")
      if (m.getString("agent") !== ctx.agent.id || m.getString("run_id") !== runId) throw E(403, "forbidden", "run_id is not a run of yours on this mention")
      var a = app.findRecordById("agents", ctx.agent.id)
      a.set("spent_usd", a.getFloat("spent_usd") + cost)
      app.save(a)
      var u = new Record(app.findCollectionByNameOrId("usage"))
      u.set("post", m.getString("thread"))
      u.set("agent", a.id)
      u.set("run_id", runId)
      u.set("mode", "mention")
      u.set("cost_usd", cost)
      u.set("estimated", b.estimated === true)
      app.save(u)
      return [200, { agent_spent_usd: a.getFloat("spent_usd"), recorded_usd: cost, clamped: clamped, mode: "mention" }]
    })
  },
}

// ---------------------------------------------------------------- search

var SEARCH_KINDS = ["post", "task", "message", "handoff"]

function likeEscape(s) {
  return s.replace(/[\\%_]/g, function (c) { return "\\" + c })
}

function snippetOf(text, terms) {
  var s = str(text).replace(/\s+/g, " ").trim()
  var low = s.toLowerCase()
  var at = -1
  for (var i = 0; i < terms.length && at < 0; i++) at = low.indexOf(terms[i].toLowerCase())
  if (at < 0) at = 0
  var from = Math.max(0, at - 60)
  return (from > 0 ? "…" : "") + s.slice(from, from + 200) + (from + 200 < s.length ? "…" : "")
}

function synonymGroups() {
  try {
    return require(__hooks + "/ach_synonyms.js") || []
  } catch (err) {
    return []
  }
}

// The query term plus its synonyms (ach_synonyms.js), lowercased, deduplicated.
function expandTerm(t, groups) {
  var low = t.toLowerCase()
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i].map(function (x) { return String(x).toLowerCase() })
    if (g.indexOf(low) >= 0) return [t].concat(g.filter(function (x) { return x !== low }))
  }
  return [t]
}

function ftsLen(t) {
  return t.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "_").length
}

// Terms of 3+ characters use the FTS5 trigram index; shorter ones (1–2 CJK
// characters, short codes) fall back to LIKE on the same table. A term with
// synonyms matches any of them. Results are ranked by bm25 when the index is
// used (then newest first); LIKE-only queries are newest first.
function searchRows(app, q, scope) {
  var terms = q.split(/\s+/).filter(function (x) { return x })
  if (!terms.length) return { rows: [], mode: "none", terms: [] }
  if (terms.length > 8) terms = terms.slice(0, 8)
  var groups = synonymGroups()
  var where = []
  var params = {}
  var fts = []
  var likeUsed = false
  var shown = []
  terms.forEach(function (t, i) {
    var variants = expandTerm(t, groups)
    variants.forEach(function (v) { if (shown.indexOf(v) < 0) shown.push(v) })
    var allLong = variants.every(function (v) { return ftsLen(v) >= 3 })
    if (allLong) {
      var ors = variants.map(function (v) { return '"' + v.replace(/"/g, '""') + '"' })
      fts.push(ors.length > 1 ? "(" + ors.join(" OR ") + ")" : ors[0])
    } else {
      likeUsed = true
      where.push("(" + variants.map(function (v, j) {
        params["l" + i + "_" + j] = "%" + likeEscape(v) + "%"
        return "body LIKE {:l" + i + "_" + j + "} ESCAPE '\\'"
      }).join(" OR ") + ")")
    }
  })
  var mode = fts.length ? (likeUsed ? "fts+like" : "fts") : "like"
  if (fts.length) {
    where.unshift("ach_fts MATCH {:m}")
    params.m = fts.join(" AND ")
  }
  if (scope.channel) {
    where.push("channel = {:ch}")
    params.ch = scope.channel
  }
  if (scope.author || scope.authorLogin) {
    // imported GitHub items also match by the GitHub login (external.author)
    var ors = []
    if (scope.author) { ors.push("author = {:au}"); params.au = scope.author }
    if (scope.authorLogin) {
      ors.push("(kind = 'post' AND rid IN (SELECT id FROM posts WHERE external_id != '' AND lower(json_extract(external,'$.author')) = {:al}))")
      params.al = scope.authorLogin.toLowerCase()
    }
    where.push("(" + ors.join(" OR ") + ")")
  }
  if (scope.ctx && arr(scope.ctx.hidden).length) {
    // private channels: members only; a party still finds its own task's content
    var party = scope.agent
      ? "task IN (SELECT id FROM tasks WHERE from_agent = {:me} OR to_agent = {:me})"
      : "task IN (SELECT t.id FROM tasks t LEFT JOIN agents a1 ON a1.id = t.from_agent LEFT JOIN agents a2 ON a2.id = t.to_agent WHERE t.owner_user = {:vu} OR a1.owner = {:vu} OR a2.owner = {:vu})"
    if (!scope.agent) params.vu = viewerOf(scope.ctx).uid
    else params.me = scope.agent
    where.push("(" + hiddenSql("channel", scope.ctx, params) + " OR (task != '' AND " + party + "))")
  }
  if (scope.agent) {
    // agents see every post, and task content only where they are a party
    where.push("(kind = 'post' OR task IN (SELECT id FROM tasks WHERE from_agent = {:me} OR to_agent = {:me}))")
    params.me = scope.agent
  }
  if (scope.excludeBots) {
    // C: exclude_bots=1 leaves out quiet agents (data bots)
    where.push("author NOT IN (SELECT id FROM agents WHERE quiet = TRUE)")
  }
  var order = fts.length ? "bm25(ach_fts), created DESC" : "created DESC"
  var rows = arrayOf(new DynamicModel({ body: "", kind: "", rid: "", task: "", channel: "", author: "", created: "" }))
  app.db()
    .newQuery("SELECT body, kind, rid, task, channel, author, created FROM ach_fts WHERE " + where.join(" AND ") + " ORDER BY " + order + " LIMIT " + scope.limit)
    .bind(params)
    .all(rows)
  return { rows: rows, mode: mode, terms: shown }
}

// author= for search: an agent, a person (id, email, name or GitHub login), or
// a GitHub login seen on imported items. -> {id, login}
function authorRef(app, ref) {
  ref = str(ref).trim().replace(/^@/, "")
  if (!ref) return { id: "", login: "" }
  var a = find(app, "agents", "name = {:n} || id = {:n}", "", 1, { n: ref })
  if (a.length) return { id: a[0].id, login: "" }
  var u = find(app, "users", "id = {:n} || email = {:n} || name = {:n}", "", 1, { n: ref })
  if (!u.length) {
    var byLogin = new DynamicModel({ id: "" })
    try {
      app.db().newQuery("SELECT id FROM users WHERE github_login != '' AND lower(github_login) = {:l} LIMIT 1").bind({ l: ref.toLowerCase() }).one(byLogin)
    } catch (err) {}
    if (byLogin.id) u = [app.findRecordById("users", byLogin.id)]
  }
  if (u.length) return { id: u[0].id, login: u[0].getString("github_login") }
  var seen = new DynamicModel({ n: 0 })
  app.db().newQuery("SELECT COUNT(*) AS n FROM posts WHERE external_id != '' AND lower(json_extract(external,'$.author')) = {:l}").bind({ l: ref.toLowerCase() }).one(seen)
  if (seen.n > 0) return { id: "", login: ref }
  throw E(404, "not_found", "no agent or person '" + ref + "'")
}

routes.search = {
  allow: ["agent", "user"],
  fn: function (e, ctx) {
    var app = e.app
    var qs = e.request.url.query()
    var q = str(qs.get("q")).trim()
    if (!q) throw E(400, "invalid", "q is required")
    if (q.length > 200) throw E(400, "invalid", "q is too long")
    var scope = { limit: Math.max(1, Math.min(100, parseInt(str(qs.get("limit")) || "30", 10) || 30)) }
    if (qs.get("channel")) {
      scope.channel = findChannel(app, qs.get("channel")).id
      requireChannelVisible(ctx, scope.channel)
    }
    if (qs.get("author")) {
      var ar = authorRef(app, qs.get("author"))
      scope.author = ar.id
      scope.authorLogin = ar.login
    }
    if (ctx.type === "agent") scope.agent = ctx.agent.id
    scope.ctx = ctx
    if (str(qs.get("exclude_bots")) === "1") scope.excludeBots = true
    var r = searchRows(app, q, scope)
    var names = new Names(app)
    var taskCache = {}
    var taskOf = function (id) {
      if (!id) return null
      if (taskCache[id] === undefined) {
        try { taskCache[id] = app.findRecordById("tasks", id) } catch (err) { taskCache[id] = null }
      }
      return taskCache[id]
    }
    var results = []
    r.rows.forEach(function (row) {
      var t = taskOf(row.task)
      var item = {
        type: row.kind,
        id: row.rid,
        channel: row.channel,
        channel_name: names.channel(row.channel),
        author: row.author,
        author_name: names.agent(row.author) || names.user(row.author),
        author_quiet: names.quiet(row.author),
        snippet: snippetOf(row.body, r.terms),
        created: row.created,
      }
      if (t) {
        item.task_id = t.id
        item.task_ref = taskRef(t)
        item.task_title = t.getString("title")
      }
      if (row.kind === "post") item.url = linkUrl("p/" + row.rid)
      else if (row.kind === "task") item.url = linkUrl("t/" + (t ? taskRef(t) : row.rid))
      else if (row.kind === "message") item.url = linkUrl("t/" + (t ? taskRef(t) : row.task) + "/m/" + row.rid)
      else if (row.kind === "handoff") {
        try {
          item.version = app.findRecordById("handoff_versions", row.rid).getInt("version")
        } catch (err) {}
        item.url = linkUrl("t/" + (t ? taskRef(t) : row.task) + (item.version ? "@v" + item.version : ""))
      }
      results.push(item)
    })
    // Wiki pages rank above raw posts
    var wikiHits = []
    if (!scope.author && !scope.authorLogin) {
      try {
        wikiHits = require(__hooks + "/ach_wiki.js").searchPages(app, q, 10, ctx.hidden).filter(function (w) { return (!scope.channel || w.channel === scope.channel) && !channelHidden(ctx, w.channel) })
      } catch (werr) { wikiHits = [] }
    }
    if (ctx.type !== "user") { try { require(__hooks + "/ach_wiki.js").logUse(app, "recall", ctx.type === "run" ? ctx.token.getString("task") : "", ctx.agent.id, 0, []) } catch (werr) {} }
    return [200, { query: q, mode: r.mode, use: "Memory pages (type wiki) first; retrieved posts, tasks and handoffs are background only", results: wikiHits.concat(results) }]
  },
}

// ---------------------------------------------------------------- activity

routes.activity = {
  allow: ["user"],
  fn: function (e, ctx) {
    var app = e.app
    var qs = e.request.url.query()
    var limit = Math.max(1, Math.min(200, parseInt(str(qs.get("limit")) || "50", 10) || 50))
    var before = str(qs.get("before")).replace("T", " ")
    // C: since= ("since my last visit"); before= pages back
    var since = str(qs.get("since")).replace("T", " ")
    var excludeBots = str(qs.get("exclude_bots")) === "1"
    var chan = qs.get("channel") ? findChannel(app, qs.get("channel")).id : ""
    requireChannelVisible(ctx, chan)
    var agent = ""
    if (qs.get("agent")) agent = resolveAgent(app, qs.get("agent")).id
    var user = str(qs.get("user")).trim()
    if (user) user = userByRef(app, user).id
    var names = new Names(app)
    var events = []
    var common = function (extra, params) {
      var f = []
      if (before) { f.push("created < {:before}"); params.before = before }
      if (since) { f.push("created > {:since}"); params.since = since }
      if (excludeBots) f.push("(" + extra.agentField + " = '' || " + extra.agentField + ".quiet = false)")
      if (agent) { f.push(extra.agentField + " = {:agent}"); params.agent = agent }
      if (user) {
        if (!extra.userField) return null
        f.push(extra.userField + " = {:user}")
        params.user = user
      }
      if (chan) { f.push(extra.channelField + " = {:chan}"); params.chan = chan }
      var hf = hiddenFilter(extra.channelField, ctx, params)
      if (hf) f.push(hf)
      return f.length ? f.join(" && ") : "id != ''"
    }
    var tasks = {}
    var taskOf = function (id) {
      if (tasks[id] === undefined) {
        try { tasks[id] = app.findRecordById("tasks", id) } catch (err) { tasks[id] = null }
      }
      return tasks[id]
    }
    var line = function (s) { return str(s).replace(/\s+/g, " ").trim().slice(0, 200) }

    var pp = {}
    var pf = common({ agentField: "author_agent", userField: "author_user", channelField: "channel" }, pp)
    if (pf) {
      find(app, "posts", pf + " && kind != 'system'", "-created,-id", limit, pp).forEach(function (p) {
        var t = p.getString("task") ? taskOf(p.getString("task")) : null
        var isTask = p.getString("kind") === "task"
        events.push({
          type: isTask ? "task" : p.getString("parent") ? "reply" : "post",
          at: p.getString("created"),
          id: p.id,
          url: isTask && t ? linkUrl("t/" + taskRef(t)) : linkUrl("p/" + p.id),
          channel_name: names.channel(p.getString("channel")),
          author_type: p.getString("author_type"),
          author_name: postAuthorName(p, names),
          task_ref: t ? taskRef(t) : "",
          title: t ? t.getString("title") : "",
          text: isTask && t ? (t ? names.agent(t.getString("from_agent")) + " → " + names.agent(t.getString("to_agent")) : "") : line(p.getString("body")),
        })
      })
    }
    var hp = {}
    var hf = common({ agentField: "author_agent", userField: "", channelField: "task.channel" }, hp)
    if (hf) {
      find(app, "handoff_versions", hf + " && version > 1", "-created,-id", limit, hp).forEach(function (h) {
        var t = taskOf(h.getString("task"))
        if (!t) return
        events.push({
          type: "handoff",
          at: h.getString("created"),
          id: h.id,
          url: linkUrl("t/" + taskRef(t) + "@v" + h.getInt("version")),
          channel_name: names.channel(t.getString("channel")),
          author_type: "agent",
          author_name: names.agent(h.getString("author_agent")),
          task_ref: taskRef(t),
          title: t.getString("title"),
          text: "v" + h.getInt("version") + ": " + line(h.getString("change_note")),
        })
      })
    }
    var mp = {}
    var mf = common({ agentField: "author_agent", userField: "author_user", channelField: "task.channel" }, mp)
    if (mf) {
      find(app, "messages", mf, "-created,-id", limit, mp).forEach(function (m) {
        var t = taskOf(m.getString("task"))
        if (!t) return
        // C: the "handoff vN: ..." timeline note duplicates the handoff event
        if (m.getString("kind") === "note" && m.getString("author_type") === "agent" && /^handoff v[0-9]+: /.test(m.getString("body"))) return
        var kind = m.getString("kind")
        var type = kind === "result" ? "complete" : kind === "note" && /^failed: /.test(m.getString("body")) ? "fail" : kind
        events.push({
          type: type,
          at: m.getString("created"),
          id: m.id,
          url: linkUrl("t/" + taskRef(t) + "/m/" + m.id),
          channel_name: names.channel(t.getString("channel")),
          author_type: m.getString("author_type"),
          author_name: m.getString("author_type") === "agent" ? names.agent(m.getString("author_agent")) : m.getString("author_type") === "human" ? names.user(m.getString("author_user")) : "system",
          task_ref: taskRef(t),
          title: t.getString("title"),
          text: line(m.getString("body")),
        })
      })
    }
    events.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0 })
    var out = events.slice(0, limit)
    // next page: pass before=<next_before>
    return [200, { events: out, next_before: out.length === limit ? out[out.length - 1].at : "" }]
  },
}

// ---------------------------------------------------------------- summary

// GET /summary?since=: the Home "since yesterday" card, scoped to me (tasks I
// own or my agents hold/sent). since defaults to 24 h ago.
// {since, done: [T], mentions_me: [P], decisions: [{state: pending|made, message, task}],
//  new_posts_by_channel: {name: n}}
routes.summary = {
  allow: ["user"],
  fn: function (e, ctx) {
    var app = e.app
    var names = new Names(app)
    var uid = ctx.user.id
    var since = str(e.request.url.query().get("since")).replace("T", " ").trim()
    if (!since || !parseTime(since)) since = iso(nowMs() - 24 * 3600 * 1000)
    var scope = "(owner_user = {:u} || to_agent.owner = {:u} || from_agent.owner = {:u})"
    var done = find(app, "tasks", scope + " && (status = 'completed' || status = 'failed') && updated > {:s}", "-updated", 50, { u: uid, s: since })
    var myAgents = find(app, "agents", "owner = {:u}", "", 1000, { u: uid }).map(function (a) { return a.id })
    var mentions = find(app, "posts", "created > {:s} && (to_user = {:u}" + myAgents.map(function (id, i) { return " || mentions ~ {:a" + i + "}" }).join("") + ")", "-created", 50,
      (function () {
        var p = { s: since, u: uid }
        myAgents.forEach(function (id, i) { p["a" + i] = id })
        return p
      })())
    var decisions = []
    var decItem = function (m, pending) {
      var t = app.findRecordById("tasks", m.getString("task"))
      return {
        state: pending ? "pending" : "made",
        pending: pending,
        id: m.id,
        task_id: t.id,
        task_ref: taskRef(t),
        ref: taskRef(t),
        title: t.getString("title"),
        body: str(m.getString("body")).replace(/\s+/g, " ").slice(0, 300),
        author_name: msgOut(m, names).author_name,
        url: linkUrl("t/" + taskRef(t) + "/m/" + m.id),
        created: m.getString("created"),
        at: m.getString("created"),
      }
    }
    find(app, "messages", "kind = 'decision_request' && resolved = false && delegated_grant = '' && (to_user = {:u} || also_to ~ {:u})", "-created", 50, { u: uid }).forEach(function (m) {
      decisions.push(decItem(m, true))
    })
    find(app, "messages", "kind = 'decision' && created > {:s} && (author_user = {:u} || task.owner_user = {:u} || task.to_agent.owner = {:u} || task.from_agent.owner = {:u})", "-created", 50, { u: uid, s: since }).forEach(function (m) {
      decisions.push(decItem(m, false))
    })
    var counts = {}
    var rows = arrayOf(new DynamicModel({ channel: "", n: 0 }))
    var sp = { s: since }
    app.db().newQuery("SELECT channel, COUNT(*) AS n FROM posts WHERE (parent = '' OR parent IS NULL) AND kind = 'post' AND created > {:s} AND " + hiddenSql("channel", ctx, sp) + " GROUP BY channel").bind(sp).all(rows)
    rows.forEach(function (r) {
      var n = names.channel(r.channel)
      if (n) counts[n] = r.n
    })
    return [200, {
      since: since,
      done: done.map(function (t) { var o = taskOut(t, names); o.at = t.getString("updated"); return o }),
      mentions_me: mentions.map(function (p) { return postOut(app, p, names, false) }),
      decisions: decisions,
      new_posts_by_channel: counts,
    }]
  },
}

// ---------------------------------------------------------------- my inbox (panel)

// GET /me/inbox?since=: the panel's one Inbox: everything that needs me, newest
// first. since defaults to 7 days ago. Items:
// Replies only: the Inbox is the one way to reach a
// person, and holds only what needs them. A person never "confirms"; they reply.
//  decision       open decision requests to me (always, whatever since says; `choices` when structured)
//  escalation     agent replies and Memory questions addressed to me with no human reply since
//  mention        posts/replies mentioning one of my agents (not by me)
//  reply          replies by others in threads I started or replied in
//  assigned / assigned_external  tasks for my agents not yet claimed; open GitHub items assigned to me
//  memory_digest  one "Memory updated" line per day for completed upkeep runs
// {since, server_time, items: [{type, id, at, url, author_type, author_name, text,
//  pending, task_id, task_ref, title, channel_name, message_id, post_id}]}
routes.myInbox = {
  allow: ["user"],
  fn: function (e, ctx) {
    var app = e.app
    var names = new Names(app)
    var uid = ctx.user.id
    var since = str(e.request.url.query().get("since")).replace("T", " ").trim()
    if (!since || !parseTime(since)) since = iso(nowMs() - 7 * 24 * 3600 * 1000)
    var line = function (s) { return str(s).replace(/\s+/g, " ").trim().slice(0, 300) }
    var items = []
    var seen = {}
    var push = function (key, o) {
      if (seen[key]) return
      seen[key] = true
      items.push(o)
    }
    var taskBits = function (t) {
      return { task_id: t.id, task_ref: taskRef(t), title: t.getString("title"), channel_name: names.channel(t.getString("channel")) }
    }
    var withBits = function (o, bits) { for (var k in bits) o[k] = bits[k]; return o }
    var postItem = function (type, p) {
      var root = p.getString("parent") || p.id
      var o = {
        type: type, id: p.id, at: p.getString("created"), url: linkUrl("p/" + p.id),
        author_type: p.getString("author_type"), author_name: postAuthorName(p, names),
        text: line(p.getString("body")), pending: false, post_id: root,
        channel_name: names.channel(p.getString("channel")),
      }
      var ch = parseJSON(p.getString("choices"))
      if (ch) o.choices = ch
      var tid = p.getString("task")
      if (!tid && p.getString("parent")) {
        try { tid = app.findRecordById("posts", root).getString("task") } catch (err) { tid = "" }
      }
      if (tid) {
        try { withBits(o, taskBits(app.findRecordById("tasks", tid))) } catch (err) { /* deleted */ }
      }
      return o
    }

    // decisions: open requests addressed to me
    find(app, "messages", "kind = 'decision_request' && resolved = false && delegated_grant = '' && (to_user = {:u} || also_to ~ {:u})", "-created", 100, { u: uid }).forEach(function (m) {
      var t
      try { t = app.findRecordById("tasks", m.getString("task")) } catch (err) { return }
      push("m:" + m.id, withBits({
        type: "decision", id: m.id, at: m.getString("created"), url: linkUrl("t/" + taskRef(t) + "/m/" + m.id),
        author_type: m.getString("author_type"), author_name: msgOut(m, names).author_name,
        text: line(m.getString("body")), pending: true, message_id: m.id, choices: parseJSON(m.getString("choices")) || null,
      }, taskBits(t)))
    })
    // new work for my agents: tasks addressed to them that nobody claimed yet
    // (not ones I sent to my own agent). Pending until claimed.
    find(app, "tasks", "status = 'submitted' && to_agent.owner = {:u} && from_agent.owner != {:u}", "-last_activity", 50, { u: uid }).forEach(function (t) {
      push("a:" + t.id, withBits({
        type: "assigned", id: t.id, at: t.getString("last_activity") || t.getString("created"), url: linkUrl("t/" + taskRef(t)),
        author_type: "agent", author_name: names.agent(t.getString("from_agent")),
        to_agent_name: names.agent(t.getString("to_agent")),
        text: "", pending: true, priority: t.getString("priority"),
      }, taskBits(t)))
    })
    // escalations to me (not the admin-wide list)
    openEscalations(app, { isAdmin: false, user: ctx.user }, names).forEach(function (po) {
      var p
      try { p = app.findRecordById("posts", po.id) } catch (err) { return }
      var o = postItem("escalation", p)
      o.pending = true
      push("p:" + p.id, o)
    })
    // mentions of my agents
    var myAgents = find(app, "agents", "owner = {:u}", "", 1000, { u: uid }).map(function (a) { return a.id })
    if (myAgents.length) {
      var mp = { s: since, u: uid }
      var mf = myAgents.map(function (id, i) { mp["a" + i] = id; return "mentions ~ {:a" + i + "}" }).join(" || ")
      find(app, "posts", andHidden("created > {:s} && author_user != {:u} && (" + mf + ")", "channel", ctx, mp), "-created", 100, mp).forEach(function (p) {
        push("p:" + p.id, postItem("mention", p))
      })
    }
    // replies in threads I am in (I wrote the root or a reply), last 30 days of my posts
    var roots = {}
    find(app, "posts", "author_user = {:u} && created > {:old}", "-created", 200, { u: uid, old: iso(nowMs() - 30 * 24 * 3600 * 1000) }).forEach(function (p) {
      roots[p.getString("parent") || p.id] = true
    })
    var rootIds = Object.keys(roots).slice(0, 60)
    if (rootIds.length) {
      var rp = { s: since, u: uid }
      var rf = rootIds.map(function (id, i) { rp["r" + i] = id; return "parent = {:r" + i + "}" }).join(" || ")
      find(app, "posts", andHidden("created > {:s} && author_user != {:u} && kind != 'system' && (" + rf + ")", "channel", ctx, rp), "-created", 100, rp).forEach(function (p) {
        push("p:" + p.id, postItem("reply", p))
      })
    }
    // GitHub issues/PRs assigned to me (imported, still open): pending until a
    // sync closes them or unassigns me
    var login = str(ctx.user.getString("github_login")).toLowerCase()
    if (login) {
      var xp = { l: login }
      var xrows = arrayOf(new DynamicModel({ id: "" }))
      app.db().newQuery(
        "SELECT id FROM posts WHERE external_id != '' AND json_extract(external,'$.state') = 'open' AND " + hiddenSql("channel", ctx, xp) +
        " AND EXISTS(SELECT 1 FROM json_each(json_extract(external,'$.assignees')) WHERE lower(value) = {:l}) " +
        "ORDER BY json_extract(external,'$.updated_at') DESC LIMIT 100"
      ).bind(xp).all(xrows)
      xrows.forEach(function (r) {
        var p
        try { p = app.findRecordById("posts", r.id) } catch (err) { return }
        var x = externalOut(p, names)
        push("x:" + p.id, {
          type: "assigned_external", id: p.id, at: (x.updated_at || p.getString("created")).replace("T", " ").replace("Z", ""), url: linkUrl("p/" + p.id),
          author_type: "external", author_name: x.author_name || x.author, text: x.title, title: x.title,
          ref: x.repo + "#" + x.number, ext_url: x.url, kind: x.kind, state: x.state, pending: true,
          channel_name: names.channel(p.getString("channel")), post_id: p.id,
        })
      })
    }
    // Memory upkeep runs that finished: one "Memory updated" line per day.
    var digest = {}
    find(app, "tasks", "(owner_user = {:u} || from_agent.owner = {:u}) && (status = 'completed' || status = 'failed') && updated > {:s}", "-updated", 200, { u: uid, s: since }).forEach(function (t) {
      // replies only: the Inbox holds what needs me; finished work is not an item (only Memory's daily digest line)
      if (t.getString("system_kind") === "wiki_upkeep" && t.getString("status") === "completed") {
        if (channelHidden(ctx, t.getString("channel"))) return
        var day = t.getString("updated").slice(0, 10)
        var dg = digest[day] || (digest[day] = { at: "", runs: 0, channels: [] })
        if (t.getString("updated") > dg.at) dg.at = t.getString("updated")
        dg.runs++
        var cn = names.channel(t.getString("channel"))
        if (cn && dg.channels.indexOf(cn) < 0) dg.channels.push(cn)
      }
    })
    Object.keys(digest).forEach(function (day) {
      var dg = digest[day]
      push("md:" + day, {
        type: "memory_digest", id: "md:" + day, day: day, at: dg.at, url: linkUrl("m"), author_type: "system", author_name: "Memory",
        text: "Memory updated: " + dg.runs + " upkeep run(s)" + (dg.channels.length ? " in #" + dg.channels.slice(0, 5).join(", #") : ""),
        pending: false, runs: dg.runs, channels: dg.channels,
      })
    })
    items.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0 })
    return [200, { since: since, server_time: iso(nowMs()), items: items.slice(0, 200) }]
  },
}

// ---------------------------------------------------------------- profiles

function costSince(app, filter, params, days) {
  var p = {}
  for (var k in params) p[k] = params[k]
  p.since = iso(nowMs() - days * 24 * 3600 * 1000)
  var rows = find(app, "usage", filter + " && created > {:since}", "", 100000, p)
  var sum = 0
  rows.forEach(function (r) { sum += r.getFloat("cost_usd") })
  return Math.round(sum * 1e6) / 1e6
}

function profilePosts(app, filter, params, names, ctx) {
  var list = find(app, "posts", andHidden(filter + " && kind = 'post'", "channel", ctx, params), "-created,-id", 50, params)
  var byChannel = {}
  var order = []
  list.forEach(function (p) {
    var c = names.channel(p.getString("channel"))
    if (!byChannel[c]) { byChannel[c] = []; order.push(c) }
    byChannel[c].push(postOut(app, p, names, false))
  })
  return order.map(function (c) { return { channel_name: c, posts: byChannel[c] } })
}

routes.agentProfile = {
  allow: ["agent", "user"],
  fn: function (e, ctx) {
    var app = e.app
    var a = resolveAgent(app, e.request.pathValue("name"))
    var names = new Names(app)
    var out = directoryOut(a, names)
    out.owner = a.getString("owner")
    out.url = linkUrl("a/" + a.getString("name"))
    var taskFilter = "to_agent = {:a}"
    var sentFilter = "from_agent = {:a}"
    var params = { a: a.id }
    if (ctx.type === "agent" && ctx.agent.id !== a.id) {
      // another agent sees only tasks it is a party to
      taskFilter += " && from_agent = {:me}"
      sentFilter += " && to_agent = {:me}"
      params.me = ctx.agent.id
    }
    var seeTask = function (t) { return ctx.type !== "user" || userTaskVisible(ctx, t) }
    out.tasks_held = find(app, "tasks", taskFilter, "-last_activity", 50, params).filter(seeTask).map(function (t) { return taskOut(t, names) })
    out.tasks_sent = find(app, "tasks", sentFilter, "-last_activity", 50, params).filter(seeTask).map(function (t) { return taskOut(t, names) })
    out.posts_by_channel = profilePosts(app, "author_agent = {:a}", { a: a.id }, names, ctx)
    out.cost_7d = costSince(app, "agent = {:a}", { a: a.id }, 7)
    out.cost_30d = costSince(app, "agent = {:a}", { a: a.id }, 30)
    return [200, out]
  },
}

routes.userProfile = {
  allow: ["user"],
  fn: function (e, ctx) {
    var app = e.app
    var u = userByRef(app, e.request.pathValue("id"))
    var names = new Names(app)
    var agents = find(app, "agents", "owner = {:u}", "name", 100, { u: u.id })
    var ids = agents.map(function (a) { return a.id })
    var out = {
      id: u.id,
      name: userName(u),
      url: linkUrl("u/" + u.id),
      agents: agents.map(function (a) { return directoryOut(a, names) }),
      role: u.getString("role"),
      github_login: u.getString("github_login"),
      posts_by_channel: profilePosts(app, "author_user = {:u}", { u: u.id }, names, ctx),
      tasks: find(app, "tasks", "owner_user = {:u} || to_agent.owner = {:u}", "-last_activity", 50, { u: u.id })
        .filter(function (t) { return userTaskVisible(ctx, t) })
        .map(function (t) { return taskOut(t, names) }),
      cost_7d: 0,
      cost_30d: 0,
    }
    if (ids.length) {
      out.cost_7d = costSince(app, "agent.owner = {:u}", { u: u.id }, 7)
      out.cost_30d = costSince(app, "agent.owner = {:u}", { u: u.id }, 30)
    }
    return [200, out]
  },
}

// ---------------------------------------------------------------- settings: embeds, storage

function readSetting(app, key) {
  var r = find(app, "hub_settings", "key = {:k}", "", 1, { k: key })
  if (!r.length) return undefined
  return parseJSON(r[0].getString("value"))
}

function writeSetting(app, key, value) {
  var r = find(app, "hub_settings", "key = {:k}", "", 1, { k: key })
  var rec = r.length ? r[0] : new Record(app.findCollectionByNameOrId("hub_settings"))
  rec.set("key", key)
  rec.set("value", value)
  app.save(rec)
}

// The embed host allowlist (bare domains; subdomains included). Cached in the
// app store for the CSP middleware; invalidated on change.
function embedHosts(app) {
  var cached = app.store().get(EMBED_STORE_KEY)
  if (cached) {
    var c = parseJSON(cached)
    if (Array.isArray(c)) return c
  }
  var v = undefined
  try { v = readSetting(app, "embed_hosts") } catch (err) {}
  var list = Array.isArray(v) ? v.map(String) : DEFAULT_EMBED_HOSTS.slice()
  app.store().set(EMBED_STORE_KEY, JSON.stringify(list))
  return list
}

function parseEmbedHosts(v) {
  var list = typeof v === "string" ? v.split(/[\s,]+/) : v
  if (!Array.isArray(list)) throw E(400, "invalid", "embed_hosts must be a list of domains")
  var out = []
  list.forEach(function (d) {
    d = str(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "")
    if (!d) return
    if (d.length > 253 || !DOMAIN_RE.test(d) || d.indexOf(".") < 0) throw E(400, "invalid", "embed host '" + d + "' is not a domain")
    // embed hosts include their subdomains, so a public suffix would allow anyone's site
    if (isPublicSuffix(d)) throw E(400, "public_suffix", "embed host '" + d + "' is a public suffix (anyone can host under it); name the site")
    if (out.indexOf(d) < 0) out.push(d)
  })
  if (out.length > 50) throw E(400, "invalid", "at most 50 embed hosts")
  return out
}

// The panel's Content-Security-Policy, with frame-src built from the embed
// allowlist. Set as a response header by the middleware in
// ach_routes.pb.js on every non-API response.
function panelCsp(app) {
  // Link-preview hosts (img/media) and the bucket origin for direct uploads (img/media/connect)
  var x = { img: [], media: [], connect: [] }
  try { x = require(__hooks + "/ach_storage.js").cspSources(app) } catch (err) {}
  var frames = []
  embedHosts(app).forEach(function (h) {
    frames.push("https://" + h)
    frames.push("https://*." + h)
  })
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:" + (x.img.length ? " " + x.img.join(" ") : ""),
    "media-src 'self' blob:" + (x.media.length ? " " + x.media.join(" ") : ""),
    "connect-src 'self'" + (x.connect.length ? " " + x.connect.join(" ") : ""),
    "frame-src " + (frames.length ? frames.join(" ") : "'none'"),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}

// The panel's top bar name and the public URL (absolute links -> in-app chips).
function workspaceName(app) {
  var v
  try { v = readSetting(app, "workspace_name") } catch (err) {}
  return typeof v === "string" && v.trim() ? v.trim() : str($os.getenv("ACH_WORKSPACE_NAME")).trim() || "AgentChannel"
}

routes.getSettings = {
  allow: ["user"],
  fn: function (e) {
    return [200, { embed_hosts: embedHosts(e.app), workspace_name: workspaceName(e.app), public_url: configuredPublicUrl() }]
  },
}

routes.adminSettings = {
  allow: ["user"],
  fn: function (e, ctx) {
    requireAdmin(ctx)
    if (e.request.method === "GET") return [200, { embed_hosts: embedHosts(e.app), embed_hosts_default: DEFAULT_EMBED_HOSTS.slice(), workspace_name: workspaceName(e.app) }]
    var b = body(e)
    if (b.embed_hosts === undefined && b.workspace_name === undefined) throw E(400, "invalid", "nothing to change (embed_hosts, workspace_name)")
    var list = b.embed_hosts === undefined ? null : parseEmbedHosts(b.embed_hosts)
    var ws = b.workspace_name === undefined ? null : str(b.workspace_name).replace(/[\r\n\t]+/g, " ").trim()
    if (ws !== null && ws.length > 80) throw E(400, "invalid", "workspace_name is too long (max 80)")
    tx(e.app, function (app) {
      if (list) writeSetting(app, "embed_hosts", list)
      if (ws !== null) writeSetting(app, "workspace_name", ws)
    })
    e.app.store().remove(EMBED_STORE_KEY)
    return [200, { embed_hosts: embedHosts(e.app), workspace_name: workspaceName(e.app) }]
  },
}

// Storage used: attachment bytes by collection (from attachments_meta),
// plus the database file size. With S3/R2/TOS storage the same numbers apply.
routes.adminStorage = {
  allow: ["user"],
  fn: function (e, ctx) {
    requireAdmin(ctx)
    var app = e.app
    var by = {}
    var total = 0
    var count = 0
    ;["messages", "handoff_versions", "posts"].forEach(function (c) {
      var row = new DynamicModel({ n: 0, bytes: 0 })
      app.db()
        .newQuery("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(json_extract(value, '$.size') AS INTEGER)), 0) AS bytes FROM " + c + ", json_each(CASE WHEN json_valid(" + c + ".attachments_meta) THEN " + c + ".attachments_meta ELSE '[]' END) WHERE json_extract(value, '$.ref') IS NULL AND json_extract(value, '$.purged') IS NULL")
        .one(row)
      by[c] = { files: row.n, bytes: row.bytes }
      total += row.bytes
      count += row.n
    })
    var dbBytes = 0
    try {
      dbBytes = $os.stat(app.dataDir() + "/data.db").size()
    } catch (err) {}
    var s3 = false
    try { s3 = !!app.settings().s3.enabled } catch (err) {}
    return [200, { attachments_bytes: total, attachments_files: count, by_collection: by, db_bytes: dbBytes, storage: s3 ? "s3" : "local" }]
  },
}

// ---------------------------------------------------------------- dispatch

function send(e, status, obj) {
  return e.json(status, obj)
}

function run(e, name) {
  var r = routes[name]
  pendingNotes = []
  pendingRefs = null
  try {
    var ctx
    if (r.allow[0] === "public") {
      ctx = { type: "public" }
    } else if (r.allow[0] === "superuser") {
      if ($os.getenv("ACH_TEST_HOOKS") !== "1") throw E(404, "not_found", "not found")
      if (!e.hasSuperuserAuth()) throw E(401, "unauthorized", "superuser only")
      ctx = { type: "superuser" }
    } else {
      ctx = authenticate(e)
      requireAuth(ctx, r.allow, r.runModes)
      hiddenChannels(e.app, ctx)
    }
    var out = r.fn(e, ctx)
    if (out === null) return // the route wrote the response itself (file download)
    // P5: notify only after the route's transaction committed.
    try {
      sendNotes(e.app)
    } catch (nerr) {
      e.app.logger().warn("ach notify failed", "error", String(nerr))
    }
    return send(e, out[0], out[1])
  } catch (err) {
    pendingNotes = []
    if (err && err.achError) {
      var payload = { error: err.message, code: err.code }
      if (err.extra) for (var k in err.extra) payload[k] = err.extra[k]
      return send(e, err.status, payload)
    }
    var msg = String((err && err.message) || err)
    if (/UNIQUE constraint/i.test(msg)) return send(e, 409, { error: "conflict", code: "conflict" })
    if (/validation|cannot be blank|must be/i.test(msg)) return send(e, 400, { error: msg, code: "invalid" })
    e.app.logger().error("ach route error", "route", name, "error", msg)
    return send(e, 500, { error: "internal error" + ($os.getenv("ACH_TEST_HOOKS") === "1" ? ": " + msg : ""), code: "internal" })
  }
}

// onFileDownloadRequest: non-media attachments become text/plain downloads.
// Returns true when it wrote the response.
function serveFileHook(e) {
  var rec = e.record
  if (!rec) return false
  var name = str(e.servedName)
  var file = str(e.servedPath).split("/").pop()
  var meta = attOut(rec.collection().name, rec).filter(function (x) { return x.name === file && !x.ref })[0]
  if (!meta || isMediaType(meta.type)) return false
  serveAttachment(e, rec, file, meta)
  return true
}

// Optional chat adapters (pb_hooks/ach_feishu.js): run a route as a caller
// the adapter already verified. A person's reply from a verified Feishu
// callback goes through the same route as the panel button (pushAct does the
// same for push taps). Returns {status, body} or {status, error, code}; queued
// notifications are sent after the route's transaction committed.
function callRoute(app, ctx, name, id, payload, query) {
  var q = query || {}
  var r = (q.table || routes)[name]
  if (!r) throw new Error("no route " + name)
  pendingNotes = []
  var fake = {
    app: app, auth: null,
    request: {
      pathValue: function (k) { return k === "id" ? str(id) : k === "kind" ? str(q.kind) : "" },
      url: { path: "", query: function () { return { get: function (k) { return str(q[k]) } } } },
      header: { get: function () { return "" } },
      method: q.method || "POST",
    },
    requestInfo: function () { return { body: payload || {} } },
    findUploadedFiles: function () { throw new Error("no files") },
  }
  try {
    var out = r.fn(fake, ctx)
    try { sendNotes(app) } catch (nerr) { app.logger().warn("ach notify failed", "error", String(nerr)) }
    return { status: out[0], body: out[1] }
  } catch (err) {
    pendingNotes = []
    if (err && err.achError) return { status: err.status, error: err.message, code: err.code }
    throw err
  }
}

/** A person's own context (human, no admin overrides), for callRoute. */
/** A 10-minute single-use login link a chat adapter (Feishu) DMs to a verified person; never admin-scoped. */
function chatLoginLink(app, u, via) {
  if (!u || u.getBool("deactivated")) throw E(403, "deactivated", "this account is deactivated")
  if (!configuredPublicUrl()) throw E(409, "no_public_url", "ACH_PUBLIC_URL is not set")
  var minted = tx(app, function (txa) { return mintLoginToken(txa, u.id, "device", str(via) + ":" + u.id, "agent", 10 * 60 * 1000) })
  return { url: configuredPublicUrl() + "/#/login/" + minted.token, expires_at: minted.expires_at }
}

function humanCtx(app, u) {
  var ctx = { type: "user", user: u, scope: "", adminRole: u.getBool("is_admin"), isAdmin: false }
  hiddenChannels(app, ctx)
  return ctx
}

module.exports = {
  run: run,
  sweep: sweep,
  BOOT_KEY: BOOT_KEY,
  callRoute: callRoute,
  humanCtx: humanCtx,
  chatLoginLink: chatLoginLink,
  personByRef: personByRef,
  channelMemberOf: channelMemberOf,
  authenticate: authenticate,
  requireAuth: requireAuth,
  requireAdmin: requireAdmin,
  nowMs: nowMs,
  panelCsp: panelCsp,
  serveFileHook: serveFileHook,
  scopeAuth: scopeAuth,
  passwordAuthHook: passwordAuthHook,
  passwordResetHook: passwordResetHook,
  requestOtpHook: requestOtpHook,
  configuredPublicUrl: configuredPublicUrl,
  // shared with ach_storage.js
  storageDeps: function () {
    return {
      authenticate: authenticate, requireAuth: requireAuth, requireAdmin: requireAdmin, bearerOf: bearerOf, hiddenChannels: hiddenChannels,
      channelHidden: channelHidden, requireChannelVisible: requireChannelVisible, findTask: findTask, findChannel: findChannel,
      findOr404: findOr404, threadRoot: threadRoot, requireRunThread: requireRunThread, runScope: runScope, checkRunTask: checkRunTask,
      isParty: isParty, tx: tx, body: body, iso: iso, nowMs: nowMs, readSetting: readSetting, writeSetting: writeSetting,
      isPublicSuffix: isPublicSuffix, DOMAIN_RE: DOMAIN_RE, TERMINAL: TERMINAL,
    }
  },
  // shared with ach_wiki.js
  wikiDeps: function () {
    return {
      authenticate: authenticate, requireAuth: requireAuth, requireAdmin: requireAdmin, adminDenied: adminDenied,
      findTask: findTask, taskRef: taskRef, linkUrl: linkUrl, moneyImpact: moneyImpact, MONEY_RE: MONEY_RE,
      Names: Names, userName: userName, iso: iso, nowMs: nowMs, parseTime: parseTime, readSetting: readSetting,
      writeSetting: writeSetting, generalChannel: generalChannel, findChannel: findChannel, findOr404: findOr404,
      tx: tx, body: body, sendNotes: sendNotes, addMsg: addMsg, notify: notify, notifyPost: notifyPost,
      parseChoices: parseChoices, choicesBody: choicesBody, optionText: optionText, recMark: recMark, defaultLang: defaultLang, postOut: postOut,
      hiddenChannels: hiddenChannels, channelHidden: channelHidden, requireChannelVisible: requireChannelVisible,
      hiddenFilter: hiddenFilter, andHidden: andHidden, hiddenSql: hiddenSql, viewerOf: viewerOf,
      cfIdentity: cfIdentity,
    }
  },
}
