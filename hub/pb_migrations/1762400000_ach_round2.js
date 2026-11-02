/// <reference path="../pb_data/types.d.ts" />
// Login, language, rate limits and channel titles:
// - users.password_login (B3): password auth works only for people a superuser
//   flagged (the bootstrap admin). Admins that exist when this migration runs
//   keep it, so an upgrade never locks anyone out; untick it in the dashboard.
// - users.lang (B12): zh|en for notification text (panel toggle).
// - login_tokens: kind "device" (5-minute link for yourself, B1/C) and
//   scope ("" = full session, "agent" = minted from an agent key, never admin).
// - agents.quiet (C), agents.disabled_by_admin / accept_from_admin (B8).
// - channels.title (B17): free display text; name stays the slug.
// - Rate limits (B2): PocketBase's per-IP limiter on the auth endpoints and the
//   ach login routes. The hooks add a per-email limit on request-otp.

const RULES = [
  { label: "users:authWithPassword", maxRequests: 10, duration: 60 },
  { label: "users:authWithOTP", maxRequests: 20, duration: 60 },
  { label: "users:requestOTP", maxRequests: 10, duration: 60 },
  { label: "users:requestPasswordReset", maxRequests: 5, duration: 60 },
  { label: "users:authRefresh", maxRequests: 120, duration: 60 },
  { label: "_superusers:auth", maxRequests: 10, duration: 60 },
  { label: "POST /api/ach/auth/link", maxRequests: 20, duration: 60 },
  { label: "POST /api/ach/auth/cf", maxRequests: 60, duration: 60 },
  { label: "POST /api/ach/auth/device-link", maxRequests: 10, duration: 60 },
  { label: "POST /api/ach/login-link", maxRequests: 20, duration: 60 },
]

migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  if (!users.fields.getByName("password_login")) users.fields.add(new BoolField({ name: "password_login" }))
  if (!users.fields.getByName("lang")) users.fields.add(new TextField({ name: "lang", max: 10 }))
  app.save(users)
  app.db().newQuery("UPDATE users SET password_login = TRUE WHERE is_admin = TRUE").execute()

  const lt = app.findCollectionByNameOrId("login_tokens")
  lt.fields.getByName("kind").values = ["invite", "login", "open", "device"]
  if (!lt.fields.getByName("scope")) lt.fields.add(new TextField({ name: "scope", max: 20 }))
  app.save(lt)

  const agents = app.findCollectionByNameOrId("agents")
  for (const n of ["quiet", "disabled_by_admin", "accept_from_admin"]) {
    if (!agents.fields.getByName(n)) agents.fields.add(new BoolField({ name: n }))
  }
  app.save(agents)

  const channels = app.findCollectionByNameOrId("channels")
  if (!channels.fields.getByName("title")) channels.fields.add(new TextField({ name: "title", max: 200 }))
  app.save(channels)

  const settings = app.settings()
  const have = {}
  for (const r of settings.rateLimits.rules || []) have[r.label] = true
  const rules = (settings.rateLimits.rules || []).slice()
  for (const r of RULES) if (!have[r.label]) rules.push(Object.assign({ audience: "" }, r))
  settings.rateLimits.rules = rules
  settings.rateLimits.enabled = true
  app.save(settings)
}, (app) => {
  const users = app.findCollectionByNameOrId("users")
  ;["password_login", "lang"].forEach((n) => { try { users.fields.removeByName(n) } catch (_) {} })
  app.save(users)
  const lt = app.findCollectionByNameOrId("login_tokens")
  try { lt.fields.removeByName("scope") } catch (_) {}
  app.save(lt)
  const agents = app.findCollectionByNameOrId("agents")
  ;["quiet", "disabled_by_admin", "accept_from_admin"].forEach((n) => { try { agents.fields.removeByName(n) } catch (_) {} })
  app.save(agents)
  const channels = app.findCollectionByNameOrId("channels")
  try { channels.fields.removeByName("title") } catch (_) {}
  app.save(channels)
})
