/// <reference path="../pb_data/types.d.ts" />
// Authorization grants. Loaded with
// require() from ach_routes.pb.js and ach_lib.js. Keep ES5-style (goja).
//
// People only reply. Who may decide a decision request:
//  - the person it is addressed to (panel or Feishu reply);
//  - that person's own agent with its agent key (an interactive session where
//    the person is present), recorded "via <agent>";
//  - under a grant: a grantee PERSON (the request is also routed to their
//    Inbox; their reply counts "on behalf of <grantor> per #id"), or a grantee
//    AGENT's runner on its run token, for the options the grant covers.
// Never: a run token without a grant; an agent speaking for anyone but its
// owner; the grantee person's own agents (a person-grant is not inherited).
//
// Enforcement is deterministic: an active grant covers the request's task (or
// its channel), the requester filter matches, the option's money fits the
// remaining cumulative cap, it has not expired, and the option carries no
// never-delegable flag (irreversible, deploy, delete, external). Options outside
// a grant go to the person. A grant lapses on expiry, task end or an exhausted cap.

var FLAGS = ["irreversible", "deploy", "delete", "external"]
// Each pattern also matches the Chinese wording (language support for Chinese input).
var FLAG_RE = {
  delete: /\b(delete|deleting|drop (the )?(table|database|bucket)|rm -rf|purge|wipe)\b|删除|删掉|清空|销毁/i,
  deploy: /\b(deploy|release|ship|roll ?out|push) (it )?(to )?(prod|production)\b|\bproduction deploy|上线|发布到生产|部署到生产|生产环境发布/i,
  external: /\b(email|e-mail|send (it )?to (the )?(customer|client|partner|vendor|user)s?|post publicly|tweet|press release|announce externally)\b|对外|发给客户|发邮件|公开发布/i,
  irreversible: /\b(irreversible|cannot be undone|can't be undone|no rollback|permanent(ly)?)\b|不可逆|无法撤销|不能回滚/i,
}

function L() { return require(__hooks + "/ach_lib.js").wikiDeps() }
function AchError(status, code, message, extra) { this.achError = true; this.status = status; this.code = code; this.message = message; this.extra = extra || null }
function E(status, code, message, extra) { return new AchError(status, code, message, extra) }
function str(v) { return v === undefined || v === null ? "" : String(v) }
function arr(v) { return Array.isArray(v) ? v : [] }
function parseJSON(s) { if (!s) return null; try { return typeof s === "string" ? JSON.parse(s) : s } catch (err) { return null } }
function find(app, coll, filter, sort, limit, params) { return app.findRecordsByFilter(coll, filter, sort || "", limit || 1000, 0, params || {}) }
function oneLine(s, max) { return str(s).replace(/\s+/g, " ").trim().slice(0, max || 300) }

// ---------------------------------------------------------------- options

/** The money of an option: the largest amount in its money text ("$20–30" -> 30); 0 when none. */
function optionMoney(o) {
  var m = str(o && o.money).replace(/,/g, "").match(/[0-9]+(?:\.[0-9]+)?/g)
  if (!m) return 0
  return Math.max.apply(null, m.map(Number))
}

/** Never-delegable flags: declared ones plus what the option's words say. */
function optionFlags(o) {
  var out = arr(o && o.flags).map(function (f) { return str(f).toLowerCase() }).filter(function (f) { return FLAGS.indexOf(f) >= 0 })
  var text = [str(o && o.label), str(o && o.detail)].join(" ")
  FLAGS.forEach(function (f) { if (out.indexOf(f) < 0 && FLAG_RE[f].test(text)) out.push(f) })
  return out
}

// ---------------------------------------------------------------- grants

function nowIso() { return L().iso(L().nowMs()) }

/** Is this grant usable now (and lapse it when it is not)? */
function liveGrant(app, g) {
  if (g.getString("status") !== "active") return false
  var D = L()
  var lapsed = false
  if (g.getString("expires_at") && D.parseTime(g.getString("expires_at")) <= D.nowMs()) lapsed = true
  if (g.getFloat("money_cap") > 0 && g.getFloat("used") >= g.getFloat("money_cap")) lapsed = true
  if (g.getString("scope_kind") === "task") {
    try { if (["completed", "failed", "canceled"].indexOf(app.findRecordById("tasks", g.getString("scope_id")).getString("status")) >= 0) lapsed = true } catch (err) { lapsed = true }
  }
  if (lapsed) { g.set("status", "lapsed"); app.save(g); return false }
  return true
}

function remaining(g) { return Math.max(0, g.getFloat("money_cap") - g.getFloat("used")) }

/** Grants that cover a request on task t, by `requester` (the asking agent record). */
function covering(app, t, requester, filter) {
  var list = find(app, "grants", "status = 'active' && ((scope_kind = 'task' && scope_id = {:t}) || (scope_kind = 'channel' && scope_id = {:c}))" + (filter ? " && " + filter.f : ""), "created", 100,
    Object.assign({ t: t.id, c: t.getString("channel") || "-" }, filter ? filter.p : {}))
  return list.filter(function (g) {
    if (!liveGrant(app, g)) return false
    if (g.getString("requester_agent") && (!requester || requester.id !== g.getString("requester_agent"))) return false
    if (g.getString("requester_user") && (!requester || requester.getString("owner") !== g.getString("requester_user"))) return false
    return true
  })
}

/** May option o be decided under grant g (flags, money within the remaining cap)? */
function optionFits(g, o) {
  if (optionFlags(o).length) return false
  return optionMoney(o) <= remaining(g)
}

/**
 * Plan for a new decision request from agent `me` on task t to person `toUser`:
 *  - people: grantee persons of person-grants by toUser that cover it (their Inbox gets it too);
 *  - agent: an agent grant by toUser to `me` itself, with the option indexes it covers
 *    (the request is split: those options go to `me` to answer under the grant, the rest to the person).
 */
function planRequest(app, t, me, toUser, choices) {
  var out = { people: [], personGrants: [], agentGrant: null, delegable: [] }
  var gs = covering(app, t, me, { f: "grantor = {:g}", p: { g: toUser } })
  gs.forEach(function (g) {
    if (g.getString("grantee_user")) {
      // a person-grant routes the request when at least one option (or a plain question) fits
      var fits = !choices || choices.options.some(function (o) { return optionFits(g, o) })
      if (fits && out.people.indexOf(g.getString("grantee_user")) < 0) { out.people.push(g.getString("grantee_user")); out.personGrants.push(g) }
    } else if (g.getString("grantee_agent") === me.id && choices && !out.agentGrant) {
      var idx = []
      choices.options.forEach(function (o, i) { if (optionFits(g, o)) idx.push(i) })
      if (idx.length) { out.agentGrant = g; out.delegable = idx }
    }
  })
  return out
}

function debit(app, g, amount) {
  g.set("used", Math.round((g.getFloat("used") + (amount || 0)) * 100) / 100)
  app.save(g)
  liveGrant(app, g)
}

/** The grant (by id) a person may use to answer request `req` on task t, with the picked option (or -1 for free text). */
function personGrantFor(app, t, req, userId, pick) {
  var D = L()
  var choices = parseJSON(req.getString("choices"))
  var requester = null
  try { requester = app.findRecordById("agents", req.getString("author_agent")) } catch (err) {}
  var gs = covering(app, t, requester, { f: "grantor = {:g} && grantee_user = {:u}", p: { g: req.getString("to_user"), u: userId } })
  for (var i = 0; i < gs.length; i++) {
    var g = gs[i]
    if (!choices) return { grant: g, money: 0 }
    if (pick >= 0) {
      if (optionFits(g, choices.options[pick])) return { grant: g, money: optionMoney(choices.options[pick]) }
      continue
    }
    // free text from a grantee: only when every option is within the grant (no flags, money fits)
    if (choices.options.every(function (o) { return optionFits(g, o) })) return { grant: g, money: 0 }
  }
  return null
}

// ---------------------------------------------------------------- output

function grantOut(app, g, names) {
  var D = L()
  liveGrant(app, g)
  var scopeName = g.getString("scope_id")
  try {
    if (g.getString("scope_kind") === "task") scopeName = D.taskRef(app.findRecordById("tasks", g.getString("scope_id")))
    else scopeName = "#" + names.channel(g.getString("scope_id"))
  } catch (err) {}
  var exp = g.getString("expires_at")
  var left = exp ? Math.max(0, Math.floor((D.parseTime(exp) - D.nowMs()) / 3600000)) : null
  // decisions made under this grant, by day (the panel's daily digest)
  var days = {}
  find(app, "messages", "grant = {:g} && kind = 'decision'", "-created", 500, { g: g.id }).forEach(function (m) {
    var day = m.getString("created").slice(0, 10)
    var d = days[day] || (days[day] = { day: day, count: 0, lines: [] })
    d.count++
    var t = null
    try { t = app.findRecordById("tasks", m.getString("task")) } catch (err) {}
    if (d.lines.length < 10) d.lines.push({ text: oneLine(m.getString("body"), 200), by: m.getString("author_type") === "human" ? names.user(m.getString("author_user")) : names.agent(m.getString("author_agent")), url: t ? D.linkUrl("t/" + D.taskRef(t) + "/m/" + m.id) : "" })
  })
  return {
    id: g.id, status: g.getString("status"),
    grantor: g.getString("grantor"), grantor_name: names.user(g.getString("grantor")),
    grantee_kind: g.getString("grantee_agent") ? "agent" : "person",
    grantee: g.getString("grantee_agent") || g.getString("grantee_user"),
    grantee_name: g.getString("grantee_agent") ? names.agent(g.getString("grantee_agent")) : names.user(g.getString("grantee_user")),
    scope_kind: g.getString("scope_kind"), scope_id: g.getString("scope_id"), scope_name: scopeName,
    money_cap: g.getFloat("money_cap"), used: g.getFloat("used"), remaining: remaining(g),
    expires_at: exp, hours_left: left, guidance: g.getString("guidance"),
    requester_name: g.getString("requester_agent") ? names.agent(g.getString("requester_agent")) : g.getString("requester_user") ? names.user(g.getString("requester_user")) : "",
    created_via: g.getString("created_via"), created: g.getString("created"),
    digest: Object.keys(days).sort().reverse().map(function (k) { return days[k] }),
  }
}

// ---------------------------------------------------------------- create / revoke

/**
 * Create a grant. grantor: a user record. b: {agent | person, task | channel,
 * cap, until, note, requester}. via: "panel", "session" (agent key) or "reply".
 */
function createGrant(app, grantor, b, via, source) {
  var D = L()
  var g = new Record(app.findCollectionByNameOrId("grants"))
  g.set("grantor", grantor.id)
  var agentRef = str(b.agent).trim()
  var personRef = str(b.person).trim()
  if (!!agentRef === !!personRef) throw E(400, "invalid", "grant to exactly one of agent or person")
  if (agentRef) {
    var a = find(app, "agents", "name = {:n} || id = {:n}", "", 1, { n: agentRef })
    if (!a.length) throw E(404, "not_found", "no agent '" + agentRef + "'")
    g.set("grantee_agent", a[0].id)
  } else {
    var u = find(app, "users", "id = {:r} || email = {:l} || name = {:r} || github_login = {:r}", "", 1, { r: personRef.replace(/^@/, ""), l: personRef.toLowerCase() })
    if (!u.length) throw E(404, "not_found", "no person '" + personRef + "'")
    if (u[0].id === grantor.id) throw E(400, "invalid", "you cannot grant yourself")
    g.set("grantee_user", u[0].id)
  }
  var hidden = D.hiddenChannels(app, { type: "user", user: grantor, isAdmin: grantor.getBool("is_admin") })
  if (str(b.task).trim()) {
    var t = D.findTask(app, str(b.task).trim(), "task")
    if (hidden.indexOf(t.getString("channel")) >= 0) throw E(404, "not_found", "task not found")
    g.set("scope_kind", "task")
    g.set("scope_id", t.id)
  } else if (str(b.channel).trim()) {
    var c = D.findChannel(app, b.channel)
    if (hidden.indexOf(c.id) >= 0) throw E(404, "not_found", "channel not found")
    g.set("scope_kind", "channel")
    g.set("scope_id", c.id)
  } else throw E(400, "invalid", "a grant needs a scope: --task <T-n> or --channel <name>")
  var cap = Number(b.cap === undefined || b.cap === null || b.cap === "" ? 0 : b.cap)
  if (!(cap >= 0 && cap <= 1000000)) throw E(400, "invalid", "cap must be a number of dollars (0–1000000)")
  g.set("money_cap", cap)
  g.set("used", 0)
  var until = str(b.until).trim()
  var ms = until ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(until) ? until + "T23:59:59Z" : until.replace(" ", "T")) : D.nowMs() + 7 * 24 * 3600 * 1000
  if (isNaN(ms) || ms <= D.nowMs()) throw E(400, "invalid", "until must be a future date (YYYY-MM-DD)")
  if (ms > D.nowMs() + 366 * 24 * 3600 * 1000) throw E(400, "invalid", "a grant lasts at most a year")
  g.set("expires_at", D.iso(ms))
  g.set("guidance", oneLine(b.note || b.guidance, 2000))
  if (str(b.requester).trim()) {
    var ra = find(app, "agents", "name = {:n} || id = {:n}", "", 1, { n: str(b.requester).trim() })
    if (ra.length) g.set("requester_agent", ra[0].id)
    else {
      var ru = find(app, "users", "id = {:r} || email = {:l} || name = {:r} || github_login = {:r}", "", 1, { r: str(b.requester).trim(), l: str(b.requester).trim().toLowerCase() })
      if (!ru.length) throw E(404, "not_found", "no agent or person '" + str(b.requester) + "' (requester)")
      g.set("requester_user", ru[0].id)
    }
  }
  g.set("status", "active")
  g.set("created_via", via)
  g.set("source", str(source).slice(0, 600))
  app.save(g)
  return g
}

