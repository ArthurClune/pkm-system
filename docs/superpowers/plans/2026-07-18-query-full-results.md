# Query Full Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make embedded queries return and render every matching block in one request, with no query pagination or “Show more” behavior.

**Architecture:** Remove `limit` and `offset` from the `/api/query` route and fetch the complete ordered result set in one SQL query. Simplify `QueryBlock` to one request per expression while preserving stale-response protection, errors, result totals, and recursion limits; regenerate the API contract after the route signature changes.

**Tech Stack:** Python 3.12+, FastAPI, sqlite3, pytest, React 18, TypeScript, Vitest, Testing Library, pnpm, openapi-typescript.

## Global Constraints

- `GET /api/query` accepts only `expr` and returns every match in one `GroupsPayload` response.
- Keep the `GroupsPayload` response shape unchanged.
- Keep query parsing, matching, source-query exclusion, ordering, stale-response protection, errors, result totals, and nested-query recursion behavior unchanged.
- Remove query-only pagination state, handlers, comments, tests, and generated API parameters.
- Do not alter pagination for backlinks or unlinked references.
- Do not add virtualization or a replacement result limit.
- Preserve the existing FCIS declarations: `routes_search.py` and `QueryBlock.tsx` remain Imperative Shell files.
- Regenerate, never hand-edit, `web/src/api/openapi.json` and `web/src/api/types.d.ts`.
- Run all commands from `/Users/arthur/code/llm/pkm/.worktrees/pkm-x41r` unless a step explicitly changes directory.
- After every commit, push `fix/pkm-x41r` as required by the project workflow.

## File Map

- `server/tests/test_query.py` — server regression proving more than the former 100-result default is returned.
- `server/src/pkm/server/routes_search.py` — unpaginated query endpoint and SQL execution.
- `web/src/api/openapi.json` — generated OpenAPI contract without query `limit` or `offset`.
- `web/src/api/types.d.ts` — generated TypeScript contract without query `limit` or `offset`.
- `web/src/components/QueryBlock.test.tsx` — web regression for more than 70 rendered results, one request, and no button; retained concurrency/error coverage.
- `web/src/components/QueryBlock.tsx` — single-request query rendering with pagination code removed.
- `.beans/pkm-x41r--query-truncation.md` — task checklist, summary, and completion status.

---

### Task 1: Return Every Match from the Query API

**Files:**
- Modify: `server/tests/test_query.py:38-88`
- Modify: `server/src/pkm/server/routes_search.py:47-78`
- Regenerate: `web/src/api/openapi.json`
- Regenerate: `web/src/api/types.d.ts`

**Interfaces:**
- Consumes: `parse_query(expr: str) -> QueryNode`, `plan_sql(node: QueryNode) -> tuple[str, list[str]]`, and the existing `GroupsPayload` response model.
- Produces: `GET /api/query?expr=<encoded expression>` returning `{groups: BlockGroup[], total: number}` with every matching block and no `limit` or `offset` request parameters.

- [ ] **Step 1: Install dependencies and confirm the focused baselines**

```bash
cd server
uv sync
uv run pytest -q tests/test_query.py
cd ../web
pnpm install --frozen-lockfile
pnpm test:unit -- src/components/QueryBlock.test.tsx
```

Expected: both focused suites pass before behavior changes.

- [ ] **Step 2: Add a server regression that exceeds the former default limit**

Append this test before `test_query_endpoint_bad_expr_400` in `server/tests/test_query.py`:

```python
def test_query_endpoint_returns_every_match(client, seeded_config):
    con = open_db(seeded_config.db_path)
    blocks = [
        (f"uid_many_{i:03d}", 1, None, i + 10, f"result {i} [[Paper]]",
         None, 0, None, None)
        for i in range(101)
    ]
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        blocks,
    )
    con.executemany(
        "INSERT INTO refs VALUES (?,?,?)",
        [(uid, 4, "link") for uid, *_ in blocks],
    )
    con.commit()
    con.close()

    body = client.get(
        "/api/query", params={"expr": "{and: [[Paper]]}"},
    ).json()
    items = [item for group in body["groups"] for item in group["items"]]

    # 101 inserted matches plus seeded uid_b3. This exceeds the old default
    # limit of 100 and proves the endpoint returns the complete result set.
    assert body["total"] == 102
    assert len(items) == 102
    assert {item["uid"] for item in items} >= {"uid_many_000", "uid_many_100"}
```

