---
# pkm-4z9r
title: wire pkm.describe logger into prod log output
status: todo
type: bug
created_at: 2026-07-28T07:33:36Z
updated_at: 2026-07-28T07:33:36Z
---

pkm.describe INFO lines (described <sha>: ok/error) never appear in ~/.config/pkm/logs/server.out.log — uvicorn_log_config() doesn't configure that logger, so backfill/describe activity is invisible in prod. Wire it like pkm.access. Found 2026-07-28 while monitoring the pkm-zc0c backfill.
