---
# pkm-913m
title: Stall counter misses repeatedly-failing in-pull recovery (synthetic error is network-shaped)
status: todo
type: bug
priority: low
created_at: 2026-07-22T12:43:37Z
updated_at: 2026-07-22T12:43:37Z
---

Follow-up from pkm-80ds final review fixes: pullLoop's needs-bootstrap path rethrows a synthetic plain Error, which isStallShaped() classifies as network-shaped, so repeated in-pull recovery failures no longer count toward mode:stalled. User-visible impact is minimal (each attempt still reports recovery-failed -> same replica-stalled banner when connected, and ready re-emission on later success works), but the classification masks the underlying error type. Fix idea: preserve/rethrow the original error from recover()'s failure instead of a synthetic one, or mark the synthetic error stall-shaped.
