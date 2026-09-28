---
# pkm-oo9w
title: Perf harness has no hashed update_text scenarios
status: todo
type: task
created_at: 2026-09-28T22:40:50Z
updated_at: 2026-09-28T22:40:50Z
---

Found in pkm-wy1v. perf/check.sh backend's only /api/ops update_text scenario (ops/edit-1) sends no base_text_hash, so it exercises the legacy hashless path. Nothing measures the hashed paths: clean, identical, conflict (daily-page landing), rename replay, or pkm-foap's missing-target landings. pkm-wy1v's query savings are therefore unmeasured. Add hashed scenarios to the harness and bootstrap their baselines.
