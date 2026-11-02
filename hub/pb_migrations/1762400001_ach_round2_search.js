/// <reference path="../pb_data/types.d.ts" />
// B14: index the text of text/code/HTML attachments. The hooks store it in
// attachments_text (posts, messages, handoff_versions); the FTS triggers of
// those tables are recreated to include it.
const ATT = "COALESCE((SELECT group_concat(json_extract(value,'$.original'),' ') FROM json_each(CASE WHEN json_valid(new.attachments_meta) THEN new.attachments_meta ELSE '[]' END)),'') || ' ' || COALESCE(new.attachments_text,'')"
const FTS2 = {
  post: ["posts", "COALESCE(new.body,'') || ' ' || " + ATT,
    "COALESCE(new.task,'')", "COALESCE(new.channel,'')",
    "COALESCE(NULLIF(new.author_agent,''), NULLIF(new.author_user,''), '')",
    "body, attachments_meta, attachments_text", "new.kind = 'post'"],
  message: ["messages", "COALESCE(new.body,'') || ' ' || COALESCE(new.evidence,'') || ' ' || " + ATT,
    "new.task", "COALESCE((SELECT channel FROM tasks WHERE id = new.task),'')",
    "COALESCE(NULLIF(new.author_agent,''), NULLIF(new.author_user,''), '')",
    "body, evidence, attachments_meta, attachments_text"],
  handoff: ["handoff_versions", "COALESCE(new.body,'') || ' ' || COALESCE(new.change_note,'') || ' ' || " + ATT,
    "new.task", "COALESCE((SELECT channel FROM tasks WHERE id = new.task),'')", "COALESCE(new.author_agent,'')",
    "body, change_note, attachments_meta, attachments_text"],
}

migrate((app) => {
  for (const kind in FTS2) {
    for (const s of ["ai", "au", "ad"]) app.db().newQuery(`DROP TRIGGER IF EXISTS ach_fts_${kind}_${s}`).execute()
  }
  for (const name of ["posts", "messages", "handoff_versions"]) {
    const c = app.findCollectionByNameOrId(name)
    if (!c.fields.getByName("attachments_text")) c.fields.add(new TextField({ name: "attachments_text", max: 2200000 }))
    app.save(c)
  }
  for (const kind in FTS2) {
    const [table, text, task, channel, author, cols, only] = FTS2[kind]
    const onlyNew = only ? ` WHEN ${only}` : ""
    const ins = `INSERT INTO ach_fts(body, kind, rid, task, channel, author, created) VALUES (${text}, '${kind}', new.id, ${task}, ${channel}, ${author}, new.created);`
    const del = `DELETE FROM ach_fts WHERE kind = '${kind}' AND rid = old.id;`
    const when = "(" + cols.split(",").map((c) => `old.${c.trim()} IS NOT new.${c.trim()}`).join(" OR ") + ")" + (only ? ` AND ${only}` : "")
    app.db().newQuery(`CREATE TRIGGER ach_fts_${kind}_ai AFTER INSERT ON ${table}${onlyNew} BEGIN ${ins} END`).execute()
    app.db().newQuery(`CREATE TRIGGER ach_fts_${kind}_au AFTER UPDATE OF ${cols} ON ${table} WHEN ${when} BEGIN ${del} ${ins} END`).execute()
    app.db().newQuery(`CREATE TRIGGER ach_fts_${kind}_ad AFTER DELETE ON ${table} BEGIN ${del} END`).execute()
  }
}, (app) => {
  // the triggers keep working without the column only if recreated by the
  // channels migration; down-migrations are for tests, so just drop the field
  for (const kind in FTS2) {
    for (const s of ["ai", "au", "ad"]) app.db().newQuery(`DROP TRIGGER IF EXISTS ach_fts_${kind}_${s}`).execute()
  }
  for (const name of ["posts", "messages", "handoff_versions"]) {
    const c = app.findCollectionByNameOrId(name)
    try { c.fields.removeByName("attachments_text") } catch (_) {}
    app.save(c)
  }
})
