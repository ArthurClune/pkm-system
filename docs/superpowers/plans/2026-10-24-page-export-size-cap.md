# Page export size cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /api/export/page/{title}` refuses (422) an export whose
resolved body would pass 10 million characters, stopping the work at the
bound, and the web's "Export as Markdown" shows that refusal.

**Architecture:** A character budget threaded through
`pkm.export.resolve` (Functional Core) raises `ExportTooLarge` as soon as
the text built passes the bound; `routes_export.py` (Imperative Shell)
maps it to a 422. The web menu item becomes a button that fetches the
export, saves the blob, and reports a failure in TopBar's existing error
line.

**Tech Stack:** Python 3 / FastAPI / pytest; React / TypeScript / vitest /
Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-page-export-size-cap-design.md`

## Global Constraints

- `EXPORT_MAX_CHARS = 10_000_000`, defined in `pkm/export/resolve.py`.
- Over the bound: status **422**, `detail` a string, exactly
  `"page too large to export: over 10 million characters once block refs and queries are expanded"`.
- No partial body, no truncation, never a 500.
- Under the bound: output byte-identical to today (every existing test in
  `test_export_resolve.py` and `test_export_routes.py` passes unchanged).
- Invariant: no string longer than a small multiple of the bound is built
  while resolving, at any recursion level, refs or queries.
- `GET /api/export.zip`, `pkm.export.markdown` and the nightly backup are
  untouched.
- FCIS headers, the comment rules in AGENTS.md (no bean ids or line
  numbers in code or doc comments; 80-column comment lines).

## Review Focus

1. A query whose results each hold refs (`{{query}}` → items → `((ref))`
   fan-out): the budget must be charged inside `render_query_result`, not
   only `resolve_text`. Test in Task 1.
2. Many top-level blocks that are each under the bound but together pass
   it: the charge is shared across the whole page walk, not reset per
   block. Test in Task 1.
3. Multi-line referenced text: `render_query_result` and
   `render_page_resolved` add indentation per line, so a body of many
   short lines grows beyond its literal text; the count must include the
   added prefixes or the "byte-identical / exact bound" claim breaks.
   Test in Task 1 (body exactly at the bound is served, one past refused,
   using a lowered bound).
4. A title with `/` or non-ASCII: the web download keeps the server's
   filename (`filename*` UTF-8 form). Test in Task 2.
5. Offline or 401 during export: the error line shows the reason (or the
   login redirect happens) instead of a silent no-op. Test in Task 2.

---

### Task 1: Server — charge the bound while resolving; 422 on refusal

Model: opus (security property, recursion invariant).

**Files:**
- Modify: `server/src/pkm/export/resolve.py`
- Modify: `server/src/pkm/server/routes_export.py`
  (`export_page_markdown`)
- Test: `server/tests/test_export_resolve.py`,
  `server/tests/test_export_routes.py`
- Docs: `docs/architecture/import-export-and-backup.md` (§ Single-page
  export), `docs/architecture/backend.md` (API reference row for
  `/api/export/page/{title}`; one row in the "No client input … makes a
  route answer 500" table), `docs/troubleshooting.md` (one row, Ref
  `pkm-8bga`). Use the `architecture-docs` skill.

**Interfaces:**
- Produces:
  - `EXPORT_MAX_CHARS: int = 10_000_000` (module constant)
  - `class ExportTooLarge(Exception)` (Core; carries no state the route
    needs beyond its type)
  - `render_page_resolved(title, tree, uid_to_text, query_results,
    max_chars: int = EXPORT_MAX_CHARS) -> str`, raising `ExportTooLarge`
  - `resolve_text(..., depth=0)` and `render_query_result(...)` keep
    their current positional signatures and behaviour for existing
    callers; the budget reaches them as an optional keyword argument
    (e.g. a small mutable `_Budget` object, default unbounded). Name it
    as you like; keep it private to the module.

- [ ] **Step 1: Write the failing tests**

In `test_export_resolve.py`:

```python
def _amp(k: int, leaf: str) -> dict[str, str]:
    # The probe's shape: three levels of K refs each over one leaf.
    return {"amp_lvl1": " ".join(["((amp_lvl2))"] * k),
            "amp_lvl2": " ".join(["((amp_lvl3))"] * k),
            "amp_lvl3": leaf}

def test_render_page_resolved_refuses_a_k_cubed_fan_out():
    tree = [node("amp_top0", " ".join(["((amp_lvl1))"] * 200))]
    # Uncharged, this is 200**3 * 100 = 800M characters.
    with pytest.raises(ExportTooLarge):
        render_page_resolved(canonical_title_of("Amp"), tree,
                             _amp(200, "Z" * 100), {}, max_chars=10_000)

