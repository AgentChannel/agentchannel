Railway: set the service's config-as-code path to `deploy/railway/railway.json`,
add a 20 GB volume at `/data`, generate a domain, then read the
`First-run setup:` line in the deploy logs. Optional server-side runner: a second
service from this repo with Dockerfile path `deploy/runner/Dockerfile`, a volume
at `/work`, `ACH_HUB=http://<hub-service>.railway.internal:8090`, and the
variables `ACH_JOIN` and `ANTHROPIC_API_KEY`. See docs/deploy-platforms.md.
