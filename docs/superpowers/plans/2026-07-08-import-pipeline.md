# Roam Import Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A re-runnable Python importer that turns a Roam EDN export + linked-files download into the PKM's SQLite database, content-addressed asset store, and a full import report.

**Architecture:** Pure functional core (EDN parsing → entity assembly → page/block tree → SQL rows; ref extraction; asset URL rewriting; report generation) with one thin imperative-shell CLI that reads files, writes the database to a temp file, and atomically swaps it in. Spec: `docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md`.

**Tech Stack:** Python ≥3.12, uv, pytest, sqlite3 (stdlib), FTS5. No third-party runtime dependencies.

**This is plan 1 of 5** (import → backend API → frontend read → frontend edit → deployment).

## Global Constraints

- Python ≥ 3.12, managed with `uv`; all commands run from `server/` via `uv run …`.
- Every runtime file declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top (per CLAUDE.md). Tests/configs exempt.
- Block text is stored **unmodified** except firebase asset URLs rewritten to `/assets/{sha256}/{filename}`.
- Roam uids are preserved exactly.
- Importer builds a **fresh** DB each run and atomically replaces `data/pkm.sqlite3` (`os.replace`).
- Nothing silently dropped: every datom attribute is counted and surfaced in the report.
- Daily page titles keep Roam's ordinal format (`July 8th, 2026`) — the importer does not touch titles.
- `sample-data/` and `data/` are gitignored (personal data). Never commit them.
- Commit after every green test cycle. Commit messages end with the Claude trailer (see repo git log for format).

## File Structure

```
server/
  pyproject.toml
  src/pkm/__init__.py
  src/pkm/edn.py                # FC: minimal EDN parser (datascript dump subset)
  src/pkm/refs.py               # FC: ref extraction from Roam-flavoured text
  src/pkm/schema.py             # FC: SQL DDL constants (incl. FTS5 + triggers)
  src/pkm/importer/__init__.py
  src/pkm/importer/parse_export.py  # FC: datoms → entities → Page/Block tree
  src/pkm/importer/rows.py      # FC: tree (+text transform) → SQL row tuples
  src/pkm/importer/assets.py    # FC: firebase URL detection/rewrite
  src/pkm/importer/report.py    # FC: ImportReport dataclass + text rendering
  src/pkm/importer/run.py       # IS: CLI — read files, write db, swap, report
  tests/test_edn.py
  tests/test_refs.py
  tests/test_parse_export.py
  tests/test_rows.py
  tests/test_assets.py
  tests/test_importer_e2e.py
  tests/fixtures/sample_export.edn
shared/fixtures/ref_grammar.json   # pins ref grammar for Python AND (later) TS
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `server/pyproject.toml`, `server/src/pkm/__init__.py`, `server/tests/test_smoke.py`

**Interfaces:**
- Produces: importable `pkm` package; `uv run pytest` works from `server/`.

- [ ] **Step 1: Write files**

`server/pyproject.toml`:
```toml
[project]
name = "pkm-server"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = []

[dependency-groups]
dev = ["pytest>=8"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/pkm"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`server/src/pkm/__init__.py`: empty file.

`server/tests/test_smoke.py`:
```python
import pkm


def test_package_imports():
    assert pkm is not None
```

- [ ] **Step 2: Sync and run**

Run: `cd server && uv sync && uv run pytest -v`
Expected: `test_package_imports PASSED`

- [ ] **Step 3: Commit**

```bash
git add server/ && git commit -m "feat: scaffold python server package"
```

---

### Task 2: Ref-extraction grammar (shared fixture + Python parser)

**Files:**
- Create: `shared/fixtures/ref_grammar.json`, `server/src/pkm/refs.py`, `server/tests/test_refs.py`

**Interfaces:**
- Produces: `pkm.refs.extract(text: str) -> ParsedRefs` where
  `ParsedRefs(refs: tuple[Ref, ...], block_refs: tuple[str, ...], embeds: int)`
  and `Ref(title: str, kind: str)` with kind ∈ `"link" | "tag" | "attribute"`.
  Task 6 (rows) consumes `extract`. The TS renderer (plan 3) must pass the same fixture.

- [ ] **Step 1: Write the shared grammar fixture**

`shared/fixtures/ref_grammar.json`:
```json
{
  "cases": [
    {"name": "plain link",
     "text": "Read [[Machine Learning]] today",
     "refs": [{"title": "Machine Learning", "kind": "link"}],
     "block_refs": [], "embeds": 0},
    {"name": "attribute plus tags",
     "text": "Tags:: #AI #[[Generative Models]]",
     "refs": [{"title": "Tags", "kind": "attribute"},
              {"title": "Generative Models", "kind": "tag"},
              {"title": "AI", "kind": "tag"}],
     "block_refs": [], "embeds": 0},
    {"name": "nested link yields outer and inner",
     "text": "See [[AI [[GPT-3]] notes]]",
     "refs": [{"title": "AI [[GPT-3]] notes", "kind": "link"},
              {"title": "GPT-3", "kind": "link"}],
     "block_refs": [], "embeds": 0},
    {"name": "inline code is not scanned",
     "text": "run `[[not a ref]]` now",
     "refs": [], "block_refs": [], "embeds": 0},
    {"name": "fenced code is not scanned",
     "text": "```python\nx = \"[[not a ref]]\"  # #nottag\n```",
     "refs": [], "block_refs": [], "embeds": 0},
    {"name": "query block refs its pages",
     "text": "{{[[query]]: {and: [[Paper]] [[Link]]}}}",
     "refs": [{"title": "query", "kind": "link"},
              {"title": "Paper", "kind": "link"},
              {"title": "Link", "kind": "link"}],
     "block_refs": [], "embeds": 0},
    {"name": "block ref is counted not linked",
     "text": "See ((abc123XYZ)) here",
     "refs": [], "block_refs": ["abc123XYZ"], "embeds": 0},
    {"name": "hash inside url is not a tag",
     "text": "see https://example.com/#anchor and #real",
     "refs": [{"title": "real", "kind": "tag"}],
     "block_refs": [], "embeds": 0},
    {"name": "embed is counted",
     "text": "{{[[embed]]: ((xyz987654))}}",
     "refs": [{"title": "embed", "kind": "link"}],
     "block_refs": ["xyz987654"], "embeds": 1},
    {"name": "duplicate refs dedupe",
     "text": "[[A/B]] then [[A/B]] again",
     "refs": [{"title": "A/B", "kind": "link"}],
     "block_refs": [], "embeds": 0},
    {"name": "url with colons is not an attribute",
     "text": "https://example.com/page has no attribute",
     "refs": [], "block_refs": [], "embeds": 0}
  ]
}
```

- [ ] **Step 2: Write the failing test**

`server/tests/test_refs.py`:
```python
import json
from pathlib import Path

import pytest

from pkm.refs import Ref, extract

