# PKM Traversal, Reference, and Section Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the non-title work in `pkm-8kw2` and all of `pkm-dzgw`: uncapped cycle-safe traversal, blank-reference parity, and level-aware marked section selection.

**Architecture:** Existing server and replica SQL shells adopt the visited-path recursive CTE already used by `ops_apply.py`. Reference filtering and section matching stay pure. Shared JSON fixtures define Python/TypeScript ref behavior; real replica tests prove persistence behavior.

**Tech Stack:** Python 3.12, SQLite recursive CTEs, pytest, TypeScript, sqlite-wasm, Vitest, pnpm.

## Global Constraints

- Execute after the title-integrity lane, because both modify `refs.py`, `routes_pages.py`, `localOps.ts`, docs, and `pkm-8kw2`.
- Do not change migration, activation, or broadcast behavior in this lane.
- Depth tests cover `100`, `101`, `102`, and `150`.
- Blank filtering drops `[[   ]]` but preserves nonblank padding byte-for-byte while canonicalization is inactive.
- No API shape changes occur in this lane; do not regenerate OpenAPI/type files.
- Preserve FCIS classifications.
- Invoke `superpowers:writing-skills` before editing `.claude/skills/pkm/SKILL.md`.

---

### Task 1: Complete and cycle-safe server ancestor reads

**Files:**
- Modify: `server/src/pkm/server/routes_pages.py`
- Modify: `server/tests/test_hardening.py`
- Modify: `.beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md`

**Interface:** Preserve:
```python
def _fetch_ancestors(db: sqlite3.Connection, uids: list[str]) -> dict[str, list[str]]: ...
```

- [ ] **Step 1: Write boundary and exact-cycle RED tests**

  Seed linear chains of depths 100, 101, 102, and 150. For `GET /api/block/{leaf}`, assert every ancestor’s text appears root-first. Strengthen the corrupt-cycle test to assert each ancestor once and starting UID never as its own ancestor.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_hardening.py -k ancestor`  
  Expected: deep cases truncate and cyclic output repeats until the cap.

- [ ] **Step 2: Replace the cap with visited-path SQL**

  ```sql
  WITH RECURSIVE anc(start_uid, uid, parent_uid, text, depth, path) AS (
    SELECT uid, uid, parent_uid, text, 0, ',' || uid || ','
      FROM blocks WHERE uid IN (...)
    UNION ALL
    SELECT a.start_uid, b.uid, b.parent_uid, b.text, a.depth + 1,
           a.path || b.uid || ','
      FROM anc a JOIN blocks b ON b.uid = a.parent_uid
     WHERE instr(a.path, ',' || b.uid || ',') = 0
  )
  SELECT start_uid, text, depth FROM anc
   WHERE depth > 0 ORDER BY start_uid, depth DESC
  ```

  Document that UID grammar excludes commas and depth remains only for ordering.

- [ ] **Step 3: Verify, update bean item, and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_hardening.py -k ancestor
  uv run pyrefly check
  uv run ruff check
  cd ..
  beans update pkm-8kw2 --body-replace-old "- [ ] Decide read-path ancestors cap (raise/remove/document)" --body-replace-new "- [x] Decide read-path ancestors cap (removed; traversal is complete and cycle-safe)"
  git add server/src/pkm/server/routes_pages.py server/tests/test_hardening.py .beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md
  git commit -m "fix(pkm-8kw2): make server ancestor reads complete"
  ```

### Task 2: Complete optimistic subtree enumeration

**Files:**
- Modify: `web/src/replica/localOps.ts`
- Modify: `web/src/replica/localOps.test.ts`
- Modify: `pkm-8kw2` bean

**Interface:** Export the existing seam:
```typescript
export function subtreeUids(db: ReplicaDb, uid: string): string[];
```
It returns every subtree UID deepest-first, each once.

- [ ] **Step 1: Export the current helper without behavior change**

  Run `cd web && pnpm vitest run src/replica/localOps.test.ts`; existing tests remain green.

- [ ] **Step 2: Write RED tests**

  Add chain helper and parameterized 100/101/102/150 enumeration tests, corrupt-cycle uniqueness, 150-block cross-page move (every page ID changes), and 150-block delete (no row survives).

  Run: `cd web && pnpm vitest run src/replica/localOps.test.ts`  
  Expected: deep/cycle/move failures; delete may expose cascade behavior and remains a regression guard if already green.

- [ ] **Step 3: Implement visited-path subtree SQL**

  ```sql
  WITH RECURSIVE sub(uid, path, depth) AS (
    SELECT uid, ',' || uid || ',', 0 FROM blocks WHERE uid = ?
    UNION ALL
    SELECT b.uid, s.path || b.uid || ',', s.depth + 1
      FROM sub s JOIN blocks b ON b.parent_uid = s.uid
     WHERE instr(s.path, ',' || b.uid || ',') = 0
  )
  SELECT uid FROM sub ORDER BY depth DESC
  ```

