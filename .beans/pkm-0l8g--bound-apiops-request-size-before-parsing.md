---
# pkm-0l8g
title: Bound /api/ops request size before parsing
status: todo
type: bug
priority: low
created_at: 2026-10-25T02:14:31Z
updated_at: 2026-10-25T02:14:31Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf plan open risks (2026-10-25). A 500-op batch of 1,000,000-character texts (500M chars, ~2 GB as JSON) is read into memory before the text-limit guard. Related: pkm-zav2 (auth before body). Add a request-body byte cap for /api/ops sized from MAX_OPS_PER_BATCH x MAX_BLOCK_TEXT_CHARS plus overhead, or a streaming refusal.

- [ ] Decide the cap from real batch sizes
- [ ] 413 before parsing; test
- [ ] troubleshooting.md row
