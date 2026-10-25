# Export gather bound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /api/export/page/{title}` stops gathering query results once
what it has gathered could not render inside the export budget, and refuses
with the same `ExportTooLarge` 422, so Q distinct query expressions over M
matching blocks never hold Q x M rows.

**Architecture:** The gather (`routes_export._gather_resolution_data`,
Imperative Shell) charges a `GatherBudget` (new, `pkm/export/resolve.py`,
Functional Core) at a price no greater than what the renderer will charge
to render each gathered result once. It checks a query's match count before
fetching any row, then streams the rows and charges each as it arrives, so a
refused query never materialises its whole result.

**Tech Stack:** Python 3 / FastAPI / SQLite / pytest / hypothesis.

**Spec:** `docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md`,
row pkm-stny ("Stop gathering once the gathered items exceed the export
budget and refuse with the same `ExportTooLarge` 422"); the existing bound is
`docs/superpowers/plans/2026-10-24-page-export-size-cap.md`.

## Global Constraints

- Same refusal: status 422, `detail` the renderer's own messages, exactly
  `"page too large to export: over 10 million characters once block refs and queries are expanded"`
  or `"page too large to export: its block refs and queries expand too many times"`.
- The gather never refuses a page the renderer would export (modulo the
  accepted edge below): every charge is a lower bound on the renderer's.
- Under the bound, output is byte-identical to today; every existing test in
  `test_export_resolve.py` and `test_export_routes.py` passes unchanged.
- `/api/query`'s behaviour and `execute_plan`'s contract are unchanged.
- FCIS headers; comment rules in AGENTS.md (no bean ids, no line numbers,
  80-column comment lines); never write "load-bearing".

## The bound, and why it is founded

The bean suggests "items > max_chars / 5" (each rendered item costs at least
five characters). The renderer gives a tighter and still sound price. Each
distinct expression the gather executes is rendered at least once (the gather
finds macros with the renderer's own `find_query_macros`, at the depths the
renderer resolves them), and rendering it once charges `_Budget`:

| Rendered piece | Calls charged | Characters charged |
|---|---|---|
| the query (`render_query_result`) | 1 | header (not counted by the gather) |
| each item (`resolve_text` at item depth d) | `1 + len(text) // SCAN_CHARS_PER_UNIT` | `5` (newline + `"  - "`) plus every literal character outside the spans `resolve_text` substitutes at depth d |

So the gather charges exactly the calls above and, for characters, `5 +
len(text) - (spans of the query macros and refs resolve_text would substitute
at depth d)`: substitution can only replace a span, never shrink literal
text. Both lower-bound what rendering costs, against the same `max_chars`
and `max_chars // CHARS_PER_CALL`, so a refusal here is a refusal the
renderer would have made. At the real bound the call budget caps the gather
at fewer than 1,000,000 items (vs 2,000,000 for max_chars / 5); the character
charge caps text-bearing items far sooner (about 285,000 items of 30
characters).

The spans come from one helper (`_substitutions(text, depth)`) that
`resolve_text` itself uses, so the gather's price cannot drift from the
renderer's.

**Accepted edge:** the gather follows refs found by `refs.extract`, the
renderer by `_BLOCK_REF_RE` outside query macros. A ref the gather follows
but the renderer does not (one inside a query macro's body) can lead the
gather to a query the renderer never shows; it is charged anyway. Refusing
such a page needs that unrendered query to match past the budget alone.

## Where the count is checked

1. Before fetching: `count_matches` (the same count `execute_plan` makes);
   `GatherBudget.check_room(total)` refuses when `total` items could not fit
   at one call and five characters each. No row is fetched.
2. While fetching: rows stream from a cursor (`Db.select_iter`, batches of
   `fetchmany`) through `query_exec.iter_plan_rows`, which shares
   `execute_plan`'s SQL text (filter and ordering). Each row is charged with
   `charge_item` before it is kept, so a write racing between count and fetch
   still cannot pass the budget, and a refusal drops at most what was kept.
3. Across expressions and rounds: one `GatherBudget` per gather, shared by
   every expression at every depth.

## Review Focus

1. A query whose items hold refs or nested macros: the character charge
   must subtract only the spans `resolve_text` replaces at the item's depth
   (at depth 2 a macro is literal, at depth 3 a ref is). Property test in
   Task 1 (gather never refuses what renders, at the exact boundary).
2. Many string-distinct equivalent expressions (`visited_exprs` misses
   them): the budget is shared across them. Route test in Task 2.
3. A query matching more than the budget: no row fetched. Route test in
   Task 2 (spy on the rows streamed).
4. Under the bound nothing changes: existing route and resolver tests.
5. A refused export never reaches the renderer and still answers 422, not
   500 (the gather now raises inside the route's `try`). Route test.

---

### Task 1: Core: `GatherBudget` in `pkm/export/resolve.py`

**Files:**
- Modify: `server/src/pkm/export/resolve.py`
- Test: `server/tests/test_export_resolve.py`

**Interfaces:**
- Produces:
  - `class GatherBudget` with `__init__(self, max_chars: int = EXPORT_MAX_CHARS)`,
    `charge_query(self) -> None`, `check_room(self, items: int) -> None`,
    `charge_item(self, text: str, depth: int) -> None`; all raise
    `ExportTooLarge` with the renderer's messages.
  - private `_substitutions(text, depth) -> list[tuple[int, int, str, str]]`
    (the `(start, end, kind, payload)` events `resolve_text` substitutes),
    now used by `resolve_text`.

- [ ] **Step 1: Write the failing tests**

```python
def test_gather_budget_refuses_more_items_than_calls_before_fetching():
    b = GatherBudget(max_chars=CHARS_PER_CALL * 100)
    b.charge_query()
    b.check_room(99)
    with pytest.raises(ExportTooLarge, match=_TOO_MANY_CALLS):
        b.check_room(100)

def test_gather_budget_charges_five_characters_an_item_at_least():
    # calls ample, characters not: 10 items fit in 50 characters
    ...  # check_room(11) at max_chars=50 raises _TOO_MANY_CHARS

def test_gather_budget_charges_literal_text_but_not_substituted_spans():
    # "ab((u1))cd" at depth 1 costs 5 + 4 chars; at depth 3 (refs raw)
    # 5 + 10; a {{query: x}} span is free at depth 1, literal at depth 2.

@given(...)  # item texts from "a", "\n", "((u1))", "{{query: x}}"
def test_the_gather_never_refuses_what_renders(items):
    # page: one block "{{query: q}}"; find by bisection the least max_chars
    # at which render_page_resolved succeeds; at that max_chars,
    # GatherBudget: charge_query, check_room(n), charge_item(t, 1) for each
    # item, then for the nested "x" result's items at depth 2, never raise.
```

- [ ] **Step 2: Run them, see them fail** (ImportError for `GatherBudget`).
  Run: `cd server && uv run pytest -q tests/test_export_resolve.py`
- [ ] **Step 3: Implement** `GatherBudget` over a private `_Budget`, and
  `_substitutions` extracted from `resolve_text`.
- [ ] **Step 4: Run them, see them pass; mutate `charge_item` to charge
  `len(text)` and confirm the property fails** (teeth).
- [ ] **Step 5: Commit.**

### Task 2: Shell: charge the gather, stream the rows

**Files:**
- Modify: `server/src/pkm/database.py` (`Db.select_iter`)
- Modify: `server/src/pkm/server/query_exec.py` (`iter_plan_rows`, shared
  `_rows_sql`)
- Modify: `server/src/pkm/server/routes_export.py` (`_run_query`,
  `_gather_resolution_data`, `export_page_markdown`)
- Test: `server/tests/test_export_routes.py`, `server/tests/test_database.py`

**Interfaces:**
- Consumes: `GatherBudget` (Task 1).
- Produces:
  - `Db.select_iter(self, sql: str, params: Params = ()) -> Iterator[Row]`,
    rows checked as `select` checks them; cursor closed when the iterator is.
  - `iter_plan_rows(db: Db, sql: str, params: Sequence[str]) -> Iterator[Row]`,
    the rows `execute_plan` returns, in its order.
  - `_gather_resolution_data(db, initial_texts, max_chars: int = EXPORT_MAX_CHARS)`
    raising `ExportTooLarge`; the route passes the module's
    `EXPORT_MAX_CHARS` to it and to `render_page_resolved`, so a test can
    lower both with `monkeypatch.setattr(routes_export, "EXPORT_MAX_CHARS", n)`.

- [ ] **Step 1: Write the failing tests**

```python
def test_export_refuses_many_equivalent_queries_without_fetching_them_all(
        tmp_path, monkeypatch):
    # 50 string-distinct equivalent expressions, each matching 40 blocks;
    # EXPORT_MAX_CHARS = CHARS_PER_CALL * 200. Spy on iter_plan_rows rows.
    # 422, the calls message, fewer than 50 * 40 rows streamed (at most
    # about 200), render_page_resolved never called.

def test_export_refuses_a_query_matching_past_the_budget_before_any_row(
        tmp_path, monkeypatch):
    # one expression matching 500 blocks at the same lowered bound:
    # 422, zero rows streamed.

def test_select_iter_yields_what_select_returns(...)
def test_iter_plan_rows_matches_execute_plan(...)
```

- [ ] **Step 2: Run them, see them fail** (no `iter_plan_rows`; the route
  answers 422 only after fetching every row, or 200).
- [ ] **Step 3: Implement.** `_run_query` takes the budget and the item
  depth: parse/plan as before; `budget.charge_query()`;
  `budget.check_room(count_matches(...))`; stream `iter_plan_rows`, charging
  each row before keeping it; group and shape as before. Move the gather
  inside the route's `try`.
- [ ] **Step 4: Run** `uv run pytest -q`, `uv run pyrefly check`,
  `uv run ruff check`; all pass.
- [ ] **Step 5: Docs** (`architecture-docs` skill):
  `import-export-and-backup.md` § Single-page export (replace "The budget
  does not bound the route's gather" with the gather's charge and the
  accepted edge); `backend.md` "makes a route answer 500"-style row for the
  export already names the 422, extend it to the gather;
  `docs/troubleshooting.md` one row (symptom: a single-page export of a
  page of query macros holds every match of every query before refusing),
  Ref pkm-stny. No route, response model or docstring change, so
  `openapi.json` is not regenerated unless the route docstring changes.
- [ ] **Step 6: Commit.**
