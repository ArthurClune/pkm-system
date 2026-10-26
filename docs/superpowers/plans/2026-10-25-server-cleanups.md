# Server Clean-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close nine follow-ups from the 2026-10-24/25 security run: bound the work a crafted text, title or body can force on the server, keep server-made text inside the limits, and stop slow clients holding connections.

**Architecture:** Each fix bounds a cost before paying it: a linear asset-token scan, a projected splice length before a page delete builds copies, the op judges run off the write lock and off the event loop, a byte cap on authenticated bodies before parsing, deadlines on header and public-body reads, and a fall-back label when a conflict header would not fit. One web task releases uploads a refused command orphaned, and one makes the web refuse a batch the server would refuse whole, as it already does for depth and text limits.

**Tech Stack:** Python 3.12, FastAPI / Starlette, uvicorn 0.49 with h11 (no httptools installed), SQLite, pytest + hypothesis; React + TypeScript, vitest.

**Spec:** the beans `pkm-25u5`, `pkm-gr92`, `pkm-n01x`, `pkm-49rh`, `pkm-iw03`, `pkm-cfi2`, `pkm-0l8g`, `pkm-iruc`, `pkm-9akp` (`.beans/<id>--*.md`), and `docs/architecture/backend.md` § Planning, § Page mutations, § Auth, § Hostile input; `docs/architecture/files-and-assets.md` § Assets.

## What reproduced (measured on `main` at 6748e6ea)