- [ ] **Step 4: Verify, check bean item, and commit**

  ```bash
  cd web
  pnpm vitest run src/replica/localOps.test.ts
  pnpm typecheck
  pnpm lint
  pnpm check:fcis
  cd ..
  beans update pkm-8kw2 --body-replace-old "- [ ] Align localOps.ts subtree traversal with the server's cycle-safe complete traversal" --body-replace-new "- [x] Align localOps.ts subtree traversal with complete cycle-safe traversal"
  git add web/src/replica/localOps.ts web/src/replica/localOps.test.ts .beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md
  git commit -m "fix(pkm-8kw2): make local subtree traversal complete"
  ```

### Task 3: Complete local-API ancestor reads

**Files:**
- Modify: `web/src/replica/localApi/tree.ts`
- Create: `web/src/replica/localApi/tree.test.ts`

**Interface:** Preserve:
```typescript
export function fetchAncestors(db: ReplicaDb, uids: string[]): Map<string, string[]>;
```

- [ ] **Step 1: Write real-sqlite RED tests**

  In node Vitest environment, seed chains at all four depths and assert root-first text for each leaf. Seed a five-node cycle and assert four unique ancestors without the starting UID.

  Run: `cd web && pnpm vitest run src/replica/localApi/tree.test.ts`  
  Expected: deep truncation and cycle repetition.

- [ ] **Step 2: Use the server-equivalent visited-path CTE**

  Keep `start_uid`, `depth`, and root-first ordering; replace only cap termination with path membership.

- [ ] **Step 3: Verify and commit**

  ```bash
  cd web
  pnpm vitest run src/replica/localApi/tree.test.ts src/replica/localApi/parity.test.ts
  pnpm typecheck
  pnpm check:fcis
  cd ..
  git add web/src/replica/localApi/tree.ts web/src/replica/localApi/tree.test.ts
  git commit -m "fix(pkm-8kw2): make local ancestor reads complete"
  ```

### Task 4: Drop blank refs in both pure extractors

**Files:**
- Modify: `shared/fixtures/ref_grammar.json`
- Modify: `server/src/pkm/refs_parity_dump.py`
- Modify: `server/src/pkm/refs.py`
- Modify: `server/src/pkm/server/store.py` docstring only
- Modify: `web/src/grammar/refs.ts`
- Regenerate: `shared/fixtures/refs_parity.json`
- Modify: `web/src/replica/localOps.test.ts`
- Modify: `pkm-8kw2` bean

**Interfaces:** Preserve Python `extract(text) -> ParsedRefs` and TS `extractRefs(text): ParsedRefs`.

- [ ] **Step 1: Add desired fixture and local persistence RED test**

  Fixture:
  ```json
  {
    "name": "plain-space blank is dropped while padded nonblank survives",
    "text": "skip [[   ]] but keep [[ Valid ]]",
    "refs": [{"title": " Valid ", "kind": "link"}],
    "block_refs": [],
    "embeds": 0
  }
  ```

  Add parity source case and local op test asserting `[[   ]]` creates no blank page/ref while `[[Valid Page]]` in the same block indexes normally.

- [ ] **Step 2: Run cross-language RED tests**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_refs.py
  cd ../web
  pnpm vitest run src/grammar/refs.test.ts src/replica/refs.test.ts src/replica/localOps.test.ts
  ```

  Expected: both extractors retain the blank target and local indexing attempts a blank page.

- [ ] **Step 3: Implement blank predicates without altering valid output**

  Python:
  ```python
  normalized = normalize_title(title)
  if not is_blank_title(normalized):
      refs.append(Ref(normalized, "tag" if is_tag else "link"))
  ```

  TypeScript:
  ```typescript
  if (r.title.trim() === "") return false;
  ```

  Update store docstring: extractor filters blanks; `BlankTitleError` catch remains defense in depth; valid padded titles remain exact.

- [ ] **Step 4: Regenerate fixture, verify, update bean, and commit**

  ```bash
  cd server
  uv run python -m pkm.refs_parity_dump > ../shared/fixtures/refs_parity.json
  uv run pytest -q -o addopts='' tests/test_refs.py tests/test_refs_parity_fixture.py tests/test_blank_titles.py
  cd ../web
  pnpm vitest run src/grammar/refs.test.ts src/replica/refs.test.ts src/replica/localOps.test.ts
  pnpm typecheck
  pnpm check:fcis
  cd ..
  beans update pkm-8kw2 --body-replace-old "- [ ] Align TS extractRefs blank-ref handling with server extract() + BlankTitleError skip" --body-replace-new "- [x] Align Python/TS extractors and local indexing for blank references"
  git add shared/fixtures/ref_grammar.json shared/fixtures/refs_parity.json server/src/pkm/refs.py server/src/pkm/refs_parity_dump.py server/src/pkm/server/store.py web/src/grammar/refs.ts web/src/replica/localOps.test.ts .beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md
  git commit -m "fix(pkm-8kw2): align blank reference extraction"
  ```

### Task 5: Level-aware marked sections with lenient bare compatibility

**Files:**
- Modify: `server/src/pkm/cli/render.py`
- Modify: `server/src/pkm/cli/main.py`
- Modify: `server/tests/test_cli_render.py`
- Modify: `server/tests/test_cli_main_read.py`
- Modify: `server/tests/test_cli_help.py`
- Modify: `.beans/pkm-dzgw--pkm-get-section-ignores-requested-heading-level.md`

**Interface:** Preserve:
```python
def select_section(blocks: Sequence[BlockNode], spec: str) -> list[BlockNode]: ...
```

- [ ] **Step 1: Mark bean in progress and write RED tests**

  Seed document-order collisions: plain `Notes`, H3 `Notes`, two H2 `Notes`. Assert `## Notes` picks first H2, `### Notes` picks H3, bare `Notes` picks plain first, duplicate H2 follows document order, and `# Notes` raises with available marked headings. Add CLI integration and help assertions for “level and exact text”, “bare text”, and “regardless of heading”.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_cli_render.py tests/test_cli_main_read.py tests/test_cli_help.py`  
  Expected: marker is stripped, wrong block selected, unmarked error list, incomplete help.

