/// <reference path="../pb_data/types.d.ts" />
// AgentChannel /api/ach routes. One handler per route; each authenticates by
// bearer prefix (ach_sk_ agent key, ach_rt_ run token, else PocketBase user).
// All logic lives in ach_lib.js (handlers run in isolated contexts).

// Routes that accept attachments (multipart) get a larger body limit:
// ACH_MAX_REQUEST_MB (default 1024). The per-file limit is ACH_MAX_FILE_MB
// (default 200), enforced in ach_lib.js. Note: Cloudflare's free plan caps
// request bodies at 100 MB.
const achBodyLimit = () => $apis.bodyLimit((parseInt($os.getenv("ACH_MAX_REQUEST_MB") || "1024", 10) || 1024) * 1024 * 1024)

routerAdd("GET", "/api/ach/me", (e) => require(`${__hooks}/ach_lib.js`).run(e, "me"))
routerAdd("GET", "/api/ach/me/inbox", (e) => require(`${__hooks}/ach_lib.js`).run(e, "myInbox"))
routerAdd("PATCH", "/api/ach/me", (e) => require(`${__hooks}/ach_lib.js`).run(e, "patchMe"))
routerAdd("GET", "/api/ach/agents", (e) => require(`${__hooks}/ach_lib.js`).run(e, "agents"))
routerAdd("GET", "/api/ach/inbox", (e) => require(`${__hooks}/ach_lib.js`).run(e, "inbox"))
routerAdd("GET", "/api/ach/panel", (e) => require(`${__hooks}/ach_lib.js`).run(e, "panel"))

routerAdd("POST", "/api/ach/tasks", (e) => require(`${__hooks}/ach_lib.js`).run(e, "createTask"), achBodyLimit())
routerAdd("GET", "/api/ach/tasks/{id}", (e) => require(`${__hooks}/ach_lib.js`).run(e, "getTask"))
routerAdd("PATCH", "/api/ach/tasks/{id}", (e) => require(`${__hooks}/ach_lib.js`).run(e, "patchTask"))
routerAdd("PUT", "/api/ach/tasks/{id}/handoff", (e) => require(`${__hooks}/ach_lib.js`).run(e, "handoff"), achBodyLimit())
routerAdd("POST", "/api/ach/tasks/{id}/claim", (e) => require(`${__hooks}/ach_lib.js`).run(e, "claim"))
routerAdd("POST", "/api/ach/tasks/{id}/heartbeat", (e) => require(`${__hooks}/ach_lib.js`).run(e, "heartbeat"))
routerAdd("POST", "/api/ach/tasks/{id}/usage", (e) => require(`${__hooks}/ach_lib.js`).run(e, "usage"))
routerAdd("POST", "/api/ach/tasks/{id}/answer-run", (e) => require(`${__hooks}/ach_lib.js`).run(e, "answerRun"))
routerAdd("POST", "/api/ach/tasks/{id}/end-run", (e) => require(`${__hooks}/ach_lib.js`).run(e, "endRun"))
routerAdd("POST", "/api/ach/tasks/{id}/messages", (e) => require(`${__hooks}/ach_lib.js`).run(e, "postMessage"), achBodyLimit())
routerAdd("POST", "/api/ach/tasks/{id}/complete", (e) => require(`${__hooks}/ach_lib.js`).run(e, "complete"), achBodyLimit())
routerAdd("POST", "/api/ach/tasks/{id}/fail", (e) => require(`${__hooks}/ach_lib.js`).run(e, "fail"))
routerAdd("POST", "/api/ach/tasks/{id}/cancel", (e) => require(`${__hooks}/ach_lib.js`).run(e, "cancel"))
routerAdd("POST", "/api/ach/tasks/{id}/note", (e) => require(`${__hooks}/ach_lib.js`).run(e, "note"), achBodyLimit())
routerAdd("POST", "/api/ach/tasks/{id}/request-changes", (e) => require(`${__hooks}/ach_lib.js`).run(e, "requestChanges"), achBodyLimit())
routerAdd("GET", "/api/ach/summary", (e) => require(`${__hooks}/ach_lib.js`).run(e, "summary"))
routerAdd("GET", "/api/ach/files/{coll}/{rid}/{name}", (e) => require(`${__hooks}/ach_lib.js`).run(e, "file"))
routerAdd("POST", "/api/ach/tasks/{id}/decide", (e) => require(`${__hooks}/ach_lib.js`).run(e, "decide"), achBodyLimit())

