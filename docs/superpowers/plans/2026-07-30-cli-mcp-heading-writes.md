# CLI/MCP heading writes (pkm-8m94) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `## Heading` text written through the `pkm` CLI or MCP tools store a real heading level instead of literal markdown characters.

**Architecture:** One pure helper, `split_heading`, strips 1–3 leading hashes off a single line and returns the level. It is wired in at exactly two places in `server/src/pkm/cli/build.py`: the item loop of `_Planner.creates` (which every create path funnels through — `save`, batch `create`/`todo`/`outline`, `upload`) and a new `plan_update` planner used by the three update paths. No server-side changes: `CreateOp.heading` and `SetHeadingOp` already exist and validate levels 1–3.

**Tech Stack:** Python 3.13, `uv`, pytest, pyrefly, ruff. All logic lives in Functional Core files (`cli/build.py`); the shells (`cli/main.py`, `mcp/server.py`) only fetch, call the planner, and post.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-cli-mcp-heading-writes-design.md`. Bean: `pkm-8m94`.
- Work on branch `worktree-cli-headings`, in the worktree at `.claude/worktrees/cli-headings`. Run every command from `<worktree>/server` unless a step says otherwise. Do NOT `cd` to the main checkout.
- Heading levels are 1–3 only. `#### x` (four hashes) must stay literal text.
- `#Tag` and `#[[Page]]` (a hash with no following space) must stay literal text — prod has 35 such tag-blocks and breaking them would corrupt real notes.
- Multi-line text must stay verbatim in a single block. `_HEADING_SPEC` is neither `MULTILINE` nor `DOTALL`, which already guarantees this; no test may weaken it.
- FCIS: `cli/build.py` is `# pattern: Functional Core` — no I/O, no clock, no randomness. `cli/main.py` and `mcp/server.py` are Imperative Shell.
- Verification gate, all three from `<worktree>/server`: `uv run pytest -q` (coverage is enforced), `uv run pyrefly check`, `uv run ruff check`.
- No server route or docstring changes, so `openapi.json` and the generated web types do NOT need regenerating.

---

### Task 1: `split_heading` and every create path

**Files:**
- Modify: `server/src/pkm/cli/build.py` (add `split_heading` after `resolve_parent`; change the item loop in `_Planner.creates`, currently lines 165–182; add to `__all__`)
- Test: `server/tests/test_cli_build.py`

**Interfaces:**
- Consumes: nothing from earlier tasks. `_HEADING_SPEC` (`build.py:12`, `re.compile(r"^(#{1,3}) (.+)$")`) already exists and is already used by `resolve_parent` for `parent:` specs — reuse it, do not add a second regex.
- Produces: `split_heading(text: str) -> tuple[str, int | None]`, used by Task 2's `plan_update`.

Background on why one call site is enough: `plan_save` and all three of `plan_batch`'s creating commands (`create`, `todo`, `outline`) build their ops by calling `_Planner.creates`, and `pkm upload` / `upload_asset` call `plan_save`. Splitting inside `creates`'s loop therefore fixes every create path at once.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/test_cli_build.py`. Extend the existing import at the top of the file to include `render_page` from the sibling module and `split_heading`:

```python
from pkm.cli.build import (BuildError, next_child_idx, parse_outline,
                           plan_batch, plan_save, referenced_pages,
                           resolve_parent, split_heading)
from pkm.cli.render import render_page
```

Then append these tests:

```python
def test_split_heading_levels():
    assert split_heading("# One") == ("One", 1)
    assert split_heading("## Two") == ("Two", 2)
    assert split_heading("### Three") == ("Three", 3)


@pytest.mark.parametrize("text", [
    "#Tag",                  # no space after the hash: a tag, not a heading
    "#[[Page]]",
    "#### Four",             # blocks carry levels 1-3 only
    "# ",                    # no body
    "plain text",
    "## Doc\n\nbody line",   # multi-line stays verbatim in one block
])
def test_split_heading_leaves_non_headings_alone(text):
    assert split_heading(text) == (text, None)


