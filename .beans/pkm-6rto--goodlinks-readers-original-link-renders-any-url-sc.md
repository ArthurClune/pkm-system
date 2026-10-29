---
# pkm-6rto
title: GoodLinks reader's original link renders any URL scheme
status: completed
type: bug
priority: low
created_at: 2026-10-27T10:53:09Z
updated_at: 2026-10-29T17:00:01Z
parent: pkm-mfd0
---

From the SECURITY.md review (2026-10-27, finding M8). GoodlinksReader.tsx renders <a href={article.url}> ("original") straight from GoodLinks' answer with no scheme check; React 18 renders javascript: hrefs. Markdown links go through isSafeHref; this one does not. Low likelihood (GoodLinks would have to hold such a URL), trivial fix.

- [x] Red unit test: a javascript: article.url renders no live href
- [x] Route the href through isSafeHref (or render the URL as text when unsafe)
- [x] SECURITY.md: widen 'rendered links reject javascript:' back to every link
- [x] troubleshooting.md row



## Summary of Changes

The reader checks the original link with `isSafeHref` and renders an unsafe URL as plain text in a span that wraps instead of overflowing the bar. `isSafeHref` moved from InlineSegments to `externalMedia.ts`, which removed an import cycle. Pinned by GoodlinksReader tests (javascript:, mixed case, leading space, protocol-relative) and direct accept/reject cases in `externalMedia.test.ts`. Docs: SECURITY.md link rule widened back to every link, a files-and-assets.md sentence, a troubleshooting row. Rulings: the T1 minors (import cycle, span overflow) were carried into the final fix wave and addressed.