// Channels, posts, mentions, search, activity, profiles, settings.
routerAdd("GET", "/api/ach/channels", (e) => require(`${__hooks}/ach_lib.js`).run(e, "listChannels"))
routerAdd("POST", "/api/ach/channels", (e) => require(`${__hooks}/ach_lib.js`).run(e, "createChannel"))
routerAdd("PATCH", "/api/ach/channels/{id}", (e) => require(`${__hooks}/ach_lib.js`).run(e, "patchChannel"))
routerAdd("GET", "/api/ach/channels/{id}/posts", (e) => require(`${__hooks}/ach_lib.js`).run(e, "channelPosts"))
routerAdd("POST", "/api/ach/channels/{id}/posts", (e) => require(`${__hooks}/ach_lib.js`).run(e, "createChannelPost"), achBodyLimit())
routerAdd("GET", "/api/ach/posts/{id}", (e) => require(`${__hooks}/ach_lib.js`).run(e, "getPost"))
routerAdd("POST", "/api/ach/posts/{id}/replies", (e) => require(`${__hooks}/ach_lib.js`).run(e, "replyPost"), achBodyLimit())
routerAdd("POST", "/api/ach/mentions/{id}/run", (e) => require(`${__hooks}/ach_lib.js`).run(e, "mentionRun"))
routerAdd("POST", "/api/ach/mentions/{id}/end", (e) => require(`${__hooks}/ach_lib.js`).run(e, "mentionEnd"))
routerAdd("POST", "/api/ach/mentions/{id}/usage", (e) => require(`${__hooks}/ach_lib.js`).run(e, "mentionUsage"))
routerAdd("GET", "/api/ach/search", (e) => require(`${__hooks}/ach_lib.js`).run(e, "search"))
routerAdd("GET", "/api/ach/activity", (e) => require(`${__hooks}/ach_lib.js`).run(e, "activity"))
routerAdd("GET", "/api/ach/profiles/agents/{name}", (e) => require(`${__hooks}/ach_lib.js`).run(e, "agentProfile"))
routerAdd("GET", "/api/ach/profiles/users/{id}", (e) => require(`${__hooks}/ach_lib.js`).run(e, "userProfile"))
routerAdd("GET", "/api/ach/settings", (e) => require(`${__hooks}/ach_lib.js`).run(e, "getSettings"))
routerAdd("GET", "/api/ach/admin/settings", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminSettings"))
routerAdd("PUT", "/api/ach/admin/settings", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminSettings"))
routerAdd("GET", "/api/ach/admin/storage", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminStorage"))

// The panel's CSP is a response header (not a <meta>), so frame-src can
// follow the admin-managed embed allowlist. Every non-API response gets it,
// including the index.html fallback for unknown paths.
routerUse((e) => {
  const path = e.request.url.path
  if (!path.startsWith("/api/") && !path.startsWith("/_/")) {
    try {
      e.response.header().set("Content-Security-Policy", require(`${__hooks}/ach_lib.js`).panelCsp(e.app))
      e.response.header().set("X-Content-Type-Options", "nosniff")
      e.response.header().set("Referrer-Policy", "no-referrer")
    } catch (err) {
      e.app.logger().error("ach csp failed", "error", String(err))
    }
  }
  return e.next()
})

// PocketBase's own file route (file token) serves text, code and .html
// attachments as text/plain downloads too; media is served normally.
onFileDownloadRequest((e) => {
  if (require(`${__hooks}/ach_lib.js`).serveFileHook(e)) return
  e.next()
}, "messages", "handoff_versions", "posts")

// Human login: public routes (they authenticate by what they carry).
routerAdd("GET", "/api/ach/auth/config", (e) => require(`${__hooks}/ach_lib.js`).run(e, "authConfig"))
routerAdd("POST", "/api/ach/auth/cf", (e) => require(`${__hooks}/ach_lib.js`).run(e, "authCf"))
routerAdd("POST", "/api/ach/auth/link", (e) => require(`${__hooks}/ach_lib.js`).run(e, "authLink"))
routerAdd("POST", "/api/ach/auth/link/peek", (e) => require(`${__hooks}/ach_lib.js`).run(e, "authLinkPeek"))
routerAdd("POST", "/api/ach/login-link", (e) => require(`${__hooks}/ach_lib.js`).run(e, "loginLink"))
routerAdd("POST", "/api/ach/auth/device-link", (e) => require(`${__hooks}/ach_lib.js`).run(e, "deviceLink"))
routerAdd("POST", "/api/ach/auth/logout", (e) => require(`${__hooks}/ach_lib.js`).run(e, "logout"))

// B1: a session minted from an agent key (`ach open`) carries ach_scope
// "agent" (never admin), also across auth-refresh.
onRecordAuthRequest((e) => {
  require(`${__hooks}/ach_lib.js`).scopeAuth(e)
  e.next()
}, "users")
// B3: password login only for superuser-flagged people; no password resets.
onRecordAuthWithPasswordRequest((e) => require(`${__hooks}/ach_lib.js`).passwordAuthHook(e), "users")
onRecordRequestPasswordResetRequest((e) => require(`${__hooks}/ach_lib.js`).passwordResetHook(e), "users")
// B2/B10: per-email request-otp limit; deactivated people get a dummy otpId.
onRecordRequestOTPRequest((e) => require(`${__hooks}/ach_lib.js`).requestOtpHook(e), "users")
// B5: links need ACH_PUBLIC_URL in production. Also records when this process
// started: the sweep gives runner leases a grace period after a restart.
onBootstrap((e) => {
  e.next()
  e.app.store().set(require(`${__hooks}/ach_lib.js`).BOOT_KEY, String(Date.now()))
  if (!require(`${__hooks}/ach_lib.js`).configuredPublicUrl()) {
    const msg = "ACH_PUBLIC_URL is not set: login links, invites and notifications only work for localhost. Set it to the panel's public URL."
    e.app.logger().warn(msg)
    console.log("WARNING: " + msg)
  }
})

routerAdd("GET", "/api/ach/admin/users", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminListUsers"))
routerAdd("POST", "/api/ach/admin/users", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminCreateUser"))
routerAdd("PATCH", "/api/ach/admin/users/{id}", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminPatchUser"))
routerAdd("POST", "/api/ach/admin/users/{id}/login-link", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminUserLoginLink"))
routerAdd("POST", "/api/ach/admin/agents", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminCreateAgent"))
// one-time invites ("ach2."): the join token is exchanged once for a fresh agent key
routerAdd("POST", "/api/ach/invite/exchange", (e) => require(`${__hooks}/ach_lib.js`).run(e, "inviteExchange"))
routerAdd("POST", "/api/ach/admin/agents/{id}/rotate-key", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminRotateKey"))
routerAdd("PATCH", "/api/ach/admin/agents/{id}", (e) => require(`${__hooks}/ach_lib.js`).run(e, "adminPatchAgent"))

// Test-only: runs the cron sweep with a simulated clock offset. Returns 404
// unless the hub was started with ACH_TEST_HOOKS=1, and requires a superuser.
routerAdd("POST", "/api/ach/_test/sweep", (e) => require(`${__hooks}/ach_lib.js`).run(e, "testSweep"))
routerAdd("POST", "/api/ach/_test/expire-login-tokens", (e) => require(`${__hooks}/ach_lib.js`).run(e, "testExpireLoginTokens"))
routerAdd("GET", "/api/ach/_test/otp", (e) => require(`${__hooks}/ach_lib.js`).run(e, "testOtp"))
routerAdd("POST", "/api/ach/_test/token-expiry", (e) => require(`${__hooks}/ach_lib.js`).run(e, "testTokenExpiry"))

// Every minute: escalate unanswered questions, expire stale claim leases
// (runner 10 min, interactive 24 h), and notify owners of tasks idle > 24 h.
cronAdd("ach_sweep", "* * * * *", () => {
  const lib = require(`${__hooks}/ach_lib.js`)
  try {
    const r = lib.sweep($app, lib.nowMs(), "")
    if (r.escalated || r.expired || r.idle) $app.logger().info("ach sweep", "escalated", r.escalated, "expired", r.expired, "idle", r.idle)
  } catch (err) {
    $app.logger().error("ach sweep failed", "error", String(err))
  }
})

// Hidden fields are hidden from users by the schema; superusers would still
// see them in API responses, so strip secrets for every requester.
onRecordEnrich((e) => {
  // hide after the core handler, which un-hides fields for superusers
  e.next()
  e.record.hide("key_hash")
}, "agents")
onRecordEnrich((e) => {
  // P5: a user's webhook URL is a secret (Feishu bot URLs carry the token)
  e.next()
  e.record.hide("notify_webhook")
}, "users")
onRecordEnrich((e) => {
  // hide after the core handler, which un-hides fields for superusers
  e.next()
  e.record.hide("token_hash")
}, "run_tokens")

// Test-only: with ACH_TEST_HOOKS=1 and ACH_TEST_CAPTURE_MAIL=1, OTP emails are
// captured (readable by a superuser via GET /api/ach/_test/otp) instead of sent.
onMailerRecordOTPSend((e) => {
  if ($os.getenv("ACH_TEST_HOOKS") === "1" && $os.getenv("ACH_TEST_CAPTURE_MAIL") === "1") {
    const meta = e.meta || {}
    e.app.store().set("ach_test_otp:" + String(e.record.email()).toLowerCase(), JSON.stringify({ otp_id: String(meta.otpId || ""), code: String(meta.password || "") }))
    return
  }
  e.next()
}, "users")
onRecordEnrich((e) => {
  e.next()
  e.record.hide("token_hash")
}, "login_tokens", "push_actions", "agent_joins")

// --- import/onboarding routes ---
// Team onboarding from GitHub (pb_hooks/ach_import.js). The `ach` CLI reads
// GitHub with the admin's own gh login and pushes plan + items here; the hub
// never stores a GitHub token. /me/welcome is each person's first view.
routerAdd("GET", "/api/ach/admin/import/state", (e) => require(`${__hooks}/ach_import.js`).run(e, "importState"))
routerAdd("POST", "/api/ach/admin/import/apply", (e) => require(`${__hooks}/ach_import.js`).run(e, "importApply"), $apis.bodyLimit(32 * 1024 * 1024))
routerAdd("GET", "/api/ach/me/welcome", (e) => require(`${__hooks}/ach_import.js`).run(e, "welcome"))

// --- Authorization grants ---
routerAdd("GET", "/api/ach/grants", (e) => require(`${__hooks}/ach_grants.js`).run(e, "list"))
routerAdd("POST", "/api/ach/grants", (e) => require(`${__hooks}/ach_grants.js`).run(e, "create"))
routerAdd("POST", "/api/ach/grants/{id}/revoke", (e) => require(`${__hooks}/ach_grants.js`).run(e, "revoke"))
routerAdd("POST", "/api/ach/tasks/{id}/grant-decide", (e) => require(`${__hooks}/ach_grants.js`).run(e, "decide"))

// --- Memory routes (formerly "wiki") ---
// Team Memory: topic pages with
// versions, keyed figures, decisions, contributions, per-channel upkeep tasks,
// the team overview, promote-to-team, contradiction holds, the optional API
// maintainer and trial metrics. Served under /api/ach/memory/*; /api/ach/wiki/*
// stays as an alias (collection names keep the wiki_ prefix).
for (const pre of ["/api/ach/memory", "/api/ach/wiki"]) {
  routerAdd("GET", pre, (e) => require(`${__hooks}/ach_wiki.js`).run(e, "index"))
  routerAdd("GET", pre + "/pages/{slug}", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "page"))
  routerAdd("GET", pre + "/pages/{slug}/versions", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "versions"))
  routerAdd("GET", pre + "/pages/{slug}/versions/{n}", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "versions"))
  routerAdd("GET", pre + "/export", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "exportPages"))
  routerAdd("GET", pre + "/search", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "search"))
  routerAdd("POST", pre + "/prompt-size", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "promptSize"))
  routerAdd("GET", pre + "/brief", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "brief"))
  routerAdd("GET", pre + "/overview", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "overview"))
  routerAdd("POST", pre + "/push", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "push"), $apis.bodyLimit(16 * 1024 * 1024))
  routerAdd("POST", pre + "/figures", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "addFigure"))
  routerAdd("GET", pre + "/contributions", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "contributions"))
  routerAdd("POST", pre + "/contributions", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "remember"))
  routerAdd("GET", pre + "/promotions", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "listPromotions"))
  routerAdd("POST", pre + "/promote", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "promote"))
  routerAdd("GET", pre + "/decisions", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "listDecisions"))
  routerAdd("POST", pre + "/decisions", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "draftDecision"))
  routerAdd("POST", pre + "/decisions/{id}/team-important", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "importantDecision"))
  routerAdd("GET", pre + "/held", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "listHeld"))
  routerAdd("POST", pre + "/seed", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "seed"))
}
for (const pre of ["/api/ach/admin/memory", "/api/ach/admin/wiki"]) {
  routerAdd("GET", pre + "/settings", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "adminSettings"))
  routerAdd("PUT", pre + "/settings", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "adminSettings"))
  routerAdd("POST", pre + "/run-api", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "adminRunApi"))
  routerAdd("POST", pre + "/overview", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "adminOverview"))
  routerAdd("GET", pre + "/metrics", (e) => require(`${__hooks}/ach_wiki.js`).run(e, "adminMetrics"))
}

