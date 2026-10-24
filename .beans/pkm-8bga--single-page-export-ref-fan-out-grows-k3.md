---
# pkm-8bga
title: Single-page export ((ref)) fan-out grows K^3
status: completed
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-24T17:43:17Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. 11 KB of blocks referencing each other export as 279 MB. Needs an output bound and what the user sees when it is hit (Arthur's call), then opus. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-exports/p5_amplify.py.

- [x] Arthur decides the user-visible result: refuse the export (2026-10-24)
- [x] Confirm with Arthur: the bound (10 MB proposed) and how the refusal reaches the user (see Decision below). Confirmed 2026-10-24: 10 MB; 'page too large' is enough, no block named. Spec: docs/superpowers/specs/2026-10-24-page-export-size-cap-design.md
- [x] Web: fetch + blob download, refusal in TopBar's error line
- [x] Docs: backend.md API row + hostile-input table, import-export-and-backup.md
- [x] Verify on the iPad PWA (simulator, Safari tab: blob + download link built, no errors; the save itself is not observable)
- [x] Red test from the probe
- [x] Fix
- [x] troubleshooting.md row

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

## Summary of Changes

- `pkm.export.resolve` charges a budget while expanding, never on the finished body:
  - characters, with the count exactly equal to `len(body)` and `EXPORT_MAX_CHARS` = 10M;
  - expansion work: one unit per call plus one per `SCAN_CHARS_PER_UNIT` scanned characters, with `max_chars // CHARS_PER_CALL` units allowed.
- Past either bound, `ExportTooLarge` is raised and the route answers 422 with that bound's message. A refused export peaks near 1-2x the bound in memory, whatever K is. Line indents are added with `str.replace`, so a refusal holds no object per line.
- Two scanners that were quadratic are now linear: the check whether a ref sits inside a query (bisect), and `find_query_macros` (one forward pass with a stack of open prefixes; pkm-cs3f).
- Web: "Export as Markdown" fetches the page (`apiDownload`) and saves the blob under the server's filename, revoking the object URL after 60 s. A refusal, being offline or a network failure shows in TopBar's error line.
- Evidence:
  - Probe: 279 MB / 1.4 GiB RSS before; now a 422 in about 0.1 s.
  - Production copy: none of its 4,497 pages is refused. The highest use is 3,256 call units of 1M, and the largest body 277,934 characters of 10M.
  - iPad simulator: the normal export downloads; the refused one shows the error line.
  - Gates: perf shows no change; the server property gate passed.
- Follow-ups:
  - pkm-stny: the gather is unbounded.
  - pkm-0zi8: the web scanMacro is quadratic.
  - pkm-gc3n: block text length cap (draft; Arthur's call).
  - pkm-dhsp: import property finding, pre-existing.