/** The person a caller speaks for: a user is themselves; an agent key speaks for its owner. Run tokens never. */
function speaker(app, ctx) {
  if (ctx.type === "user") return ctx.user
  if (ctx.type === "agent") return app.findRecordById("users", app.findRecordById("agents", ctx.agent.id).getString("owner"))
  throw E(403, "forbidden", "a background run cannot grant or revoke authorization")
}

var routes = {}

// POST /grants {agent|person, task|channel, cap, until, note, requester}: a person (panel) or their agent in an interactive session (agent key).
routes.create = {
  allow: ["user", "agent"],
  fn: function (e, ctx) {
    var D = L()
    var b = D.body(e)
    return D.tx(e.app, function (app) {
      var who = speaker(app, ctx)
      var g = createGrant(app, who, b, ctx.type === "user" ? "panel" : "session:" + ctx.agent.id, "")
      return [201, grantOut(app, g, new D.Names(app))]
    })
  },
}

// GET /grants: grants I gave (to agents and people) and grants given to me (or, for an agent, to it).
routes.list = {
  allow: ["user", "agent", "run"], runModes: ["work", "answer"],
  fn: function (e, ctx) {
    var D = L()
    var app = e.app
    var names = new D.Names(app)
    if (ctx.type === "user") {
      return [200, {
        given: find(app, "grants", "grantor = {:u}", "-created", 500, { u: ctx.user.id }).map(function (g) { return grantOut(app, g, names) }),
        received: find(app, "grants", "grantee_user = {:u}", "-created", 500, { u: ctx.user.id }).map(function (g) { return grantOut(app, g, names) }),
      }]
    }
    var owner = app.findRecordById("agents", ctx.agent.id).getString("owner")
    return [200, {
      given: ctx.type === "agent" ? find(app, "grants", "grantor = {:u}", "-created", 500, { u: owner }).map(function (g) { return grantOut(app, g, names) }) : [],
      received: find(app, "grants", "grantee_agent = {:a}", "-created", 500, { a: ctx.agent.id }).map(function (g) { return grantOut(app, g, names) }),
    }]
  },
}

