/// <reference path="../pb_data/types.d.ts" />
// Notifications: "something changed and nobody knows".
// Loaded with require() from ach_routes.pb.js (the "notifications" block) and
// ach_import.js (releases). Keep ES5-style (goja).
//
// Events (notify_events, unique key: repeated GitHub syncs never repeat one):
//  - GitHub (from the importer sync): opened (items created on GitHub in the
//    last 48 h), closed, merged, reopened, updated, newly assigned, release;
//  - tasks: sent, completed, failed;
//  - announcements (a top-level post with announce: true);
//  - a Memory key figure changed (old -> new);
//  - replies and mentions (these want the person's reply: they also show in the
//    Inbox "Needs me" list, so the "Updates" list leaves them out).
// Who hears what: things involving me (assigned, my agents mentioned, my
// threads, my issues/PRs/tasks changed by others) always; otherwise per channel
// all / important (default) / off; plus items I follow (explicit follow; an
// explicit unfollow silences an item except direct mentions/replies). Private
// channels: members only, never anyone else (admins included).
// Delivery: in-app always; a push to the person's own webhook (Feishu/JSON)
// right away for important and involves-me items (more than 3 at once collapse
// into one); everything else in one daily digest at the person's time
// (users.notify_prefs.digest_time in their UTC offset). Content is the event,
// the title and a deep link only: never bodies of private items or handoffs.

var IMPORTANT = { gh_opened: 1, gh_closed: 1, gh_merged: 1, gh_reopened: 1, gh_release: 1, task_sent: 1, task_completed: 1, task_failed: 1, announce: 1, figure_changed: 1, agent_post: 1 }
var LEVELS = ["all", "important", "off"]
var OPENED_WINDOW_MS = 48 * 3600 * 1000
var COLLAPSE_AT = 3
var DIGEST_MAX_LINES = 20
var DIRTY_KEY = "ach_notify_dirty"
var LONGPOLL_MAX_S = 25

var TEXT = {
  gh_opened: "Opened on GitHub", gh_closed: "Closed on GitHub", gh_merged: "PR merged", gh_reopened: "Reopened on GitHub",
  gh_updated: "Updated on GitHub", gh_assigned: "Assigned to you on GitHub", gh_release: "New release",
  task_sent: "Task sent", task_completed: "Task completed", task_failed: "Task failed",
  announce: "Announcement", figure_changed: "Key figure changed", reply: "New reply", mention: "Your agent was mentioned",
  digest: "Daily digest", summary: "{n} updates",
  decision_request: "Decision needed", memory_question: "Memory has a question for you",
  agent_joined: "An agent invite was used",
  agent_post: "New report from an agent", feishu_mapping: "Feishu identity mapping changed",
}
var TEXT_ZH = {
  gh_opened: "GitHub 上新开", gh_closed: "GitHub 上已关闭", gh_merged: "PR 已合并", gh_reopened: "GitHub 上重新打开",
  gh_updated: "GitHub 上有更新", gh_assigned: "GitHub 上分给了你", gh_release: "发布了新版本",
  task_sent: "发出了任务", task_completed: "任务完成", task_failed: "任务失败",
  announce: "公告", figure_changed: "关键数字变了", reply: "有新回复", mention: "你的智能体被提到",
  digest: "每日动态", summary: "{n} 条动态",
  decision_request: "需要你决定", memory_question: "记忆有个问题要你回答",
  agent_joined: "有人使用了智能体邀请",
  agent_post: "智能体发了新报告", feishu_mapping: "飞书身份映射有变化",
}

function L() { return require(__hooks + "/ach_lib.js").wikiDeps() }
function AchError(status, code, message) { this.achError = true; this.status = status; this.code = code; this.message = message }
function E(status, code, message) { return new AchError(status, code, message) }
function str(v) { return v === undefined || v === null ? "" : String(v) }
function arr(v) { return Array.isArray(v) ? v : [] }
function parseJSON(s) { if (!s) return null; try { return typeof s === "string" ? JSON.parse(s) : s } catch (err) { return null } }
function find(app, coll, filter, sort, limit, params) { return app.findRecordsByFilter(coll, filter, sort || "", limit || 1000, 0, params || {}) }
function oneLine(s, max) { return str(s).replace(/\s+/g, " ").trim().slice(0, max || 200) }
function lower(s) { return str(s).trim().toLowerCase() }
function nowMs() { return Date.now() }
function iso(ms) { return new Date(ms).toISOString().replace("T", " ") }
function parseTime(s) { if (!s) return 0; var t = Date.parse(String(s).replace(" ", "T")); return isNaN(t) ? 0 : t }
function publicUrl() { return str($os.getenv("ACH_PUBLIC_URL")).trim().replace(/\/+$/, "") }
function byId(app, coll, id) { if (!id) return null; try { return app.findRecordById(coll, id) } catch (err) { return null } }
function userName(u) { var n = u.getString("name"); if (n) return n; var em = u.getString("email"); return em ? em.split("@")[0] : u.id }
function taskRef(t) { var n = t.getInt("seq"); return n > 0 ? "T-" + n : t.id }
function markDirty(app) { try { app.store().set(DIRTY_KEY, "1") } catch (err) {} }

function defaultLang() { return lower($os.getenv("ACH_DEFAULT_LANG")) === "zh" ? "zh" : "en" }
function defaultOffset() {
  var v = parseInt(str($os.getenv("ACH_DEFAULT_TZ_OFFSET_MIN")), 10)
  if (!isNaN(v)) return v
  return defaultLang() === "zh" ? 480 : 0
}

// ---------------------------------------------------------------- prefs

function prefsOf(u) {
  var p = parseJSON(u.getString("notify_prefs")) || {}
  var ch = p.channels && typeof p.channels === "object" ? p.channels : {}
  return {
    channels: ch,
    digest_time: p.digest_time === undefined ? "09:00" : str(p.digest_time),
    tz: str(p.tz),
    tz_offset: typeof p.tz_offset === "number" ? p.tz_offset : defaultOffset(),
    digest_last: str(p.digest_last),
  }
}
function levelOf(prefs, channelId) {
  var l = str(prefs.channels[channelId])
  return LEVELS.indexOf(l) >= 0 ? l : "important"
}

// ---------------------------------------------------------------- emit

/**
 * Record one event and fan it out. ev: {key, event, channel, target_kind,
 * target_id, title, path, actor_user, actor_name, detail, important?,
 * reasons {uid: why} (involves them), replyNeeded {uid: why} (wants their reply),
 * followers {uid: true} (implicit follows), pushSkip {uid: true} (already
 * notified by the hub's older task notifications), quiet (agent-authored: no
 * push for reply-needed rows), noBroadcast (no channel-level fan-out)}.
 * Returns the number of people notified, or -1 for a duplicate key.
 */
