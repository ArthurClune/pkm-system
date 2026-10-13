# Page Delete Unlinks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deleting a page rewrites every inbound reference to it into plain text and inlines `((refs))` into its blocks, refuses when a query or an attribute-position link names it, and keeps linked daily notes out of the journal cleanup.

**Architecture:** A new functional-core module `pkm/unlink.py` owns the text rewrites and the delete plan (what changes, what blocks). `store.py` gains a shell that snapshots, plans, applies (update + replay record + reindex) and deletes inside the route's write lock, on rename's pattern. `block_rewrites` gains a `kind` so stale offline edits replay an unlink or an inline as they already replay a rename. The web delete action asks a new preview route first and either shows a blocked list or a confirm with counts.

**Tech Stack:** Python 3 / FastAPI / SQLite (server, pytest, pyrefly, ruff); React + TypeScript (web, vitest, Playwright).

**Spec:** `docs/superpowers/specs/2026-10-13-page-delete-unlinks-design.md` (bean pkm-wlkh)

## Global Constraints

- Work only in `/Users/arthur/code/llm/pkm/.claude/worktrees/page-delete-unlinks` (branch `feature/page-delete-unlinks`). Never `cd` into `/Users/arthur/code/llm/pkm` itself.
- Every new file with runtime behaviour starts with `# pattern: Functional Core` or `# pattern: Imperative Shell`. `pkm/unlink.py` is Functional Core: no DB, no clock.
- No bean ids in code or test comments; comments state the rule they enforce.
- Every rewritten block goes through `store.reindex_refs_for_text` in the same transaction (spec anti-goal).
- Unlinked spellings: `[[A]]` -> `A`; `#A` -> `A`; `#[[A]]` -> `A`; `[label]([[A]])` -> `label`. Code spans and fences are never rewritten.
- A copy for a `((ref))`: target text with a leading task marker removed (`todo.with_state(text, None)`), then a leading `Name::` removed, newlines folded (every whitespace run containing a newline -> one space), refs back into the deleted page inlined one level deep, anything still pointing into it -> `""`, and the deleted title unlinked. Children are not copied.
- Blockers (refuse, no override): a query macro (`export.resolve.find_query_macros`) whose expression refs the page; a link whose unlinking would create the attribute `Title::`.
- Any route/model change regenerates `web/src/api/openapi.json` and `types.d.ts` in the same commit: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; never a Claude session URL.

## Review Focus

1. A block that both links `[[A]]` and refs `((uid))` into A's page: rewritten once, both applied, one reindex (Task 3 test `test_delete_block_with_link_and_ref_is_rewritten_once`).
2. A ref cycle: a ref target on the deleted page whose own text refs back into the page (incl. itself) ends as text with no `((...))` into the page (Task 1 test `test_plan_copy_cycle_ends_empty`).
3. Case and spelling: deleting `AI` leaves `[[ai]]` (a different page) alone and catches `#AI`, `#[[AI]]`, `[x]([[AI]])`, while `[[ AI ]]` (a padded, distinct title) stays (Task 1 tests).
4. A query or `[[A]]::` inside a code span is not a blocker and is not rewritten (Task 1 test `test_blockers_ignore_code`).
5. A stale offline edit pushed after a delete *and* a later rename of another page in the same block replays both steps in order (Task 2 test `test_replay_chains_unlink_then_retitle`).

---

### Task 1: Pure delete rewriter and planner

**Files:**
- Create: `server/src/pkm/unlink.py`
- Test: `server/tests/test_unlink.py`