- [ ] **Step 2: Implement pure matching**

  ```python
  _SECTION_MARKER = re.compile(r"^(#{1,3}) (.*)$")

  marked = _SECTION_MARKER.fullmatch(spec)
  heading = len(marked.group(1)) if marked else None
  text = marked.group(2) if marked else spec
  for node in _walk(blocks):
      if node.text == text and (heading is None or node.heading == heading):
          return [node]
  ```

  On miss, list `#` markers with heading text in document order. Update docstring and CLI epilog/argument help with marked and bare semantics.

- [ ] **Step 3: Verify behavior and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_cli_render.py tests/test_cli_main_read.py tests/test_cli_help.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  beans update pkm-dzgw --body-replace-old "- [ ] Decide: honor level when a marker is supplied, or document that markers are stripped" --body-replace-new "- [x] Honor level and exact text for marked specs; preserve bare exact-text matching"
  git add server/src/pkm/cli/render.py server/src/pkm/cli/main.py server/tests/test_cli_render.py server/tests/test_cli_main_read.py server/tests/test_cli_help.py .beans/pkm-dzgw--pkm-get-section-ignores-requested-heading-level.md
  git commit -m "fix(pkm-dzgw): honor marked section heading levels"
  ```

### Task 6: Documentation, bean completion, and lane verification

**Files:**
- Modify: `README.md`
- Modify: `.claude/skills/pkm/SKILL.md`
- Modify: `docs/architecture/backend.md`
- Modify: `docs/architecture/sync-and-offline.md`
- Modify: `pkm-8kw2` and `pkm-dzgw` beans

- [ ] **Step 1: Invoke `superpowers:writing-skills` and test the current PKM skill**

  Ask a fresh agent how to select first exact-text `Notes` regardless of heading versus specifically H2 `Notes`; current skill should fail to explain both forms.

- [ ] **Step 2: Update user and architecture docs**

  README/skill show both `--section "## H"` and `--section "H"`. Backend documents extractor blankness, defense in depth, fixtures, and section modes. Sync docs state both local traversal functions are uncapped visited-path CTEs and cycle-safe.

- [ ] **Step 3: Retest the skill and complete beans**

  Fresh agent must recommend bare `Notes` for heading-agnostic selection and `## Notes` for H2. Append accurate summaries. Complete `pkm-dzgw`. Complete `pkm-8kw2` only if its broadcast item was already checked by the title lane and no unchecked tasks remain.

- [ ] **Step 4: Run focused lane gates**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_hardening.py tests/test_refs.py tests/test_refs_parity_fixture.py tests/test_blank_titles.py tests/test_cli_render.py tests/test_cli_main_read.py tests/test_cli_help.py
  uv run pyrefly check
  uv run ruff check
  cd ../web
  pnpm vitest run src/replica/localOps.test.ts src/replica/localApi/tree.test.ts src/replica/localApi/parity.test.ts src/grammar/refs.test.ts src/replica/refs.test.ts
  pnpm typecheck
  pnpm lint
  pnpm check:fcis
  ```

- [ ] **Step 5: Commit docs and bean statuses**

  ```bash
  cd ..
  git add README.md .claude/skills/pkm/SKILL.md docs/architecture/backend.md docs/architecture/sync-and-offline.md .beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md .beans/pkm-dzgw--pkm-get-section-ignores-requested-heading-level.md
  git commit -m "docs(pkm-mk87): document traversal refs and sections"
  ```
