---
# pkm-r1wy
title: update.sh silently updates whatever checkout it lives in
status: todo
type: bug
created_at: 2026-07-09T19:46:33Z
updated_at: 2026-07-09T19:46:33Z
---

Running deploy/update.sh from the dev checkout pulls/rebuilds the dev repo but kickstarts the production service — the deployed app at $PKM_HOME/app is untouched, so "updates" silently do nothing in prod (bit us on pkm-862c). Options: make update.sh refuse to run (or warn loudly) when its APP dir is not $PKM_HOME/app, or make the dev copy delegate to the deployed one. Also worth adding while in there: serve index.html with cache-control: no-cache so browsers revalidate and pick up new hashed bundles immediately after deploys.
