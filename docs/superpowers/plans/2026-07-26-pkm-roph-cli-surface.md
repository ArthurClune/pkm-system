# pkm-roph CLI Surface Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the seven pkm-roph CLI/MCP surface improvements: exact search, query ref expansion, block-ref resolution in get, full --help audit, batch create positioning + alias-as-uid, token-lean output modes, and empty-query-result hints.

**Architecture:** Server gains two query params (`exact` on /api/search, `expand` on /api/query) and one response field (`ref_counts` on /api/query via a new `QueryPayload` model). Everything else is pure CLI-side work in `cli/render.py` (new pure helpers), `cli/build.py` (batch planning), and `cli/main.py` (flags/help). The MCP server mirrors the new params. The web offline shim mirrors `exact` for parity.

**Tech Stack:** Python 3 / FastAPI / sqlite FTS5 / argparse; TypeScript for the web shim mirror.

**Spec:** `docs/superpowers/specs/2026-07-26-pkm-roph-cli-surface-design.md`

## Global Constraints

- FCIS: every runtime file keeps its `# pattern:` declaration; new logic in
  `cli/render.py`, `cli/build.py`, `server/fts.py`, `server/query.py` is pure
  (Functional Core); I/O stays in `cli/main.py`, `client/api.py`, routes.
- All commands below run from `server/` (`uv run pytest ...`) unless noted.
- After any change to route params/response models, regenerate
  `web/src/api/openapi.json`:
  `uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`
  and commit it with the change (test_openapi_sync.py enforces this).
- Bean pkm-roph checklist: tick the matching `- [ ]` item in the bean file
  and include it in the task's commit.
- Match surrounding code style: ~79-col lines, terse docstrings.

---

### Task 1: `exact` param on /api/search (server)

**Files:**
- Modify: `server/src/pkm/server/fts.py`
- Modify: `server/src/pkm/server/routes_search.py:21-42`
- Test: `server/tests/test_search_endpoint.py`
- Regenerate: `web/src/api/openapi.json`

**Interfaces:**
- Produces: `escape_fts_query(q: str, exact: bool = False) -> str`;
  `GET /api/search?q=&limit=&exact=` (exact defaults False).

- [ ] **Step 1: Write failing tests** (append to `server/tests/test_search_endpoint.py`)

```python
def test_search_exact_disables_prefix_match(client):
    body = client.get("/api/search",
                      params={"q": "machi", "exact": "true"}).json()
    assert body == {"pages": [], "blocks": []}


def test_search_exact_whole_token_still_matches(client):
    body = client.get("/api/search",
                      params={"q": "machine", "exact": "true"}).json()
    assert [p["title"] for p in body["pages"]] == ["Machine Learning"]
    assert {b["uid"] for b in body["blocks"]} == {"uid_b4", "uid_b6"}
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_search_endpoint.py -q`
Expected: the two new tests FAIL (prefix match still fires / TypeError absent — `exact` ignored, "machi" matches).

- [ ] **Step 3: Implement**

`fts.py` — add the parameter:

```python
def escape_fts_query(q: str, exact: bool = False) -> str:
    terms = [t for t in re.split(r"\s+", q.strip()) if t]
    if not terms:
        return '""'
    quoted = [_quote(t) for t in terms]
    if not exact:
        quoted[-1] += "*"
    return " ".join(quoted)
```

`routes_search.py` — thread it through:

```python
@router.get("/api/search", response_model=SearchPayload)
def search(q: str = "", limit: int = 20, exact: bool = False,
           db: sqlite3.Connection = Depends(get_db)) -> dict:
    ...
    match = escape_fts_query(q, exact)
```

- [ ] **Step 4: Regenerate openapi.json**

Run (from `server/`): `uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/test_search_endpoint.py tests/test_openapi_sync.py -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/server/fts.py server/src/pkm/server/routes_search.py \
        server/tests/test_search_endpoint.py web/src/api/openapi.json .beans
git commit -m "pkm-roph: /api/search exact param disables prefix wildcard"
```

---

### Task 2: mirror `exact` in the web shim + parity fixture

**Files:**
- Modify: `web/src/replica/localApi/fts.ts`
- Modify: `web/src/replica/localApi/search.ts`
- Modify: `web/src/replica/localApi/router.ts:84-86`
- Modify: `server/src/pkm/server/shim_parity_dump.py:68-84` (CASES)
- Regenerate: `shared/fixtures/shim_parity.json`

**Interfaces:**
- Consumes: server `exact` behavior from Task 1.
- Produces: `escapeFtsQuery(q: string, exact = false)`;
  `searchPayload(db, q, limit, exact = false)`; parity cases
  `search_exact_miss` and `search_exact_hit`.

- [ ] **Step 1: Add parity cases** (in `shim_parity_dump.py` CASES, after `search_empty`)

```python
    ("search_exact_miss", "/api/search?q=machi&exact=1"),
    ("search_exact_hit", "/api/search?q=machine&exact=1"),
```

- [ ] **Step 2: Regenerate the fixture and verify the server side**

Run (from `server/`):
`uv run python -m pkm.server.shim_parity_dump > ../shared/fixtures/shim_parity.json`
then `uv run pytest tests/test_shim_parity_fixture.py -q` → PASS.

- [ ] **Step 3: Run the web parity test to verify it fails**

Run (from `web/`): `pnpm vitest run src/replica/localApi/parity.test.ts`
Expected: FAIL — the shim ignores `exact`, so `search_exact_miss` returns hits.

