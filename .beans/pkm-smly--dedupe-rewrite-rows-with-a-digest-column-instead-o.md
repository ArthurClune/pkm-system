---
# pkm-smly
title: Dedupe rewrite rows with a digest column instead of a charged read
status: todo
type: task
priority: low
created_at: 2026-10-26T19:58:27Z
updated_at: 2026-10-26T19:58:27Z
parent: pkm-mfd0
---

From the security/batch-server perf-fix re-review. Recording a rewrite row first reads the rows stored under (uid, base_hash) to skip duplicates — one charged statement per replayed edit (part of ops/edit-rename-replay 25→28), and past the budget nothing is compared, so a reposted stale op can store duplicates. A digest column with a unique index on (uid, base_hash, digest) plus INSERT OR IGNORE would dedupe in one lookup per row, without reading or charging, including past the budget. Needs a migration.

- [ ] Migration adding the digest column + unique index (backfill)
- [ ] INSERT OR IGNORE in RecordRewrite; drop the dedupe read
- [ ] perf: ops/edit-rename-replay drops one statement; --bootstrap
