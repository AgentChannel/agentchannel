/// <reference path="../pb_data/types.d.ts" />
// Panel UX: system lines carry a code + params next to their English body, so
// the panel renders them in the reader's language (messages and posts).
// sys_code: a short identifier (e.g. "changes_requested"); sys_params: JSON.

migrate((app) => {
  for (const name of ["messages", "posts"]) {
    const c = app.findCollectionByNameOrId(name)
    if (!c.fields.getByName("sys_code")) c.fields.add(new TextField({ name: "sys_code", max: 64 }))
    if (!c.fields.getByName("sys_params")) c.fields.add(new JSONField({ name: "sys_params", maxSize: 4000 }))
    app.save(c)
  }
}, (app) => {
  for (const name of ["messages", "posts"]) {
    const c = app.findCollectionByNameOrId(name)
    ;["sys_code", "sys_params"].forEach((n) => { try { c.fields.removeByName(n) } catch (_) {} })
    app.save(c)
  }
})
