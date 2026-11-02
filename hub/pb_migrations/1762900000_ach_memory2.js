/// <reference path="../pb_data/types.d.ts" />
// Memory accuracy fixes:
// - wiki_decisions.scope: "task" (a one-off arrangement stored on its task and
//   shown in its thread, never in channel Memory or prompts) or "channel" (a
//   standing decision; counts only once a person confirmed it). Empty = channel
//   (rows made before this migration).
// - wiki_figures.at: when the source said it (post/message/comment time, ISO);
//   orders rows with the same as_of date. wiki_figures.corrects: the figure row
//   this one corrects (an explicit correction supersedes it directly).
// - wiki_log.kind gains "prompt" (total worker prompt size, for the metrics).
// - Replies only: people never "confirm"; they reply.
//   messages.choices / posts.choices: a structured decision request
//   {question, options:[{label, detail, money}], recommended} (recommended first).
//   wiki_decisions.request: the decision request it answers (message id, or
//   "p:<post id>" for a channel question); wiki_decisions.reply: the human reply
//   that is its source (only those count as confirmed). wiki_held.question: the
//   channel post asking the owner which value is right (their reply resolves it).
// - Authorization: grants (grantor -> an agent or a person, scope a
//   task or channel, cumulative money cap, expiry, guidance, optional requester
//   filter). Route-only (no collection reads). messages gain: also_to (people a
//   person-grant routes a request to), delegated_grant (a request part an agent
//   grant covers), grant (the grant a decision was made under), on_behalf_of
//   (the grantor a grantee person decided for), via_agent (the owner's agent in
//   an interactive session that relayed the owner's decision).

migrate((app) => {
  const decisions = app.findCollectionByNameOrId("wiki_decisions")
  if (!decisions.fields.getByName("scope")) decisions.fields.add(new SelectField({ name: "scope", values: ["channel", "task"], maxSelect: 1 }))
  app.save(decisions)
  const figures = app.findCollectionByNameOrId("wiki_figures")
  if (!figures.fields.getByName("at")) figures.fields.add(new TextField({ name: "at", max: 40 }))
  if (!figures.fields.getByName("corrects")) figures.fields.add(new TextField({ name: "corrects", max: 20 }))
  app.save(figures)
  const log = app.findCollectionByNameOrId("wiki_log")
  log.fields.getByName("kind").values = ["inject", "recall", "brief", "prompt"]
  app.save(log)
  if (!decisions.fields.getByName("request")) decisions.fields.add(new TextField({ name: "request", max: 40 }))
  if (!decisions.fields.getByName("reply")) decisions.fields.add(new TextField({ name: "reply", max: 40 }))
  app.save(decisions)
  for (const n of ["messages", "posts"]) {
    const c = app.findCollectionByNameOrId(n)
    if (!c.fields.getByName("choices")) c.fields.add(new JSONField({ name: "choices", maxSize: 20000 }))
    app.save(c)
  }
  const held = app.findCollectionByNameOrId("wiki_held")
  if (!held.fields.getByName("question")) held.fields.add(new TextField({ name: "question", max: 20 }))
  app.save(held)
  if (!decisions.fields.getByName("grant")) decisions.fields.add(new TextField({ name: "grant", max: 20 }))
  app.save(decisions)

  const msgs = app.findCollectionByNameOrId("messages")
  if (!msgs.fields.getByName("also_to")) msgs.fields.add(new JSONField({ name: "also_to", maxSize: 2000 }))
  for (const n of ["delegated_grant", "grant", "on_behalf_of", "via_agent"]) if (!msgs.fields.getByName(n)) msgs.fields.add(new TextField({ name: n, max: 20 }))
  app.save(msgs)

  const users = app.findCollectionByNameOrId("users")
  const agents = app.findCollectionByNameOrId("agents")
  const grants = new Collection({
    type: "base", name: "grants", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: ["CREATE INDEX idx_grants_scope ON grants (scope_id, status)", "CREATE INDEX idx_grants_grantor ON grants (grantor)"],
  })
  grants.fields.add(
    new RelationField({ name: "grantor", required: true, collectionId: users.id, maxSelect: 1 }),
    new RelationField({ name: "grantee_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "grantee_user", collectionId: users.id, maxSelect: 1 }),
    new SelectField({ name: "scope_kind", required: true, values: ["task", "channel"], maxSelect: 1 }),
    new TextField({ name: "scope_id", required: true, max: 20 }),
    new NumberField({ name: "money_cap", min: 0 }),
    new NumberField({ name: "used", min: 0 }),
    new TextField({ name: "expires_at", max: 30 }),
    new TextField({ name: "guidance", max: 2000 }),
    new RelationField({ name: "requester_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "requester_user", collectionId: users.id, maxSelect: 1 }),
    new SelectField({ name: "status", required: true, values: ["active", "revoked", "lapsed"], maxSelect: 1 }),
    new TextField({ name: "created_via", max: 40 }),
    new TextField({ name: "source", max: 600 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(grants)
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("grants")) } catch (_) {}
  const msgs = app.findCollectionByNameOrId("messages")
  for (const n of ["also_to", "delegated_grant", "grant", "on_behalf_of", "via_agent"]) { try { msgs.fields.removeByName(n) } catch (_) {} }
  app.save(msgs)
  const decisions = app.findCollectionByNameOrId("wiki_decisions")
  try { decisions.fields.removeByName("scope") } catch (_) {}
  try { decisions.fields.removeByName("request") } catch (_) {}
  try { decisions.fields.removeByName("reply") } catch (_) {}
  try { decisions.fields.removeByName("grant") } catch (_) {}
  for (const n of ["messages", "posts"]) {
    const c = app.findCollectionByNameOrId(n)
    try { c.fields.removeByName("choices") } catch (_) {}
    app.save(c)
  }
  const held = app.findCollectionByNameOrId("wiki_held")
  try { held.fields.removeByName("question") } catch (_) {}
  app.save(held)
  app.save(decisions)
  const figures = app.findCollectionByNameOrId("wiki_figures")
  try { figures.fields.removeByName("at") } catch (_) {}
  try { figures.fields.removeByName("corrects") } catch (_) {}
  app.save(figures)
  const log = app.findCollectionByNameOrId("wiki_log")
  log.fields.getByName("kind").values = ["inject", "recall", "brief"]
  app.save(log)
})
