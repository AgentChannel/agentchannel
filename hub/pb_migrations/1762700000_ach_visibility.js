/// <reference path="../pb_data/types.d.ts" />
// Channel membership and private channels, roles, imported
// GitHub items as "external" posts.
// - channels.visibility: "team" (everyone on the hub) or "private" (members +
//   admins). channels.members: the people of the channel (from the import plan
//   or admin edits); for team channels membership only orders the sidebar.
// - users.role: free text from the import plan ("backend and worker").
// - posts.author_type "external": an imported GitHub issue/PR (external.author is
//   the GitHub login; author_user the matching person when known).
// - Collection read rules follow channel visibility for every collection that
//   carries channel content (posts, tasks, messages, handoff_versions, wiki).
//   Agents never use collection rules (they go through /api/ach routes).

const USERS_ONLY = '@request.auth.id != "" && @request.auth.collectionName = "users"'
const vis = (path) => `${USERS_ONLY} && (@request.auth.is_admin = true || ${path}.visibility != "private" || ${path}.members.id ?= @request.auth.id)`
const visOpt = (path) => `${USERS_ONLY} && (@request.auth.is_admin = true || ${path} = "" || ${path}.visibility != "private" || ${path}.members.id ?= @request.auth.id)`

const RULES = {
  channels: (c) => `${USERS_ONLY} && (@request.auth.is_admin = true || visibility != "private" || members.id ?= @request.auth.id)`,
  posts: () => vis("channel"),
  tasks: () => visOpt("channel"),
  messages: () => visOpt("task.channel"),
  handoff_versions: () => visOpt("task.channel"),
  wiki_pages: () => visOpt("channel"),
  wiki_versions: () => visOpt("page.channel"),
  wiki_decisions: () => visOpt("channel"),
  wiki_contributions: () => visOpt("channel"),
}

migrate((app) => {
  const users = app.findCollectionByNameOrId("users")
  if (!users.fields.getByName("role")) users.fields.add(new TextField({ name: "role", max: 200 }))
  app.save(users)

  const channels = app.findCollectionByNameOrId("channels")
  const v = channels.fields.getByName("visibility")
  v.values = ["team", "private"]
  if (!channels.fields.getByName("members")) channels.fields.add(new RelationField({ name: "members", collectionId: users.id, maxSelect: 100000 }))
  app.save(channels)

  const posts = app.findCollectionByNameOrId("posts")
  const at = posts.fields.getByName("author_type")
  at.values = ["agent", "human", "system", "external"]
  app.save(posts)
  // imported items so far were "system" posts carrying external data
  app.db().newQuery("UPDATE posts SET author_type = 'external' WHERE external_id != '' AND author_type = 'system'").execute()

  for (const name in RULES) {
    const c = app.findCollectionByNameOrId(name)
    c.listRule = RULES[name]()
    c.viewRule = RULES[name]()
    app.save(c)
  }
}, (app) => {
  for (const name in RULES) {
    const c = app.findCollectionByNameOrId(name)
    c.listRule = USERS_ONLY
    c.viewRule = USERS_ONLY
    app.save(c)
  }
  app.db().newQuery("UPDATE posts SET author_type = 'system' WHERE author_type = 'external'").execute()
  const posts = app.findCollectionByNameOrId("posts")
  posts.fields.getByName("author_type").values = ["agent", "human", "system"]
  app.save(posts)
  app.db().newQuery("UPDATE channels SET visibility = 'team' WHERE visibility = 'private'").execute()
  const channels = app.findCollectionByNameOrId("channels")
  channels.fields.getByName("visibility").values = ["team"]
  try { channels.fields.removeByName("members") } catch (_) {}
  app.save(channels)
  const users = app.findCollectionByNameOrId("users")
  try { users.fields.removeByName("role") } catch (_) {}
  app.save(users)
})
