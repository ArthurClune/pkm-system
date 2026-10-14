# Stale-batch follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four follow-ups of page-delete-wins: a stale leading attribute must not re-create a deleted page (pkm-4g1a), a chained edit after a rename/delete replay must not land a spurious conflict entry (pkm-wj3x), the sync property suite must be able to delete every pool page (pkm-ialr), and the property suites must cover what only examples and review caught (pkm-8dgu).

**Architecture:** Server changes stay in the functional core (`server/src/pkm/unlink.py`, `server/src/pkm/server/ops_core.py`), with `ops_apply.apply_batch` as the one shell plug-in point. Property work is in `server/tests/props/`, `server/tooling/proptest/sync_server.py` and `web/src/props/sync/`.

**Tech Stack:** Python 3 / FastAPI / SQLite / Hypothesis (server), TypeScript / fast-check / vitest (web props).

**Spec:** `docs/superpowers/specs/2026-10-14-page-delete-wins-design.md` (the feature these follow up), the beans `pkm-4g1a`, `pkm-wj3x`, `pkm-ialr`, `pkm-8dgu`, and the handover `docs/superpowers/handoffs/2026-10-14-page-delete-wins-followups-handover.md` (gitignored; the orchestrator holds it).

## Global Constraints

- **Ruling (Arthur, pkm-4g1a):** a stale batch's text whose leading attribute names a deleted page is written in place with the attribute name code-fenced: `X:: v` → `` `X`:: v ``. Inline code is never scanned for refs. A raw name holding a backtick cannot be fenced (`strip_code` knows only single-backtick spans), so it falls back to a single colon: `` a`b:: v `` → `` a`b: v ``.
- The real page delete (`plan_page_delete`) is unchanged: it still refuses `used_as_attribute` / `attribute` blockers.
- **Perf counts are exact.** A plain update_text, create, rename or delete must run exactly the statements it runs today. New `block_rewrites` rows are written only when a replay or stale unlink changed the written text.
- FCIS headers on every touched runtime file; no bean ids in code or test comments.
- **Fix what property checks find**: never exempt a finding in `props/`. A product bug gets an ordinary unit test on its own side plus the fix; a wrong property is fixed in `props/` with the reason in the commit.
- Sync suite budget is about 185 s; keep additions proportionate. Never raise `NUM_RUNS` above 2100.
- pyrefly must report `0 errors` (the "7 suppressed" line is the baseline).

## Review Focus

1. A stale `[[X]]:: v` (bracketed attribute): the unlink makes it `X:: v`, which must then be fenced. Test in Task 1.
2. A stale text whose leading attribute names a *live* page and links a deleted one: the attribute is untouched and the link is unlinked. Test in Task 1.
3. The chained edit after a stale fence: edit N+1 (`X:: v2`, base = hash of `X:: v`) must apply clean as `` `X`:: v2 `` with no conflict entry. Test in Task 1.
4. A replay through two steps (rename A→B, then B deleted) followed by a chained edit: either it applies clean, or no row is recorded and the behaviour is unchanged from today. It must never write wrong text. Test in Task 2.
5. A batch that is both stale and replays a rename: there must be one coherent rewrite row group from hash(sent) to hash(written), never two that disagree. Test in Task 2.

---

### Task 1: pkm-4g1a: defuse a stale leading attribute

**Files:**
- Modify: `server/src/pkm/unlink.py` (new pure helpers)
- Modify: `server/src/pkm/server/ops_core.py` (`unlink_stale_text`, `stale_unlink_effects`, the unlink step of `replay_title_rewrites`)
- Test: `server/tests/test_unlink.py`, `server/tests/props/test_unlink_props.py`, `server/tests/test_stale_page_ops.py`

**Interfaces:**
- Produces: `unlink.defuse_attribute(text: str, is_target: TitleMatch) -> str`. If the leading attribute (`attribute_title_span(strip_code(text))`) names a target, wrap its raw-name span in backticks, or replace its `::` with `:` when the raw name holds a backtick. Otherwise return the text unchanged.
- Produces: `unlink.unlink_stale_refs(text: str, is_target: TitleMatch) -> str` = `defuse_attribute(unlink_title_refs(text, is_target), is_target)`. This is the one function the stale path and the unlink replay step use.

- [ ] **Step 1: Failing tests.** In `test_unlink.py`, cover `defuse_attribute` / `unlink_stale_refs` on `X:: v` → `` `X`:: v ``, `  X:: v` (leading whitespace kept), `[[X]]:: v` → `` `X`:: v ``, `#X:: v`, `` a`b:: v `` → `` a`b: v ``, `Live:: [[X]]` → `Live:: X`, and a non-target attribute left alone. In `test_unlink_props.py`, add the property: for drawn texts (include leading-attribute shapes), `extract(unlink_stale_refs(t, is_x)).refs` holds no ref whose title is the target. In `test_stale_page_ops.py`, end to end:
  - a stale update_text `X:: v` writes `` `X`:: v `` and X stays deleted;
  - a stale create `[[X]]:: v` does the same;
  - the chained edit (Review Focus 3) applies clean with no daily-note conflict entry;
  - a stale top-level create on the deleted page parks the fenced text.
