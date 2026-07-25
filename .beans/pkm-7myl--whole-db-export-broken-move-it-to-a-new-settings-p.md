---
# pkm-7myl
title: Whole-db export broken; move it to a new Settings page
status: completed
type: bug
priority: normal
created_at: 2026-07-25T12:02:10Z
updated_at: 2026-07-25T12:36:39Z
---

The 'Export whole database as Markdown (.zip)' link at the end of the Help page doesn't work in prod. Fix the download, add a Settings page (frontend route), link it in the left sidebar below the user-editable favourites, and move the whole-db export there (only item for now, more coming).

## Checklist

- [x] Investigate Part 1 (systematic debugging, root cause FIRST):
  - [x] Verify the PWA/workbox "prime suspect" against git history and the
        currently-deployed prod bundle -- `navigateFallbackDenylist`
        already includes `/^\/api/` (added 2026-07-13, well before
        pkm-uvqf shipped) in both this branch's `web/vite.config.ts` and
        the byte-compiled `~/.config/pkm/app/web/dist/sw.js` actually
        running in prod.
  - [x] Build the real SPA (`pnpm build`), serve it behind the real
        FastAPI app the same way the e2e harness does, register the SW
        in a Playwright context, confirm it's genuinely controlling the
        page (`navigator.serviceWorker.controller !== null`), then click
        `.help-export-link` for real. Result: a correct zip downloads
        with the correct `Content-Disposition` filename
        (`pkm-export-<today>.zip`) -- the SW/download-attribute theory is
        **disproved by repro**, not just by code inspection.
  - [x] Since the mechanism wasn't the SW, went looking for a real
        difference between the tiny pytest/e2e fixture DB and the actual
        prod graph: copied prod's own nightly backup snapshot into the
        session scratchpad (never touched the live DB) and ran
        `export_graph()` against it directly.
  - [x] Found it: `export_graph()` took **276s** against the real ~52.7k
        block / 4.3k page graph (zipping itself was 0.3s). `cProfile`
        pinned essentially all of it to one `re.Pattern.match` call site.
        Root cause: `pkm/refs.py`'s `_ATTRIBUTE` regex
        (`^\s*([^\[\]{}:\n]+?)::`) is O(n²) to *fail* against a long run
        of characters with no `::` in it, because the leading `\s*`
        (greedy) and the following negated class (lazy) both accept
        space characters -- every one of the run's n possible split
        points forces a full re-scan. `_strip_code()` blanks an entire
        fenced code block (newlines included) to spaces before this
        regex ever runs, so **a single large all-code block** (the
        real graph has one ~258KB pasted block) turns into exactly that
        pathological input. Measured: that one block alone took **224s**
        inside `extract()`; a few other large code blocks (44-46KB) cost
        multi-second hits too. `export_graph()` (whole-db export) and
        `routes_export.export_page_markdown` (per-page export) both call
        `extract()` once per block via `collect_block_ref_uids` --
        exactly why the *whole-db* export looked broken (worst case,
        summed over every pathological block) while the smaller per-page
        exports mostly didn't (unless a page happens to contain one such
        block itself).
- [x] Part 1 fix: rewrite `_ATTRIBUTE` matching so leading whitespace is
      stripped in Python (`str.lstrip()`, linear, no backtracking)
      *before* the regex runs, removing the ambiguous overlap; confirmed
      identical results on the shared `ref_grammar.json` fixture and the
      attribute-ordering test.
- [x] TDD: failing perf regression test first (RED: 132s for a 200KB
      adversarial block against the pre-fix regex, confirming the O(n²)
      diagnosis independently) then GREEN after the fix (whole
      `test_refs.py`, 17 tests, 0.34s).
- [x] Part 2: `/settings` route + `Settings.tsx` (plain growable list of
      sections, one today: "Export"); whole-db export link moved out of
      `Help.tsx` into it; "Settings" nav link added below `<SidebarNav>`
      in `App.tsx`'s left nav, styled as a plain (non-`primary`) nav-link.
