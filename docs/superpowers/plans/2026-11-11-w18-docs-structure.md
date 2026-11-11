# W18 Docs Structure: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** Split the write path out of `backend.md` into `write-path.md` with one "Work bounds under the write lock" section; state each auth mechanism once (mechanism in `backend.md`, threat and consequence in `SECURITY.md`); merge troubleshooting rows that share a symptom and a guard; slim AGENTS.md to what every session needs; point code comments at the architecture docs instead of a frozen July spec; give `check-docs.mjs` a reference point that a commit cannot reset; trim the docs this epic grew; then run `recheck-docs` over the whole set. No code token changes anywhere.

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W18, its Global Constraints and Review Focus item 5; evidence in the local review report `08-docs.md` (findings 1, 2, 4, 6, 8, 9, 12). Branch `docs/structure`, read at `main` @ `0992997f`, with every package but W11 (in progress in `.worktrees/w11-lease`, no commits yet) and W19 (deferred) merged.

**Architecture:** The tooling change lands first, so that every later task is checked by the stricter `check-docs.mjs`. Then the anchor moves (the split, then the bounds section), each with its citers in the same commit, run serially. Then the trims and merges, in parallel lanes that own disjoint files and rename no heading. `recheck-docs` runs last, over the result.

**Tech stack:** Markdown and mermaid (`docs/`), one Node script (`.claude/skills/architecture-docs/check-docs.mjs`), skill files, and comment-only edits to Python and TypeScript.

## Global Constraints

- Every task: its own worktree off `docs/structure` (path `.worktrees/w18-<task>`, branch `docs/structure-<task>`), merged back with `git merge --no-ff`. Run `pwd` and `git branch --show-current` before the first write. Stage by path, never `git add -A`.
- `check-docs.mjs` needs `web/node_modules` for mermaid. In a worktree without an install, symlink the main checkout's `web/node_modules` and remove the symlink before staging.
- Every edit under `docs/architecture/` or to `docs/troubleshooting.md` goes through the `architecture-docs` skill. Every skill edit goes through `superpowers:writing-skills` first.
- **No code token changes.** A task that touches a file under `server/`, `web/` or `shared/` changes comments, and docstrings that are not route or model docstrings, and nothing else, except Task 10's one model docstring and the regeneration it forces. The token check in Final checks proves this per file.
- `server/tooling/perfcheck/fixture.py` stays byte-identical: no task lists it. Its hash (`perfcheck.build.fixture_hash`, the sha256 of its source) is `cbc83f86b4d84f1a` today, the value both `perf/baseline-*.json` record.
- Wave 2 renames and removes no heading in any file. A heading a trim wants to change goes on that task's report, for Task 12. This keeps every anchor that another lane, a code comment or a troubleshooting row cites stable while the lanes run.
- Docs carry no counts and no copied constant values; durable guidance carries no numeric thresholds; never the phrase AGENTS.md § Writing guidance bans.
- Do not write a literal `<doc>.md#<anchor>` into this plan, a spec or a bean for an anchor that is moving: frozen records keep their text, and `check-docs.mjs` scans them.
- Commit messages say what was **corrected** (a claim was wrong), **restructured** (no claim changed) and **moved** (with its destination). End with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never a session URL.

## Review Focus

1. A moved anchor or section that something still cites (epic Review Focus 5). Markdown links are caught by `check-docs.mjs` once Task 1 lands (same-file links included); code comments cite the write-path sections by name, not by anchor (`server/tests/props/model.py`, `test_model.py`, `limit_texts.py`), and only the grep in Final checks finds those.
2. A rule lost in a trim. Every deleted rule sentence names the test, lint or type that enforces it, or it stays. The dropped-identifier list, now taken against the branch base, is accounted for line by line.
3. A troubleshooting merge that loses an incident: the set of bean ids in the Ref column, and every quoted banner or error string in a Symptom cell, are the same before and after.
4. A comment edit that changes code: the per-file token check, and the OpenAPI diff limited to one `description` string.

---

## Where the repo disagrees with W18

The repo wins; the tasks are written to it.

