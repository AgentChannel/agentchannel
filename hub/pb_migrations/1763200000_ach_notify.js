/// <reference path="../pb_data/types.d.ts" />
// Notifications ("something changed and nobody knows"; pb_hooks/ach_notify.js).
// - notify_events: one row per thing that happened (GitHub opened/closed/merged/
//   release, task sent/completed/failed, announcement, key figure changed, a
//   reply or mention). `key` is unique, so repeated GitHub syncs never repeat one.
// - notifications: one row per person who should hear about an event: why
//   (reason), whether it involves them (needs_me) or wants their reply
//   (reply_needed: those live in the Inbox "Needs me" list already), and how it
//   is delivered (push: pending -> sent | digest -> digested | none | skipped).
// - follows: an explicit follow (on) or unfollow (off) of a post or task.
// - users.notify_prefs: {channels: {<id>: all|important|off}, digest_time "HH:MM"
//   ("" = no digest), tz, tz_offset (minutes east of UTC), digest_last}.
// - posts.announce: a top-level post marked as an announcement.
// - hooks / hook_deliveries / inbound_hooks / push_subs: outbound hooks, their
//   delivery queue, inbound channel webhooks, Web Push subscriptions.
// All are route-only (no collection API rules).

migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  if (!users.fields.getByName("notify_prefs")) users.fields.add(new JSONField({ name: "notify_prefs", maxSize: 20000 }))
  app.save(users)
  const posts = app.findCollectionByNameOrId("posts")
  if (!posts.fields.getByName("announce")) posts.fields.add(new BoolField({ name: "announce" }))
  app.save(posts)

  const events = new Collection({
    type: "base", name: "notify_events", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: ["CREATE UNIQUE INDEX idx_notify_events_key ON notify_events (key)", "CREATE INDEX idx_notify_events_created ON notify_events (created)"],
  })
  events.fields.add(
    new TextField({ name: "key", required: true, max: 300 }),
    new TextField({ name: "event", required: true, max: 40 }),
    new TextField({ name: "channel", max: 20 }),
    new TextField({ name: "target_kind", max: 10 }),
    new TextField({ name: "target_id", max: 20 }),
    new TextField({ name: "title", max: 400 }),
    new TextField({ name: "path", max: 300 }),
    new TextField({ name: "actor_user", max: 20 }),
    new TextField({ name: "actor_name", max: 200 }),
    new TextField({ name: "detail", max: 400 }),
    new BoolField({ name: "important" }),
    new BoolField({ name: "private" }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(events)

  const notes = new Collection({
    type: "base", name: "notifications", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: [
      "CREATE UNIQUE INDEX idx_notifications_user_ev ON notifications (user, ev)",
      "CREATE INDEX idx_notifications_push ON notifications (push)",
      "CREATE INDEX idx_notifications_user_created ON notifications (user, created)",
    ],
  })
  notes.fields.add(
    new RelationField({ name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "ev", required: true, collectionId: events.id, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "reason", max: 20 }),
    new BoolField({ name: "needs_me" }),
    new BoolField({ name: "reply_needed" }),
    new SelectField({ name: "push", required: true, values: ["pending", "sent", "digest", "digested", "none", "skipped"], maxSelect: 1 }),
    new TextField({ name: "push_at", max: 40 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(notes)

  const follows = new Collection({
    type: "base", name: "follows", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: ["CREATE UNIQUE INDEX idx_follows_key ON follows (user, kind, target)", "CREATE INDEX idx_follows_target ON follows (kind, target)"],
  })
  follows.fields.add(
    new RelationField({ name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true }),
    new SelectField({ name: "kind", required: true, values: ["post", "task"], maxSelect: 1 }),
    new TextField({ name: "target", required: true, max: 20 }),
    new BoolField({ name: "on" }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(follows)

  // Outbound hooks at three levels (personal | channel | team), each with a
  // preset (payload format), a signing secret, and a health state.
  const hooks = new Collection({
    type: "base", name: "hooks", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: ["CREATE INDEX idx_hooks_owner ON hooks (owner)", "CREATE INDEX idx_hooks_scope ON hooks (scope, channel)"],
  })
  hooks.fields.add(
    new RelationField({ name: "owner", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true }),
    new SelectField({ name: "scope", required: true, values: ["personal", "channel", "team"], maxSelect: 1 }),
    new TextField({ name: "channel", max: 20 }),
    new TextField({ name: "name", max: 100 }),
    new SelectField({ name: "preset", required: true, values: ["json", "feishu", "dingtalk", "wecom", "slack", "discord", "telegram", "ntfy", "bark", "pushover"], maxSelect: 1 }),
    new TextField({ name: "url", required: true, max: 1000 }),
    new TextField({ name: "secret", max: 200, hidden: true }),
    new JSONField({ name: "config", maxSize: 4000, hidden: true }),
    new SelectField({ name: "level", values: ["important", "all"], maxSelect: 1 }),
    new TextField({ name: "lang", max: 5 }),
    new SelectField({ name: "status", required: true, values: ["active", "paused", "broken"], maxSelect: 1 }),
    new NumberField({ name: "fail_count", min: 0 }),
    new TextField({ name: "last_error", max: 300 }),
    new TextField({ name: "last_ok_at", max: 40 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(hooks)

  // One outbound HTTP delivery (retried with backoff). target: "hook:<id>",
  // "user:<id>" (the person's own notify_webhook) or "sub:<id>" (Web Push).
  const deliveries = new Collection({
    type: "base", name: "hook_deliveries", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: ["CREATE INDEX idx_hook_deliveries_due ON hook_deliveries (status, next_at)"],
  })
  deliveries.fields.add(
    new TextField({ name: "target", required: true, max: 40 }),
    new TextField({ name: "ev", max: 20 }),
    new JSONField({ name: "message", maxSize: 100000 }),
    new NumberField({ name: "attempts", min: 0 }),
    new TextField({ name: "next_at", max: 40 }),
    new SelectField({ name: "status", required: true, values: ["pending", "sent", "failed"], maxSelect: 1 }),
    new TextField({ name: "last_error", max: 300 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(deliveries)

  // Inbound hooks: a channel's incoming webhook URL (token hashed; rotatable).
  const inbound = new Collection({
    type: "base", name: "inbound_hooks", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: ["CREATE INDEX idx_inbound_hooks_channel ON inbound_hooks (channel)"],
  })
  inbound.fields.add(
    new TextField({ name: "channel", required: true, max: 20 }),
    new TextField({ name: "name", max: 100 }),
    new TextField({ name: "token_hash", max: 100, hidden: true }),
    new TextField({ name: "token_prefix", max: 40 }),
    new RelationField({ name: "created_by", collectionId: users.id, maxSelect: 1 }),
    new BoolField({ name: "active" }),
    new TextField({ name: "last_used", max: 40 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(inbound)

  // Web Push subscriptions (payload-less pushes; the service worker reads the
  // newest item with its own read key).
  const subs = new Collection({
    type: "base", name: "push_subs", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: ["CREATE UNIQUE INDEX idx_push_subs_endpoint ON push_subs (endpoint)", "CREATE INDEX idx_push_subs_user ON push_subs (user)"],
  })
  subs.fields.add(
    new RelationField({ name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "endpoint", required: true, max: 1000 }),
    new TextField({ name: "read_key_hash", max: 100, hidden: true }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
  )
  app.save(subs)
}, (app) => {
  for (const n of ["push_subs", "inbound_hooks", "hook_deliveries", "hooks", "follows", "notifications", "notify_events"]) {
    try { app.delete(app.findCollectionByNameOrId(n)) } catch (_) {}
  }
  const users = app.findCollectionByNameOrId("users")
  try { users.fields.removeByName("notify_prefs") } catch (_) {}
  app.save(users)
  const posts = app.findCollectionByNameOrId("posts")
  try { posts.fields.removeByName("announce") } catch (_) {}
  app.save(posts)
})