FIXTURE = Path(__file__).parents[2] / "shared" / "fixtures" / "ref_grammar.json"
CASES = json.loads(FIXTURE.read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_grammar_fixture(case):
    parsed = extract(case["text"])
    assert [{"title": r.title, "kind": r.kind} for r in parsed.refs] == case["refs"]
    assert list(parsed.block_refs) == case["block_refs"]
    assert parsed.embeds == case["embeds"]


def test_ref_ordering_and_types():
    parsed = extract("Tags:: [[B]] #c")
    assert parsed.refs == (
        Ref("Tags", "attribute"),
        Ref("B", "link"),
        Ref("c", "tag"),
    )
```

Note: `refs` in each fixture case are ordered attribute → bracket links/tags (scan order) → bare hashtags.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_refs.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.refs'`

- [ ] **Step 4: Implement `refs.py`**

`server/src/pkm/refs.py`:
```python
# pattern: Functional Core
"""Extract page references from Roam-flavoured block text.

Grammar is pinned by shared/fixtures/ref_grammar.json; the TS renderer
must pass the same fixture (see design spec, Section 1).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

_CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`[^`\n]*`")
_ATTRIBUTE = re.compile(r"^\s*([^\[\]{}:\n]+?)::")
_HASHTAG = re.compile(r"(?:^|(?<=[\s(]))#([\w/.\-]+)")
_BLOCK_REF = re.compile(r"\(\(([a-zA-Z0-9_-]{6,})\)\)")
_EMBED = re.compile(r"\{\{\s*(?:\[\[)?embed(?:\]\])?\s*[:}]")


@dataclass(frozen=True)
class Ref:
    title: str
    kind: str  # "link" | "tag" | "attribute"


@dataclass(frozen=True)
class ParsedRefs:
    refs: tuple[Ref, ...]
    block_refs: tuple[str, ...]
    embeds: int


def _strip_code(text: str) -> str:
    text = _CODE_FENCE.sub(lambda m: " " * len(m.group()), text)
    return _INLINE_CODE.sub(lambda m: " " * len(m.group()), text)


def _scan_brackets(text: str, nested: bool = False) -> list[tuple[str, bool]]:
    """Balanced [[...]] scan. Nested links yield outer then inner titles.
    Returns (title, is_tag) pairs; is_tag when written as #[[...]]."""
    out: list[tuple[str, bool]] = []
    i, n = 0, len(text)
    while i < n - 1:
        if text[i] == "[" and text[i + 1] == "[":
            depth, j = 1, i + 2
            while j < n - 1 and depth:
                pair = text[j : j + 2]
                if pair == "[[":
                    depth, j = depth + 1, j + 2
                elif pair == "]]":
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            if depth == 0:
                inner = text[i + 2 : j - 2]
                is_tag = not nested and i > 0 and text[i - 1] == "#"
                out.append((inner, is_tag))
                out.extend(_scan_brackets(inner, nested=True))
                i = j
                continue
        i += 1
    return out


def extract(text: str) -> ParsedRefs:
    clean = _strip_code(text)
    refs: list[Ref] = []
    if m := _ATTRIBUTE.match(clean):
        refs.append(Ref(m.group(1).strip(), "attribute"))
    for title, is_tag in _scan_brackets(clean):
        refs.append(Ref(title, "tag" if is_tag else "link"))
    for m in _HASHTAG.finditer(clean):
        refs.append(Ref(m.group(1), "tag"))
    seen: set[tuple[str, str]] = set()
    deduped = [r for r in refs
               if (r.title, r.kind) not in seen
               and not seen.add((r.title, r.kind))]
    return ParsedRefs(
        refs=tuple(deduped),
        block_refs=tuple(m.group(1) for m in _BLOCK_REF.finditer(clean)),
        embeds=len(_EMBED.findall(clean)),
    )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_refs.py -v`
Expected: all cases PASS. If a fixture case fails, fix the implementation — the fixture is the contract; change a fixture expectation only if it contradicts the spec.

- [ ] **Step 6: Commit**

```bash
git add shared/ server/ && git commit -m "feat: ref-extraction grammar with shared fixture"
```

---

### Task 3: Minimal EDN parser

**Files:**
- Create: `server/src/pkm/edn.py`, `server/tests/test_edn.py`

**Interfaces:**
- Produces: `pkm.edn.parse_edn(text: str) -> object` returning: dict for maps
  (keyword keys kept as strings with leading `:`), list for vectors/lists/sets,
  `str`/`int`/`float`/`bool`/`None` for atoms, and `Tagged(tag: str, value: object)`
  for tagged literals (`#datascript/DB {...}`). `EdnError(ValueError)` on malformed
  input. Task 4 consumes `parse_edn` and `Tagged`.

- [ ] **Step 1: Write the failing test**

`server/tests/test_edn.py`:
```python
import pytest

from pkm.edn import EdnError, Tagged, parse_edn


def test_datascript_dump_shape():
    src = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref,
                                                       :db/cardinality :db.cardinality/many}}
                             :datoms [[1 :node/title "AI" 536870913]
                                      [1 :block/children 2 536870913]
                                      [2 :block/string "hi \\"there\\"\\nline2" 536870913]
                                      [2 :block/open false 536870913]
                                      [2 :edit/time 1600000000000 536870913]]}"""
    db = parse_edn(src)
    assert isinstance(db, Tagged) and db.tag == "datascript/DB"
    schema = db.value[":schema"]
    assert schema[":block/children"][":db/cardinality"] == ":db.cardinality/many"
    datoms = db.value[":datoms"]
    assert datoms[0] == [1, ":node/title", "AI", 536870913]
    assert datoms[2][2] == 'hi "there"\nline2'
    assert datoms[3][2] is False
    assert datoms[4][2] == 1600000000000


def test_atoms_and_collections():
    assert parse_edn("nil") is None
    assert parse_edn("true") is True
    assert parse_edn("[1 -2 3.5]") == [1, -2, 3.5]
    assert parse_edn("#{1 2}") == [1, 2]
    assert parse_edn('{"k" (1 2)}') == {"k": [1, 2]}
    assert parse_edn(':a/b') == ":a/b"
    assert parse_edn('"\\u00e9"') == "é"
    assert parse_edn('#uuid "abc"') == Tagged("uuid", "abc")


def test_comments_commas_discard():
    assert parse_edn("[1, 2 ; comment\n 3 #_ 99 4]") == [1, 2, 3, 4]


def test_errors():
    with pytest.raises(EdnError):
        parse_edn('"unterminated')
    with pytest.raises(EdnError):
        parse_edn("{:a}")
    with pytest.raises(EdnError):
        parse_edn("[1] trailing")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_edn.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.edn'`

- [ ] **Step 3: Implement `edn.py`**

`server/src/pkm/edn.py`:
```python
# pattern: Functional Core
"""Minimal EDN parser — the subset used by Roam/DataScript EDN exports.

Maps -> dict (keywords kept as ':kw' strings), vectors/lists/sets -> list,
tagged literals -> Tagged. Not a general EDN library.
"""
from __future__ import annotations

from dataclasses import dataclass

_WS = set(" \t\n\r,")
_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t", "r": "\r",
            "b": "\b", "f": "\f"}
_NAMED_CHARS = {"newline": "\n", "space": " ", "tab": "\t", "return": "\r"}


class EdnError(ValueError):
    pass


@dataclass(frozen=True)
class Tagged:
    tag: str
    value: object


def parse_edn(text: str) -> object:
    value, pos = _parse(text, _skip_ws(text, 0))
    if _skip_ws(text, pos) != len(text):
        raise EdnError(f"trailing data at offset {pos}")
    return value


def _skip_ws(text: str, pos: int) -> int:
    n = len(text)
    while pos < n:
        c = text[pos]
        if c in _WS:
            pos += 1
        elif c == ";":
            while pos < n and text[pos] != "\n":
                pos += 1
        else:
            break
    return pos


def _parse(text: str, pos: int) -> tuple[object, int]:
    if pos >= len(text):
        raise EdnError("unexpected end of input")
    c = text[pos]
    if c == "{":
        return _parse_map(text, pos + 1)
    if c == "[":
        return _parse_seq(text, pos + 1, "]")
    if c == "(":
        return _parse_seq(text, pos + 1, ")")
    if c == '"':
        return _parse_string(text, pos + 1)
    if c == "#":
        return _parse_dispatch(text, pos + 1)
    if c == "\\":
        return _parse_char(text, pos + 1)
    return _parse_atom(text, pos)


def _parse_map(text: str, pos: int) -> tuple[dict, int]:
    items = []
    while True:
        pos = _skip_ws(text, pos)
        if pos >= len(text):
            raise EdnError("unterminated map")
        if text[pos] == "}":
            break
        value, pos = _parse(text, pos)
        items.append(value)
    if len(items) % 2:
        raise EdnError("map has odd number of forms")
    return dict(zip(items[::2], items[1::2], strict=True)), pos + 1


def _parse_seq(text: str, pos: int, closer: str) -> tuple[list, int]:
    items: list = []
    while True:
        pos = _skip_ws(text, pos)
        if pos >= len(text):
            raise EdnError("unterminated sequence")
        if text[pos] == closer:
            return items, pos + 1
        value, pos = _parse(text, pos)
        items.append(value)


def _parse_string(text: str, pos: int) -> tuple[str, int]:
    out: list[str] = []
    n = len(text)
    while pos < n:
        c = text[pos]
        if c == '"':
            return "".join(out), pos + 1
        if c == "\\":
            if pos + 1 >= n:
                break
            e = text[pos + 1]
            if e == "u":
                out.append(chr(int(text[pos + 2 : pos + 6], 16)))
                pos += 6
            else:
                out.append(_ESCAPES.get(e, e))
                pos += 2
        else:
            out.append(c)
            pos += 1
    raise EdnError("unterminated string")


def _parse_dispatch(text: str, pos: int) -> tuple[object, int]:
    if text[pos] == "{":  # set literal #{...}
        return _parse_seq(text, pos + 1, "}")
    if text[pos] == "_":  # discard form #_
        _, pos = _parse(text, _skip_ws(text, pos + 1))
        return _parse(text, _skip_ws(text, pos))
    start = pos
    while pos < len(text) and text[pos] not in _WS and text[pos] not in '{[("':
        pos += 1
    tag = text[start:pos]
    value, pos = _parse(text, _skip_ws(text, pos))
    return Tagged(tag, value), pos


def _parse_char(text: str, pos: int) -> tuple[str, int]:
    start = pos
    while pos < len(text) and text[pos] not in _WS and text[pos] not in '()[]{}"':
        pos += 1
    token = text[start:pos]
    return _NAMED_CHARS.get(token, token[:1]), pos


def _parse_atom(text: str, pos: int) -> tuple[object, int]:
    start = pos
    n = len(text)
    while pos < n and text[pos] not in _WS and text[pos] not in '()[]{}";':
        pos += 1
    token = text[start:pos]
    if not token:
        raise EdnError(f"unexpected character at offset {pos}")
    if token == "nil":
        return None, pos
    if token == "true":
        return True, pos
    if token == "false":
        return False, pos
    if token[0] == ":":
        return token, pos
    try:
        return int(token), pos
    except ValueError:
        pass
    try:
        return float(token), pos
    except ValueError:
        pass
    return token, pos  # bare symbol, kept as its string
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_edn.py -v`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/ && git commit -m "feat: minimal EDN parser for datascript exports"
```

Performance note for the executor: this parser is pure Python. On the real export (Task 9) importing should be an offline batch step; only optimize if a run exceeds ~2 minutes, and then only the string-scanning hot path.

---

### Task 4: Datoms → Page/Block tree

**Files:**
- Create: `server/src/pkm/importer/__init__.py` (empty), `server/src/pkm/importer/parse_export.py`, `server/tests/test_parse_export.py`

**Interfaces:**
- Consumes: `pkm.edn.Tagged`.
- Produces (Task 6 and Task 9 consume these):
  - `Block(uid: str, text: str, heading: int | None, open: bool, created_at: int | None, edited_at: int | None, children: tuple[Block, ...])`
  - `Page(title: str, created_at: int | None, edited_at: int | None, children: tuple[Block, ...])`
  - `Export(pages: tuple[Page, ...], orphan_block_count: int, skipped_entities: int, attr_counts: dict[str, int])`
  - `parse_export(db: object) -> Export` — raises `ValueError` if not a `datascript/DB` tagged value.
  - Module constant `CONSUMED_ATTRS: frozenset[str]` (used by the report).

- [ ] **Step 1: Write the failing test**

`server/tests/test_parse_export.py`:
```python
import pytest

from pkm.edn import parse_edn
from pkm.importer.parse_export import parse_export

EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Machine Learning" 536870913]
  [1 :create/time 1600000000000 536870913]
  [1 :edit/time 1600000001000 536870913]
  [1 :block/children 3 536870913]
  [1 :block/children 2 536870913]
  [2 :block/uid "uid-2xxxx" 536870913]
  [2 :block/string "second (order 1)" 536870913]
  [2 :block/order 1 536870913]
  [3 :block/uid "uid-3xxxx" 536870913]
  [3 :block/string "first (order 0)" 536870913]
  [3 :block/order 0 536870913]
  [3 :block/heading 2 536870913]
  [3 :block/open false 536870913]
  [3 :block/children 4 536870913]
  [4 :block/uid "uid-4xxxx" 536870913]
  [4 :block/string "nested child" 536870913]
  [4 :block/order 0 536870913]
  [4 :edit/time 1600000002000 536870913]
  [5 :block/uid "uid-orphan" 536870913]
  [5 :block/string "unreachable" 536870913]
  [6 :block/uid "uid-empty" 536870913]
  [2 :block/refs 1 536870913]
 ]}"""


def test_tree_shape_and_ordering():
    export = parse_export(parse_edn(EXPORT))
    assert len(export.pages) == 1
    page = export.pages[0]
    assert page.title == "Machine Learning"
    assert page.created_at == 1600000000000
    assert [b.text for b in page.children] == ["first (order 0)", "second (order 1)"]
    first = page.children[0]
    assert first.heading == 2
    assert first.open is False
    assert first.children[0].uid == "uid-4xxxx"
    assert first.children[0].edited_at == 1600000002000


def test_orphans_skips_and_attr_counts():
    export = parse_export(parse_edn(EXPORT))
    assert export.orphan_block_count == 1      # uid-orphan
    assert export.skipped_entities == 1        # eid 6: uid but no string
    assert export.attr_counts[":block/refs"] == 1
    assert export.attr_counts[":node/title"] == 1


def test_rejects_non_datascript_value():
    with pytest.raises(ValueError):
        parse_export({"not": "a db"})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_parse_export.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.importer'`

- [ ] **Step 3: Implement `parse_export.py`**

`server/src/pkm/importer/parse_export.py`:
```python
# pattern: Functional Core
"""Transform a parsed Roam EDN export into a tree of Pages and Blocks."""
from __future__ import annotations

from dataclasses import dataclass

from pkm.edn import Tagged

CONSUMED_ATTRS: frozenset[str] = frozenset({
    ":node/title", ":block/uid", ":block/string", ":block/order",
    ":block/children", ":block/heading", ":block/open",
    ":create/time", ":edit/time",
})


@dataclass(frozen=True)
class Block:
    uid: str
    text: str
    heading: int | None
    open: bool
    created_at: int | None
    edited_at: int | None
    children: tuple["Block", ...]


@dataclass(frozen=True)
class Page:
    title: str
    created_at: int | None
    edited_at: int | None
    children: tuple[Block, ...]


@dataclass(frozen=True)
class Export:
    pages: tuple[Page, ...]
    orphan_block_count: int
    skipped_entities: int
    attr_counts: dict[str, int]


def parse_export(db: object) -> Export:
    if not (isinstance(db, Tagged) and db.tag == "datascript/DB"):
        raise ValueError("input is not a #datascript/DB export")
    schema = db.value.get(":schema", {})
    datoms = db.value.get(":datoms", [])
    many = {a for a, spec in schema.items()
            if isinstance(spec, dict)
            and spec.get(":db/cardinality") == ":db.cardinality/many"}

    entities: dict[int, dict[str, object]] = {}
    attr_counts: dict[str, int] = {}
    for e, a, v, *_ in datoms:
        attr_counts[a] = attr_counts.get(a, 0) + 1
        ent = entities.setdefault(e, {})
        if a in many:
            ent.setdefault(a, []).append(v)
        else:
            ent[a] = v

    def is_block(ent: dict[str, object]) -> bool:
        return ":block/uid" in ent and ":block/string" in ent

    skipped = 0
    built: dict[int, Block] = {}

    def build(eid: int, trail: frozenset[int]) -> Block | None:
        nonlocal skipped
        if eid in trail:  # cycle guard: a child that is its own ancestor
            return None
        if eid in built:
            return built[eid]
        ent = entities.get(eid, {})
        if not is_block(ent):
            skipped += 1
            return None
        block = Block(
            uid=ent[":block/uid"],
            text=ent[":block/string"],
            heading=ent.get(":block/heading"),
            open=bool(ent.get(":block/open", True)),
            created_at=ent.get(":create/time"),
            edited_at=ent.get(":edit/time"),
            children=_children(ent, trail | {eid}),
        )
        built[eid] = block
        return block

    def _children(ent: dict[str, object], trail: frozenset[int]) -> tuple[Block, ...]:
        kids = ent.get(":block/children", [])
        ordered = sorted(kids, key=lambda c: entities.get(c, {}).get(":block/order", 0))
        return tuple(b for c in ordered if (b := build(c, trail)) is not None)

    pages = []
    for eid, ent in entities.items():
        if ":node/title" not in ent:
            continue
        pages.append(Page(
            title=ent[":node/title"],
            created_at=ent.get(":create/time"),
            edited_at=ent.get(":edit/time"),
            children=_children(ent, frozenset({eid})),
        ))

    reached: set[str] = set()

    def walk(b: Block) -> None:
        reached.add(b.uid)
        for c in b.children:
            walk(c)

    for p in pages:
        for b in p.children:
            walk(b)
    all_uids = {ent[":block/uid"] for ent in entities.values() if is_block(ent)}

    return Export(
        pages=tuple(sorted(pages, key=lambda p: p.title)),
        orphan_block_count=len(all_uids - reached),
        skipped_entities=skipped,
        attr_counts=attr_counts,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_parse_export.py -v`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/ && git commit -m "feat: assemble page/block tree from datascript datoms"
```

Note for executor: deep outlines recurse; `run.py` (Task 9) sets `sys.setrecursionlimit(20000)` before parsing — that is deliberate and stays in the shell.

---

### Task 5: Asset URL detection and rewriting

**Files:**
- Create: `server/src/pkm/importer/assets.py`, `server/tests/test_assets.py`

**Interfaces:**
- Produces (Tasks 6 and 9 consume):
  - `Asset(sha256: str, filename: str, mime: str, size: int)`
  - `url_basename(url: str) -> str`
  - `rewrite_asset_urls(text: str, by_name: dict[str, Asset]) -> tuple[str, frozenset[str], frozenset[str]]`
    returning (new_text, used sha256s, missing URLs). `by_name` keys are lowercase filenames.

- [ ] **Step 1: Write the failing test**

`server/tests/test_assets.py`:
```python
from pkm.importer.assets import Asset, rewrite_asset_urls, url_basename

URL = ("https://firebasestorage.googleapis.com/v0/b/firescript-577a2.appspot.com/"
       "o/imgs%2Fapp%2Fgraph%2Fpaper-fig.png?alt=media&token=abc-123")
INDEX = {"paper-fig.png": Asset("f" * 64, "paper-fig.png", "image/png", 7)}


def test_url_basename_decodes_path():
    assert url_basename(URL) == "paper-fig.png"


def test_rewrites_known_url():
    text = f"figure: ![]({URL}) end"
    new, used, missing = rewrite_asset_urls(text, INDEX)
    assert new == f"figure: ![](/assets/{'f' * 64}/paper-fig.png) end"
    assert used == frozenset({"f" * 64})
    assert missing == frozenset()


def test_unknown_url_left_alone_and_reported():
    other = URL.replace("paper-fig", "gone")
    new, used, missing = rewrite_asset_urls(f"see {other}", INDEX)
    assert other in new
    assert used == frozenset()
    assert missing == frozenset({other})


def test_non_firebase_urls_untouched():
    text = "see https://example.com/x.png"
    assert rewrite_asset_urls(text, INDEX)[0] == text


def test_filename_needing_quoting():
    idx = {"my file (1).pdf": Asset("a" * 64, "my file (1).pdf", "application/pdf", 9)}
    url = ("https://firebasestorage.googleapis.com/v0/b/x/o/"
           "my%20file%20%281%29.pdf?alt=media")
    new, used, _ = rewrite_asset_urls(f"[pdf]({url})", idx)
    assert f"/assets/{'a' * 64}/my%20file%20%281%29.pdf" in new
    assert used == frozenset({"a" * 64})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_assets.py -v`
Expected: FAIL — `ModuleNotFoundError` (no `pkm.importer.assets`)

- [ ] **Step 3: Implement `assets.py`**

`server/src/pkm/importer/assets.py`:
```python
# pattern: Functional Core
"""Detect Roam firebase asset URLs in block text and rewrite to local paths."""
from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass

_FIREBASE_URL = re.compile(
    r"https://firebasestorage\.googleapis\.com/[^\s\)\]\}\"']+"
)


@dataclass(frozen=True)
class Asset:
    sha256: str
    filename: str
    mime: str
    size: int


def url_basename(url: str) -> str:
    path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
    return path.rsplit("/", 1)[-1]


def rewrite_asset_urls(
    text: str, by_name: dict[str, Asset]
) -> tuple[str, frozenset[str], frozenset[str]]:
    used: set[str] = set()
    missing: set[str] = set()

    def _sub(m: re.Match[str]) -> str:
        url = m.group()
        asset = by_name.get(url_basename(url).lower())
        if asset is None:
            missing.add(url)
            return url
        used.add(asset.sha256)
        quoted = urllib.parse.quote(asset.filename)
        return f"/assets/{asset.sha256}/{quoted}"

    return _FIREBASE_URL.sub(_sub, text), frozenset(used), frozenset(missing)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_assets.py -v`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/ && git commit -m "feat: firebase asset url rewriting"
```

---

### Task 6: Tree → SQL rows (refs, implicit pages, counts)

**Files:**
- Create: `server/src/pkm/importer/rows.py`, `server/tests/test_rows.py`

**Interfaces:**
- Consumes: `Export`, `Page`, `Block` (Task 4); `extract` (Task 2).
- Produces (Task 9 consumes):
  - `Rows(pages: list[tuple], blocks: list[tuple], refs: list[tuple], implicit_page_count: int, block_ref_count: int, embed_count: int)`
    - pages rows: `(id, title, created_at, updated_at)`
    - blocks rows: `(uid, page_id, parent_uid, order_idx, text, heading, collapsed, created_at, updated_at)` in parent-before-child order
    - refs rows: `(src_block_uid, target_page_id, kind)`
  - `to_rows(export: Export, transform_text: Callable[[str], str]) -> Rows` — `transform_text` is applied to every block's text before ref extraction (Task 9 passes the asset rewriter; tests pass identity).

- [ ] **Step 1: Write the failing test**

`server/tests/test_rows.py`:
```python
from pkm.importer.parse_export import Block, Export, Page
from pkm.importer.rows import to_rows


def _block(uid, text, children=(), heading=None, open_=True):
    return Block(uid=uid, text=text, heading=heading, open=open_,
                 created_at=None, edited_at=None, children=tuple(children))


EXPORT = Export(
    pages=(
        Page("Machine Learning", 1600000000000, 1600000001000, (
            _block("uid-attr1", "Tags:: #AI"),
            _block("uid-head1", "Papers", heading=2, open_=False, children=(
                _block("uid-link1", "read [[Attention]] and [[AI]]"),
            )),
        )),
    ),
    orphan_block_count=0,
    skipped_entities=0,
    attr_counts={},
)


def test_pages_include_implicit_targets():
    rows = to_rows(EXPORT, lambda t: t)
    titles = {r[1] for r in rows.pages}
    assert titles == {"Machine Learning", "Tags", "AI", "Attention"}
    assert rows.implicit_page_count == 3
    ml = next(r for r in rows.pages if r[1] == "Machine Learning")
    assert ml[2] == 1600000000000


def test_block_rows_shape_and_order():
    rows = to_rows(EXPORT, lambda t: t)
    by_uid = {r[0]: r for r in rows.blocks}
    page_id = next(r[0] for r in rows.pages if r[1] == "Machine Learning")
    assert by_uid["uid-attr1"] == ("uid-attr1", page_id, None, 0, "Tags:: #AI",
                                   None, 0, None, None)
    assert by_uid["uid-head1"][3] == 1          # order_idx
    assert by_uid["uid-head1"][5] == 2          # heading
    assert by_uid["uid-head1"][6] == 1          # collapsed (open=False)
    assert by_uid["uid-link1"][2] == "uid-head1"  # parent_uid
    uids = [r[0] for r in rows.blocks]
    assert uids.index("uid-head1") < uids.index("uid-link1")  # parent first


def test_refs_rows():
    rows = to_rows(EXPORT, lambda t: t)
    page_ids = {r[1]: r[0] for r in rows.pages}
    assert set(rows.refs) == {
        ("uid-attr1", page_ids["Tags"], "attribute"),
        ("uid-attr1", page_ids["AI"], "tag"),
        ("uid-link1", page_ids["Attention"], "link"),
        ("uid-link1", page_ids["AI"], "link"),
    }


def test_transform_applied_before_extraction():
    rows = to_rows(EXPORT, lambda t: t.replace("[[Attention]]", "[[Rewritten]]"))
    titles = {r[1] for r in rows.pages}
    assert "Rewritten" in titles and "Attention" not in titles
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_rows.py -v`
Expected: FAIL — `ModuleNotFoundError` (no `pkm.importer.rows`)

- [ ] **Step 3: Implement `rows.py`**

`server/src/pkm/importer/rows.py`:
```python
# pattern: Functional Core
"""Flatten a parsed Export into SQL row tuples, deriving refs and
creating implicit pages for referenced-but-never-created titles."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from pkm.importer.parse_export import Block, Export
from pkm.refs import extract