- [ ] **Step 4: Implement the shim mirror**

`fts.ts`:

```ts
export function escapeFtsQuery(q: string, exact = false): string {
  const terms = q.trim().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return '""';
  const quoted = terms.map(quote);
  if (!exact) quoted[quoted.length - 1] += "*";
  return quoted.join(" ");
}
```

`search.ts`: add `exact = false` parameter, pass to `escapeFtsQuery(q, exact)`.

`router.ts`: where `/api/search` is handled, parse the param and pass it:

```ts
const exact = q.get("exact") === "1" || q.get("exact") === "true";
return ok(searchPayload(db, q.get("q") ?? "", /* existing limit expr */, exact));
```

- [ ] **Step 5: Run web tests**

Run (from `web/`): `pnpm vitest run src/replica/localApi` → PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/replica/localApi server/src/pkm/server/shim_parity_dump.py \
        shared/fixtures/shim_parity.json
git commit -m "pkm-roph: mirror search exact param in offline shim (+parity cases)"
```

---

### Task 3: `expand` param on /api/query (server)

**Files:**
- Modify: `server/src/pkm/server/query.py`
- Modify: `server/src/pkm/server/routes_search.py:45-76`
- Test: `server/tests/test_query.py`
- Regenerate: `web/src/api/openapi.json`

**Interfaces:**
- Produces: `plan_sql(node: QueryNode, expand: bool = False)`;
  `GET /api/query?expr=&expand=`.
- Note: `routes_export.py` also calls `plan_sql` — the keyword default keeps
  it unchanged.

- [ ] **Step 1: Write failing tests** (append to `server/tests/test_query.py`)

Seed facts (conftest): `uid_b1` (on page "Machine Learning") tags `[[AI]]`;
`uid_b4` (on "July 7th, 2026") links `[[Machine Learning]]`. So expanding
`[[AI]]` must also match `uid_b4` (it references a page whose blocks
reference AI).

```python
def test_plan_sql_expand_duplicates_params():
    from pkm.server.query import QueryNode, plan_sql
    sql, params = plan_sql(QueryNode("page", "AI"), expand=True)
    assert params == ["AI", "AI"]
    assert "UNION" in sql


def test_query_endpoint_expand_one_hop(client):
    base = client.get("/api/query", params={"expr": "{and: [[AI]]}"}).json()
    assert {i["uid"] for g in base["groups"] for i in g["items"]} == {"uid_b1"}
    body = client.get("/api/query",
                      params={"expr": "{and: [[AI]]}", "expand": "true"}).json()
    assert {i["uid"] for g in body["groups"] for i in g["items"]} == \
        {"uid_b1", "uid_b4"}
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_query.py -q` — new tests FAIL
(`plan_sql() got an unexpected keyword argument 'expand'`).

- [ ] **Step 3: Implement**

`query.py` — expanded operand SQL + threading:

```python
_PAGE_SQL_EXPANDED = (
    _PAGE_SQL
    + " UNION SELECT r.src_block_uid AS uid FROM refs r"
      " WHERE r.target_page_id IN ("
      "SELECT b2.page_id FROM refs r2"
      " JOIN blocks b2 ON b2.uid = r2.src_block_uid"
      " JOIN pages px ON px.id = r2.target_page_id WHERE px.title = ?)"
)


def plan_sql(node: QueryNode, expand: bool = False) -> tuple[str, list[str]]:
    if node.kind == "page":
        assert node.title is not None  # page nodes always carry a title
        if expand:
            return _PAGE_SQL_EXPANDED, [node.title, node.title]
        return _PAGE_SQL, [node.title]
    ...  # every recursive plan_sql(c) call becomes plan_sql(c, expand)
```

(Docstring note on `_PAGE_SQL_EXPANDED`: one-hop opt-in transitivity — a
block also matches [[X]] if it references a page whose own blocks
reference X; all ref kinds count.)

`routes_search.py`:

```python
@router.get("/api/query", response_model=GroupsPayload)
def run_query(expr: str, expand: bool = False,
              db: sqlite3.Connection = Depends(get_db)) -> dict:
    try:
        sql, params = plan_sql(parse_query(expr), expand)
    ...
```

- [ ] **Step 4: Regenerate openapi.json** (same command as Task 1 Step 4)

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/test_query.py tests/test_export_resolve.py tests/test_openapi_sync.py -q`
Expected: PASS (export tests prove the default keeps old behavior).

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/server/query.py server/src/pkm/server/routes_search.py \
        server/tests/test_query.py web/src/api/openapi.json .beans
git commit -m "pkm-roph: /api/query expand param — one-hop ref transitivity"
```

---

### Task 4: `ref_counts` on /api/query + render hint

**Files:**
- Modify: `server/src/pkm/server/query.py` (add `page_operands`)
- Modify: `server/src/pkm/server/routes_search.py` (compute counts, new model)
- Modify: `server/src/pkm/server/response_models.py` (QueryPayload)
- Modify: `server/src/pkm/cli/render.py` (`render_groups` hint line)
- Test: `server/tests/test_query.py`, `server/tests/test_cli_render.py`
- Regenerate: `web/src/api/openapi.json`

**Interfaces:**
- Produces: `page_operands(node: QueryNode) -> list[str]` (distinct titles,
  first-seen order); `QueryPayload(GroupsPayload)` with
  `ref_counts: dict[str, int]`; `render_groups` prints
  `per-ref block counts: [[A]] 1, [[B]] 0` after `(0 total)` when total is 0
  and the payload carries a non-empty `ref_counts`.
- `/api/todos` and `/api/unlinked` keep `GroupsPayload` (no ref_counts);
  `render_groups` uses `payload.get("ref_counts")` so those payloads are
  unaffected.

- [ ] **Step 1: Write failing tests**

Append to `server/tests/test_query.py`:

```python
def test_page_operands_distinct_first_seen():
    from pkm.server.query import page_operands, parse_query
    node = parse_query("{and: [[A]] {or: [[B]] [[A]]} {not: [[C]]}}")
    assert page_operands(node) == ["A", "B", "C"]


