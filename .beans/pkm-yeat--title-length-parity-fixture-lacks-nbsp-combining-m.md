---
# pkm-yeat
title: Title-length parity fixture lacks NBSP, combining-mark and lone-surrogate cases
status: in-progress
type: task
priority: low
created_at: 2026-10-26T16:13:09Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

From the security/batch-server final review (T12 Minor 8). The server/web parity fixture for title length checks no NBSP, combining marks or lone surrogates; verified by hand in T12 only.

- [x] Add the cases to the shared fixture -- title_length.json gains NBSP edges and runs, combining marks, and lone-surrogate cases; both sides gain a surrogate-load test
- [x] Both sides pass -- server test_title_length_fixture.py (26 passed) and web titleLength.test.ts pass; one mutant on each side goes red