**Interfaces:**
- Consumes: `pkm.refs` (`strip_code`, `bracket_spans`, `tag_spans`, `attribute_title_span`, `normalize_title`, `extract`, `BLOCK_REF_TOKEN`), `pkm.todo.with_state`, `pkm.export.resolve.find_query_macros`.
- Produces:
  - `TitleMatch = Callable[[str], bool]` — given a title as written, is it the deleted page.
  - `unlink_title_refs(text: str, is_target: TitleMatch) -> str`
  - `inline_block_refs(text: str, copies: Mapping[str, str]) -> str` — replaces `((uid))` and a whole `{{embed: ((uid))}}` / `{{[[embed]]: ((uid))}}` macro for each uid in `copies`; other uids untouched.
  - `plain_copy(text: str) -> str` — marker, leading attribute, newline folding (no ref handling).
  - `apply_delete_rewrite(text: str, is_target: TitleMatch, copies: Mapping[str, str]) -> str` = `unlink_title_refs(inline_block_refs(text, copies), is_target)`.
  - `BlockerReason = Literal["query", "attribute"]`
  - `@dataclass(frozen=True) class DeleteBlocker: uid: str; page_title: str; text: str; reason: BlockerReason`
  - `@dataclass(frozen=True) class SourceBlock: uid: str; page_title: str; text: str`
  - `@dataclass(frozen=True) class DeletePlan: rewrites: Mapping[str, str]` (uid -> new text, changed blocks only); `unlinked: frozenset[str]` (uids whose links changed); `inlined: Mapping[str, Mapping[str, str]]` (uid -> {target uid: copy} actually applied); `links: int; link_pages: int; block_refs: int; block_ref_pages: int; blockers: tuple[DeleteBlocker, ...]`
  - `plan_page_delete(is_target: TitleMatch, page_blocks: Mapping[str, str], sources: Sequence[SourceBlock]) -> DeletePlan` — `page_blocks` is uid -> text of the deleted page; `sources` is every block on other pages that links the page or refs into it (deduplicated by the caller).

- [ ] **Step 1: Write the failing tests** in `server/tests/test_unlink.py`, using `is_ai = lambda raw: normalize_title(raw) == "AI"`:

```python
@pytest.mark.parametrize("text,expected", [
    ("see [[AI]] now", "see AI now"),
    ("#AI rules", "AI rules"),
    ("#[[AI]] rules", "AI rules"),
    ("[the field]([[AI]])", "the field"),
    ("[[ AI ]]", "[[ AI ]]"),        # padded title is a different page
    ("[[ai]] and [[AI]]", "[[ai]] and AI"),
    ("`[[AI]]` and [[AI]]", "`[[AI]]` and AI"),
    ("Tags:: #AI", "Tags:: AI"),
    ("AI:: value", "AI:: value"),    # attribute left as it is
])
def test_unlink_title_refs(text, expected): ...

def test_inline_block_refs_replaces_ref_and_embed():
    copies = {"uid_x1": "copied"}
    assert inline_block_refs("a ((uid_x1)) b {{embed: ((uid_x1))}} c "
                             "{{[[embed]]: ((uid_x1))}} ((uid_y1))", copies) \
        == "a copied b copied c copied ((uid_y1))"

def test_plain_copy_strips_marker_attribute_and_newlines():
    assert plain_copy("{{[[TODO]]}} Status:: line one\n  line two") \
        == "line one line two"

def test_plan_counts_and_rewrites():
    # page "AI": blocks p1 "[[Paper]] about AI", p2 "inner ((p1))"
    # sources: s1 on Notes "[[AI]] and ((p1))", s2 on Log "#AI", s3 on Log "see ((p2))"
    plan = plan_page_delete(is_ai, {"p1": "[[Paper]] about AI", "p2": "inner ((p1))"}, [...])
    assert plan.rewrites == {"s1": "AI and [[Paper]] about AI",
                             "s2": "AI",
                             "s3": "see inner [[Paper]] about AI"}
    assert (plan.links, plan.link_pages) == (2, 2)
    assert (plan.block_refs, plan.block_ref_pages) == (2, 2)
    assert plan.blockers == ()

def test_plan_copy_cycle_ends_empty():
    # p1 "a ((p2))", p2 "b ((p1))"; source s1 "x ((p1))" -> "x a b "
    ...  # assert no "((p1))"/"((p2))" remains in plan.rewrites["s1"]

def test_blockers_query_and_attribute_position():
    plan = plan_page_delete(is_ai, {}, [
        SourceBlock("q1", "Q", "{{query: {and: [[AI]] [[Paper]]}}}"),
        SourceBlock("a1", "A", "[[AI]]:: value"),
        SourceBlock("ok", "B", "fine [[AI]]")])
    assert [(b.uid, b.reason) for b in plan.blockers] == [("q1", "query"), ("a1", "attribute")]

def test_blockers_ignore_code():
    plan = plan_page_delete(is_ai, {}, [SourceBlock("c1", "C", "`{{query: {and: [[AI]]}}}` [[AI]]")])
    assert plan.blockers == ()
```

