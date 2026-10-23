# Security small fixes (pkm-0ve4, pkm-6fqw, pkm-h1em) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three independent Low findings from the 2026-10-23 security
review that need no product decision: export filenames that collide on
APFS, forgeable access-log lines with an unbounded diagnostics log line,
and MCP read tools that follow `../` in a title to another route.

**Architecture:** Three disjoint tasks, each red test first. Findings and
reproductions: `docs/security-review-2026-10-23.md`. Probes (gitignored,
main checkout only; read by absolute path, never copy into the repo):
`PROBES=/Users/arthur/code/llm/pkm/docs/superpowers/handoffs/security-review-2026-10-23-probes`.

**Spec:** beans pkm-0ve4, pkm-6fqw, pkm-h1em (`beans show <id>`).

## Global constraints

- **Red first.** Each task starts with a test that fails on the current
  code *for the reason the finding states*; record the failing output in
  the report before changing product code.
- **Guard tests already exist** for nearby behaviour (security guard tests,
  merged before this branch): export arcname rules in
  `test_export_routes.py` / `export_hostile.py`, the route walk in
  `test_auth.py`, hostile requests in `test_hostile_requests.py`. They must
  stay green, unmodified unless the task says so.
- FCIS: keep the pure logic in Functional Core files (each file's
  `# pattern:` header says which it is).
- Comment rules (AGENTS.md § FCIS): no bean ids, no line numbers, comment
  lines ≤ 80 columns, code ≤ 120. Never write "load-bearing".
- Docs, same task: one row per fix in `docs/troubleshooting.md` (symptom,
  cause, owning section, bean id), and the sentence stating the rule in the
  owning `docs/architecture/` section if a rule changed. Do not edit
  `docs/SECURITY.md`.
- Gates from `server/`: `uv run pytest -q`, `uv run pyrefly check`,
  `uv run ruff check`; from the repo root
  `PYTHONPATH=server/tooling python3 -m commentlint.run --all`. No custom
  `-m`. If a docstring of a route changes, regenerate
  `web/src/api/openapi.json` per `docs/architecture/backend.md`
  § Generated artifacts.
- Check off the bean's checklist items as you finish them (`beans update`)
  and commit the bean file with the code.

## Task 1: Export filenames dedupe as APFS does (pkm-0ve4)

Files: `server/src/pkm/export/markdown.py` (`page_filename`),
`server/src/pkm/assets_core.py` (the arcname dedupe that uses
`arc.lower()`), their tests (`test_export_writer.py`,
`test_export_markdown.py`, `test_assets_core.py` or `test_asset_export.py`).

1. Red: with pages titled `café` (NFC), `café` (NFD), `Straße`, `STRASSE`,
   `ς`, `σ`, `ﬀ`, `ff` (from `$PROBES/sec-exports/p2_zip.py`), the
   whole-graph export (`export_graph` into a tmp dir on this machine's
   APFS, or `GET /api/export.zip`) contains every page's body. Today four
   are lost. Same for the selected-asset zip with filenames `Straße.txt`
   and `STRASSE.txt` plus an NFC/NFD pair: every asset present under a
   distinct arcname.
2. Fix: one pure helper (Functional Core, e.g. in `pkm/filenames.py` if it
   owns filename rules; check first) giving the dedupe key
   `unicodedata.normalize("NFD", unicodedata.normalize("NFD", name).casefold())`,
   used by both `page_filename` and the asset arcname dedupe in place of
   `.lower()`. Update both docstrings ("case-insensitively" -> "as APFS
   compares names: Unicode-normalised and case-folded").
3. A test that the key is at least as strict as the real filesystem: for
   each pair above plus `K`/`K` and `ǅ`/`ǆ`, write both names into one
   tmp dir; whenever the filesystem ends up with one file, the keys must
   be equal. (Over-merging only adds a "(2)" suffix; under-merging loses a
   page.)
4. Accepted consequence, say it in the commit message: some export
   filenames change (a page that collided now gets " (2)"), which shows as
   a rename in the nightly backup's git history.
5. Do not touch the arcname-safety rules the guard tests pin.

## Task 2: Access-log lines escape control characters; diagnostics log line bounded (pkm-6fqw)

Files: `server/src/pkm/server/logfmt.py` (`request_line`),
`server/src/pkm/server/routes_sync.py` (`client_diagnostics`), tests in
`test_request_log.py` and `test_hostile_requests.py` (beside
`test_diagnostics_normalise_nested_strings`).

1. Red (access log): an anonymous request to
   `/api/local/probe%0aFORGED%20LOG%20ENTRY%1b%5b31m` (exact raw path; see
   `tests/hostile.py` / `asgi_harness.py` for raw-path requests) produces a
   `pkm.access` record containing a literal newline and ESC. Assert the
   record's message has no character < 0x20 or 0x7f..0x9f and that the
   path's control characters appear escaped.
2. Fix (access log): `request_line` escapes every C0/C1 control character
   and DEL in `path` (and `method`, `client`), as `\xNN` (or `\uNNNN` above
   0xff is not needed: only controls). Backslash itself becomes `\\` so an
   escaped line cannot be confused with a literal `\x0a`. Pure function;
   test it directly too.
3. Red (diagnostics): an authenticated `POST /api/client/diagnostics`
   whose `report` holds a 2 MiB string answers 200 and logs a line of over
   2 MiB.
4. Fix (diagnostics), the bound chosen for this plan: keep answering 200
   (the report is evidence a replica sends just before destroying its
   database, so refusing it loses the evidence), and cap the logged JSON at
   `_MAX_DIAGNOSTICS_LOG_CHARS = 64 * 1024` characters. A longer dump is cut
   at the cap and followed by the marker
   `…[truncated: <total> chars]`. A module constant in `routes_sync.py`
   with a one-line comment saying why truncation and not 413. Request-body
   memory before auth is pkm-u8uh's job, not this task's.
5. Tests: the 2 MiB report logs a line of at most cap + marker length,
   ending with the marker naming the total; a small report logs unchanged
   (existing test stays green).

## Task 3: MCP title paths stay under /api/page/ (pkm-h1em)

Files: `server/src/pkm/client/api.py` (`get_page`, `rename_page`: both
build `/api/page/{quote(ref_title, safe='/')}`), tests in
`test_client_api.py` (and `test_mcp_server.py` if the tool layer needs
one).

1. Red: with an `httpx` `MockTransport` recording request URLs (see how
   `test_client_api.py` builds clients), `PkmClient.get_page` with titles
   `../sync/snapshot`, `..`, `.`, `a/../../healthz` requests a path that is
   not under `/api/page/`. Also `rename_page("../x", ...)`. Read
   `$PROBES/sec-assistant/probe_upload.py` (read-tool traversal section)
   and its `report.md` for the observed URLs.
2. Fix: one helper that builds the page path from a title so httpx cannot
   normalise it out of `/api/page/`: `quote(title, safe="")` and then
   encode `.` as `%2E` (a title of exactly `.` or `..` would otherwise
   still be a dot segment). Both call sites use it.
3. Must keep working: namespaced titles with `/` (e.g. `Paper/Measuring AI
   Ability`) and titles with spaces, `%`, `?`, `#`, unicode. Prove it
   end-to-end against the real app in-process (the `client` fixture app
   via an ASGI transport, as other `PkmClient` tests do): create pages
   titled `Paper/Measuring`, `a.b`, `100% done?`, `..x`, and `get_page`
   returns each; `rename_page` renames a namespaced one.
4. Test: for each traversal title, every request the client sends has a
   path starting `/api/page/` (assert on the transport's recorded raw
   path, after httpx's own normalisation).