def test_a_refused_export_never_builds_a_string_far_past_the_bound():
    # tracemalloc peak while refusing stays a small multiple of the bound
    # (assert peak < 20 * max_chars bytes with max_chars = 1_000_000).
    ...

def test_the_bound_is_shared_across_top_level_blocks():
    # 50 blocks each rendering ~1_000 chars, max_chars=10_000 -> refused;
    # the same 50 blocks with max_chars=100_000 -> rendered.

def test_query_results_are_charged():
    # One {{query: ...}} whose QueryResult has items each holding
    # ((amp_lvl1)) with _amp(50, "Z"*100), max_chars=10_000 -> refused.

def test_the_bound_is_exact_on_the_finished_body():
    # Any page with multi-line ref text inside a query result: let
    # n = len(render_page_resolved(... default bound)); then
    # max_chars=n renders identically and max_chars=n-1 raises.
```

In `test_export_routes.py` (seeded with `seeded_client`, as the
neighbouring ref tests are, and the probe's four-block page):

```python
def test_export_page_markdown_refuses_a_fan_out_past_the_bound(tmp_path):
    # K=60, leaf "Z"*100 -> 21.6M chars uncharged, past the real bound.
    r = tc.get("/api/export/page/Amp")
    assert r.status_code == 422
    assert r.json() == {"detail": "page too large to export: over 10 million"
                        " characters once block refs and queries are expanded"}
    assert "content-disposition" not in r.headers
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd server && uv run pytest -q tests/test_export_resolve.py tests/test_export_routes.py`
Expected: the new tests FAIL (ImportError for `ExportTooLarge` /
`max_chars`, then the route returns 200 with a 21.6 MB body).

- [ ] **Step 3: Implement the budget in `resolve.py`**

Charge every piece of text as it is appended to an output (literal slices
of the source text, the query header and `- `/indent prefixes, and each
page-walk line with its padding), so the running count equals the length
of the finished body and the refusal is exact (Review Focus 3). Raise
`ExportTooLarge` the moment the count passes `max_chars`. One budget per
`render_page_resolved` call, shared by every recursion and every block.
A recursive result is not charged again by its caller (its characters
were charged where they originated).
`rewrite_asset_links` lengthens each `](/assets/` by two characters;
charge that growth too, or the count drifts from the body. Update the module docstring: the
depth caps bound how deep expansion goes; the character budget bounds how
much it produces, and why it is charged on the way in.

- [ ] **Step 4: Map the refusal in the route**

`export_page_markdown` catches `ExportTooLarge` and raises
`HTTPException(status_code=422, detail=<the exact string>)`. Keep the
detail string as a module constant in `routes_export.py`. Mention the 422
in the module docstring. Do not add a route docstring (it would stale
`openapi.json`); if you change anything the schema reads, regenerate per
the generated-artifacts table in `backend.md`.

- [ ] **Step 5: Run the tests, the probe and the gates**

```bash
cd server && uv run pytest -q tests/test_export_resolve.py tests/test_export_routes.py
uv run python ../docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-exports/p5_amplify.py <probes dir> 60 100
```
The probe lives in the main checkout only
(`/Users/arthur/code/llm/pkm/docs/superpowers/handoffs/security-review-2026-10-23-probes/`);
run it from there with `sys.argv[1]` pointing at that probes directory and
the worktree's `server` on `PYTHONPATH`/`uv --project`. Expected: status
422, maxrss growth well under 1.4 GiB (record the numbers in your report).
Then the full gates: `uv run pytest -q`, `uv run pyrefly check`,
`uv run ruff check`, all clean.

- [ ] **Step 6: Docs**

`import-export-and-backup.md` § Single-page export: the bound, the 422,
and the rule "charged as text is appended, never on the finished body,
because expansion is built bottom-up". `backend.md`: the API row mentions
the 422; the hostile-input table gets the row (Input: a page whose refs
or queries fan out past `EXPORT_MAX_CHARS`; Guard: `resolve.py` charges
the bound as it expands and the route answers 422; Kept by: the tests
above). `troubleshooting.md`: symptom "single-page export of a small page
runs the server out of memory (279 MB from 11 KB)", cause, owning
section, `pkm-8bga`.

- [ ] **Step 7: Commit**

```bash
git add server/src/pkm/export/resolve.py server/src/pkm/server/routes_export.py \
  server/tests/test_export_resolve.py server/tests/test_export_routes.py \
  docs/architecture/import-export-and-backup.md docs/architecture/backend.md \
  docs/troubleshooting.md
git commit -m "export: refuse a single-page export past 10M characters"
```

### Task 2: Web — fetch the export; show a refusal

Model: sonnet (fully specified UI change).

**Files:**
- Modify: `web/src/api/client.ts` (new download helper)
- Modify: `web/src/components/TopBar.tsx` (menu item, error line)
- Test: `web/src/api/client.test.ts`, `web/src/components/TopBar.test.tsx`
- Modify the two existing TopBar tests that assert the `<a href download>`
  ("shows an 'Export as Markdown' download link…", "encodes slashes…").

**Interfaces:**
- Consumes: the route answers 200 `text/markdown` with
  `Content-Disposition` from `pkm.filenames.attachment_disposition`
  (`attachment; filename="<ascii>"` or additionally
  `; filename*=UTF-8''<percent-encoded>`), or 422 `{"detail": "<string>"}`.
- Produces: `apiDownload(path: string): Promise<{ blob: Blob; filename:
  string | undefined }>` in `client.ts`. Online only: when the offline
  gateway reports offline it throws `OfflineError(path)` without
  fetching. 401 calls the unauthorized handler and throws, as
  `apiFetch` does; any other non-OK throws `ApiError(status, path,
  await readErrorDetail(res))`. `filename` prefers `filename*`
  (decoded), then `filename`.

- [ ] **Step 1: Failing tests**

`client.test.ts`: `apiDownload` returns the blob and the decoded
`filename*` for `attachment; filename="_.md"; filename*=UTF-8''%E6%97%A5.md`
(→ `"日.md"`); falls back to `filename` when there is no `filename*`;
throws `ApiError` with `.status === 422` and `.detail` the server string
on a 422; throws `OfflineError` and never calls fetch when the gateway is
offline.

`TopBar.test.tsx`: "Export as Markdown" is a `menuitem` `<button>`;
clicking it fetches `/api/export/page/AWS/SCP` for `/page/AWS/SCP` (the
`encodeTitle` path, as today), closes the menu, and, on 200, creates an
object URL and clicks a temporary `<a download="<filename>">` (stub
`URL.createObjectURL`/`revokeObjectURL` and assert the anchor's
`download`); on 422 shows a `role="alert"` paragraph containing
`Couldn't export "AWS/SCP": page too large to export` with a Dismiss
button; a later successful export clears it.

- [ ] **Step 2: Run them and see them fail**

Run: `cd web && pnpm test:unit -- src/api/client.test.ts src/components/TopBar.test.tsx`
Expected: FAIL (`apiDownload` missing; menu item is still an `<a>`).

- [ ] **Step 3: Implement**

`apiDownload` in `client.ts` beside `apiFetch`. In TopBar: generalise
`deleteError` to one `menuError` line (both failures use the same
paragraph and Dismiss; clear it when either action starts). The export
handler builds the anchor, clicks it, removes it and revokes the URL
after the click (a `setTimeout(…, 0)` revoke, so Safari has started the
download). Fallback filename when the header gives none:
`` `${title}.md` ``. Replace the "Plain download navigation…" comment
with one saying why it is a fetch: a refused export must show its reason,
which a navigation cannot.

- [ ] **Step 4: Run the tests and the web gate**

Run: `cd web && pnpm test:unit -- src/api/client.test.ts src/components/TopBar.test.tsx`, then `set -o pipefail; E2E_PORT=8981 pnpm verify 2>&1 | tee <scratchpad>/verify.log`
Expected: all green.

- [ ] **Step 5: Docs**

`docs/architecture/frontend.md`: only if it describes the export menu
item or a download convention; otherwise nothing.

- [ ] **Step 6: Commit**

```bash
git add web/src/api/client.ts web/src/api/client.test.ts \
  web/src/components/TopBar.tsx web/src/components/TopBar.test.tsx
git commit -m "web: export fetches the page and shows a refused export's reason"
```

### Task 3: Branch close (orchestrator)

- [ ] `perf/check.sh` on the branch (quiet machine); table into the review
      package.
- [ ] Whole-branch review on the strongest model, plus an adversarial
      reviewer for Task 1 ("assume the bound is bypassable; name the
      minimal condition for safety"; named mutants in a throwaway
      detached worktree).
- [ ] iPad PWA check of the blob download (`ipad-simulator` skill): a
      normal export saves a `.md`; a refused one shows the error line.
- [ ] Bean checklist, `## Summary of Changes`, merge `--no-ff`, deploy,
      verify (new PID on 8974, `launchctl list | grep pkm`, served bundle
      contains `Couldn't export`).
