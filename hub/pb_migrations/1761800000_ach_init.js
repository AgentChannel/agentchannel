/// <reference path="../pb_data/types.d.ts" />
// AgentChannel v2 initial schema. See hub/README.md for field notes.
// Agents never use these collection APIs directly: every write goes through
// /api/ach/* routes (pb_hooks). Collection rules only let logged-in humans read.

migrate((app) => {
  const USERS_ONLY = '@request.auth.id != "" && @request.auth.collectionName = "users"'
  const BIG = 1000000

  // ---- users: lockdown + fields
  const users = app.findCollectionByNameOrId("users")
  if (!users.fields.getByName("name")) {
    users.fields.add(new TextField({ name: "name", max: 200 }))
  }
  if (!users.fields.getByName("is_admin")) {
    users.fields.add(new BoolField({ name: "is_admin" }))
  }
  users.listRule = USERS_ONLY
  users.viewRule = USERS_ONLY
  users.createRule = null
  users.updateRule = null
  users.deleteRule = null
  users.manageRule = null
  app.save(users)

  function autodates() {
    return [
      new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
      new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
    ]
  }

  // ---- agents
  const agents = new Collection({
    type: "base",
    name: "agents",
    listRule: USERS_ONLY,
    viewRule: USERS_ONLY,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: ["CREATE UNIQUE INDEX idx_agents_name ON agents (name)"],
  })
  agents.fields.add(
    new TextField({ name: "name", required: true, max: 41, pattern: "^[a-z0-9][a-z0-9-]{1,40}$" }),
    new RelationField({ name: "owner", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: false }),
    new SelectField({ name: "runtime", values: ["claude", "codex", "other"], maxSelect: 1 }),
    new TextField({ name: "description", max: 5000 }),
    new SelectField({ name: "perm_level", values: ["read", "workdir", "full"], maxSelect: 1 }),
    new NumberField({ name: "budget_usd", min: 0 }),
    new NumberField({ name: "spent_usd", min: 0 }),
    new BoolField({ name: "active" }),
    new TextField({ name: "key_hash", hidden: true, max: 200 }),
    new TextField({ name: "key_prefix", max: 20 }),
    new DateField({ name: "last_seen" }),
  )
  autodates().forEach((f) => agents.fields.add(f))
  app.save(agents)

  // ---- tasks
  const tasks = new Collection({
    type: "base",
    name: "tasks",
    listRule: USERS_ONLY,
    viewRule: USERS_ONLY,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: [
      "CREATE INDEX idx_tasks_to_status ON tasks (to_agent, status)",
      "CREATE INDEX idx_tasks_from_status ON tasks (from_agent, status)",
    ],
  })
  tasks.fields.add(
    new TextField({ name: "title", required: true, max: 300 }),
    new SelectField({ name: "priority", values: ["P0", "P1", "P2", "P3"], maxSelect: 1 }),
    new TextField({ name: "purpose", max: 20000 }),
    new TextField({ name: "money", max: 20000 }),
    new SelectField({
      name: "status",
      required: true,
      maxSelect: 1,
      values: ["submitted", "working", "input-required", "completed", "failed", "canceled"],
    }),
    new RelationField({ name: "from_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "to_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "owner_user", collectionId: users.id, maxSelect: 1 }),
    new TextField({ name: "handoff", max: BIG }),
    new NumberField({ name: "handoff_version", onlyInt: true, min: 0 }),
    new TextField({ name: "waiting_on", max: 100 }),
    new JSONField({ name: "links", maxSize: 200000 }),
    new TextField({ name: "run_id", max: 200 }),
    new DateField({ name: "claimed_at" }),
    new DateField({ name: "last_activity" }),
    new NumberField({ name: "agent_hops", onlyInt: true, min: 0 }),
    new NumberField({ name: "cost_usd", min: 0 }),
    new BoolField({ name: "cost_estimated" }),
    new TextField({ name: "result", max: BIG }),
    new DateField({ name: "parked_at" }),
  )
  autodates().forEach((f) => tasks.fields.add(f))
  app.save(tasks)
  // self relation needs the collection id
  tasks.fields.add(new RelationField({ name: "depends_on", collectionId: tasks.id, maxSelect: 50 }))
  app.save(tasks)

  // ---- handoff_versions
  const hv = new Collection({
    type: "base",
    name: "handoff_versions",
    listRule: USERS_ONLY,
    viewRule: USERS_ONLY,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: ["CREATE UNIQUE INDEX idx_hv_task_version ON handoff_versions (task, version)"],
  })
  hv.fields.add(
    new RelationField({ name: "task", required: true, collectionId: tasks.id, maxSelect: 1, cascadeDelete: true }),
    new NumberField({ name: "version", onlyInt: true, min: 1 }),
    new TextField({ name: "body", max: BIG }),
    new TextField({ name: "change_note", max: 20000 }),
    new RelationField({ name: "author_agent", collectionId: agents.id, maxSelect: 1 }),
  )
  autodates().forEach((f) => hv.fields.add(f))
  app.save(hv)

  // ---- messages
  const messages = new Collection({
    type: "base",
    name: "messages",
    listRule: USERS_ONLY,
    viewRule: USERS_ONLY,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: [
      "CREATE INDEX idx_messages_task ON messages (task)",
      "CREATE INDEX idx_messages_open ON messages (kind, resolved)",
    ],
  })
  messages.fields.add(
    new RelationField({ name: "task", required: true, collectionId: tasks.id, maxSelect: 1, cascadeDelete: true }),
    new SelectField({ name: "author_type", required: true, values: ["agent", "human", "system"], maxSelect: 1 }),
    new RelationField({ name: "author_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "author_user", collectionId: users.id, maxSelect: 1 }),
    new SelectField({
      name: "kind",
      required: true,
      maxSelect: 1,
      values: ["question", "answer", "decision_request", "decision", "progress", "result", "note"],
    }),
    new TextField({ name: "body", max: BIG }),
    new RelationField({ name: "to_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "to_user", collectionId: users.id, maxSelect: 1 }),
    new TextField({ name: "evidence", max: BIG }),
    new BoolField({ name: "resolved" }),
    new TextField({ name: "prev_status", max: 40 }),
    new TextField({ name: "topic", max: 40 }),
    new BoolField({ name: "escalated" }),
  )
  autodates().forEach((f) => messages.fields.add(f))
  app.save(messages)
  messages.fields.add(new RelationField({ name: "reply_to", collectionId: messages.id, maxSelect: 1 }))
  app.save(messages)

  // ---- run_tokens (superuser-only; never exposed)
  const rt = new Collection({
    type: "base",
    name: "run_tokens",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: [
      "CREATE UNIQUE INDEX idx_rt_hash ON run_tokens (token_hash)",
      "CREATE INDEX idx_rt_task ON run_tokens (task)",
    ],
  })
  rt.fields.add(
    new TextField({ name: "token_hash", required: true, hidden: true, max: 200 }),
    new RelationField({ name: "task", required: true, collectionId: tasks.id, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "agent", required: true, collectionId: agents.id, maxSelect: 1, cascadeDelete: true }),
    new TextField({ name: "run_id", max: 200 }),
    new SelectField({ name: "mode", required: true, values: ["work", "answer"], maxSelect: 1 }),
    new RelationField({ name: "question", collectionId: messages.id, maxSelect: 1 }),
    new DateField({ name: "expires_at", required: true }),
    new BoolField({ name: "revoked" }),
  )
  autodates().forEach((f) => rt.fields.add(f))
  app.save(rt)
}, (app) => {
  ;["run_tokens", "messages", "handoff_versions", "tasks", "agents"].forEach((n) => {
    try { app.delete(app.findCollectionByNameOrId(n)) } catch (_) {}
  })
})
