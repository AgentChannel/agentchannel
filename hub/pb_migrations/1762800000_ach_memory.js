/// <reference path="../pb_data/types.d.ts" />
// Memory: per-channel upkeep, team
// overview, promote to team, contradiction holds, staleness, trial metrics.
// - wiki_promotions: statements a member of a (private) channel made
//   team-visible; source_channel set when the source is private (non-members see
//   "source: private channel", never the source). Read through routes only.
// - wiki_held: pushes, figures and contributions held because they contradict a
//   confirmed decision or a current figure (status held/accepted/discarded; the
//   counts are the false-positive metric). Routes only.
// - wiki_log: injections (chars, item refs) and recall/brief calls (metrics). Routes only.
// - wiki_figures.stable: exempt from staleness. wiki_decisions.team_important.
// - wiki_events.kind gains "overview" and "promoted".
// - Existing (aggregated) upkeep tasks: handoffs replaced, open ones canceled,
//   their items re-queued (see below).
// - wiki_figures and wiki_contributions become route-only (no collection reads):
//   a figure belongs to a page (which may be private) only through its topic slug.

migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const agents = app.findCollectionByNameOrId("agents")
  const channels = app.findCollectionByNameOrId("channels")
  const decisions = app.findCollectionByNameOrId("wiki_decisions")
  const autodates = (c) => {
    c.fields.add(new AutodateField({ name: "created", onCreate: true, onUpdate: false }))
    c.fields.add(new AutodateField({ name: "updated", onCreate: true, onUpdate: true }))
  }
  const author = () => [
    new SelectField({ name: "author_type", values: ["agent", "human", "system"], maxSelect: 1 }),
    new RelationField({ name: "author_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "author_user", collectionId: users.id, maxSelect: 1 }),
  ]
  const base = (name, indexes) => new Collection({ type: "base", name, listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, indexes: indexes || [] })

  const figures = app.findCollectionByNameOrId("wiki_figures")
  if (!figures.fields.getByName("stable")) figures.fields.add(new BoolField({ name: "stable" }))
  figures.listRule = null
  figures.viewRule = null
  app.save(figures)

  const contribs = app.findCollectionByNameOrId("wiki_contributions")
  contribs.listRule = null
  contribs.viewRule = null
  app.save(contribs)

  if (!decisions.fields.getByName("team_important")) decisions.fields.add(new BoolField({ name: "team_important" }))
  app.save(decisions)

  const events = app.findCollectionByNameOrId("wiki_events")
  events.fields.getByName("kind").values = ["task_completed", "task_failed", "import_closed", "decision_confirmed", "seed", "overview", "promoted"]
  app.save(events)

  const prom = base("wiki_promotions", ["CREATE INDEX idx_wiki_promotions_created ON wiki_promotions (created)"])
  prom.fields.add(
    new TextField({ name: "text", required: true, max: 1000 }),
    new TextField({ name: "source", required: true, max: 600 }),
    new RelationField({ name: "source_channel", collectionId: channels.id, maxSelect: 1 }),
    new RelationField({ name: "decision", collectionId: decisions.id, maxSelect: 1 }),
    ...author(),
  )
  autodates(prom)
  app.save(prom)

  const held = base("wiki_held", ["CREATE INDEX idx_wiki_held_status ON wiki_held (status)"])
  held.fields.add(
    new SelectField({ name: "kind", required: true, values: ["push", "figure", "contribution"], maxSelect: 1 }),
    new RelationField({ name: "channel", collectionId: channels.id, maxSelect: 1 }),
    new JSONField({ name: "payload", maxSize: 20000000 }),
    new JSONField({ name: "conflicts", maxSize: 200000 }),
    new JSONField({ name: "reviewers", maxSize: 20000 }),
    new SelectField({ name: "status", required: true, values: ["held", "accepted", "discarded"], maxSelect: 1 }),
    new TextField({ name: "scope_channel", max: 20 }),
    new RelationField({ name: "resolved_by", collectionId: users.id, maxSelect: 1 }),
    new DateField({ name: "resolved_at" }),
    ...author(),
  )
  autodates(held)
  app.save(held)

  const log = base("wiki_log", ["CREATE INDEX idx_wiki_log_kind ON wiki_log (kind, created)"])
  log.fields.add(
    new SelectField({ name: "kind", required: true, values: ["inject", "recall", "brief"], maxSelect: 1 }),
    new TextField({ name: "task", max: 20 }),
    new TextField({ name: "agent", max: 20 }),
    new NumberField({ name: "chars", onlyInt: true, min: 0 }),
    new JSONField({ name: "items", maxSize: 200000 }),
  )
  autodates(log)
  app.save(log)

  // Security fix: upkeep/seed tasks made before this migration aggregated items
  // of every channel into ONE task in #general (private titles and links visible
  // to everyone). Their handoffs are replaced, open ones are canceled, and their
  // items go back to the queue: the next trigger creates one task per channel.
  const NOTE = "(Replaced: Memory upkeep now runs per channel, inside each channel. This aggregated handoff was removed because it listed items of private channels.)"
  const old = app.findRecordsByFilter("tasks", "system_kind = 'wiki_upkeep'", "", 10000, 0)
  for (const t of old) {
    t.set("handoff", NOTE)
    if (["submitted", "working", "input-required"].includes(t.getString("status"))) t.set("status", "canceled")
    app.save(t)
    for (const v of app.findRecordsByFilter("handoff_versions", "task = {:t}", "", 10000, 0, { t: t.id })) {
      v.set("body", NOTE)
      app.save(v)
    }
  }
  app.db().newQuery("UPDATE wiki_events SET upkeep_task = '' WHERE processed = FALSE").execute()
  app.db().newQuery("UPDATE wiki_contributions SET upkeep_task = '' WHERE processed = FALSE").execute()
}, (app) => {
  for (const n of ["wiki_log", "wiki_held", "wiki_promotions"]) {
    try { app.delete(app.findCollectionByNameOrId(n)) } catch (_) {}
  }
  const USERS_ONLY = '@request.auth.id != "" && @request.auth.collectionName = "users"'
  const figures = app.findCollectionByNameOrId("wiki_figures")
  try { figures.fields.removeByName("stable") } catch (_) {}
  figures.listRule = USERS_ONLY
  figures.viewRule = USERS_ONLY
  app.save(figures)
  const decisions = app.findCollectionByNameOrId("wiki_decisions")
  try { decisions.fields.removeByName("team_important") } catch (_) {}
  app.save(decisions)
})