function emit(app, ev) {
  if (find(app, "notify_events", "key = {:k}", "", 1, { k: ev.key }).length) return -1
  var ch = byId(app, "channels", ev.channel)
  var priv = !!ch && ch.getString("visibility") === "private"
  var members = ch ? arr(ch.getStringSlice("members")) : []
  var important = ev.important !== undefined ? !!ev.important : !!IMPORTANT[ev.event]
  var er = new Record(app.findCollectionByNameOrId("notify_events"))
  er.set("key", str(ev.key).slice(0, 300))
  er.set("event", ev.event)
  er.set("channel", ev.channel || "")
  er.set("target_kind", ev.target_kind || "")
  er.set("target_id", ev.target_id || "")
  er.set("title", oneLine(ev.title, 400))
  er.set("path", str(ev.path).slice(0, 300))
  er.set("actor_user", ev.actor_user || "")
  er.set("actor_name", oneLine(ev.actor_name, 200))
  er.set("detail", oneLine(ev.detail, 400))
  er.set("important", important)
  er.set("private", priv)
  if (ev.data) er.set("data", ev.data)
  app.save(er)

  var follows = {}
  if (ev.target_kind && ev.target_id) {
    find(app, "follows", "kind = {:k} && target = {:t}", "", 10000, { k: ev.target_kind, t: ev.target_id }).forEach(function (f) {
      follows[f.getString("user")] = f.getBool("on")
    })
  }
  var reasons = ev.reasons || {}
  var rn = ev.replyNeeded || {}
  var implicit = ev.followers || {}
  var skip = ev.pushSkip || {}
  var coll = app.findCollectionByNameOrId("notifications")
  var n = 0
  find(app, "users", "deactivated = false", "", 100000, {}).forEach(function (u) {
    var uid = u.id
    if (uid === ev.actor_user) return
    if (priv && members.indexOf(uid) < 0) return
    var f = follows[uid]
    var replyNeeded = !!rn[uid]
    if (f === false && !replyNeeded) return
    var reason = replyNeeded ? str(rn[uid]) : str(reasons[uid])
    var needs = replyNeeded || !!reasons[uid]
    if (!needs) {
      if (f === true || implicit[uid]) reason = "follow"
      else if (ev.noBroadcast) return
      else {
        // A channel's news reaches its members only (#general is the
        // whole team; a non-member opts in by setting the level to "all");
        // GitHub news is muted for people without a GitHub login unless "all".
        var prefs = prefsOf(u)
        var lv = levelOf(prefs, ev.channel)
        var explicitAll = str(prefs.channels[ev.channel]) === "all"
        if (lv === "off" || (lv === "important" && !important)) return
        var member = !ch || members.indexOf(uid) >= 0 || ch.getString("name") === "general"
        if (!member && !explicitAll) return
        if (/^gh_/.test(ev.event) && !u.getString("github_login") && !explicitAll) return
        reason = "channel"
      }
    }
    var push
    if (skip[uid]) push = "skipped"
    else if (replyNeeded) push = ev.quiet ? "none" : "pending"
    else if (needs || important) push = "pending"
    else push = "digest"
    var r = new Record(coll)
    r.set("user", uid)
    r.set("ev", er.id)
    r.set("reason", reason)
    r.set("needs_me", needs)
    r.set("reply_needed", replyNeeded)
    r.set("push", push)
    app.save(r)
    n++
  })
  if (!ev.noBroadcast) enqueueGroup(app, er)
  markDirty(app)
  return n
}

// ---------------------------------------------------------------- record hooks

function loginMap(app) {
  var m = {}
  find(app, "users", "github_login != '' && deactivated = false", "", 100000, {}).forEach(function (u) { m[lower(u.getString("github_login"))] = u.id })
  return m
}
function agentOwner(app, id) { var a = byId(app, "agents", id); return a ? a.getString("owner") : "" }
function agentName(app, id) { var a = byId(app, "agents", id); return a ? a.getString("name") : "" }
function ghTitle(x) { return str(x.repo) + "#" + str(x.number) + " " + oneLine(x.title, 200) }

var EXCERPT_MAX = 80
var EXCERPT_EVENTS = { announce: true, agent_post: true }
/** A post's first non-empty line, at most EXCERPT_MAX characters. */
function postExcerpt(p) {
  var line = str(p.getString("body")).split("\n").map(function (x) { return x.trim() }).filter(function (x) { return x })[0] || ""
  line = oneLine(line, 400)
  return line.length > EXCERPT_MAX ? line.slice(0, EXCERPT_MAX - 1) + "…" : line
}
/**
 * A private channel's report/announcement carries no text in the event (team
 * hooks, web push, webhooks); only the team's own chat bot (ach_feishu.js)
 * adds this short excerpt for a member of that channel, read at delivery time.
 */
function memberExcerpt(app, evId, u) {
  var ev = byId(app, "notify_events", str(evId))
  if (!ev || !u || !ev.getBool("private") || !EXCERPT_EVENTS[ev.getString("event")] || ev.getString("target_kind") !== "post") return ""
  var ch = byId(app, "channels", ev.getString("channel"))
  if (!ch || arr(ch.getStringSlice("members")).indexOf(u.id) < 0) return ""
  var p = byId(app, "posts", ev.getString("target_id"))
  return p ? postExcerpt(p) : ""
}

