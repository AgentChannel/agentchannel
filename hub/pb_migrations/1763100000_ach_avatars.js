/// <reference path="../pb_data/types.d.ts" />
// Avatars (pb_hooks/ach_avatars.js). One row per (person, source):
// - source: upload (the person's own), feishu (uploaded by `ach admin` from
//   lark-cli), github (hub-fetched github.com/<login>.png), gravatar
//   (hub-fetched by email hash).
// - file: the cached image as fetched/uploaded (<= 200 KB; PNG/JPEG/GIF/WebP,
//   never SVG). PocketBase serves a 128x128 thumbnail (?thumb=128x128), so the
//   panel loads avatars only from the hub. Not "protected": the URL holds the
//   random record id and file name and is only handed out by the
//   authenticated GET /api/ach/avatars (the collection itself has no API rules).
// - status: ok (file present) | missing (the source has none) | error.
// - fetched_at: last fetch/upload; hub-fetched rows are refreshed weekly.

migrate((app) => {
  let c
  try {
    c = app.findCollectionByNameOrId("avatars")
  } catch (_) {
    c = new Collection({
      type: "base", name: "avatars",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    })
  }
  if (!c.fields.getByName("user")) c.fields.add(new TextField({ name: "user", required: true, max: 20 }))
  if (!c.fields.getByName("source")) c.fields.add(new SelectField({ name: "source", required: true, values: ["upload", "feishu", "github", "gravatar"], maxSelect: 1 }))
  if (!c.fields.getByName("file")) {
    c.fields.add(new FileField({
      name: "file", maxSelect: 1, maxSize: 200 * 1024,
      mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
      thumbs: ["128x128"], protected: false,
    }))
  }
  if (!c.fields.getByName("status")) c.fields.add(new SelectField({ name: "status", values: ["ok", "missing", "error"], maxSelect: 1 }))
  if (!c.fields.getByName("fetched_at")) c.fields.add(new TextField({ name: "fetched_at", max: 40 }))
  if (!c.fields.getByName("note")) c.fields.add(new TextField({ name: "note", max: 300 }))
  if (!c.fields.getByName("created")) c.fields.add(new AutodateField({ name: "created", onCreate: true }))
  if (!c.fields.getByName("updated")) c.fields.add(new AutodateField({ name: "updated", onCreate: true, onUpdate: true }))
  c.indexes = ["CREATE UNIQUE INDEX idx_avatars_user_source ON avatars (user, source)"]
  app.save(c)
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("avatars")) } catch (_) {}
})
