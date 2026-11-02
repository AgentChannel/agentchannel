/// <reference path="../pb_data/types.d.ts" />
// Feishu/Lark adapter (optional; pb_hooks/ach_feishu.js, API.md "Feishu adapter").
// - feishu_ids: a Feishu user (open_id of this app; union_id) and the person it
//   maps to. how: admin (an admin confirmed it), email (the Feishu directory
//   email matched a person), import (users.feishu_open_id from the importer).
//   status: mapped | pending (wrote to the bot, not mapped: the admin sees them)
//   | blocked. last_list: the numbered Inbox list last sent ("reply <n>").
// - feishu_events: verified callbacks, unique by Feishu event_id (dedupe and
//   the work queue for messages: queued -> done | failed), kept 7 days.
// - feishu_messages: messages the bot sent (notifications, decision cards):
//   message_id -> person + item, so a reply in that thread or a card click maps
//   to exactly that item.
// Route-only (no collection API rules).

migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const ids = new Collection({
    type: "base", name: "feishu_ids", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: [
      "CREATE UNIQUE INDEX idx_feishu_ids_open ON feishu_ids (open_id)",
      "CREATE INDEX idx_feishu_ids_user ON feishu_ids (user)",
      "CREATE INDEX idx_feishu_ids_union ON feishu_ids (union_id)",
    ],
  })
  ids.fields.add(
    new TextField({ name: "open_id", required: true, max: 100 }),
    new TextField({ name: "union_id", max: 100 }),
    new TextField({ name: "tenant_key", max: 100 }),
    new TextField({ name: "name", max: 200 }),
    new TextField({ name: "email", max: 200 }),
    new RelationField({ name: "user", collectionId: users.id, maxSelect: 1, cascadeDelete: false }),
    new SelectField({ name: "how", values: ["admin", "email", "import"], maxSelect: 1 }),
    new SelectField({ name: "status", required: true, values: ["mapped", "pending", "blocked"], maxSelect: 1 }),
    new TextField({ name: "last_seen", max: 40 }),
    new JSONField({ name: "last_list", maxSize: 8000 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(ids)

  const evs = new Collection({
    type: "base", name: "feishu_events", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: [
      "CREATE UNIQUE INDEX idx_feishu_events_id ON feishu_events (event_id)",
      "CREATE INDEX idx_feishu_events_status ON feishu_events (status, created)",
    ],
  })
  evs.fields.add(
    new TextField({ name: "event_id", required: true, max: 200 }),
    new TextField({ name: "event_type", max: 100 }),
    new TextField({ name: "open_id", max: 100 }),
    new SelectField({ name: "status", required: true, values: ["queued", "working", "done", "failed", "ignored"], maxSelect: 1 }),
    new JSONField({ name: "payload", maxSize: 64000 }),
    new JSONField({ name: "result", maxSize: 4000 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(evs)

  const msgs = new Collection({
    type: "base", name: "feishu_messages", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: [
      "CREATE UNIQUE INDEX idx_feishu_messages_id ON feishu_messages (message_id)",
      "CREATE INDEX idx_feishu_messages_target ON feishu_messages (request)",
    ],
  })
  msgs.fields.add(
    new TextField({ name: "message_id", required: true, max: 100 }),
    new RelationField({ name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true }),
    new SelectField({ name: "kind", required: true, values: ["task", "post", "card", "other"], maxSelect: 1 }),
    new TextField({ name: "task", max: 20 }),
    new TextField({ name: "post", max: 20 }),
    // the decision request (task message id or question post id) a card answers
    new TextField({ name: "request", max: 20 }),
    new JSONField({ name: "card", maxSize: 16000 }),
    new TextField({ name: "chosen", max: 300 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
  )
  app.save(msgs)
}, (app) => {
  ;["feishu_messages", "feishu_events", "feishu_ids"].forEach((n) => { try { app.delete(app.findCollectionByNameOrId(n)) } catch (_) {} })
})