@dataclass(frozen=True)
class Rows:
    pages: list[tuple]
    blocks: list[tuple]
    refs: list[tuple]
    implicit_page_count: int
    block_ref_count: int
    embed_count: int


def to_rows(export: Export, transform_text: Callable[[str], str]) -> Rows:
    pages: list[tuple] = []
    blocks: list[tuple] = []
    refs: list[tuple] = []
    page_ids: dict[str, int] = {}
    counts = {"block_ref": 0, "embed": 0}

    def page_id(title: str, created: int | None = None,
                updated: int | None = None) -> int:
        if title not in page_ids:
            page_ids[title] = len(page_ids) + 1
            pages.append((page_ids[title], title, created, updated))
        return page_ids[title]

    explicit = len(export.pages)
    for p in export.pages:  # register explicit pages first, with timestamps
        page_id(p.title, p.created_at, p.edited_at)

    def walk(b: Block, pid: int, parent_uid: str | None, order_idx: int) -> None:
        text = transform_text(b.text)
        parsed = extract(text)
        blocks.append((b.uid, pid, parent_uid, order_idx, text, b.heading,
                       0 if b.open else 1, b.created_at, b.edited_at))
        for r in parsed.refs:
            refs.append((b.uid, page_id(r.title), r.kind))
        counts["block_ref"] += len(parsed.block_refs)
        counts["embed"] += parsed.embeds
        for i, child in enumerate(b.children):
            walk(child, pid, b.uid, i)

    for p in export.pages:
        pid = page_ids[p.title]
        for i, child in enumerate(p.children):
            walk(child, pid, None, i)

    return Rows(pages=pages, blocks=blocks, refs=refs,
                implicit_page_count=len(pages) - explicit,
                block_ref_count=counts["block_ref"],
                embed_count=counts["embed"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_rows.py -v`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/ && git commit -m "feat: flatten export tree to sql rows with derived refs"
```

---

### Task 7: SQLite schema (DDL + FTS5 + triggers)

**Files:**
- Create: `server/src/pkm/schema.py`, `server/tests/test_schema.py`

**Interfaces:**
- Produces: `pkm.schema.DDL: str` — full `executescript`-able DDL. Task 9 and every later plan consume it. Table shapes are fixed by the spec (Section 1) and Task 6's row tuples.

- [ ] **Step 1: Write the failing test**

`server/tests/test_schema.py`:
```python
import sqlite3

import pytest

from pkm.schema import DDL


@pytest.fixture()
def db():
    con = sqlite3.connect(":memory:")
    con.executescript(DDL)
    yield con
    con.close()


def test_tables_exist(db):
    names = {r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    assert {"pages", "blocks", "refs", "assets",
            "blocks_fts", "pages_fts"} <= names


def test_fts_triggers_track_blocks(db):
    db.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    db.execute("INSERT INTO blocks VALUES ('u1', 1, NULL, 0,"
               " 'hello attention world', NULL, 0, NULL, NULL)")
    hit = db.execute("SELECT rowid FROM blocks_fts WHERE blocks_fts"
                     " MATCH 'attention'").fetchall()
    assert len(hit) == 1
    db.execute("UPDATE blocks SET text = 'goodbye' WHERE uid = 'u1'")
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH 'attention'").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH 'goodbye'").fetchone()[0] == 1
    db.execute("DELETE FROM blocks WHERE uid = 'u1'")
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH 'goodbye'").fetchone()[0] == 0


def test_pages_fts_tracks_titles(db):
    db.execute("INSERT INTO pages VALUES (1, 'Machine Learning', NULL, NULL)")
    assert db.execute("SELECT count(*) FROM pages_fts WHERE pages_fts"
                      " MATCH 'machine'").fetchone()[0] == 1


def test_refs_kind_constraint(db):
    db.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    db.execute("INSERT INTO blocks VALUES ('u1', 1, NULL, 0, 'x',"
               " NULL, 0, NULL, NULL)")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO refs VALUES ('u1', 1, 'bogus')")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_schema.py -v`
Expected: FAIL — `ModuleNotFoundError` (no `pkm.schema`)

- [ ] **Step 3: Implement `schema.py`**

`server/src/pkm/schema.py`:
```python
# pattern: Functional Core
"""SQLite DDL for the PKM database. Executescript-able; owns all tables,
FTS5 indexes, and the triggers that keep FTS in sync with base tables."""

DDL = """
CREATE TABLE pages(
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL UNIQUE,
  created_at  INTEGER,
  updated_at  INTEGER
);

CREATE TABLE blocks(
  uid         TEXT PRIMARY KEY,
  page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_uid  TEXT REFERENCES blocks(uid) ON DELETE CASCADE,
  order_idx   INTEGER NOT NULL,
  text        TEXT NOT NULL,
  heading     INTEGER,
  collapsed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER,
  updated_at  INTEGER
);
CREATE INDEX idx_blocks_page ON blocks(page_id);
CREATE INDEX idx_blocks_parent ON blocks(parent_uid);

CREATE TABLE refs(
  src_block_uid  TEXT NOT NULL REFERENCES blocks(uid) ON DELETE CASCADE,
  target_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK(kind IN ('link','tag','attribute')),
  PRIMARY KEY (src_block_uid, target_page_id, kind)
) WITHOUT ROWID;
CREATE INDEX idx_refs_target ON refs(target_page_id);

CREATE TABLE assets(
  sha256      TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER
);

CREATE VIRTUAL TABLE blocks_fts USING fts5(text, content='blocks');
CREATE TRIGGER blocks_fts_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER blocks_fts_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER blocks_fts_au AFTER UPDATE OF text ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE pages_fts USING fts5(title, content='pages', content_rowid='id');
CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER pages_fts_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title)
  VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER pages_fts_au AFTER UPDATE OF title ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title)
  VALUES ('delete', old.id, old.title);
  INSERT INTO pages_fts(rowid, title) VALUES (new.id, new.title);
END;
"""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_schema.py -v`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/ && git commit -m "feat: sqlite schema with fts5 and sync triggers"
```

---

### Task 8: Import report

**Files:**
- Create: `server/src/pkm/importer/report.py`, extend `server/tests/test_rows.py`? No — Create: `server/tests/test_report.py`

**Interfaces:**
- Consumes: `CONSUMED_ATTRS` (Task 4).
- Produces (Task 9 consumes):
  - `ImportReport(pages: int, implicit_pages: int, blocks: int, refs: int, orphan_blocks: int, skipped_entities: int, block_ref_count: int, embed_count: int, assets_total: int, assets_used: int, missing_asset_urls: tuple[str, ...], attr_counts: dict[str, int])`
  - `render(report: ImportReport) -> str` — human-readable text; lists every
    non-consumed attribute with its count under "ignored attributes"; lists
    every missing asset URL. Nothing silently dropped.

- [ ] **Step 1: Write the failing test**

`server/tests/test_report.py`:
```python
from pkm.importer.report import ImportReport, render

REPORT = ImportReport(
    pages=8, implicit_pages=5, blocks=7, refs=9,
    orphan_blocks=1, skipped_entities=2,
    block_ref_count=1, embed_count=0,
    assets_total=2, assets_used=1,
    missing_asset_urls=("https://firebasestorage.googleapis.com/x/gone.png",),
    attr_counts={":node/title": 2, ":block/string": 7, ":block/refs": 4,
                 ":children/view-type": 1},
)


def test_render_headline_numbers():
    text = render(REPORT)
    assert "pages: 8 (5 implicit)" in text
    assert "blocks: 7" in text
    assert "block refs ((...)): 1" in text
    assert "embeds: 0" in text


def test_render_lists_ignored_attrs_and_missing_assets():
    text = render(REPORT)
    assert ":block/refs (4)" in text
    assert ":children/view-type (1)" in text
    assert ":node/title" not in text.split("ignored attributes")[1].split("missing")[0]
    assert "gone.png" in text


def test_render_all_clear_sections():
    clean = ImportReport(pages=1, implicit_pages=0, blocks=1, refs=0,
                         orphan_blocks=0, skipped_entities=0,
                         block_ref_count=0, embed_count=0,
                         assets_total=0, assets_used=0,
                         missing_asset_urls=(), attr_counts={":node/title": 1})
    text = render(clean)
    assert "missing asset urls: none" in text
    assert "ignored attributes: none" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_report.py -v`
Expected: FAIL — `ModuleNotFoundError` (no `pkm.importer.report`)

- [ ] **Step 3: Implement `report.py`**

`server/src/pkm/importer/report.py`:
```python
# pattern: Functional Core
"""Import report: everything the importer saw, kept, ignored, or missed."""
from __future__ import annotations

from dataclasses import dataclass

from pkm.importer.parse_export import CONSUMED_ATTRS


@dataclass(frozen=True)
class ImportReport:
    pages: int
    implicit_pages: int
    blocks: int
    refs: int
    orphan_blocks: int
    skipped_entities: int
    block_ref_count: int
    embed_count: int
    assets_total: int
    assets_used: int
    missing_asset_urls: tuple[str, ...]
    attr_counts: dict[str, int]


def render(r: ImportReport) -> str:
    ignored = {a: n for a, n in sorted(r.attr_counts.items())
               if a not in CONSUMED_ATTRS}
    lines = [
        "== import report ==",
        f"pages: {r.pages} ({r.implicit_pages} implicit)",
        f"blocks: {r.blocks}",
        f"refs: {r.refs}",
        f"orphan blocks (unreachable, not imported): {r.orphan_blocks}",
        f"skipped entities (no uid/string): {r.skipped_entities}",
        f"block refs ((...)): {r.block_ref_count}",
        f"embeds: {r.embed_count}",
        f"assets: {r.assets_total} in store, {r.assets_used} referenced",
    ]
    if ignored:
        lines.append("ignored attributes:")
        lines += [f"  {a} ({n})" for a, n in ignored.items()]
    else:
        lines.append("ignored attributes: none")
    if r.missing_asset_urls:
        lines.append("missing asset urls:")
        lines += [f"  {u}" for u in sorted(r.missing_asset_urls)]
    else:
        lines.append("missing asset urls: none")
    return "\n".join(lines) + "\n"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_report.py -v`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/ && git commit -m "feat: import report rendering"
```

---

### Task 9: Importer CLI (imperative shell) + end-to-end fixture test

**Files:**
- Create: `server/src/pkm/importer/run.py`, `server/tests/fixtures/sample_export.edn`, `server/tests/test_importer_e2e.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `python -m pkm.importer.run EXPORT.edn --files DIR --out DATA_DIR`
  → writes `DATA_DIR/pkm.sqlite3` (atomic swap), `DATA_DIR/assets/<sha[:2]>/<sha>`,
  `DATA_DIR/import-report.txt`; prints the report. `main(argv) -> int` for tests.

- [ ] **Step 1: Write the fixture EDN**

`server/tests/fixtures/sample_export.edn`:
```edn
#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}, :block/refs {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Machine Learning" 536870913]
  [1 :create/time 1600000000000 536870913]
  [1 :edit/time 1600000001000 536870913]
  [1 :block/children 2 536870913]
  [1 :block/children 3 536870913]
  [2 :block/uid "uid-tags1x" 536870913]
  [2 :block/string "Tags:: #AI #[[Generative Models]]" 536870913]
  [2 :block/order 0 536870913]
  [3 :block/uid "uid-head1x" 536870913]
  [3 :block/string "Papers" 536870913]
  [3 :block/order 1 536870913]
  [3 :block/heading 2 536870913]
  [3 :block/open false 536870913]
  [3 :block/children 4 536870913]
  [3 :block/children 5 536870913]
  [3 :block/children 6 536870913]
  [4 :block/uid "uid-link1x" 536870913]
  [4 :block/string "[[Attention Is All You Need]] ![fig](https://firebasestorage.googleapis.com/v0/b/firescript-577a2.appspot.com/o/imgs%2Fapp%2Fgraph%2Fpaper-fig.png?alt=media&token=abc-123)" 536870913]
  [4 :block/order 0 536870913]
  [5 :block/uid "uid-query1" 536870913]
  [5 :block/string "{{[[query]]: {and: [[Machine Learning]] [[Paper]]}}}" 536870913]
  [5 :block/order 1 536870913]
  [6 :block/uid "uid-code1x" 536870913]
  [6 :block/string "```python\nprint(\"[[not a link]]\")\n```" 536870913]
  [6 :block/order 2 536870913]
  [7 :node/title "July 8th, 2026" 536870913]
  [7 :block/children 8 536870913]
  [7 :block/children 9 536870913]
  [8 :block/uid "uid-bref1x" 536870913]
  [8 :block/string "Read ((uid-link1x)) later" 536870913]
  [8 :block/order 0 536870913]
  [9 :block/uid "uid-see1xx" 536870913]
  [9 :block/string "See [[Machine Learning]]" 536870913]
  [9 :block/order 1 536870913]
  [10 :block/uid "uid-orphan" 536870913]
  [10 :block/string "unreachable block" 536870913]
  [2 :block/refs 1 536870913]
 ]}