- [ ] **Step 2:** Run `cd server && uv run pytest -q tests/test_unlink.py tests/test_stale_page_ops.py tests/props/test_unlink_props.py`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Add the two helpers. `ops_core.unlink_stale_text` calls `unlink_stale_refs`. `stale_unlink_effects` decides "this title changed the text" with `unlink_stale_refs` too, so an attribute-only change records its `unlink` row. In `replay_title_rewrites`, the unlink step defuses after `apply_delete_rewrite`: a recorded unlink row then reproduces the fenced text on the next chained edit even from a batch without `seen_seq`. Real deletes never record a row for an attribute block (they refuse it), so this changes nothing for them.
- [ ] **Step 4:** Re-run Step 2's command, then the full gate: `uv run pytest -q`, `uv run pyrefly check` (0 errors), `uv run ruff check`. Expected: all PASS.
- [ ] **Step 5:** Add a row to the "Stale batches" table in `docs/architecture/backend.md` for the fenced attribute. Commit the code, tests, doc and the `pkm-4g1a` bean file (tick its todos).

### Task 2: pkm-wj3x: record a rewrite row when a replay changed the written text

**Files:**
- Modify: `server/src/pkm/server/ops_core.py` (`replay_title_rewrites` reports the steps it consumed; a planner helper builds the rows)
- Modify: `server/src/pkm/server/ops_apply.py` (only if the row building cannot live in the planner)
- Test: `server/tests/test_ops_core.py`, `server/tests/test_stale_page_ops.py` (or the existing rename-replay test file: grep for `replay_title_rewrites` tests)

**Interfaces:**
- Consumes: Task 1's `unlink_stale_refs`.
- Produces: a `RecordReplayRewrite`-style effect (name it to match `RecordUnlinkRewrite`; generalising `RecordUnlinkRewrite` into one effect that carries retitles, unlinked titles and inlines is preferred if it stays small). It writes `block_rewrites` rows sharing `base_hash = text_hash(op.text as the client sent it)` and `after_hash = text_hash(written)`.

- [ ] **Step 1: Failing tests.**
  - Rename X→Y. An offline device sends two chained hashed edits of a block containing `[[X]]`: the first is based on the pre-rename hash, the second on the hash of the first edit's text as the client sent it. The second applies clean as `[[Y]] …` with no conflict entry.
  - The same for a delete replay (block_rewrites `unlink` rows, batch without `seen_seq`).
  - Review Focus 4 (two-step replay) and 5 (stale and replay in one batch).
  - A plain hashed edit with no rewrites writes no `block_rewrites` row.
