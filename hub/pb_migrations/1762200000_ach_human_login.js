/// <reference path="../pb_data/types.d.ts" />
// Human login without passwords.
// - users.email is optional (external people may have none); the unique email
//   index ignores empty values.
// - users.deactivated: a deactivated person cannot authenticate (authRule) and
//   loses every session (the hooks rotate their tokenKey).
// - users.authToken lasts 30 days ("remember this device"); the panel refreshes
//   it on every load, so an active person stays logged in.
// - users.otp: PocketBase email one-time codes (needs SMTP; see docs/deploy.md).
// - login_tokens: one-time login links (invite 24h, re-login 24h, `ach open`
//   60s). Only the SHA-256 of the token is stored; superuser-only collection.

const USER_TOKEN_DAYS = 30

migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  const email = users.fields.getByName("email")
  if (email) email.required = false
  if (!users.fields.getByName("deactivated")) users.fields.add(new BoolField({ name: "deactivated" }))
  users.authRule = "deactivated = false"
  users.authToken.duration = USER_TOKEN_DAYS * 24 * 3600
  users.otp.enabled = true
  users.otp.duration = 600
  users.otp.length = 8
  app.save(users)

  const lt = new Collection({
    type: "base",
    name: "login_tokens",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    indexes: ["CREATE UNIQUE INDEX idx_login_tokens_hash ON login_tokens (token_hash)"],
  })
  lt.fields.add(
    new TextField({ name: "token_hash", required: true, hidden: true, max: 200 }),
    new RelationField({ name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true }),
    new SelectField({ name: "kind", values: ["invite", "login", "open"], maxSelect: 1, required: true }),
    new DateField({ name: "expires_at", required: true }),
    new DateField({ name: "used_at" }),
    new TextField({ name: "created_by", max: 100 }),
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  )
  app.save(lt)
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("login_tokens")) } catch (_) {}
  const users = app.findCollectionByNameOrId("users")
  try { users.fields.removeByName("deactivated") } catch (_) {}
  users.authRule = ""
  users.otp.enabled = false
  users.authToken.duration = 604800
  const email = users.fields.getByName("email")
  if (email) email.required = true
  app.save(users)
})