```

- [ ] **Step 2: Write the failing end-to-end test**

`server/tests/test_importer_e2e.py`:
```python
import hashlib
import sqlite3
from pathlib import Path

from pkm.importer.run import main

FIXTURE = Path(__file__).parent / "fixtures" / "sample_export.edn"


def _setup_files(tmp_path: Path) -> Path:
    files = tmp_path / "files"
    files.mkdir()
    (files / "paper-fig.png").write_bytes(b"PNGDATA")
    (files / "unused.pdf").write_bytes(b"PDFDATA")
    return files


def test_end_to_end_import(tmp_path):
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    rc = main([str(FIXTURE), "--files", str(files), "--out", str(out)])
    assert rc == 0

    con = sqlite3.connect(out / "pkm.sqlite3")
    titles = {r[0] for r in con.execute("SELECT title FROM pages")}
    assert titles == {"Machine Learning", "July 8th, 2026", "Tags", "AI",
                      "Generative Models", "Attention Is All You Need",
                      "query", "Paper"}
    assert con.execute("SELECT count(*) FROM blocks").fetchone()[0] == 7

    # asset url rewritten to content-addressed path
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    text = con.execute("SELECT text FROM blocks WHERE uid='uid-link1x'").fetchone()[0]
    assert f"/assets/{sha}/paper-fig.png" in text
    assert "firebasestorage" not in text
    assert (out / "assets" / sha[:2] / sha).read_bytes() == b"PNGDATA"

    # assets table has both files; fts works; refs derived
    assert con.execute("SELECT count(*) FROM assets").fetchone()[0] == 2
    assert con.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                       " MATCH 'Attention'").fetchone()[0] == 1
    kinds = dict(con.execute(
        "SELECT kind, count(*) FROM refs GROUP BY kind").fetchall())
    assert kinds["attribute"] == 1
    assert kinds["tag"] == 2

    report = (out / "import-report.txt").read_text()
    assert "block refs ((...)): 1" in report
    assert ":block/refs (1)" in report
    assert "missing asset urls: none" in report


