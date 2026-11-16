---
# pkm-1zdg
title: Approval card must show every write's target
status: completed
type: task
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-11-16T10:20:47Z
parent: pkm-mfd0
---

Review findings (Medium x2 + Info): batch previews clip the whole serialized params so a uid disappears; the card collapses at PREVIEW_COLLAPSE_THRESHOLD (300) with Allow active and arguments in model-chosen order, so any write's target can sit after a long value; string values are inserted unescaped so a value can draw a fake argument list.

- [x] Red test first, reproducing the review's finding.
- [x] Target fields (uid, page, title, parent, path, allow_merge, ...) render first and never inside the collapsed or clipped part, for every write tool and every batch op
- [x] Clip long values individually, never a whole params object
- [x] Render string values so they cannot imitate argument syntax
- [x] A second confirm_request does not swap the card under the cursor (queue or show both)
- [x] Check ops_preview against live payloads per AGENTS/SECURITY note (satisfied by `test_preview_matches_what_the_tool_receives`, which compares the preview with what the tool receives)

## Decision (2026-10-23)

Arthur approved the drafted design (targets first and in full, content clipped per value, unknown keys as targets, non-schema-shaped input denied, values as quoted separate elements, allow_merge warning line, confirms queued). Next: spec, then plan.

## Summary of Changes

The approval card is built by `write_preview.py` from the tool's own FastMCP argument model: targets first, in full, with unnamed keys counted as targets; content clipped per value; input the schema rejects is denied without a confirm. The web card quotes values (`quoteValue`), escapes labels and warnings, queues confirms, and arms Allow after `ALLOW_ARM_MS` once both ends of the ops list have been in view. Documented in `docs/architecture/assistant.md` and `docs/troubleshooting.md`.