/** A post was created (GitHub item, announcement, reply, mention). */
function onPostCreate(app, p) {
  if (p.getString("kind") === "system" || p.getString("author_type") === "system") return
  var channel = p.getString("channel")
  var ch = byId(app, "channels", channel)
  var priv = !!ch && ch.getString("visibility") === "private"
  var chName = ch ? ch.getString("name") : ""
  // reports and announcements name the channel by its title (#Ops data), as people know it
  var chLabel = ch ? oneLine(ch.getString("title"), 60) || chName : ""
  if (p.getString("external_id")) {
    var x = parseJSON(p.getString("external")) || {}
    var made = parseTime(x.created_at)
    if (made && nowMs() - made <= OPENED_WINDOW_MS && x.state === "open") {
      emit(app, ghEvent(app, p, x, "gh_opened", p.getString("external_id") + ":opened", ""))
    }
    return
  }
  var actor = p.getString("author_user")
  var actorName = actor ? (byId(app, "users", actor) ? userName(byId(app, "users", actor)) : "") : agentName(app, p.getString("author_agent"))
  var agentAuthored = p.getString("author_type") === "agent"
  var parent = p.getString("parent")
  if (!parent && p.getBool("announce")) {
    emit(app, {
      key: "announce:" + p.id, event: "announce", channel: channel, target_kind: "post", target_id: p.id,
      // a private channel's announcement text never leaves in a push; members read it in the panel
      title: "#" + chLabel + (priv ? "" : ": " + postExcerpt(p)),
      path: "p/" + p.id, actor_user: actor, actor_name: actorName,
    })
  }
  // An agent's top-level post (a report) is channel news for its members
  if (!parent && agentAuthored && !p.getBool("announce") && p.getString("kind") !== "task") {
    emit(app, {
      key: "agent_post:" + p.id, event: "agent_post", channel: channel, target_kind: "post", target_id: p.id,
      title: "#" + chLabel + (priv ? "" : ": " + postExcerpt(p)),
      path: "p/" + p.id, actor_user: "", actor_name: actorName,
    })
  }
  var rn = {}
  var followers = {}
  var target = { kind: "post", id: p.id }
  var titleLine = ""
  if (parent) {
    var root = byId(app, "posts", parent)
    if (!root) return
    titleLine = root.getString("external_id") ? ghTitle(parseJSON(root.getString("external")) || {}) : oneLine(str(root.getString("body")).split("\n")[0], 160)
    if (root.getString("author_user")) rn[root.getString("author_user")] = "reply"
    var rows = arrayOf(new DynamicModel({ author_user: "" }))
    app.db().newQuery("SELECT DISTINCT author_user FROM posts WHERE parent = {:r} AND author_user != '' AND created > {:old}").bind({ r: root.id, old: iso(nowMs() - 30 * 24 * 3600 * 1000) }).all(rows)
    rows.forEach(function (r) { rn[r.author_user] = "reply" })
    target = { kind: "post", id: root.id }
    if (root.getString("external_id")) {
      var rx = parseJSON(root.getString("external")) || {}
      var lm = loginMap(app)
      ;[str(rx.author)].concat(arr(rx.assignees)).forEach(function (l) { var u = lm[lower(l)]; if (u) followers[u] = true })
    }
    if (root.getString("task")) {
      var t = byId(app, "tasks", root.getString("task"))
      if (t) {
        target = { kind: "task", id: t.id }
        if (t.getString("owner_user")) followers[t.getString("owner_user")] = true
        var wo = agentOwner(app, t.getString("to_agent"))
        if (wo) followers[wo] = true
        titleLine = taskRef(t) + " " + oneLine(t.getString("title"), 160)
      }
    }
  }
  arr(p.getStringSlice("mentions")).forEach(function (aid) { var o = agentOwner(app, aid); if (o) rn[o] = "mention" })
  if (actor) delete rn[actor]
  if (!parent && !Object.keys(rn).length) return
  emit(app, {
    key: "post:" + p.id, event: parent ? "reply" : "mention", channel: channel, target_kind: target.kind, target_id: target.id,
    title: "#" + chName + (priv || !titleLine ? "" : ": " + titleLine),
    path: "p/" + p.id, actor_user: actor, actor_name: actorName,
    replyNeeded: rn, followers: followers, quiet: agentAuthored, noBroadcast: true, important: false,
  })
}

function ghEvent(app, p, x, event, key, detail) {
  var lm = loginMap(app)
  var reasons = {}
  var a = lm[lower(x.author)]
  if (a) reasons[a] = "author"
  arr(x.assignees).forEach(function (l) { var u = lm[lower(l)]; if (u) reasons[u] = "assigned" })
  return {
    key: key, event: event, channel: p.getString("channel"), target_kind: "post", target_id: p.id,
    title: ghTitle(x), path: "p/" + p.id, actor_name: str(x.author), detail: detail, reasons: reasons,
  }
}

/** A GitHub item's post was updated by a sync: state changes and updates. */
function onPostUpdate(app, p, orig) {
  if (!p.getString("external_id")) return
  var x = parseJSON(p.getString("external")) || {}
  var o = parseJSON(orig.getString("external")) || {}
  var xid = p.getString("external_id")
  if (str(o.state) !== str(x.state)) {
    var ev = x.state === "merged" ? "gh_merged" : x.state === "closed" ? "gh_closed" : x.state === "open" ? "gh_reopened" : ""
    if (ev) emit(app, ghEvent(app, p, x, ev, xid + ":" + x.state + ":" + str(x.updated_at), str(o.state) + " → " + str(x.state)))
    return
  }
  var before = arr(o.assignees).map(lower)
  var added = arr(x.assignees).filter(function (l) { return before.indexOf(lower(l)) < 0 })
  if (added.length) {
    var e1 = ghEvent(app, p, x, "gh_assigned", xid + ":assigned:" + added.map(lower).sort().join(",") + ":" + str(x.updated_at), "")
    var lm = loginMap(app)
    var only = {}
    added.forEach(function (l) { var u = lm[lower(l)]; if (u) only[u] = "assigned" })
    e1.reasons = only
    e1.noBroadcast = true
    e1.important = false
    emit(app, e1)
  }
  if (str(o.updated_at) !== str(x.updated_at) && str(x.updated_at)) {
    var e2 = ghEvent(app, p, x, "gh_updated", xid + ":updated:" + str(x.updated_at), "")
    // an update is news for the channel's "all" readers and followers, not a reason to push to the author
    e2.followers = e2.reasons
    e2.reasons = {}
    emit(app, e2)
  }
}

function taskEvent(app, t, event, key) {
  return {
    key: key, event: event, channel: t.getString("channel"), target_kind: "task", target_id: t.id,
    title: taskRef(t) + " " + oneLine(t.getString("title"), 200), path: "t/" + taskRef(t),
    reasons: {}, pushSkip: {},
  }
}

function onTaskCreate(app, t) {
  if (t.getString("system_kind")) return
  var ev = taskEvent(app, t, "task_sent", "task:" + t.id + ":sent")
  var from = agentOwner(app, t.getString("from_agent"))
  var to = agentOwner(app, t.getString("to_agent"))
  ev.actor_user = from || t.getString("owner_user")
  ev.actor_name = agentName(app, t.getString("from_agent"))
  ev.detail = agentName(app, t.getString("from_agent")) + " → " + agentName(app, t.getString("to_agent"))
  if (to && to !== ev.actor_user) { ev.reasons[to] = "assigned"; ev.pushSkip[to] = true } // the hub already sent "task_received"
  emit(app, ev)
}

function onTaskUpdate(app, t, orig) {
  if (t.getString("system_kind")) return
  var st = t.getString("status")
  if (st === orig.getString("status") || (st !== "completed" && st !== "failed")) return
  var ev = taskEvent(app, t, st === "completed" ? "task_completed" : "task_failed", "task:" + t.id + ":" + st + ":" + t.getString("updated"))
  ev.actor_user = agentOwner(app, t.getString("to_agent"))
  ev.actor_name = agentName(app, t.getString("to_agent"))
  var owner = t.getString("owner_user")
  if (owner && owner !== ev.actor_user) { ev.reasons[owner] = "mine"; ev.pushSkip[owner] = true } // the hub already sent "task_completed/failed"
  emit(app, ev)
}

/** A figure row lost to a newer one with a different value: "key figure changed (old -> new)". */
function onFigureUpdate(app, f, orig) {
  if (orig.getString("status") !== "active" || f.getString("status") !== "superseded" || !f.getString("superseded_by")) return
  var head = byId(app, "wiki_figures", f.getString("superseded_by"))
  if (!head || head.getString("value") === f.getString("value")) return
  var page = find(app, "wiki_pages", "slug = {:s}", "", 1, { s: f.getString("topic") })[0] || null
  var unit = head.getString("unit") ? " " + head.getString("unit") : ""
  emit(app, {
    key: "fig:" + f.id + ":" + head.id, event: "figure_changed", channel: page ? page.getString("channel") : "",
    target_kind: "", target_id: "",
    title: (page ? page.getString("title") || f.getString("topic") : f.getString("topic")) + " · " + f.getString("metric") + (f.getString("env") ? " (" + f.getString("env") + ")" : ""),
    detail: f.getString("value") + (f.getString("unit") ? " " + f.getString("unit") : "") + " → " + head.getString("value") + unit + (head.getString("as_of") ? " (as of " + head.getString("as_of").slice(0, 10) + ")" : ""),
    path: "m/" + f.getString("topic"),
  })
}