def test_query_endpoint_ref_counts(client):
    body = client.get(
        "/api/query", params={"expr": "{and: [[Paper]] [[AI]]}"}).json()
    assert body["total"] == 0
    assert body["ref_counts"] == {"Paper": 1, "AI": 1}
```

Append to `server/tests/test_cli_render.py`:

```python
def test_render_groups_empty_with_ref_counts_hint():
    payload = {"groups": [], "total": 0,
               "ref_counts": {"Meeting": 312, "Databases": 51}}
    out = render_groups(payload)
    assert out == ("(0 total)\n"
                   "per-ref block counts: [[Meeting]] 312, [[Databases]] 51\n")


def test_render_groups_no_hint_when_results_exist():
    payload = {"groups": [{"page_id": 1, "page_title": "AI",
                           "items": [{"uid": "t1", "text": "x"}]}],
               "total": 1, "ref_counts": {"AI": 1}}
    assert "per-ref" not in render_groups(payload)
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_query.py tests/test_cli_render.py -q` → new tests FAIL.

- [ ] **Step 3: Implement**

`query.py`:

```python
def page_operands(node: QueryNode) -> list[str]:
    """Distinct [[Page]] operand titles in an expression, first-seen order
    (drives /api/query's ref_counts hint)."""
    if node.kind == "page":
        assert node.title is not None
        return [node.title]
    out: list[str] = []
    for c in node.children:
        for title in page_operands(c):
            if title not in out:
                out.append(title)
    return out
```

`response_models.py` (after `GroupsPayload`):

```python
class QueryPayload(GroupsPayload):
    """GET /api/query: groups plus per-operand match counts so an empty
    result is steerable (bad query shape vs genuinely nothing)."""
    ref_counts: dict[str, int]
```

`routes_search.py` — `run_query` becomes:

```python
@router.get("/api/query", response_model=QueryPayload)
def run_query(expr: str, expand: bool = False,
              db: sqlite3.Connection = Depends(get_db)) -> dict:
    try:
        node = parse_query(expr)
        sql, params = plan_sql(node, expand)
    except QueryParseError as e:
        raise HTTPException(status_code=400, detail=str(e))
    ref_counts = {}
    for title in page_operands(node):
        osql, oparams = plan_sql(QueryNode("page", title), expand)
        ref_counts[title] = db.execute(
            f"""SELECT count(*) FROM ({osql}) m
                  JOIN blocks b ON b.uid = m.uid
                 WHERE {QUERY_SOURCE_FILTER}""",
            oparams).fetchone()[0]
    ...  # existing total/rows/groups code unchanged
    return {"groups": groups, "total": total, "ref_counts": ref_counts}
```

(imports: add `QueryNode`, `page_operands` to the `pkm.server.query` import,
`QueryPayload` to the response_models import.)

`cli/render.py` — end of `render_groups`:

```python
    lines.append(f"({payload['total']} total)")
    counts = payload.get("ref_counts")
    if counts and payload["total"] == 0:
        pairs = ", ".join(f"[[{t}]] {n}" for t, n in counts.items())
        lines.append(f"per-ref block counts: {pairs}")
    return "\n".join(lines) + "\n"
```

- [ ] **Step 4: Regenerate openapi.json** (same command as Task 1 Step 4)

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/test_query.py tests/test_cli_render.py tests/test_cli_main_read.py tests/test_todos_endpoint.py tests/test_openapi_sync.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/server/query.py server/src/pkm/server/routes_search.py \
        server/src/pkm/server/response_models.py server/src/pkm/cli/render.py \
        server/tests/test_query.py server/tests/test_cli_render.py \
        web/src/api/openapi.json .beans
git commit -m "pkm-roph: /api/query ref_counts + empty-result hint line"
```

---

### Task 5: client/CLI/MCP flags for exact + expand

**Files:**
- Modify: `server/src/pkm/client/api.py:110-115`
- Modify: `server/src/pkm/cli/main.py` (`cmd_search`, `cmd_query`, parser)
- Modify: `server/src/pkm/mcp/server.py` (`search`, `query`)
- Test: `server/tests/test_cli_main_read.py`, `server/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: server params from Tasks 1/3.
- Produces: `PkmClient.search(q, limit=20, exact=False)`,
  `PkmClient.run_query(expr, expand=False)`; CLI `pkm search --exact`,
  `pkm query --expand`; MCP `search(q, limit=20, exact=False)`,
  `query(expr, expand=False)`.

- [ ] **Step 1: Write failing tests**

Append to `server/tests/test_cli_main_read.py` (seed facts as in Task 3):

```python
def test_search_exact_flag(run):
    code, out, _ = run("search", "machi", "--exact")
    assert code == 0
    assert out == "no results\n"


def test_query_expand_flag(run):
    _, base, _ = run("query", "{and: [[AI]]}")
    assert "^uid_b4" not in base
    code, out, _ = run("query", "{and: [[AI]]}", "--expand")
    assert code == 0
    assert "^uid_b4" in out and "^uid_b1" in out


