---
# pkm-0on4
title: Backlink breadcrumbs amplify output d²/2 times
status: completed
type: bug
priority: normal
created_at: 2026-10-25T04:38:08Z
updated_at: 2026-10-25T13:00:28Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

From the pkm-85jq review (2026-10-25). pkm-85jq fixed the CPU cost of breadcrumbs but kept the same output: d²/2 copies of ancestor text per backlinked chain. At the outline depth cap, 1.9 MiB of accepted writes (100-deep chain, each block [[Amp Target]] + 20,000 chars) made every GET /api/page/Amp Target return 96.4 MiB; with MAX_BLOCK_TEXT_CHARS = 1,000,000 that is ~4.8 GB per GET from ~100 MB stored. Probe: p8_amp.py in the 85jq review scratch (reproduce from this description). Server and replica both build it.

- [x] Check how the web displays breadcrumb ancestor text (is it already visually clipped?)
- [x] Bound breadcrumb bytes: send each ancestor once per response (shared map) and/or an explicit excerpt — never a silent cut (Arthur's rule); decide with the display
- [x] Same on the replica path
- [x] Red test from the amplification shape; perf case
- [x] troubleshooting.md row

## Summary of Changes

- Backlink responses no longer repeat ancestor text per item: each backlink group lists its ancestors' texts once (ancestor_texts) and each item names its trail by position (ancestors); both omitted when empty. Server and replica changed together; shim parity fixture regenerated. The web rebuilds text crumbs per batch, so the display is unchanged (full ancestor text, as before).
- The bean's 100-deep chain of 20,000-character blocks: GET /api/page 101,109,756 → 4,004,724 bytes (2x stored); block/backlinks, deep-backlinks and hub payloads shrank; page/hub-deep +363 bytes accepted by Arthur and recorded with --bootstrap.
- Old cached tabs: every item keeps a compatibility breadcrumbs field (["…"] or []), so an old online tab renders '…' instead of crashing until it reloads (troubleshooting row).
- Follow-up: the browser still renders each item's full trail (draft bean for a visible clip).