// Weekly (Monday 06:00 UTC): refresh the team overview in #general.
cronAdd("ach_memory_overview", "0 6 * * 1", () => {
  const w = require(`${__hooks}/ach_wiki.js`)
  try {
    $app.runInTransaction((tx) => { w.queueOverview(tx, "weekly") })
  } catch (err) {
    $app.logger().error("ach memory overview failed", "error", String(err))
  }
})

// Hourly: the optional API maintainer (off by default; needs consent + a monthly cap).
cronAdd("ach_wiki_api", "7 * * * *", () => {
  const w = require(`${__hooks}/ach_wiki.js`)
  try {
    if (!w.apiReady($app)) return
    const r = w.runApiUpkeep($app)
    if (r.ran || r.reason !== "nothing") $app.logger().info("ach wiki api upkeep", "result", JSON.stringify(r))
  } catch (err) {
    $app.logger().error("ach wiki api upkeep failed", "error", String(err))
  }
})

// --- Avatars (pb_hooks/ach_avatars.js) ---
// People: upload > feishu > github > gravatar (admin-set order), else initials;
// cached on the hub, so the panel never loads third-party images.
routerAdd("GET", "/api/ach/avatars", (e) => require(`${__hooks}/ach_avatars.js`).run(e, "list"))
routerAdd("PUT", "/api/ach/me/avatar", (e) => require(`${__hooks}/ach_avatars.js`).run(e, "putMine"), $apis.bodyLimit(1024 * 1024))
routerAdd("DELETE", "/api/ach/me/avatar", (e) => require(`${__hooks}/ach_avatars.js`).run(e, "deleteMine"))
routerAdd("POST", "/api/ach/admin/avatars/users/{id}", (e) => require(`${__hooks}/ach_avatars.js`).run(e, "adminPut"), $apis.bodyLimit(1024 * 1024))
routerAdd("DELETE", "/api/ach/admin/avatars/users/{id}", (e) => require(`${__hooks}/ach_avatars.js`).run(e, "adminDelete"))
routerAdd("POST", "/api/ach/admin/avatars/refresh", (e) => require(`${__hooks}/ach_avatars.js`).run(e, "adminRefresh"))
routerAdd("GET", "/api/ach/admin/avatars/settings", (e) => require(`${__hooks}/ach_avatars.js`).run(e, "adminSettings"))
routerAdd("PUT", "/api/ach/admin/avatars/settings", (e) => require(`${__hooks}/ach_avatars.js`).run(e, "adminSettings"))
routerAdd("GET", "/api/ach/admin/access-check", (e) => require(`${__hooks}/ach_avatars.js`).run(e, "accessCheck"))
// Every 10 minutes: fetch avatars for people never tried; refresh weekly.
cronAdd("ach_avatars", "*/10 * * * *", () => {
  try {
    require(`${__hooks}/ach_avatars.js`).refreshAll($app, {})
  } catch (err) {
    $app.logger().error("ach avatars refresh failed", "error", String(err))
  }
})
// --- end avatars ---

