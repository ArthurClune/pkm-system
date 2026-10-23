---
# pkm-1zdg
title: Approval card must show every write's target
status: todo
type: task
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review findings (Medium x2 + Info): batch previews clip the whole serialized params so a uid disappears; the card collapses at PREVIEW_COLLAPSE_THRESHOLD (300) with Allow active and arguments in model-chosen order, so any write's target can sit after a long value; string values are inserted unescaped so a value can draw a fake argument list.

- [ ] Red test first, from the review probe: sec-assistant/probe_preview.py (card collapse, unescaped strings; it copies the TSX slice, so the web half needs a vitest on ConfirmCard itself); the first-pass batch-params probe was not kept, rebuild from the review doc. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] Target fields (uid, page, title, parent, path, allow_merge, ...) render first and never inside the collapsed or clipped part, for every write tool and every batch op
- [ ] Clip long values individually, never a whole params object
- [ ] Render string values so they cannot imitate argument syntax
- [ ] A second confirm_request does not swap the card under the cursor (queue or show both)
- [ ] Check ops_preview against live payloads per AGENTS/SECURITY note