- [ ] **Step 2: Run** `cd server && uv run pytest tests/test_unlink.py -q` — expect ImportError.
- [ ] **Step 3: Implement `server/src/pkm/unlink.py`.** Reuse `rename.py`'s walk shape (`_rewrite_range`: outer match wins, unmatched runs descended), but splice the run's inner text; for an `is_tag` run widen the span one character left to take the `#`; for an alias, if `clean[:bracket.start]` ends with `](` matched by `\[([^\[\]\n]*)\]\($` and `clean[bracket.end] == ")"`, splice from the `[` to past the `)` with the label. The attribute span is never touched. `plan_page_delete`: link counts come from sources whose `extract().refs` match `is_target`; block-ref counts from `extract().block_refs` in `page_blocks`; copies are built per target as `plain_copy` → `inline_block_refs` one level with copies of page blocks (themselves only `plain_copy`'d) → `inline_block_refs` with `""` for anything still in `page_blocks` → `unlink_title_refs`. Attribute blocker: `attribute_title_span(strip_code(text))` does not match the target before, and does match after `apply_delete_rewrite`. Query blocker: any `find_query_macros(strip_code(text))` expression whose `extract(expr).refs` match the target.
- [ ] **Step 4: Run** the tests — PASS; then `uv run ruff check src/pkm/unlink.py tests/test_unlink.py && uv run pyrefly check`.
- [ ] **Step 5: Commit** `feat(pkm-wlkh): pure page-delete rewriter and planner`.

### Task 2: Replayable unlink and inline rewrites

**Files:**
- Modify: `server/src/pkm/schema.py:203-223` (`block_rewrites`), `server/src/pkm/server/db.py:22-34` (`_ensure_schema_migrations`), `server/src/pkm/server/ops_core.py:79-141` (`BlockRewrite`, `_rewrite_steps`, `replay_title_rewrites`), `server/src/pkm/server/ops_apply.py:91-101` (`_block_rewrites`), `server/src/pkm/server/store.py:147-174` (`_record_block_rewrite` writes `kind='retitle'`).
- Test: `server/tests/test_ops_core.py`, `server/tests/test_db.py` (or wherever `view_type` migration is tested — grep `ADD COLUMN view_type`).

**Interfaces:**
- Consumes: Task 1 `apply_delete_rewrite`, `TitleMatch`.
- Produces:
  - column `block_rewrites.kind TEXT NOT NULL DEFAULT 'retitle' CHECK(kind IN ('retitle','unlink','inline'))`. Row meaning: `retitle` old_title→new_title; `unlink` old_title = deleted page title, new_title = `''`; `inline` old_title = target uid, new_title = the copy.
  - `BlockRewrite(base_hash, after_hash, old_title, new_title, kind: Literal["retitle","unlink","inline"] = "retitle")`
  - `replay_title_rewrites` keeps its name and signature; a step whose rows are `unlink`/`inline` applies `apply_delete_rewrite(text, lambda raw: normalize_title(raw) in unlinked_titles, inline_copies)`; a `retitle` step is unchanged.

- [ ] **Step 1: Failing tests:** in `test_ops_core.py`, `test_replay_applies_an_unlink_step` (base "Tags:: #AI" hash, row kind unlink old_title "AI"; edit "Tags:: #AI plus" → "Tags:: AI plus" and the after hash), `test_replay_applies_an_inline_step` (row kind inline "uid_p1" → "copied"; "see ((uid_p1)) more" → "see copied more"), `test_replay_chains_unlink_then_retitle` (unlink AI, then retitle Paper→Papers on the resulting hash; edit "#AI [[Paper]] x" → "AI [[Papers]] x"). In the DB test module: `test_block_rewrites_gains_kind_on_an_old_database` — create a DB whose `block_rewrites` lacks `kind`, run `init_db`, assert the column exists and old rows read `retitle`.
- [ ] **Step 2: Run** them — FAIL.
- [ ] **Step 3: Implement** the column in `SERVER_DDL`, the `ALTER TABLE block_rewrites ADD COLUMN kind ...` in `_ensure_schema_migrations` (guarded by `PRAGMA table_info`), `kind` in `_block_rewrites`'s SELECT, and the kind-aware step in `_rewrite_steps`/`replay_title_rewrites` (a step groups rows by hash pair as now; its retitle map, unlink set and inline map replay together, retitle first). Update the `block_rewrites` schema comment to the three row meanings.
- [ ] **Step 4: Run** `uv run pytest -q tests/test_ops_core.py tests/test_ops_endpoint.py tests/test_schema_artifact.py` plus the DB test — PASS (regenerate `web/src/replica/baseSchema.gen.ts` only if `test_schema_artifact` says so; `block_rewrites` is `SERVER_DDL`, so it should not).
- [ ] **Step 5: Commit** `feat(pkm-wlkh): block_rewrites replays unlink and inline steps`.

### Task 3: Store shell for delete

**Files:**
- Modify: `server/src/pkm/server/store.py` (beside `rename_page_rows`)
- Test: `server/tests/test_page_delete_unlinks.py` (new; direct store tests on a `seeded_config` DB)

**Interfaces:**
- Consumes: Task 1 `plan_page_delete`, `SourceBlock`, `DeletePlan`, `apply_delete_rewrite`; Task 2 `kind` column; existing `reindex_refs_for_text`, `delete_page_rows`, `_prune_block_rewrites`, `pkm.server.sync_meta.title_reader`.
- Produces:
  - `class DeleteBlockedError(Exception): blockers: tuple[DeleteBlocker, ...]`
  - `plan_delete(db, page_id: PageId, title: CanonicalTitle) -> DeletePlan` — read-only: page blocks; sources = distinct blocks on other pages from `refs.target_page_id = page_id` ∪ `block_refs.target_block_uid IN (page uids)`, joined to their page titles; `is_target = lambda raw: canonical(normalize_title(raw)) == title` with `canonical = title_reader(db)`.
  - `delete_page_unlinking(db, page_id: PageId, title: CanonicalTitle, now_ms: int) -> DeletePlan` — raises `DeleteBlockedError` when `plan.blockers`; else for each uid in `plan.rewrites`: `UPDATE blocks SET text, updated_at`, insert `block_rewrites` rows (`unlink` row if uid in `plan.unlinked`; one `inline` row per entry in `plan.inlined[uid]`; all with the before/after hashes of the whole rewrite), `reindex_refs_for_text`; then `delete_page_rows`, `_prune_block_rewrites`. Never commits.

- [ ] **Step 1: Failing tests** (seed: page 1 "Machine Learning" holds uid_b3 "[[Attention Is All You Need]] is a [[Paper]]"; uid_b4 on "July 7th, 2026" links it; uid_b5 there says "See ((uid_b3)) for details"):
  - `test_delete_unlinks_inbound_links` — after `delete_page_unlinking(db, 1, "Machine Learning", now)`: uid_b4 text "Studying Machine Learning today"; no `refs` row targets a page titled "Machine Learning"; `fetch_page` is None.
  - `test_delete_inlines_block_refs` — uid_b5 text "See [[Attention Is All You Need]] is a [[Paper]] for details"; its `block_refs` rows are gone and its `refs` now include "Paper".
  - `test_delete_block_with_link_and_ref_is_rewritten_once` — add a block "[[Machine Learning]] ((uid_b3))" on page 3; exactly one UPDATE (assert `changes` gained one row for it) and the expected text.
  - `test_delete_records_replay_rows` — `block_rewrites` has an `unlink` row for uid_b4 and an `inline` row for uid_b5 with matching hashes.
  - `test_delete_refused_by_query_blocker` — add "{{query: {and: [[Machine Learning]]}}}" on page 3; `DeleteBlockedError` with that uid and reason "query"; nothing changed (page still there, texts unchanged).
  - `test_delete_without_inbound_refs_only_deletes`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** `uv run pytest -q tests/test_page_delete_unlinks.py tests/test_rename_endpoint.py` — PASS.
- [ ] **Step 5: Commit** `feat(pkm-wlkh): delete unlinks and inlines through the store`.

### Task 4: Routes: DELETE and the preview

**Files:**
- Modify: `server/src/pkm/server/routes_pages.py:270-282` (`delete_page`), add `GET /api/delete-preview` (query param `title`; a path under `/api/page/` would be swallowed by `GET /api/page/{title:path}`); response models in `server/src/pkm/contracts/responses.py`.
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`.
- Test: `server/tests/test_page_endpoint.py` (rewrite `test_delete_page_removes_inbound_refs_but_leaves_source_block_text` → `test_delete_page_turns_inbound_links_into_plain_text`), `server/tests/test_ops_endpoint.py` (stale replay).

**Interfaces:**
- Consumes: Task 3 `plan_delete`, `delete_page_unlinking`, `DeleteBlockedError`.
- Produces (pydantic, in `contracts/responses.py`):
  - `DeleteBlockerModel { uid: str, page_title: str, text: str, reason: Literal["query","attribute"] }`
  - `DeletePreview { links: int, link_pages: int, block_refs: int, block_ref_pages: int, blockers: list[DeleteBlockerModel] }`
  - `GET /api/delete-preview?title=` → `DeletePreview`, 404 when the page is missing.
  - `DELETE /api/page/{title}` → `{"ok": true}` as today; 409 with `detail = {"message": "page is still referenced in ways a delete cannot rewrite", "blockers": [DeleteBlockerModel...]}`; 503 + `Retry-After: 1` when `BEGIN IMMEDIATE` hits a lock (copy rename's block at :299-305); rollback on any exception.

- [ ] **Step 1: Failing tests:** `test_delete_page_turns_inbound_links_into_plain_text` (uid_b4 → "Studying Machine Learning today", refs to page 1 gone); `test_delete_preview_counts` (Machine Learning: links 1/1, block_refs 1/1, blockers []); `test_delete_refused_with_blockers_409` (add query block via `/api/ops`, DELETE → 409, body blockers list, page still GETs 200); `test_delete_page_busy_returns_503` (mirror `test_rename_holds_the_write_lock_from_its_snapshot_on`); in `test_ops_endpoint.py`, `test_stale_edit_replays_a_delete_unlink_instead_of_resurrecting_the_title` (delete "AI", then `_stale_push(client, STALE_BASE)` → `_ml_texts(client)[0] == "Tags:: AI plus offline words"`, `/api/page/AI` 404, `/api/page/conflict` 404).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the routes and models; regenerate openapi + types (Global Constraints command).
- [ ] **Step 4: Run** `uv run pytest -q` (whole server suite incl. `test_openapi_sync.py`), `uv run pyrefly check`, `uv run ruff check` — all pass.
- [ ] **Step 5: Commit** `feat(pkm-wlkh): delete route unlinks, refuses blockers; delete preview route` (include both generated files).

### Task 5: Journal cleanup keeps linked daily notes

**Files:**
- Modify: `server/src/pkm/server/routes_pages.py:492-534` (`_block_is_referenced` → a page-level `_daily_is_linked(db, page_id) -> bool`)
- Test: `server/tests/test_journal_cleanup.py`

**Interfaces:**
- Produces: `_daily_is_linked(db, page_id: int) -> bool` — true when a `refs` row targets the page from a block on another page, or a `block_refs` row on another page targets any of its blocks. Replaces the `LIKE '%((uid))%'` scan.

- [ ] **Step 1: Failing tests:** `test_spares_empty_daily_with_inbound_link` (`[[<daily title>]]` on another page), `test_spares_empty_daily_with_inbound_tag` (`#[[<daily title>]]`); existing `test_spares_daily_whose_blank_block_is_referenced` stays green; an empty unlinked daily is still deleted.
- [ ] **Step 2: Run** — FAIL (the first two).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `uv run pytest -q tests/test_journal_cleanup.py` — PASS.
- [ ] **Step 5: Commit** `feat(pkm-wlkh): journal cleanup keeps daily notes that are linked`.

### Task 6: Web delete dialog

**Files:**
- Create: `web/src/components/deletePageCopy.ts` (Functional Core: copy only), `web/src/components/DeleteBlockedDialog.tsx`
- Modify: `web/src/components/TopBar.tsx:45-64`
- Test: `web/src/components/deletePageCopy.test.ts`, `web/src/components/TopBar.test.tsx`

**Interfaces:**
- Consumes: `GET /api/delete-preview` (`components["schemas"]["DeletePreview"]`), DELETE 409 `detail.blockers`.
- Produces: `deleteConfirmMessage(title: string, p: DeletePreview): string`; `<DeleteBlockedDialog title blockers onClose />` listing each blocker as a link to its page (`/page/<encoded title>`), its text, and the reason label.

Exact copy (pinned by tests):
- confirm: `Delete "${title}"? This cannot be undone.` then, if `links > 0`, ` ${links} link(s) on ${link_pages} page(s) will become plain text.` then, if `block_refs > 0`, ` ${block_refs} block reference(s) on ${block_ref_pages} page(s) will be replaced with a copy of the text they point to.` Use singular/plural words ("1 link on 1 page", "2 links on 2 pages").
- blocked dialog heading: `Can't delete "${title}"`; lead: `Change these blocks first:`; reason labels: query → `a query names this page`; attribute → `unlinking would make this an attribute`; one button `Close`.

- [ ] **Step 1: Failing tests:** `deletePageCopy.test.ts` for the four count combinations and plurals; `TopBar.test.tsx`: preview with blockers shows the blocked dialog and never calls DELETE; preview without blockers shows the counted confirm and DELETEs on confirm; a 409 from DELETE (preview raced) shows the blocked dialog.
- [ ] **Step 2: Run** `cd web && pnpm test:unit -- deletePageCopy TopBar` — FAIL.
- [ ] **Step 3: Implement.** Preview fetch failure falls back to today's plain confirm text (the server still enforces blockers).
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test:unit` — PASS.
- [ ] **Step 5: Commit** `feat(pkm-wlkh): delete dialog shows what will be unlinked and what blocks it`.

### Task 7: Docs, gates, finish

**Files:**
- Modify: `docs/architecture/backend.md` ("Database" `block_rewrites`; "Page mutations and the sidebar"; "Conflicts" replay kinds; API table rows for `DELETE /api/page/{title}` and `GET /api/delete-preview`), `docs/architecture/sync-and-offline.md` (replay table row), `docs/architecture/frontend.md` if it lists TopBar dialogs, `.beans/pkm-wlkh--*.md` (checklist, then completed with Summary), plus a bean noting deletes of attribute pages should refuse (spec non-goal follow-up).

- [ ] **Step 1:** Invoke the `architecture-docs` skill; update the docs above against the code as shipped; grep docs for "inbound links remain as text" / "left as-is" and fix each.
- [ ] **Step 2:** Run gates: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`; `cd web && pnpm verify` (with `set -o pipefail` if piped); `perf/check.sh`; `proptest/check.sh server`. All green; regressions handled per AGENTS.md.
- [ ] **Step 3:** Commit docs + bean; hand to final review (superpowers:requesting-code-review), then superpowers:finishing-a-development-branch (`git merge --no-ff`).

### Task 8: Data repair after deploy (needs Arthur's OK)

Not code. After merge and `~/.config/pkm/app/deploy/update.sh`, with Arthur's go-ahead:
- [ ] Rerun the pkm-70ty sweep script (`scratchpad/sweep.py` / `dangling.py` against a fresh DB copy) and confirm the 13 blocks are still the set.
- [ ] `pkm batch`: `#1`/`#3`/`#4`/`#5`/`#18` → `1`/`3`/`4`/`5`/`18` in the 8 tag blocks; `[[Keyboard shortcuts]]` → `Keyboard shortcuts` in `RY9E8_vcn`.
- [ ] Recreate empty daily notes `July 28th, 2026`, `July 30th, 2026`, `September 30th, 2026`, then re-derive refs for their 4 linking blocks with the text+" " / text update pair.
- [ ] Rerun the sweep: zero stale.
