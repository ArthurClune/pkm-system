# Security batch: tests and gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six test/gate beans on `security/batch-tests`: three random-draw floors that flaked (pkm-v4uc, pkm-36zw, pkm-76sh), an ops property that never reached the over-limit landing's unlink rule (pkm-7981), a deep-delete test that passes through `ON DELETE CASCADE` (pkm-w6pc), and a title-length parity fixture missing NBSP, combining-mark and lone-surrogate cases (pkm-yeat).

**Architecture:** Only tests and fixtures change; no product code. Floors are re-set from 60 unseeded runs measured at the pre-branch commit (`d1da2a39`). Where lowering a floor would leave the observed failure one event from failing again, the generator is steered instead. The ops machine gains a scripted offline kind that builds the over-limit replay on purpose: the bean's two random-generator changes reached it 0 times in a 380-example merge run.

**Tech Stack:** Python 3 / pytest / Hypothesis (server), vitest (web), shared JSON fixtures.

**Spec:** the six beans (`beans show pkm-v4uc pkm-36zw pkm-76sh pkm-7981 pkm-w6pc pkm-yeat`) and the handover table, `docs/superpowers/handoffs/2026-10-27-security-epic-handover.md` § 2 (main checkout, gitignored). Read AGENTS.md § Testing (property gate rules) and `docs/architecture/checks.md` § Property gate before starting.

## For Arthur (nothing blocks)

There is no product question. The plan takes three engineering decisions; overrule any of them before execution if you disagree:

1. **pkm-7981 retitles: no rename rule in the ops machine.** The retitle half of the over-limit landing (`StepTitles.gone` from `retitles`) is pinned by two tests in `server/tests/test_text_limits_ops.py`: `test_an_over_limit_replay_after_a_rename_does_not_recreate_the_old_title` and `test_an_over_limit_replay_unlinks_a_padded_renamed_away_title`. Both fail against the landing mutant M1 (measured). A rename rule would need a whole rename model in `props/model.py`. The model holds no retitles to mirror, and its comment already says that a rename rule must add the old titles.
2. **pkm-7981: a scripted offline kind instead of the bean's random-generator items.** I prototyped the bean's checklist: a 600,000-char text in `LIMIT_TEXTS`, a ref-doubling `_edit_text` variant, and a ref extension in the "conflict" kind. Together they reached `update_text replay: over the length cap` in **0 of 380** merge examples, so they are dropped. The scripted kind reached the landing with its deleted titles unlinked in **24.6%** of examples. It also reaches `delete page blocker: limit` (7.2%, 0 before). It costs merge-run time: 226 s against a 145 s baseline, details under Task 5.
3. **pkm-v4uc: the `batch input: blank` floor is dropped, not steered.** Over 60 runs its lowest count was 1 (of 86), which is under `with_floors`' five-event bar, so the rule gives it no floor and it stays an `event`. Blank input keeps its floor on the route properties (`input: blank` in `test_no_route_answers_hostile_input_with_a_500` and in `test_hostile_writes_leave_every_read_serialisable`).

## Global Constraints

- Worktree `/Users/arthur/code/llm/pkm/.claude/worktrees/batch-tests`, branch `security/batch-tests`. Run `pwd` first; never touch the main checkout.
- Mutants and measurement scripts live only in a throwaway detached worktree under the scratchpad (`git worktree add --detach <scratchpad>/<name> HEAD`, removed afterwards). Never commit a mutant.
- Do not run `proptest/check.sh` or `perf/check.sh`; the orchestrator runs them serially. Run a long property in the foreground under a cap (`perl -e 'alarm 1500; exec @ARGV' …`), not in the background.
- A custom `pytest -m` replaces `addopts`' `-m 'not proptest'`. Add `and not proptest` to it, or use `-m proptest` only when you mean to run the property suite.
- Comments:
  - no bean ids and no line numbers;
  - at most 80 columns on a comment line, 120 elsewhere;
  - never write "load-bearing";
  - each comment must tell the next reader something they would otherwise spend tool calls finding.