def test_query_empty_result_prints_hint(run):
    code, out, _ = run("query", "{and: [[Paper]] [[AI]]}")
    assert code == 0
    assert "(0 total)" in out
    assert "per-ref block counts: [[Paper]] 1, [[AI]] 1" in out
```

Append to `server/tests/test_mcp_server.py`:

```python
def test_search_exact_and_query_expand(tools):
    assert tools.search("machi", exact=True) == "no results\n"
    assert "uid_b4" in tools.query("{and: [[AI]]}", expand=True)
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_cli_main_read.py tests/test_mcp_server.py -q` → new tests FAIL.

- [ ] **Step 3: Implement**

`client/api.py`:

```python
    def search(self, q: str, limit: int = 20, exact: bool = False) -> dict:
        params: dict = {"q": q, "limit": limit}
        if exact:
            params["exact"] = "true"
        return self._request("GET", "/api/search", params=params)

    def run_query(self, expr: str, expand: bool = False) -> dict:
        params = {"expr": expr}
        if expand:
            params["expand"] = "true"
        return self._request("GET", "/api/query", params=params)
```

(Only-send-when-true keeps requests to an older deployed server valid.)

`cli/main.py` — handlers and parser:

```python
def cmd_search(args, client):
    payload = client.search(args.term, limit=args.limit, exact=args.exact)
    ...

def cmd_query(args, client):
    payload = client.run_query(args.expr, expand=args.expand)
    ...
```

Parser additions:

```python
    p.add_argument("--exact", action="store_true",
                   help="match whole words only (no prefix wildcard)")
    # on the query subparser:
    p.add_argument("--expand", action="store_true",
                   help="[[X]] also matches blocks referencing a page that"
                        " itself references X (one hop)")
```

`mcp/server.py`:

```python
def search(q: str, limit: int = 20, exact: bool = False) -> str:
    """Full-text search over page titles and block text. exact=True
    matches whole words only (default prefix-matches the last term)."""
    return render_search(_client().search(q, limit=limit, exact=exact))


def query(expr: str, expand: bool = False) -> str:
    """Structured block query, Roam syntax: {and: [[A]] [[B]]},
    {or: ...}, {not: ...} (not only inside and). Operands are [[Page
    Title]] references. expand=True also matches blocks referencing a
    page that itself references the operand (one hop). An empty result
    includes per-operand match counts to steer the next query."""
    return render_groups(_client().run_query(expr, expand=expand))
```

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_cli_main_read.py tests/test_mcp_server.py tests/test_client_api.py -q` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/client/api.py server/src/pkm/cli/main.py \
        server/src/pkm/mcp/server.py server/tests/test_cli_main_read.py \
        server/tests/test_mcp_server.py .beans
git commit -m "pkm-roph: search --exact and query --expand through client/CLI/MCP"
```

---

### Task 6: `pkm get --resolve-refs`

**Files:**
- Modify: `server/src/pkm/cli/render.py`
- Modify: `server/src/pkm/cli/main.py` (`cmd_get`, get parser)
- Modify: `server/src/pkm/mcp/server.py` (`get_page`, `get_block`)
- Test: `server/tests/test_cli_render.py`, `server/tests/test_cli_main_read.py`,
  `server/tests/test_mcp_server.py`

**Interfaces:**
- Produces: pure `resolve_ref_texts(text: str, ref_map: dict, _seen: frozenset = frozenset()) -> str`
  — rewrites each `((uid))` whose uid is in `ref_map` to `"<resolved text>" ((uid))`,
  recursing into the resolved text with a seen-set (cycles leave the inner
  token bare); unknown uids untouched. `render_page(payload, include_uids=False, resolve_refs=False)`
  and `render_block(...)` same. CLI `pkm get TARGET --resolve-refs`;
  MCP `get_page(title, resolve_refs=False)`, `get_block(uid, resolve_refs=False)`.
- Note: the server already resolves ref chains transitively into
  `block_ref_texts` (`routes_pages._resolve_ref_uids`), so the map contains
  every uid needed; `ref_map` values are `{"text": ..., "page_title": ...}`.

- [ ] **Step 1: Write failing tests**

Append to `server/tests/test_cli_render.py`:

```python
def test_resolve_ref_texts_inlines_and_keeps_uid():
    from pkm.cli.render import resolve_ref_texts
    ref_map = {"u9": {"text": "the target", "page_title": "P"}}
    assert resolve_ref_texts("see ((u9)) here", ref_map) == \
        'see "the target" ((u9)) here'


def test_resolve_ref_texts_unknown_uid_untouched():
    from pkm.cli.render import resolve_ref_texts
    assert resolve_ref_texts("see ((zz)) here", {}) == "see ((zz)) here"


def test_resolve_ref_texts_nested_and_cyclic():
    from pkm.cli.render import resolve_ref_texts
    ref_map = {"a": {"text": "A says ((b))", "page_title": "P"},
               "b": {"text": "B says ((a))", "page_title": "P"}}
    out = resolve_ref_texts("root ((a))", ref_map)
    # a inlined; b inlined inside it; the cyclic ((a)) inside b stays bare
    assert out == 'root "A says "B says ((a))" ((b))" ((a))'


