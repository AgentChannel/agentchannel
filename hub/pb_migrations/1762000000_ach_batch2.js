/// <reference path="../pb_data/types.d.ts" />
// Product fixes:
// - tasks.claim_mode (P1): "runner" | "interactive" | "" (unclaimed). Interactive
//   claims keep their lease for ACH_INTERACTIVE_LEASE_HOURS (24h) of inactivity.
// - tasks.key_question (P6): optional; shown in the panel header.
// - tasks.idle_notified_at (P5): the last "idle > 24h" notification.
// - agents.net_allow (P2): domains the agent's sandbox may reach; null = default list.
// - users.notify_webhook (P5): hidden; overrides ACH_NOTIFY_WEBHOOK for this user.

migrate((app) => {
  const tasks = app.findCollectionByNameOrId("tasks")
  if (!tasks.fields.getByName("claim_mode")) tasks.fields.add(new TextField({ name: "claim_mode", max: 20 }))
  if (!tasks.fields.getByName("key_question")) tasks.fields.add(new TextField({ name: "key_question", max: 20000 }))
  if (!tasks.fields.getByName("idle_notified_at")) tasks.fields.add(new DateField({ name: "idle_notified_at" }))
  app.save(tasks)
  // Tasks claimed before this migration were all claimed by a runner.
  app.db().newQuery("UPDATE tasks SET claim_mode = 'runner' WHERE run_id != '' AND (claim_mode = '' OR claim_mode IS NULL)").execute()

  const agents = app.findCollectionByNameOrId("agents")
  if (!agents.fields.getByName("net_allow")) agents.fields.add(new JSONField({ name: "net_allow", maxSize: 20000 }))
  app.save(agents)

  const users = app.findCollectionByNameOrId("users")
  if (!users.fields.getByName("notify_webhook")) users.fields.add(new TextField({ name: "notify_webhook", max: 500, hidden: true }))
  app.save(users)
}, (app) => {
  const tasks = app.findCollectionByNameOrId("tasks")
  ;["claim_mode", "key_question", "idle_notified_at"].forEach((n) => { try { tasks.fields.removeByName(n) } catch (_) {} })
  app.save(tasks)
  const agents = app.findCollectionByNameOrId("agents")
  try { agents.fields.removeByName("net_allow") } catch (_) {}
  app.save(agents)
  const users = app.findCollectionByNameOrId("users")
  try { users.fields.removeByName("notify_webhook") } catch (_) {}
  app.save(users)
})