| W18 says | The repo says | Consequence |
|---|---|---|
| Move "Page mutations" | The heading is `### Page mutations and the sidebar`. All other named sections exist under the epic's names. `### Hostile input` sits under `## HTTP API reference`, not at top level. | Task 3 moves the heading as it is. |
| Planning holds Ordering, Refs, Timestamps, Idempotency, Well-formed text | Planning has nine labelled bullets: those five plus Text limits, Replayed text, Title reader, Replay budget. | Task 3 moves all nine. Task 4 moves Text limits, Replayed text and Replay budget into the bounds section; Title reader stays in Planning. |
| Repoint inbound anchors with `git grep 'backend.md#'` | 154 cross-file `backend.md#` citations: troubleshooting 84, `docs/architecture` 41, `SECURITY.md` 11, server code 6 (all to Auth and Login throttle, which stay), frozen plans and specs 7, `deploy/README.md` 2, `AGENTS.md` 1, `cli.md` 1, one bean. **57 cite a moving anchor, all in `docs/`:** troubleshooting 36, `sync-and-offline.md` 6, `SECURITY.md` 3, `import-export-and-backup.md` 3, `overview.md` 2, `sync-recovery.md` 2, and one each in `assistant.md`, `cli-and-mcp.md`, `files-and-assets.md`, `frontend-editor.md`, `frontend-rendering.md`. None in code, frozen records or beans. | Task 3's list. |
| (not stated) | `backend.md` itself has 28 same-file links (`](#planning)` and the like) to moving anchors, and the moving sections link back to `#auth`, `#refused-titles`, `#hostile-input` and others. **`check-docs.mjs` does not check same-file links at all**: its link regex needs a file before the `#`. | Task 1 adds same-file link checking before the split, or the split breaks these silently. |
| `props/model.py` cites backend.md anchors | It cites sections by name (`backend.md § Planning (text limits)`), as do `test_model.py` and `limit_texts.py`: 30 lines. Some use the old name "§ Page mutations". `checks.md` says the model "encodes backend.md and sync-and-offline.md" in prose. | Task 3 repoints these by name in the split commit; Task 4 repoints the ones its section takes. |
| Auth, Login throttle and Hostile input "lose every sentence SECURITY.md also carries" | Read literally this moves mechanisms out of the doc that owns them, against the `architecture-docs` rule "dedupe toward the doc that owns the mechanism". The duplicated pairs (review finding 9) are: the gate's public routes; the origin rule; `Referrer-Policy`; throttle keying per listener; `apply_batch` holding the lock and the uncharged costs (near verbatim in SECURITY's Known limitations). | Task 5 decides by kind: a mechanism sentence lives in `backend.md` or `write-path.md`; a threat, consequence or limitation sentence lives in `SECURITY.md`, which links the mechanism. Open question 2. |
| "The 53 comments citing `offline-editing-design.md §N`" | 60 lines in `server`, `web`, `shared`: 3 are commentlint test data (`test_commentlint_core.py`, keep), 2 are generated (`web/src/api/openapi.json`, `types.d.ts`, from `CreatePageOp`'s model docstring in `contracts/ops.py`). **55 hand-written lines in 37 files**: 22 in 12 `server/src` files, 5 in `server/tests`, 28 in 20 `web` files. | Task 10. Editing `CreatePageOp`'s docstring forces a regeneration. |
| Two comments contradict the code | They contradict the **spec they cite**, not the code: the spec never mentions a subtree hash (`DeleteOp.base_subtree_hash` came from `2026-09-30-hash-guarded-delete-design.md`), and its §2 lands a conflict copy as a sibling, where the code lands it on the daily page. `conflict_label`'s docstring no longer says "check 1". | Task 10 repoints both to `write-path.md` § Conflicts and checks each sentence against `ops_core.descendant_copy_effects` and `conflict_notes.conflict_label`. |
| The deploy verification recipe is in AGENTS.md § Testing | It is in § Production and ports (the "Verify a deploy rather than trusting…" bullet). `deploy/README.md` § Updating exists and lacks both the recipe and `CI=true`. | Task 2. |
| Drop the per-suite time budgets | W17 already cut them to two totals ("the server is about 4½ minutes and the web side about 6½ minutes"), in the Property checks bullet. | Task 2 drops the totals and keeps the pointer to each suite's constant. |
| Copied constants such as `MAX_LINK_NESTING` = 32 | That literal is gone. What remains: `write-path` text "an `OpBatch` of 1–500 ops", "one block opens 32 runs", "32 deep"; `backend.md` "refused at 1,002", "about 1 KiB/s at 300 s" (`WRITE_STALL_TIMEOUT_S`), "routes three loggers to two handlers", Testing's seed pages and date (`SEED_PAGES`), "Two tests pin"; `frontend-rendering.md` "`MAX_DEPTH` of 3, and `QueryBlock` stops at 2"; heading "Availability: two values, one owner" (`sync-recovery.md`); `deploy/README.md` "all three jobs"; AGENTS.md's suite totals. vitest's 60 s, pydantic-core's 255 levels and uvicorn's 5 s keep-alive are other projects' values, quoted as facts, and stay. | Each owning task names its hits below. |
| `docs/superpowers/README.md` | Does not exist. | Task 2 creates it. |
| `check-docs.mjs` reports size against the merge-base and the last re-check | It compares names, new long sentences and size against `HEAD` only, so a committed edit reads `+0`. Its inbound scan reads every tracked `.md` (frozen plans, specs and beans included, where a moved anchor can never be fixed) and no code. It names `CLAUDE.md`, which does not exist. Its header promises six checks and lists five. | Task 1. |
| `recheck-docs` writes `last-recheck` and a trailer | It writes nothing. Step 1 finds the last re-check with `git log -i --grep='re-check'`, which matches code commits ("re-check the route after each await"); no re-check has run since the skill was added. `check-arch-docs` uses the same grep, falling back to `7d842de`. | Task 11. |
| A trailer may clash with `.githooks/commit-msg` | The hook rejects `claude\.ai/code/` and `^\s*Claude-Session:` only. `Docs-Recheck: <sha>` passes. | No hook change; Task 11 proves it. |
| Add Backend subheadings "Writes stall or 503", "A deleted or renamed page comes back", "A route answers 500" | § Backend already has four: "Titles and the ref grammar", "Writes, conflicts and races", "500s from hostile input", "Reads, startup and logging". Only `troubleshooting.md`'s § Performance checks is cited from outside, so subsections can be renamed freely. | Task 9 re-keys the existing four into symptom families. |

## Measured

At `0992997f`. Growth is since the review commit `09e433e8`.

| File | Words | Growth | Where it grew |
|---|---|---|---|
| `backend.md` | 15,556 | +680 | The write lock +146, Module map +142, HTTP API reference +90, Auth +67, Planning +61, Generated artifacts +61 |
| `troubleshooting.md` | 14,746 | +1,205 | Assistant +270, "Server rejected a change" +183, Frontend shell +167, "Local sync is stuck" +133, Writes, conflicts and races +78, Rendering +72 |
| `frontend.md` | 4,898 | +1,047 | Fetch state +316 (new), The chat machine +289, Popovers and menus +251, Module map +93, Linked references +69 (new) |
| `assistant.md` | 4,860 | +665 | The turn phase +331, The stream contract +114 (new), The blocks a write changes +75 |
| `sync-recovery.md` | 4,267 | +634 | Calls that arrive during a run +293 (new), What the UI shows +133, The recovery barrier +118, Replica mode +70 |
| `frontend-editor.md` | 4,313 | +220 | Rules an edit must not break +76 |
| `sync-and-offline.md` | 4,081 | +224 | Key pieces +102 |
| `checks.md` | 2,559 | +339 | Property gate +170, Every check +117 |
| `styling.md` | 1,393 | +201 | Layout invariants +116, intro +74 |
| `SECURITY.md` | 3,023 | 0 | |

`troubleshooting.md`: 277 data rows; 62 Cause cells say "now"; 25 rows cite more than one bean; 40 beans are cited by more than one row.

The write-path sections to move total about 5,750 words.

## Files

| File | Tasks |
|---|---|
| `.claude/skills/architecture-docs/check-docs.mjs` | 1 |
| `AGENTS.md`, `deploy/README.md`, `docs/superpowers/README.md` (new) | 2 |
| `docs/architecture/write-path.md` (new) | 3, 4, then 5 (trim) |
| `docs/architecture/backend.md` | 3, then 5 |
| `docs/SECURITY.md` | 3 (links), 4 (links), 5 |
| `docs/troubleshooting.md` | 3 and 4 (Where cells only), then 9 |
| `docs/architecture/overview.md`, `checks.md`, `sync-and-offline.md`, `sync-recovery.md`, `import-export-and-backup.md`, `assistant.md`, `cli-and-mcp.md`, `files-and-assets.md`, `frontend-editor.md`, `frontend-rendering.md` | 3 (link lines only), then their trim task |
| `server/tests/props/model.py`, `test_model.py`, `limit_texts.py` (comments) | 3, 4 |
| `sync-and-offline.md`, `sync-recovery.md` | 6 |
| `frontend.md`, `frontend-editor.md`, `frontend-rendering.md`, `styling.md` | 7 |
| `assistant.md`, `checks.md` | 8 |
| The 37 files citing the offline spec, `openapi.json`, `types.d.ts` | 10 |
| `.claude/skills/architecture-docs/SKILL.md`, `.claude/skills/recheck-docs/{SKILL.md,briefs.md,last-recheck}`, `.claude/skills/check-arch-docs/SKILL.md` | 11, then 12 writes `last-recheck` |

## Tasks

Sizes: **S** an hour or less, **M** a few hours, **L** most of a session. Models as briefed: opus for judgement over prose (the split, the bounds section, the dedupe, the trims, the troubleshooting merge, the re-check); sonnet for mechanical work (tooling, AGENTS.md moves, comment repointing, skills).

### Common to every trim (Tasks 5 to 9)

A trim is separate from a move: it changes no heading (Global Constraints) and moves no section between files.

What goes, in this order:

1. Prose a table or diagram beside it already states.
2. Case walks a test pins: a paragraph enumerating orderings, windows or inputs. Keep the invariant and its sharpest reason; name the test.
3. History narration: "used to", "before the fix", "now", a bean's story.
4. Lists and constants the code holds: inventories, a registry's members, a constant's value, a count. Name the symbol.
5. Rationale stated twice: keep it in the section that owns the mechanism, link from the other.

What stays: a rule nothing enforces, with its reason; which of two paths is authoritative; orientation a newcomer needs; every `CONSTANT`, function, file, error string and wire field an agent greps for. A module map is for orientation, not completeness: a row whose role cell only restates its filename may go.

Required in the task's reply, for the lead's review package:

- `wc -w` before and after for each file.
- The dropped-identifier list from `check-docs.mjs` (against the branch base, Task 1), every line marked **moved** (to which file and section), **renamed** (to what) or **removed** (why it was safe).
- Every deleted sentence that stated a rule, each with the test, lint or type that enforces it (`test_x.py::test_name`, a commentlint rule, a type), or "kept".
- Headings it wanted to rename or remove, for Task 12.
- Wrong claims found on the way: fixed (with the code that shows it) and listed as **corrected** in the commit.

Done for every trim: `check-docs.mjs` over the task's files exits 0, the commentlint sweep is clean, and the report is complete.

### Task 1: `check-docs.mjs` measures from a reference a commit cannot reset (sonnet, M)

**Files:** `.claude/skills/architecture-docs/check-docs.mjs` only (the skill text is Task 11's).

- [ ] **Base.** Add `--base <ref>`. Default: `git merge-base HEAD main`, falling back to `HEAD` when there is no `main`. Dropped identifiers, `NEW` long sentences and cells, and size are all taken against the base, and the output names it (`since <short sha>`), never "since HEAD". On `main` the base is `HEAD`, which is today's behaviour.
- [ ] **Re-check reference.** When `.claude/skills/recheck-docs/last-recheck` exists, its first line is a commit SHA; print each file's size against that commit too (`n words (+d since merge-base, +e since re-check <sha>)`). Absent: print `no re-check recorded` once. A file the reference lacks prints `(new)`.
- [ ] **Moved identifiers.** An identifier dropped from one target that appears in another target's current text prints as `moved to <file>`; the rest print as dropped. This is how the split shows nothing was lost: `check-docs.mjs docs/architecture/backend.md docs/architecture/write-path.md`.
- [ ] **Same-file links.** Resolve `](#anchor)` against the file's own headings; a miss is a `FAIL`.
- [ ] **Inbound over the tree.** `checkInbound` reads every tracked text file (`git ls-files`, skipping binaries), not only markdown, so `docs/architecture/backend.md#auth` in `auth_gate.py` is checked. Match a citation to the target by the path it resolves to from the citing file, or by basename when it carries no directory; never let `README.md` match `deploy/README.md` by basename alone. Hits under `docs/superpowers/` and `.beans/` print as `note` (frozen records keep their text), not `FAIL`. Drop the `CLAUDE.md` pathspec.
- [ ] **Existing misses.** Run the widened scan over the tree before changing behaviour. Today it finds one miss: `server/tests/test_commentlint_core.py` holds a `sync-and-offline.md` citation with the anchor `feed`, which no heading has, as lint test data. Exclude that file by path in one named constant whose comment says it is lint test input; fix any other miss in the doc that holds it.
- [ ] Rewrite the header comment to list what the script checks without a count.
- [ ] **Red, then green**, in a scratch copy of a doc (not committed): a broken same-file link fails; a broken inbound anchor in a `.py` comment fails; one in a file under `docs/superpowers/` prints a note; an identifier moved between two targets prints `moved to`.
- [ ] `node .claude/skills/architecture-docs/check-docs.mjs docs/*.md docs/architecture/*.md deploy/README.md AGENTS.md` exits 0 on the branch.

**Done:** the five behaviours shown red and green; the whole set passes; the diff touches only `check-docs.mjs`.

### Task 2: AGENTS.md keeps what every session needs; deploy and specs get their own pages (sonnet, S)

**Files:** `AGENTS.md`, `deploy/README.md`, `docs/superpowers/README.md` (new).

- [ ] **Deploy.** Move § Production and ports' "Verify a deploy rather than trusting…" bullet into `deploy/README.md` § Updating, after the step table, as a short "Verify" paragraph: `launchctl kickstart` does nothing when the service is unloaded, so check `launchctl list` and the port's owner, then grep the served bundle under `/app-assets/` for a string the change added. Add the `CI=true` fact there too (pnpm aborts asking to purge `node_modules` without a TTY). AGENTS.md keeps one bullet: deploy only with `~/.config/pkm/app/deploy/update.sh`, after merging (it deploys local `main` and refuses another checkout), and run and verify it per `deploy/README.md` § Updating, which covers headless runs. Link the section.
- [ ] **Property checks bullet.** Drop "the server is about 4½ minutes and the web side about 6½ minutes … so the gate's total grows as suites are added". Keep that each suite's time limit is a constant in its `*.prop.ts`.
- [ ] **FCIS comment rule.** Replace the example "write `offline-editing-design.md §3` or a `docs/` path, or drop it" with: point to the `docs/architecture/` section that states the rule, by path and section name, or drop the pointer; a spec or plan is cited for rationale only, because specs and plans are frozen at approval. Keep the lint's own wording (`spec section 3`, `plan-4`) as the examples of what is refused.
- [ ] `deploy/README.md`: "re-renders and reloads all three jobs" loses the count.
- [ ] `docs/superpowers/README.md`, three lines: specs and plans here are frozen at approval and record the rationale and rejected alternatives at that time; `docs/architecture/` describes the system as it is; a code comment cites the architecture doc for a current rule. (`handoffs/` is gitignored; say so in the same three lines only if it fits.)
- [ ] AGENTS.md's other content is unchanged: commands, when to run each gate, the policy decisions, the traps, the ports table.

**Done:** `check-docs.mjs AGENTS.md deploy/README.md docs/superpowers/README.md` exits 0; `wc -w AGENTS.md` before and after in the reply; no other file touched.

### Task 3: Split the write path into `write-path.md`, citers in the same commit (opus, L)

**Files:** `docs/architecture/backend.md`, `docs/architecture/write-path.md` (new), every file in the "57 cite a moving anchor" row above, `docs/architecture/overview.md`, `docs/architecture/checks.md`, `server/tests/props/model.py`, `test_model.py`, `limit_texts.py` (comments only).

A verbatim move. No claim changes in this task; Task 4 restructures.

| Source in `backend.md` | Destination in `write-path.md` |
|---|---|
| `## The write path`: intro, op table, mermaid | `# The write path` (the H1) and the paragraphs under it, plus a new short orientation paragraph: siblings, and the one-line pointer to `troubleshooting.md` |
| `### The write lock` | `## The write lock` |
| `### Planning` (all nine bullets) | `## Planning` |
| `### Conflicts` | `## Conflicts` |
| `### Missing targets` | `## Missing targets` |
| `### Stale batches` | `## Stale batches` |
| `### Concurrent structure edits` | `## Concurrent structure edits` |
| `### Page mutations and the sidebar` | `## Page mutations and the sidebar` |
| `### Post-commit nudges` (mermaid included) | `## Post-commit nudges` |

Headings move up one level and keep their text, so their slugs do not change. `backend.md` keeps no stub; its intro's siblings sentence names `write-path.md`. Everything else stays, in today's order (Ref grammar is then followed by Title integrity).

- [ ] Move the sections. Keep the paragraphs byte-identical apart from links.
- [ ] Links inside the moved text to anchors that stay (`#auth`, `#refused-titles`, `#hostile-input`, `#ref-grammar`, `#database`, `#breadcrumbs-and-recursive-traversal`, `#title-integrity-and-one-time-activation`, `#http-api-reference`, `#schema-migrations-and-legacy-data` and any other) become `backend.md#…`. Links left in `backend.md` to moved anchors become `write-path.md#…`. Relative links to siblings (`sync-and-offline.md`, `../superpowers/specs/…`) still resolve from the same directory; check each.
- [ ] Inbound citations from other docs: rewrite target and link text together (a link reading "backend.md § Stale batches" reads "write-path.md § Stale batches" and targets the new file). A citation of the whole write path points at `write-path.md` with no anchor.
- [ ] Section-name citations in code comments: in the three `server/tests/props` files, every `backend.md § <moved section>` becomes `write-path.md § <section>`; the old name "§ Page mutations" becomes "§ Page mutations and the sidebar". `backend.md § Database` stays. Rewrap to 80 columns. `checks.md`'s prose "encodes backend.md and sync-and-offline.md" names `write-path.md` as well.
- [ ] `overview.md`: add a `write-path.md` row ("change an op, planning, conflicts, the write lock or a page mutation") and narrow `backend.md`'s ("change a route, the schema, the ref grammar, titles, auth or config"). In a separate commit in this task, the intro's sentence about the specs says they are frozen at approval.
- [ ] Merge `main` into `docs/structure` first if W11 has landed, so its text is in the grep.
- [ ] Before committing, run `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/backend.md docs/architecture/write-path.md` and read the dropped list: every identifier must print as `moved to write-path.md` or still be in `backend.md`.

**Done:** one commit holds the move and every repoint; `check-docs.mjs` over `docs/*.md docs/architecture/*.md` exits 0 at that commit; `git grep -nE 'backend\.md#(the-write-path|the-write-lock|planning|conflicts|missing-targets|stale-batches|concurrent-structure-edits|page-mutations-and-the-sidebar|post-commit-nudges)' -- . ':!docs/superpowers' ':!.beans'` is empty; `git grep -nE 'backend\.md *§ *(The write|Planning|Conflicts|Missing targets|Stale batches|Concurrent|Page mutations|Post-commit)'` is empty outside frozen records; the commentlint sweep is clean.

### Task 4: "Work bounds under the write lock" (opus, M to L)

**Files:** `docs/architecture/write-path.md`, `docs/SECURITY.md` (link targets only), `docs/troubleshooting.md` (Where cells only), the three `server/tests/props` files (comments only).

Today the bound rules are stated piecemeal: the write lock's last paragraph; Planning's Text limits, Replayed text and Replay budget bullets; Missing targets' depth-cap paragraphs, the server-made landings table and "Nor is server-made text ever past a text limit"; the Stale batches row "stored two characters past it"; Page mutations' level rule, page-delete work paragraphs, copy-bounds table and rewrite-refusal table. This task gathers them into one section, placed after Planning, with one table and the rules stated once.

Write each row from the code, not from the paragraphs being replaced. Where the bound is defined and where it is judged:

| Bound | Constant (defined in) | Judged in | Exceeding it |
|---|---|---|---|
| request body | `PRIVATE_BODY_MAX_BYTES` (`auth_gate_core.py`) | `auth_gate_core.private_body_cap`, applied by `AuthGateMiddleware` | 413 before FastAPI parses the body; rule in `backend.md` § Auth |
| ops in a batch | `MAX_OPS_PER_BATCH` (`contracts/ops.py`) | `OpBatch.ops` (`Field(max_length=…)`) | 422 |
| a client's block text | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` (`contracts/ops.py`) | `ops_core.judge_batch` → `find_op_text_limit_violation` → `text_limits.text_limit_violation`, in the threadpool before `BEGIN IMMEDIATE` | the whole batch is a 400, unless `applied_batches` already holds it, which replays its ack |
| a page title | `MAX_PAGE_TITLE_CHARS` (`contracts/titles.py`) | `refs.title_length_over`, via `ops_core.find_op_title_violation` | a 400; a server-made header naming the page uses `LONG_TITLE_LABEL` instead (`conflict_notes._fitted`) |
| where a client's block lands | `MAX_OUTLINE_DEPTH` (`contracts/ops.py`) | `ops_core._check_depth`, from `plan_op` | a 400 |
| where a server-made landing goes | `MAX_OUTLINE_DEPTH` | `ops_apply._conflict_landing`, `ops_core.descendant_copy_effects` | never refused; placed no deeper than the cap |
| a server rewrite of stored text | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` | `text_limits.rewrite_text_limit_violation`, from `store.rewrite_snapshotted_blocks`, `unlink.plan_page_delete`, `routes_assets._strip_references` | refused only when worse than the stored row: 422, 409 or blocker `limit` per the rewrite table |
| one replay step | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING`, `MAX_UNLINK_WORK` (`text_limits.py`) | `replay_core._replay_step` (`spans.spliced_length`, `text_limits.unlink_refused`), then `replay_core.classify_text_edit` | the edit lands `over_limit` as a conflict entry; the ack skips it as `text_limit` |
| a batch's replays | `MAX_BATCH_REPLAY_WORK`, `ROW_CHARS` (`replay_core.py`) | `ops_apply.BatchReplay._spend`, through `walk` and `charge` | that edit and every later replayed edit land `over_limit` |
| a page delete's copies | `MAX_DELETE_COPY_CHARS` (`unlink.py`), `MAX_UNLINK_WORK` | `unlink.plan_page_delete`, `unlink._Copies.get` | the delete is refused, blocker `limit` |
| uncharged work | none | a large subtree's move or delete; `store.stale_titles` | bounded only by the request; `SECURITY.md` § Known limitations states the consequence |

The implementer opens each function before writing its row and corrects the row where the code differs.

- [ ] The table, then the rules, each once: server-made text passes a limit only by the stated backticks (the two a defused attribute adds, and the two a fence adds per link a legacy title ending in `[` leaves; pinned by `test_a_stale_defuse_at_the_cap_stores_at_most_two_more`); never a 400 over text the client did not send; a stored row over a limit may stay level, never get worse; which costs are uncharged, and why the client's body bounds what is left. Keep the bolded "Depth rejects the batch rather than skipping the op" reason and its design link.
- [ ] Delete the piecemeal statements the section replaces. Each source section keeps one sentence and a link where a reader of that mechanism needs it (Planning's text-limit judging order and the "convention, not a check" note on `JudgedBatch` are mechanism, not bounds: they stay).
- [ ] Case walks move to their tests: the `[[` × 32m construction, `octet_length` reading the record header, the `_step_key` dedupe, `_Copies.projected` summing once. For each, name the test that pins it. A walk no test pins keeps its one-sentence invariant and goes on the report (open question 3).
- [ ] Copied values: "an `OpBatch` of 1–500 ops" names `MAX_OPS_PER_BATCH`; "32 runs" and "32 deep" name `MAX_LINK_NESTING`.
- [ ] Repoint in the same commit: `SECURITY.md` § Bounds on a session's rows that link Planning for a bound; troubleshooting Where cells whose rule now lives in the bounds section (a Where that still resolves but lands on a section no longer stating the rule is the failure to look for); the `props` comments citing "§ Planning (text limits)".

**Done:** the section's rows each name a constant and a function that exist (`git grep` each); `check-docs.mjs` over `write-path.md`, `SECURITY.md`, `troubleshooting.md` exits 0 with every dropped identifier accounted; the report lists each deleted statement's new home; one commit.

### Task 5: `backend.md` and `SECURITY.md` state each mechanism once; trim `backend.md` and `write-path.md` (opus, L)

**Files:** `docs/architecture/backend.md`, `docs/architecture/write-path.md`, `docs/SECURITY.md`.

- [ ] **Dedupe by kind** (open question 2). For each pair, the mechanism and its reason stay in `backend.md` (or `write-path.md`); the threat, consequence or limitation stays in `SECURITY.md`, which links the mechanism:

  | Pair | `backend.md` keeps | `SECURITY.md` keeps |
  |---|---|---|
  | the gate and the public routes | the `is_public` table, what the gate reads and refuses | that every route but login needs a session, and the link |
  | the origin guard | the allowed-origin table, the refusals, the `Origin: null` rule | that CSRF protection is `SameSite=Lax` plus the guard, the safe-method side effects a sibling page can trigger, and the link |
  | `Referrer-Policy: no-referrer` | the "Nothing enforces" bullet | the hardening-priority note, linking it |
  | throttle keying | the listener table and the conditions | the Known limitations row's consequences (per-device bucket, a local process can choose its key, no lockout, a weak password is open to patient guessing), without `FORWARDED_ALLOW_IPS` and header detail |
  | lock held on the event loop; uncharged costs | `write-path.md` (Task 4) | the two Known limitations rows' consequences, linking § Work bounds under the write lock |

  `SECURITY.md` keeps its threat model, deployment assumptions, consequences, limitations and hardening order, and each mechanism it mentions links its owner. Keep both "Nothing enforces these rules" lists in `backend.md` whole.
- [ ] **Trim `backend.md`** per the common method. Hits named: "refused at 1,002" (name `MAX_PAGE_TITLE_CHARS`), "about 1 KiB/s at 300 s" (name `WRITE_STALL_TIMEOUT_S`), "routes three loggers to two handlers", Testing's seed pages and date (name `SEED_PAGES`), "Two tests pin"; the HTTP API reference's cells that restate a route docstring (the table's intro says docstrings carry the detail); Module map rows whose role restates the filename. The generated-artifacts table stays in `backend.md` with every `UPDATE_*_FIXTURE` name: `test_regen.py::test_every_update_fixture_in_backend_md_is_a_step` reads them from this file.
- [ ] **Trim `write-path.md`** per the common method, after Task 4's section: Conflicts' stale-title probing narration, Page mutations' "a search from the text's start per link made the unlink quadratic" (history; the troubleshooting row holds it).

**Done:** the common trim report for all three files, plus a table of every SECURITY/backend pair resolved; `check-docs.mjs` over the three files exits 0; one commit per file or per concern.

### Task 6: Trim the sync docs (opus, M)

**Files:** `docs/architecture/sync-and-offline.md`, `docs/architecture/sync-recovery.md`.

- [ ] Per the common method. Look first at what grew: `sync-recovery.md` § Calls that arrive during a run (new), § What the UI shows, § The recovery barrier, § Replica mode; `sync-and-offline.md` § Key pieces. Late-caller case lists belong to the tests that pin them (`reconnectFlow.test.ts`, `clientRuntime.test.ts`, `legacyRepair.test.ts`, `barrier.test.ts`); the rule and its reason stay.
- [ ] **W11.** Leave `sync-recovery.md` § runRecovery byte-identical: W11 adds a paragraph and a diagram there. If W11 has merged to `main` before this task starts, merge `main` into `docs/structure` first and trim the section with W11's text in it. Otherwise W11's edit lands on an untouched section and Task 12 reviews it after the lead merges `main` again. If W18 merges first, W11's branch links any write-path anchor to `write-path.md`, and its own `check-docs.mjs` run catches a miss.
- [ ] The heading "Availability: two values, one owner" carries a count; it goes on the report for Task 12 (wave 2 renames nothing).

**Done:** the common trim report; § runRecovery unchanged unless W11 was merged first.

### Task 7: Trim the frontend docs (opus, M)

**Files:** `docs/architecture/frontend.md`, `frontend-editor.md`, `frontend-rendering.md`, `styling.md`.

- [ ] Per the common method. What grew: `frontend.md` § Fetch state (new), § The chat machine, § Popovers and menus, § Module map, § Linked references (new); `styling.md` § Layout invariants and its intro; `frontend-editor.md` § Rules an edit must not break.
- [ ] `frontend.md` § The chat machine and `assistant.md` § The turn phase both grew in W3 and W14: the turn's phases are owned by the server doc's phase table where the server owns the phase, and by `frontend.md` where only the web machine holds it. Cut the second copy, link the first; coordinate with Task 8 by reading its branch, not by editing `assistant.md`.
- [ ] `frontend-rendering.md`: "`MAX_DEPTH` of 3, and `QueryBlock` stops at 2" names the constants without the values.

**Done:** the common trim report.

### Task 8: Trim `assistant.md` and `checks.md` (opus, M)

**Files:** `docs/architecture/assistant.md`, `docs/architecture/checks.md`.

- [ ] Per the common method. What grew: `assistant.md` § The turn phase, § The stream contract (new), § The blocks a write changes; `checks.md` § Property gate and § Every check. The property gate's per-suite reach and teeth notes belong to the suites' own `event()` and tally labels where those carry them; the gate's rules stay.
- [ ] The card's bounds already have a table in `assistant.md` § Bounds; prose that restates it goes.

**Done:** the common trim report.

### Task 9: Troubleshooting rows keyed by symptom (opus, L)

**Files:** `docs/troubleshooting.md`.

- [ ] **Merge** rows that share a symptom and a current guard into one row: the Symptom says what someone sees, the Cause names the current guard by identifier, the Ref lists every bean and test the merged rows cited. Example in § Writes, conflicts and races: "One `/api/ops` batch of small stale edits holds every write for minutes" and "… though the replay budget is in place" become one row.
- [ ] **Cause cells** lose fix narration ("now refuses", "used to", "before"); the guard is stated in the present tense.
- [ ] **§ Backend** re-keyed into symptom families: "Writes stall or 503"; "A deleted or renamed page comes back"; "A route answers 500" (today's "500s from hostile input", plus 500 rows from the other Backend subsections); "Titles and the ref grammar" and "Reads, startup and logging" keep their rows that fit no family. Only § Performance checks is cited from outside; keep its heading.
- [ ] Review-only rows (an attack input a review reproduced, never observed) stay, merged like the rest (open question 1). The file's intro already admits them; keep that sentence.
- [ ] Every Where cell still lands on the section that states the rule (after Tasks 3 and 4).
- [ ] **Accounting**, in the reply: rows before and after per area; `wc -w`; the bean ids in the Ref column as a set, before and after, which must be equal (`grep -o 'pkm-[a-z0-9]\{4\}'` over the Ref cells); every double-quoted banner or error string in an old Symptom cell, found in the new file; check-docs' dropped identifiers, accounted.

**Done:** the accounting shows nothing lost; `check-docs.mjs docs/troubleshooting.md` exits 0.

### Task 10: Code comments cite the architecture docs, not the July spec (sonnet, M)

**Files:** the 37 files with the 55 hand-written citations (`git grep -n 'offline-editing-design' -- server web shared` minus `test_commentlint_core.py`, `openapi.json`, `types.d.ts`), then `web/src/api/openapi.json` and `web/src/api/types.d.ts` by regeneration.

For each citation, in order: if the comment already states the rule it points for, drop the pointer; otherwise point to the architecture section that states it today, by path and section name (`docs/architecture/write-path.md § Conflicts`). Open the target and confirm it states the rule; if no section does, drop the pointer and list the comment in the reply. Default targets, to be confirmed per comment:

| Spec section | Default target |
|---|---|
| §1 journal, sync endpoints, idempotent pushes | `write-path.md` § Planning (idempotency), § Conflicts (subtree hash), § Post-commit nudges (the nudge invariant), the op table (`create_page`); `sync-and-offline.md` § The changes feed (windows) |
| §2 conflict handling | `write-path.md` § Conflicts |
| §3 client replica | `sync-and-offline.md` § The replica, § The changes feed, § Applying a window over pending edits; negative-id pages in `frontend.md`'s reads-and-writes section |
| §4 offline reads, the shim | `sync-and-offline.md` § Offline editing and reconnect, and its shim row in § Key pieces |
| §5 app shell and assets | `frontend.md` § Build notes (`vite.config.ts`); `files-and-assets.md` for the asset cache |
| §6 error handling | `sync-recovery.md` § A batch the server rejects, § Recovery never erases intent |
| §7 testing, shim parity | `backend.md` § Generated artifacts and parity fixtures |

- [ ] The two that contradict their spec: `DeleteOp`'s comment in `contracts/ops.py` and `conflict_notes.conflict_label`'s docstring point to `write-path.md` § Conflicts. Check every sentence of both against `ops_core.descendant_copy_effects`, `ops_apply._conflict_landing` and `conflict_label`, and correct what differs.
- [ ] `CreatePageOp`'s docstring in `contracts/ops.py` feeds the OpenAPI description. After editing it, from `server/`, run `uv run python -m pkm.regen` (needs `web/node_modules`) and commit what it rewrites. Expected diff: `openapi.json`'s `CreatePageOp` `description` and the matching comment in `types.d.ts`; any other change is a stop-and-report.
- [ ] No other docstring edited here is a route's or a model's: confirm with `git grep -c 'offline-editing-design' -- web/src/api` reading zero after the regen.
- [ ] Rewrap to 80 columns. Never touch `server/tooling/`.
- [ ] Run the token check (Final checks) over the task's diff before committing.

**Done:** `git grep -n 'offline-editing-design' -- server web shared` lists only `test_commentlint_core.py`; the token check reports no code change; the commentlint sweep is clean. The gates run once, in Task 13.

### Task 11: Skills: module maps, the re-check reference, the new doc (sonnet, M)

Invoke `superpowers:writing-skills` first. **Files:** `.claude/skills/architecture-docs/SKILL.md`, `.claude/skills/recheck-docs/SKILL.md`, `.claude/skills/recheck-docs/briefs.md`, `.claude/skills/check-arch-docs/SKILL.md`.

- [ ] `architecture-docs`: resolve the module-map contradiction. Its first table sends "a module inventory" to the code; its shape table prescribes "the aligned tree in `backend.md` § Module map, … one sub-line per file". One sentence wins: a module map is an aligned tree for orientation, naming the directories and the files a newcomer needs, never a complete inventory.
- [ ] `architecture-docs`: "Server broadcast behaviour stays in `backend.md`" becomes `write-path.md` (§ Post-commit nudges moved); "`props/model.py` cites `backend.md` sections" becomes `write-path.md`; the Verify section describes Task 1's output (base, re-check reference, `moved to`, same-file links, frozen records as notes) in place of "since `HEAD`".
- [ ] `recheck-docs` step 1: the last re-check is the SHA in `.claude/skills/recheck-docs/last-recheck`, confirmed by `git log -1 --format=%H --grep='^Docs-Recheck:'`; drop the `--grep='re-check'` search and its false positives. Step 7: the run's final commit writes `last-recheck` (one line: the SHA of the commit whose docs tree the re-check left, the last fix commit) and carries a `Docs-Recheck: <that sha>` trailer, in the same trailer block as `Co-Authored-By`. The reviewer table's backend row covers `backend.md` and `write-path.md`. `briefs.md`'s fixer brief stops requiring "re-check" in the first line.
- [ ] `check-arch-docs` step 2: find the last re-check the same way, dropping the `7d842de` fallback and the grep.
- [ ] Prove the hook: write a message ending in `Docs-Recheck: 0123abcd` and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` to a scratch file and run `.githooks/commit-msg <file>`: exit 0. `git interpret-trailers --parse <file>` lists both trailers.

**Done:** writing-skills' checks run; the hook proof in the reply; no file outside the four.

### Task 12: Run `recheck-docs` over the whole set (opus, L)

After every wave-2 lane has merged into `docs/structure`, and after `main` is merged in again if W11 has landed. Follows the skill as Task 11 left it, with two deviations: the run happens on `docs/structure`, not a `docs/recheck-<date>` branch; and fixers run on opus, not sonnet.

- [ ] Steps 1 and 2 (set up, mechanical sweep). The first run has no `last-recheck`: the start SHA stands in.
- [ ] Step 3: the reviewers as the skill lists them, with the headings the wave-2 reports asked to rename or remove, and the case-walk gaps from Task 4, handed to the reviewer of the owning doc.
- [ ] Step 4: **the lead reports to Arthur and stops.** No fix starts before his answer.
- [ ] Steps 5 and 6: fixes per his rulings; the adversarial final review on the strongest model whenever a doc was rewritten; memory edits by the lead after the repo side lands.
- [ ] Step 7: the final commit writes `last-recheck` and carries the `Docs-Recheck:` trailer (Task 11).

**Done:** Arthur's rulings applied; the final review's findings applied or answered; `last-recheck` committed; the skill's end report delivered.

### Task 13: Final checks and gates (lead or sonnet, S)

See Final checks.

## Order and parallel lanes

```
Wave 1   T1 tooling  ||  T2 AGENTS.md, deploy, specs README
Wave 1b  T3 split                      (after T1: needs same-file link checking)
Wave 1c  T4 work bounds                (after T3: moves rules between sections)
Wave 2   T5 backend/write-path/SECURITY  ||  T6 sync  ||  T7 frontend  ||  T8 assistant/checks
         ||  T9 troubleshooting  ||  T10 code comments  ||  T11 skills
Wave 3   T12 recheck-docs  ->  T13 final checks
```

- **Serial where an anchor moves.** T3 and T4 move anchors or move the rule an anchor's reader came for, and each carries its citers in its own commit. Everything that cites them (every doc, the troubleshooting Where cells, the props comments, Task 10's new comment targets) starts after T4 merges.
- **Wave 2 lanes own disjoint files** (the Files table), branch from `docs/structure` after T4, and merge back in any order. None renames or removes a heading, so no lane can break another's links. T7 and T8 both touch the turn-phase material: T7 reads T8's branch and edits only its own files.
- **T10's targets** are headings that exist after T4 and that wave 2 will not rename.
- **T12 runs last** over the merged set; it is the only task that renames or removes headings, fixing citers in the same commit per the skill.
- **W11** may land on `main` at any point. Before T3 and before T12, merge `main` into `docs/structure`. T6 leaves § runRecovery alone unless W11 is already in.

## Final checks

Run in `.worktrees/w18-docs` on `docs/structure` after T12.

- [ ] `node .claude/skills/architecture-docs/check-docs.mjs docs/*.md docs/architecture/*.md deploy/README.md AGENTS.md docs/superpowers/README.md` exits 0. Its size lines against the merge-base give the before/after table for the review package.
- [ ] `PYTHONPATH=server/tooling python3 -m commentlint.run --all` is clean.
- [ ] `git grep -nE 'backend\.md#(the-write-path|the-write-lock|planning|conflicts|missing-targets|stale-batches|concurrent-structure-edits|page-mutations-and-the-sidebar|post-commit-nudges)' -- . ':!docs/superpowers' ':!.beans'` is empty, and so is `git grep -nE 'backend\.md *§ *(The write|Planning|Conflicts|Missing targets|Stale batches|Concurrent|Page mutations|Post-commit)' -- . ':!docs/superpowers' ':!.beans'`.
- [ ] `git grep -n 'offline-editing-design' -- server web shared` lists only `server/tests/test_commentlint_core.py`.
- [ ] `grep -rn` for the banned phrase over `docs/`, `AGENTS.md`, `.claude/skills/` finds only the rules that ban it.
- [ ] **Token check.** For every file under `server/`, `web/`, `shared/` in `git diff --name-only <merge-base>...HEAD`:
  - Python: `ast.dump` of the old and new source, after blanking the docstring of every module, class and function, are equal. A changed docstring is listed by name; only `CreatePageOp`'s may reach OpenAPI.
  - TypeScript and TSX: the token streams from `typescript`'s scanner (`ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, …)`, from `web/node_modules`), kind and text per token, are equal.
  - `openapi.json`: `jq` shows the only changed path is `CreatePageOp`'s `description`.
  - Any other file type in the list is a stop-and-report.
  The script lives in the scratchpad, not the repo.
- [ ] `git diff --exit-code <merge-base> -- server/tooling/perfcheck/fixture.py` passes, and `fixture_hash()` still prints `cbc83f86b4d84f1a`, the value in both `perf/baseline-*.json`.
- [ ] **Gates, once**, because Tasks 3, 4 and 10 touched comments and Task 10 regenerated two artifacts: from `server/`, `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`; from `web/`, `pnpm verify` (with its own `E2E_PORT` if another session runs a suite). The server suite includes `test_openapi_sync.py`, `test_regen.py` and the commentlint tree sweep.
- [ ] **No perf or property gate.** The token check shows no code token changed, so no request path, query, render path or machine changed. `perfcheck`'s fixture cache key includes a digest of the product's source, so the next perf run rebuilds its cached fixture once; that is a cache miss, not a stale baseline (`fixture_hash` covers `fixture.py` alone).
- [ ] The commit-msg hook accepts the `Docs-Recheck:` commit (T11's proof, and T12's real commit went through it).

## Traps

- `check-docs.mjs` before Task 1 cannot see same-file links: do not start Task 3 on a branch without Task 1.
- Running `check-docs.mjs` after committing used to show `+0`. After Task 1 it compares against the merge-base; a lane worktree branched from `docs/structure` still has `main` as its merge-base, so its numbers include earlier waves. Pass `--base <lane start sha>` for a lane's own report.
- A heading demoted from `###` to `##` keeps its slug; a heading whose text changes does not.
- `README.md` basenames collide (`README.md`, `deploy/README.md`, `web/tooling/perf/README.md`); never match an anchor by basename alone when the citation has a path.
- `test_regen.py` reads `backend.md` for `UPDATE_*_FIXTURE` names; the generated-artifacts table cannot leave it.
- `pnpm typecheck` plus `pnpm test:unit` is not web verification; Task 13 runs `pnpm verify`.
- The props comments are under `server/tests/props/`; the pre-commit hook lints them at 80 columns like any comment.
- Parallel sessions share the main checkout: run nothing there.

## Questions for Arthur

1. **Review-only troubleshooting rows** (an attack input a review reproduced, never observed): keep or drop? *Default: they stay, merged with the rows that share their symptom and guard.*
2. **`backend.md` versus `SECURITY.md`:** the epic says `backend.md` loses every sentence `SECURITY.md` carries; the docs' own rule keeps a mechanism in the doc that owns it. *Default: split by kind. Mechanisms and their reasons stay in `backend.md` and `write-path.md`; threats, consequences and limitations stay in `SECURITY.md`, which links each mechanism.*
3. **Case walks no test pins:** W18 is docs-only. *Default: no new tests; the walk shrinks to its invariant sentence and the gap goes to the re-check report, where you can ask for a bean.*
4. **Frozen records citing a moved anchor** (`docs/superpowers/`, `.beans/`): *Default: `check-docs.mjs` reports them as notes, never failures, and nobody edits them.*
5. **`last-recheck` file and `Docs-Recheck:` trailer:** both, as the epic says, or the trailer alone (`git log --grep` finds it, and a file is one more thing to keep true)? *Default: both; the file is what `check-docs.mjs` reads, the trailer is what `recheck-docs` step 1 confirms.*
6. **Model for the trims:** *Default: opus for every trim, since losing a rule is the risk; sonnet only for the mechanical tasks named above.*