/** Hook entry: never breaks the write that triggered it. */
function onRecord(app, kind, rec, orig) {
  try {
    if (kind === "post_create") onPostCreate(app, rec)
    else if (kind === "post_update") onPostUpdate(app, rec, orig)
    else if (kind === "task_create") onTaskCreate(app, rec)
    else if (kind === "task_update") onTaskUpdate(app, rec, orig)
    else if (kind === "figure_update") onFigureUpdate(app, rec, orig)
  } catch (err) {
    app.logger().warn("ach notify event failed", "kind", kind, "error", String(err))
  }
}

// ---------------------------------------------------------------- releases (importer)

var REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
var TAG_RE = /^[A-Za-z0-9._\/+-]{1,120}$/

/** releases: [{repo, tag, name, url, published_at}] from `ach admin sync github`. */
function importReleases(app, list, counts) {
  if (list.length > 500) throw E(400, "invalid", "at most 500 releases per request")
  var idx = {}
  find(app, "channels", "archived = false", "created", 10000, {}).forEach(function (c) {
    arr(parseJSON(c.getString("repos"))).forEach(function (r) { idx[lower(r)] = c })
  })
  counts.releases = counts.releases || 0
  list.forEach(function (r) {
    if (!r || typeof r !== "object") throw E(400, "invalid", "each release must be an object")
    var repo = str(r.repo).trim()
    var tag = str(r.tag).trim()
    if (!REPO_RE.test(repo) || !TAG_RE.test(tag)) throw E(400, "invalid", "release.repo must be owner/name and release.tag a tag name")
    var url = str(r.url).trim()
    if (!/^https:\/\/[A-Za-z0-9.-]+\/\S+$/.test(url) || url.length > 500) url = "https://github.com/" + repo + "/releases/tag/" + encodeURIComponent(tag)
    var key = "rel:" + lower(repo) + "@" + tag
    if (find(app, "notify_events", "key = {:k}", "", 1, { k: key }).length) return
    var ch = idx[lower(repo)] || find(app, "channels", "name = 'general'", "", 1, {})[0]
    if (!ch) return
    var name = oneLine(r.name, 200)
    var p = new Record(app.findCollectionByNameOrId("posts"))
    p.set("channel", ch.id)
    p.set("author_type", "system")
    p.set("kind", "system")
    p.set("body", "Release " + repo + " " + tag + (name && name !== tag ? " (" + name + ")" : "") + ": " + url)
    p.set("sys_code", "gh_release")
    p.set("sys_params", { repo: repo, tag: tag, name: name, url: url })
    app.save(p)
    emit(app, {
      key: key, event: "gh_release", channel: ch.id, target_kind: "post", target_id: p.id,
      title: repo + " " + tag + (name && name !== tag ? " " + name : ""), path: "p/" + p.id, actor_name: str(r.author),
    })
    counts.releases++
  })
}

// ---------------------------------------------------------------- delivery
// Messages (event + title + deep link + channel) go to targets through the
// hook delivery queue (ach_hooks.js: presets, signing, SSRF block, retries).

function textOf(event, lang, vars) {
  var s = (lang === "zh" ? TEXT_ZH[event] : TEXT[event]) || event
  for (var k in (vars || {})) s = s.replace("{" + k + "}", vars[k])
  return s
}
/** The words for a person's notification row. */
function eventLabel(n, ev, lang) {
  if (ev && DECISION_EVENTS[ev.getString("event")]) return textOf(ev.getString("event"), lang)
  if (n && n.getBool("reply_needed")) return textOf(n.getString("reason") === "mention" ? "mention" : "reply", lang)
  return textOf(ev ? ev.getString("event") : "summary", lang, { n: "1" })
}
function clean(s, max) { return str(s).replace(/[\r\n]+/g, " ").replace(/[<>]/g, " ").slice(0, max) }
function itemUrl(ev) { return publicUrl() + "/#/" + ev.getString("path") }
/** Detail (old -> new, a state change) only for items outside private channels. */
function detailOf(ev) { return ev.getBool("private") ? "" : clean(ev.getString("detail"), 300) }
function langOf(u) { return u && u.getString("lang") ? (u.getString("lang") === "zh" ? "zh" : "en") : defaultLang() }
function chName(app, id) { var c = byId(app, "channels", id); return c ? c.getString("name") : "" }

function single(app, ev, lang, n, u) {
  var m = { kind: "single", id: ev.id, event: ev.getString("event"), text: n ? eventLabel(n, ev, lang) : textOf(ev.getString("event"), lang), title: clean(ev.getString("title"), 300), url: itemUrl(ev), channel: chName(app, ev.getString("channel")), lang: lang }
  var d = detailOf(ev)
  if (d) m.detail = d
  if (n) m.reason = n.getString("reason")
  if (u) m.to_user = { id: u.id, name: userName(u) }
  decisionFields(m, ev, false)
  return m
}
function listMsg(app, kind, pairs, lang, u) {
  var items = pairs.slice(0, DIGEST_MAX_LINES).map(function (x) { var s = single(app, x.ev, lang, x.n, null); delete s.kind; delete s.lang; return s })
  return {
    kind: kind, id: kind + "-" + u.id + "-" + pairs[0].ev.id, event: kind, lang: lang,
    text: kind === "digest" ? textOf("digest", lang) : textOf("summary", lang, { n: String(pairs.length) }),
    title: kind === "digest" ? textOf("digest", lang) : textOf("summary", lang, { n: String(pairs.length) }),
    url: publicUrl() + "/#/inbox/updates", count: pairs.length, more: Math.max(0, pairs.length - items.length), items: items,
    to_user: { id: u.id, name: userName(u) },
  }
}

/** Channel and team hooks of a just-recorded event (not replies/mentions). */
function enqueueGroup(app, er) {
  var H = require(__hooks + "/ach_hooks.js")
  H.groupTargets(app, er).forEach(function (h) {
    H.enqueue(app, "hook:" + h.id, single(app, er, h.getString("lang") || defaultLang(), null, null), er.id)
  })
}

/** Claim a row for delivery (several requests may flush at once). */
function claim(app, id, from, to, now) {
  try {
    var res = app.db().newQuery("UPDATE notifications SET push = {:to}, push_at = {:at} WHERE id = {:id} AND push = {:from}").bind({ to: to, at: iso(now), id: id, from: from }).execute()
    return res.rowsAffected() === 1
  } catch (err) {
    return false
  }
}

