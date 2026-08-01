---
# pkm-1wv1
title: Deduplicate queued and in-flight image descriptions
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 15).

## Context

**References:** `server/src/pkm/describe/service.py:60-79,96-122`; `server/src/pkm/describe/routes.py:23-28`

Uploads and scans enqueue SHA values without pending/in-flight deduplication. Duplicate entries after a failure can repeatedly send the same private image to the external describer, multiplying cost and rate-limit pressure.

**Direction:** Track queued/in-flight SHAs with finally cleanup and model force-retry intent explicitly.

## Tasks

- [ ] Add duplicate upload/scan tests with a failing describer
- [ ] Guarantee at most one ordinary in-flight attempt per asset
