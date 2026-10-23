# Security guard tests (pkm-t74a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the security review's "guard" probes into passing regression
tests, so the fix beans that follow (auth, routes, export) cannot silently
break what already held.

**Architecture:** Tests only; no product change. Each probe under
`PROBES=/Users/arthur/code/llm/pkm/docs/superpowers/handoffs/security-review-2026-10-23-probes`
prints what it observed; each test asserts the observation that held.
`$PROBES/README.md` maps probes to kinds; `$PROBES/<folder>/report.md` holds
the reviewer's exact inputs and outputs. The probes are gitignored and live
only in the main checkout: read them by absolute path, never copy them into
the repo.

**Spec:** bean pkm-t74a (`beans show pkm-t74a`) and
`docs/security-review-2026-10-23.md`.

## Global constraints

- **No product code changes.** If a guard turns out NOT to hold (the test
  fails against current code), stop: do not fix it, do not weaken the test.
  Mark it `pytest.mark.xfail(strict=True, reason=...)` naming the finding,
  and report it as a concern.
- **Extend existing suites** over new files. Suggested homes are given per
  test; a new file only when no existing file owns the area.
- **Real code path.** Tests drive the app through the `client` /
  `anon_client` fixtures in `server/tests/conftest.py` (or
  `create_app` + TestClient as those fixtures do), or call the real
  function. Never copy product code into a test.
- **Every guard is mutation-checked.** For each test (or parametrised
  group), break the guarded product behaviour once by a minimal local edit,
  run the test, see it fail, revert. Record in the report: test name,
  file+function mutated, the mutation, and the failing assertion line. Never
  commit a mutation; `git diff -- server/src` must be empty at the end.
- **Use `hostile.py`/`asgi_harness.py`** when a request must reach the app
  with an exact raw path (TestClient re-decodes percent escapes); read them
  first.
- Comment rules (AGENTS.md § FCIS): no bean ids, no line numbers, comment
  lines ≤ 80 columns, code ≤ 120. Test docstrings say what is guarded and
  why, not which probe it came from.
- Gates, all from `server/`: `uv run pytest -q`, `uv run pyrefly check`,
  `uv run ruff check`. Do not use a custom `-m` (see AGENTS.md traps).

## Task 1: Export, asset and SPA guards

Probes: `$PROBES/sec-exports/` `p1_disposition.py`, `p2_zip.py` (guard half
only: arcnames), `p3_assets.py`, `p4_spa.py`, `p6_cleanup.py`,
`p8_titles.py`, `p9_cycle_copy.py` (cycle half only); `report.md` in that
folder has the observed outputs.

Tests to write (suggested homes in parentheses):

1. Content-Disposition for hostile titles (`test_export_routes.py`): for
   each title in p1's list, `attachment_disposition(page_filename(t, set()))`
   is printable ASCII (32..126) with no CR/LF; and via
   `GET /api/export/page/{quoted title}` for p1's four route titles the
   response has no `set-cookie` header and its content-disposition is
   printable ASCII.