/** Queue pending personal pushes (more than COLLAPSE_AT for one person become one message), then send what is due. */
function flush(app, now) {
  now = now || nowMs()
  try { app.store().remove(DIRTY_KEY) } catch (err) {}
  var H = require(__hooks + "/ach_hooks.js")
  var rows = find(app, "notifications", "push = 'pending'", "created", 2000, {})
  var byUser = {}
  rows.forEach(function (r) { (byUser[r.getString("user")] = byUser[r.getString("user")] || []).push(r) })
  var queued = 0
  Object.keys(byUser).forEach(function (uid) {
    var u = byId(app, "users", uid)
    var targets = u && !u.getBool("deactivated") && publicUrl() ? H.personalTargets(app, u, true) : []
    var mine = byUser[uid].filter(function (r) { return claim(app, r.id, "pending", targets.length ? "sent" : "none", now) })
    if (!targets.length || !mine.length) return
    var lang = langOf(u)
    var pairs = mine.map(function (n) { return { n: n, ev: byId(app, "notify_events", n.getString("ev")) } }).filter(function (x) { return x.ev })
    if (!pairs.length) return
    var dec = pairs.filter(function (x) { return DECISION_EVENTS[x.ev.getString("event")] })
    var rest = pairs.filter(function (x) { return !DECISION_EVENTS[x.ev.getString("event")] })
    var msgs = rest.length > COLLAPSE_AT ? [listMsg(app, "summary", rest, lang, u)] : rest.map(function (x) { return single(app, x.ev, lang, x.n, u) })
    msgs.forEach(function (m) { targets.forEach(function (t) { H.enqueue(app, t, m, m.kind === "single" ? m.id : "") }) })
    // decision requests: one message each, with their options and per-option links;
    // never to the person's legacy webhook ("user:"), which sendNotes already reached
    dec.forEach(function (x) {
      var m = single(app, x.ev, lang, x.n, u)
      targets.forEach(function (t) { if (t.indexOf("user:") !== 0) H.enqueue(app, t, m, m.id) })
    })
    queued += msgs.length + dec.length
  })
  var sent = H.processDue(app, Math.max(now, nowMs()))
  return { pushed: queued, sent: sent }
}

/** The person's digest moment for "now" (UTC ms), or 0 when there is none. */
function digestSlot(prefs, now) {
  var m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(prefs.digest_time)
  if (!m) return 0
  var off = prefs.tz_offset * 60000
  var d = new Date(now + off)
  var slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), parseInt(m[1], 10), parseInt(m[2], 10)) - off
  return slot <= now ? slot : slot - 24 * 3600 * 1000
}

function setDigestLast(app, u, now) {
  var p = parseJSON(u.getString("notify_prefs")) || {}
  p.digest_last = iso(now)
  u.set("notify_prefs", p)
  app.save(u)
}

/** Queue each person's daily digest once their time of day has passed. */
function digest(app, now) {
  now = now || nowMs()
  var H = require(__hooks + "/ach_hooks.js")
  var ids = arrayOf(new DynamicModel({ user: "" }))
  app.db().newQuery("SELECT DISTINCT user FROM notifications WHERE push = 'digest'").all(ids)
  var sent = 0
  ids.forEach(function (row) {
    var u = byId(app, "users", row.user)
    if (!u) return
    var prefs = prefsOf(u)
    var rows = find(app, "notifications", "user = {:u} && push = 'digest'", "created", 5000, { u: u.id })
    if (!prefs.digest_time) { rows.forEach(function (r) { claim(app, r.id, "digest", "none", now) }); return }
    // the first look starts the clock: the first digest comes at the next digest time
    if (!prefs.digest_last) { setDigestLast(app, u, now); return }
    var slot = digestSlot(prefs, now)
    if (!slot || parseTime(prefs.digest_last) >= slot) return
    rows = rows.filter(function (r) { return parseTime(r.getString("created")) <= now })
    var mine = rows.filter(function (r) { return claim(app, r.id, "digest", "digested", now) })
    setDigestLast(app, u, now)
    var targets = !u.getBool("deactivated") && publicUrl() ? H.personalTargets(app, u, false) : []
    if (!mine.length || !targets.length) return
    var pairs = mine.map(function (n) { return { n: n, ev: byId(app, "notify_events", n.getString("ev")) } }).filter(function (x) { return x.ev })
    if (!pairs.length) return
    var m = listMsg(app, "digest", pairs, langOf(u), u)
    targets.forEach(function (t) { H.enqueue(app, t, m, "") })
    sent++
  })
  if (sent) H.processDue(app, Math.max(now, nowMs()))
  return { digests: sent }
}

/** Middleware tail: flush only when an event was recorded since the last flush. */
function flushIfDirty(app) {
  var dirty = false
  try { dirty = !!app.store().get(DIRTY_KEY) } catch (err) {}
  if (!dirty) return
  try { flush(app) } catch (err) { app.logger().warn("ach notify flush failed", "error", String(err)) }
}

// ---------------------------------------------------------------- decision requests + push actions
// A decision request addressed to a person (a task message, or a channel
// question post such as a Memory conflict) is also a notification row, so Web
// Push and desktop notifiers can carry its options as action buttons. A tap
// sends a short-lived action token to POST /api/ach/push/act (ach_lib.js),
// which records the person's reply exactly like a panel reply. Tokens: random,
// stored as SHA-256 only, single use, bound to person + request + option,
// expire after ACTION_TTL_MS. Links in chat webhooks only open the panel with
// the option preselected (a GET never answers anything).

var DECISION_EVENTS = { decision_request: 1, memory_question: 1 }
var ACTION_TTL_MS = 24 * 3600 * 1000
var ACTION_KEEP = 5
var ACTION_RE = /^acha_[A-Za-z0-9]{43}$/
var BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

/** What a tap sends: the option's label and detail (the same words as the panel button). */
function optionReply(o) { return (str(o.label) + (o.detail ? " — " + str(o.detail) : "")).slice(0, 700) }
function pickLink(path, i) { return publicUrl() + "/#/" + path + "?pick=" + i }

/** sendNotes (ach_lib.js): a decision request for one person becomes an event + their notification row. */
function decisionEvent(app, n) {
  if (!n || !n.to_user) return
  var c = n.choices && Array.isArray(n.choices.options) && n.choices.options.length ? n.choices : null
  var data = n.message_id ? { kind: "task", task_id: n.task_id, task_ref: n.ref || "", message_id: n.message_id } : { kind: "post", post_id: n.post_id }
  if (c) {
    data.choices = {
      question: oneLine(c.question, 500), recommended: Number(c.recommended) || 0,
      options: c.options.map(function (o) { return { label: oneLine(o.label, 120), detail: oneLine(o.detail, 400), money: oneLine(o.money, 80) } }),
    }
  }
  var rn = {}
  rn[n.to_user] = "decision"
  emit(app, {
    key: "dr:" + (n.message_id || n.post_id) + ":" + n.to_user, event: n.event, channel: "",
    target_kind: n.message_id ? "task" : "post", target_id: n.message_id ? n.task_id : n.post_id,
    title: (n.ref ? n.ref + " " : "") + oneLine(n.title, 300), path: n.path,
    replyNeeded: rn, noBroadcast: true, important: false, data: data,
  })
}

