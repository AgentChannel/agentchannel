/// <reference path="../pb_data/types.d.ts" />
// Large files, references and retention (pb_hooks/ach_storage.js):
// - ach_uploads: direct uploads to S3-compatible storage (presigned PUT, then
//   complete). Route-only (no collection API rules). `principal` is
//   "agent:<id>" or "user:<id>"; `target` what the upload was presigned for;
//   `record` the "<collection>/<id>" it was attached to.
// - channels.retention_days: 0 keeps everything (default); N deletes
//   attachments of terminal tasks older than N days, except those flagged keep.

migrate((app) => {
  const up = new Collection({
    type: "base", name: "ach_uploads", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    indexes: [
      "CREATE UNIQUE INDEX idx_ach_uploads_key ON ach_uploads (key)",
      "CREATE INDEX idx_ach_uploads_principal ON ach_uploads (principal, status)",
      "CREATE INDEX idx_ach_uploads_status ON ach_uploads (status, created)",
      "CREATE INDEX idx_ach_uploads_channel ON ach_uploads (channel)",
    ],
  })
  up.fields.add(
    new TextField({ name: "key", required: true, max: 1024 }),
    new TextField({ name: "name", required: true, max: 255 }),
    new TextField({ name: "mime", required: true, max: 100 }),
    new NumberField({ name: "size", min: 0, onlyInt: true }),
    new SelectField({ name: "status", required: true, values: ["pending", "complete", "attached", "failed", "deleted"], maxSelect: 1 }),
    new TextField({ name: "principal", required: true, max: 40 }),
    new TextField({ name: "target", max: 120 }),
    new SelectField({ name: "target_kind", values: ["task", "channel", "post", "new_task"], maxSelect: 1 }),
    new TextField({ name: "task", max: 20 }),
    new TextField({ name: "channel", max: 20 }),
    new TextField({ name: "post", max: 20 }),
    new TextField({ name: "record", max: 80 }),
    new BoolField({ name: "keep" }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(up)

  const channels = app.findCollectionByNameOrId("channels")
  if (!channels.fields.getByName("retention_days")) channels.fields.add(new NumberField({ name: "retention_days", min: 0, max: 3650, onlyInt: true }))
  app.save(channels)
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("ach_uploads")) } catch (_) {}
  try {
    const channels = app.findCollectionByNameOrId("channels")
    channels.fields.removeByName("retention_days")
    app.save(channels)
  } catch (_) {}
})