// --- notifications + realtime fallback (pb_hooks/ach_notify.js) ---
// Events from record hooks (GitHub sync, tasks, announcements, Memory figures,
// replies/mentions) become per-person notifications; pushes go out after the
// request that recorded them (and every minute), digests at each person's time.
routerAdd("GET", "/api/ach/me/notifications", (e) => require(`${__hooks}/ach_notify.js`).run(e, "list"))
routerAdd("GET", "/api/ach/me/notify-prefs", (e) => require(`${__hooks}/ach_notify.js`).run(e, "getPrefs"))
routerAdd("PUT", "/api/ach/me/notify-prefs", (e) => require(`${__hooks}/ach_notify.js`).run(e, "putPrefs"))
routerAdd("GET", "/api/ach/follows/{kind}/{id}", (e) => require(`${__hooks}/ach_notify.js`).run(e, "getFollow"))
routerAdd("PUT", "/api/ach/follows/{kind}/{id}", (e) => require(`${__hooks}/ach_notify.js`).run(e, "putFollow"))
routerAdd("GET", "/api/ach/changes", (e) => require(`${__hooks}/ach_notify.js`).run(e, "changes"))
routerAdd("POST", "/api/ach/_test/notify-tick", (e) => require(`${__hooks}/ach_notify.js`).run(e, "testTick"))
// hooks (pb_hooks/ach_hooks.js): outbound personal/channel/team hooks with presets,
// signing and an SSRF block; inbound channel hooks; Web Push (ach_webpush.js)
routerAdd("GET", "/api/ach/hooks", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "listHooks"))
routerAdd("POST", "/api/ach/hooks", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "createHook"))
routerAdd("PATCH", "/api/ach/hooks/{id}", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "patchHook"))
routerAdd("DELETE", "/api/ach/hooks/{id}", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "deleteHook"))
routerAdd("POST", "/api/ach/hooks/{id}/test", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "testHook"))
routerAdd("POST", "/api/ach/hooks/{id}/rotate-secret", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "rotateHookSecret"))
routerAdd("GET", "/api/ach/admin/hooks/allow", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "allowList"))
routerAdd("PUT", "/api/ach/admin/hooks/allow", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "allowList"))
routerAdd("GET", "/api/ach/channels/{id}/inbound", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "listInbound"))
routerAdd("POST", "/api/ach/channels/{id}/inbound", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "createInbound"))
routerAdd("POST", "/api/ach/inbound-hooks/{id}/rotate", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "rotateInbound"))
routerAdd("DELETE", "/api/ach/inbound-hooks/{id}", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "deleteInbound"))
routerAdd("POST", "/api/ach/inbound/{token}", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "inbound"), $apis.bodyLimit(64 * 1024))
routerAdd("GET", "/api/ach/push/vapid", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "vapid"))
routerAdd("POST", "/api/ach/push/subscribe", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "subscribe"))
routerAdd("DELETE", "/api/ach/push/subscribe", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "unsubscribe"))
routerAdd("GET", "/api/ach/push/latest", (e) => require(`${__hooks}/ach_hooks.js`).run(e, "latest"))
// push actions: a tap on a notification's option (Web Push, desktop notifiers) with a single-use token
routerAdd("POST", "/api/ach/push/act", (e) => require(`${__hooks}/ach_lib.js`).run(e, "pushAct"))
// counts of what waits for my reply (session reminders; person or agent key)
routerAdd("GET", "/api/ach/me/attention", (e) => require(`${__hooks}/ach_notify.js`).run(e, "attention"))
onRecordAfterCreateSuccess((e) => { require(`${__hooks}/ach_notify.js`).onRecord(e.app, "post_create", e.record, null); e.next() }, "posts")
onRecordAfterUpdateSuccess((e) => { require(`${__hooks}/ach_notify.js`).onRecord(e.app, "post_update", e.record, e.record.original()); e.next() }, "posts")
onRecordAfterCreateSuccess((e) => { require(`${__hooks}/ach_notify.js`).onRecord(e.app, "task_create", e.record, null); e.next() }, "tasks")
onRecordAfterUpdateSuccess((e) => { require(`${__hooks}/ach_notify.js`).onRecord(e.app, "task_update", e.record, e.record.original()); e.next() }, "tasks")
onRecordAfterUpdateSuccess((e) => { require(`${__hooks}/ach_notify.js`).onRecord(e.app, "figure_update", e.record, e.record.original()); e.next() }, "wiki_figures")
// after any request that recorded an event: push (after its transaction committed)
routerUse((e) => {
  try {
    return e.next()
  } finally {
    try { require(`${__hooks}/ach_notify.js`).flushIfDirty(e.app) } catch (err) { e.app.logger().warn("ach notify flush failed", "error", String(err)) }
  }
})
onRecordEnrich((e) => {
  e.next()
  e.record.hide("notify_prefs")
}, "users")
cronAdd("ach_notify", "* * * * *", () => {
  const n = require(`${__hooks}/ach_notify.js`)
  try { n.flush($app); n.digest($app) } catch (err) { $app.logger().error("ach notify cron failed", "error", String(err)) }
})
// --- end notifications ---