/** Adds question/options/ids of a decision event to a message or list item (links: per-option pick links). */
function decisionFields(o, ev, forList) {
  if (!ev || !DECISION_EVENTS[ev.getString("event")]) return o
  var d = parseJSON(ev.getString("data")) || {}
  o.decision = true
  if (d.task_id) o.task_id = d.task_id
  if (d.task_ref) o.task_ref = d.task_ref
  if (d.message_id) o.message_id = d.message_id
  if (d.post_id) o.post_id = d.post_id
  var c = d.choices
  if (c && Array.isArray(c.options)) {
    o.question = c.question
    o.options = c.options.map(function (x, i) {
      var r = { option: i, label: x.label, detail: x.detail || "", money: x.money || "", recommended: i === (Number(c.recommended) || 0) }
      if (!forList) r.url = pickLink(ev.getString("path"), i)
      return r
    })
  }
  return o
}

/** A decision request's state for person uid: {kind, target, task, choices, addressed, open}, or null when gone. */
function decisionState(app, d, uid) {
  if (!d) return null
  if (d.kind === "task") {
    var m = byId(app, "messages", d.message_id)
    if (!m || m.getString("kind") !== "decision_request") return null
    // A grantee person (also_to) is addressed too (their reply is checked against the grant by /decide)
    var also = arr(parseJSON(m.getString("also_to")))
    var st = { kind: "task", target: m.id, task: m.getString("task"), choices: parseJSON(m.getString("choices")), addressed: m.getString("to_user") === uid || also.indexOf(uid) >= 0, open: !m.getBool("resolved"), to_user: m.getString("to_user") }
    if (!st.open) {
      var dec = find(app, "messages", "reply_to = {:r} && kind = 'decision'", "-created", 1, { r: m.id })[0]
      if (dec) { var du = byId(app, "users", dec.getString("author_user")); st.answered_by = du ? userName(du) : ""; st.answer = oneLine(dec.getString("body"), 200) }
    }
    return st
  }
  if (d.kind === "post") {
    var p = byId(app, "posts", d.post_id)
    if (!p) return null
    var root = p.getString("parent") || p.id
    var later = find(app, "posts", "(parent = {:r} || id = {:r}) && author_type = 'human' && created > {:c}", "created", 1, { r: root, c: p.getString("created") })
    var ps = { kind: "post", target: p.id, task: "", choices: parseJSON(p.getString("choices")), addressed: p.getString("to_user") === uid, open: !later.length, to_user: p.getString("to_user") }
    if (later.length) { var lu = byId(app, "users", later[0].getString("author_user")); ps.answered_by = lu ? userName(lu) : ""; ps.answer = oneLine(later[0].getString("body"), 200) }
    return ps
  }
  return null
}

/** Mints action tokens for options idxs of an open request addressed to uid. [{option, label, recommended, token, expires_at}] */
function mintActions(app, uid, st, idxs, via) {
  if (!st || !st.open || !st.addressed || !st.choices || !Array.isArray(st.choices.options)) return []
  var now = nowMs()
  try { app.db().newQuery("DELETE FROM push_actions WHERE expires_at < {:old}").bind({ old: iso(now - 7 * 24 * 3600 * 1000) }).execute() } catch (err) {}
  var coll = app.findCollectionByNameOrId("push_actions")
  var rec = Number(st.choices.recommended) || 0
  var out = []
  idxs.forEach(function (i) {
    var o = st.choices.options[i]
    if (!o) return
    // a polling notifier may mint again: keep at most ACTION_KEEP live tokens per person + request + option
    find(app, "push_actions", "user = {:u} && target = {:t} && option = {:o} && used_at = ''", "-created", 100, { u: uid, t: st.target, o: i }).slice(ACTION_KEEP - 1).forEach(function (r) { app.delete(r) })
    var tok = "acha_" + $security.randomStringWithAlphabet(43, BASE62)
    var r = new Record(coll)
    r.set("token_hash", $security.sha256(tok))
    r.set("user", uid)
    r.set("kind", st.kind)
    r.set("target", st.target)
    r.set("task", st.task || "")
    r.set("option", i)
    r.set("reply", optionReply(o))
    r.set("via", via)
    r.set("expires_at", iso(now + ACTION_TTL_MS))
    app.save(r)
    out.push({ option: i, label: str(o.label), recommended: i === rec, token: tok, expires_at: iso(now + ACTION_TTL_MS) })
  })
  return out
}

// ---------------------------------------------------------------- routes

var routes = {}

function evOut(app, n, ev, names, lang) {
  var url = (publicUrl() || "") + "/#/" + ev.getString("path")
  return {
    id: n.id, event_id: ev.id, event: ev.getString("event"), reason: n.getString("reason"), needs_me: n.getBool("needs_me"), important: ev.getBool("important"),
    reply_needed: n.getBool("reply_needed"), alert: n.getBool("reply_needed") || n.getBool("needs_me") || ev.getBool("important"),
    text: eventLabel(n, ev, lang),
    title: ev.getString("title"), detail: ev.getString("detail"), url: url, path: ev.getString("path"),
    channel: ev.getString("channel"), channel_name: names.channel(ev.getString("channel")), actor_name: ev.getString("actor_name"),
    target_kind: ev.getString("target_kind"), target_id: ev.getString("target_id"),
    at: n.getString("created"),
  }
}

// GET /api/ach/me/notifications?since=<iso>&limit=: the "Updates" list (FYI),
// newest first. Reply-needed rows are left out: they are the Inbox "Needs me".
// An agent key reads its owner's list (the desktop notifier in `ach run --notify`;
// ?all=1 adds reply-needed rows; `alert` marks what deserves an OS notification).
routes.list = {
  allow: ["user", "agent"],
  fn: function (e, ctx) {
    var app = e.app
    var q = e.request.url.query()
    var limit = Math.min(200, Math.max(1, parseInt(q.get("limit"), 10) || 100))
    var since = str(q.get("since")).replace("T", " ").trim()
    var uid = ctx.type === "user" ? ctx.user.id : ctx.agent.getString("owner")
    var f = "user = {:u}" + (q.get("all") === "1" ? "" : " && reply_needed = false")
    var p = { u: uid }
    if (since && parseTime(since)) { f += " && created > {:s}"; p.s = since }
    var names = new (L().Names)(app)
    var lu = byId(app, "users", uid)
    var lang = lu && lu.getString("lang") ? (lu.getString("lang") === "zh" ? "zh" : "en") : defaultLang()
    var items = []
    // Action tokens answer as the person, so only a full human session
    // (a panel login) gets them; an agent key or an agent-scoped (`ach open`)
    // session gets the per-option panel links (?pick=) instead.
    var human = ctx.type === "user" && ctx.scope !== "agent"
    var wantActions = q.get("actions") === "1" && human
    find(app, "notifications", f, "-created", limit, p).forEach(function (n) {
      var ev = byId(app, "notify_events", n.getString("ev"))
      if (!ev) return
      // membership changed since: a private channel's item is gone for a non-member
      if (ev.getBool("private") && L().channelHidden(ctx, ev.getString("channel"))) return
      var o = decisionFields(evOut(app, n, ev, names, lang), ev, true)
      if (o.decision) {
        var st = decisionState(app, parseJSON(ev.getString("data")), uid)
        o.open = !!(st && st.open && st.addressed)
        if (o.options) o.options.forEach(function (x) { x.url = pickLink(ev.getString("path"), x.option) })
        // ?actions=1: per-option action tokens for a desktop notifier (POST /push/act)
        if (wantActions && o.open && o.options) o.actions = mintActions(app, uid, st, o.options.map(function (x) { return x.option }), "desktop")
      }
      items.push(o)
    })
    var me = ctx.type === "user" ? ctx.user : byId(app, "users", uid)
    return [200, { items: items, prefs: me ? prefsOut(me) : null, server_time: iso(nowMs()) }]
  },
}

