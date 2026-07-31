---
# pkm-2ilw
title: Canonicalize existing space-padded page titles (data migration)
status: todo
type: task
priority: normal
created_at: 2026-07-31T16:43:21Z
updated_at: 2026-07-31T16:43:21Z
parent: pkm-ulae
---

Follow-up from pkm-1rb5 review. Production data contains pages whose stored titles carry leading/trailing plain spaces (e.g. " EvilCorp" id=2 with 11 blocks/3 inbound refs; "Paper/AI-Assisted Scientific Assessment: A Case Study on Climate Change " id=2924). Since padded and stripped spellings resolve to different pages (exact-match lookup, deliberately preserved by pkm-1rb5 round 2), users can silently split content between "X" and " X".

Design a one-time data migration that trims existing padded page titles, merging into an existing clean-named twin where one exists (reuse the pkm-g0t5 rename/merge machinery), rewriting inbound [[refs]] accordingly. After migration, consider stripping plain spaces at the shared creation boundary so new padded titles cannot be created (blocked on the migration; see pkm-1rb5's recorded decision).

- [ ] Inventory padded titles in prod DB
- [ ] Migration with merge handling + ref rewrite
- [ ] Then (and only then) canonicalize new titles at the creation boundary
