---
# pkm-8bga
title: Single-page export ((ref)) fan-out grows K^3
status: in-progress
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-24T15:24:48Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. 11 KB of blocks referencing each other export as 279 MB. Needs an output bound and what the user sees when it is hit (Arthur's call), then opus. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-exports/p5_amplify.py.

- [x] Arthur decides the user-visible result: refuse the export (2026-10-24)
- [x] Confirm with Arthur: the bound (10 MB proposed) and how the refusal reaches the user (see Decision below). Confirmed 2026-10-24: 10 MB; 'page too large' is enough, no block named. Spec: docs/superpowers/specs/2026-10-24-page-export-size-cap-design.md
- [ ] Web: fetch + blob download, refusal in TopBar's error line
- [ ] Docs: backend.md API row + hostile-input table, import-export-and-backup.md
- [ ] Verify on the iPad PWA
- [ ] Red test from the probe
- [ ] Fix
- [ ] troubleshooting.md row

## Decision (Arthur, 2026-10-24)

Refuse the export when it would exceed the bound; no truncation and no partial expansion. "User can fix the page."

Facts gathered (prod DB copy, all 4,497 pages): largest single-page export 278 KB ('Prompt Jailbreaking'), next 259 KB, p99 14 KB, median 315 B, no errors. Probe p5_amplify.py: four blocks (~11 KB) export as 279 MB and push RSS 100 MiB -> 1.4 GiB.

Still open (confirm with Arthur before the spec):
- The bound: 10 MB was proposed (36x the largest real export); Arthur has not confirmed the number.
- How the refusal reaches the user. The menu item is a plain <a href download> (TopBar.tsx 'Export as Markdown'), so an error status shows only as a failed download with no reason. For the user to fix the page, the web likely needs fetch + blob download with the refusal message in a notice. TopBar's comment says plain navigation was chosen to match PdfFallbackLink.

Design notes (not decided):
- Charge the budget inside pkm.export.resolve.resolve_text at every expansion level (and render_query_result), not on the finished body: nested expansions are built bottom-up, so a check at the top still builds the K^2 intermediate strings.
- Query macro results are uncapped and re-expanded at depth+1; the budget covers them too.
- The route answers a 4xx with a message naming the limit (hostile-request rule: never 500). 413 is meant for request bodies; 422 or 400 with a reason are the alternatives.