def test_render_page_resolve_refs():
    payload = {"page": PAGE["page"],
               "blocks": [_node("u1", "see ((u9))")],
               "backlinks": PAGE["backlinks"],
               "block_ref_texts": {"u9": {"text": "target",
                                          "page_title": "X"}}}
    out = render_page(payload, resolve_refs=True)
    assert '- see "target" ((u9))\n' in out
    assert "see ((u9))" in render_page(payload)  # default unchanged
```

Append to `server/tests/test_cli_main_read.py` (seed: `uid_b5` on
"July 7th, 2026" is `See ((uid_b3)) for details`):

```python
def test_get_resolve_refs_flag(run):
    code, out, _ = run("get", "July 7th, 2026", "--resolve-refs")
    assert code == 0
    assert '"[[Attention Is All You Need]] is a [[Paper]]" ((uid_b3))' in out
```

Append to `server/tests/test_mcp_server.py`:

```python
def test_get_page_resolve_refs(tools):
    out = tools.get_page("July 7th, 2026", resolve_refs=True)
    assert '"[[Attention Is All You Need]] is a [[Paper]]" ((uid_b3))' in out
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_cli_render.py tests/test_cli_main_read.py tests/test_mcp_server.py -q` → new tests FAIL (import error).

- [ ] **Step 3: Implement**

`cli/render.py`:

```python
import re

_REF_TOKEN = re.compile(r"\(\(([\w-]+)\)\)")


def resolve_ref_texts(text: str, ref_map: dict,
                      _seen: frozenset = frozenset()) -> str:
    """Inline ((uid)) tokens from `ref_map` (a payload's block_ref_texts)
    as '"resolved text" ((uid))' — text visible, uid kept for follow-up.
    Recurses into resolved text; a uid already being expanded stays a bare
    token, so ref cycles terminate. Unknown uids are left untouched."""
    def _sub(m: re.Match) -> str:
        uid = m.group(1)
        if uid in _seen or uid not in ref_map:
            return m.group(0)
        inner = resolve_ref_texts(ref_map[uid]["text"], ref_map,
                                  _seen | {uid})
        return f'"{inner}" (({uid}))'
    return _REF_TOKEN.sub(_sub, text)
```

`render_page` / `render_block` gain `resolve_refs: bool = False`; when set,
map block texts through `resolve_ref_texts(text, payload["block_ref_texts"])`.
Implement by giving `_bullets`/`_line` an optional
`resolve: Callable[[str], str] | None` (identity when None) — or rewrite the
node texts first with a small pure `_resolved(nodes, ref_map)` recursion;
either is fine, keep it pure.

`cli/main.py` — `cmd_get` passes `resolve_refs=args.resolve_refs` to both
`render_block` and `render_page` calls; parser gains (on the get subparser):

```python
    p.add_argument("--resolve-refs", action="store_true",
                   help="inline ((uid)) block refs as '\"text\" ((uid))'")
```

`mcp/server.py`:

```python
def get_page(title: str, resolve_refs: bool = False) -> str:
    """... existing docstring ... resolve_refs=True inlines ((uid)) block
    refs as '"referenced text" ((uid))'."""
    return render_page(_client().get_page(title), include_uids=True,
                       resolve_refs=resolve_refs)
```

(same for `get_block`.)

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_cli_render.py tests/test_cli_main_read.py tests/test_mcp_server.py -q` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/cli/render.py server/src/pkm/cli/main.py \
        server/src/pkm/mcp/server.py server/tests/test_cli_render.py \
        server/tests/test_cli_main_read.py server/tests/test_mcp_server.py .beans
git commit -m "pkm-roph: get --resolve-refs inlines block-ref text"
```

---

### Task 7: `pkm get --section / --depth`

**Files:**
- Modify: `server/src/pkm/cli/render.py` (pure filters + RenderError)
- Modify: `server/src/pkm/cli/main.py` (`cmd_get`, parser, error handling)
- Test: `server/tests/test_cli_render.py`, `server/tests/test_cli_main_read.py`

**Interfaces:**
- Produces: `RenderError(ValueError)`;
  `select_section(blocks: list[dict], spec: str) -> list[dict]` — spec is
  `"## Heading"` or bare text (leading `#{1,3} ` stripped); returns
  `[matching node]` (the first node, at any depth, whose text equals it);
  raises RenderError listing the page's headings when absent.
  `clip_depth(blocks: list[dict], depth: int) -> list[dict]` — keeps `depth`
  levels (depth 1 = top level only, children emptied); non-mutating.
- CLI: `pkm get PAGE --section "## H"` and `--depth N`, composable, applied
  to markdown AND `--json` output (blocks replaced, other keys kept).
  `--depth` also clips a uid-target's subtree; `--section` on a uid target
  is an error. `main()` catches RenderError like BuildError.

- [ ] **Step 1: Write failing tests**

Append to `server/tests/test_cli_render.py`:

```python
def test_select_section_and_clip_depth():
    from pkm.cli.render import RenderError, clip_depth, select_section
    import pytest
    blocks = PAGE["blocks"]
    [sec] = select_section(blocks, "## Papers")
    assert sec["uid"] == "u2"
    assert select_section(blocks, "Papers")[0]["uid"] == "u2"
    with pytest.raises(RenderError, match="Papers"):
        select_section(blocks, "## Missing")
    clipped = clip_depth(blocks, 1)
    assert clipped[1]["children"] == []
    assert PAGE["blocks"][1]["children"]  # original not mutated
```

Append to `server/tests/test_cli_main_read.py` (seed: page
"Machine Learning" has heading block `Papers` (uid_b2) with child uid_b3):

