/// <reference path="../pb_data/types.d.ts" />
// Onboarding security.
// - agent_joins.ip / user_agent: who exchanged a one-time invite (shown to the
//   agent's owner and the admins in the agent_joined notification).
// - agents.key_unused: the key from create / rotate-key has not been used yet;
//   its first use burns the agent's unused join tokens.
// - push_subs.full: the Web Push subscription was made from a full human
//   session (only those get decision action buttons; never agent-scoped ones).
// - Rate limits (per IP) on the public one-time-credential routes.

const RULES = [
  { label: "POST /api/ach/invite/exchange", maxRequests: 10, duration: 60 },
  { label: "POST /api/ach/push/act", maxRequests: 30, duration: 60 },
  { label: "POST /api/ach/setup", maxRequests: 10, duration: 60 },
  { label: "POST /api/ach/setup/check", maxRequests: 10, duration: 60 },
  { label: "POST /api/ach/auth/link/peek", maxRequests: 20, duration: 60 },
]

migrate((app) => {
  const joins = app.findCollectionByNameOrId("agent_joins")
  if (!joins.fields.getByName("ip")) joins.fields.add(new TextField({ name: "ip", max: 100 }))
  if (!joins.fields.getByName("user_agent")) joins.fields.add(new TextField({ name: "user_agent", max: 300 }))
  app.save(joins)
  const agents = app.findCollectionByNameOrId("agents")
  if (!agents.fields.getByName("key_unused")) agents.fields.add(new BoolField({ name: "key_unused" }))
  app.save(agents)
  const subs = app.findCollectionByNameOrId("push_subs")
  if (!subs.fields.getByName("full")) subs.fields.add(new BoolField({ name: "full" }))
  app.save(subs)
  const settings = app.settings()
  const have = {}
  for (const r of settings.rateLimits.rules || []) have[r.label] = true
  const rules = (settings.rateLimits.rules || []).slice()
  for (const r of RULES) if (!have[r.label]) rules.push(Object.assign({ audience: "" }, r))
  settings.rateLimits.rules = rules
  settings.rateLimits.enabled = true
  app.save(settings)
}, (app) => {
  const joins = app.findCollectionByNameOrId("agent_joins")
  ;["ip", "user_agent"].forEach((n) => { try { joins.fields.removeByName(n) } catch (_) {} })
  app.save(joins)
  const agents = app.findCollectionByNameOrId("agents")
  try { agents.fields.removeByName("key_unused") } catch (_) {}
  app.save(agents)
  const subs = app.findCollectionByNameOrId("push_subs")
  try { subs.fields.removeByName("full") } catch (_) {}
  app.save(subs)
})
