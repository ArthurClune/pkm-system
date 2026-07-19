---
# pkm-vphw
title: Harden synthetic data generator edge cases
status: in-progress
type: task
priority: low
created_at: 2026-07-18T20:58:19Z
updated_at: 2026-07-19T14:07:29Z
---

Follow-ups from the pkm-2xh2 final review.

## Checklist

- [ ] Add a focused success-path test for generation into a pre-existing empty output directory
- [ ] Deduplicate fixture assets by SHA before inserting asset rows
- [ ] Add a regression test for differently named asset files with identical bytes
- [ ] Run focused generator tests, pyrefly, and Ruff