- [x] Web unit tests updated/added first: `Settings.test.tsx` (new),
      `Help.test.tsx` (export section assertions replaced with an
      assertion that it's gone), `App.test.tsx` (nav-order + navigation).
- [x] Server: `cd server && uv run pytest -q` -- 620 passed, 95.34% cov.
- [x] Server: `uv run pyrefly check` -- 0 errors. `uv run ruff check` --
      clean.
- [x] Web: `E2E_PORT=8978 pnpm verify` (typecheck, lint, fcis, coverage,
      build, Playwright) -- fully green, no flakes this run (see Summary).
- [x] `docs/architecture/backend.md` updated: export UI-placement note
      (Settings, not Help) + a new note on the `extract()` perf fix.
- [x] Bean: checklist complete, Summary of Changes, status completed.

## Summary of Changes

**Root cause of "the whole-db export doesn't work" (confirmed by repro,
not the hypothesised PWA/service-worker cause):**

`pkm/refs.py`'s attribute-detection regex,
`_ATTRIBUTE = re.compile(r"^\s*([^\[\]{}:\n]+?)::")`, is O(n²) on any text
whose (code-fence-blanked) content is a long run of characters containing
no `::` -- the leading `\s*` (greedy) and the following negated character
class (lazy) both match plain spaces, so every one of the n possible
split points between them forces the lazy group to re-scan forward. A
block whose entire text is one large fenced code block collapses to
exactly this shape, because `_strip_code()` blanks fences to
same-length runs of spaces (newlines included). The real production graph
has one ~258KB pasted-code block; `extract()` alone took **224 seconds**
on it, and `export_graph()` -- which calls `extract()` once per block via
`collect_block_ref_uids`, for both the whole-db `.zip` export and the
per-page `.md` export -- took **276 seconds** end to end against a copy
of the real database. A browser `<a download>` click waiting that long
for a response is indistinguishable from "doesn't work". None of this
shows up against the tiny pytest/e2e fixture DB, which is why the route's
own test suite was green.

The PWA/workbox theory named in the bean as the prime suspect was
investigated first and disproved by repro, not assumed away:
`navigateFallbackDenylist` already includes `/^\/api/` in both this
branch's `vite.config.ts` (added 2026-07-13, well before pkm-uvqf) and
the byte-compiled `sw.js` actually deployed to prod; building the real
SPA, serving it behind the real server, registering the SW for real in a
Playwright context, and confirming it was genuinely controlling the page
before clicking `.help-export-link` produced a correct zip download with
the correct filename every time.

**Server**
- `server/src/pkm/refs.py`: `_ATTRIBUTE` no longer has a leading `\s*`;
  `extract()` strips leading whitespace itself
  (`_ATTRIBUTE.match(clean.lstrip())`) before the regex runs, which is
  linear and removes the pathological overlap. Behaviour for every
  legitimate case is unchanged (confirmed against
  `shared/fixtures/ref_grammar.json` and the attribute-ordering test) --
  only the failure-to-match path on pathological input changes from O(n²)
  to O(n).
- `server/tests/test_refs.py`: two new tests --
  `test_extract_is_linear_on_a_large_all_whitespace_run` (a 200KB fenced
  block must extract in well under the pre-fix ~132s it measured RED at)
  and `test_extract_attribute_still_recognised_after_leading_whitespace`
  (indented `Tags::` still parses as an attribute).

**Web**
- `web/src/views/Settings.tsx` (new): `/settings` view, a plain array of
  `{id, title, body}` sections rendered as `<section class="settings-section">`
  blocks so future settings are new array entries, not page rewrites. One
  section today, "Export", holding the whole-db export link moved from
  Help (`<a href="/api/export.zip" download>`).
- `web/src/views/Help.tsx`: the "Export" section removed entirely.
- `web/src/App.tsx`: new `/settings` route; a "Settings" `NavLink` added
  to `left-nav`, placed *after* `<SidebarNav>` (the user-editable
  favourites) and *not* given the `primary` class, so it reads as
  secondary the same way the favourites themselves do.
- `web/src/styles.css`: `.settings-page`/`.settings-section` rules mirror
  `.help-page`'s existing prose-width convention.
- `web/src/views/Settings.test.tsx` (new), `web/src/views/Help.test.tsx`
  (export-section-is-gone assertion replacing the old export-link
  assertion), `web/src/App.test.tsx` (nav-order + Settings-link
  navigation tests) -- written before the corresponding implementation.

**Docs**
- `docs/architecture/backend.md`: export UI-placement note now points at
  Settings instead of Help; new note under "Export and backup" describing
  the `extract()` O(n²)→O(n) fix and why it mattered for the whole-db
  export specifically.

**Verification**
- `cd server && uv run pytest -q` -- 620 passed, 95.34% coverage.
- `cd server && uv run pyrefly check` -- 0 errors.
- `cd server && uv run ruff check` -- all checks passed.
- `cd web && E2E_PORT=8978 pnpm verify` -- typecheck, lint, fcis (119
  modules, no boundary violations), 100 test files / 1447 unit tests
  passed (97.53% statement coverage), bundle + precache budgets OK, build
  succeeded, 34/34 Playwright e2e passed with zero flakes on this run.

Not merged to main; not deployed, per instructions.