function prefsOut(u) {
  var p = prefsOf(u)
  return { channels: p.channels, digest_time: p.digest_time, tz: p.tz, tz_offset: p.tz_offset, webhook_set: !!u.getString("notify_webhook") }
}

routes.getPrefs = { allow: ["user"], fn: function (e, ctx) { return [200, prefsOut(ctx.user)] } }

// PUT /api/ach/me/notify-prefs {channel, level} | {digest_time, tz, tz_offset}
routes.putPrefs = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = L().body(e)
    return L().tx(e.app, function (app) {
      var u = app.findRecordById("users", ctx.user.id)
      var p = parseJSON(u.getString("notify_prefs")) || {}
      if (!p.channels || typeof p.channels !== "object") p.channels = {}
      var changed = false
      if (b.channel !== undefined) {
        var c = L().findChannel(app, str(b.channel))
        L().requireChannelVisible(ctx, c.id, "channel")
        var lv = str(b.level)
        if (LEVELS.indexOf(lv) < 0) throw E(400, "invalid", "level must be all, important or off")
        if (lv === "important") delete p.channels[c.id]
        else p.channels[c.id] = lv
        changed = true
      }
      if (b.digest_time !== undefined) {
        var dt = str(b.digest_time).trim()
        if (dt && !/^([01]?\d|2[0-3]):([0-5]\d)$/.test(dt)) throw E(400, "invalid", "digest_time must be HH:MM (or empty for no digest)")
        p.digest_time = dt
        changed = true
      }
      if (b.tz !== undefined) {
        var tz = str(b.tz).trim()
        if (tz.length > 64 || (tz && !/^[A-Za-z0-9_+\/-]+$/.test(tz))) throw E(400, "invalid", "tz must be a time zone name")
        p.tz = tz
        changed = true
      }
      if (b.tz_offset !== undefined) {
        var off = Number(b.tz_offset)
        if (!isFinite(off) || off < -720 || off > 840 || Math.floor(off) !== off) throw E(400, "invalid", "tz_offset must be whole minutes east of UTC (-720..840)")
        p.tz_offset = off
        changed = true
      }
      if (!changed) throw E(400, "invalid", "nothing to change (channel + level, digest_time, tz, tz_offset)")
      u.set("notify_prefs", p)
      app.save(u)
      return [200, prefsOut(u)]
    })
  },
}

/** The item a follow names, checked for visibility. */
function followTarget(app, ctx, kind, id) {
  if (kind === "post") {
    var p = byId(app, "posts", id)
    if (!p || L().channelHidden(ctx, p.getString("channel"))) throw E(404, "not_found", "post not found")
    if (p.getString("parent")) p = byId(app, "posts", p.getString("parent")) || p
    if (p.getString("task")) return { kind: "task", rec: byId(app, "tasks", p.getString("task")) || p }
    return { kind: "post", rec: p }
  }
  if (kind === "task") {
    var t
    try { t = L().findTask(app, id, "task") } catch (err) { throw E(404, "not_found", "task not found") }
    if (L().channelHidden(ctx, t.getString("channel")) && t.getString("owner_user") !== ctx.user.id) throw E(404, "not_found", "task not found")
    return { kind: "task", rec: t }
  }
  throw E(400, "invalid", "kind must be post or task")
}

/** Am I on this item without an explicit follow (author, assignee, owner, in the thread)? */
function implicitFollow(app, ctx, tg) {
  var uid = ctx.user.id
  var r = tg.rec
  if (tg.kind === "task") return r.getString("owner_user") === uid || agentOwner(app, r.getString("to_agent")) === uid || agentOwner(app, r.getString("from_agent")) === uid
  if (r.getString("author_user") === uid) return true
  if (r.getString("external_id")) {
    var x = parseJSON(r.getString("external")) || {}
    var login = lower(ctx.user.getString("github_login"))
    if (login && (lower(x.author) === login || arr(x.assignees).map(lower).indexOf(login) >= 0)) return true
  }
  return find(app, "posts", "parent = {:p} && author_user = {:u}", "", 1, { p: r.id, u: uid }).length > 0
}

function followOut(app, ctx, tg) {
  var f = find(app, "follows", "user = {:u} && kind = {:k} && target = {:t}", "", 1, { u: ctx.user.id, k: tg.kind, t: tg.rec.id })[0]
  var implicit = implicitFollow(app, ctx, tg)
  var explicit = f ? (f.getBool("on") ? "on" : "off") : ""
  return { kind: tg.kind, id: tg.rec.id, following: explicit ? explicit === "on" : implicit, implicit: implicit, explicit: explicit }
}

routes.getFollow = {
  allow: ["user"],
  fn: function (e, ctx) {
    return [200, followOut(e.app, ctx, followTarget(e.app, ctx, e.request.pathValue("kind"), e.request.pathValue("id")))]
  },
}

// PUT /api/ach/follows/{kind}/{id} {on: true|false|null (null: back to the default)}
routes.putFollow = {
  allow: ["user"],
  fn: function (e, ctx) {
    var b = L().body(e)
    return L().tx(e.app, function (app) {
      var tg = followTarget(app, ctx, e.request.pathValue("kind"), e.request.pathValue("id"))
      var f = find(app, "follows", "user = {:u} && kind = {:k} && target = {:t}", "", 1, { u: ctx.user.id, k: tg.kind, t: tg.rec.id })[0]
      if (b.on === null) {
        if (f) app.delete(f)
      } else {
        if (typeof b.on !== "boolean") throw E(400, "invalid", "on must be true, false or null")
        if (!f) {
          f = new Record(app.findCollectionByNameOrId("follows"))
          f.set("user", ctx.user.id)
          f.set("kind", tg.kind)
          f.set("target", tg.rec.id)
        }
        f.set("on", b.on)
        app.save(f)
      }
      return [200, followOut(app, ctx, tg)]
    })
  },
}

