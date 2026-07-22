---
# pkm-ri5b
title: Require batch_id on POST /api/ops; give web fallback paths real batch ids
status: todo
type: bug
priority: high
created_at: 2026-07-22T10:12:47Z
updated_at: 2026-07-22T10:12:47Z
---

Fix B of docs/superpowers/specs/2026-07-22-sync-hardening-design.md (incident bean pkm-8uld). Id-less batches apply unconditionally on every retry/replay, which re-applied stale edits during the incident. Server: OpBatch.batch_id required, 422 when absent, openapi+types regen. Web: legacy queue freezes slice+id across retries; quota fallback mints an id.