- Commit only the files a task names, by explicit path. End the message with `Co-Authored-By: Claude <model> <noreply@anthropic.com>`; never include a claude.ai session URL.
- A floor is half the lowest share over at least 30 unseeded runs, rounded **down** to three decimals. A label whose lowest count is under five gets no floor (`with_floors`' docstring).

## Measurements (pre-branch commit `d1da2a39`)

Each floored property ran 60 times unseeded, and a scratch patch to `with_floors` logged each run's tally (Task 1 commits that hook as `PKM_FLOOR_LOG`). In the table, `share` is a label's count over the `per` label, and `fails` counts the runs that would have failed the current floor.

| Property / label | floor now | min share | min count | median | half min | fails |
|---|---|---|---|---|---|---|
| `test_a_hostile_cli_batch_is_applied_or_refused[False]` blank | 0.058 | 0.012 | 1 | 0.311 | 0.006 | **1** (1 of 86) |
| same, lone surrogate | 0.06 | 0.114 | 10 | 0.329 | 0.057 | 0 |
| same, `batch: applied` | 0.054 | 0.106 | 9 | 0.269 | 0.053 | 0 |
| same, refused by the planner | 0.11 | 0.247 | 21 | 0.500 | 0.124 | 0 |
| `[True]`, every label | | ≥ 0.133 | ≥ 12 | | ≥ 0.067 | 0 |
| `test_unlink_walk_matches_the_recursive_walk` alias dropped a span | 0.016 | 0.024 | 12 | 0.089 | 0.012 | 0 (7/500 seen in a full run) |
| same, matched a run holding runs | 0.09 | 0.172 | 86 | 0.286 | 0.086 | 0 |
| same, matched a tag in an opened run | 0.017 | 0.038 | 19 | 0.128 | 0.019 | 0 |
| goodlinks `GET check -> 503` | 0.041 | 0.073 | 22 | 0.158 | 0.037 | 0 |
| goodlinks `POST resolve -> 200` | 0.021 | 0.040 | 12 | 0.087 | 0.020 | 0 |
| describer `describe: DescribeError` | 0.24 | 0.464 | 116 | 0.620 | 0.232 | 0 |
| describer `describe: description` | 0.11 | 0.180 | 45 | 0.380 | 0.090 | 0 |
| describer `upstream: 4xx` | 0.046 | 0.064 | 16 | 0.160 | 0.032 | 0 |

Every other label of these properties already sits at or below half its lowest share. Shares are heavy-tailed because the examples within one run are correlated:

- One run in sixty drew blank once, against a median of 27.
- Several labels' lowest share over runs 31-60 was half their lowest over runs 1-30.

So a floor set near the typical share, or from a few runs, flakes.

What reproduced:

- **pkm-v4uc** reproduced as `('batch input: blank', 1, 86)`.
- **pkm-36zw** and **pkm-76sh** did not fail in 60 runs, but each property had floors above half the measured lowest share.
- pkm-76sh's failing label was never logged, so the five floors above half-min are the candidates.

No run produced a 5xx, and pytest-randomly is not installed.

## Review Focus

1. **A steered generator that stops drawing the unsteered cases.** Task 2's alias prefix fires in one draw in four. The unlink property's other labels must keep their shares, so re-measure every label, not only the steered one.
2. **The scripted ops kind eating the rest of the machine's coverage.** It deletes up to two pages per call, which removes their pool blocks. At full weight the prototype halved `skip: cycle` (37.8% → 15.7%) and `text: past a limit` (16.0% → 7.7%). Task 5 gates the kind behind a coin and compares the whole event table against the baseline below.
3. **A mutant that "fails" for the wrong reason.** The property must fail on `deletes_agree` or `no_text_lost`, not on an error in the new rule's own code. Read the assertion, not just the exit code.
4. **A lone-surrogate fixture case replaced on load.** U+FFFD is one code point too, so the cases would still pass if the surrogate were replaced. Task 4 asserts that each side loads it unreplaced.
5. **A deep-delete test that a refactor silently bypasses.** If `_execute` is renamed or the delete stops emitting `DeleteBlocks`, the recording wrapper must fail loudly. Task 3 asserts that exactly one `DeleteBlocks` was seen, so an empty list fails instead of passing.

---

### Task 1: The floor log, and pkm-v4uc's and pkm-76sh's floors (sonnet)

**Files:**
- Modify: `server/tests/hostile.py` (`with_floors`)
- Modify: `server/tests/test_no_500_request_props.py` (floors of `test_a_hostile_cli_batch_is_applied_or_refused`, and the comment above it)
- Modify: `server/tests/test_no_500_upstream_props.py` (floors of `test_goodlinks_routes_answer_any_upstream_cleanly` and `test_the_describer_turns_any_answer_into_a_description_or_an_error`)

**Interfaces:**
- Produces: the env var `PKM_FLOOR_LOG`. When it is set, `with_floors` appends one JSON line per property run to that path, before its asserts:
  - `test`: the function's `__name__`;
  - `params`: the kwargs whose values are bool, int or str;
  - `per`: `TALLY[per]`;
  - `floors`: the floors dict;
  - `tally`: `TALLY[label]` for each floor label.

  Task 2 uses it.

- [ ] **Step 1: Add the log to `with_floors`.** After `total = TALLY[per]` and before `assert total, per`, append the line when `os.environ.get("PKM_FLOOR_LOG")` is set (append mode, `json.dumps`).
  - Change the share assert's message so that a gate log says what failed: `f"{label}: {TALLY[label]} of {total} {per}s, under the floor {share}"`.
  - Rewrite the docstring's measuring paragraph to say three things. A floor is half the lowest share over at least 30 unseeded runs, rounded down to three decimals. `PKM_FLOOR_LOG` collects the runs. Shares are heavy-tailed because a run's examples are correlated: a label fell to a twentieth of its median in one run of sixty, so a floor near the typical share, or set from a few runs, fails with nothing wrong.
  - Keep the docstring's sentences on the five-event bar and on pytest parameters.

- [ ] **Step 2: Check that the log works.**

Run: `cd server && PKM_FLOOR_LOG=<scratchpad>/fl.jsonl uv run pytest -q --no-cov tests/test_no_500_upstream_props.py && wc -l <scratchpad>/fl.jsonl`
Expected: 2 passed, and 2 lines in the log.

- [ ] **Step 3: Re-set pkm-v4uc's floors** in `test_a_hostile_cli_batch_is_applied_or_refused`:
  - remove `"batch input: blank"`;
  - set `"batch input: lone surrogate": 0.05` and `"batch: applied": 0.05`;
  - leave `"batch: refused by the planner"` at `0.11`.

  Rewrite the comment above the test: `batch input: blank`, `NUL` and `very long` have no floor because each fell under five events in some run (blank: once in 86).

- [ ] **Step 4: Re-set pkm-76sh's floors.** Leave every other floor as it is.
  - Goodlinks: `"GET check -> 503": 0.036` and `"POST resolve -> 200": 0.02`.
  - Describer: `"describe: DescribeError": 0.23`, `"describe: description": 0.09` and `"upstream: 4xx": 0.032`.

- [ ] **Step 5: Run the two files.**

Run: `cd server && uv run pytest -q --no-cov tests/test_no_500_request_props.py tests/test_no_500_upstream_props.py`
Expected: all pass.

- [ ] **Step 6: Commit** `server/tests/hostile.py`, `server/tests/test_no_500_request_props.py` and `server/tests/test_no_500_upstream_props.py`. Message: `tests: floors at half the lowest share over 60 runs; PKM_FLOOR_LOG`, with these labels' measurement rows in the body.

### Task 2: Steer the unlink walk's alias case (pkm-36zw) and record the floor failures (sonnet)

Lowering `alias dropped a span` to its half-min (0.012) would let the observed 7/500 pass by a single event, so the generator is steered instead. A prototype of exactly this change measured the label at min 0.224 and median 0.277 over 10 runs (it was 0.024 and 0.089). The other labels did not drop.

**Files:**
- Modify: `server/tests/test_bracket_walk_equivalence.py` (`_unlink_cases`, a new `_TAG_KEYS`, and the floors of `test_unlink_walk_matches_the_recursive_walk`)
- Modify: `docs/troubleshooting.md` (a new section)

**Interfaces:**
- Consumes: `PKM_FLOOR_LOG` (Task 1).

- [ ] **Step 1: Steer.**
  - Add `_TAG_KEYS = ("AI", "ai", "Old", "é")` beside `_KEYS`, commented as the keys a `#key` tag spells whole.
  - In `_unlink_cases`, after drawing the text: when some drawn key is in `_TAG_KEYS`, prefix `f"[x #{key}]([[{key}]]) "` in one draw in four (`draw(st.integers(0, 3)) == 0`), with `key` drawn from those keys.
  - Comment the prefix: an alias whose label holds a tag of a target drops the tag span collected before it. That is the only path on which the walk's span order shows in the output (`_noting_drops`). Unsteered, it was drawn in 2.4% of cases at worst over 60 runs, and in 1.4% in one full run.

- [ ] **Step 2: Measure 30 runs.**

Run: `cd server && for i in $(seq 30); do PKM_FLOOR_LOG=<scratchpad>/unlink.jsonl uv run pytest -q --no-cov -p no:cacheprovider tests/test_bracket_walk_equivalence.py::test_unlink_walk_matches_the_recursive_walk >/dev/null || echo "run $i failed"; done`

Then, for each label, summarise the min share, min count, median and half min with a throwaway script in the scratchpad that reads the JSON lines. Do not commit the script.
Expected: no failed run, and the lowest share of `alias dropped a span` well above 0.1.

- [ ] **Step 3: Set every floor of this property** to its half-min from Step 2, rounded down to three decimals. A label whose lowest count is under five gets no floor. Put the measured lowest shares in the commit body.

- [ ] **Step 4: Run the file.**

Run: `cd server && uv run pytest -q --no-cov tests/test_bracket_walk_equivalence.py`
Expected: all pass.

- [ ] **Step 5: Add the troubleshooting row.** Add a section `## Property checks` just before `## Performance checks`, with the owner line `Owner: [checks.md § Property gate](architecture/checks.md#property-gate)` and one row:
  - **Symptom:** ``A full server `pytest` run fails a `with_floors` share, e.g. `('batch input: blank', 4, 92)`, and passes when rerun``
  - **Cause:** `A run's draws are correlated, so a label's share is heavy-tailed (blank fell to 1 of 86 in one run of 60), and floors sat above half the lowest share. Floors are now half the lowest of 60 runs, or the generator draws the case more often`
  - **Where:** the checks.md link
  - **Ref:** `pkm-v4uc, pkm-36zw, pkm-76sh`

- [ ] **Step 6: Commit** `server/tests/test_bracket_walk_equivalence.py` and `docs/troubleshooting.md`.

### Task 3: The deep-delete test observes the walk (pkm-w6pc) (sonnet)

Tombstones cannot show the walk. Measured: the `blocks_chg_ad` trigger also fires for cascade deletes, so a truncated walk still journals every uid. The test therefore records the `DeleteBlocks` effect instead, on both delete paths: the hashless delete uses `_subtree_with_height`, and the hashed one uses `subtree_rows`.

**Files:**
- Modify: `server/tests/test_ops_apply.py` (`test_delete_removes_entire_deep_subtree`)

- [ ] **Step 1: Rewrite the test** as `test_delete_removes_entire_deep_subtree(db, depth, hashed, monkeypatch)`:
  - Parametrize `depth` over `[100, 101, 102, 150]` and `hashed` over `[False, True]`.
  - Wrap `ops_apply._execute` with `monkeypatch.setattr`, so that each `DeleteBlocks` effect's `uids` is recorded before the call is passed to the original.
  - The hashed op carries `base_subtree_hash=subtree_hash((op["uid"], op["text"]) for op in _linear_chain("Machine Learning", depth))`.

  Assert:

```python
assert len(deletes) == 1                      # one DeleteBlocks effect
assert sorted(deletes[0]) == sorted(f"level{i}" for i in range(depth))
assert result.skipped == []
```

  Keep the `remaining == 0` row check. Replace the old comment with this one: the cascade on `blocks.parent_uid` removes whatever the walk misses, and the changes trigger fires for those rows too, so only the effect's uid list shows whether the walk reached full depth.

- [ ] **Step 2: Green.**

Run: `cd server && uv run pytest -q --no-cov tests/test_ops_apply.py -k deep_subtree`
Expected: 8 passed.

- [ ] **Step 3: Red against the depth-cap mutants**, in a detached scratch worktree with the new test copied in. In both mutants the cap walks levels 0-100, so depths 100 and 101 fit; the old test passes against both.
  - **Mutant A:** in `ops_apply._subtree_with_height`, change the recursive member's `WHERE instr(s.path, ',' || b.uid || ',') = 0` to `... = 0 AND s.depth < 100`, then run the `-k deep_subtree` command there. Expected: `hashed=False` fails at depths 102 and 150 (measured).
  - **Mutant B:** make the same edit in `subtree_rows`. Expected: `hashed=True` fails at 102 and 150 (measured).

  Record both outputs for the review package, then remove the worktree.

- [ ] **Step 4: Commit** `server/tests/test_ops_apply.py`.

### Task 4: Title-length fixture: NBSP, combining marks, lone surrogates (pkm-yeat) (sonnet)

Measured in a scratch worktree with the cases below: both sides pass. A lone surrogate written as a JSON escape loads unreplaced through all three readers:
- Python's `json.loads`;
- vitest's JSON import (`grammar/titleLength.test.ts`);
- `JSON.parse` (`replica/titles.test.ts`).

It must be an escape: a raw lone surrogate cannot be encoded in UTF-8, so the file would not load at all.

**Files:**
- Modify: `shared/fixtures/title_length.json`
- Modify: `server/tests/test_title_length_fixture.py`
- Modify: `web/src/grammar/titleLength.test.ts`

- [ ] **Step 1: Add the cases**, written with `\u` escapes so that a reviewer can see the characters. Add these to `titles`:

| name | parts | violation | why |
|---|---|---|---|
| `nbsp_edges_strip` | `[[" ",1],["t",1000],[" ",1]]` | null | NBSP is in `TITLE_WHITESPACE`, so the fold changes the title and its edges strip (contrast `single_space_edges_count`) |
| `an_nbsp_run_counts_once` | `[["t",999],["  ",1],["t",1]]` | 1001 | |
| `combining_marks_at_the_cap` | `[["é",500]]` | null | no normalisation form is applied, so a mark is its own code point |
| `combining_marks_count_apart` | `[["é",500],["t",1]]` | 1001 | |
| `lone_surrogates_at_the_cap` | `[["\ud800",1000]]` | null | one code point each |
| `lone_surrogates_over_the_cap` | `[["\udc00",1001]]` | 1001 | |

  Give each violation `"describe": "title of 1001 characters is over the limit of 1000"`. Add these to `texts`:
  - `a_lone_surrogate_link_over_the_cap`: `[["[[",1],["\ud800",1001],["]]",1]]` → 1001, with the `op_describe` wording of `link_over_the_cap`;
  - `an_nbsp_fold_brings_a_link_to_the_cap`: `[["[[",1],["t",500],["  ",1],["t",499],["]]",1]]` → null.

  Do not add a case that splits a surrogate pair across two parts. Python keeps `"\ud83d" + "\ude00"` as two code points while JS reads them as one, and no request can reach that difference: a request body's lone surrogates become U+FFFD, and a pair escape decodes whole.

- [ ] **Step 2: Assert that the cases load unreplaced.**
  - Server: add `test_the_lone_surrogate_cases_load_as_lone_surrogates`. For every case, in titles and texts, whose name contains `lone_surrogate`, assert that some character of `_text(case)` lies in U+D800-U+DFFF.
  - Web, in `titleLength.test.ts`: the same check over the imported fixture, matching `/[\ud800-\udfff]/` (no `u` flag) against `textOf(c.parts)`.

- [ ] **Step 3: Run both sides.**

Run: `cd server && uv run pytest -q --no-cov tests/test_title_length_fixture.py`, then `cd web && pnpm exec vitest run src/grammar/titleLength.test.ts src/replica/titles.test.ts`
Expected: all pass.

- [ ] **Step 4: Red, in a scratch worktree** (both measured):
  - **Server mutant:** in `refs.title_length_over`, measure `len(unicodedata.normalize("NFC", normalize_title(text)))`. Expected: `combining_marks_count_apart` fails.
  - **Web mutant:** in `titleLengthOver`, replace `codePointLength(normalizeRefTitle(text))` with `codePointLength(text)`. Expected: `nbsp_edges_strip` and `an_nbsp_run_counts_once` fail, along with the existing fold cases.

  Record both outputs, then remove the worktree.

- [ ] **Step 5: Commit** the three files.

### Task 5: The ops property reaches the over-limit landing (pkm-7981) (opus)

**Files:**
- Modify: `server/tests/props/limit_texts.py` (two constants)
- Modify: `server/tests/props/test_ops_state.py` (`offline_edit`, `delete_page`, and a new `_over_the_cap`)
- Modify: `server/tests/props/test_model.py` (one model test, and `test_limit_texts_are_what_they_claim`)
- Modify: `server/tests/props/model.py` (the rename comment in `Model._update_text`)
- Modify: `docs/architecture/checks.md` (the suite table in § Property gate)

**Interfaces:**
- Produces:
  - `limit_texts.COPIES_PAST_CAP: int = 10` and `limit_texts.LONG_WITHIN_CAP: str = "x" * (TEXT_CAP // COPIES_PAST_CAP + 1)`;
  - `OpsMachine._delete_page(self, title: str) -> int`, which returns the HTTP status;
  - `OpsMachine._over_the_cap(self, data: st.DataObject, word: str) -> None`.

**How the path is reached:**

1. Block P on page X holds `LONG_WITHIN_CAP`. One copy of it fits the cap; ten copies do not.
2. Block B, on another page, holds `[[X]] ((P))` (or `#X ((P))`).
3. Deleting X inlines P's copy into B (about 100,000 characters) and records one rewrite that unlinks X.
4. A device that missed the delete edits B, hashed on `[[X]] ((P))`, and sends that text with nine more `((P))`. The replay of the rewrite inlines ten copies, which is past the cap.
5. So the edit lands as a conflict entry and B keeps its text. The landing must have X made plain, or the entry re-creates page X.

With `past`, B also links `[[Z]]`, and Z is deleted after X. The chain then has a second step beyond the one over the cap, and that step's title must be made plain too (`_replay` walks on past the stopped step).

The first prototype used one copy of 600,000 characters, doubled. That merge run took 840 s against the baseline's 145 s, so the copy is small and repeated instead.

- [ ] **Step 1: The constants.** In `limit_texts.py`, add `COPIES_PAST_CAP` and `LONG_WITHIN_CAP` with a comment: a stored text one copy of which fits the cap and `COPIES_PAST_CAP` copies do not, so a page delete can inline it and a replay that inlines it that many times is over the cap. Kept small because the invariants re-read every stored text after every step. It is not in `LIMIT_TEXTS`: nothing about it is at a limit. In `test_model.py`, extend `test_limit_texts_are_what_they_claim` with `assert len(LONG_WITHIN_CAP) * COPIES_PAST_CAP > TEXT_CAP > len(LONG_WITHIN_CAP) + 1000` (import the names).

- [ ] **Step 2: Pin the two-step model rule.** In `test_model.py`, beside `test_edit_whose_replay_passes_the_cap_lands_with_deleted_titles_plain`, add `test_an_over_cap_replay_unlinks_the_titles_of_steps_past_it`:
  - Setup: P on Alpha with `"e" * 600_000`, and B on Beta with `f"[[Alpha]] [[Gamma]] (({P}))"`.
  - `delete_page` Alpha at `seq_of(9)`, then Gamma at `seq_of(10)`.
  - Apply the edit `f"[[Alpha]] [[Gamma]] (({P})) (({P}))"`, hashed on `f"[[Alpha]] [[Gamma]] (({P}))"`.
  - Assert `kept_texts == (f"Alpha Gamma (({P})) (({P}))",)` and `skipped == ((0, "update_text", B, "text_limit"),)`, that the path is `"update_text replay: over the length cap, gone titles unlinked"`, and that neither title is in `m.pages`.

  It passes at once, because the model rule already exists. What it adds is a pin on the rule that the machine now reaches.

  Run: `cd server && uv run pytest -q --no-cov tests/props/test_model.py -k "over_cap or limit_texts"`

- [ ] **Step 3: Split `delete_page`.** Move everything after the title draw into `_delete_page(title) -> int`, which returns `r.status_code` from both the refused and the applied branch. `delete_page` keeps the title draw and calls it. Behaviour is unchanged.

- [ ] **Step 4: The scripted kind.**
  - In `offline_edit`, add `"over the cap"` to `kinds` when there is a live block, a pool uid that is not live (`len(live) < len(UIDS)`), and a coin drawn true (`data.draw(st.booleans(), label="over the cap offered")`). The coin halves its share of the rule's calls, because at full weight it halved other paths (Review Focus 2).
  - Dispatch the kind to `_over_the_cap(data, word)` before the `queue` branch.
  - Add a docstring bullet: one sentence on what it builds, one on what the landing must do.

  `_over_the_cap` draws, each with a `label`:
  - `block`: B, from the live blocks;
  - `page`: X, from `PAGES` minus B's page;
  - `copied`: P, from the pool uids that are not live;
  - `past`: a boolean;
  - `form`: `"[[{}]]"` or `"#{}"`, for X.

  Then:
  - Build `before = form.format(X)`, then ` [[Z]]` when `past` (Z is the one page in `PAGES` other than B's and X), then ` ((P))`.
  - `_send` a top-level create of P on X with `order_idx` 0 and text `LONG_WITHIN_CAP`, then `_send` a hashless `update_text` of B to `before`.
  - Call `_delete_page(X)`, and when `past`, `_delete_page(Z)`. A refused delete ends the step after `event("offline over the cap: first delete refused")` (or `"... second delete refused"`).
  - Build `sent = before + f" (({P}))" * (COPIES_PAST_CAP - 1)`, plus `" " + word` when an `extend` boolean is drawn.
  - Call `event(f"offline over the cap: {'two steps' if past else 'one step'}")`, then `_send` the `update_text` of B to `sent` with `base_text_hash=text_hash(before)` and no `seen_seq`.

  Every send goes through `_send`, so the model decides each outcome; `_over_the_cap` asserts nothing of its own.

- [ ] **Step 5: Dev run.**

Run: `cd server && TZ=Europe/London uv run pytest -m proptest --no-cov -q tests/props/test_ops_state.py --hypothesis-show-statistics`
Expected: pass, with `update_text replay: over the length cap, gone titles unlinked` among the events.

- [ ] **Step 6: Reach in a merge run.**

Run: `cd server && perl -e 'alarm 1500; exec @ARGV' env TZ=Europe/London HYPOTHESIS_PROFILE=merge uv run pytest -m proptest --no-cov -q tests/props/test_ops_state.py --hypothesis-show-statistics`. It takes about four minutes; do not start it while perf or another property suite runs.

Expected: `update_text replay: over the length cap, gone titles unlinked` in roughly 10-15% of examples. At full weight, without the coin, the prototype measured:

| event | rate |
|---|---|
| landing, gone titles unlinked | 24.6% |
| `offline over the cap: two steps` | 18.1% |
| `offline over the cap: one step` | 11.6% |
| first delete refused | 9.6% |
| second delete refused | 2.7% |
| `delete page blocker: limit` | 7.2% |

Compare the whole event table with the baseline at the end of this plan. Report any other rate that halves; it is a finding, not something to tune away. Report the wall time too (prototype 226 s against the baseline's 145 s), since it adds to the gate's server budget.

- [ ] **Step 7: The mutants**, in a detached scratch worktree with this task's test changes applied. Both were measured against the 600,000-char prototype; re-run them against the final version.
  - **M1, the bean's mutant:** in `ops_core.plan_op`'s `ReplayOverLimitContext` branch, replace `landed = over_limit_landing_text(op.text, ctx.replayed, ctx.canonical, ctx.blind)` with `landed = op.text`. Run the Step 5 command. Expected: it fails on `deletes_agree` (measured: `assert {'Alpha', 'Beta'} == {'Alpha'}`; the landing's link re-created the deleted page). Shrinking can take many minutes; let it finish.
  - **M2, a narrowing of the walk:** in `ops_core._replay`, add `break` after `stopped_at = base_hash`, so the walk stops at the step over the cap. Expected: it fails on `deletes_agree` through a `past` example (measured: `assert {'Alpha', 'Gamma'} == {'Alpha'}`, so the title of the step past the stop came back; 279 s). The unit test `test_an_over_limit_replay_unlinks_titles_past_the_step_it_stopped_at` also fails against M2.

  Record both failures (the invariant, and the rule names of the shrunk steps) for the review package, then remove the worktree.

- [ ] **Step 8: The rename comment.** In `Model._update_text`, replace "The machine draws no rename, so a `Rewrite` carries no retitles and `gone` is the deleted titles alone; a rename rule must add the old titles." Keep that fact, and add where the retitle half is pinned: the two rename tests named under "For Arthur", by function name.

- [ ] **Step 9: checks.md.** In § Property gate's suite table, add to the Holds cell of the `test_ops_state.py` row: "an over-limit replay's landing, with its deleted titles plain". Invoke the `architecture-docs` skill for the edit.

- [ ] **Step 10: Commit** the five files.

### Task 6: Close (sonnet)

- [ ] **Step 1:** `cd server && uv run pytest -q`. Expected: pass, with the coverage gate met.
- [ ] **Step 2:** `cd server && uv run pyrefly check`, then `uv run ruff check`. Expected: clean.
- [ ] **Step 3:** `cd web && set -o pipefail && E2E_PORT=8976 pnpm verify`. Expected: exit 0.
- [ ] **Step 4:** From the repo root, `PYTHONPATH=server/tooling python3 -m commentlint.run --all`. Expected: clean.
- [ ] **Step 5:** Tick each bean's checklist items with what was done; the bean files are already modified in the worktree, so commit them by path. Report to the orchestrator:
  - the floor table;
  - the reach table and the event-table comparison;
  - both mutant outputs from Task 3, Task 4 and Task 5;
  - that `proptest/check.sh server` and `perf/check.sh` are theirs to run. Perf should find nothing, since no product code changed.

## Baseline event rates (merge, 380 examples, `d1da2a39`, 145 s)

The rates that matter for Review Focus 2, as the baseline against the prototype at full weight:

| event | baseline | prototype |
|---|---|---|
| `skip: cycle` | 37.8% | 15.7% |
| `text: past a limit` | 16.0% | 7.7% |
| `text: nest hidden in code` | 4.0% | 1.0% |
| `update_text replay: clean` | 3.0% | 0.7% |
| `delete page: 200` | 46.0% | 69.6% |
| `update_text hash: replay` | 9.0% | 25.5% |
| `update_text replay: conflict, edit rewritten` | 4.3% | 12.8% |
| `offline: a queued edit links a dropped title again` | 0.3% | 10.6% |

No other baseline rate fell by half or more. For the full table, run the Step 6 command in a detached worktree at the merge base.