/** A cursor that moves whenever something this person can see changed. */
function changeCursor(app, ctx) {
  var D = L()
  var p = { u: ctx.type === "user" ? ctx.user.id : ctx.agent.getString("owner") }
  var q = function (sql) {
    var m = new DynamicModel({ at: "" })
    try { app.db().newQuery(sql).bind(p).one(m) } catch (err) {}
    return str(m.at)
  }
  var parts = [
    q("SELECT COALESCE(MAX(updated), '') AS at FROM posts WHERE " + D.hiddenSql("channel", ctx, p)),
    q("SELECT COALESCE(MAX(updated), '') AS at FROM tasks WHERE (" + D.hiddenSql("channel", ctx, p) + " OR owner_user = {:u})"),
    q("SELECT COALESCE(MAX(m.updated), '') AS at FROM messages m JOIN tasks t ON t.id = m.task WHERE (" + D.hiddenSql("t.channel", ctx, p) + " OR t.owner_user = {:u})"),
    q("SELECT COALESCE(MAX(updated), '') AS at FROM channels WHERE " + D.hiddenSql("id", ctx, p)),
    q("SELECT COALESCE(MAX(updated), '') AS at FROM notifications WHERE user = {:u}"),
    q("SELECT COALESCE(MAX(updated), '') AS at FROM grants WHERE grantor = {:u} OR grantee_user = {:u}"),
    q("SELECT COALESCE(MAX(updated), '') AS at FROM wiki_pages WHERE " + D.hiddenSql("channel", ctx, p)),
    q("SELECT COALESCE(MAX(updated), '') AS at FROM wiki_decisions WHERE " + D.hiddenSql("channel", ctx, p)),
    // the directory (agents online, people): the panel's sidebar
    q("SELECT COALESCE(MAX(updated), '') AS at FROM agents"),
    q("SELECT COALESCE(MAX(updated), '') AS at FROM users"),
  ]
  return parts.reduce(function (m, x) { return x > m ? x : m }, "")
}

// GET /api/ach/changes?since=<cursor>&wait=<s>: the realtime fallback (long poll).
// Returns at once when the cursor moved past `since` (or with no since), else
// after up to `wait` seconds (max 25) with changed: false.
routes.changes = {
  allow: ["user", "agent"],
  fn: function (e, ctx) {
    var q = e.request.url.query()
    var since = str(q.get("since"))
    var wait = Math.max(0, Math.min(LONGPOLL_MAX_S, parseInt(q.get("wait"), 10) || 0))
    var end = nowMs() + wait * 1000
    var cur = changeCursor(e.app, ctx)
    while (since && cur <= since && nowMs() < end) {
      sleep(1000)
      cur = changeCursor(e.app, ctx)
    }
    return [200, { changed: !since || cur > since, cursor: cur, server_time: iso(nowMs()) }]
  },
}

// GET /api/ach/me/attention[?since=]: counts only (no bodies) of what waits for
// my reply, for one-line session reminders (MCP) and notifiers. A person or an
// agent key (its owner's counts); run tokens are refused. Cheap: a few COUNTs.
// by_kind: decision (open decision requests to me, any age), question (channel
// questions / escalations addressed to me with no human reply since), mention
// and reply (reply-needed notifications since `since`, default 24 h ago).
routes.attention = {
  allow: ["user", "agent"],
  fn: function (e, ctx) {
    var app = e.app
    var uid = ctx.type === "user" ? ctx.user.id : ctx.agent.getString("owner")
    var q = e.request.url.query()
    var since = str(q.get("since")).replace("T", " ").trim()
    if (!parseTime(since)) since = iso(nowMs() - 24 * 3600 * 1000)
    var count = function (sql, p) {
      var m = new DynamicModel({ n: 0 })
      app.db().newQuery(sql).bind(p).one(m)
      return Number(m.n) || 0
    }
    var by = {
      decision: count("SELECT COUNT(*) AS n FROM messages WHERE kind = 'decision_request' AND resolved = 0 AND delegated_grant = '' AND (to_user = {:u} OR also_to LIKE {:like})", { u: uid, like: '%"' + uid + '"%' }),
      question: count("SELECT COUNT(*) AS n FROM posts p WHERE p.escalated = 1 AND p.to_user = {:u} AND NOT EXISTS (SELECT 1 FROM posts r WHERE (r.parent = CASE WHEN p.parent = '' THEN p.id ELSE p.parent END OR r.id = CASE WHEN p.parent = '' THEN p.id ELSE p.parent END) AND r.author_type = 'human' AND r.created > p.created)", { u: uid }),
      mention: count("SELECT COUNT(*) AS n FROM notifications WHERE user = {:u} AND reply_needed = 1 AND reason = 'mention' AND created > {:s}", { u: uid, s: since }),
      reply: count("SELECT COUNT(*) AS n FROM notifications WHERE user = {:u} AND reply_needed = 1 AND reason = 'reply' AND created > {:s}", { u: uid, s: since }),
    }
    try { e.response.header().set("Cache-Control", "private, max-age=15") } catch (err) {}
    return [200, { needs_reply_count: by.decision + by.question + by.mention + by.reply, by_kind: by, since: since, url: publicUrl() + "/#/inbox", server_time: iso(nowMs()) }]
  },
}

// Test-only (ACH_TEST_HOOKS=1, superuser): flush + digest with a simulated clock.
routes.testTick = {
  allow: ["superuser"],
  fn: function (e) {
    var b = L().body(e)
    var now = Number(b.now_ms) || nowMs()
    var f = flush(e.app, now)
    var d = digest(e.app, now)
    return [200, { pushed: f.pushed, sent: f.sent, digests: d.digests }]
  },
}

function run(e, name) {
  var r = routes[name]
  try {
    var ctx
    if (r.allow[0] === "superuser") {
      if ($os.getenv("ACH_TEST_HOOKS") !== "1") throw E(404, "not_found", "not found")
      if (!e.hasSuperuserAuth()) throw E(401, "unauthorized", "superuser only")
      ctx = { type: "superuser" }
    } else {
      var D = L()
      ctx = D.authenticate(e)
      D.requireAuth(ctx, r.allow, r.runModes)
      D.hiddenChannels(e.app, ctx)
    }
    var out = r.fn(e, ctx)
    return e.json(out[0], out[1])
  } catch (err) {
    if (err && err.achError) {
      var payload = { error: err.message, code: err.code }
      if (err.extra) for (var k in err.extra) payload[k] = err.extra[k]
      return e.json(err.status, payload)
    }
    var msg = String((err && err.message) || err)
    if (/validation|cannot be blank|must be/i.test(msg)) return e.json(400, { error: msg, code: "invalid" })
    e.app.logger().error("ach notify route error", "route", name, "error", msg)
    return e.json(500, { error: "internal error" + ($os.getenv("ACH_TEST_HOOKS") === "1" ? ": " + msg : ""), code: "internal" })
  }
}

module.exports = {
  run: run, onRecord: onRecord, importReleases: importReleases, flush: flush, digest: digest, flushIfDirty: flushIfDirty,
  digestSlot: digestSlot, emit: emit, eventLabel: eventLabel,
  decisionEvent: decisionEvent, decisionFields: decisionFields, decisionState: decisionState, mintActions: mintActions, memberExcerpt: memberExcerpt,
  ACTION_RE: ACTION_RE, DECISION_EVENTS: DECISION_EVENTS,
  // optional chat adapters (ach_feishu.js) call routes through ach_lib callRoute-style contexts
  routes: routes,
}
