/// <reference path="../pb_data/types.d.ts" />
// Feishu card settlement and admin email mapping:
// - feishu_messages.settled: the card was updated in place after its request
//   was answered elsewhere (panel, CLI, another card).
// - feishu_ids.wants_user: an email match to an admin is held for an admin's
//   confirmation instead of mapping automatically.

migrate((app) => {
  const msgs = app.findCollectionByNameOrId("feishu_messages")
  msgs.fields.add(new BoolField({ name: "settled" }))
  app.save(msgs)
  const ids = app.findCollectionByNameOrId("feishu_ids")
  ids.fields.add(new TextField({ name: "wants_user", max: 20 }))
  app.save(ids)
}, (app) => {
  const msgs = app.findCollectionByNameOrId("feishu_messages")
  msgs.fields.removeByName("settled")
  app.save(msgs)
  const ids = app.findCollectionByNameOrId("feishu_ids")
  ids.fields.removeByName("wants_user")
  app.save(ids)
})
