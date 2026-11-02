/// <reference path="../pb_data/types.d.ts" />
// Team onboarding from GitHub (docs/import-github.md).
// - channels.repos: JSON list of "owner/name" repos whose issues/PRs land here.
// - posts.external / tasks.external: JSON {kind: github_issue|github_pr, repo,
//   number, url, state, title, author, assignees, created_at, updated_at}.
//   external_id ("github:owner/name#123") is the idempotency key: unique when set.
// - users.github_login (unique when set, matched case-insensitively by the
//   importer) and users.feishu_open_id (optional, for `ach admin invite --feishu`).
// The hub never stores a GitHub token: the `ach` CLI reads GitHub with the
// admin's own `gh` login and pushes the result through /api/ach/admin/import.

migrate((app) => {
  const channels = app.findCollectionByNameOrId("channels")
  if (!channels.fields.getByName("repos")) channels.fields.add(new JSONField({ name: "repos", maxSize: 20000 }))
  app.save(channels)

  for (const name of ["posts", "tasks"]) {
    const c = app.findCollectionByNameOrId(name)
    if (!c.fields.getByName("external")) c.fields.add(new JSONField({ name: "external", maxSize: 20000 }))
    if (!c.fields.getByName("external_id")) c.fields.add(new TextField({ name: "external_id", max: 300 }))
    c.indexes = (c.indexes || []).concat([`CREATE UNIQUE INDEX idx_${name}_external_id ON ${name} (external_id) WHERE external_id != ''`])
    app.save(c)
  }

  const users = app.findCollectionByNameOrId("users")
  if (!users.fields.getByName("github_login")) users.fields.add(new TextField({ name: "github_login", max: 100, pattern: "^$|^[A-Za-z0-9][A-Za-z0-9-]{0,99}$" }))
  if (!users.fields.getByName("feishu_open_id")) users.fields.add(new TextField({ name: "feishu_open_id", max: 200, hidden: true }))
  users.indexes = (users.indexes || []).concat(["CREATE UNIQUE INDEX idx_users_github_login ON users (lower(github_login)) WHERE github_login != ''"])
  app.save(users)
}, (app) => {
  const users = app.findCollectionByNameOrId("users")
  users.indexes = (users.indexes || []).filter((i) => !/idx_users_github_login/.test(i))
  ;["github_login", "feishu_open_id"].forEach((n) => { try { users.fields.removeByName(n) } catch (_) {} })
  app.save(users)
  for (const name of ["posts", "tasks"]) {
    const c = app.findCollectionByNameOrId(name)
    c.indexes = (c.indexes || []).filter((i) => !/_external_id/.test(i))
    ;["external", "external_id"].forEach((n) => { try { c.fields.removeByName(n) } catch (_) {} })
    app.save(c)
  }
  const channels = app.findCollectionByNameOrId("channels")
  try { channels.fields.removeByName("repos") } catch (_) {}
  app.save(channels)
})