// --- feishu adapter (pb_hooks/ach_feishu.js; optional, API.md "Feishu adapter") ---
// One callback URL for event subscription and card callbacks (verified:
// encrypted body + X-Lark-Signature + verification token); admin settings and
// mappings; a cron retries queued messages and trims old events.
routerAdd("POST", "/api/ach/feishu/events", (e) => require(`${__hooks}/ach_feishu.js`).events(e), $apis.bodyLimit(64 * 1024))
routerAdd("GET", "/api/ach/admin/feishu", (e) => require(`${__hooks}/ach_feishu.js`).run(e, "adminGet"))
routerAdd("PUT", "/api/ach/admin/feishu", (e) => require(`${__hooks}/ach_feishu.js`).run(e, "adminPut"))
routerAdd("POST", "/api/ach/admin/feishu/check", (e) => require(`${__hooks}/ach_feishu.js`).run(e, "adminCheck"))
routerAdd("POST", "/api/ach/admin/feishu/mappings", (e) => require(`${__hooks}/ach_feishu.js`).run(e, "adminMap"))
routerAdd("DELETE", "/api/ach/admin/feishu/mappings/{id}", (e) => require(`${__hooks}/ach_feishu.js`).run(e, "adminUnmap"))
routerAdd("POST", "/api/ach/admin/feishu/invite", (e) => require(`${__hooks}/ach_feishu.js`).run(e, "adminInvite"))
routerAdd("POST", "/api/ach/_test/feishu-crypto", (e) => require(`${__hooks}/ach_feishu.js`).run(e, "testCrypto"))
cronAdd("ach_feishu", "* * * * *", () => {
  try { require(`${__hooks}/ach_feishu.js`).cron($app) } catch (err) { $app.logger().error("ach feishu cron failed", "error", String(err)) }
})
onRecordEnrich((e) => { e.next(); e.record.hide("payload") }, "feishu_events")
// A decision answered anywhere settles the Feishu cards sent for it
onRecordAfterCreateSuccess((e) => { try { require(`${__hooks}/ach_feishu.js`).onRecord(e.app, "messages", e.record) } catch (err) {} ; e.next() }, "messages")
onRecordAfterCreateSuccess((e) => { try { require(`${__hooks}/ach_feishu.js`).onRecord(e.app, "posts", e.record) } catch (err) {} ; e.next() }, "posts")
// --- end feishu adapter ---

