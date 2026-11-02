/// <reference path="../pb_data/types.d.ts" />
// ---- ach deploy block (owned by deploy/; see ach_deploy.js and docs/deploy.md)
// First-run setup link, admin deployment check, version.

// The token travels only in POST bodies (never a URL path or query,
// so it never lands in the request log).
routerAdd("POST", "/api/ach/setup/check", (e) => require(`${__hooks}/ach_deploy.js`).run(e, "setupState"))
routerAdd("POST", "/api/ach/setup", (e) => require(`${__hooks}/ach_deploy.js`).run(e, "setup"))
routerAdd("GET", "/api/ach/admin/deploy-check", (e) => require(`${__hooks}/ach_deploy.js`).run(e, "deployCheck"))
routerAdd("GET", "/api/ach/version", (e) => require(`${__hooks}/ach_deploy.js`).run(e, "version"))

// After bootstrap, print the setup link while there is no admin. `serve`
// applies migrations only after onBootstrap, so apply them here first (the
// same idempotent call `serve` makes next; it is a no-op when up to date).
onBootstrap((e) => {
  e.next()
  try {
    let addr = ""
    const args = $os.args || []
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i])
      if (a === "--http" && i + 1 < args.length) addr = String(args[i + 1])
      else if (a.indexOf("--http=") === 0) addr = a.slice(7)
    }
    if (args.indexOf("serve") < 0) return // only when serving, not for `superuser upsert` etc.
    e.app.runAllMigrations()
    require(`${__hooks}/ach_deploy.js`).announceSetup(e.app, addr)
  } catch (err) {
    console.log("ach first-run setup check failed: " + err)
  }
})
// ---- end ach deploy block