def test_rerun_replaces_database(tmp_path):
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0
    con = sqlite3.connect(out / "pkm.sqlite3")
    con.execute("INSERT INTO pages VALUES (999, 'Scribble', NULL, NULL)")
    con.commit()
    con.close()
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0
    con = sqlite3.connect(out / "pkm.sqlite3")
    assert con.execute("SELECT count(*) FROM pages WHERE title='Scribble'"
                       ).fetchone()[0] == 0
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_importer_e2e.py -v`
Expected: FAIL — `ModuleNotFoundError` (no `pkm.importer.run`)

- [ ] **Step 4: Implement `run.py`**

`server/src/pkm/importer/run.py`:
```python
# pattern: Imperative Shell
"""Importer CLI: EDN export + files dir -> data dir (sqlite + assets + report)."""
from __future__ import annotations

import argparse
import hashlib
import mimetypes
import os
import shutil
import sqlite3
import sys
from pathlib import Path

from pkm.edn import parse_edn
from pkm.importer.assets import Asset, rewrite_asset_urls
from pkm.importer.parse_export import parse_export
from pkm.importer.report import ImportReport, render
from pkm.importer.rows import to_rows
from pkm.schema import DDL


def _index_files(files_dir: Path) -> tuple[dict[str, Asset], dict[str, Path]]:
    by_name: dict[str, Asset] = {}
    paths: dict[str, Path] = {}
    for path in sorted(p for p in files_dir.rglob("*") if p.is_file()):
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        by_name[path.name.lower()] = Asset(sha, path.name, mime, len(data))
        paths[sha] = path
    return by_name, paths


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import a Roam EDN export.")
    parser.add_argument("export", help="path to the .edn export file")
    parser.add_argument("--files", help="path to the linked-files download dir")
    parser.add_argument("--out", default="data", help="output data directory")
    args = parser.parse_args(argv)

    sys.setrecursionlimit(20000)  # deep outlines recurse in tree assembly
    export = parse_export(parse_edn(Path(args.export).read_text(encoding="utf-8")))

    by_name, paths = _index_files(Path(args.files)) if args.files else ({}, {})
    used: set[str] = set()
    missing: set[str] = set()

    def transform(text: str) -> str:
        new, u, m = rewrite_asset_urls(text, by_name)
        used.update(u)
        missing.update(m)
        return new

    rows = to_rows(export, transform)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "pkm.sqlite3.tmp"
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    try:
        con.executescript(DDL)
        con.executemany("INSERT INTO pages VALUES (?,?,?,?)", rows.pages)
        con.executemany("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)",
                        rows.blocks)
        con.executemany("INSERT INTO refs VALUES (?,?,?)", rows.refs)
        con.executemany(
            "INSERT INTO assets VALUES (?,?,?,?,NULL)",
            [(a.sha256, a.filename, a.mime, a.size) for a in by_name.values()])
        con.commit()
    finally:
        con.close()
    os.replace(tmp, out / "pkm.sqlite3")

    for sha, src in paths.items():
        dest = out / "assets" / sha[:2] / sha
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)

    report = ImportReport(
        pages=len(rows.pages),
        implicit_pages=rows.implicit_page_count,
        blocks=len(rows.blocks),
        refs=len(rows.refs),
        orphan_blocks=export.orphan_block_count,
        skipped_entities=export.skipped_entities,
        block_ref_count=rows.block_ref_count,
        embed_count=rows.embed_count,
        assets_total=len(by_name),
        assets_used=len(used),
        missing_asset_urls=tuple(sorted(missing)),
        attr_counts=export.attr_counts,
    )
    text = render(report)
    (out / "import-report.txt").write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Run the full suite**

