---
# pkm-apr7
title: 'jsdom ''Not implemented: navigation'' noise in PdfViewer unit tests'
status: todo
type: task
priority: low
created_at: 2026-08-04T09:54:53Z
updated_at: 2026-08-04T09:54:53Z
---

`pnpm test:unit` logs two of these, attributed to the wrong test:

```
stderr | src/components/PdfViewer.test.tsx > falls back to the download link when the document fails to load
Error: Not implemented: navigation (except hash changes)
```

Cosmetic, but it trains the eye to ignore jsdom navigation warnings -- which are worth reading, since an unprevented click leaking into a later test is a real flake source.

## What's actually happening

The warnings do not come from the test they're printed against. `PdfViewer.test.tsx`'s interactive-island test (the one asserting a Download anchor click doesn't bubble into edit mode) does `fireEvent.click` on two real anchors -- `getByRole("link", { name: "Notes" })` and `{ name: "Download" }`. Neither click is prevented, which is correct: a download link should do its native thing. jsdom then attempts a real navigation on a timer, and the warning lands on whatever test is running by then -- the next one in the file. Two clicks, two warnings.

Same root cause as the noise avoided in pkm-10ah's App test, where reading `defaultPrevented` from a document-level listener and then calling `preventDefault()` there kept jsdom quiet while still asserting the app hadn't prevented it.

## Options

- [ ] Decide the approach: swallow the default in a document-level listener for the two clicks (keeps the island assertions exactly as they are), or point the anchors at a `#`-fragment href in the fixture so jsdom treats it as a hash change
- [ ] Apply it, and confirm `pnpm test:unit 2>&1 | grep -c "Not implemented: navigation"` reports 0
- [ ] Consider whether a stray-warning guard is worth having (e.g. failing the run on unexpected jsdom "Not implemented" output) so the next one can't accumulate silently
