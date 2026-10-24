# Refuse a single-page export that expands too large

## Intent

`GET /api/export/page/{title}` expands `((refs))` up to three levels and
`{{query: ...}}` macros up to two, so output grows as K³ in the number of
refs per block. Four blocks of ~11 KB export as 279 MB and push the server
from 100 MiB to 1.4 GiB RSS (probe `sec-exports/p5_amplify.py`). Real pages
never come close: the largest of the 4,497 pages in production exports at
278 KB, p99 14 KB.

Arthur's decision: past a bound, **refuse** the export. No truncation, no
partial expansion; the user fixes the page. The refusal says only that the
page is too large to export. It does not name a block.

## Behaviour

- Bound: `EXPORT_MAX_CHARS = 10_000_000` characters of resolved body
  (≈ 10 MB for ASCII; 36× the largest real export).
- Past the bound the route answers **422** with a string `detail`, e.g.
  `"page too large to export: over 10 million characters once block refs
  and queries are expanded"`. Never a 500 and never a partial body.
- The bound is charged **while expanding**, at every level of
  `resolve_text` and in `render_query_result`, not checked on the finished
  body: nested expansions are built bottom-up, so a check at the top still
  builds the K² intermediate strings. The invariant: no string longer than
  a small multiple of the bound is ever built, and the peak memory of a
  refused export stays a small multiple of the bound.
- An export whose body is under the bound comes out byte-identical to
  today.
- Web: "Export as Markdown" stops being a plain `<a download>` (a refused
  download shows the user nothing). It fetches the export and saves the
  blob under the server's `Content-Disposition` filename. A failure,
  including the refusal and being offline, shows in TopBar's existing
  dismissible error line (`deleteError`'s `.error` paragraph), e.g.
  `Couldn't export "<title>": page too large to export: …`.

## Non-goals

- `GET /api/export.zip` and the nightly backup: one-level ref resolution,
  no amplification. Unchanged.
- The size of a query's own result set (bounded by the database, fetched
  once per expression). Its *rendering* is charged against the bound.
- Near-cap UX. If a real page ever hits the bound, lower or raise it then.

## Approaches

1. **(chosen)** A budget charged inside `pkm.export.resolve` as text is
   appended, raising a Core exception (`ExportTooLarge`) that the route
   turns into the 422. Stops the work at the bound.
2. Check `len(body)` after rendering. Rejected: the 279 MB is already built.
3. Lower the depth caps. Rejected: they mirror the live UI's
   (`BlockRef.tsx`, `QueryBlock.tsx`) so the export reads like the page,
   and K³ at depth 3 still explodes for a large K.

Web side, the only alternative to fetch + blob is keeping the link, which
cannot show a reason. So there was nothing to choose.

## Calls left to the builder (marked as Claude's)

- 422 rather than 400 or 413: the request is well formed, and 413 is
  about request bodies.
- Characters, not UTF-8 bytes: `len()` is free and the margin is wide.
- How the charge is counted (literal slices plus added indentation and
  headers, or every appended piece at each level), provided the invariant
  above holds. A test proves it with the probe's shape at a scale that
  would be far past the bound uncharged, and a lowered bound.
- Fetch helper: whether the blob fetch is a new function in
  `web/src/api/client.ts` beside `apiFetch` (sharing its 401 handling and
  `readErrorDetail`) or inline in TopBar. The route stays out of the
  offline shim.
- Verify the blob download on the iPad PWA (`ipad-simulator` skill), since
  that is where plain navigation was the known-good path.
