---
# pkm-6mxb
title: A page title with a . or .. path segment is unreachable by URL
status: completed
type: bug
priority: normal
created_at: 2026-10-21T16:21:16Z
updated_at: 2026-10-21T20:44:06Z
parent: pkm-a1xk
---

Found by the title-routes property (pkm-u4rw). A title such as `.`, `..`, `a/./b` or `a/../b` is sent as /api/page/<segments> with the slashes kept literal (client.api quote(safe='/'), web paths.encodePathSegments). URL clients remove dot segments (httpx and the WHATWG parser, which also treats %2e as a dot), so GET /api/page/. becomes /api/page/ (a 307 redirect) and /api/page/a/../b reads page b. The same holds for the export and rename routes and the SPA's /page/ route.

Needs a decision: refuse such titles in title_syntax_reason (and the replica's titleSyntaxReason, with the title migration audit), or address pages by a query parameter or a fully encoded single segment instead of a path. Check the prod DB for existing titles with a dot segment first.

The web has a sibling: a title with an empty segment (`/x`, `a//b`) loses it when the SPA navigates: a <Navigate> to pagePath('/ a') (`/page//%20a`) opened ` a` in the property run, react-router's path resolution collapsing `//`. Links probably do the same; check. The server routes keep `//`.

The properties in server/tests/test_title_routes_props.py and web/src/outline/titleKeys.props.test.tsx leave these titles out of their draws until this is settled; remove those carve-outs when fixing.

## Checklist
- [x] Decide: refuse the titles, or change how routes carry a title
- [x] Fix and drop the carve-outs in both properties

## Ruling (Arthur, 2026-10-21)

Option B. A title with a `.`, `..` or empty `/` segment is refused as a page title everywhere: create, rename, move, sidebar, import, and as a `forbidden_syntax` blocker in the migration audit. In block text such a ref is no ref at all, as a blank `[[   ]]` is, so typing `#work/` on the way to `#work/notes` is never refused. Every title rule judges the title edge-stripped of U+0020 on both sides (this also fixes the padded ` a] ` ops 500). `...` stays allowed, and blank titles keep their own handling.

## Summary of Changes

- `refs.has_unreachable_segment` and the web's `hasUnreachableSegment` (`grammar/scan.ts`): an edge-stripped, non-blank title with a `.`, `..` or empty `/` segment.
- `title_syntax_reason` / `titleSyntaxReason` refuse such a title, and now judge every rule on the edge-stripped title (`target_canonical_title`). Under the plain-space flag, `POST /api/ops` creating ` a] ` or writing `[[ a] ]]` used to 500, because the ops check passed the padded spelling and the store refused `a]`; it is now a 400.
- `refs.extract` and the web's `extractRefs` drop a link, tag or attribute whose title has such a segment.
- `POST /api/sidebar` now refuses a forbidden title (422), as creation and rename already did.
- Fixtures:
  - `title_syntax.json` gained 14 rows: dot, empty and padded segments, plus `...`, `a.b`, `v1.2/x`, `Acme / Notes` and blank as allowed.
  - `ref_grammar.json` gained 5 rows, which both parsers replay.
  - `title_parity.json` was regenerated with `/`, `.` and `..` pieces; 52 corpus titles have an unreachable segment.
  - `refs_parity.json` is unchanged.
- Both route properties now draw refused titles on purpose instead of carving them out:
  - Server: every route answers below 500, writes answer 4xx, and nothing is written. Refused titles are 15% of the route draws and 10% of the CLI draws.
  - Web: no editor is ever held under a refused title.
- `server/tests/test_unreachable_titles.py` checks that stored `.` and `''` pages read, sync and audit without a 500, and that they delete by URL. The audit reports `.` as a `forbidden_syntax` blocker; `''` is already its own canonical form, so the audit does not list it.
- Deleting a stored `.` page: `DELETE /api/page/%2E` works, because a URL client keeps the escape and Starlette decodes it to `.`. The CLI cannot reach it: `pkm get .` follows a 307 and `pkm rename .` gets a 405. `''` deletes with `DELETE /api/page/`. Both are covered by the test.
- Docs: a new backend.md § Refused titles table, which the conflict-header table, the migration audit text and sync-and-offline.md now link to; two troubleshooting rows.
