/// <reference path="../pb_data/types.d.ts" />
// Attachments (images and videos) on messages and handoff versions.
// - attachments: protected file field (download needs a PocketBase file token,
//   or the agent route GET /api/ach/files/...). MIME allowlist only: no SVG/HTML.
// - attachments_meta: [{name, original, size, type}] written by the hooks.
// The per-file size limit is enforced by the hooks (ACH_MAX_FILE_MB, default 200);
// the field maxSize is only a hard ceiling.

const MIME = ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"]

migrate((app) => {
  for (const name of ["messages", "handoff_versions"]) {
    const c = app.findCollectionByNameOrId(name)
    if (!c.fields.getByName("attachments")) {
      c.fields.add(new FileField({
        name: "attachments",
        maxSelect: 10,
        maxSize: 4 * 1024 * 1024 * 1024,
        mimeTypes: MIME,
        protected: true,
      }))
    }
    if (!c.fields.getByName("attachments_meta")) c.fields.add(new JSONField({ name: "attachments_meta", maxSize: 100000 }))
    app.save(c)
  }
}, (app) => {
  for (const name of ["messages", "handoff_versions"]) {
    const c = app.findCollectionByNameOrId(name)
    ;["attachments", "attachments_meta"].forEach((n) => { try { c.fields.removeByName(n) } catch (_) {} })
    app.save(c)
  }
})