// --- storage: references, direct uploads, retention ---
// Direct uploads need PocketBase's S3 storage (R2/S3/OSS/TOS): presign -> PUT to
// the bucket -> complete (HEAD check) -> attach as attachment_refs [{upload}].
routerAdd("GET", "/api/ach/storage/config", (e) => require(`${__hooks}/ach_storage.js`).run(e, "config"))
routerAdd("POST", "/api/ach/uploads/presign", (e) => require(`${__hooks}/ach_storage.js`).run(e, "presign"))
routerAdd("POST", "/api/ach/uploads/complete", (e) => require(`${__hooks}/ach_storage.js`).run(e, "complete"))
routerAdd("GET", "/api/ach/uploads/{id}/raw", (e) => require(`${__hooks}/ach_storage.js`).run(e, "raw"))
routerAdd("POST", "/api/ach/attachments/keep", (e) => require(`${__hooks}/ach_storage.js`).run(e, "keep"))
routerAdd("GET", "/api/ach/channels/{id}/retention", (e) => require(`${__hooks}/ach_storage.js`).run(e, "getRetention"))
routerAdd("PUT", "/api/ach/channels/{id}/retention", (e) => require(`${__hooks}/ach_storage.js`).run(e, "putRetention"))
routerAdd("GET", "/api/ach/admin/storage/detail", (e) => require(`${__hooks}/ach_storage.js`).run(e, "adminDetail"))
routerAdd("GET", "/api/ach/admin/storage/settings", (e) => require(`${__hooks}/ach_storage.js`).run(e, "adminSettings"))
routerAdd("PUT", "/api/ach/admin/storage/settings", (e) => require(`${__hooks}/ach_storage.js`).run(e, "adminSettings"))
routerAdd("POST", "/api/ach/_test/retention", (e) => require(`${__hooks}/ach_storage.js`).run(e, "testRetention"))
// Hourly: unfinished direct uploads expire after an hour.
cronAdd("ach_upload_expire", "41 * * * *", () => {
  try { require(`${__hooks}/ach_storage.js`).expirePending($app, Date.now()) } catch (err) { $app.logger().warn("ach upload expiry failed", "error", String(err)) }
})
// Daily 03:17 UTC: retention per channel, and unfinished uploads older than a day.
cronAdd("ach_retention", "17 3 * * *", () => {
  try {
    const r = require(`${__hooks}/ach_storage.js`).sweepRetention($app, Date.now())
    if (r.files || r.uploads || r.expired_uploads || r.errors) $app.logger().info("ach retention", "result", JSON.stringify(r))
  } catch (err) {
    $app.logger().error("ach retention failed", "error", String(err))
  }
})
// --- end storage ---
