/// <reference path="../pb_data/types.d.ts" />
// Team onboarding from GitHub: import apply/state (admin) and the per-person
// welcome view. Loaded with require() from ach_routes.pb.js ("import/onboarding
// routes" block). Kept separate from ach_lib.js on purpose.
//
// The hub never talks to GitHub and never stores a GitHub token: `ach admin
// import github` reads GitHub with the admin's own `gh` login and pushes a plan
// (channels + people) and compact items (issues/PRs) here. Everything is an
// idempotent upsert: channels by name, people by github_login (then email),
// items by external_id "github:owner/name#123".
// Keep ES5-style (goja).

var CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
var LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/
var REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
var KINDS = ["github_issue", "github_pr"]
var STATES = ["open", "closed", "merged"]
var MAX_ITEMS = 500
var EXCERPT_MAX = 600
var STATS_KEY = "ach_import_stats"
var STATE_PREFIX = "ach_import:"
var BOT_RE = /\[bot\]$/i

function AchError(status, code, message) {
  this.status = status
  this.code = code
  this.message = message
  this.achError = true
}
function E(status, code, message) {
  return new AchError(status, code, message)
}
function str(v) {
  if (v === undefined || v === null) return ""
  return String(v)
}
function arr(v) {
  return Array.isArray(v) ? v : []
}
function parseJSON(s) {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch (err) {
    return null
  }
}
function lower(s) {
  return str(s).trim().toLowerCase()
}
function find(app, coll, filter, sort, limit, params) {
  return app.findRecordsByFilter(coll, filter, sort || "", limit || 1000, 0, params || {})
}
function linkUrl(path) {
  var base = str($os.getenv("ACH_PUBLIC_URL")).trim().replace(/\/+$/, "")
  return base + "/#/" + path
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
function body(e) {
  try {
    return e.requestInfo().body || {}
  } catch (err) {
    throw E(400, "bad_json", "request body must be JSON")
  }
}
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

// ---- auth: people only (an agent key never imports or sees a welcome page)

function authenticate(e) {
  var h = str(e.request.header.get("Authorization")).trim()
  var tok = h.toLowerCase().indexOf("bearer ") === 0 ? h.slice(7).trim() : h
  if (tok.indexOf("ach_") === 0) throw E(403, "forbidden", "this route needs a person's session, not an agent key")
  if (!e.auth || e.auth.collection().name !== "users") {
    if (tok) throw E(401, "session_ended", "your session ended; log in again")
    throw E(401, "unauthorized", "missing or invalid credentials")
  }
  if (e.auth.getBool("deactivated")) throw E(401, "deactivated", "this account is deactivated")
  var scope = ""
  try {
    var c = $security.parseUnverifiedJWT(tok)
    scope = str(c && c.ach_scope)
  } catch (err) {}
  var role = e.auth.getBool("is_admin")
  return { user: e.auth, scope: scope, adminRole: role, isAdmin: role && scope !== "agent" }
}

function requireAdmin(ctx) {
  if (ctx.isAdmin) return
  if (ctx.adminRole && ctx.scope === "agent") {
    throw E(403, "needs_admin_login", "this session was opened from an agent key and cannot use admin actions; log in with a device link or login link")
  }
  throw E(403, "forbidden", "admin only")
}

// ---- helpers

function repoKey(r) {
  return lower(r)
}

function channelRepos(c) {
  return arr(parseJSON(c.getString("repos"))).map(function (x) { return str(x) }).filter(function (x) { return REPO_RE.test(x) })
}

function userByLogin(app, login) {
  if (!login) return null
  var n = new DynamicModel({ id: "" })
  try {
    app.db().newQuery("SELECT id FROM users WHERE github_login != '' AND lower(github_login) = {:l} LIMIT 1").bind({ l: lower(login) }).one(n)
  } catch (err) {
    return null
  }
  return n.id ? app.findRecordById("users", n.id) : null
}

function userName(u) {
  var n = u.getString("name")
  if (n) return n
  var em = u.getString("email")
  return em ? em.split("@")[0] : u.id
}

function personOut(u) {
  return {
    id: u.id,
    name: userName(u),
    email: u.getString("email"),
    github_login: u.getString("github_login"),
    feishu_mapped: !!u.getString("feishu_open_id"),
    feishu_open_id: u.getString("feishu_open_id"),
    role: u.getString("role"),
    is_admin: u.getBool("is_admin"),
    deactivated: u.getBool("deactivated"),
  }
}

function newPerson(app, name, email, isAdmin) {
  var u = new Record(app.findCollectionByNameOrId("users"))
  if (email) u.setEmail(email)
  // random, never shown: people log in with one-time links (same as admin create-user)
  u.setPassword($security.randomString(48))
  u.setVerified(true)
  u.set("name", name)
  u.set("is_admin", !!isAdmin)
  u.set("deactivated", false)
  return u
}

function cleanExcerpt(s) {
  var t = str(s)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
    .replace(/<img[^>]*>/gi, "[image]")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (t.length > EXCERPT_MAX) t = t.slice(0, EXCERPT_MAX - 1).replace(/\s+\S*$/, "") + "…"
  return t
}

function isoDay(s) {
  return str(s).slice(0, 10)
}

// The compact post body for an imported item: one tag line, the title, who,
// a short excerpt and the link back. Never the comment thread.
function itemBody(it) {
  var tag = it.kind === "github_pr" ? "[PR]" : "[issue]"
  var who = "by " + (it.author || "unknown")
  if (it.assignees.length) who += " · assigned " + it.assignees.join(", ")
  var lines = [
    tag + " **" + it.title.replace(/\*/g, "\\*") + "**",
    it.repo + "#" + it.number + " · " + it.state + " · " + who + " · updated " + isoDay(it.updated_at),
  ]
  if (it.excerpt) {
    lines.push("")
    it.excerpt.split("\n").forEach(function (l) { lines.push("> " + l) })
  }
  lines.push("")
  lines.push(it.url)
  return lines.join("\n")
}

function parseItem(raw) {
  if (!raw || typeof raw !== "object") throw E(400, "invalid", "each item must be an object")
  var kind = str(raw.kind)
  if (KINDS.indexOf(kind) < 0) throw E(400, "invalid", "item.kind must be github_issue or github_pr")
  var repo = str(raw.repo).trim()
  if (!REPO_RE.test(repo)) throw E(400, "invalid", "item.repo must be owner/name")
  var number = parseInt(raw.number, 10)
  if (!(number > 0)) throw E(400, "invalid", "item.number must be a positive integer")
  var url = str(raw.url).trim()
  if (!/^https:\/\/[A-Za-z0-9.-]+\/\S+$/.test(url) || url.length > 500) throw E(400, "invalid", "item.url must be an https URL")
  var state = lower(raw.state)
  if (STATES.indexOf(state) < 0) throw E(400, "invalid", "item.state must be open, closed or merged")
  var title = str(raw.title).replace(/[\r\n\t]+/g, " ").trim().slice(0, 300) || "(untitled)"
  var author = str(raw.author).trim()
  if (author && !LOGIN_RE.test(author.replace(BOT_RE, ""))) author = ""
  var assignees = arr(raw.assignees).map(function (x) { return str(x).trim() }).filter(function (x) { return LOGIN_RE.test(x) }).slice(0, 20)
  return {
    kind: kind,
    repo: repo,
    number: number,
    url: url,
    state: state,
    title: title,
    author: author,
    assignees: assignees,
    created_at: str(raw.created_at).slice(0, 40),
    updated_at: str(raw.updated_at).slice(0, 40),
    excerpt: cleanExcerpt(raw.excerpt),
    labels: arr(raw.labels).map(function (x) { return str(x && typeof x === "object" ? x.name : x).replace(/[\r\n\t]+/g, " ").trim().slice(0, 60) }).filter(function (x) { return x }).slice(0, 20),
  }
}

function externalOf(it) {
  return {
    kind: it.kind,
    repo: it.repo,
    number: it.number,
    url: it.url,
    state: it.state,
    title: it.title,
    author: it.author,
    assignees: it.assignees,
    created_at: it.created_at,
    updated_at: it.updated_at,
    excerpt: it.excerpt,
    labels: it.labels,
  }
}

// key-order independent JSON (the hub stores JSON objects with sorted keys)
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]"
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]) }).join(",") + "}"
  return JSON.stringify(v === undefined ? null : v)
}

