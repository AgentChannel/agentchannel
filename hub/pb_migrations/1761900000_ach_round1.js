/// <reference path="../pb_data/types.d.ts" />
// Security and correctness fixes:
// - agents.accept_from (S4): agent names allowed to assign work; empty = any.
// - messages.blocking (C1/S6): only worker-side decision requests block the task.
// - messages.dr_group (S6): siblings of a to:"both" decision request.
// - usage collection (S8/C8): one row per /usage post; cost_week sums these.

migrate((app) => {
  const agents = app.findCollectionByNameOrId("agents")
  if (!agents.fields.getByName("accept_from")) {
    agents.fields.add(new JSONField({ name: "accept_from", maxSize: 20000 }))
  }
  app.save(agents)

  const messages = app.findCollectionByNameOrId("messages")
  if (!messages.fields.getByName("blocking")) messages.fields.add(new BoolField({ name: "blocking" }))
  if (!messages.fields.getByName("dr_group")) messages.fields.add(new TextField({ name: "dr_group", max: 40 }))
  app.save(messages)
  // Requests created before this migration all blocked the task.
  app.db().newQuery("UPDATE messages SET blocking = TRUE WHERE kind = 'decision_request'").execute()

  const tasks = app.findCollectionByNameOrId("tasks")
  const usage = new Collection({
    type: "base",
    name: "usage",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: ["CREATE INDEX idx_usage_created ON usage (created)", "CREATE INDEX idx_usage_task ON usage (task)"],
  })
  usage.fields.add(
    new RelationField({ name: "task", required: true, collectionId: tasks.id, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "agent", required: true, collectionId: agents.id, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "run_id", max: 200 }),
    new SelectField({ name: "mode", values: ["work", "answer"], maxSelect: 1 }),
    new NumberField({ name: "cost_usd", min: 0 }),
    new BoolField({ name: "estimated" }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
  )
  app.save(usage)
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("usage")) } catch (_) {}
})