- [ ] **Step 2:** Run the new tests. Expected: FAIL (the second edit lands a conflict entry).
- [ ] **Step 3: Implement.** Record rows only for a `clean` or `identical` outcome whose written text differs from the sent text. The composed row's content is the union of the consumed steps: retitles composed through the chain (A→B then B→C gives A→C and B→C), unlinked titles unioned, inlines unioned. Self-check before recording: re-run `replay_title_rewrites` with only the composed row on the *sent* text and require it to reproduce the written text. If it doesn't, record nothing (today's behaviour). When the batch was also stale, build one row group that covers both: the stale unlink titles plus the replay steps, from hash(sent) to hash(written), under the same self-check. `stale_unlink_effects` must not also add its own rows for that op.
- [ ] **Step 4:** Full server gate as in Task 1 Step 4.
- [ ] **Step 5:** Run `perf/check.sh backend`. Expected: no count changes. A changed count means a plain path gained a statement, so find and remove it. Commit the code, tests and `pkm-wj3x` bean file. Add a row to `docs/troubleshooting.md` (symptom: spurious conflict entry after a chained offline edit following a rename/delete; cause; owning section; bean id).

### Task 3: pkm-ialr: `pt_seed_6` off the title pool

**Files:**
- Modify: `server/tooling/proptest/sync_server.py` (`build_template`, the reserved-uid comment near line 59)
- Modify: `web/src/props/sync/commands.ts` (`DeletePage`: drop the spared branch and its doc lines), `web/src/props/sync/commands.test.ts`
- Modify as needed: `web/src/props/sync/arbitraries.ts` (`SEED_UIDS`/`EDIT_TARGETS` header comment), `harnessClient.ts`, `teeth.prop.ts` (the fixed scenarios create `pt_seed_6` with `page_title: "Proptest"`), `smoke.prop.ts`, `model.ts`, `normalise.ts` and any fixture that counts Proptest's blocks

- [ ] **Step 1:** Seed `pt_seed_6` as the only block of a new page `Fixture`, which is outside `PAGE_TITLES` and never a Rename, DeletePage or Edit target. Proptest then has five seed blocks. Update every fixed scenario and count that assumed six.
- [ ] **Step 2:** Delete DeletePage's "spared" outcome and its test. Every pool page can now be deleted.
- [ ] **Step 3:** `cd web && pnpm test:unit` (props unit tests) and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 4:** `proptest/check.sh web --file sync`. Expected: PASS, and the tally line "examples with a stale batch naming a deleted page" goes up from 103/2100. Report the before/after figures and the suite's wall time.
- [ ] **Step 5:** Commit with the `pkm-ialr` bean file. Update `docs/architecture/property-checks.md` wherever it describes the seed pages or DeletePage's sparing.

### Task 4: pkm-8dgu (server): the Hypothesis ops model draws page deletes, `seen_seq` and attribute texts

**Files:**
- Modify: `server/tests/props/strategies.py`, `server/tests/props/model.py`, `server/tests/props/test_ops_state.py` (and `test_model.py` for model unit tests)

**Interfaces:**
- Consumes: Tasks 1 and 2 (the model's expectations follow the shipped rules).

- [ ] **Step 1:** Read how the state machine drives batches and what the model predicts. Add the following:
  - a page-delete rule (through the real delete path the HTTP route uses, refusing as it refuses);
  - a `seen_seq` on drawn batches (none, current, or before a recorded delete);
  - texts with leading attributes (`X:: v`, `[[X]]:: v`) naming pool titles;
  - model staleness: a stale batch's creates on a deleted page are parked, links and attributes to deleted titles are unlinked or fenced, and no invariant step finds a deleted page re-created.
- [ ] **Step 2:** Add model unit tests in `test_model.py` for the new model functions.
- [ ] **Step 3:** `cd server && uv run pytest -q tests/props` and the full gate. Then run `proptest/check.sh server`. Expected: PASS within about the current 3-minute budget. Report the wall time.
- [ ] **Step 4:** A failure here follows the fix-what-proptests-find rule: a product bug gets a unit test in `server/tests/` and a fix, reported back to the orchestrator before the fix lands. Commit.

### Task 5: pkm-8dgu (web): conflict-noise invariant, attribute texts, orphan-edit teeth

**Files:**
- Modify: `web/src/props/sync/oracle.ts` (and `model.ts` if the model must track who edited what), `arbitraries.ts`, `teeth.prop.ts`, `sync.prop.ts` (tally lines)
- Test: the matching `*.test.ts` beside each

**Interfaces:**
- Consumes: Tasks 1–3.

- [ ] **Step 1: Conflict-noise invariant.** At quiescence, every check-5 text-conflict entry ("overwritten" under a `[[conflict]] … — ((uid))` header) must target a block whose text was edited by at least two clients during the example. A conflict on a block only one client ever edited is spurious noise, and the property fails. Orphan headers (`— edit to a block the server no longer has`, `— deleted while edited elsewhere`) and move notes are exempt. First establish from the code whether a single client can legitimately produce a check-5 conflict (Reload, Fault retries, RotateGeneration, CrossMidnight). Narrow the invariant only for a cause you can name in a code comment, and report each such cause.
- [ ] **Step 2: Teeth for the invariant.** Add a fixed scenario that replays the pkm-wj3x chain (rename, then two chained offline edits) with the Task 2 rows suppressed through a harness switch modelled on `_stale_teeth`. The new invariant must fail with the switch on and pass with it off.
- [ ] **Step 3: Attribute texts.** Draw leading-attribute texts naming pool titles in `arbitraries.ts`, and extend `deleteWins.ts` if its check would miss an attribute ref.
- [ ] **Step 4: Orphan-edit teeth.** In the stale teeth, add the orphan-edit parked-text path: a stale update_text of a block on the deleted page, carrying a live link to the deleted title. With staleness off it re-creates the page; with it on it does not.
- [ ] **Step 5:** `cd web && pnpm test:unit && pnpm typecheck`, then `proptest/check.sh web`. Expected: PASS, with the sync suite near its budget. Report the wall times and the new tally lines.
- [ ] **Step 6:** Update `docs/architecture/property-checks.md` (the invariant list, the teeth and the timings, including AGENTS.md's "sync about 185 seconds" if it moved). Commit with the `pkm-8dgu` bean file.

### Task 6: Branch end

- [ ] `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`; `cd web && pnpm verify`; `perf/check.sh`; `proptest/check.sh`. All green, with the perf table kept for the review package.
- [ ] Architecture docs pass (the `architecture-docs` skill): backend.md "Stale batches" / "Missing targets", the replay-row mechanism as a short prose note, troubleshooting rows.
- [ ] Whole-branch review on the strongest model, then merge `--no-ff` to main and deploy per AGENTS.md.
