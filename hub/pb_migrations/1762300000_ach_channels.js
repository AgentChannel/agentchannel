/// <reference path="../pb_data/types.d.ts" />
// Channels, posts, mentions, search and links.
// - channels: team-visible discussion streams; "general" is seeded.
// - posts: top-level posts and thread replies (parent); kind "task" is a task's
//   anchor post in its channel. Attachments reuse the message machinery.
// - mentions: one row per (mentioned agent, post); the agent's runner wakes for
//   a read-only "mention run" (run token mode "mention"). Superuser-only.
// - hub_settings: key/value (embed host allowlist). Superuser-only; routes.
// - tasks.channel, tasks.seq (T-<seq>, unique); existing tasks are backfilled
//   into #general with anchor posts, numbered in creation order.
// - run_tokens / usage: mode "mention" (bound to a post thread, no task).
// - Attachments: text/code (≤ 2 MB, checked by the hooks) and .html artifacts
//   join images and videos. The content-based MIME check stays on.
// - ach_fts: SQLite FTS5 (trigram tokenizer, handles Chinese) kept current by
//   triggers on posts, tasks, messages and handoff_versions. NOTE: a future
//   migration that drops or rebuilds an indexed column must recreate these
//   triggers (SQLite refuses DROP COLUMN on a column a trigger uses).

const MEDIA_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"]
const TEXT_MIME = ["text/plain", "text/csv", "application/json", "text/x-python", "text/x-shellscript", "text/javascript", "text/html"]
const ALL_MIME = MEDIA_MIME.concat(TEXT_MIME)
const USERS_ONLY = '@request.auth.id != "" && @request.auth.collectionName = "users"'
const BIG = 1000000

const FTS_SOURCES = {
  // kind -> [table, text expression over NEW, task expr, channel expr, author expr, update-of columns]
  post: ["posts",
    "COALESCE(new.body,'') || ' ' || COALESCE((SELECT group_concat(json_extract(value,'$.original'),' ') FROM json_each(CASE WHEN json_valid(new.attachments_meta) THEN new.attachments_meta ELSE '[]' END)),'')",
    "COALESCE(new.task,'')", "COALESCE(new.channel,'')",
    "COALESCE(NULLIF(new.author_agent,''), NULLIF(new.author_user,''), '')",
    "body, attachments_meta", "new.kind = 'post'"],
  task: ["tasks",
    "COALESCE(new.title,'') || ' ' || COALESCE(new.purpose,'') || ' ' || COALESCE(new.key_question,'') || ' ' || COALESCE(new.money,'')",
    "new.id", "COALESCE(new.channel,'')", "COALESCE(new.from_agent,'')",
    "title, purpose, key_question, money, channel"],
  message: ["messages",
    "COALESCE(new.body,'') || ' ' || COALESCE(new.evidence,'') || ' ' || COALESCE((SELECT group_concat(json_extract(value,'$.original'),' ') FROM json_each(CASE WHEN json_valid(new.attachments_meta) THEN new.attachments_meta ELSE '[]' END)),'')",
    "new.task", "COALESCE((SELECT channel FROM tasks WHERE id = new.task),'')",
    "COALESCE(NULLIF(new.author_agent,''), NULLIF(new.author_user,''), '')",
    "body, evidence, attachments_meta"],
  handoff: ["handoff_versions",
    "COALESCE(new.body,'') || ' ' || COALESCE(new.change_note,'') || ' ' || COALESCE((SELECT group_concat(json_extract(value,'$.original'),' ') FROM json_each(CASE WHEN json_valid(new.attachments_meta) THEN new.attachments_meta ELSE '[]' END)),'')",
    "new.task", "COALESCE((SELECT channel FROM tasks WHERE id = new.task),'')", "COALESCE(new.author_agent,'')",
    "body, change_note, attachments_meta"],
}

function ftsSql() {
  const out = [
    "CREATE VIRTUAL TABLE IF NOT EXISTS ach_fts USING fts5(body, kind UNINDEXED, rid UNINDEXED, task UNINDEXED, channel UNINDEXED, author UNINDEXED, created UNINDEXED, tokenize='trigram')",
  ]
  for (const kind in FTS_SOURCES) {
    const [table, text, task, channel, author, cols, only] = FTS_SOURCES[kind]
    // a task's anchor post repeats the task title: only real posts are indexed
    const onlyNew = only ? ` WHEN ${only}` : ""
    const ins = `INSERT INTO ach_fts(body, kind, rid, task, channel, author, created) VALUES (${text}, '${kind}', new.id, ${task}, ${channel}, ${author}, new.created);`
    const del = `DELETE FROM ach_fts WHERE kind = '${kind}' AND rid = old.id;`
    out.push(`CREATE TRIGGER IF NOT EXISTS ach_fts_${kind}_ai AFTER INSERT ON ${table}${onlyNew} BEGIN ${ins} END`)
    // PocketBase updates name every column, so only re-index when an indexed column really changed.
    const when = "(" + cols.split(",").map((c) => `old.${c.trim()} IS NOT new.${c.trim()}`).join(" OR ") + ")" + (only ? ` AND ${only}` : "")
    out.push(`CREATE TRIGGER IF NOT EXISTS ach_fts_${kind}_au AFTER UPDATE OF ${cols} ON ${table} WHEN ${when} BEGIN ${del} ${ins} END`)
    out.push(`CREATE TRIGGER IF NOT EXISTS ach_fts_${kind}_ad AFTER DELETE ON ${table} BEGIN ${del} END`)
  }
  return out
}