// POST /grants/{id}/revoke: the grantor (or their agent key), or an admin.
routes.revoke = {
  allow: ["user", "agent"],
  fn: function (e, ctx) {
    var D = L()
    return D.tx(e.app, function (app) {
      var g = D.findOr404(app, "grants", e.request.pathValue("id"), "grant")
      var who = speaker(app, ctx)
      if (g.getString("grantor") !== who.id && !(ctx.type === "user" && ctx.isAdmin)) throw E(404, "not_found", "grant not found")
      if (g.getString("status") === "active") { g.set("status", "revoked"); app.save(g) }
      return [200, grantOut(app, g, new D.Names(app))]
    })
  },
}

// POST /tasks/{id}/grant-decide {message_id, option, grant}: a grantee agent's runner answers the part of a request its grant covers.
routes.decide = {
  allow: ["agent", "run"], runModes: ["work", "answer"],
  fn: function (e, ctx) {
    var D = L()
    var b = D.body(e)
    return D.tx(e.app, function (app) {
      var t = D.findTask(app, e.request.pathValue("id"), "task")
      var req = D.findOr404(app, "messages", str(b.message_id), "decision request")
      if (req.getString("task") !== t.id || req.getString("kind") !== "decision_request") throw E(400, "invalid", "message_id is not a decision request on this task")
      if (req.getBool("resolved")) throw E(409, "resolved", "decision request already resolved")
      var g = null
      try { g = app.findRecordById("grants", str(b.grant)) } catch (err) {}
      if (!g || req.getString("delegated_grant") !== g.id) throw E(403, "forbidden", "no grant covers this request: a person decides it")
      if (g.getString("grantee_agent") !== ctx.agent.id) throw E(403, "forbidden", "this grant is for another agent")
      if (!liveGrant(app, g)) throw E(403, "forbidden", "the grant is no longer active (revoked, expired or used up)")
      var choices = parseJSON(req.getString("choices"))
      var i = parseInt(b.option, 10)
      if (!choices || !(i >= 0 && i < choices.options.length)) throw E(400, "invalid", "option must be the index of one of the request's options")
      var o = choices.options[i]
      if (!optionFits(g, o)) throw E(403, "forbidden", "that option is outside the grant (money over the remaining cap, or never delegable): a person decides it")
      var names = new D.Names(app)
      var me = app.findRecordById("agents", ctx.agent.id)
      var text = "per " + names.user(g.getString("grantor")) + "'s authorization #" + g.id + ": " + D.optionText(o, false, "en")
      req.set("resolved", true)
      app.save(req)
      var m = D.addMsg(app, t, { author_type: "agent", author_agent: me.id, kind: "decision", body: text, reply_to: req.id, grant: g.id, to_agent: me.id })
      debit(app, g, optionMoney(o))
      require(__hooks + "/ach_wiki.js").onGrantDecision(app, t, req, m, g)
      return [200, { message: { id: m.id, body: text, grant: g.id }, grant: grantOut(app, g, names) }]
    })
  },
}

function run(e, name) {
  var r = routes[name]
  try {
    var D = L()
    var ctx = D.authenticate(e)
    D.requireAuth(ctx, r.allow, r.runModes)
    D.hiddenChannels(e.app, ctx)
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
    e.app.logger().error("ach grants route error", "route", name, "error", msg)
    return e.json(500, { error: "internal error" + ($os.getenv("ACH_TEST_HOOKS") === "1" ? ": " + msg : ""), code: "internal" })
  }
}

module.exports = {
  run: run, FLAGS: FLAGS, optionMoney: optionMoney, optionFlags: optionFlags, optionFits: optionFits,
  planRequest: planRequest, personGrantFor: personGrantFor, liveGrant: liveGrant, debit: debit, createGrant: createGrant, grantOut: grantOut,
}