def test_plan_save_outline_sets_heading_levels():
    ops = plan_save(PAYLOAD, "Machine Learning", None,
                    "## Overview\n  detail\n### Deeper", todo=False,
                    uids=uid_gen())
    assert [(o["text"], o.get("heading")) for o in ops] == [
        ("Overview", 2), ("detail", None), ("Deeper", 3)]


def test_plan_save_todo_marker_rides_on_a_heading():
    ops = plan_save(PAYLOAD, "Machine Learning", None, "## Do it",
                    todo=True, uids=uid_gen())
    assert ops[0]["text"] == "{{TODO}} Do it"
    assert ops[0]["heading"] == 2


def test_plan_batch_create_and_outline_set_headings():
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "# Top"}},
        {"command": "outline",
         "params": {"page": "Machine Learning",
                    "items": ["## Section", ["body"]]}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": PAYLOAD}, uid_gen())
    assert [(o["text"], o.get("heading")) for o in ops] == [
        ("Top", 1), ("Section", 2), ("body", None)]


def test_plan_batch_created_heading_resolves_as_a_later_parent():
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "## Notes"}},
        {"command": "create",
         "params": {"page": "Machine Learning", "parent": "## Notes",
                    "text": "beneath"}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": PAYLOAD}, uid_gen())
    assert len(ops) == 2                  # no duplicate "Notes" heading
    assert ops[1]["parent_uid"] == ops[0]["uid"]


def test_render_then_save_round_trips_a_heading():
    line = next(ln for ln in render_page(PAYLOAD).splitlines()
                if "Papers" in ln)
    assert line == "- ## Papers"
    ops = plan_save({"blocks": []}, "P", None, line.removeprefix("- "),
                    todo=False, uids=uid_gen())
    assert (ops[0]["text"], ops[0]["heading"]) == ("Papers", 2)
```

Note on the last two: `test_render_then_save_round_trips_a_heading` is the invariant this whole bean buys — `render.py:39` prints a stored heading as `## text`, and after this task `plan_save` reads that back as a heading. `test_plan_batch_created_heading_resolves_as_a_later_parent` needs the `_headings` memo registration in Step 3; without it `resolve_parent` cannot see the in-batch block (it only walks the *fetched* page payload) and a second `Notes` heading gets created.

- [ ] **Step 2: Run the tests to verify they fail**

Run from `<worktree>/server`:

```bash
uv run pytest tests/test_cli_build.py -q -k "split_heading or heading_levels or todo_marker_rides or create_and_outline_set or created_heading_resolves or round_trips"
```

Expected: `ImportError: cannot import name 'split_heading'` — collection fails before any test runs. That is the correct first failure.

- [ ] **Step 3: Implement**

In `server/src/pkm/cli/build.py`, add after `resolve_parent` (i.e. after line 82):

```python
def split_heading(text: str) -> tuple[str, int | None]:
    """Split a leading markdown heading marker off `text`, returning
    (body, level): '## Overview' -> ('Overview', 2).

    Text that doesn't match comes back unchanged with None: '#Tag' (no
    space after the hashes, so tag-only blocks survive), '#### x' (blocks
    carry levels 1-3 only), '# ' (no body), and any multi-line text --
    _HEADING_SPEC is neither MULTILINE nor DOTALL, so `$` cannot match
    mid-string and a pasted markdown document stays verbatim in its
    block. Same syntax as a `parent:` spec, same regex.
    """
    m = _HEADING_SPEC.match(text)
    return (m.group(2), len(m.group(1))) if m else (text, None)
```

Replace the item loop in `_Planner.creates` (currently lines 165–182) with:

```python
        for depth, text in items:
            del stack[depth + 1:]
            target = stack[depth]
            body, level = split_heading(text)
            if todo and depth == 0:
                body = with_state(body, "TODO")
            uid = self.next_uid()
            if depth == 0 and first and index is not None:
                idx = index
            else:
                idx = self.bump(payload, page, target,
                                in_batch | frozenset(created))
            first = False
            ops.append(_create(uid, page, target, idx, body, level))
            if level is not None:
                # So a later `parent: "## Notes"` in the same batch nests
                # under this block instead of creating a second heading.
                # `resolve_parent` can't find it: it walks only the
                # fetched page payload, which predates this batch. Keyed
                # on the stored text (TODO prefix included, if any) so
                # the memo agrees with what a later fetch would match.
                self._headings.setdefault((page, level, body), uid)
            created.add(uid)
            if len(stack) == depth + 1:
                stack.append(uid)
            else:
                stack[depth + 1] = uid
        return ops
```

Two details that matter: the split happens **before** `with_state`, so `## Do it` with `todo=True` yields text `{{TODO}} Do it` at level 2 rather than a TODO marker buried behind hashes; and `setdefault` (not assignment) leaves an earlier auto-created heading as the memo's winner.

Add `"split_heading"` to `__all__` at the bottom of the file, keeping it alphabetical-ish alongside the other planner exports:

```python
__all__ = [
    "BuildError", "parse_outline", "next_child_idx", "resolve_parent",
    "split_heading", "plan_save", "asset_block_text", "referenced_pages",
    "plan_batch",
]
```

- [ ] **Step 4: Run the new tests, then the whole file**

```bash
uv run pytest tests/test_cli_build.py -q
```

Expected: PASS, all of them. The pre-existing tests must not need editing in this task — `_create` only adds a `"heading"` key when the level is not None, so op dicts for plain text keep their exact old shape, and `test_plan_save_appends_at_end_of_page` (which asserts full dict equality) still holds.

- [ ] **Step 5: Run the full gate**

```bash
uv run pytest -q && uv run pyrefly check && uv run ruff check
```

Expected: all pass. If `test_cli_main_write.py` or `test_mcp_server.py` fail here, stop and report — nothing in this task should have changed the update paths.

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/cli/build.py server/tests/test_cli_build.py
git commit -m "fix(pkm-8m94): CLI/MCP creates store '## X' as a real heading

split_heading() strips 1-3 leading hashes into a heading level in
_Planner.creates's item loop -- the one call site every create path
funnels through (save, batch create/todo/outline, upload). Splitting
before with_state keeps a --todo heading as '{{TODO}} text' at its
level. A created heading also registers in the _headings memo so a
later 'parent: \"## X\"' in the same batch reuses it instead of
creating a duplicate.

'#Tag', '#### x', '# ', and multi-line text stay literal.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012esBP8RU2pXLhxhyKwCs7u"
```

---

### Task 2: `plan_update` and the three update paths

**Files:**
- Modify: `server/src/pkm/cli/build.py` (add `plan_update`; use it in `plan_batch`'s `update` branch, currently lines 300–303; import `text_hash`; add to `__all__`)
- Modify: `server/src/pkm/cli/main.py:363-382` (`cmd_update`)
- Modify: `server/src/pkm/mcp/server.py:107-123` (`update_block`)
- Test: `server/tests/test_cli_build.py`, `server/tests/test_cli_main_write.py`, `server/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `split_heading(text: str) -> tuple[str, int | None]` from Task 1.
- Produces: `plan_update(uid: str, text: str, base_text: str | None = None) -> list[dict]`, returning exactly two ops: an `update_text` (with a `base_text_hash` guard only when `base_text` is given) followed by a `set_heading`.

Two things to get right. First, `set_heading` is emitted **unconditionally** — it is idempotent, and `plan_batch`'s `update` command has no fetched page payload to compare a current level against, so a conditional emit would need two code paths. Second, the `-D`/`-T`/`mark=` paths must **not** go through `plan_update`: the text they read back from the API is already bare (the level lives in its own column), so splitting it would find no hashes and silently demote a real heading to plain text.

- [ ] **Step 1: Write the failing tests**

In `server/tests/test_cli_build.py`, extend the import to add `plan_update`, and add an import for the hash helper:

```python
from pkm.cli.build import (BuildError, next_child_idx, parse_outline,
                           plan_batch, plan_save, plan_update,
                           referenced_pages, resolve_parent, split_heading)
from pkm.server.ops_core import text_hash
```

Append:

```python
def test_plan_update_sets_heading_from_text():
    assert plan_update("u3", "## Overview", "old text") == [
        {"op": "update_text", "uid": "u3", "text": "Overview",
         "base_text_hash": text_hash("old text")},
        {"op": "set_heading", "uid": "u3", "heading": 2}]


def test_plan_update_clears_heading_for_plain_text():
    ops = plan_update("u3", "Overview", "old text")
    assert ops[1] == {"op": "set_heading", "uid": "u3", "heading": None}


def test_plan_update_without_base_text_has_no_hash_guard():
    ops = plan_update("u3", "edited")
    assert ops[0] == {"op": "update_text", "uid": "u3", "text": "edited"}
```

Two **existing** tests in that file assert exact op lists and index into them positionally; batch `update` now emits a second op, so they must be updated in this same step. Replace their bodies' assertions:

In `test_plan_batch_todo_update_move_delete`, the four assertions become five:

```python
    assert ops[0]["text"] == "{{TODO}} follow up"
    assert ops[1] == {"op": "update_text", "uid": "u3", "text": "edited"}
    assert ops[2] == {"op": "set_heading", "uid": "u3", "heading": None}
    assert ops[3] == {"op": "move", "uid": "u1", "parent_uid": "u2",
                      "order_idx": 1, "page_title": None}
    assert ops[4] == {"op": "delete", "uid": "u3"}
```

In `test_plan_batch_alias_as_uid`, the last assertion gains a companion:

```python
    assert ops[1]["op"] == "move" and ops[1]["uid"] == ops[0]["uid"]
    assert ops[2] == {"op": "update_text", "uid": ops[0]["uid"], "text": "y"}
    assert ops[3] == {"op": "set_heading", "uid": ops[0]["uid"],
                      "heading": None}
```

In `server/tests/test_cli_main_write.py`, append (the `run` fixture and `_page_texts` helper are already at the top of the file):

```python
def test_save_heading_text_becomes_a_real_heading(run, pkm_client):
    code, _, _ = run("save", "-p", "AI", "## Overview\n  detail")
    assert code == 0
    page = pkm_client.get_page("AI")
    overview = next(n for n in page["blocks"] if n["text"] == "Overview")
    assert overview["heading"] == 2
    assert overview["children"][0]["text"] == "detail"


def test_update_to_a_heading_sets_the_level(run, pkm_client):
    code, _, _ = run("update", "uid_b6", "## Rewritten")
    assert code == 0
    block = pkm_client.get_block("uid_b6")["block"]
    assert (block["text"], block["heading"]) == ("Rewritten", 2)


def test_update_to_plain_text_clears_the_level(run, pkm_client):
    run("update", "uid_b6", "## Rewritten")
    run("update", "uid_b6", "Rewritten again")
    block = pkm_client.get_block("uid_b6")["block"]
    assert (block["text"], block["heading"]) == ("Rewritten again", None)


def test_update_done_flag_keeps_the_heading(run, pkm_client):
    run("update", "uid_b6", "## Task x")
    run("update", "uid_b6", "-D")
    block = pkm_client.get_block("uid_b6")["block"]
    assert (block["text"], block["heading"]) == ("{{DONE}} Task x", 2)
```

In `server/tests/test_mcp_server.py`, append (the `tools` fixture is already at the top):

```python
def test_save_note_heading_levels(tools, pkm_client):
    tools.save_note("# Big", page="AI")
    page = pkm_client.get_page("AI")
    assert any(n["text"] == "Big" and n["heading"] == 1
               for n in page["blocks"])


def test_update_block_sets_heading_and_mark_preserves_it(tools, pkm_client):
    tools.save_note("temp", page="AI")
    uid = next(n["uid"] for n in pkm_client.get_page("AI")["blocks"]
               if n["text"] == "temp")
    tools.update_block(uid, text="### Section")
    block = pkm_client.get_block(uid)["block"]
    assert (block["text"], block["heading"]) == ("Section", 3)
    tools.update_block(uid, mark="TODO")
    block = pkm_client.get_block(uid)["block"]
    assert (block["text"], block["heading"]) == ("{{TODO}} Section", 3)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest tests/test_cli_build.py -q
```

Expected: `ImportError: cannot import name 'plan_update'` — collection fails. Then, once `plan_update` exists but before the shells are wired, the `test_cli_main_write.py` / `test_mcp_server.py` additions fail on `block["heading"]` being `None` instead of the expected level.

- [ ] **Step 3: Implement `plan_update` in `cli/build.py`**

Add the import near the top, beside the existing `from pkm.todo import with_state`:

```python
from pkm.server.ops_core import text_hash
```

(`ops_core` is itself `# pattern: Functional Core` and `text_hash` is pure, so this keeps `build.py` a Core file. `cli/main.py` already imports from the same module.)

Add after `plan_save` (i.e. after line 193):

```python
def plan_update(uid: str, text: str,
                base_text: str | None = None) -> list[dict]:
    """Ops for replacing a block's text: `update_text` plus the
    `set_heading` that keeps the stored level in step with the text's
    leading hashes -- no hashes means plain text, so a heading is cleared.

    `base_text`, when given, adds the `base_text_hash` concurrent-edit
    guard (the standalone `pkm update` / `update_block` path). `pkm batch`'s
    `update` command passes None: batch updates carry no guard by design.

    `set_heading` is emitted unconditionally rather than compared against
    the block's current level -- it is idempotent, and the batch path has
    no fetched block to compare against.

    Callers must NOT route a task-marker change (`-D`/`-T`/`mark=`)
    through here: the text those read back from the API is already bare,
    so it would split to no hashes and demote a real heading.
    """
    body, level = split_heading(text)
    update: dict = {"op": "update_text", "uid": uid, "text": body}
    if base_text is not None:
        update["base_text_hash"] = text_hash(base_text)
    return [update, {"op": "set_heading", "uid": uid, "heading": level}]
```

Replace `plan_batch`'s `update` branch (currently lines 300–303):

```python
        elif name == "update":
            uid = _alias_uid(params["uid"], aliases)
            ops.extend(plan_update(uid, params["text"]))
```

Add `"plan_update"` to `__all__`:

```python
__all__ = [
    "BuildError", "parse_outline", "next_child_idx", "resolve_parent",
    "split_heading", "plan_save", "plan_update", "asset_block_text",
    "referenced_pages", "plan_batch",
]
```

- [ ] **Step 4: Wire the CLI shell**

In `server/src/pkm/cli/main.py`, extend the `pkm.cli.build` import (lines 21–22) to include `plan_update`:

```python
from pkm.cli.build import (BuildError, asset_block_text, plan_batch,
                           plan_save, plan_update, referenced_pages)
```

Replace `cmd_update` (lines 363–382) with:

```python
def cmd_update(args: argparse.Namespace, client: PkmClient) -> int:
    changes = [args.text is not None, args.done, args.todo]
    if sum(changes) != 1:
        print("exactly one of TEXT, -D, or -T is required", file=sys.stderr)
        return 1
    current = client.get_block(args.uid)["block"]["text"]
    if args.done or args.todo:
        # Not plan_update: `current` is already bare (the heading level
        # lives in its own column), so splitting it would find no hashes
        # and demote a real heading to plain text.
        ops = [{"op": "update_text", "uid": args.uid,
                "text": with_state(current, "DONE" if args.done else "TODO"),
                "base_text_hash": text_hash(current)}]
    else:
        new_text = _read_text_arg(args.text)
        if args.text in (None, "-"):
            new_text = new_text.rstrip("\n")
        ops = plan_update(args.uid, new_text, current)
    client.post_ops(ops, batch_id=uuid.uuid4().hex)
    print(f"updated ^{args.uid}")
    return 0
```

`with_state` and `text_hash` are already imported in that file (lines 27–28); leave those imports alone.

- [ ] **Step 5: Wire the MCP shell**

In `server/src/pkm/mcp/server.py`, extend the `pkm.cli.build` import (line 15):

```python
from pkm.cli.build import (asset_block_text, plan_batch, plan_save,
                           plan_update, referenced_pages)
```

Replace the body of `update_block` after the validation guards (lines 116–123) with:

```python
    client = _client()
    current = client.get_block(uid)["block"]["text"]
    if mark is not None:
        # Not plan_update: `current` is already bare, so it would split to
        # no hashes and clear the block's heading.
        ops = [{"op": "update_text", "uid": uid,
                "text": with_state(current, mark),
                "base_text_hash": text_hash(current)}]
    else:
        assert text is not None
        ops = plan_update(uid, text, current)
    client.post_ops(ops, batch_id=uuid.uuid4().hex)
    return f"updated ^{uid}"
```

`with_state` and `text_hash` are already imported there (lines 19–20).

- [ ] **Step 6: Run the tests**

```bash
uv run pytest tests/test_cli_build.py tests/test_cli_main_write.py tests/test_mcp_server.py -q
```

Expected: PASS. If `test_update_done_flag_keeps_the_heading` fails with `heading == None`, the `-D` path is going through `plan_update` — recheck Step 4's branch.

- [ ] **Step 7: Run the full gate**

```bash
uv run pytest -q && uv run pyrefly check && uv run ruff check
```

Expected: all pass, coverage gate included.

- [ ] **Step 8: Commit**

```bash
git add server/src/pkm/cli/build.py server/src/pkm/cli/main.py \
        server/src/pkm/mcp/server.py server/tests/test_cli_build.py \
        server/tests/test_cli_main_write.py server/tests/test_mcp_server.py
git commit -m "fix(pkm-8m94): CLI/MCP updates keep text and heading level in step

plan_update() pairs update_text with the set_heading its leading hashes
imply, so 'pkm update <uid> \"## X\"' makes a real heading and plain text
clears one. cmd_update and the MCP update_block share it; batch update
gets the same two ops without the hash guard.

The -D/-T/mark= paths deliberately bypass it: the text they read back is
already bare, so splitting it would demote a real heading.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012esBP8RU2pXLhxhyKwCs7u"
```

---

### Task 3: Contracts and documentation

**Files:**
- Modify: `server/src/pkm/cli/main.py` (`_SAVE_EPILOG` ~line 120, `_UPDATE_EPILOG` ~line 135, `_BATCH_EPILOG` ~line 169)
- Modify: `server/src/pkm/mcp/server.py` (docstrings of `save_note`, `update_block`, `batch`)
- Modify: `.claude/skills/pkm/SKILL.md` (Write verbs section)
- Modify: `README.md` (the Notes paragraph after the CLI quick reference, ~line 198)
- Modify: `docs/architecture/backend.md:389-395`
- Test: `server/tests/test_cli_help.py`

**Interfaces:**
- Consumes: the behaviour built in Tasks 1 and 2. No new code.
- Produces: nothing later tasks depend on.

This task is not cosmetic. The absence of any mention that headings could be set is *why* the bug went unnoticed — an LLM reading these contracts had no way to know `## Section` would come out literal.

- [ ] **Step 1: Write the failing drift-guard test**

Append to `server/tests/test_cli_help.py`:

```python
@pytest.mark.parametrize("verb", ["save", "update", "batch"])
def test_write_verb_help_documents_heading_levels(verb, capsys):
    with pytest.raises(SystemExit):
        main([verb, "--help"])
    out = capsys.readouterr().out
    assert "heading" in out.lower(), f"{verb} --help omits heading levels"
    assert "###" in out, f"{verb} --help omits the heading marker syntax"
```

- [ ] **Step 2: Run it to verify it fails**

```bash
uv run pytest tests/test_cli_help.py -q -k heading_levels
```

Expected: FAIL — `save --help omits heading levels` (its epilog mentions `"## Heading"` only as a `--parent` form, and `###` appears nowhere).

- [ ] **Step 3: Update the CLI epilogs**

In `server/src/pkm/cli/main.py`, add to `_SAVE_EPILOG`, immediately after the `--todo` paragraph and before `example:`:

```
A line beginning "# ", "## " or "### " becomes a real heading block at
that level (1-3); the hashes are not stored as text. "#Tag" (no space)
is a tag, not a heading, and is stored as written -- as is "#### " and
deeper, since blocks only carry levels 1-3.
```

Add to `_UPDATE_EPILOG`, after the paragraph about hash-guarded text updates:

```
A TEXT beginning "# ", "## " or "### " makes the block a heading at
that level; TEXT without those hashes makes it plain text, clearing any
heading it had. -D and -T only change the task marker and never touch
the heading level. Since `pkm get` prints a heading AS "## text", a
fetch-then-update round trip preserves the level on its own.
```

In `_BATCH_EPILOG`, extend the `create` and `update` command entries:

```
  create   {page, text, parent?, index?, as?}
      appends one block. "as": "name" lets later commands in the same
      batch reference the created block via a parent/uid param of
      "{{name}}". A text beginning "# ", "## " or "### " becomes a
      heading block at that level (1-3), hashes not stored; a heading
      created this way also satisfies a later "## Heading" parent for
      the same text rather than creating a second one.
```

```
  update   {uid, text}
      replaces a block's text (uid may be "{{alias}}"). A text
      beginning "# ", "## " or "### " sets the heading level; text
      without hashes clears it. Unlike standalone `pkm update`, batch
      update carries NO hash guard: it always overwrites, and never
      preserves a concurrent edit as a conflict sibling.
```

- [ ] **Step 4: Run the drift guard**

```bash
uv run pytest tests/test_cli_help.py -q
```

Expected: PASS, including the pre-existing `test_batch_help_is_self_sufficient`.

- [ ] **Step 5: Update the MCP docstrings**

In `server/src/pkm/mcp/server.py`, these are the LLM-facing contracts — the single highest-value edit in this task.

`save_note`:

```python
    """Create block(s). Multi-line `text` becomes an outline (2-space
    indent = nesting). A line beginning '# ', '## ' or '### ' becomes a
    real heading at that level (1-3) with the hashes stripped; '#Tag' (no
    space) and '#### ' or deeper stay literal text. `page` defaults to
    today's daily note and is created if missing. `parent` is '## Heading'
    (created if missing) or '((uid))'. todo=True prefixes top-level items
    with {{TODO}}."""
```

`update_block`:

```python
    """Replace a block's text, or set its task marker (mark='TODO' or
    'DONE'). Provide exactly one of text/mark. A `text` beginning '# ',
    '## ' or '### ' makes the block a heading at that level; text without
    those hashes clears any heading it had. `mark` only changes the task
    marker and never the heading level. Concurrent-edit safe: the current
    text's hash rides along."""
```

`batch`: append to the existing docstring, after the sentence about `'as'`:

```
    A create/todo/outline text beginning '# ', '## ' or '### ' becomes a
    heading at that level; an `update` text sets or clears the level the
    same way.
```

- [ ] **Step 6: Update the skill doc and README**

In `.claude/skills/pkm/SKILL.md`, add a bullet to the Write verbs list, after the `save` bullet:

```markdown
- A line beginning `# `, `## `, or `### ` becomes a real heading block at
  that level (1-3) — on `save`, on `batch` create/todo/outline, and on
  `update`. The hashes are not stored as text. `#Tag` (no space) stays a
  tag, and `#### ` or deeper stays literal, since blocks only carry levels
  1-3. On `update`, text *without* leading hashes clears an existing
  heading; `-D`/`-T` never touch the level. `pkm get` prints a heading as
  `## text`, so fetch-then-update round trips are lossless.
```

In `README.md`, add to the Notes paragraph that follows the CLI quick reference:

```
A line starting `# `/`## `/`### ` is stored as a heading block at that
level (1-3) rather than as literal text — on `save`, `batch`, and
`update` alike; `#Tag` and `#### ` and deeper stay literal.
```

- [ ] **Step 7: Update the architecture doc**

In `docs/architecture/backend.md`, the planner list at line 389 enumerates `build.py`'s pure planners and must name the two new ones. Replace that bullet and the `POST /api/ops` bullet after it with:

```markdown
- `cli/build.py` (Core) holds the pure planners: `plan_save` (indented
  outline text → create ops), `plan_batch` (the `pkm batch` command language:
  `create`/`todo`/`update`/`move`/`delete`/`outline`, `as`-aliases,
  matched-or-created `## Heading` parents), `plan_update` (a text
  replacement → `update_text` + `set_heading`), `split_heading` (strips
  `#`/`##`/`###` off a line into a heading level 1-3),
  `asset_block_text` (MIME → image embed / `{{[[pdf]]}}` macro / link).
  `cli/render.py` (Core) renders API payloads to terminal markdown.
- Text is the source of truth for a block's heading level on every CLI/MCP
  write: `split_heading` runs in `_Planner.creates` (the one call site every
  create path funnels through) and in `plan_update`, so `## X` is never
  stored as literal text and `render.py`'s `## text` output reads back as a
  heading. Deliberate exclusions: `#Tag` (no space), `#### ` and deeper
  (blocks carry levels 1-3), and multi-line text, which stays verbatim in
  one block. The `-D`/`-T`/`mark=` task-marker paths bypass `plan_update`
  entirely — the text they read back is already bare, so splitting it would
  demote a real heading.
- Writes go through `POST /api/ops` with a fresh `batch_id`; `pkm update`
  fetches current text first and rides the `base_text_hash` conflict path.
```

- [ ] **Step 8: Run the full gate**

```bash
uv run pytest -q && uv run pyrefly check && uv run ruff check
```

Expected: all pass. `test_batch_help_is_self_sufficient` and the new heading drift guard both exercise the edited epilogs.

- [ ] **Step 9: Tick the bean and commit**

Mark the bean's checklist items done and add a `## Summary of Changes` section to `.beans/pkm-8m94--climcp-writes-store-headings-as-literal-markdown.md`, then:

```bash
git add server/src/pkm/cli/main.py server/src/pkm/mcp/server.py \
        server/tests/test_cli_help.py .claude/skills/pkm/SKILL.md \
        README.md docs/architecture/backend.md .beans/
git commit -m "docs(pkm-8m94): document heading levels in the CLI/MCP contracts

The missing contract is why this bug went unnoticed -- nothing told a
caller that '## X' would land as literal text, or that headings could be
set at all. Covers the save/update/batch epilogs (with a --help drift
guard), the three MCP docstrings, the pkm skill, README, and the
backend architecture doc's planner list.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012esBP8RU2pXLhxhyKwCs7u"
```

---

## Final verification

Before claiming the bean complete, from `<worktree>/server`:

```bash
uv run pytest -q
uv run pyrefly check
uv run ruff check
```

No web changes are involved, so `pnpm verify` is not part of this bean's gate.

Then a live smoke test against a **non-production** server (port 8974 is prod on this machine — writes there are real):

```bash
# from <worktree>/server, with a dev server running on 8975
PKM_URL=http://127.0.0.1:8975 uv run pkm save -p "Heading Smoke" \
  "## Overview
  a detail
### Deeper
#NotAHeading"
PKM_URL=http://127.0.0.1:8975 uv run pkm get "Heading Smoke" --uids
```

Expected output — the hashes come back because they are *rendered* from real levels, and the tag is untouched:

```
# Heading Smoke

- ## Overview  ^<uid>
  - a detail  ^<uid>
- ### Deeper  ^<uid>
- #NotAHeading  ^<uid>
```

Confirm in the browser that Overview renders as an `h2` and Deeper as an `h3`, not as literal `##`/`###` characters.