Run: `cd server && uv run pytest -v`
Expected: all tests PASS (smoke, refs, edn, parse_export, assets, rows, schema, report, e2e ×2)

- [ ] **Step 6: Commit**

```bash
git add server/ && git commit -m "feat: importer cli with atomic swap and e2e test"
```

---

### Task 10: Run against the real export (verification)

**Blocked on:** user placing the real EDN export and linked-files download in `sample-data/` (e.g. `sample-data/graph.edn`, `sample-data/files/`). If absent, stop and ask.

- [ ] **Step 1: Run the importer, timed**

Run: `cd server && time uv run python -m pkm.importer.run ../sample-data/graph.edn --files ../sample-data/files --out ../data`
(adjust filenames to whatever the user provided)
Expected: exit 0, report printed. If runtime > 2 minutes, note it — optimize the EDN string-scanning hot path only then.

- [ ] **Step 2: Review the report with the user**

Read `data/import-report.txt`. Specifically surface to the user:
- orphan/skipped counts (should be small; investigate if > 1% of blocks)
- the **block ref and embed counts** — these decide whether `((block-ref))`
  rendering enters plan 3's scope (spec open item)
- ignored attributes list — confirm none of them look load-bearing
  (anything named like `:block/props` with a large count deserves a look
  at sample values before dismissing)
