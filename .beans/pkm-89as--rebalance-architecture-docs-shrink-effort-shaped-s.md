---
# pkm-89as
title: 'Rebalance architecture docs: shrink effort-shaped sections, fix flow, fold ship notes into owners'
status: completed
type: task
priority: normal
created_at: 2026-08-05T08:25:32Z
updated_at: 2026-08-05T09:20:31Z
---

Follow-up to the pkm-3f83 review. Ranked fixes, largest payoff first. Each is independent; do them in separate small branches if picked up.

## backend.md
- [x] Shrink the Importer section (124 lines, the largest in the directory, for a run-once re-runnable tool). Keep: pipeline diagram, preflight refusals, why mermaid preservation exists, atomic swap. Move the two-pass orphan-root algorithm, report-dedup semantics and temp-file staging detail to the tests/beans that pin them.
- [x] Compress the Title integrity cluster (149 lines across five sections; heavier than the write path). Blank-titles/blank-refs subsections walk defensive cases the tests already pin.
- [x] Compress the LoginThrottle exposition (~30 lines): keep "the 2s acquire timeout, not per-source backoff, is the real defence" and "behind tailscale serve all clients share one bucket"; drop the step-by-step starvation analysis.
- [x] Delete "Why extract() is O(n) per call" as a section; its content is the pkm-7myl symptom row plus one sentence on lstrip-before-regex wherever refs.py is introduced.
- [x] Dedupe asset repair verification (told in both Importer and Markdown export; asset_needs_repair owns it once).
- [x] Reorder the back half: Generated artifacts up (high value, currently buried), Importer late, Title integrity adjacent to the write path; rehome the orphaned "Daily pages are special" paragraph at the end of Configuration.
- [x] Ops enum in a sentence (create/update_text/...): table or link.

## frontend.md
- [x] Styling+focus is 219 lines (more than The editor). Move the incident material (off-screen drawer, heading-onClick, accname collision) to symptom rows; keep each current invariant to a sentence or two.
- [x] The tail of The editor is four unrelated bolded ship notes (stamp cell, menu label flip, nowrap, set_collapsed). Fold nowrap + menu-label into Styling, stamp cell into layout/styling, keep set_collapsed near the edit paths.
- [x] Move the PdfViewer generation-race paragraph out of "The /files browser" (PdfViewer belongs to the rendering pipeline).
- [x] Bold-lead count 35 — thin during the above.

## cli-and-mcp.md
- [x] Move "The MCP tool surface" to the top as orientation; make the eleven-tool enumeration a table (stale-count risk).
- [x] Split "Writes, uids and missing pages" (65-line grab-bag of six mechanisms with different risk profiles).
- [x] Add the doc's first "When something looks wrong" rows: section-spec marker-stripping incident, heading round-trip demotion gap, leading-dash uid addressing.
- [x] Compress the backlinks-pagination paragraph to the invariant (complete list or raise; restart bounded) and consider a small diagram.

## sync-and-offline.md (light)
- [x] Move "Title activation across online and offline paths" out of the core edit-path narrative (it splits the changes feed from post-commit nudges); it sits naturally near Rebootstrap triggers, which it is coupled to via generation rotation.

## assistant-and-files.md
- [x] Add the missing sequence diagram: one confirmed-write turn, browser -> SSE -> harness -> pkm-mcp -> API, confirm round-trip included. Let it replace the prose it covers.
- [x] Compress "Admission is serialized" + the transactional-startup bullet: state the invariants (bounded lock hold; startup failure and teardown share close(); config unlink in finally) and drop the timing arithmetic and case walks; the fake-engine tests pin them.

## overview.md
- [x] Healthy; no action.

## Summary of Changes

Applied on branch docs-rebalance-emphasis, one commit per doc, all restructuring with no claim changes. Every doc passes check-docs.mjs (all links/anchors/mermaid ok, no NEW 40+-word sentences). Directory went 3003 -> 2858 lines with a diagram and three tables added.

Deviations from the plan above: (1) "Writes, uids and missing pages" was compressed under its existing heading rather than split -- backend.md links to that anchor, and the compression (65 -> ~40 lines, one paragraph per mechanism) removed the flatness the split was for. (2) The backlinks paragraph kept prose, no diagram -- at four sentences it no longer earns one. (3) frontend bold-leads went 35 -> ~29 via the moves/rewrites, not a dedicated de-bolding pass; several remaining bolds are definition-list labels the updated skill now exempts.

## Round 2 (Arthur's branch review)

- [x] frontend module map rewritten in backend.md's aligned tree style — name/pattern/role columns, directories spread across sub-lines, every pattern verified against the file's declared FCIS header (outline/dnd.ts was absent from the old map), keyboard chords removed from the map
- [x] styling split out to docs/architecture/styling.md (tokens/theming, control families, confirmations, focus invariants, its own symptom table with the two pkm-cq32 rows); frontend.md keeps a stub; overview.md table and CLAUDE.md list + styling trigger updated
