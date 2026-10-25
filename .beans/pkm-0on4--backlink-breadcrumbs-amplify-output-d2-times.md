---
# pkm-0on4
title: Backlink breadcrumbs amplify output d²/2 times
status: in-progress
type: bug
priority: normal
created_at: 2026-10-25T04:38:08Z
updated_at: 2026-10-25T09:38:33Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

From the pkm-85jq review (2026-10-25). pkm-85jq fixed the CPU cost of breadcrumbs but kept the same output: d²/2 copies of ancestor text per backlinked chain. At the outline depth cap, 1.9 MiB of accepted writes (100-deep chain, each block [[Amp Target]] + 20,000 chars) made every GET /api/page/Amp Target return 96.4 MiB; with MAX_BLOCK_TEXT_CHARS = 1,000,000 that is ~4.8 GB per GET from ~100 MB stored. Probe: p8_amp.py in the 85jq review scratch (reproduce from this description). Server and replica both build it.

- [ ] Check how the web displays breadcrumb ancestor text (is it already visually clipped?)
- [ ] Bound breadcrumb bytes: send each ancestor once per response (shared map) and/or an explicit excerpt — never a silent cut (Arthur's rule); decide with the display
- [ ] Same on the replica path
- [ ] Red test from the amplification shape; perf case
- [ ] troubleshooting.md row