```python
def test_get_section(run):
    code, out, _ = run("get", "Machine Learning", "--section", "## Papers")
    assert code == 0
    assert "Tags:: #AI" not in out
    assert "- ## Papers" in out and "Attention" in out


def test_get_section_missing_lists_headings(run):
    code, _, err = run("get", "Machine Learning", "--section", "## Nope")
    assert code == 1
    assert "Papers" in err


def test_get_depth_clips_and_filters_json(run):
    code, out, _ = run("get", "Machine Learning", "--depth", "1", "--json")
    assert code == 0
    blocks = json.loads(out)["blocks"]
    assert all(b["children"] == [] for b in blocks)


def test_get_section_on_uid_is_error(run):
    code, _, err = run("get", "uid_b3", "--section", "## Papers")
    assert code == 1
    assert "page" in err
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_cli_render.py tests/test_cli_main_read.py -q` → new tests FAIL.

- [ ] **Step 3: Implement**

`cli/render.py`:

```python
class RenderError(ValueError):
    pass


def _walk(nodes: list[dict]):
    for n in nodes:
        yield n
        yield from _walk(n["children"])


def select_section(blocks: list[dict], spec: str) -> list[dict]:
    """The subtree rooted at the first block whose text equals `spec`
    ('## Heading' or bare text). Raises RenderError naming the page's
    headings when nothing matches."""
    text = re.sub(r"^#{1,3} ", "", spec)
    for n in _walk(blocks):
        if n["text"] == text:
            return [n]
    headings = ", ".join(n["text"] for n in _walk(blocks) if n["heading"])
    raise RenderError(f"no block titled {text!r} on the page"
                      f" (headings: {headings or 'none'})")


def clip_depth(blocks: list[dict], depth: int) -> list[dict]:
    """Copy `blocks` keeping `depth` levels (1 = top level only)."""
    if depth <= 0:
        return []
    return [{**n, "children": clip_depth(n["children"], depth - 1)}
            for n in blocks]
```

`cli/main.py` — in `cmd_get`, the uid branch: if `args.section`, print
`--section only applies to pages` to stderr and return 1; if `args.depth`,
replace the block with `clip_depth([payload["block"]], args.depth)[0]`
before emitting. Page branch:

```python
    payload = client.get_page(target)
    blocks = payload["blocks"]
    if args.section:
        blocks = select_section(blocks, args.section)
    if args.depth:
        blocks = clip_depth(blocks, args.depth)
    payload = {**payload, "blocks": blocks}
    _emit(payload, render_page(payload, args.uids,
                               resolve_refs=args.resolve_refs), args.json)
```

Parser (get subparser):

```python
    p.add_argument("--section", default=None, metavar='"## Heading"',
                   help="only the subtree under this heading/block text")
    p.add_argument("--depth", type=int, default=None,
                   help="clip nesting deeper than N levels")
```

`main()` except-clause: add `RenderError` to the caught tuple (import from
`pkm.cli.render`).

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_cli_render.py tests/test_cli_main_read.py -q` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/cli/render.py server/src/pkm/cli/main.py \
        server/tests/test_cli_render.py server/tests/test_cli_main_read.py .beans
git commit -m "pkm-roph: get --section/--depth subtree fetch"
```

---

### Task 8: token-lean output — minified --json, search limit 10, --compact

**Files:**
- Modify: `server/src/pkm/cli/main.py` (`_emit`, search parser default,
  `cmd_search`)
- Modify: `server/src/pkm/cli/render.py` (`render_search` compact)
- Test: `server/tests/test_cli_main_read.py`, `server/tests/test_cli_render.py`

**Interfaces:**
- Produces: `_emit` prints `json.dumps(data, separators=(",", ":"))` (single
  line) when `--json`; CLI search `--limit` default becomes 10;
  `render_search(payload, compact=False)` — compact keeps the
  `## Pages`/`## Blocks` headers but block lines become
  `- [page_title] ^uid` (no snippet).
- CLI `pkm search TERM --compact`.

- [ ] **Step 1: Write failing tests**

Append to `server/tests/test_cli_render.py`:

```python
def test_render_search_compact():
    payload = {"pages": [{"id": 1, "title": "AI"}],
               "blocks": [{"uid": "u1", "page_title": "ML",
                           "snippet": "…<mark>hit</mark>…"}]}
    assert render_search(payload, compact=True) == (
        "## Pages\n"
        "- AI\n"
        "\n"
        "## Blocks\n"
        "- [ML] ^u1\n")
```

Append to `server/tests/test_cli_main_read.py`:

```python
def test_json_output_is_minified(run):
    code, out, _ = run("get", "Machine Learning", "--json")
    assert code == 0
    assert out.startswith('{"page":')
    assert '": ' not in out  # no space after separators = minified
    assert "\n" not in out.rstrip("\n")


def test_search_default_limit_is_10():
    from pkm.cli.main import build_parser
    args = build_parser().parse_args(["search", "x"])
    assert args.limit == 10


def test_search_compact(run):
    code, out, _ = run("search", "Papers", "--compact")
    assert code == 0
    assert "^uid_b2" in out
    assert "<mark>" not in out
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_cli_render.py tests/test_cli_main_read.py -q` → new tests FAIL.

- [ ] **Step 3: Implement**

`cli/main.py`:

```python
def _emit(data: dict, rendered: str, as_json: bool) -> None:
    # minified: agent loops resend tool output every turn (pkm-roph)
    print(json.dumps(data, separators=(",", ":")) if as_json else rendered,
          end="")
    if as_json:
        print()
```

