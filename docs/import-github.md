# Onboard a team from GitHub

Turn an existing GitHub organization into channels, people and a first Memory
page per channel. GitHub is read on the admin's machine with their own `gh`
login (or `GITHUB_TOKEN`); the hub never gets a GitHub token and nothing is
written to GitHub. You need an admin session (`ach admin login --link ...`).

```sh
gh auth status                                          # your GitHub login
ach admin import github --org acme --since 60d --dry-run --out acme-plan.json
#   prints channels (repos grouped by name prefix and activity), people with
#   inferred roles, bots skipped; writes the plan. Nothing changes anywhere.
$EDITOR acme-plan.json                                  # rename/merge channels, move repos,
                                                        # fix names/emails, "invite": true/false
ach admin import github --plan acme-plan.json           # apply (idempotent; re-run updates)
ach admin invite --people alice,bob --yes               # print one-time login links to send
ach admin sync github --org acme                        # later: issues/PRs updated since the last sync
ach memory seed --from-imports                          # one Memory upkeep task per channel
```

- **Plan file:** `channels: [{name, description, repos: [...]}]` (a repo maps
  to one channel; repos not in the plan are not read), `people:
  [{github_login, name, email?, is_admin?, invite, role, channels}]` (`self:
  true` is you), `bots` (never invited).
- **Apply** creates missing channels and people and imports each issue or PR as
  one compact card in its channel (tag, `repo#n` and title linking to GitHub,
  state, author and assignees, date, a short collapsed excerpt). Comment threads
  stay on GitHub. Cards are keyed by `github:owner/repo#n`, so re-runs and syncs
  update them in place and never notify anyone.
- **Two ranges:** cards **posted** are open items plus items closed in the last
  7 days (`--post-closed-days N`, `--all`); items used to **seed Memory** (links
  only, never posted) are closed items of the last 6 months (`--seed-months M`,
  `--seed-all`). Items whose labels or title mention security or secrets (in
  English or Chinese) are never sent, not even an excerpt (`--exclude a,b`,
  `--no-exclude`).
- **Who sees what:** GitHub permissions do not come along. Everyone on the hub
  sees every team channel, so mark channels holding restricted repos
  `"visibility": "private"` in the plan (or `ach admin channels private #name`);
  then only members and admins see them. Manage members with
  `ach admin channels members #name --add alice,bob --remove carol`.
- **Sync:** run `ach admin sync github --org acme` on a schedule (cron on the
  admin's machine or the runner's).
- **Feishu invites:** with the local `lark-cli` logged in, `ach admin invite
  --feishu` previews and `--feishu --yes` sends each person their one-time link
  by Feishu direct message (see [feishu.md](feishu.md)).