- missing asset URLs — spot-check a few in Roam to see what they are

- [ ] **Step 3: Sanity-check real data**

Run: `sqlite3 ../data/pkm.sqlite3 "SELECT count(*) FROM pages; SELECT count(*) FROM blocks; SELECT title FROM pages ORDER BY random() LIMIT 10;"`
Then pick one familiar page and verify its block tree:
`sqlite3 ../data/pkm.sqlite3 "SELECT b.order_idx, substr(b.text,1,60) FROM blocks b JOIN pages p ON p.id=b.page_id WHERE p.title='<a page the user knows>' AND b.parent_uid IS NULL ORDER BY b.order_idx;"`
Compare against the same page in Roam.

- [ ] **Step 4: Record findings**

Update the spec's "Open items" section with the block-ref/embed verdict and
any real-export quirks discovered. Commit the spec update:
```bash
git add docs/ && git commit -m "docs: record real-export import findings"
```

---

## Self-review notes (completed)

- **Spec coverage (plan-1 scope):** data model ✓ (Task 7), uid preservation ✓ (Tasks 4/6), asset store + URL rewrite ✓ (Tasks 5/9), fresh-build + atomic swap ✓ (Task 9), report with nothing-silently-dropped ✓ (Tasks 8/9/10), shared ref-grammar fixture ✓ (Task 2), daily-title preservation ✓ (importer never touches titles; fixture includes an ordinal daily page). Backend/frontend/deployment are later plans by design.
- **Type consistency:** `extract`/`ParsedRefs` (T2) used in T6; `Export`/`Block`/`Page` (T4) used in T6/T9; `Asset`/`rewrite_asset_urls` (T5) used in T9; `Rows` (T6) used in T9; `DDL` (T7) used in T9; `ImportReport`/`render` (T8) used in T9 — names and shapes match.
- **Placeholder scan:** no TBDs; every code step contains complete code.