`cmd_search` passes `compact=args.compact` to `render_search`; search
parser: `--limit` default 10, plus

```python
    p.add_argument("--compact", action="store_true",
                   help="titles and uids only, no snippets")
```

`cli/render.py`:

```python
def render_search(payload: dict, compact: bool = False) -> str:
    if not payload["pages"] and not payload["blocks"]:
        return "no results\n"
    lines = ["## Pages"]
    lines.extend(f"- {p['title']}" for p in payload["pages"])
    lines.append("")
    lines.append("## Blocks")
    if compact:
        lines.extend(f"- [{b['page_title']}] ^{b['uid']}"
                     for b in payload["blocks"])
    else:
        lines.extend(f"- [{b['page_title']}] {b['snippet']}"
                     for b in payload["blocks"])
    return "\n".join(lines) + "\n"
```

Check other `_emit` JSON assertions in `tests/test_cli_main_read.py` /
`test_cli_main_write.py` still pass (they parse with `json.loads`, so
minification is transparent).

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_cli_render.py tests/test_cli_main_read.py tests/test_cli_main_write.py -q` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/cli/main.py server/src/pkm/cli/render.py \
        server/tests/test_cli_render.py server/tests/test_cli_main_read.py .beans
git commit -m "pkm-roph: minified --json, search --compact, default limit 10"
```

---

### Task 9: batch `index` on create/todo + `{{alias}}` as uid

**Files:**
- Modify: `server/src/pkm/cli/build.py` (`_Planner.creates`, `plan_batch`)
- Test: `server/tests/test_cli_build.py`

