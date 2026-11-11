---
# pkm-3iwm
title: 'Recovery lease holds the worker gate across network I/O: measure, then document or restructure'
status: in-progress
type: task
priority: normal
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-11T09:34:28Z
parent: pkm-4gda
blocked_by:
    - pkm-onr2
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W11. Child of the 2026-11-09 maintainability review epic.


## Plan

Task-level plan: docs/superpowers/plans/2026-11-11-w11-recovery-lease.md
(Arthur, 2026-11-11: option (c), the lease follows the download, plus
compression of the snapshot and changes responses).

- [ ] T1 The sync routes gzip their bodies
- [ ] T2 The worker renews a recovery lease
- [ ] T3 A property over the worker lease
- [ ] T4 apiFetch bounds a read by its silence
- [ ] T5 runRecovery renews on progress and abandons a stalled download (after pkm-jowv)
- [ ] T6 "Reset failed" shows the message, not the class
- [ ] T7 The sync suite meets slow and stalled downloads
- [ ] T8 Docs say what W11 made true
- [ ] T9 The troubleshooting row (own final commit)
- [ ] T10 Measure the fix (Chromium throttled, WebKit through a pacing proxy)
