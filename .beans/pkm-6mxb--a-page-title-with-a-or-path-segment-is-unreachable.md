---
# pkm-6mxb
title: A page title with a . or .. path segment is unreachable by URL
status: todo
type: bug
priority: normal
created_at: 2026-10-21T16:21:16Z
updated_at: 2026-10-21T16:43:52Z
parent: pkm-a1xk
---

Found by the title-routes property (pkm-u4rw). A title such as `.`, `..`, `a/./b` or `a/../b` is sent as /api/page/<segments> with the slashes kept literal (client.api quote(safe='/'), web paths.encodePathSegments). URL clients remove dot segments (httpx and the WHATWG parser, which also treats %2e as a dot), so GET /api/page/. becomes /api/page/ (a 307 redirect) and /api/page/a/../b reads page b. The same holds for the export and rename routes and the SPA's /page/ route.

Needs a decision: refuse such titles in title_syntax_reason (and the replica's titleSyntaxReason, with the title migration audit), or address pages by a query parameter or a fully encoded single segment instead of a path. Check the prod DB for existing titles with a dot segment first.

The web has a sibling: a title with an empty segment (`/x`, `a//b`) loses it when the SPA navigates: a <Navigate> to pagePath('/ a') (`/page//%20a`) opened ` a` in the property run, react-router's path resolution collapsing `//`. Links probably do the same; check. The server routes keep `//`.

The properties in server/tests/test_title_routes_props.py and web/src/outline/titleKeys.props.test.tsx leave these titles out of their draws until this is settled; remove those carve-outs when fixing.

## Checklist
- [ ] Decide: refuse the titles, or change how routes carry a title
- [ ] Fix and drop the carve-outs in both properties