- [ ] **Step 3: Run the regression and verify RED**

```bash
cd server
uv run pytest -q tests/test_query.py::test_query_endpoint_returns_every_match
```

Expected: FAIL because `body["total"]` is 102 while `len(items)` is only 100 under the old default `limit`.

- [ ] **Step 4: Remove pagination from the route signature and SQL**

In `server/src/pkm/server/routes_search.py`, replace the paginated route declaration and row query with:

```python
@router.get("/api/query", response_model=GroupsPayload)
def run_query(expr: str,
              db: sqlite3.Connection = Depends(get_db)) -> dict:
    try:
        sql, params = plan_sql(parse_query(expr))
    except QueryParseError as e:
        raise HTTPException(status_code=400, detail=str(e))
    total = db.execute(
        f"""SELECT count(*) FROM ({sql}) m
              JOIN blocks b ON b.uid = m.uid
             WHERE {_QUERY_SOURCE_FILTER}""",
        params,
    ).fetchone()[0]
    rows = db.execute(
        f"""SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title
              FROM ({sql}) m JOIN blocks b ON b.uid = m.uid
              JOIN pages p ON p.id = b.page_id
             WHERE {_QUERY_SOURCE_FILTER}
             ORDER BY p.title, b.uid""",
        params,
    ).fetchall()
```

Leave the existing grouping loop and return value unchanged.

- [ ] **Step 5: Run the focused server suite and verify GREEN**

```bash
cd server
uv run pytest -q tests/test_query.py
```

Expected: all query tests pass, including all 102 returned items.

- [ ] **Step 6: Regenerate the API artifacts**

```bash
cd server
uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web
pnpm gen-types
```

Expected: generated diffs remove only the `/api/query` `limit` and `offset` parameters; the response type remains `GroupsPayload`.

- [ ] **Step 7: Verify the route contract and generated-schema sync**

```bash
cd server
uv run pytest -q tests/test_query.py tests/test_openapi_sync.py
cd ..
python - <<'PY'
import json
from pathlib import Path

schema = json.loads(Path("web/src/api/openapi.json").read_text())
parameters = schema["paths"]["/api/query"]["get"]["parameters"]
assert [parameter["name"] for parameter in parameters] == ["expr"]
PY
```

Expected: pytest passes and the Python assertion exits successfully.

- [ ] **Step 8: Commit and push the server/API deliverable**

```bash
git add server/tests/test_query.py server/src/pkm/server/routes_search.py \
  web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "fix(query): return complete result sets (pkm-x41r)"
git push
```

Expected: commit succeeds and `origin/fix/pkm-x41r` advances.

---

### Task 2: Render Full Query Results in One Web Request

**Files:**
- Modify: `web/src/components/QueryBlock.test.tsx:1-256`
- Modify: `web/src/components/QueryBlock.tsx:1-117`
- Modify: `.beans/pkm-x41r--query-truncation.md`

**Interfaces:**
- Consumes: the Task 1 API contract `GET /api/query?expr=<encoded expression>` returning one complete `GroupsPayload`.
- Produces: `QueryBlock({ expr, depth? })` that renders every returned item after one request and exposes no pagination control.

- [ ] **Step 1: Replace the paginated rendering test with a full-result regression**

In `web/src/components/QueryBlock.test.tsx`, remove `fireEvent` from the Testing Library import and replace the first test with:

```tsx
it("renders more than seventy results from one request without show more", async () => {
  const items = Array.from({ length: 71 }, (_, i) => ({
    uid: `uid_q${i}`,
    text: `result ${i}`,
  }));
  const fetchMock = stubFetch([
    [`/api/query?expr=${ENC}`, {
      groups: [{ page_id: 6, page_title: "Generative Models", items }],
      total: items.length,
    }],
  ]);

  renderExpr(EXPR);

  expect(await screen.findByText("result 70")).toBeInTheDocument();
  expect(screen.getByText("71 results")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(`/api/query?expr=${ENC}`, undefined);
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});
```

- [ ] **Step 2: Run the web regression and verify RED**

```bash
cd web
pnpm test:unit -- src/components/QueryBlock.test.tsx
```

Expected: FAIL because the existing component calls `/api/query?...&limit=20&offset=0` rather than the exact unpaginated URL.

- [ ] **Step 3: Simplify `QueryBlock` to one request per expression**

In `web/src/components/QueryBlock.tsx`:

1. Delete the `mergeGroups` import and `PAGE_SIZE` constant.
2. Delete `offset`, `loading`, and `pageRequestRef` state/refs.
3. Replace the request comment and `load` callback with:

```tsx
  // Every expression load is stamped with a monotonically increasing request
  // id. A response is applied only if it is still current when it resolves;
  // this drops stale responses even when the offline gateway does not honor an
  // AbortController.
  const requestIdRef = useRef(0);

  const load = useCallback(async (requestId: number) => {
    try {
      const p = await apiFetch<GroupsPayload>(
        `/api/query?expr=${encodeURIComponent(expr)}`);
      if (requestId !== requestIdRef.current) return;
      setGroups(p.groups);
      setTotal(p.total);
      setError(null);
    } catch (e: unknown) {
      if (requestId !== requestIdRef.current) return;
      // query blocks are online-only in v1 (spec section 4)
      setError(e instanceof OfflineError ? "query unavailable offline"
                                         : String(e));
    }
  }, [expr]);
```

4. Replace the effect body with:

```tsx
  useEffect(() => {
    if (capped) return;
    const requestId = ++requestIdRef.current;
    setGroups([]);
    setTotal(null);
    setError(null);
    void load(requestId);
  }, [capped, load]);
```

5. Delete `loadMore` and delete the conditional “Show more” button from the returned JSX.

Keep the recursion-cap branch, header, errors, group rendering, and nested `InlineSegments` rendering unchanged.

- [ ] **Step 4: Remove pagination-only tests and preserve error clearing across expressions**

Delete these tests from `web/src/components/QueryBlock.test.tsx` because their behavior no longer exists:

- `clears a stale error once a show-more retry succeeds`
- `drops an obsolete pagination response after a rerender changes the expr`
- `recovers the page guard after a show-more that paginates from offset 0`
- `ignores a second show-more click while a page request is already in flight`

Add this replacement for the removed retry test so successful expression changes still prove that current errors clear:

```tsx
it("clears the current error when a changed expression succeeds", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`/api/query?expr=${ENC_A}`)) {
      return Promise.resolve(jsonResponse({ detail: "boom" }, 500));
    }
    if (url.startsWith(`/api/query?expr=${ENC_B}`)) {
      return Promise.resolve(jsonResponse({
        groups: [{
          page_id: 2,
          page_title: "Beta page",
          items: [{ uid: "b1", text: "recovered" }],
        }],
        total: 1,
      }));
    }
    throw new Error(`unexpected url ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const { rerender } = renderExpr(EXPR_A);
  expect(await screen.findByText(/500/)).toBeInTheDocument();

  rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <QueryBlock expr={EXPR_B} />
    </MemoryRouter>,
  );

  expect(await screen.findByText("recovered")).toBeInTheDocument();
  expect(screen.queryByText(/500/)).toBeNull();
});
```

Retain the recursion, server-error, superseded-expression, and stale-rejection tests.

- [ ] **Step 5: Run the focused web suite and verify GREEN**

```bash
cd web
pnpm test:unit -- src/components/QueryBlock.test.tsx
pnpm typecheck
```

Expected: all `QueryBlock` tests pass and TypeScript reports no errors.

- [ ] **Step 6: Update the bean’s implemented/tested checklist items**

```bash
cd ..
beans update pkm-x41r \
  --body-replace-old '- [ ] Add a regression test that fails before the fix' \
  --body-replace-new '- [x] Add a regression test that fails before the fix'
beans update pkm-x41r \
  --body-replace-old '- [ ] Render all query results and remove the show-more behavior' \
  --body-replace-new '- [x] Render all query results and remove the show-more behavior'
```

Expected: the bean remains `in-progress` with both items checked.

- [ ] **Step 7: Commit and push the web deliverable**

```bash
git add web/src/components/QueryBlock.tsx \
  web/src/components/QueryBlock.test.tsx \
  .beans/pkm-x41r--query-truncation.md
