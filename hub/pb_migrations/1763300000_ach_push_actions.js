/// <reference path="../pb_data/types.d.ts" />
// Push actions (reply by tapping a notification; pb_hooks/ach_notify.js).
// - push_actions: one short-lived action token per (person, decision request,
//   option, notification). Random, stored only as a SHA-256 hash, single use,
//   bound to the person + the request (task message or channel question post) +
//   the option; expires after ~24 h. `result` keeps the outcome so a retry of a
//   used token returns the same answer (idempotent) and never records twice.
// - notify_events.data: structured facts of a decision event (task/message/post
//   ids and the options) for notifiers and action buttons.
// - agent_joins: one-time join tokens for "ach2." invites (see API.md "Invite exchange").
// Route-only (no collection API rules).

migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const acts = new Collection({
    type: "base", name: "push_actions", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: [
      "CREATE UNIQUE INDEX idx_push_actions_hash ON push_actions (token_hash)",
      "CREATE INDEX idx_push_actions_target ON push_actions (user, target, option)",
      "CREATE INDEX idx_push_actions_expires ON push_actions (expires_at)",
    ],
  })
  acts.fields.add(
    new TextField({ name: "token_hash", required: true, max: 100, hidden: true }),
    new RelationField({ name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true }),
    new SelectField({ name: "kind", required: true, values: ["task", "post"], maxSelect: 1 }),
    new TextField({ name: "target", required: true, max: 20 }),
    new TextField({ name: "task", max: 20 }),
    new NumberField({ name: "option", min: 0, max: 9 }),
    new TextField({ name: "reply", max: 700 }),
    new SelectField({ name: "via", required: true, values: ["webpush", "desktop"], maxSelect: 1 }),
    new TextField({ name: "expires_at", required: true, max: 40 }),
    new TextField({ name: "used_at", max: 40 }),
    new JSONField({ name: "result", maxSize: 2000 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
  )
  app.save(acts)

  // One-time agent join tokens ("ach2." invites): exchanged once for a fresh
  // agent key (POST /api/ach/invite/exchange); hashed at rest; expire.
  const agents = app.findCollectionByNameOrId("agents")
  const joins = new Collection({
    type: "base", name: "agent_joins", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: ["CREATE UNIQUE INDEX idx_agent_joins_hash ON agent_joins (token_hash)", "CREATE INDEX idx_agent_joins_agent ON agent_joins (agent)"],
  })
  joins.fields.add(
    new TextField({ name: "token_hash", required: true, max: 100, hidden: true }),
    new RelationField({ name: "agent", required: true, collectionId: agents.id, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "created_by", collectionId: users.id, maxSelect: 1 }),
    new TextField({ name: "expires_at", required: true, max: 40 }),
    new TextField({ name: "used_at", max: 40 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
  )
  app.save(joins)

  const events = app.findCollectionByNameOrId("notify_events")
  if (!events.fields.getByName("data")) events.fields.add(new JSONField({ name: "data", maxSize: 8000 }))
  app.save(events)
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("push_actions")) } catch (_) {}
  try { app.delete(app.findCollectionByNameOrId("agent_joins")) } catch (_) {}
  const events = app.findCollectionByNameOrId("notify_events")
  try { events.fields.removeByName("data") } catch (_) {}
  app.save(events)
})