function ftsBackfill(app) {
  app.db().newQuery("DELETE FROM ach_fts").execute()
  for (const kind in FTS_SOURCES) {
    const [table, text, task, channel, author, , only] = FTS_SOURCES[kind]
    const sel = (s) => s.replace(/\bnew\./g, "n.")
    app.db().newQuery(
      `INSERT INTO ach_fts(body, kind, rid, task, channel, author, created) SELECT ${sel(text)}, '${kind}', n.id, ${sel(task)}, ${sel(channel)}, ${sel(author)}, n.created FROM ${table} n` + (only ? ` WHERE ${sel(only)}` : "")
    ).execute()
  }
}

migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const agents = app.findCollectionByNameOrId("agents")
  const tasks = app.findCollectionByNameOrId("tasks")
  const autodates = () => [
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  ]

  // ---- channels
  const channels = new Collection({
    type: "base",
    name: "channels",
    listRule: USERS_ONLY,
    viewRule: USERS_ONLY,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: ["CREATE UNIQUE INDEX idx_channels_name ON channels (name)"],
  })
  channels.fields.add(
    new TextField({ name: "name", required: true, max: 40, pattern: "^[a-z0-9][a-z0-9_-]{0,39}$" }),
    new TextField({ name: "description", max: 2000 }),
    new SelectField({ name: "visibility", values: ["team"], maxSelect: 1 }),
    new RelationField({ name: "created_by", collectionId: users.id, maxSelect: 1 }),
    new BoolField({ name: "archived" }),
  )
  autodates().forEach((f) => channels.fields.add(f))
  app.save(channels)

  // ---- posts
  const posts = new Collection({
    type: "base",
    name: "posts",
    listRule: USERS_ONLY,
    viewRule: USERS_ONLY,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: [
      "CREATE INDEX idx_posts_channel ON posts (channel, created)",
      "CREATE INDEX idx_posts_task ON posts (task)",
    ],
  })
  posts.fields.add(
    new RelationField({ name: "channel", required: true, collectionId: channels.id, maxSelect: 1, cascadeDelete: true }),
    new SelectField({ name: "author_type", required: true, values: ["agent", "human", "system"], maxSelect: 1 }),
    new RelationField({ name: "author_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "author_user", collectionId: users.id, maxSelect: 1 }),
    new SelectField({ name: "kind", required: true, values: ["post", "task", "system"], maxSelect: 1 }),
    new TextField({ name: "body", max: BIG }),
    new TextField({ name: "evidence", max: BIG }),
    new FileField({ name: "attachments", maxSelect: 10, maxSize: 4 * 1024 * 1024 * 1024, mimeTypes: ALL_MIME, protected: true }),
    new JSONField({ name: "attachments_meta", maxSize: 100000 }),
    new RelationField({ name: "task", collectionId: tasks.id, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "mentions", collectionId: agents.id, maxSelect: 50 }),
    new NumberField({ name: "thread_hops", onlyInt: true, min: 0 }),
    new NumberField({ name: "reply_count", onlyInt: true, min: 0 }),
    new DateField({ name: "last_reply_at" }),
    new BoolField({ name: "escalated" }),
    new RelationField({ name: "to_user", collectionId: users.id, maxSelect: 1 }),
  )
  autodates().forEach((f) => posts.fields.add(f))
  app.save(posts)
  posts.fields.add(new RelationField({ name: "parent", collectionId: posts.id, maxSelect: 1, cascadeDelete: true }))
  posts.indexes = posts.indexes.concat(["CREATE INDEX idx_posts_parent ON posts (parent, created)"])
  app.save(posts)

  // ---- mentions (superuser-only bookkeeping)
  const mentions = new Collection({
    type: "base",
    name: "mentions",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: ["CREATE INDEX idx_mentions_agent ON mentions (agent, status)", "CREATE INDEX idx_mentions_thread ON mentions (thread, agent)"],
  })
  mentions.fields.add(
    new RelationField({ name: "post", required: true, collectionId: posts.id, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "thread", required: true, collectionId: posts.id, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "agent", required: true, collectionId: agents.id, maxSelect: 1, cascadeDelete: true }),
    new RelationField({ name: "by_agent", collectionId: agents.id, maxSelect: 1 }),
    new RelationField({ name: "by_user", collectionId: users.id, maxSelect: 1 }),
    new SelectField({ name: "status", required: true, values: ["open", "running", "done"], maxSelect: 1 }),
    new TextField({ name: "run_id", max: 200 }),
  )
  autodates().forEach((f) => mentions.fields.add(f))
  app.save(mentions)

  // ---- hub_settings (superuser-only; routes read/write it)
  const settings = new Collection({
    type: "base",
    name: "hub_settings",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: ["CREATE UNIQUE INDEX idx_hub_settings_key ON hub_settings (key)"],
  })
  settings.fields.add(new TextField({ name: "key", required: true, max: 100 }), new JSONField({ name: "value", maxSize: 200000 }))
  autodates().forEach((f) => settings.fields.add(f))
  app.save(settings)

  // ---- tasks: channel + seq
  tasks.fields.add(new RelationField({ name: "channel", collectionId: channels.id, maxSelect: 1 }))
  tasks.fields.add(new NumberField({ name: "seq", onlyInt: true, min: 0 }))
  tasks.indexes = (tasks.indexes || []).concat(["CREATE UNIQUE INDEX idx_tasks_seq ON tasks (seq) WHERE seq > 0", "CREATE INDEX idx_tasks_channel ON tasks (channel)"])
  app.save(tasks)

  // ---- run_tokens / usage: mention mode, no task
  const rt = app.findCollectionByNameOrId("run_tokens")
  rt.fields.getByName("task").required = false
  rt.fields.getByName("mode").values = ["work", "answer", "mention"]
  rt.fields.add(new RelationField({ name: "post", collectionId: posts.id, maxSelect: 1, cascadeDelete: true }))
  rt.fields.add(new RelationField({ name: "mention", collectionId: mentions.id, maxSelect: 1, cascadeDelete: true }))
  app.save(rt)
  const usage = app.findCollectionByNameOrId("usage")
  usage.fields.getByName("task").required = false
  usage.fields.getByName("mode").values = ["work", "answer", "mention"]
  usage.fields.add(new RelationField({ name: "post", collectionId: posts.id, maxSelect: 1, cascadeDelete: true }))
  app.save(usage)

  // ---- attachments: text/code and HTML artifacts too
  for (const name of ["messages", "handoff_versions"]) {
    const c = app.findCollectionByNameOrId(name)
    c.fields.getByName("attachments").mimeTypes = ALL_MIME
    app.save(c)
  }

  // ---- seed #general, backfill tasks (channel, seq, anchor post)
  const general = new Record(channels)
  general.set("name", "general")
  general.set("description", "Team-wide discussion and tasks")
  general.set("visibility", "team")
  general.set("archived", false)
  app.save(general)
  const old = app.findRecordsByFilter("tasks", "id != ''", "created,id", 0, 0)
  let seq = 0
  for (const t of old) {
    seq++
    t.set("seq", seq)
    t.set("channel", general.id)
    app.saveNoValidate(t)
    const p = new Record(posts)
    p.set("channel", general.id)
    p.set("author_type", "agent")
    p.set("author_agent", t.getString("from_agent"))
    p.set("kind", "task")
    p.set("task", t.id)
    p.set("body", t.getString("title"))
    app.saveNoValidate(p)
    // keep the stream in task order
    app.db().newQuery("UPDATE posts SET created = {:c} WHERE id = {:id}").bind({ c: t.getString("created"), id: p.id }).execute()
  }

  // ---- full-text search
  ftsSql().forEach((s) => app.db().newQuery(s).execute())
  ftsBackfill(app)
}, (app) => {
  ;["ai", "au", "ad"].forEach((s) => {
    for (const k in FTS_SOURCES) app.db().newQuery(`DROP TRIGGER IF EXISTS ach_fts_${k}_${s}`).execute()
  })
  app.db().newQuery("DROP TABLE IF EXISTS ach_fts").execute()
  const tasks = app.findCollectionByNameOrId("tasks")
  ;["channel", "seq"].forEach((n) => { try { tasks.fields.removeByName(n) } catch (_) {} })
  tasks.indexes = (tasks.indexes || []).filter((i) => !/idx_tasks_seq|idx_tasks_channel/.test(i))
  app.save(tasks)
  const rt = app.findCollectionByNameOrId("run_tokens")
  ;["post", "mention"].forEach((n) => { try { rt.fields.removeByName(n) } catch (_) {} })
  app.save(rt)
  const usage = app.findCollectionByNameOrId("usage")
  try { usage.fields.removeByName("post") } catch (_) {}
  app.save(usage)
  ;["mentions", "hub_settings", "posts", "channels"].forEach((n) => {
    try { app.delete(app.findCollectionByNameOrId(n)) } catch (_) {}
  })
})
