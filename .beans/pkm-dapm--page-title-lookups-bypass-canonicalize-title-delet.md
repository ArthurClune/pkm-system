---
# pkm-dapm
title: 'Page title lookups bypass canonicalize_title: delete, rename, todos/changed filter, query operands, sidebar add'
status: completed
type: bug
priority: high
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T08:52:43Z
parent: pkm-7uxw
---

Several server routes look a page up by the title as it arrives (URL path, query param, query operand, request body) without the canonicalisation every other title lookup uses. The result is a 404, or an empty result with no error, for a page that exists. Prod has `plain_space_title_canonicalization = 1` (checked 2026-10-01), so the padded-title cases are reachable there.

Paths below are relative to `server/src/pkm/` and `web/src/`.

## Findings

1. **Delete page 404s (live).** `delete_page` calls `fetch_page(db, title)` on the raw path title, without `_read_title` (`server/routes_pages.py:266-271`). `get_page` canonicalises it (`:220`). The web sends `titleFromPathname(pathname)` (`components/TopBar.tsx:25,55`); `replica/localApi` serves no DELETE, so the request reaches the server. Link hrefs carry the *normalized* title (`grammar/tokenize.ts:97`), so `[[ Foo ]]` opens `/page/%20Foo%20` and the page shows "Foo", but Delete page returns 404. A hand-typed URL containing `%0A` behaves the same.
2. **Rename 404s from the CLI.** `rename_page` uses the raw path title (`server/routes_pages.py:304`). The web is safe: it sends the stored title (`views/PageView.tsx:42` → `components/PageTitle.tsx:25`). The CLI applies only `normalize_title` (`client/api.py:292`), so a padded old title 404s. The `new_title == title` check at `:306` is fine once the lookup matches.
3. **todos/changed filter returns nothing.** The `page` filter in `/api/todos` and `/api/changed` never canonicalises (`server/routes_search.py:102-104,134-136`). Only the CLI and MCP call these routes (`client/api.py:271-282`, `mcp/server.py:74,79`), and the client doesn't normalise either, unlike `get_page` (`client/api.py:148`).
4. **Query operands miss.** In `{{query: [[X]]}}` the operand titles go to `p.title = ?` as raw slices (`server/query.py:86`, `:108-123`, `_PAGE_SQL` `:89-90`). The same `[[ Foo ]]` resolves as a link (`store.get_or_create_page` canonicalises, `server/store.py:56`) but matches nothing as an operand.
5. **Sidebar add stores a fifth title form.** `routes_sidebar.py:37` stores `str.strip()`, and the web trims too (`components/SidebarNav.tsx:71` `.trim()`). Entries join to pages by equality (`server/store.py:134,237-242`). `strip()`/`trim()` remove all Unicode whitespace unconditionally, while `canonicalize_title` collapses control whitespace and strips only edge U+0020, gated by the flag. An NBSP-edged title therefore gets a sidebar entry that names no page, and the entry doesn't follow the page through rename or delete.

## Plan

- [x] Failing test per route first: delete, rename (CLI-shaped padded title), todos `page`, changed `page`, query operand, sidebar add with an NBSP edge
- [x] `delete_page` and `rename_page` go through `_read_title`
- [x] todos/changed `page` filter canonicalises
- [x] query operand titles canonicalise before `_PAGE_SQL`
- [x] sidebar add uses `canonicalize_title` (server), and the web stops pre-trimming differently
- [x] CLI client normalises the `todos`/`changed` page argument, like `get_page`
- [x] Row in `docs/troubleshooting.md` (symptom: delete/filter/query 404s or empties for a padded title)
- [x] Note the invariant ("every title used as a key goes through canonicalize_title") where `backend.md` covers titles

## Summary of Changes

- `sync_meta.read_title` (and `title_reader`, which reads the flag once per request) is the one way a title arriving as a lookup key is canonicalised. It replaced `routes_pages._read_title` and the copy in the export route.
- `delete_page` and `rename_page` canonicalise the path title; the todos/changed `page` filter canonicalises.
- `{{query}}` operands canonicalise through `query_exec.parse_canonical_query`, used by both `/api/query` and the resolved Markdown export; the export wasn't in the original findings and turned up in review. `QueryPayload.ref_counts` is now keyed by the canonical title; only the CLI/MCP renderer reads it.
- `POST /api/sidebar` canonicalises and checks blankness with `is_blank_title` instead of `str.strip()`; the web form sends its input untrimmed. On a flag-off database, a padded title typed into the sidebar now keeps its padding, the same as a link would.
- The CLI client normalises the todos/changed `page` argument.
- Docs: the backend.md Title integrity invariant, module map entries, import-export query path, and a troubleshooting row.
- perf: query/and-not statements 4 -> 5 (the single flag read the fix needs), accepted by Arthur and re-baselined with `--bootstrap`.
