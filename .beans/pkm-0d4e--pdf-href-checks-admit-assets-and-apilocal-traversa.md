---
# pkm-0d4e
title: PDF href checks admit /assets/.. and /api/local/.. traversal
status: completed
type: bug
priority: normal
created_at: 2026-10-23T15:00:12Z
updated_at: 2026-10-23T18:24:55Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Adversarial review of pkm-tk9i (M2). `isPdfHref` and `isDeferredPdfHref` in web/src/components/InlineSegments.tsx are prefix tests, so `[x](/assets/../api/local/paper.pdf)` passes `isPdfHref` but not `isDeferredPdfHref`: the viewer auto-loads a local-docs file (possibly starting an iCloud download), the cost the deferral exists to avoid. Same-origin only; no external host. pkm-tk9i fixed the same shape in `isUploadedAsset` (externalMedia.ts) by refusing `..` segments, encoded slashes and backslashes; reuse that.

- [x] Red vitest for the traversal forms (`..`, `%2e%2e`, backslash)
- [x] Both checks refuse them (share the externalMedia.ts helper)


## Summary of Changes

- `externalMedia.ts`: new `isPathUnder(href, prefix)`, the one climb test; `isUploadedAsset` is `isPathUnder(src, "/assets/")`. It drops tab/CR/LF and trailing controls/spaces, cuts the query and fragment, splits on `/`, `\`, `%2f` and `%5c`, and refuses any `..` / `%2e` dot-dot segment.
- Rule change from the earlier fix: a backslash or `%5c` with no dot-dot segment no longer refuses. The blanket refusal would have demoted legitimate uploaded PDFs to links: an upload name is quoted with no safe chars, so its backslash arrives as `%5C`, and that upload serves (`assets.props.test.ts` fails under the old rule). A raw backslash, or `%5C` in a local href, serves nothing (the browser rewrites the raw one to `/`; uvicorn decodes `%5C` and `clean_relative` refuses the backslash); those stay admitted only because they stay under the prefix. Every climb under any of those separators is still refused, and `..?x`, `..#x` and `.. ` (trailing space) are now refused too.
- `InlineSegments.tsx`: `isPdfHref` requires `isUploadedAsset` or `isPathUnder(…, "/api/local/")`, so a climbing href is a plain link; `isDeferredPdfHref` is `!isUploadedAsset` (fails closed: only uploads auto-load).
- Other prefix tests checked: `PdfEmbed` `LOCAL_PREFIX` (click-only download probe, and only receives hrefs `isPdfHref` admitted), `tokenize.ts` `ASSET_LINK_RE` -> `AssetLink` (click-only), `localLinksParity.test.ts` (test). None decides auto-loading.
- Docs: frontend-rendering.md PDF table and link-safety rule; troubleshooting row.