git commit -m "fix(web): render all query results at once (pkm-x41r)"
git push
```

Expected: commit succeeds and `origin/fix/pkm-x41r` advances.

---

### Task 3: Prove Cleanup, Verify the Project, and Complete the Bean

**Files:**
- Inspect: `server/src/pkm/server/routes_search.py`
- Inspect: `server/tests/test_query.py`
- Inspect: `web/src/components/QueryBlock.tsx`
- Inspect: `web/src/components/QueryBlock.test.tsx`
- Inspect: `web/src/api/openapi.json`
- Inspect: `web/src/api/types.d.ts`
- Modify: `.beans/pkm-x41r--query-truncation.md`

**Interfaces:**
- Consumes: the complete server and web changes from Tasks 1 and 2.
- Produces: verified code with no query-pagination remnants, a completed `pkm-x41r` bean, and a pushed branch.

- [ ] **Step 1: Search for orphaned query-pagination code**

```bash
rg -n 'PAGE_SIZE|pageRequestRef|loadMore|mergeGroups|offset|limit|Show more|show-more' \
  web/src/components/QueryBlock.tsx \
  web/src/components/QueryBlock.test.tsx
```

Expected: no matches. Check the server route structurally so unrelated search/title limits do not create false positives:

```bash
python - <<'PY'
import ast
from pathlib import Path

path = Path("server/src/pkm/server/routes_search.py")
source = path.read_text()
module = ast.parse(source)
run_query = next(
    node for node in module.body
    if isinstance(node, ast.FunctionDef) and node.name == "run_query"
)
assert [arg.arg for arg in run_query.args.args] == ["expr", "db"]
body = ast.get_source_segment(source, run_query)
assert body is not None
assert "LIMIT ?" not in body
assert "OFFSET ?" not in body
PY
```

Expected: all structural assertions pass. Confirm `mergeGroups` remains legitimately used elsewhere rather than deleting its shared implementation:

```bash
rg -n 'mergeGroups' web/src
```

Expected: references remain in backlink/unlinked pagination code, but none in `QueryBlock.tsx` or `QueryBlock.test.tsx`.

- [ ] **Step 2: Verify the generated query operation has no orphan parameters**

```bash
python - <<'PY'
import json
from pathlib import Path

schema = json.loads(Path("web/src/api/openapi.json").read_text())
parameters = schema["paths"]["/api/query"]["get"]["parameters"]
assert [parameter["name"] for parameter in parameters] == ["expr"]

types = Path("web/src/api/types.d.ts").read_text()
query_operation = types.split("run_query_api_query_get: {", 1)[1].split(
    "\n    };", 1,
)[0]
assert "limit?:" not in query_operation
assert "offset?:" not in query_operation
PY
```

Expected: both assertions pass.

- [ ] **Step 3: Run required server verification**

```bash
cd server
uv run pytest -q
uv run pyrefly check
uv run ruff check
```

Expected: the server suite passes with enforced coverage, pyrefly reports no errors, and ruff reports no lint violations.

- [ ] **Step 4: Run required web verification**

```bash
cd ../web
pnpm verify
```

Expected: typecheck, lint, FCIS check, enforced unit coverage, production build, and Playwright E2E all pass.

- [ ] **Step 5: Review the final diff and request code review**

```bash
cd ..
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
git status --short --branch
```

Expected: no whitespace errors, only the planned files differ, and the worktree is clean before the final bean update. Invoke `superpowers:requesting-code-review`; address any correctness or scope findings and rerun affected verification before continuing.

- [ ] **Step 6: Complete the bean checklist and add the summary**

```bash
beans update pkm-x41r \
  --body-replace-old '- [ ] Remove orphaned truncation code and references' \
  --body-replace-new '- [x] Remove orphaned truncation code and references'
beans update pkm-x41r \
  --body-replace-old '- [ ] Run required verification and review the diff' \
  --body-replace-new '- [x] Run required verification and review the diff'
beans update pkm-x41r \
  --body-replace-old '- [ ] Commit and push the completed fix' \
  --body-replace-new '- [x] Commit and push the completed fix'
beans update pkm-x41r --status completed --body-append $'## Summary of Changes\n\n- Removed pagination parameters and SQL limits from `/api/query`.\n- Simplified `QueryBlock` to render complete result sets from one request with no Show more control.\n- Added server and web regressions for large result sets, regenerated API artifacts, removed pagination-only tests/code, and passed required verification.'
```

Expected: `beans show --json pkm-x41r` reports `completed` and contains no unchecked checklist items.

- [ ] **Step 7: Commit and push bean completion**

```bash
git add .beans/pkm-x41r--query-truncation.md
git commit -m "chore(beans): complete pkm-x41r"
git push
git status --short --branch
```

Expected: the completion commit is pushed and the branch is clean and synchronized with `origin/fix/pkm-x41r`.
