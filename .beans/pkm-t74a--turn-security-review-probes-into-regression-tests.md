---
# pkm-t74a
title: Turn security-review probes into regression tests
status: completed
type: task
priority: high
created_at: 2026-10-23T11:00:14Z
updated_at: 2026-10-23T12:10:07Z
parent: pkm-mfd0
---

The second review pass's probe scripts are in /Users/arthur/code/llm/pkm/docs/superpowers/handoffs/security-review-2026-10-23-probes (gitignored, this machine; README.md there maps every probe to its finding, kind and bean; each report.md has exact inputs). Probes print rather than assert. This bean reviews every probe and owns the ones that guard behaviour that held; probes that reproduce a finding are the red test of their fix bean, which says so.

Review each probe critically before converting: confirm it exercises the real code path (not a copy, e.g. the TSX slice copied into probe_preview), that the assertion would fail if the guarded behaviour broke (break it once, see it fail), and that the test sits on the right side (pytest in server/tests/, vitest beside web code). Prefer extending an existing suite (test_hostile_requests.py, test_auth.py, the export and assistant tests) over a new file.

Guards to convert now (passing tests):
- [x] Anonymous route-table walk: 401 on every private method/route, 4401 on /api/ws, public routes stay public (build fresh; first-pass probe not kept). This is SECURITY.md hardening priority 2's contract test
- [x] Content-Disposition for hostile titles stays printable ASCII, no injected header (sec-exports/p1_disposition.py)
- [x] Export arcnames never carry '..', a leading '/', backslash, drive letter or control char (sec-exports/p2_zip.py, guard half)
- [x] parse_sha256 rejects non-canonical digests; DELETE/serve with traversal shapes 404 and leave the DB intact; asset search LIKE/FTS literal (sec-exports/p3_assets.py)
- [x] SPA catch-all never serves outside web_dist: encoded traversal, prefix-sibling dir, outward symlink (sec-exports/p4_spa.py)
- [x] Export temp dirs removed on send error and client disconnect (sec-exports/p6_cleanup.py); check existing coverage first
- [x] Export page odd paths: anon 401, no 500 (sec-exports/p8_titles.py)
- [x] Resolver terminates ((ref))/query cycles (sec-exports/p9_cycle_copy.py)
- [x] /api/ops refuses deeply nested [[ (sec-pages/p5_brackets.py)
- [x] /api/changed and /api/current-work extremes never 500; limit clamps (sec-pages/p6_misc.py)
- [x] In-scope GET routes leave the DB unchanged apart from today's daily (sec-pages/p7_getwrite_and_size.py)
- [x] Confirm binding: replayed, unknown and late confirms are no-ops; each decision binds to its own id; unknown tools denied (sec-assistant/probe_confirm.py); check existing assistant tests first
- [x] Every JSON-model route refuses text/plain, form and missing content types with 422 (sec-cross/probe_csrf.py, guard half)

- [x] Confirm each red probe is named in its fix bean (pkm-0ve4, pkm-qd81, pkm-ak4e, pkm-1zdg, pkm-i9pg, pkm-h1em, pkm-d8vp, pkm-u1jk, pkm-u8uh) and that the first-pass findings' fix beans (pkm-tk9i, pkm-6fqw) say to rebuild their probe from the review doc
- [x] Probes of kind 'none' (timing, real CLI, audits, headers): note in the README whether any belongs in perf/ or a slow test instead
- [x] Copy anything still needed into the fix beans (deleting the probe directory
  moved to pkm-e95y: the red probes are still unused)

## Summary of Changes

Guard tests (tests only, no product change) for every behaviour the review found holding: Content-Disposition and zip arcnames for hostile titles, parse_sha256 and asset DELETE/serve traversal shapes, asset search literals, SPA containment (encoded traversal, prefix sibling, outward symlink), export temp-dir cleanup on send error and disconnect, export odd paths, ((ref))/query cycles, deep [[ refused by /api/ops, /api/changed and current-work extremes, read-only GETs (DB digest), assistant confirm binding and unknown-tool denial, an anonymous walk of every route kind (HTTP, WebSocket incl. a hung handler, the SPA and app-assets mount) and a logged-in content-type walk of every JSON-body route. Each guard was mutation-checked in an isolated copy. Red probes are named in their fix beans; notes for pkm-u8uh and pkm-u1jk say which guards their fixes must adjust. Fact-finding recorded in pkm-i9pg (the CLI repairs string-encoded arrays) and pkm-0ve4 (no page lost in retained backups).