**Interfaces:**
- Produces: batch `create`/`todo` params accept optional `index` (int) —
  becomes the created op's `order_idx` verbatim (the server splices
  siblings ≥ idx on insert); nested outline children are unaffected.
  `update`/`move`/`delete` `uid` params accept `"{{alias}}"` (resolved via
  the batch's aliases; unknown alias raises BuildError).
- `plan_batch` signature unchanged.

- [ ] **Step 1: Write failing tests** (append to `server/tests/test_cli_build.py`)

```python
def test_plan_batch_create_with_index():
    cmds = [{"command": "create",
             "params": {"page": "Machine Learning", "text": "top",
                        "index": 0}}]
    ops = plan_batch(cmds, {"Machine Learning": PAYLOAD}, uid_gen())
    assert ops[0]["order_idx"] == 0
    assert ops[0]["parent_uid"] is None


def test_plan_batch_todo_with_index_under_parent():
    cmds = [{"command": "todo",
             "params": {"page": "Machine Learning", "parent": "((u2))",
                        "text": "urgent", "index": 0}}]
    ops = plan_batch(cmds, {"Machine Learning": PAYLOAD}, uid_gen())
    assert ops[0]["order_idx"] == 0
    assert ops[0]["parent_uid"] == "u2"
    assert ops[0]["text"] == "{{TODO}} urgent"


def test_plan_batch_alias_as_uid():
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "x", "as": "n"}},
        {"command": "move",
         "params": {"uid": "{{n}}", "page": "Machine Learning",
                    "parent": "((u2))", "index": 0}},
        {"command": "update", "params": {"uid": "{{n}}", "text": "y"}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": PAYLOAD}, uid_gen())
    assert ops[1]["op"] == "move" and ops[1]["uid"] == ops[0]["uid"]
    assert ops[2] == {"op": "update_text", "uid": ops[0]["uid"], "text": "y"}


def test_plan_batch_alias_as_uid_unknown_raises():
    with pytest.raises(BuildError, match="unknown alias"):
        plan_batch([{"command": "delete", "params": {"uid": "{{ghost}}"}}],
                   {}, uid_gen())
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_cli_build.py -q` → new tests FAIL
(index ignored → order_idx 2; `{{n}}` passed through as a literal uid).

- [ ] **Step 3: Implement**

`build.py` — `_Planner.creates` gains `index: int | None = None`, used for
the first depth-0 item only (later top-level items in the same call keep
appending — only single-item create/todo pass it):

```python
    def creates(self, payload, page, parent_spec, items, todo,
                in_batch=frozenset(), index=None):
        ...
        first = True
        for depth, text in items:
            ...
            if depth == 0 and first and index is not None:
                idx = index
            else:
                idx = self.bump(payload, page, target,
                                in_batch | frozenset(created))
            first = False
            ...
```

(Docstring note: `index` is passed straight through as `order_idx`; the
server splices siblings on insert. Mixing indexed creates and appends under
the same parent in one batch may interleave — documented in `pkm batch
--help`.)

`plan_batch`:

- alias-as-uid helper (near `_resolve_alias`):

```python
def _alias_uid(value: str, aliases: dict[str, str]) -> str:
    m = _ALIAS_SPEC.match(value)
    if m:
        if m.group(1) not in aliases:
            raise BuildError(f"unknown alias: {m.group(1)}")
        return aliases[m.group(1)]
    return value
```

- `create`/`todo` branch passes `index=params.get("index")` to
  `planner.creates`.
- `update`/`move`/`delete` branches resolve
  `uid = _alias_uid(params["uid"], aliases)` and use `uid` in the op dicts.

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_cli_build.py tests/test_cli_main_write.py -q` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/cli/build.py server/tests/test_cli_build.py .beans
git commit -m "pkm-roph: batch create index + {{alias}} as uid"
```

---

### Task 10: full --help audit

**Files:**
- Modify: `server/src/pkm/cli/main.py` (`build_parser` only)
- Test: `server/tests/test_cli_help.py` (new)

**Interfaces:**
- Consumes: all flags from Tasks 5-9 (they must exist first).
- Produces: every subparser built with
  `formatter_class=argparse.RawDescriptionHelpFormatter` and an `epilog`
  containing a worked example; `pkm batch --help` embeds the full command
  reference.

- [ ] **Step 1: Write failing tests** (create `server/tests/test_cli_help.py`)

```python
import pytest

from pkm.cli.main import main

VERBS = ["login", "get", "search", "refs", "query", "todos",
         "save", "update", "upload", "batch"]


@pytest.mark.parametrize("verb", VERBS)
def test_every_verb_help_has_example(verb, capsys):
    with pytest.raises(SystemExit):
        main([verb, "--help"])
    out = capsys.readouterr().out
    assert "example" in out.lower(), f"{verb} --help has no example"


def test_batch_help_is_self_sufficient(capsys):
    with pytest.raises(SystemExit):
        main(["batch", "--help"])
    out = capsys.readouterr().out
    for needle in ["create", "todo", "update", "move", "delete", "outline",
                   "as", "{{alias}}", "index", "## Heading", "((uid))",
                   '"command"', "params"]:
        assert needle in out, f"batch --help missing {needle!r}"


def test_get_help_documents_target_forms(capsys):
    with pytest.raises(SystemExit):
        main(["get", "--help"])
    out = capsys.readouterr().out
    for needle in ["today", "uid", "--section", "--depth", "--resolve-refs"]:
        assert needle in out
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_cli_help.py -q` → FAIL (no epilogs yet).

- [ ] **Step 3: Implement**

In `build_parser`, add a small helper and give every subparser an epilog.
Content requirements (write real prose, one epilog per verb):

- **login**: example with `--url`; note `--password-stdin` for scripts.
- **get**: target forms (page title, `today`/`yesterday`/`tomorrow`,
  12-char uid); flags `--uids`, `--resolve-refs`, `--section`, `--depth`,
  `--json`; example: `pkm get "Machine Learning" --section "## Papers" --depth 2`.
- **search**: exact vs default prefix matching; `--compact`; example.
- **refs**: what backlinks are; example.
- **query**: syntax `{and: [[A]] [[B]]}`, `{or: ...}`, `{not: ...}` (not
  only inside and); `--expand` one-hop semantics; empty results include
  per-ref counts; example.
- **todos**: example with `-p`.
- **save**: outline via multi-line text/stdin (2-space indent), `--parent`
  forms `"## Heading"` (created if missing) / `"((uid))"`, `--todo`; example.
- **update**: exactly one of TEXT/-D/-T; hash-guarded (conflict → re-get);
  example.
- **upload**: mime handling (image embed / pdf macro / link), `--no-block`;
  example.
- **batch**: the full op reference — JSON array of `{"command": ...,
  "params": {...}}`; commands `create` (page, text, parent?, index?, as?),
  `todo` (same, {{TODO}}-prefixed), `update` (uid, text), `move` (uid, page,
  parent?, index?), `delete` (uid), `outline` (page, parent?, items: nested
  string arrays); parent forms `"## Heading"` / `"((uid))"` / `"{{alias}}"`;
  `"as"` names a created block, later `parent`/`uid` params may use
  `"{{alias}}"`; repeated missing `"## Heading"` on one page creates one
  heading; `index` inserts at that position (server shifts siblings); avoid
  mixing indexed creates and appends under one parent in one batch; a full
  worked JSON example (heredoc style).

Pattern:

```python
    p = sub.add_parser(
        "batch",
        help="apply a JSON array of commands from stdin atomically",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_BATCH_EPILOG)
```

with the epilog texts as module-level `_X_EPILOG` string constants (keeps
`build_parser` readable).

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_cli_help.py -q` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/cli/main.py server/tests/test_cli_help.py .beans
git commit -m "pkm-roph: self-sufficient --help for every verb"
```

---

### Task 11: docs, type regen, full verification

**Files:**
- Modify: `README.md` ("CLI and MCP access" section)
- Modify: `.claude/skills/pkm/SKILL.md`
- Regenerate: `web/src/api/types.d.ts` (`pnpm gen-types`)
- Modify: bean `pkm-roph` (Summary of Changes, status)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Regenerate TS types**

Run (from `web/`): `pnpm gen-types` — commit the `types.d.ts` diff
(QueryPayload + new params).

- [ ] **Step 2: Update README CLI section**

Document: `search --exact/--compact` (and the new default limit 10),
`query --expand` + ref-count hints, `get --resolve-refs/--section/--depth`,
batch `index` + alias-as-uid, minified `--json`.

- [ ] **Step 3: Update `.claude/skills/pkm/SKILL.md`**

Same surface, in the read/write verb tables; keep it terse (one line per
flag). Mention that `--json` is minified and `--help` is self-sufficient.

- [ ] **Step 4: Full verification**

- `cd server && uv run pytest -q` → all pass, coverage gate green
- `cd server && uv run pyrefly check` → clean
- `cd server && uv run ruff check` → clean
- `cd web && pnpm verify` → typecheck + unit coverage + Playwright green

- [ ] **Step 5: Bean + commit**

Tick remaining bean checkboxes, add `## Summary of Changes`, set status
completed (`beans update pkm-roph -s completed`).

```bash
git add README.md .claude/skills/pkm/SKILL.md web/src/api/types.d.ts .beans
git commit -m "pkm-roph: docs + regenerated types; bean complete"
```