| Bean | Reproduces | Measurement |
|---|---|---|
| 25u5 | yes | `strip_asset_tokens` on lone `[` before an asset URL: 2.1 s / 7.9 s / 31.9 s at 1k / 2k / 4k tokens (x4 per doubling). Unclosed `{{pdf: url` macros on one line: 0.19 / 0.76 / 3.0 s. Well-formed tokens are linear (26 ms at 4k). A 1M-character block of `[ ` would run for days |
| gr92 | yes | `[![x](/assets/<sha>/f.png)[GrFoo]]` → after `DELETE /api/assets/<sha>` the block is `[[GrFoo]]` with no `refs` row and no page `GrFoo` |
| n01x | by reading | `useOutline.run()` refuses after `onFiles` / `onDropFiles` uploaded; the fresh shas are never released and `scrollToUidRef` keeps a uid that never renders |
| 49rh | yes | `plan_page_delete` runs inline, unlink, `extract` and bracket pairing over the whole inlined text before judging it: 0.17 s and one string copy per million inlined characters. 100 refs to a 100k-character block: 37 s; 76k refs to a 1M block (the bean's case) is a 7.6e10-character string that never finishes |
| iw03 | yes | stale `update_text` of `IwGone:: x…` at 1,000,000 code points, `IwGone` deleted after `seen_seq`: stored 1,000,002 code points, ack ok |
| cfi2 | yes | per 1M-character op, the text-limit judge costs up to 0.10 s and the title judge (`extract`) up to 1.31 s; both run under `BEGIN IMMEDIATE` and on the event loop (`post_ops` is `async`). A 500-op batch: about 700 s holding the single writer |
| 0l8g | yes | the body is read and parsed whole before any judge. `OpBatch.model_validate_json` peaks near 3.7x the body: 61 MiB → 0.9 s, ~225 MiB RSS; 122 MiB → 1.9 s, ~470 MiB. 500 x 1M is about 477 MiB of JSON, so several GiB |
| iruc | yes | `update_text` of a missing uid with a 3,000,000-character `page_title` hint stored a 3,000,075-character header. `create_page` and `POST /api/pages` both accept a 2,000,000-character title |
| 9akp | yes, wider than filed | scratch `run.main` on 9033, 30 s probes: a refused `POST /api/ops` dripping 1 byte/s, a `POST /api/login` dripping under the cap, a connection that sends nothing, and one that drips its headers were **all** still open at 30 s. uvicorn starts its keep-alive timer only after a response, and has no header or body read timeout |

Real sizes, from a copy of the production database: 57,954 blocks, the largest 258,277 characters, all block text together 5.0M characters; the longest page title 260 characters.

## Decisions

- **25u5:** port the web's pairing (`closesOf` in `web/src/grammar/markdown.ts`, commit 9240fc36) to `assets_core`, and replace the lazy macro regex by one forward pass. Output must be byte-identical to today's for every input.
- **gr92:** re-derive refs for every block the strip rewrites (`store.reindex_refs_for_text`), as rename and page delete do. Refusing the delete instead would make an asset undeletable for a harmless join.
- **49rh:** judge the projected length (`spans.spliced_length`) before splicing. A page block whose own copy would pass the cap is never built and blocks every referrer as `limit`. A source whose inlined text, **before unlinking**, would be over the cap and longer than it was is refused as `limit`. This is stricter than today only for a text that inlining carries over the cap and unlinking brings back under it; unlinking removes only link syntax, so that needs a source within a few characters of the cap.
- **cfi2:** a pure `ops_core.judge_batch` (text limits, then titles, today's messages) returns a `JudgedBatch`; `apply_batch` takes only a `JudgedBatch`, so no caller can apply an unjudged batch. `post_ops` runs the judge in the threadpool before `BEGIN IMMEDIATE`. Consequence, documented: a batch is judged before its dedupe read, so a retry of a stored batch meets the current limits.
- **0l8g:** one cap on **every** authenticated body outside `SAFE_METHODS`, not only `/api/ops` (every FastAPI route parses its body before running), except `POST /api/assets`, which streams to disk under `config.max_upload_bytes`. `PRIVATE_BODY_MAX_BYTES = 64 MiB`: over ten times the whole production graph's text and 250 times its largest block, while a parse stays near 250 MiB. A declared `Content-Length` past it gets 413 unread; a declared length within it passes untouched (h11 frames the body to it); a body with no `Content-Length` is read by the gate up to the cap and replayed, as the public body is.
- **0l8g, web side:** a 413 or 422 on `/api/ops` is a terminal rejection that discards the batch (`sync/rejection.ts`), so the web must never queue one: `run()` refuses a command whose batch has more than `MAX_OPS_PER_BATCH` ops or whose JSON could pass `PRIVATE_BODY_MAX_BYTES`, as it refuses depth and text limits. This also fixes a gap found while planning: a paste of more than 500 lines is one batch the server answers 422, and is discarded today.
- **iruc:** no title cap. Every header and note the planner writes is judged with `text_limit_violation`; one that would not fit is rebuilt with the label `(page title too long)`. Copies of stored text (a conflict's losing text, a diverged delete's copies) copy a row level with itself, which the rewrite rule allows; the docs say so. A title longer than any link can hold stays possible (see Open questions).
- **9akp:** three parts. Every gate refusal (401, 413, new 408) carries `Connection: close`, so h11 closes after the response instead of draining the body. The gate's public-body read has a total deadline, `PUBLIC_BODY_READ_TIMEOUT_S = 10.0`, answered 408. A `DeadlineH11Protocol` closes a connection whose request head has not arrived `HEADER_READ_TIMEOUT_S = 10.0` after it opened or after its last response. Authenticated slow bodies keep no deadline: a 150 MB upload over a weak link must not be cut.
- **iw03:** needs Arthur (Product questions). Task 8 implements the recommendation and is written so the alternative swaps in.
- **New, no bean yet (call it R1):** an `update_text` whose replay is `over_limit` lands the text **as sent** under a conflict header, and that text can still link a page the replay deleted or renamed away, so the landing re-creates it. Reproduced: a stale-hash edit `[[RpDel]] ((d1)) ((d1))` after `RpDel` was deleted re-created `RpDel`. The orchestrator files a bean before Task 8 starts.

## Product questions

1. **iw03, a stale defuse at the cap.** Any spelling that keeps the attribute's text whole and stops it indexing (`` `X`:: v ``) needs two more characters; an inert spelling that does not grow (swapping, moving or dropping `::`) can create a different ref in edge cases. Options:
   - **A (recommended): accept the two characters.** The stale unlink may store at most `MAX_BLOCK_TEXT_CHARS + 2`; the docs state the bound and why; a test pins it. Cost: the block sits two characters over the cap, so the user's next edit must cut at least two characters in one flush to be accepted.
   - B: 400 the batch, as the depth cap does. Cost: the whole offline batch is discarded with a notice.
   - C: skip the op as `text_limit` and land the text as two conflict entries (the fenced attribute name, then the rest). Lossless, but a new skip for `create` needs journal rows and a replica mirror, the cost the depth-cap design declined.
2. **0l8g:** `PRIVATE_BODY_MAX_BYTES = 64 MiB` on every authenticated body bar uploads, and a web refusal of a command past 500 ops or the cap (notice copy in Task 10). Invisible at today's sizes; say if a different number or scope is wanted.

## Global Constraints

- Work only in `/Users/arthur/code/llm/pkm/.claude/worktrees/batch-server` (branch `security/batch-server`). `pwd` first; never touch `/Users/arthur/code/llm/pkm`. Scratch servers on 9033 or 9034 only; 8974 is production. Stop servers you start by PID.
- Do not stage `.beans/`; the orchestrator owns the bean files (they already carry uncommitted status edits).
- Never answer a 4xx for server-made text: a 400 discards the client's batch. Only text a client sent may refuse a batch.
- Constants, verbatim: `PRIVATE_BODY_MAX_BYTES: Final = 64 * 1024 * 1024`; `PUBLIC_BODY_READ_TIMEOUT_S: Final = 10.0`; `HEADER_READ_TIMEOUT_S: Final = 10.0`; `LONG_TITLE_LABEL = "(page title too long)"`. Responses: 413 `{"detail": "request body too large"}` (existing `BODY_TOO_LARGE_DETAIL`), 408 `{"detail": "request body timed out"}`.
- FCIS: every new runtime file declares its pattern. Pure judges live in `*_core.py` / `ops_core.py`; middleware and protocol classes are Imperative Shell.
- Comments: at most 80 columns, other lines 120; no bean ids, line numbers or plan pointers in code, tests or `docs/architecture/`; never write "load-bearing". `git config core.hooksPath .githooks` once.
- Work-scaling tests count loop iterations, not seconds (`tests/scaling.py`, Task 1), except where the slow path runs in C (a regex), which gets a generous wall-clock bound.
- Server verification per task: `cd server && uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`. Web tasks: `cd web && pnpm verify` (not `typecheck` + `test:unit`). Pipe a gate only under `set -o pipefail`.
- A custom `pytest -m` must add `and not proptest`.
- A route docstring change stales `web/src/api/openapi.json`: Tasks 2 and 4 change one; Task 11 regenerates once (`backend.md § Generated artifacts and parity fixtures`).
- Docs: invoke the `architecture-docs` skill before editing `docs/architecture/`. Each fix adds one row to `docs/troubleshooting.md` (symptom, cause, owning section, bean id in the Ref column). Do not touch `docs/SECURITY.md`; `pkm-e95y` owns it.
- Commits: explicit paths; `git status -sb` first; message ends `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; no session URL.

## Review Focus

1. **A private body with no `Content-Length`** (chunked through a proxy) past the cap must get 413 at the cap, not be buffered whole. Pinned in Task 5.
2. **An upload larger than 64 MiB** must still reach `POST /api/assets` and its own `max_upload_bytes` rule. Pinned in Task 5.
3. **A keep-alive client sending a second request** on the same connection, and a client posting a normal login, must be unaffected by the header and body deadlines. Pinned in Task 6.
4. **The linear strip must equal today's strip on every input**, including nested labels, unbalanced parens and macros split across lines. Pinned by a hypothesis oracle in Task 1.
5. **A legacy source already over the cap**, whose delete inlines nothing new, must stay deletable (level is allowed). Pinned in Task 3.

---

### Task 1: Linear asset-token strip (pkm-25u5)

**Model:** opus (a write path's DoS bound with exact-equivalence demands).

**Files:**
- Modify: `server/src/pkm/assets_core.py` (`_markdown_destination_close`, `_markdown_link_span_at`, `_markdown_asset_spans`, `strip_asset_tokens`)
- Create: `server/tests/scaling.py` (helper, moved from `test_export_resolve._loop_steps`)
- Modify: `server/tests/test_export_resolve.py` (use the helper)
- Test: `server/tests/test_assets_core.py`, `server/tests/test_upload_links_props.py`
- Docs: `docs/troubleshooting.md` (Files and assets)

**Interfaces:**
- Produces: `tests/scaling.loop_steps(module: ModuleType, run: Callable[[], object]) -> int`, the jump count in `module`'s file during `run()` (today's `_loop_steps` body, parameterised by module). Task 3 uses it.
- `strip_asset_tokens(text, sha256) -> str` keeps its signature and output.

- [ ] **Step 1: Move `_loop_steps` into `tests/scaling.py` as `loop_steps(module, run)`**; `test_export_resolve.py` calls `loop_steps(resolve, ...)`. Run `uv run pytest -q tests/test_export_resolve.py`: PASS.
- [ ] **Step 2: Write the failing tests** in `tests/test_assets_core.py`:

```python
@pytest.mark.parametrize("unit", ["[ ", "![ ", "[a](", "[a]( ("],
                         ids=["lone-bracket", "lone-image", "open-dest", "nested-dest"])
def test_strip_costs_linear_work_on_unclosed_openers(unit):
    def steps(n: int) -> int:
        text = unit * n + f"![x]({URL})"
        return loop_steps(assets_core, lambda: strip_asset_tokens(text, SHA))
    small, large = steps(500), steps(2_000)
    # Linear work grows about 4x from N to 4N; quadratic about 16x.
    assert large < 6 * small, (small, large)

def test_unclosed_pdf_macros_on_one_line_strip_in_bounded_time():
    text = " ".join([f"{{{{pdf: {URL}"] * 10_000)
    start = time.perf_counter()
    strip_asset_tokens(text, SHA)
    # Quadratic today: about 19 s. Linear: well under a second.
    assert time.perf_counter() - start < 2.0
```

and in `tests/test_upload_links_props.py` a hypothesis property `test_the_linear_strip_equals_the_reference` comparing `strip_asset_tokens(text, SHA_A)` with `_reference_strip(text, SHA_A)`, a verbatim copy of today's `strip_asset_tokens` and its three helpers kept in the test file (pure, small inputs only). Texts are drawn from tokens `["[", "]", "(", ")", "!", "{{pdf: ", "{{[[pdf]]: ", "}}", "}", "\n", " ", "a", "[[", "]]", f"/assets/{SHA_A}/f.png", f"/assets/{SHA_B}/g.png"]`, up to 40 tokens.

- [ ] **Step 3: Run them.** `uv run pytest -q tests/test_assets_core.py tests/test_upload_links_props.py -k "linear or bounded"`. Expected: the four `linear_work` cases and the macro bound FAIL; the equivalence property PASSES (it pins today's behaviour).
- [ ] **Step 4: Implement.**
  - `_closes_of(text: str) -> array[int]` (`array("q")`, one slot per character, -1 where nothing closes): the web's `closesOf` over the whole text. Forward pass with a `[` stack and a `(` stack, both cleared at `\n`; a `]` pairs the top `[`, a `)` the top `(`. Backward pass: an unpaired `(` takes the first `)` after it on its line, else stays -1. That is today's rule: `_markdown_destination_close` falls back to `text.find(")", start)`, and the caller drops a close past a newline.
  - `_markdown_link_span_at(text, start, closes)` reads label close = `closes[open_]`, requires `text[label_close + 1] == "("`, destination close = `closes[label_close + 1]`; `None` where either is -1. `_markdown_asset_spans` builds `closes` once, on the first probe that reaches a `[`. Delete `_markdown_destination_close`.
  - `_macro_spans(text: str, prefix: str) -> list[tuple[int, int]]` replaces the lazy-regex `finditer`: iterate heads of `\{\{(?:\[\[pdf\]\]|pdf):\s*` + `re.escape(prefix)`, skip a head starting before the last span's end, and close each at the first `}}` at or after the head's end that comes before the next `\n`. Find both with monotonic pointers into the sorted `}}` positions (`re.finditer(r"(?=\}\})", text)`) and `\n` positions, so the pass is linear.
- [ ] **Step 5: Run** `uv run pytest -q tests/test_assets_core.py tests/test_upload_links_props.py tests/test_upload_links_parity.py tests/test_asset_delete.py`: PASS. Re-run the scratchpad benchmark shape (lone `[` at 4,000 tokens) and record the time in the commit message.
- [ ] **Step 6: Troubleshooting row** (Files and assets): "Deleting a file from /files takes minutes, holding every write, when a block holds the file's link after thousands of unclosed `[` or `{{pdf:`" / "`strip_asset_tokens` rescanned to the end of the line from each opener" / files-and-assets.md § Assets / pkm-25u5.
- [ ] **Step 7: Commit** `server/src/pkm/assets_core.py server/tests/scaling.py server/tests/test_export_resolve.py server/tests/test_assets_core.py server/tests/test_upload_links_props.py docs/troubleshooting.md`: `fix: strip asset tokens in one linear pass`.

### Task 2: Asset delete re-derives refs (pkm-gr92)

**Model:** sonnet (fully specified).

**Files:**
- Modify: `server/src/pkm/server/routes_assets.py` (`_strip_references`, `delete_asset` docstring)
- Test: `server/tests/test_asset_delete.py`
- Docs: `docs/architecture/files-and-assets.md` (the "Asset URLs produce no `refs` rows" bullet), `docs/architecture/backend.md` § Planning "Refs" bullet (drop "The asset-token strip skips it"), `docs/troubleshooting.md`

**Interfaces:**
- Consumes: `store.reindex_refs_for_text(db, uid, text, now_ms)` (never commits).

- [ ] **Step 1: Failing test** `test_a_strip_that_joins_a_link_indexes_it`: upload an asset, create `"[" + f"![x]({url})" + "[GrFoo]]"` on page `Host`, `DELETE /api/assets/{sha}`; assert the block text is `[[GrFoo]]`, page `GrFoo` exists, and `GET /api/page/GrFoo` lists the block among its backlinks.
- [ ] **Step 2: Run** `uv run pytest -q tests/test_asset_delete.py -k joins`: FAIL (no backlink, no page).
- [ ] **Step 3: Implement.** In `_strip_references`, after each `UPDATE`, call `reindex_refs_for_text(db, uid, new_text, now_ms)`. A deleted (emptied, childless) block needs none: its `refs` rows cascade. Rewrite the docstring's "no refs reindex is needed" passage to say why every rewritten block is reindexed (a removed token can join `[` and `[Foo]]` into a link).
- [ ] **Step 4: Run** `uv run pytest -q tests/test_asset_delete.py tests/test_text_limits_rewrites.py tests/test_journal_advancing_contract.py`: PASS.
- [ ] **Step 5: Docs.** Replace the files-and-assets.md bullet with the rule (rewritten blocks are reindexed; a strip can create a link) and drop the asset strip from backend.md's list of paths that skip `ReindexRefs`. Troubleshooting row (Files and assets): "After deleting a file, a `[[Foo]]` that appeared where its link sat is missing from Foo's backlinks, and Foo may not exist" / "`delete_asset` stored stripped text without re-deriving refs" / files-and-assets.md § Assets / pkm-gr92.
- [ ] **Step 6: Commit** the three docs, the route and the test: `fix: reindex blocks an asset delete rewrites`.

### Task 3: Page delete bounds inlined copies before building them (pkm-49rh)

**Model:** opus (write path; blocker semantics).

**Files:**
- Modify: `server/src/pkm/unlink.py` (`_build_copies`, `_blocker_reason`, `plan_page_delete`)
- Test: `server/tests/test_unlink.py`, `server/tests/test_text_limits_rewrites.py`
- Docs: `docs/architecture/backend.md` § Page mutations (the `limit` row and the rewrite paragraph), `docs/troubleshooting.md`

**Interfaces:**
- Consumes: `spans.spliced_length`, `unlink.block_ref_spans`, `pkm.contracts.ops.MAX_BLOCK_TEXT_CHARS`, `tests/scaling.loop_steps` (not needed if the memory bound suffices).
- Produces: `_build_copies(is_target, page_blocks) -> tuple[dict[BlockUid, str], frozenset[BlockUid]]`, copies plus the uids whose copy would pass the cap (never built). `_blocker_reason` splits into `_source_blocker_reason(is_target, source) -> BlockerReason | None` (`query`, `used_as_attribute`; reads only the source) and `_rewrite_blocker_reason(is_target, page_blocks, source, rewritten) -> BlockerReason | None` (`attribute`, `residual`). `plan_page_delete`'s signature and `DeletePlan` are unchanged.

- [ ] **Step 1: Failing tests** in `tests/test_unlink.py`, measured with `tracemalloc` (inputs built before tracing starts):

```python
def test_inlining_past_the_cap_is_refused_before_the_copies_are_built():
    page = {TARGET: "x" * 200_000}
    source = SourceBlock(SRC, OTHER, " ".join([f"(({TARGET}))"] * 100))
    plan, peak = _traced(lambda: plan_page_delete(is_t, page, [source]))
    assert [b.reason for b in plan.blockers] == ["limit"]
    assert peak < 10 * 200_000  # 20M characters were built before

def test_a_page_block_whose_own_copy_passes_the_cap_blocks_its_referrers():
    page = {A: " ".join([f"(({B}))"] * 100), B: "y" * 200_000}
    source = SourceBlock(SRC, OTHER, f"(({A}))")
    plan, peak = _traced(lambda: plan_page_delete(is_t, page, [source]))
    assert [b.reason for b in plan.blockers] == ["limit"]
    assert peak < 10 * 200_000

def test_a_legacy_source_over_the_cap_that_inlines_nothing_new_stays_deletable():
    # level is allowed: only the link goes
    source = SourceBlock(SRC, OTHER, "z" * 1_000_100 + " [[T]]")
    plan = plan_page_delete(is_t, {}, [source])
    assert plan.blockers == () and plan.rewrites[SRC].endswith(" T")
```

and in `tests/test_text_limits_rewrites.py` `test_delete_preview_reports_a_projected_limit_without_building_it`: seed the 100-ref shape, `GET /api/delete-preview?title=T` answers 200 with one `limit` blocker; `DELETE /api/page/T` answers 409 with the same blocker and changes nothing.

- [ ] **Step 2: Run** `uv run pytest -q tests/test_unlink.py tests/test_text_limits_rewrites.py -k "cap or limit or legacy"`: the two peak assertions FAIL (the blockers already say `limit`), the legacy test PASSES.
- [ ] **Step 3: Implement.** In `_build_copies`, project `spliced_length(plain[uid], block_ref_spans(plain[uid], plain))`; past `MAX_BLOCK_TEXT_CHARS`, record the uid as oversized and build nothing for it (the blank-inline and unlink passes only shorten). In `plan_page_delete`, per source: `_source_blocker_reason` first; then `limit` when any referenced uid is oversized, or when the projected inlined length is over the cap and longer than `source.text`; only then splice, unlink, `_rewrite_blocker_reason` and the exact `rewrite_text_limit_violation` as today. Update the module docstring and the `BlockerReason` comment to say `limit` is judged on the projected inlined text before unlinking.
- [ ] **Step 4: Run** `uv run pytest -q tests/test_unlink.py tests/test_text_limits_rewrites.py tests/test_page_delete_unlinks.py tests/test_delete_preview*.py`: PASS.
- [ ] **Step 5: Docs.** backend.md § Page mutations: the `limit` row says the copies' length is projected before any is built, and that the judgement is of the inlined text before unlinking (why: unlinking only removes link syntax, and building first lets one block force a string the size of every copy). Troubleshooting row (Writes, conflicts and races): "Deleting a page, or opening its delete preview, runs for minutes or exhausts memory when a block refers to the page's long blocks many times" / "`plan_page_delete` built every inlined copy before judging the text limit" / backend.md § Page mutations / pkm-49rh.
- [ ] **Step 6: Commit** `server/src/pkm/unlink.py`, the two tests, `docs/architecture/backend.md`, `docs/troubleshooting.md`: `fix: bound a page delete's inlined copies before building them`.

### Task 4: Judge a batch before the write lock (pkm-cfi2)

**Model:** opus (write lock, event loop, idempotency order).

**Files:**
- Modify: `server/src/pkm/server/ops_core.py` (new `JudgedBatch`, `judge_batch`), `server/src/pkm/server/ops_apply.py` (`apply_batch`), `server/src/pkm/server/routes_ops.py` (`post_ops`)
- Modify (callers): `server/tests/test_ops_apply.py` and any other direct `apply_batch(db, …)` caller in `server/tests/` (grep `apply_batch(db`)
- Test: `server/tests/test_text_limits_ops.py`
- Docs: `docs/architecture/backend.md` (write-path diagram, § The write lock row for `POST /api/ops`, § Planning "Text limits" bullet), `docs/troubleshooting.md`

**Interfaces:**
- Produces: `@dataclass(frozen=True) class JudgedBatch: batch: OpBatch` and `judge_batch(batch: OpBatch) -> JudgedBatch`, raising `OpError(index, reason)` with exactly today's reasons (`f"block {uid}: {describe_text_limit(v)}"`, then `f"unsupported {source} title syntax: {title!r}"`). `apply_batch(db: Db, judged: JudgedBatch, now_ms: int) -> AppliedBatch` reads `judged.batch` and judges nothing. Task 8 relies on these names.

- [ ] **Step 1: Failing tests** in `tests/test_text_limits_ops.py`, using `test_ops_concurrency`'s lock-holding pattern (`monkeypatch.setattr(db_module, "BUSY_TIMEOUT_MS", 50)`, a second connection holding `BEGIN IMMEDIATE`):
  - `test_an_over_limit_batch_is_refused_without_the_write_lock`: a `create` of `"x" * 1_000_001` → 400 naming the block (today: 503).
  - `test_a_bad_title_batch_is_refused_without_the_write_lock`: a `create_page` with a title `title_syntax_reason` refuses → 400 (today: 503).
  - `test_a_judged_batch_still_waits_for_the_lock`: a valid batch → 503 with `Retry-After: 1`.
- [ ] **Step 2: Run** `uv run pytest -q tests/test_text_limits_ops.py -k write_lock`: the first two FAIL with 503.
- [ ] **Step 3: Implement.** Move the two judges from `apply_batch` into `judge_batch`. In `post_ops`, before `begin_immediate`: `judged = await run_in_threadpool(judge_batch, batch)` (`starlette.concurrency`), its `OpError` mapped to the same 400 detail. Update the `post_ops` docstring (judged off the lock and the event loop, before the dedupe read) and `apply_batch`'s. Update direct test callers to `apply_batch(db, judge_batch(batch), now)`.
- [ ] **Step 4: Run** `uv run pytest -q tests/test_text_limits_ops.py tests/test_ops_apply.py tests/test_ops_concurrency.py tests/test_ops_idempotency.py tests/test_ops_endpoint.py`: PASS. Then the whole suite.
- [ ] **Step 5: Docs.** Diagram: the judge sits outside the TX box. Write-lock row: "the dedupe read and every op's context read; the text and title judges run before it, in the threadpool". Planning bullet: `judge_batch` judges every op, a skipped one included, before the lock; a retry of a stored batch is judged again, so a limit tightened by a deploy refuses it. Troubleshooting row (Writes, conflicts and races): "Every write waits, then 503s, while one large batch is refused" / "`apply_batch` ran the text and title judges inside `BEGIN IMMEDIATE`, on the event loop" / backend.md § The write lock / pkm-cfi2.
- [ ] **Step 6: Commit** the three modules, the tests and the docs: `fix: judge an ops batch before taking the write lock`.

### Task 5: Cap authenticated request bodies (pkm-0l8g)

**Model:** opus (security boundary in middleware).

**Files:**
- Modify: `server/src/pkm/server/auth_gate_core.py` (constants, `private_body_cap`, `declared_content_length`), `server/src/pkm/server/auth_gate.py` (`_capped(scope, receive, send, cap)` and the private branch)
- Create: `shared/fixtures/batch_limits.json` = `{"max_ops_per_batch": 500, "private_body_max_bytes": 67108864}`
- Test: `server/tests/test_auth_gate.py`, `server/tests/test_batch_limits_fixture.py`
- Docs: `docs/architecture/backend.md` (§ Auth prose and table, API reference `POST /api/ops` row, § Hostile input row "An anonymous body of any size" → widened, § Generated artifacts table row for the fixture), `docs/troubleshooting.md`

**Interfaces:**
- Produces: `PRIVATE_BODY_MAX_BYTES`, `UNCAPPED_PRIVATE_ROUTES: frozenset[tuple[str, str]] = frozenset({("POST", "/api/assets")})`, `private_body_cap(method: str, route_path: str) -> int | None` (None for `SAFE_METHODS` and uncapped routes), `declared_content_length(headers) -> int | None`. Task 6 edits `auth_gate.py` after this; Task 10 reads the fixture.

- [ ] **Step 1: Failing tests** in `tests/test_auth_gate.py`, at the ASGI level as the existing "refused unread" tests are (a `receive` that records calls), with a valid session cookie:
  - `test_an_authenticated_body_declared_past_the_cap_is_refused_unread`: `POST /api/ops`, `content-length: PRIVATE_BODY_MAX_BYTES + 1` → 413 `request body too large`, `receive` never called.
  - `test_an_authenticated_body_without_a_length_stops_at_the_cap`: no `content-length`, 1 MiB messages with `more_body` (patch the cap to 4 MiB) → 413 after at most one message past the cap.
  - `test_an_authenticated_body_within_the_cap_reaches_the_route`: a declared-length batch → 200.
  - `test_an_upload_declared_past_the_cap_is_left_to_its_route`: `POST /api/assets` declaring `PRIVATE_BODY_MAX_BYTES + 1` → not the gate's 413 (the gate calls the app).
  - `test_private_body_cap`: table over (`POST /api/ops`, cap), (`GET /api/page/x`, None), (`POST /api/assets`, None), (`DELETE /api/assets/abc`, cap), (`PUT /api/sidebar`, cap).
  - In `tests/test_batch_limits_fixture.py`: the fixture equals `MAX_OPS_PER_BATCH` and `PRIVATE_BODY_MAX_BYTES`.
- [ ] **Step 2: Run** `uv run pytest -q tests/test_auth_gate.py tests/test_batch_limits_fixture.py`: FAIL (names missing, no cap).
- [ ] **Step 3: Implement.** After `session_is_valid`, for an `http` scope: `cap = private_body_cap(method, get_route_path(scope))`; None → app; a declared length past `cap` → `_too_large`; a declared length within → app untouched; no declared length → `_capped(scope, receive, send, cap)`, today's buffered read and replay with the cap as a parameter (the public path passes `PUBLIC_BODY_MAX_BYTES`). Module docstrings say why uploads are exempt and why a declared length is trusted (h11 frames the body to it).
- [ ] **Step 4: Run** the whole server suite: PASS (`test_the_gate_admits_exactly_the_public_routes` unchanged).
- [ ] **Step 5: Docs.** § Auth: one table row or sentence for the private cap and its exemption; the "nothing enforces" list gains "a new upload route joins `UNCAPPED_PRIVATE_ROUTES`, or its bodies are cut at 64 MiB". API reference: `POST /api/ops` "413 past `PRIVATE_BODY_MAX_BYTES`". Hostile input: the anonymous-body row also covers authenticated bodies. Generated-artifacts table: a row for `batch_limits.json` (hand-edited; guarded by `test_batch_limits_fixture.py` and, after Task 10, `batchLimits.test.ts`). Troubleshooting row (Writes, conflicts and races): "A `POST /api/ops` of hundreds of MiB was read and parsed whole, using GiBs, before any limit refused it" / "nothing bounded an authenticated body; FastAPI parses before the route" / backend.md § Auth / pkm-0l8g.
- [ ] **Step 6: Commit** the two modules, the fixture, both tests and the docs: `fix: cap authenticated request bodies before parsing`.

### Task 6: Slow clients cannot hold connections (pkm-9akp)

**Model:** opus (concurrency; uvicorn internals).

**Files:**
- Create: `server/src/pkm/server/http_protocol.py` (Imperative Shell): `DeadlineH11Protocol`
- Modify: `server/src/pkm/server/run.py` (`uvicorn_config` passes `http=DeadlineH11Protocol`), `server/src/pkm/server/auth_gate.py` (`Connection: close` on every refusal; deadline on the public read), `server/src/pkm/server/auth_gate_core.py` (`PUBLIC_BODY_READ_TIMEOUT_S`)
- Create: `server/tests/uvicorn_harness.py` (the real-socket server now private to `test_auth_gate.py`, moved)
- Test: `server/tests/test_http_protocol.py`, `server/tests/test_auth_gate.py`, `server/tests/test_run.py`
- Docs: `docs/architecture/backend.md` § Auth (replace "a slow client can hold the connection past the keep-alive timeout"; add to "Nothing enforces" that `run.main` must pass the protocol), `docs/troubleshooting.md`

**Interfaces:**
- Produces: `class DeadlineH11Protocol(uvicorn.protocols.http.h11_impl.H11Protocol)` with module constant `HEADER_READ_TIMEOUT_S`. It arms a timer in `connection_made` and after `on_response_complete`, disarms it in `data_received` once `self.conn.their_state is not h11.IDLE` (the request head is in) and in `connection_lost`; on firing, if `their_state` is still `IDLE` and the transport is open, it closes the transport. Behaviour beyond that stays uvicorn's.

- [ ] **Step 1: Move the real-socket harness** from `test_auth_gate.py` into `tests/uvicorn_harness.py` (`serve(app) -> context manager yielding port`, loaded through `run.uvicorn_config`). Existing real-socket tests PASS.
- [ ] **Step 2: Failing tests** over a real socket, deadlines patched to 0.5 s, each asserting the server closes (recv returns `b""`) within 3 s:
  - `test_http_protocol.py::test_a_connection_that_sends_nothing_is_closed`
  - `test_http_protocol.py::test_a_request_head_dripped_a_byte_at_a_time_is_closed`
  - `test_http_protocol.py::test_a_keep_alive_client_can_send_a_second_request` (two `GET /healthz` on one connection, the second 0.2 s after the first response: both 200)
  - `test_auth_gate.py::test_a_refused_private_body_closes_the_connection` (anonymous `POST /api/ops`, `Content-Length: 1000`, one byte sent: 401 with `connection: close`, then EOF without sending the rest)
  - `test_auth_gate.py::test_a_login_body_dripped_past_the_deadline_gets_408` (408 `request body timed out`, then EOF)
  - `test_auth_gate.py::test_a_login_body_sent_promptly_still_logs_in`
  - `test_run.py::test_uvicorn_config_uses_the_deadline_protocol` (`uvicorn_config(...).http is DeadlineH11Protocol`)
- [ ] **Step 3: Run** `uv run pytest -q tests/test_http_protocol.py tests/test_auth_gate.py tests/test_run.py`: the new tests FAIL (held open; no 408; no attribute).
- [ ] **Step 4: Implement.** `_too_large`, the 401 and the new `_timed_out` all send `headers={"Connection": "close"}`. Wrap `_capped`'s read loop for the public path in `asyncio.timeout(PUBLIC_BODY_READ_TIMEOUT_S)`; on `TimeoutError` send the 408. Private bodies keep no deadline (`_capped` takes the timeout as an optional parameter, None for private). Write `DeadlineH11Protocol` to the interface above, and pass it in `uvicorn_config`.
- [ ] **Step 5: Run** the whole server suite, then repeat the plan's 30 s probe against a scratch `run.main` on 9033 (all four shapes should close within about 10 s); record the numbers in the commit message.
- [ ] **Step 6: Docs.** § Auth: refusals close the connection; the public body read has a deadline; the protocol closes a connection whose request head is late; authenticated bodies have no deadline and why (uploads over slow links). "Nothing enforces": only `run.uvicorn_config` installs the protocol, so launchd must keep starting `python -m pkm.server.run`. Troubleshooting row (Writes, conflicts and races, beside the zav2 row): "A client dripping a request body, or headers, one byte a second, or sending nothing, held a connection open indefinitely, refused or not" / "uvicorn has no header or body read timeout and drains a refused body before the next request" / backend.md § Auth / pkm-9akp.
- [ ] **Step 7: Commit** the new module, `run.py`, the gate files, the harness, the tests and the docs: `fix: close connections whose head or public body is late`.

### Task 7: Conflict headers and notes always fit the text limits (pkm-iruc)

**Model:** opus (server-made text on the write path).

**Files:**
- Modify: `server/src/pkm/server/conflict_notes.py`
- Test: `server/tests/test_conflict_notes.py`, `server/tests/test_text_limits_ops.py`
- Docs: `docs/architecture/backend.md` § Conflicts (header table: one row for the fall-back label) and § Missing targets ("Server-made landings…" paragraph: also never past a text limit; copies of stored rows are level with them), `docs/troubleshooting.md`

**Interfaces:**
- Produces: `LONG_TITLE_LABEL = "(page title too long)"`. `overwritten_header_text`, `deleted_header_text`, `orphan_header_text`, `live_block_header_text` and `stale_page_move_note` keep their signatures; each builds its text with the title's label and, when `text_limit_violation` refuses that text, rebuilds it with `LONG_TITLE_LABEL` in the label's place. One private helper does the fitting for all five.

- [ ] **Step 1: Failing tests.** `test_conflict_notes.py`: for each builder, a 1,000,000-character title (and for `orphan_header_text` a 3,000,000-character hint naming no page) yields text that `text_limit_violation` accepts and that contains `LONG_TITLE_LABEL`; a 260-character title (the longest in production) is still named. A title nesting `[[` past `MAX_LINK_NESTING` (`"[[a//" * 40 + "x" + "]]" * 40`) also falls back. `test_text_limits_ops.py::test_a_huge_page_title_hint_lands_a_header_within_the_cap`: `update_text` of a missing uid with a 3,000,000-character hint → 200, and the longest stored block is at most `MAX_BLOCK_TEXT_CHARS`.
- [ ] **Step 2: Run** `uv run pytest -q tests/test_conflict_notes.py tests/test_text_limits_ops.py -k "title or hint"`: FAIL.
- [ ] **Step 3: Implement** the helper and route the five builders through it.
- [ ] **Step 4: Run** the whole server suite: PASS (`missing_targets.json` cases unchanged).
- [ ] **Step 5: Docs** as listed. Troubleshooting row (Writes, conflicts and races): "A conflict note's header block is millions of characters long" / "headers embedded the page title or the client's `page_title` hint, neither length-capped, unjudged" / backend.md § Conflicts / pkm-iruc.
- [ ] **Step 6: Commit** `conflict_notes.py`, both tests and the docs: `fix: fit conflict headers and notes inside the text limits`.

### Task 8: Stale defuse at the cap, and over-limit landings that re-create pages (pkm-iw03, R1)

**Model:** opus (write path; replay semantics). **Blocked:** Steps 1–3 wait for Arthur's answer to Product question 1 (written for option A; the swap-ins for B and C are below). Steps 4–8 (R1) need the orchestrator's new bean id and may run first.

**Files:**
- Modify: `server/src/pkm/server/ops_core.py` (`ReplayOverLimitContext`, `plan_op`'s over-limit branch), `server/src/pkm/server/ops_apply.py` (`_context_for` fills the new fields)
- Test: `server/tests/test_stale_page_ops.py`, `server/tests/test_text_limits_ops.py`
- Docs: `docs/architecture/backend.md` § Planning ("Text limits" and "Replayed text" bullets), § Stale batches, `docs/troubleshooting.md`

**Interfaces:**
- Consumes: Task 4's `judge_batch` / `apply_batch(db, judged, now_ms)`.
- Produces: `ReplayOverLimitContext` gains `replayed: tuple[RewriteStep, ...]` and `canonical: Callable[[str], str]` (as `TextConflictContext` has); `ops_core.over_limit_landing_text(text: str, replayed: Sequence[RewriteStep], canonical: Callable[[str], str]) -> str`, the sent text with every title a consumed step deleted or renamed away unlinked (`unlink.unlink_stale_refs` over the union of `step.unlinked` and `step.retitles` keys, matched through `canonical`).

- [ ] **Step 1 (iw03, option A): Pin the bound.** `test_stale_page_ops.py::test_a_stale_defuse_at_the_cap_stores_at_most_two_more`: page `Gone` created then deleted after `seen_seq`; a stale `update_text` of `"Gone:: " + "x" * (MAX_BLOCK_TEXT_CHARS - 7)` → 200, stored text starts `` `Gone`:: `` and its length is exactly `MAX_BLOCK_TEXT_CHARS + 2`; page `Gone` is not re-created. This passes today; it pins the accepted bound.
- [ ] **Step 2 (iw03, option A): Docs.** The "Text limits" bullet states the bound and why: any spelling that keeps the name's text and stops it indexing needs the two backticks, and refusing would discard the offline batch. Troubleshooting needs no row (no behaviour changes).
- [ ] **Step 3 (iw03): Commit** the test and docs: `docs: a stale defuse may store two characters past the cap`.
  - *If B:* Step 1 asserts a 400 naming the block and nothing stored; implement in `apply_batch` by judging `unlink_stale_text`'s result with `text_limit_violation` and raising `OpError`; docs say a stale batch past the cap after unlinking is refused like a depth overflow.
  - *If C:* stop and re-plan this task (a new skip kind for `create`, journal rows and the replica mirror).
- [ ] **Step 4 (R1): Failing tests** in `test_text_limits_ops.py`:
  - `test_an_over_limit_replay_after_a_delete_does_not_recreate_the_page`: block `B` = `f"[[RpDel]] (({D1}))"` with `D1` a 600,000-character block on page `RpDel`; delete `RpDel`; post `update_text` of `B` with `base_text_hash` of the original text and text `f"[[RpDel]] (({D1})) (({D1}))"`, no `seen_seq` → ack skips it as `text_limit`; page `RpDel` does not exist; the conflict entry's text starts `RpDel `.
  - `test_an_over_limit_replay_after_a_rename_does_not_recreate_the_old_title`: `B` = `[[Old]] [[Old]]`; rename `Old` to `"n" * 400_000` (B becomes 800,008 code points); post `update_text` of `B` with the pre-rename hash and text `[[Old]] [[Old]] [[Old]]` (replayed: 1,200,012) → skipped `text_limit`; page `Old` does not exist.
- [ ] **Step 5 (R1): Run** them: FAIL (the page is back).
- [ ] **Step 6 (R1): Implement.** `_context_for` passes the outcome's `replayed` and `canonical` into `ReplayOverLimitContext`; `plan_op` lands `over_limit_landing_text(op.text, ctx.replayed, ctx.canonical)` and reindexes that text. `((uid))` refs to deleted blocks stay (a dangling ref is legal).
- [ ] **Step 7 (R1): Run** the whole server suite, then `proptest/check.sh server`.
- [ ] **Step 8 (R1): Docs and commit.** "Replayed text" bullet: the landed entry has the titles the replay unlinked or renamed away made plain, or the landing would re-create the page. Troubleshooting row (Writes, conflicts and races): "A deleted or renamed-away page reappears after an offline edit too long to replay landed as a conflict note" / "the over-limit landing stored the text as sent, links included" / backend.md § Planning / the new bean id. Commit: `fix: an over-limit replay lands without re-creating gone pages`.

### Task 9: A refused upload releases what it uploaded (pkm-n01x)

**Model:** sonnet (fully specified web change).

**Files:**
- Modify: `web/src/outline/useOutline.ts` (`run`, `onFiles`, `onDropFiles`), `web/src/outline/undoManager.ts` (new export)
- Test: `web/src/outline/useOutline.depth.test.tsx`
- Docs: `docs/troubleshooting.md` (Editor)

**Interfaces:**
- Produces: `run(fn, opts?: { freshAssets?: readonly Sha256Hex[] }): boolean`, true when the command's ops applied (not refused, not empty). `undoManager.releaseUnusedAssets(shas: readonly Sha256Hex[]): void` calls the current `releaser.release(shas, [])` (so `setAssetReleaser` covers it in tests). Task 10 edits `commandRefusal` and `run` after this.

- [ ] **Step 1: Failing tests** in `useOutline.depth.test.tsx` (stub `fetch` for the upload as `useOutline.freshAssets.test.tsx` does; install a spy with `setAssetReleaser`):
  - `a file drop past the depth cap releases the files it uploaded`: `onDropFiles([png("one.png")], { parent_uid: d100a, order_idx: 0, page_title: "Deep" })` → `editNotice === DEPTH_NOTICE`, nothing enqueued, the releaser called once with `[digestOf("one.png")]` and `[]`.
  - `an /upload past the depth cap releases the files and reports no insert`: `handlers.onFiles` on a level-100 block whose plan nests the new block at 101 resolves `false` and releases.
  - `a refused drop sets no scroll target`: after the refused drop, a later render adds a block with the planned uid (`n<k>` from the mocked `newUid`) and `scrollIntoView` is never called (jsdom has none: define it on `Element.prototype` as a `vi.fn()`).
- [ ] **Step 2: Run** `cd web && pnpm vitest run src/outline/useOutline.depth.test.tsx`: FAIL.
- [ ] **Step 3: Implement.** `run` returns whether `result.ops` applied, and on a refusal with `opts.freshAssets` non-empty calls `releaseUnusedAssets`. `onFiles` / `onDropFiles` keep the plan's fallback uid in a local and set `scrollToUidRef` only when `run` returned true; `onFiles` resolves to `run`'s result.
- [ ] **Step 4: Run** `pnpm verify`: PASS.
- [ ] **Step 5: Troubleshooting row** (Editor): "Files dropped or uploaded where the outline is too deep stay in /files as unlinked uploads" / "`run()` refused the command after the uploads and nothing released them" / frontend-editor.md § Rules an edit must not break / pkm-n01x.
- [ ] **Step 6: Commit** the two modules, the test and the row: `fix: release uploads a refused command orphaned`.

### Task 10: The web never queues a batch the server refuses for size (pkm-0l8g, web side)

**Model:** sonnet (fully specified; mirrors depth and text-limit refusals).

**Files:**
- Create: `web/src/sync/batchLimits.ts` (Functional Core), `web/src/sync/batchLimits.test.ts`
- Modify: `web/src/outline/useOutline.ts` (`commandRefusal` takes the whole batch)
- Test: `web/src/outline/useOutline.paste.test.tsx`
- Docs: `docs/architecture/frontend-editor.md` § Rules an edit must not break (one line), `docs/troubleshooting.md` (Sync and offline)

**Interfaces:**
- Consumes: `shared/fixtures/batch_limits.json` (Task 5).
- Produces: `MAX_OPS_PER_BATCH = 500`, `PRIVATE_BODY_MAX_BYTES = 67_108_864`, `BATCH_TOO_LARGE_NOTICE = "This change is too large to save in one step."`, and `findBatchSizeViolation(ops: readonly BlockOp[]): "ops" | "bytes" | null`. Bytes: when the sum of op text lengths x 6 plus 1,024 per op plus 4,096 is within the cap, null without serialising (JSON escapes a code point to at most six bytes); otherwise the UTF-8 length of `JSON.stringify(ops)` plus 1,024 per op (stamps the queue adds: hashes, `page_title`) plus 4,096 (the envelope) against the cap.

- [ ] **Step 1: Failing tests.** `batchLimits.test.ts`: constants equal the fixture (imported as `depthCap.test.ts` imports its fixture); 500 small ops → null, 501 → `"ops"`; one `update_text` of 1,000,000 `"\u0001"` characters x 12 ops → `"bytes"` (6 MB escaped each). `useOutline.paste.test.tsx`: `onPasteOutline` of 501 lines → `editNotice === BATCH_TOO_LARGE_NOTICE`, nothing enqueued but the pending draft's text op.
- [ ] **Step 2: Run** `pnpm vitest run src/sync/batchLimits.test.ts src/outline/useOutline.paste.test.tsx`: FAIL.
- [ ] **Step 3: Implement.** `commandRefusal(result, textOps)` judges depth, then text limits, then `findBatchSizeViolation([...textOps, ...result.ops])`. The refusal keeps today's shape: none of the command's ops ship; the draft's still do.
- [ ] **Step 4: Run** `pnpm verify`: PASS.
- [ ] **Step 5: Docs.** frontend-editor.md: the web refuses a command whose batch the server would refuse whole for its op count or size, for the reason it refuses depth (a queued refusal discards the batch). Troubleshooting row (Sync and offline): "Pasting more than 500 lines shows 'Server rejected a change' and the paste is lost" / "the paste was one batch past `MAX_OPS_PER_BATCH`, which the server answers 422 and the queue discards" / frontend-editor.md / pkm-0l8g.
- [ ] **Step 6: Commit** the new module and test, `useOutline.ts`, the paste test and the docs: `fix: refuse a command whose batch the server would refuse for size`.

### Task 11: Docs sweep and gates

**Model:** opus (judges perf and property results; final review package).

**Files:** `web/src/api/openapi.json`, `web/src/api/types.d.ts` (regenerated); `docs/architecture/*.md` and `docs/troubleshooting.md` (fixes only).

- [ ] **Step 1: Regenerate the OpenAPI artifacts** (`delete_asset` and `post_ops` docstrings changed): `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`, then `cd web && pnpm gen-types`. `uv run pytest -q tests/test_openapi_sync.py`: PASS.
- [ ] **Step 2: Docs sweep** with the `architecture-docs` skill: read every section the tasks touched against the code as merged on the branch (claims, not the plan); check the `overview.md` index still points right; no bean ids in architecture prose; no counts.
- [ ] **Step 3: Server gates:** `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`. Web: `pnpm verify`. All exit 0.
- [ ] **Step 4: Property gate** (sync, ops, planning, outline commands and undo changed): `proptest/check.sh` (both sides). A failure follows AGENTS.md (fix product bugs with a unit test on the bug's side).
- [ ] **Step 5: Perf gate,** on a quiet machine, serial: `perf/check.sh` (both sides from the diff). A regression is read along its path in the diff and fixed; only a surviving one goes to Arthur with the table.
- [ ] **Step 6: Commit** the regenerated artifacts and any doc fixes: `docs: sweep for the server clean-ups; regenerate openapi`. The review package carries the perf table, the property run's summary and the before/after probe numbers from Tasks 1, 3, 4 and 6.

### Task 12: Page titles are at most 1,000 characters (pkm-ax2j)

**Model:** opus. It touches the ops judge, the store's create choke point, every title route, the importer, the replica and the editor, and legacy rows must keep working.

**Runs:** after Task 10 (it edits `commandRefusal` as Task 10 left it) and before Task 11 (Task 11's sweep and gates cover it). If Task 11 has already run, Step 6 regenerates OpenAPI here, and Step 12's property run is followed by `proptest/check.sh` on both sides.

**Prod survey:** already done. The longest title is 260 characters and the longest sidebar entry 20, so no row is over the cap. No migration is needed, and the legacy rules below are for old databases and tests.

**Files:**
- Create: `shared/fixtures/title_length.json` (hand-edited), `web/src/grammar/titleLength.ts` (`// pattern: Functional Core`)
- Modify (server): `server/src/pkm/contracts/titles.py`, `server/src/pkm/refs.py`, `server/src/pkm/server/ops_core.py` (`OpTitleViolation`, `find_op_title_violation`, `judge_batch`), `server/src/pkm/server/store.py` (`TitleTooLongError`, `get_or_create_page`, `index_ref`), `server/src/pkm/server/routes_pages.py` (`create_page`, `rename_page`), `server/src/pkm/server/routes_sidebar.py` (`add_sidebar_entry`), `server/src/pkm/importer/titles.py` (`ImportTitleErrorReason`, `sanitize_import_title`), `server/src/pkm/server/conflict_notes.py` (module docstring only)
- Modify (web): `web/src/replica/titles.ts`, `web/src/replica/queue.ts`, `web/src/replica/localOps.ts`, `web/src/replica/localApi/router.ts`, `web/src/outline/useBlockDraft.ts` (`admit`), `web/src/outline/useOutline.ts` (`commandRefusal`), `web/src/outline/undoManager.ts` (`refusalNotice`), `web/src/props/ops/arbitraries.ts`, `web/src/props/ops/example.ts` (`causeOf`, `RejectionCause`, tally)
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts` (the `create_page` and `rename_page` docstrings change)
- Test (server): create `server/tests/test_title_length_fixture.py` and `server/tests/test_title_length.py`; extend `server/tests/test_import_titles.py`, `server/tests/test_cli_main_write.py` and `server/tests/test_mcp_server.py`
- Test (web): create `web/src/grammar/titleLength.test.ts`; extend `web/src/replica/titles.test.ts`, `web/src/replica/queue.test.ts`, `web/src/replica/localOps.test.ts`, `web/src/replica/localApi/router.test.ts`, `web/src/views/EditablePage.test.tsx`, `web/src/outline/useOutline.textLimits.test.tsx` and `web/src/outline/undoManager.test.ts`
- Docs: `docs/architecture/backend.md` (§ Refused titles, § Planning "Replayed text" bullet, § Missing targets "Nor is server-made text…" paragraph, the HTTP API reference rows for `POST /api/pages`, rename and `/api/sidebar`, a § Hostile input row, a § Generated artifacts row), `docs/architecture/frontend-editor.md` (§ Rules an edit must not break: the text-limit row and the notice paragraph), `docs/architecture/sync-and-offline.md` (`enqueueBatch`'s refusal sentence), `docs/troubleshooting.md` (Backend › Titles and the ref grammar). Check `docs/architecture/import-export-and-backup.md`'s `sanitize_import_title` paragraph. It links § Refused titles, so it should need no edit.

**Interfaces:**
- Consumes: Task 4's `ops_core.judge_batch` (limits first, then titles), Task 7's `conflict_notes` (`LONG_TITLE_LABEL`, `_fitted`), and Task 10's `commandRefusal(result, textOps)`.
- Produces (server):
  - `pkm.contracts.titles.MAX_PAGE_TITLE_CHARS: Final = 1_000`, beside `UNTITLED_PAGE_TITLE`. Its comment says the value is in code points of the folded title, and that `shared/fixtures/title_length.json` pins the web's copy.
  - `pkm.refs.TitleRefusal = Literal["forbidden_syntax", "too_long"]`. `TitleSyntaxReason` is unchanged.
  - `pkm.refs.title_length_over(text: str) -> int | None`: `None` when `len(text) <= MAX_PAGE_TITLE_CHARS`, because the fold never lengthens. Otherwise it returns `len(normalize_title(text))` when that is over the cap, else `None`.
  - `pkm.refs.describe_title_length(measured: int) -> str`, which returns `f"title of {measured} characters is over the limit of {MAX_PAGE_TITLE_CHARS}"`.
  - `pkm.refs.title_refusal(text: str) -> TitleRefusal | None`: `"too_long"` when `title_length_over` says so, else `title_syntax_reason(text)`. Length is judged first.
  - `ops_core.OpTitleViolation.reason: TitleRefusal`, and `ops_core.describe_op_title_violation(v: OpTitleViolation) -> str`. For `"too_long"` it returns `f"{v.source} {describe_title_length(n)}"`, so `page_title title of 1001 characters is over the limit of 1000` or `reference title of …`. For `"forbidden_syntax"` it returns today's `f"unsupported {v.source} title syntax: {v.title!r}"`. `judge_batch` raises `OpError(v.op_index, describe_op_title_violation(v))`.
  - `store.TitleTooLongError(ValueError)` with `.title` and `.measured`, whose `str()` is `describe_title_length(measured)`. `get_or_create_page` raises it only on the insert branch, after `fetch_page` misses. `index_ref` catches it as it catches `BlankTitleError` and `ForbiddenTitleError`.
  - `importer.titles.ImportTitleErrorReason = Literal["malformed_syntax", "blank", "too_long"]`.
- Produces (web):
  - `web/src/grammar/titleLength.ts` exports `MAX_PAGE_TITLE_CHARS = 1_000` and `TITLE_LENGTH_NOTICE = "A page title can't be longer than 1,000 characters."`.
  - It also exports `titleLengthOver(text): number | null`: `null` when `text.length <= MAX_PAGE_TITLE_CHARS`, else `codePointLength(normalizeRefTitle(text))` when over the cap.
  - It exports `describeTitleLength(measured): string` with the server's wording.
  - It exports `linkedTitleLengthOver(text): number | null`: `null` when `text.length <= MAX_PAGE_TITLE_CHARS`, else the measure of the first ref, in `extractRefs` (grammar) order, whose title is over the cap.
  - `replica/titles.ts` gains `TitleRefusal`, `titleRefusal(text)` and `describeOpTitleViolation(v)`, and `OpTitleViolation.reason` becomes a `TitleRefusal`. `findOpTitleViolation` judges each title with `titleRefusal`.

- [ ] **Step 1: The parity fixture and its server test.** Write `shared/fixtures/title_length.json`. Text is given as `parts`, a list of `[string, repeat]` joined in order, as in `text_limits_parity.json`:

  ```json
  {
    "max_page_title_chars": 1000,
    "titles": [
      {"name": "at_the_cap", "parts": [["t", 1000]], "violation": null},
      {"name": "over_the_cap", "parts": [["t", 1001]], "violation": 1001,
       "describe": "title of 1001 characters is over the limit of 1000"},
      {"name": "astral_at_the_cap", "parts": [["😀", 1000]], "violation": null},
      {"name": "astral_over_the_cap", "parts": [["😀", 1001]], "violation": 1001,
       "describe": "title of 1001 characters is over the limit of 1000"},
      {"name": "a_fold_brings_it_to_the_cap", "parts": [["t", 500], ["  \n", 1], ["t", 499]], "violation": null},
      {"name": "a_fold_strips_its_edges", "parts": [["\n", 1], ["t", 1000], ["\t", 1]], "violation": null},
      {"name": "single_space_edges_count", "parts": [[" ", 1], ["t", 1000], [" ", 1]], "violation": 1002,
       "describe": "title of 1002 characters is over the limit of 1000"},
      {"name": "a_run_counts_once", "parts": [["t", 999], ["   ", 1], ["t", 1]], "violation": 1001,
       "describe": "title of 1001 characters is over the limit of 1000"}
    ],
    "texts": [
      {"name": "a_long_text_of_short_links", "parts": [["x", 5000], [" [[Short]] #tag", 1]], "violation": null},
      {"name": "link_at_the_cap", "parts": [["see [[", 1], ["t", 1000], ["]]", 1]], "violation": null},
      {"name": "link_over_the_cap", "parts": [["see [[", 1], ["t", 1001], ["]]", 1]], "violation": 1001},
      {"name": "tag_over_the_cap", "parts": [["#", 1], ["t", 1001]], "violation": 1001},
      {"name": "bracket_tag_over_the_cap", "parts": [["#[[", 1], ["t", 1001], ["]]", 1]], "violation": 1001},
      {"name": "attribute_over_the_cap", "parts": [["t", 1001], [":: v", 1]], "violation": 1001},
      {"name": "a_code_span_hides_it", "parts": [["`[[", 1], ["t", 1001], ["]]`", 1]], "violation": null},
      {"name": "a_fold_brings_a_link_to_the_cap", "parts": [["[[", 1], ["t", 600], ["\n\n", 1], ["t", 399], ["]]", 1]], "violation": null}
    ]
  }
  ```

  Every non-null `texts` case also carries `"op_describe": "reference title of <n> characters is over the limit of 1000"`. All measures were checked against `refs.extract` and `normalize_title` while planning. `server/tests/test_title_length_fixture.py` holds three tests:
  - `test_the_cap_equals_the_fixture`.
  - `test_title_length_over_matches_the_fixture[<name>]`. It compares against `violation`, and checks `describe_title_length` against `describe` when non-null.
  - `test_the_ops_judge_refuses_linked_titles_as_the_fixture_says[<name>]`. It runs `find_op_title_violation` on one `create` op carrying the text, with `page_title` `"Fixture"`. The result is `None`, or reason `"too_long"` with `describe_op_title_violation` equal to `op_describe`.
- [ ] **Step 2: Server entry-point tests.** All of them go in `server/tests/test_title_length.py` except the import, CLI and MCP tests. Use the `client` and `seeded_config` fixtures. `T1001 = "t" * 1001`. `LEGACY = "Legacy " + "l" * 1493` (1,500 code points), written straight into `pages` with `open_db`, with its refs indexed by `reindex_refs_for_text`, as `test_text_limits_ops._write_legacy_row` does.
  - **Ops:**
    - `test_create_page_at_the_cap_is_stored`: `"t" * 1000` gives 200, then GET 200.
    - `test_create_page_over_the_cap_refuses_the_batch`: a fine `create` at op 0, then `create_page` of `T1001` at op 1. The response is 400 with `{"index": 1, "reason": "page_title title of 1001 characters is over the limit of 1000"}`, and neither op is stored.
    - `test_a_create_or_move_page_title_over_the_cap_is_refused`: parametrized over `create` and top-level `move`.
    - `test_a_link_tag_or_attribute_to_a_long_title_is_refused`: parametrized over `f"[[{T1001}]]"`, `f"#{T1001}"` and `f"{T1001}:: v"`, as a `create` and as an `update_text`. Each gets 400 with reason `reference title of 1001 characters is over the limit of 1000`, and no page is created.
    - `test_a_fold_that_brings_a_title_to_the_cap_is_accepted`: `create_page` of `"t"*500 + "\n\n" + "t"*499` gives 200, and the stored title is 1,000 code points.
    - `test_length_is_judged_before_syntax_and_never_echoed`: `create_page` of `"#" + "t" * 2_000_000` gives 400 with reason `page_title title of 2000001 characters is over the limit of 1000`, and `len(r.text) < 500`.
    - `test_an_update_text_page_title_hint_is_never_judged`: `update_text` of a live block with `page_title` `T1001` gives 200.
  - **Routes:**
    - `test_post_pages_over_the_cap_is_422`: detail `title of 1001 characters is over the limit of 1000`, and the titles are unchanged.
    - `test_rename_to_a_title_over_the_cap_is_422_before_any_mutation`: "Machine Learning" renamed to `T1001` with `allow_merge=True`. The response is 422 with the same detail, and pages, blocks and refs are unchanged.
    - `test_a_sidebar_pin_over_the_cap_is_422`.
  - **Legacy:**
    - `test_a_legacy_long_page_stays_readable_renamable_and_deletable`: GET `/api/page/{LEGACY}` gives 200. Renaming it to `"Short"` gives 200, and a block that linked `[[LEGACY]]` now reads `[[Short]]`. DELETE `/api/page/Short` gives 200.
    - `test_reindexing_a_block_keeps_its_backlink_to_a_legacy_long_page`: `uid_b4`'s text becomes `f"Studying [[Machine Learning]] and [[{LEGACY}]]"` and is reindexed. Rename "Machine Learning" to "ML Stuff". A `refs` row from `uid_b4` to the legacy page still exists. This pins "create branch only": a check before `fetch_page` would drop the backlink.
    - `test_an_op_naming_a_legacy_long_title_is_refused_until_renamed`: a `create` with `page_title=LEGACY` gives 400 with reason `page_title title of 1500 characters is over the limit of 1000`.
    - `test_post_pages_with_a_legacy_long_title_is_422`: the route judges the title it is sent, whatever exists.
    - `test_a_rename_onto_a_legacy_long_title_is_422`: "AI" renamed to `LEGACY` with `allow_merge=True` gives 422, and nothing merges.
  - **Store:**
    - `test_get_or_create_page_refuses_only_creating_a_long_page`: it raises `TitleTooLongError` (with `measured == 1001`) for a new `T1001`, and returns the row for an existing `LEGACY`.
    - `test_index_ref_never_creates_a_long_page`: `reindex_refs_for_text` of `f"[[{T1001}]]"` raises nothing and creates no page and no ref.
    - The daily and `UNTITLED_PAGE_TITLE` creations need no test, because both titles are short by construction (see Decisions).
  - **Import (`test_import_titles.py`):**
    - `test_a_page_title_over_the_cap_is_skipped_and_its_refs_unlinked`: an export with page `T1001` and a block on another page reading `f"see [[{T1001}]]"`. `sanitize_export_titles` skips the page with `SkippedPage.reason == "too_long"` and moves its blocks to the orphans. The block's text becomes plain and its uid is in `unlinked_block_uids`.
    - `test_the_cap_is_judged_on_the_sanitized_title`: `"#" + "t" * 1000` and `"[[" + "t" * 1000 + "]]"` both sanitize to the 1,000-character title and are kept.
  - **CLI (`test_cli_main_write.py`):** `test_save_propagates_the_title_length_refusal`. `run("save", "-p", T1001, "x")` gives code 1, `"400: op 0: page_title title of 1001 characters is over the limit of 1000"` in err, and no page.
  - **MCP (`test_mcp_server.py`):** `test_rename_page_propagates_the_title_length_refusal`. `tools.rename_page("AI", T1001)` raises `ApiError` whose `str` is `"422: title of 1001 characters is over the limit of 1000"`. The assistant's `rename_page` and `batch` reach the same routes through the MCP tools.
- [ ] **Step 3: Run red.** `cd server && uv run pytest -q tests/test_title_length_fixture.py tests/test_title_length.py tests/test_import_titles.py tests/test_cli_main_write.py tests/test_mcp_server.py`. Expect these failures:
  - the fixture file fails on importing `MAX_PAGE_TITLE_CHARS`;
  - every refusal test fails, with 200 where 400 or 422 is expected;
  - the import skip test fails;
  - the store test fails on importing `TitleTooLongError`.

  The acceptance, hint and legacy tests already pass and pin behaviour. Save the output to `t12-red.log`.
- [ ] **Step 4: Implement the server.**
  - The constant goes in `contracts/titles.py`. `refs.py` gets `TitleRefusal`, `title_length_over`, `describe_title_length` and `title_refusal`.
  - `ops_core.find_op_title_violation` calls `title_refusal` on each `page_title` (`create`, `create_page`, `move`) and each `extract(op.text).refs` title, keeping today's op and title order. Add `describe_op_title_violation`; `judge_batch` uses it. `UpdateTextOp.page_title` stays unjudged.
  - In `store`, `get_or_create_page` keeps the blank and syntax checks before `fetch_page`. On a miss it calls `title_length_over(canonical_title)`; when that is not `None` it raises `TitleTooLongError` before the `INSERT`. `index_ref` catches it too, and its docstring says why: a server-made text never creates a page past the cap, and an existing one keeps its backlink.
  - `routes_pages.create_page` judges `title_length_over(body.title)` before `get_or_create_page` and answers 422 with `describe_title_length(n)`. Its docstring gains: "A title longer than 1,000 characters (`MAX_PAGE_TITLE_CHARS`) is a 422, even for a page stored before the cap."
  - `rename_page` judges `title_length_over(body.new_title)` after the blank check and before `title_syntax_reason`, so a 2,000,000-character title is never echoed. It answers 422 with the same detail. Its docstring's 422 sentence gains "or when the new title is longer than 1,000 characters".
  - `routes_sidebar.add_sidebar_entry` does the same on `body.title`, before its syntax check.
  - `importer/titles.sanitize_import_title` raises `ImportTitleError(text, location=location, reason="too_long")` when `title_length_over(result)` is not `None`, after the blank check and before the syntax check. `ImportTitleError.__init__` must not put a 1,000,000-character title in its message for this reason, so use `f"too_long: {len(original_title)} characters"`.
  - Reword the `conflict_notes` module docstring's "neither a page title nor a client's `page_title` hint is length-capped" to say that a client's `page_title` hint is never length-judged, and that a title stored before `MAX_PAGE_TITLE_CHARS` may be longer than the cap.
- [ ] **Step 5: Run green.** Run the Step 3 command, then the full gates: `uv run pytest -q`, `uv run pyrefly check` and `uv run ruff check`, all exiting 0. In particular, `test_conflict_notes.py`, `test_title_routes_props.py`, `test_blank_titles.py`, `test_rename_endpoint.py` and `test_ops_endpoint.py` must stay green.
- [ ] **Step 6: Regenerate OpenAPI.** The `create_page` and `rename_page` docstrings changed. Run `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`, then `cd web && pnpm gen-types`. `uv run pytest -q tests/test_openapi_sync.py` must pass.
- [ ] **Step 7: Commit the server.** Commit the fixture, the server sources, the five test files and the regenerated artifacts with the message `feat: refuse page titles longer than 1,000 characters on the server`.
- [ ] **Step 8: Web tests.**
  - `grammar/titleLength.test.ts`: the constants equal the fixture, imported as `depthCap.test.ts` imports its fixture. `titleLengthOver` and `describeTitleLength` cover every `titles` case, and `linkedTitleLengthOver` every `texts` case.
  - `replica/titles.test.ts`:
    - `findOpTitleViolation` on a `create` carrying each `texts` case: null, or reason `"too_long"` with `describeOpTitleViolation` equal to `op_describe`.
    - `"refuses a page title over the cap for length before syntax"`: a `create_page` of `"#" + "t".repeat(1001)` gives `too_long`.
    - `"never judges an update_text page_title hint"`.
  - `replica/queue.test.ts`: `"enqueueBatch refuses a create_page past the title cap and stores nothing"`. It throws `LocalOpError` with `rejected` true and message `page_title title of 1001 characters is over the limit of 1000`, and the queue and pages are unchanged.
  - `replica/localOps.test.ts`: `"getOrCreateLocalPage refuses minting a title past the cap but returns a stored one"`.
  - `replica/localApi/router.test.ts`: `"offline POST /api/pages past the title cap is a 422"`, with detail `title of 1001 characters is over the limit of 1000`, and nothing enqueued.
  - `views/EditablePage.test.tsx`: `"typing a link to a title past the cap shows the notice, saves nothing"`, modelled on the nesting test. `fireEvent.change` to `` `[[${"t".repeat(1001)}]]` `` leaves `ta.value === "first"` and shows `TITLE_LENGTH_NOTICE`, and the blur sends nothing.
  - `outline/useOutline.textLimits.test.tsx`: `"an outline paste with a line linking a title past the cap applies nothing"`. Nothing is sent, the blocks are unchanged, and `editNotice === TITLE_LENGTH_NOTICE`.
  - `outline/undoManager.test.ts`: `"an undo that would restore a link to a title past the cap is refused"`. The tree starts with a stored (legacy) block reading `[[<1,001 t>]]`. The user edits it to `"x"`, and undo is refused with `TITLE_LENGTH_NOTICE` while keeping its entry.
- [ ] **Step 9: Run red.** `cd web && pnpm vitest run src/grammar/titleLength.test.ts src/replica/titles.test.ts src/replica/queue.test.ts src/replica/localOps.test.ts src/replica/localApi/router.test.ts src/views/EditablePage.test.tsx src/outline/useOutline.textLimits.test.tsx src/outline/undoManager.test.ts` should FAIL. Save the output to `t12-web-red.log`.
- [ ] **Step 10: Implement the web.**
  - Write `grammar/titleLength.ts` as in Interfaces. It imports `codePointLength` from `./textLimits`, `normalizeRefTitle` from `./scan` and `extractRefs` from `./refs`.
  - `replica/titles.ts`: `titleRefusal` judges length first, and `findOpTitleViolation` uses it. Add `describeOpTitleViolation`.
  - `queue.ts` and `localOps.titleViolationError` build their `LocalOpError` message with `describeOpTitleViolation`.
  - `localOps.getOrCreateLocalPage` keeps its syntax throw before the lookup. After `existing` misses, it throws `LocalOpError(describeTitleLength(n))` when `titleLengthOver(title)` is not null, mirroring the store.
  - `localApi/router.ts` `POST /api/pages` answers `err(422, describeTitleLength(n))` before the syntax check.
  - `useBlockDraft.admit` judges `textLimitViolation(next)` first. When that passes it judges `linkedTitleLengthOver(next)`, and on a refusal calls `onRefused(TITLE_LENGTH_NOTICE)` with the same caret handling.
  - `useOutline.commandRefusal` judges depth, then text limits, then batch size (Task 10), then `findOpTitleViolation([...textOps, ...result.ops])`. It refuses with `TITLE_LENGTH_NOTICE` when the reason is `"too_long"`; a forbidden-syntax violation keeps today's path.
  - `undoManager.refusalNotice` adds the same check after `textLimitRefusal`.
- [ ] **Step 11: Run green.** Run the Step 9 command, then `pnpm verify` (under `set -o pipefail` if piped). Both must pass.
- [ ] **Step 12: Property gate (ops).**
  - In `props/ops/arbitraries.ts`, add `"t".repeat(1_001)` and `` ` ${"t".repeat(1_000)} ` `` (refused because the fold keeps its edges) to `FORBIDDEN_TITLES`, and `` `see [[${"t".repeat(1_001)}]]` `` and `` `#${"t".repeat(1_001)}` `` to `FORBIDDEN_REF_TEXTS`. Update the doc comment to name `titleRefusal`.
  - In `props/ops/example.ts`, add `RejectionCause` `"title length"` with `TITLE_LENGTH = /title of \d+ characters is over the limit of \d+$/`. `causeOf` tests it before `TEXT_LIMIT`, which would otherwise match. `sameGuard` requires equal messages for it, as for text limits, since both sides now word it identically. Add the tally key.
  - Run `proptest/check.sh web --file ops`, and read that the `"title length"` rejection count is above 0.
  - Teeth: set the web's `MAX_PAGE_TITLE_CHARS` to `1_001`, re-run, and confirm the property fails (the server refuses a title the replica takes). Revert, and re-run green.
  - Save the summaries to `t12-proptest.log`.
- [ ] **Step 13: Commit the web.** Commit `grammar/titleLength.ts` and its test, the replica, outline and props sources, and the extended tests, with the message `feat: refuse page titles past the cap in the editor and replica`.
- [ ] **Step 14: Docs.** Invoke the `architecture-docs` skill first.
  - **`backend.md`:**
    - § Refused titles: add a paragraph. A title longer than `MAX_PAGE_TITLE_CHARS` code points of its fold (`normalize_title`) is refused (`refs.title_length_over`), at creation, rename, move, sidebar pin and import, but not in the migration audit, which only shortens a title. It is measured on the title as sent, before the flag's edge strip: the fold is the longest a stored title can be under either flag, and the pure ops check never knows the flag. Length is judged before syntax, so a refusal never echoes the title. `get_or_create_page` refuses only creating such a page (`TitleTooLongError`), so a row stored before the cap stays readable, renamable to a shorter title and deletable, and a reindex keeps its backlinks. An op naming it as a `page_title` or a link is refused until it is renamed. `update_text`'s `page_title` hint is never judged.
    - § Planning "Replayed text": replace "titles have no length cap" with "a link grows by up to the title's growth (a title may be `MAX_PAGE_TITLE_CHARS` long, a legacy one longer)".
    - § Missing targets: reword the "Neither a page title nor a `page_title` hint is length-capped" sentence. The hint is never judged and a legacy title may be longer, so `LONG_TITLE_LABEL` stays.
    - The API reference rows: `POST /api/pages` gets "422 for a blank, refused or over-long title". Rename gets "422 when the new title is refused or longer than `MAX_PAGE_TITLE_CHARS`". The `/api/sidebar` row gets "a pin of a refused or over-long title is a 422".
    - § Hostile input row: "A page title millions of characters long" | "refused past `MAX_PAGE_TITLE_CHARS` at every entry point; rule in [Refused titles](#refused-titles)" | `test_title_length.py`.
    - § Generated artifacts row: `title_length.json` | hand-edited | `test_title_length_fixture.py`, `grammar/titleLength.test.ts`, `replica/titles.test.ts` | `MAX_PAGE_TITLE_CHARS`, `title_length_over` and the ops refusal wording.
  - **`frontend-editor.md`:** the text-limit rule row also covers a link to a title past `MAX_PAGE_TITLE_CHARS`: `admit` judges it with `linkedTitleLengthOver`, and `run()` and undo with `findOpTitleViolation`. The notice paragraph names `TITLE_LENGTH_NOTICE`.
  - **`sync-and-offline.md`:** `enqueueBatch` also refuses a title past the length cap, linking `backend.md#refused-titles`.
  - **`troubleshooting.md`** (Backend › Titles and the ref grammar): "`create_page`, `POST /api/pages` or a rename stored a title millions of characters long, and every link to it carried the whole title" | "No rule bounded a title's length (`title_length_over` now refuses one past `MAX_PAGE_TITLE_CHARS`)" | [backend.md § Refused titles](architecture/backend.md#refused-titles) | pkm-ax2j.

  Commit with the message `docs: page titles are at most 1,000 characters (added)`.

**Decisions:**
1. **"Characters" means code points of the title's fold (`normalize_title`), measured on what the client sent.**
   - Code points match the block cap (`len`, `codePointLength`).
   - The fold, not the raw text: a whitespace run stores as one space, so judging the raw text would refuse spellings that store short.
   - The fold, not the flag's canonical form (`target_canonical_title`): the fold is the longest a stored title can be under either flag, and the pure ops check never knows the flag. This mirrors why the syntax rule judges its strictest form.
   - Cost: ` t…t ` with single-space edges is refused at 1,002, though the active flag would store 1,000 (pinned in the fixture).
2. **Length is judged before syntax**, both per title and in routes, so no refusal echoes a title millions of characters long. The importer's message carries the length, not the title.
3. **Status and behaviour per entry point:**

   | Entry point | Over the cap |
   |---|---|
   | `POST /api/ops` (`create_page`, `create`/`move` `page_title`, a `[[link]]`, `#tag` or `attr::` in `create`/`update_text` text) | 400 for the whole batch, as title syntax is; the web refuses first, so none is queued |
   | `POST /api/pages`, rename and merge (the new title only), sidebar pin | 422 |
   | Import | the page is skipped (`too_long`) and its blocks go to the recovery page; refs to it become plain text, as for the other refused titles |
   | CLI `save`/`batch`/`rename`, MCP and the assistant | the 400/422 surfaces through the HTTP client |
   | Server-made pages (daily titles, `"Untitled"`, `index_ref` of server-made text) | never 4xx: the daily and fallback titles are short by construction, and `index_ref` skips a page it may not create |

4. **A `[[link]]` to a long title is refused by the title judge as a `reference`, not as a text limit.** It runs in the same `extract` pass that refuses `[[a#b]]`, after the text limits, so each op is still scanned once. Keeping it out of `text_limit_violation` leaves the rewrite, replay and page-delete judges, and `text_limits_parity.json`, unchanged. This matches how the nesting cap refuses text: a 400 for the batch, pre-judged by the editor.
5. **Legacy rows stay usable.** `get_or_create_page` refuses only the insert, so a stored long page is readable, renamable to a shorter title (the old title is only a lookup) and deletable, and a rename elsewhere keeps its backlink. The pure judges cannot know a page exists, so an op naming it is refused until it is renamed, as for a legacy forbidden-syntax title. Prod has no such row.
6. **Task 7's `LONG_TITLE_LABEL` stays.** `update_text`'s `page_title` hint is never judged: judging it would 400 an edit to a legacy page's block and discard the offline batch, and the hint only labels a header. A legacy title may also be longer than the cap. At a capped title a header is about 1,060 characters, so the fallback never fires for one.
7. **The editor refuses rather than queueing a refusal.** `admit` (typing, paste, the `[[` wrap of a selection), `run()` and undo show `TITLE_LENGTH_NOTICE`. `enqueueBatch`, `applyLocalOps`, `getOrCreateLocalPage` and the offline `POST /api/pages` are the backstops. `admit` scans refs only for a draft longer than 1,000 UTF-16 units; Task 11's `perf/check.sh frontend` covers the per-keystroke cost on long blocks.
8. **No pydantic `max_length` on the request or op models.** It would measure raw text and answer pydantic's 422, which on `/api/ops` is a terminal rejection that names no op.

**Product questions (not blocking):**
- The bean says "the importer refusing the import naming the page". Arthur's ruling says "refused … on import like the other title rules", and the other title rules skip the page and list it in the report (pkm-lvyl). This task follows the ruling. If Arthur wants the whole import refused instead, Step 4's importer change becomes a preflight error that exits 2, like `ImportTextLimitError`.
- Finding outside this bean: the editor does not pre-judge forbidden-syntax link titles. A typed `[[a#b]]` reaches `enqueueBatch`'s `rejected` `LocalOpError`, and `opQueue` desyncs, which repairs the outline back to server state and loses the draft. It is worth its own bean; this task's `commandRefusal` and `admit` handle only the length.

**Orchestrator addition (from Task 10's review, Minors 2–3):** `web/src/sync/batchLimits.ts` `findBatchSizeViolation` allows 1,024 bytes per op for the fields the queue stamps (`page_title`, hashes), and its fast path counts only op `text`. A page title is now at most 1,000 code points, which JSON can escape to 6,000 bytes, so in Step 10 make the per-op allowance cover a stamped title at the cap (derive it from the title limit, e.g. `6 * MAX_TITLE_CHARS + 1,024`, or count title fields in both the fast path and the slow path) and add a test in `batchLimits.test.ts` that a batch whose escaped titles exceed the old allowance is still measured as not under-counted.

## Order

Chains share files and run in order; the chains are independent of each other.

| Chain | Tasks |
|---|---|
| Assets | 1 → 2 |
| Page delete | 3 |
| Ops path | 4 → 7 → 8 |
| HTTP edge | 5 → 6 |
| Web | (5 for the fixture) → 9 → 10 |
| Close | 11 after all |

## Open questions and risks

- **Titles have no length cap.** `create_page` and `POST /api/pages` store a 2,000,000-character title. Task 7 keeps them out of server-made text, but a title longer than any link can hold (`MAX_BLOCK_TEXT_CHARS - 4`) can never be linked and costs every reader that lists titles. Refusing such a title is a new limit only in name; it deserves its own bean.
- **`apply_batch` itself runs on the event loop** (`post_ops` is `async`). Task 4 moves the judges off it; applying an accepted batch still blocks async routes (login, WebSocket) while it runs. Task 5's cap bounds that to about 64 one-megabyte texts.
- **Authenticated slow bodies** keep no deadline (Task 6). A stolen session cookie can still hold connections.
- **The web's paste and selection commands** could also be split into several batches rather than refused; Task 10 refuses, as depth does.
- **Task 6 depends on uvicorn's h11 internals** (`conn.their_state`, `on_response_complete`). The real-socket tests are the guard; a uvicorn upgrade that renames them fails them.