function externalId(it) {
  return "github:" + repoKey(it.repo) + "#" + it.number
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

// repo (lowercase) -> channel record, over every channel's repos.
function repoIndex(app) {
  var idx = {}
  find(app, "channels", "id != ''", "created", 10000, {}).forEach(function (c) {
    channelRepos(c).forEach(function (r) { idx[repoKey(r)] = c })
  })
  return idx
}

// ---- plan: channels

function applyChannels(app, ctx, chans, counts) {
  var seen = {}
  var planned = {}
  chans.forEach(function (pc) {
    var name = lower(str(pc.name).replace(/^#/, ""))
    if (!CHANNEL_NAME_RE.test(name)) throw E(400, "invalid_name", "channel name '" + str(pc.name) + "' must match ^[a-z0-9][a-z0-9_-]{0,39}$")
    if (planned[name]) throw E(400, "invalid", "channel #" + name + " is listed twice in the plan")
    var repos = arr(pc.repos).map(function (r) { return str(r).trim() })
    repos.forEach(function (r) {
      if (!REPO_RE.test(r)) throw E(400, "invalid", "repo '" + r + "' must be owner/name")
      if (seen[repoKey(r)]) throw E(400, "invalid", "repo " + r + " is mapped to both #" + seen[repoKey(r)] + " and #" + name)
      seen[repoKey(r)] = name
    })
    var vis = pc.private === true ? "private" : lower(pc.visibility)
    if (vis && vis !== "team" && vis !== "private") throw E(400, "invalid", "channel #" + name + ": visibility must be team or private")
    if (vis === "private" && name === "general") throw E(400, "invalid", "#general is always team-visible")
    planned[name] = { name: name, title: str(pc.title).replace(/[\r\n\t]+/g, " ").trim().slice(0, 200), description: str(pc.description).slice(0, 2000), repos: repos, visibility: vis }
  })
  // a repo the plan maps elsewhere leaves its old channel
  find(app, "channels", "id != ''", "", 10000, {}).forEach(function (c) {
    if (planned[c.getString("name")]) return
    var cur = channelRepos(c)
    var keep = cur.filter(function (r) { return !seen[repoKey(r)] })
    if (keep.length !== cur.length) {
      c.set("repos", keep)
      app.save(c)
    }
  })
  var out = []
  Object.keys(planned).forEach(function (name) {
    var p = planned[name]
    var ex = find(app, "channels", "name = {:n}", "", 1, { n: name })
    var c
    if (ex.length) {
      c = ex[0]
      var changed = JSON.stringify(channelRepos(c)) !== JSON.stringify(p.repos)
      if (p.description && !c.getString("description")) { c.set("description", p.description); changed = true }
      if (p.title && !c.getString("title")) { c.set("title", p.title); changed = true }
      if (c.getBool("archived")) { c.set("archived", false); changed = true }
      if (p.visibility && c.getString("visibility") !== p.visibility) { c.set("visibility", p.visibility); changed = true }
      c.set("repos", p.repos)
      if (changed) {
        app.save(c)
        counts.channels_updated++
      }
    } else {
      c = new Record(app.findCollectionByNameOrId("channels"))
      c.set("name", name)
      c.set("title", p.title)
      c.set("description", p.description)
      c.set("visibility", p.visibility || "team")
      c.set("created_by", ctx.user.id)
      c.set("archived", false)
      c.set("repos", p.repos)
      app.save(c)
      counts.channels_created++
    }
    out.push({ id: c.id, name: name, repos: p.repos, visibility: c.getString("visibility") || "team", url: linkUrl("c/" + name) })
  })
  return out
}

// ---- plan: people

function applyPeople(app, ctx, people, counts) {
  var out = []
  var skipped = []
  people.forEach(function (pp) {
    if (!pp || typeof pp !== "object") throw E(400, "invalid", "each person must be an object")
    var login = str(pp.github_login).trim()
    if (login && !LOGIN_RE.test(login)) throw E(400, "invalid", "github_login '" + login + "' is not a GitHub login")
    var email = lower(pp.email)
    if (email && (!EMAIL_RE.test(email) || email.length > 200)) throw E(400, "invalid", "email '" + email + "' is not valid")
    var name = str(pp.name).replace(/[\r\n\t]+/g, " ").trim().slice(0, 200)
    var feishu = str(pp.feishu_open_id).trim().slice(0, 200)
    var role = str(pp.role).replace(/[\r\n\t]+/g, " ").trim().slice(0, 200)
    var chans = arr(pp.channels).map(function (c) { return lower(str(c).replace(/^#/, "")) }).filter(function (c) { return CHANNEL_NAME_RE.test(c) })
    if (pp.invite === false || pp.bot === true) {
      skipped.push(login || name)
      return
    }
    var u = null
    var how = "matched"
    if (pp.self === true) u = app.findRecordById("users", ctx.user.id)
    if (!u && login) u = userByLogin(app, login)
    if (!u && email) {
      try {
        u = app.findAuthRecordByEmail("users", email)
      } catch (err) {
        u = null
      }
    }
    if (!u) {
      if (!name && !login) throw E(400, "invalid", "a person needs a name or github_login")
      if (pp.create === false || (!name && pp.match_only === true)) {
        skipped.push(login || name)
        return
      }
      u = newPerson(app, name || login, email, pp.is_admin === true)
      how = "created"
    }
    if (login) {
      var other = userByLogin(app, login)
      if (other && other.id !== u.id) throw E(409, "conflict", "github_login " + login + " already belongs to " + userName(other))
      if (!u.getString("github_login")) u.set("github_login", login)
    }
    if (feishu) u.set("feishu_open_id", feishu)
    var roleChanged = role && u.getString("role") !== role
    if (roleChanged) u.set("role", role)
    if (how === "created" || login || feishu || roleChanged) app.save(u)
    // the plan's channels for this person become real membership (never removed here)
    chans.forEach(function (cn) {
      var cr = find(app, "channels", "name = {:n}", "", 1, { n: cn })
      if (!cr.length) return
      var mem = arr(cr[0].getStringSlice("members"))
      if (mem.indexOf(u.id) >= 0) return
      mem.push(u.id)
      cr[0].set("members", mem)
      app.save(cr[0])
      counts.memberships_added++
    })
    if (how === "created") counts.people_created++
    else counts.people_matched++
    var o = personOut(u)
    o.status = how
    out.push(o)
  })
  return { people: out, skipped: skipped }
}

// ---- items

function applyItems(app, items, counts) {
  var idx = repoIndex(app)
  var byLogin = {}
  var authorOf = function (login) {
    var k = lower(login.replace(BOT_RE, ""))
    if (!k) return ""
    if (byLogin[k] === undefined) {
      var u = BOT_RE.test(login) ? null : userByLogin(app, k)
      byLogin[k] = u ? u.id : ""
    }
    return byLogin[k]
  }
  var general = null
  var postsColl = app.findCollectionByNameOrId("posts")
  items.forEach(function (raw) {
    var it = parseItem(raw)
    var ch = idx[repoKey(it.repo)]
    if (!ch) {
      if (!general) general = generalChannel(app)
      ch = general
      counts.items_unmapped++
    }
    var xid = externalId(it)
    var ext = externalOf(it)
    var text = itemBody(it)
    var ex = find(app, "posts", "external_id = {:x}", "", 1, { x: xid })
    if (ex.length) {
      var p = ex[0]
      var au = authorOf(it.author)
      var same = p.getString("body") === text && p.getString("channel") === ch.id && canon(parseJSON(p.getString("external"))) === canon(ext) &&
        p.getString("author_type") === "external" && p.getString("author_user") === au
      if (same) {
        counts.items_unchanged++
        return
      }
      var wasOpen = str((parseJSON(p.getString("external")) || {}).state) === "open"
      p.set("body", text)
      p.set("external", ext)
      p.set("channel", ch.id)
      p.set("author_type", "external")
      p.set("author_user", au)
      app.save(p)
      counts.items_updated++
      // An imported issue/PR that closed is a wiki upkeep trigger
      if (wasOpen && it.state !== "open") require(__hooks + "/ach_wiki.js").onImportClosed(app, p, ext)
      return
    }
    var np = new Record(postsColl)
    np.set("channel", ch.id)
    np.set("author_type", "external")
    np.set("author_user", authorOf(it.author))
    np.set("kind", "post")
    np.set("body", text)
    np.set("external", ext)
    np.set("external_id", xid)
    app.save(np)
    // the stream shows the item where it happened on GitHub
    var when = Date.parse(it.created_at || it.updated_at)
    if (when > 0) {
      var ts = new Date(when).toISOString().replace("T", " ")
      app.db().newQuery("UPDATE posts SET created = {:c} WHERE id = {:id}").bind({ c: ts, id: np.id }).execute()
    }
    counts.items_created++
  })
}

// Older closed/merged items (the CLI's default import posts only open items and
// ones closed in the last days): links only, kept for the wiki seed. One that
// was posted before just gets its state updated.
function applyArchive(app, list, counts) {
  if (!list.length) return
  var cutoff = seedCutoff(importRanges(app))
  var idx = repoIndex(app)
  var general = null
  var wiki = require(__hooks + "/ach_wiki.js")
  var byChannel = {}
  list.forEach(function (raw) {
    if (!raw || typeof raw !== "object") throw E(400, "invalid", "each archive entry must be an object")
    var kind = str(raw.kind)
    if (KINDS.indexOf(kind) < 0) throw E(400, "invalid", "archive.kind must be github_issue or github_pr")
    var repo = str(raw.repo).trim()
    if (!REPO_RE.test(repo)) throw E(400, "invalid", "archive.repo must be owner/name")
    var number = parseInt(raw.number, 10)
    if (!(number > 0)) throw E(400, "invalid", "archive.number must be a positive integer")
    var url = str(raw.url).trim()
    if (!/^https:\/\/[A-Za-z0-9.-]+\/\S+$/.test(url) || url.length > 500) throw E(400, "invalid", "archive.url must be an https URL")
    var state = lower(raw.state)
    if (STATES.indexOf(state) < 0) throw E(400, "invalid", "archive.state must be open, closed or merged")
    var title = str(raw.title).replace(/[\r\n\t]+/g, " ").trim().slice(0, 300) || "(untitled)"
    var at = str(raw.closed_at || raw.updated_at).slice(0, 40)
    var xid = "github:" + repoKey(repo) + "#" + number
    var ex = find(app, "posts", "external_id = {:x}", "", 1, { x: xid })
    if (ex.length) {
      var p = ex[0]
      var x = parseJSON(p.getString("external")) || {}
      if (x.state !== state) {
        var wasOpen = x.state === "open"
        x.state = state
        if (raw.updated_at) x.updated_at = str(raw.updated_at).slice(0, 40)
        x.assignees = arr(x.assignees)
        x.excerpt = str(x.excerpt)
        p.set("external", x)
        p.set("body", itemBody(x))
        app.save(p)
        counts.items_updated++
        if (wasOpen && state !== "open") wiki.onImportClosed(app, p, x)
      }
    }
    var ch = idx[repoKey(repo)]
    if (!ch) {
      if (!general) general = generalChannel(app)
      ch = general
    }
    if (cutoff && at && at < cutoff) { counts.archive_too_old++; return }
    byChannel[ch.id] = byChannel[ch.id] || []
    byChannel[ch.id].push({ ref: repo + "#" + number, kind: kind, title: title, url: url, state: state, at: at })
    counts.archived++
  })
  Object.keys(byChannel).forEach(function (cid) { wiki.recordArchive(app, cid, byChannel[cid]) })
}

// Import ranges: two separate settings.
// - post_closed_days: closed/merged items newer than this become channel posts
//   (open items always do). Default 7.
// - seed: items used to seed Memory (links only): the last seed_months months
//   (default 6) or "all". Older archive entries are dropped by the hub too.
var RANGES_KEY = "ach_import_ranges"
var DEFAULT_RANGES = { post_closed_days: 7, seed_months: 6, seed_all: false }
function importRanges(app) {
  var v = readSetting(app, RANGES_KEY) || {}
  return {
    post_closed_days: v.post_closed_days === undefined ? DEFAULT_RANGES.post_closed_days : v.post_closed_days,
    seed_months: v.seed_months === undefined ? DEFAULT_RANGES.seed_months : v.seed_months,
    seed_all: !!v.seed_all,
  }
}
function cleanRanges(raw, cur) {
  if (!raw || typeof raw !== "object") throw E(400, "invalid", "ranges must be an object {post_closed_days, seed_months | seed: \"all\"}")
  var out = { post_closed_days: cur.post_closed_days, seed_months: cur.seed_months, seed_all: cur.seed_all }
  if (raw.post_closed_days !== undefined) {
    var d = Number(raw.post_closed_days)
    if (!(Math.floor(d) === d && d >= 0 && d <= 3650)) throw E(400, "invalid", "ranges.post_closed_days must be a whole number 0–3650")
    out.post_closed_days = d
  }
  if (raw.seed === "all" || raw.seed_all === true) { out.seed_all = true }
  else if (raw.seed_months !== undefined) {
    var m = Number(raw.seed_months)
    if (!(Math.floor(m) === m && m >= 1 && m <= 240)) throw E(400, "invalid", "ranges.seed_months must be a whole number 1–240 (or seed: \"all\")")
    out.seed_months = m
    out.seed_all = false
  }
  return out
}
function seedCutoff(ranges) {
  if (ranges.seed_all) return ""
  var d = new Date(Date.now())
  d.setUTCMonth(d.getUTCMonth() - ranges.seed_months)
  return d.toISOString()
}

// commit/issue counts per channel and login, sent by the CLI (no bots).
function mergeStats(app, stats) {
  if (!stats || typeof stats !== "object") return
  var cur = readSetting(app, STATS_KEY) || {}
  Object.keys(stats).forEach(function (chName) {
    var name = lower(chName)
    if (!CHANNEL_NAME_RE.test(name)) return
    var per = stats[chName] || {}
    var clean = {}
    Object.keys(per).slice(0, 200).forEach(function (login) {
      if (!LOGIN_RE.test(login)) return
      var s = per[login] || {}
      clean[login] = { commits: Math.max(0, parseInt(s.commits, 10) || 0) }
    })
    cur[name] = clean
  })
  writeSetting(app, STATS_KEY, cur)
}

// ---------------------------------------------------------------- routes

var routes = {}

// GET /api/ach/admin/import/state[?source=github:org]: what the hub knows
// (last sync per source, channel repo mappings, people with github logins).
routes.importState = {
  admin: true,
  fn: function (e, ctx) {
    var app = e.app
    var source = str(e.request.url.query().get("source")).trim()
    var sources = {}
    find(app, "hub_settings", "key ~ {:p}", "key", 1000, { p: STATE_PREFIX + "%" }).forEach(function (r) {
      var k = r.getString("key").slice(STATE_PREFIX.length)
      if (!source || k === source) sources[k] = parseJSON(r.getString("value"))
    })
    var chans = find(app, "channels", "id != ''", "name", 10000, {}).map(function (c) {
      return { id: c.id, name: c.getString("name"), archived: c.getBool("archived"), repos: channelRepos(c) }
    })
    // open imported items assigned to each GitHub login (the invite text adapts to 0)
    var asg = arrayOf(new DynamicModel({ login: "", n: 0 }))
    app.db().newQuery("SELECT lower(j.value) AS login, COUNT(*) AS n FROM posts p, json_each(json_extract(p.external,'$.assignees')) j WHERE p.external_id != '' AND json_extract(p.external,'$.state') = 'open' GROUP BY lower(j.value)").all(asg)
    var asgBy = {}
    asg.forEach(function (r) { asgBy[r.login] = r.n })
    var people = find(app, "users", "id != ''", "name", 100000, {}).map(function (u) {
      var o = personOut(u)
      o.assigned_open = o.github_login ? asgBy[lower(o.github_login)] || 0 : 0
      return o
    })
    return [200, { sources: sources, channels: chans, people: people, ranges: importRanges(app), range_defaults: DEFAULT_RANGES }]
  },
}

// POST /api/ach/admin/import/apply {source, plan?: {channels, people}, items?,
// stats?, sync?: {at, since}}. Idempotent; call it in chunks of ≤ 500 items.
routes.importApply = {
  admin: true,
  fn: function (e, ctx) {
    var b = body(e)
    var source = str(b.source).trim()
    if (!/^github:[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(source)) throw E(400, "invalid", "source must be github:<org>")
    var items = arr(b.items)
    if (items.length > MAX_ITEMS) throw E(400, "invalid", "at most " + MAX_ITEMS + " items per request")
    var archive = arr(b.archive)
    if (archive.length > 5000) throw E(400, "invalid", "at most 5000 archive entries per request")
    var plan = b.plan && typeof b.plan === "object" ? b.plan : null
    var counts = {
      channels_created: 0, channels_updated: 0, people_created: 0, people_matched: 0,
      items_created: 0, items_updated: 0, items_unchanged: 0, items_unmapped: 0,
      memberships_added: 0, archived: 0, archive_too_old: 0,
    }
    return tx(e.app, function (app) {
      var out = { counts: counts }
      if (b.ranges !== undefined) writeSetting(app, RANGES_KEY, cleanRanges(b.ranges, importRanges(app)))
      out.ranges = importRanges(app)
      if (plan) {
        if (plan.channels !== undefined) out.channels = applyChannels(app, ctx, arr(plan.channels), counts)
        if (plan.people !== undefined) {
          var pr = applyPeople(app, ctx, arr(plan.people), counts)
          out.people = pr.people
          out.skipped_people = pr.skipped
        }
      }
      applyItems(app, items, counts)
      applyArchive(app, archive, counts)
      // releases published since the last sync: a channel line + a "release" notification (ach_notify.js)
      if (b.releases !== undefined) require(__hooks + "/ach_notify.js").importReleases(app, arr(b.releases), counts)
      if (b.stats) mergeStats(app, b.stats)
      if (b.sync && typeof b.sync === "object") {
        var at = str(b.sync.at)
        if (!(Date.parse(at) > 0)) throw E(400, "invalid", "sync.at must be an ISO time")
        var prev = readSetting(app, STATE_PREFIX + source) || {}
        writeSetting(app, STATE_PREFIX + source, {
          last_sync: at,
          since: str(b.sync.since) || prev.since || "",
          first_import: prev.first_import || at,
          by: ctx.user.id,
        })
      }
      return [200, out]
    })
  },
}

function itemRow(r, chNames) {
  var x = parseJSON(r.external) || {}
  return {
    post_id: r.id,
    post_url: linkUrl("p/" + r.id),
    channel: chNames[r.channel] || "",
    kind: str(x.kind),
    ref: str(x.repo) + "#" + str(x.number),
    title: str(x.title),
    url: str(x.url),
    state: str(x.state),
    author: str(x.author),
    assignees: arr(x.assignees),
    updated_at: str(x.updated_at),
  }
}

// GET /api/ach/me/welcome: what a person sees first. Only channels the person
// may see (private channels: members and admins).
routes.welcome = {
  admin: false,
  fn: function (e, ctx) {
    var app = e.app
    var me = app.findRecordById("users", ctx.user.id)
    var login = me.getString("github_login")
    var lib = require(__hooks + "/ach_lib.js").wikiDeps()
    var hidden = lib.hiddenChannels(app, { type: "user", user: me })
    var chNames = {}
    var chRecs = find(app, "channels", "archived = false", "name", 10000, {}).filter(function (c) { return hidden.indexOf(c.id) < 0 })
    chRecs.forEach(function (c) { chNames[c.id] = c.getString("name") })

    var assigned = []
    var opened = []
    var perChannel = {}
    var openPer = {} // open work per channel: GitHub items assigned to me (3) or opened by me (1), hub tasks for me or my agents (3)
    find(app, "tasks", "channel != '' && (status = 'submitted' || status = 'working' || status = 'input-required') && (owner_user = {:u} || to_agent.owner = {:u})", "", 2000, { u: me.id }).forEach(function (t) {
      if (chNames[t.getString("channel")]) openPer[t.getString("channel")] = (openPer[t.getString("channel")] || 0) + 3
    })
    if (login) {
      var rows = arrayOf(new DynamicModel({ id: "", channel: "", external: "", mine_assigned: 0, mine_author: 0 }))
      app.db().newQuery(
        "SELECT id, channel, external, " +
        "EXISTS(SELECT 1 FROM json_each(json_extract(external,'$.assignees')) WHERE lower(value) = {:l}) AS mine_assigned, " +
        "(lower(json_extract(external,'$.author')) = {:l}) AS mine_author " +
        "FROM posts WHERE external_id != '' AND (lower(json_extract(external,'$.author')) = {:l} " +
        "OR EXISTS(SELECT 1 FROM json_each(json_extract(external,'$.assignees')) WHERE lower(value) = {:l})) " +
        "ORDER BY json_extract(external,'$.updated_at') DESC LIMIT 2000"
      ).bind({ l: lower(login) }).all(rows)
      rows.forEach(function (r) {
        if (!chNames[r.channel]) return
        perChannel[r.channel] = (perChannel[r.channel] || 0) + 1
        var row = itemRow(r, chNames)
        if (row.state !== "open") return
        openPer[r.channel] = (openPer[r.channel] || 0) + (r.mine_assigned ? 3 : 1)
        if (r.mine_assigned) assigned.push(row)
        else if (r.mine_author) opened.push(row)
      })
    }
    var stats = readSetting(app, STATS_KEY) || {}
    var myCommits = function (name) {
      var st = stats[name] || {}
      var n = 0
      Object.keys(st).forEach(function (k) { if (login && lower(k) === lower(login)) n += st[k].commits || 0 })
      return n
    }

    // wiki pages per channel (titles + links)
    var wikiBy = {}
    find(app, "wiki_pages", "channel != ''", "title", 2000, {}).forEach(function (p) {
      var cid = p.getString("channel")
      if (!chNames[cid]) return
      wikiBy[cid] = wikiBy[cid] || []
      if (wikiBy[cid].length < 8) wikiBy[cid].push({ slug: p.getString("slug"), title: p.getString("title"), url: linkUrl("m/" + p.getString("slug")) })
    })

    // channels: mine (member, or my items) first, by my activity; #general always mine.
    var chans = chRecs.map(function (c) {
      var name = c.getString("name")
      var member = arr(c.getStringSlice("members")).indexOf(me.id) >= 0
      var activity = (perChannel[c.id] || 0) + myCommits(name)
      return {
        id: c.id,
        name: name,
        title: c.getString("title") || name,
        description: c.getString("description"),
        visibility: c.getString("visibility") || "team",
        repos: channelRepos(c),
        url: linkUrl("c/" + name),
        member: member,
        my_items: perChannel[c.id] || 0,
        my_open: openPer[c.id] || 0,
        my_activity: activity,
        mine: member || !!perChannel[c.id] || !!openPer[c.id] || name === "general",
        wiki: wikiBy[c.id] || [],
      }
    })
    chans.sort(function (a, b) {
      return (b.mine - a.mine) || (b.member - a.member) || (b.my_activity - a.my_activity) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    })
    // the channel to land on: my most active one (members first), else #general.
    // Admins (who see every channel and whose commits span them all): the one with the most open work assigned to them.
    var main = ""
    var best = -1
    var admin = me.getBool("is_admin")
    chans.forEach(function (c) {
      if (!c.mine || c.name === "general") return
      var score = admin ? (openPer[c.id] || 0) * 1000 + (c.member ? 1 : 0) * 100 + Math.min(c.my_items, 99) : c.my_activity * 2 + (c.member ? 1 : 0)
      if (score > best) { best = score; main = c.name }
    })
    if (!main && chans.some(function (c) { return c.name === "general" })) main = "general"

    // who does what: top people per channel from imported items and commits.
    var who = whoDoesWhat(app, chRecs)

    var ag = arrayOf(new DynamicModel({ name: "", active: false, last_seen: "" }))
    app.db().newQuery("SELECT name, active, last_seen FROM agents WHERE owner = {:u} ORDER BY name").bind({ u: me.id }).all(ag)
    var agents = ag.map(function (a) { return { name: a.name, active: !!a.active, last_seen: a.last_seen } })
    // connected: has an agent; cli: an admin can create one; ask_admin: everyone
    // else (an agent is optional for people who do not code)
    var hint = agents.length ? "connected" : me.getBool("is_admin") ? "cli" : "ask_admin"

    var hasImport = find(app, "hub_settings", "key ~ {:p}", "", 1, { p: STATE_PREFIX + "%" }).length > 0
    return [200, {
      user: { id: me.id, name: userName(me), github_login: login, role: me.getString("role"), is_admin: me.getBool("is_admin") },
      show: hasImport || !!login,
      main_channel: main,
      channels: chans,
      assigned_open: assigned.slice(0, 200),
      assigned_total: assigned.length,
      opened_open: opened.slice(0, 200),
      opened_total: opened.length,
      who: who,
      agents: {
        count: agents.length,
        list: agents,
        hint: hint,
        // English fallback; the panel localizes by `hint` (an agent key is shown once)
        join_hint: hint === "connected"
          ? "Your agent is connected with `ach join <line>`. Lost the line? Ask an admin: ach admin invite <agent>."
          : hint === "cli"
            ? "Connect your coding agent: ach admin create-agent --name <you>-claude --owner <you> --runtime claude --description <d> --invite, then run the printed `ach join ...` line."
            : "Ask an admin to connect an agent for you (optional).",
      },
    }]
  },
}

function whoDoesWhat(app, chRecs) {
  var stats = readSetting(app, STATS_KEY) || {}
  var rows = arrayOf(new DynamicModel({ channel: "", external: "" }))
  app.db().newQuery("SELECT channel, external FROM posts WHERE external_id != ''").all(rows)
  var by = {}
  function bump(ch, login, field) {
    if (!login || BOT_RE.test(login)) return
    var k = lower(login)
    by[ch] = by[ch] || {}
    by[ch][k] = by[ch][k] || { login: login, commits: 0, opened: 0, assigned: 0 }
    by[ch][k][field]++
  }
  rows.forEach(function (r) {
    var x = parseJSON(r.external) || {}
    bump(r.channel, str(x.author), "opened")
    arr(x.assignees).forEach(function (a) { bump(r.channel, str(a), "assigned") })
  })
  var users = {}
  find(app, "users", "github_login != ''", "", 100000, {}).forEach(function (u) { users[lower(u.getString("github_login"))] = u })
  var out = []
  chRecs.forEach(function (c) {
    var m = by[c.id] || {}
    var st = stats[c.getString("name")] || {}
    Object.keys(st).forEach(function (login) {
      var k = lower(login)
      m[k] = m[k] || { login: login, commits: 0, opened: 0, assigned: 0 }
      m[k].commits += st[login].commits || 0
    })
    var list = Object.keys(m).map(function (k) { return m[k] })
    if (!list.length) return
    // only people on this hub (known logins) are listed
    list = list.filter(function (p) { return users[lower(p.login)] && !users[lower(p.login)].getBool("deactivated") })
    list.forEach(function (p) { p.score = p.commits + 3 * p.assigned + p.opened })
    list.sort(function (a, b) { return b.score - a.score })
    if (!list.length) return
    out.push({
      channel: c.getString("name"),
      people: list.slice(0, 3).map(function (p) {
        var u = users[lower(p.login)]
        return { user_id: u.id, name: userName(u), role: u.getString("role"), github_login: p.login, commits: p.commits, opened: p.opened, assigned: p.assigned }
      }),
    })
  })
  return out
}

function run(e, name) {
  var r = routes[name]
  try {
    var ctx = authenticate(e)
    if (r.admin) requireAdmin(ctx)
    var out = r.fn(e, ctx)
    return e.json(out[0], out[1])
  } catch (err) {
    if (err && err.achError) return e.json(err.status, { error: err.message, code: err.code })
    var msg = String((err && err.message) || err)
    if (/UNIQUE constraint/i.test(msg)) return e.json(409, { error: "conflict", code: "conflict" })
    if (/validation|cannot be blank|must be/i.test(msg)) return e.json(400, { error: msg, code: "invalid" })
    e.app.logger().error("ach import route error", "route", name, "error", msg)
    return e.json(500, { error: "internal error" + ($os.getenv("ACH_TEST_HOOKS") === "1" ? ": " + msg : ""), code: "internal" })
  }
}

module.exports = { run: run }