2. Whole-graph zip arcnames (`test_export_routes.py`): with p2's titles and
   asset filenames seeded, every arcname in `GET /api/export.zip` has no
   `..` component (after `\`→`/`), no leading `/`, no backslash, no NUL, no
   `X:` drive prefix, no char < 32. Do NOT assert page counts: page loss is
   the red finding owned by pkm-0ve4.
3. Assets (`test_asset_export.py`, `test_asset_delete.py`,
   `test_asset_search_filters.py`): `parse_sha256` accepts exactly
   lowercase 64-hex and rejects p3's other cases (trailing newline, upper,
   63/65 chars, `../`, fullwidth, Arabic-Indic digits); anon
   `POST /api/assets/export.zip` is 401; assets export arcnames for p3's
   hostile filenames obey test 2's rules; `DELETE /api/assets/{p}` for p3's
   five shapes (send exact raw paths) is 404 and the DB file and every
   asset row are intact; asset search with `%`, `_`, `\` matches literally
   (seed names so a wildcard reading would over-match) and never 500s for
   p3's queries and params.
4. SPA catch-all (`test_spa.py`): build p4's fixture dist (outside file,
   prefix-sibling dir `distsecret`, outward symlink `link-out`, symlink
   loop) and assert no response body for p4's paths ever contains
   `SECRET-OUTSIDE` or `PREFIX-SIBLING`. Exclude the NUL / over-long paths
   that 500 today (`/a%00b`, `/sw.js%00`, very long components): those are
   red for pkm-qd81. Send exact raw paths.
5. Export temp-dir cleanup (`test_tempfile_response.py` or
   `test_export_routes.py`): read existing coverage first; add only what is
   missing. For `GET /api/export.zip` and `POST /api/assets/export.zip`,
   when ASGI `send` raises mid-body and when `receive` returns
   `http.disconnect` first, no `pkm-*` temp dir remains (point `TMPDIR` /
   `tempfile.tempdir` at a test tmp dir via monkeypatch).
6. Export page odd paths (`test_export_routes.py`): p8's paths are 401 for
   an anonymous client and never 500 for an authenticated one, except any
   that p8's report shows 500ing today (check the report; if one does, it is
   red for pkm-qd81: leave it out and say so). Anon `GET /api/export.zip` is
   401.
7. Resolver cycles (`test_export_resolve.py`): a page whose two blocks
   ((ref)) each other and each hold `{{query: [[Cyc]]}}` exports with 200
   within a bounded time (use a generous bound or rely on pytest's timeout
   if configured; check `pyproject.toml`).

## Task 2: Pages, route walk and content-type guards

Probes: `$PROBES/sec-pages/` `p5_brackets.py`, `p6_misc.py`,
`p7_getwrite_and_size.py` (with `harness.py`); `$PROBES/sec-cross/`
`probe_csrf.py` (guard half), `routes.py`; `report.md` in each folder.

Tests (home: `test_hostile_requests.py` unless noted):

1. `/api/ops` refuses a create whose text nests `[[` 990 and 2000 deep
   (4xx, not 2xx, not 500), and the page is not created.
2. `/api/changed` with p6's since/until extremes and `limit=INT64_MAX`,
   `/api/current-work` with `now_ms` in {INT64_MIN, INT64_MAX, 0, -1},
   `/api/page/AI` with p6's `bl_offset`/`bl_limit` extremes, and
   `/api/todos?page=\x00`: every status < 500. Where p6's report shows the
   limit is clamped, assert the clamp.
3. GET routes leave the DB unchanged (`test_page_endpoint.py` or
   here): DB dump digest (p6's `digest()` approach) is identical before and
   after p6's list of GETs. Separately, GET of today's daily page may create
   today's page and nothing else.
4. Anonymous route-table walk (`test_auth.py`; no probe kept, build
   fresh): iterate the app's routes (see `_api_routes` in
   `test_routes_models.py` for how the app's routes are enumerated); for
   every method/path not in the public set, an anonymous request (path
   params filled with a plausible value) gets 401. The public set is
   whatever the auth dependency exempts in the code (find it; name the
   symbol in a comment rather than copying a list where possible). Public
   routes must NOT 401. `/api/ws` without a cookie closes with 4401 (see
   `test_ws.py` for how WS is driven). The test must fail if a new private
   route is added without the auth dependency: prove it by registering a
   throwaway unauthenticated route on the app in the mutation check.
5. Every JSON-body route refuses `text/plain;charset=UTF-8`, no
   Content-Type, and `application/x-www-form-urlencoded` with 422 (do not
   assert the route's effect, assert the status and that no write landed).
   Enumerate JSON-body routes from the app (FastAPI route `body_field`),
   not a hand list, so a new route is covered. Routes that take no body,
   form or multipart are out of scope (they are pkm-u1jk's red finding).

## Task 3: Assistant confirm binding

Probe: `$PROBES/sec-assistant/probe_confirm.py`; `report.md` there. Read
`test_claude_engine.py` and `test_assistant_*.py` first: add only what is
missing, in `test_claude_engine.py`.

Guards: two concurrent `can_use_tool` calls each get a distinct confirm id;
`resolve_confirm` with an unknown id resolves neither; resolving B's id
allows B only (A still pending); replaying B's id leaves A pending; denying
A's id returns `PermissionResultDeny`; `can_use_tool` for a non-pkm tool and
for an unknown `mcp__pkm__` tool is denied without a card; `ops_preview` is
a string snapshot (mutating the input dict after the card is emitted does
not change the card). Late confirm (after the call resolved) is a no-op.

## Task 4 (main loop, not dispatched): bean bookkeeping

- Confirm each red probe is named in its fix bean; first-pass fix beans
  (pkm-tk9i, pkm-6fqw) say to rebuild their probe from the review doc.
- Note in `$PROBES/README.md` whether any kind-'none' probe belongs in
  `perf/` or a slow test.
- Copy anything still needed into fix beans; the probe directory goes only
  once every fix bean has used it.
