/// <reference path="../pb_data/types.d.ts" />
// Team wiki, reduced design.
// - wiki_pages / wiki_versions: one page per topic (Markdown body with the
//   sections Current state / Decisions / Lessons / Open questions), every save a
//   new version. No locks, no git sync.
// - wiki_figures: keyed figures {topic, metric, value, unit, env, as_of, source,
//   status}; a newer row with the same (topic, metric, env) supersedes older ones.
// - wiki_decisions: decisions drafted by agents, confirmed/edited/rejected by the
//   named decider (only confirmed ones are human-confirmed).
// - wiki_contributions: `ach remember` facts and lessons (source link required).
// - wiki_events: superuser-only upkeep queue (what changed since the last upkeep).
// - tasks.system_kind: "wiki_upkeep" marks the one coalesced upkeep task.
// Writes go through /api/ach/wiki/* routes; users may read in the panel.

const USERS_ONLY = '@request.auth.id != "" && @request.auth.collectionName = "users"'
const BIG = 1000000

migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const agents = app.findCollectionByNameOrId("agents")
  const channels = app.findCollectionByNameOrId("channels")
  const tasks = app.findCollectionByNameOrId("tasks")
  const autodates = () => [
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  ]
  const base = (name, rule, indexes) => new Collection({
    type: "base", name, listRule: rule, viewRule: rule, createRule: null, updateRule: null, deleteRule: null, indexes,
  })
  const author = () => [
    new SelectField({ name: "author_type", values: ["agent", "human", "system"], maxSelect: 1 }),
    new RelationField({ name: "author_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "author_user", collectionId: users.id, maxSelect: 1 }),
  ]

  const pages = base("wiki_pages", USERS_ONLY, ["CREATE UNIQUE INDEX idx_wiki_pages_slug ON wiki_pages (slug)", "CREATE INDEX idx_wiki_pages_channel ON wiki_pages (channel)"])
  pages.fields.add(
    new TextField({ name: "slug", required: true, max: 80, pattern: "^[a-z0-9][a-z0-9-]{0,79}$" }),
    new TextField({ name: "title", required: true, max: 200 }),
    new RelationField({ name: "channel", collectionId: channels.id, maxSelect: 1 }),
    new JSONField({ name: "topics", maxSize: 4000 }),
    new TextField({ name: "body", max: BIG }),
    new NumberField({ name: "version", onlyInt: true, min: 0 }),
    new TextField({ name: "note", max: 2000 }),
    ...author(),
  )
  autodates().forEach((f) => pages.fields.add(f))
  app.save(pages)

  const versions = base("wiki_versions", USERS_ONLY, ["CREATE UNIQUE INDEX idx_wiki_versions_pv ON wiki_versions (page, version)"])
  versions.fields.add(
    new RelationField({ name: "page", required: true, collectionId: pages.id, maxSelect: 1, cascadeDelete: true }),
    new NumberField({ name: "version", onlyInt: true, min: 1 }),
    new TextField({ name: "title", max: 200 }),
    new TextField({ name: "body", max: BIG }),
    new JSONField({ name: "topics", maxSize: 4000 }),
    new TextField({ name: "note", max: 2000 }),
    ...author(),
  )
  autodates().forEach((f) => versions.fields.add(f))
  app.save(versions)

  const figures = base("wiki_figures", USERS_ONLY, ["CREATE INDEX idx_wiki_figures_key ON wiki_figures (topic, metric, env, as_of)"])
  figures.fields.add(
    new TextField({ name: "topic", required: true, max: 80 }),
    new TextField({ name: "metric", required: true, max: 200 }),
    new TextField({ name: "value", required: true, max: 200 }),
    new TextField({ name: "unit", max: 40 }),
    new TextField({ name: "env", max: 40 }),
    new TextField({ name: "as_of", required: true, max: 10, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
    new TextField({ name: "source", required: true, max: 600 }),
    new SelectField({ name: "status", required: true, values: ["active", "superseded"], maxSelect: 1 }),
    new TextField({ name: "superseded_by", max: 20 }),
    ...author(),
  )
  autodates().forEach((f) => figures.fields.add(f))
  app.save(figures)

  const decisions = base("wiki_decisions", USERS_ONLY, ["CREATE INDEX idx_wiki_decisions_decider ON wiki_decisions (decider, status)"])
  decisions.fields.add(
    new TextField({ name: "text", required: true, max: 4000 }),
    new TextField({ name: "original_text", max: 4000 }),
    new RelationField({ name: "decider", required: true, collectionId: users.id, maxSelect: 1 }),
    new TextField({ name: "source", required: true, max: 600 }),
    new RelationField({ name: "channel", collectionId: channels.id, maxSelect: 1 }),
    new TextField({ name: "topic", max: 80 }),
    new RelationField({ name: "task", collectionId: tasks.id, maxSelect: 1 }),
    new SelectField({ name: "status", required: true, values: ["draft", "confirmed", "rejected"], maxSelect: 1 }),
    new BoolField({ name: "money" }),
    new TextField({ name: "as_of", max: 10 }),
    new RelationField({ name: "drafted_by_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "confirmed_by", collectionId: users.id, maxSelect: 1 }),
    new DateField({ name: "confirmed_at" }),
  )
  autodates().forEach((f) => decisions.fields.add(f))
  app.save(decisions)

  const contribs = base("wiki_contributions", USERS_ONLY, ["CREATE INDEX idx_wiki_contrib_pending ON wiki_contributions (processed, created)"])
  contribs.fields.add(
    new TextField({ name: "text", required: true, max: 4000 }),
    new TextField({ name: "source", required: true, max: 600 }),
    new RelationField({ name: "channel", collectionId: channels.id, maxSelect: 1 }),
    new TextField({ name: "topic", max: 80 }),
    new RelationField({ name: "task", collectionId: tasks.id, maxSelect: 1 }),
    new BoolField({ name: "processed" }),
    new TextField({ name: "upkeep_task", max: 20 }),
    ...author(),
  )
  autodates().forEach((f) => contribs.fields.add(f))
  app.save(contribs)

  const events = base("wiki_events", null, ["CREATE INDEX idx_wiki_events_pending ON wiki_events (processed, upkeep_task)"])
  events.fields.add(
    new SelectField({ name: "kind", required: true, values: ["task_completed", "task_failed", "import_closed", "decision_confirmed", "seed"], maxSelect: 1 }),
    new TextField({ name: "ref", required: true, max: 300 }),
    new TextField({ name: "title", max: 300 }),
    new TextField({ name: "url", max: 600 }),
    new RelationField({ name: "channel", collectionId: channels.id, maxSelect: 1 }),
    new BoolField({ name: "processed" }),
    new TextField({ name: "upkeep_task", max: 20 }),
  )
  autodates().forEach((f) => events.fields.add(f))
  app.save(events)

  if (!tasks.fields.getByName("system_kind")) tasks.fields.add(new TextField({ name: "system_kind", max: 40 }))
  app.save(tasks)
}, (app) => {
  for (const n of ["wiki_events", "wiki_contributions", "wiki_decisions", "wiki_figures", "wiki_versions", "wiki_pages"]) {
    try { app.delete(app.findCollectionByNameOrId(n)) } catch (_) {}
  }
  const tasks = app.findCollectionByNameOrId("tasks")
  try { tasks.fields.removeByName("system_kind") } catch (_) {}
  app.save(tasks)
})
