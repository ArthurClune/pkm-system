"""Every route and CLI verb that takes a title resolves a variant spelling of
a title to the same page as the title itself.

A variant is what the documented canonicalisation folds onto the title:
control whitespace widened into the plain-space gaps and padding the
edges always (`normalize_title`), and plain-space padding too while the
plain-space flag is on (`canonicalize_title(..., plain_space=True)`). The
generator builds each variant from that rule, not from the code under
test, and the check is differential: a read answers the variant exactly
as it answers the title, and a write leaves the same database behind.

The routes come from the app's OpenAPI document and the verbs from the CLI
parser, so a new title-taking route or verb fails
`test_every_title_input_is_covered` until it is added here."""
import asyncio
import io
import json
import shutil
import sys
import tempfile
from collections.abc import Callable, Iterator
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI
from conftest import TEST_PASSWORD, make_config, seed_db
from fastapi.testclient import TestClient
from hypothesis import currently_in_test_context, given, settings
from hypothesis import event as _event
from hypothesis import strategies as st

from pkm.batch import title_flag_needed
from pkm.cli.main import build_parser, main
from pkm.client.api import PkmClient
from pkm.client.core import CliConfig
from pkm.contracts.daily import title_for_date
from pkm.database import connect
from pkm.refs import canonicalize_title, title_syntax_reason
from pkm.server.app import create_app
from pkm.server.config import Config
from pkm.server.db import open_db
from pkm.server.sync_meta import set_plain_space_title_canonicalization

EXAMPLES = 60
# Each CLI example runs every verb twice through argparse and the client.
CLI_EXAMPLES = 30
CONTROL = "\t\n\r\f\v"
SEEDED_DAILY = "July 7th, 2026"


def event(label: str) -> None:
    if currently_in_test_context():
        _event(label)


# Words never hold whitespace, `#` or a backtick; brackets come singly and
# the syntax filter drops the spellings that pair or trail. A literal `%`
# is drawn on purpose: the HTTP property sends single-decoded paths.
_WORD = st.text(
    alphabet=st.sampled_from(list("abcXYZ019éß✨😀%/?&+.-'():;,=[]")),
    min_size=1, max_size=5)
_GAP = st.sampled_from([" ", " ", " ", "\xa0"])


@st.composite
def tidy_titles(draw: st.DrawFn) -> str:
    """A title every variant can reach: words joined by one plain space or
    NBSP, so no edge or run of whitespace for canonicalisation to remove."""
    if draw(st.integers(0, 9)) == 0:
        return draw(st.sampled_from([title_for_date(date.today()),
                                     SEEDED_DAILY]))
    words = draw(st.lists(_WORD, min_size=1, max_size=4))
    gaps = [draw(_GAP) for _ in words[1:]]
    text = words[0] + "".join(g + w for g, w in zip(gaps, words[1:]))
    if title_syntax_reason(text) is not None:
        text = " ".join("".join(c for c in w if c not in "[]") or "x" for w in words)
    # A title with a `.`, `..` or empty `/` segment has no URL, so every
    # route refuses it; drawn on purpose as well as by chance.
    if draw(st.integers(0, 5)) == 0:
        text = draw(st.sampled_from([
            "/" + text, text + "/", text + "//x", text + "/./x", text + "/../x",
            ".", ".."]))
    return text


_RUN = st.text(alphabet=st.sampled_from(list(" " + CONTROL)), min_size=1, max_size=3)
_EDGE = st.text(alphabet=st.sampled_from(list(" " + CONTROL)), max_size=3)


@st.composite
def control_variant(draw: st.DrawFn, canonical: str) -> str:
    """`title` with each plain-space gap widened into a whitespace run and
    whitespace on both edges, holding at least one control character."""
    words = canonical.split(" ")
    out = draw(_EDGE) + words[0]
    for w in words[1:]:
        out += draw(_RUN) + w
    out += draw(_EDGE)
    return out if any(c in out for c in CONTROL) else out + draw(st.sampled_from(list(CONTROL)))


@st.composite
def variant_of(draw: st.DrawFn, canonical: str, kind: str, active: bool) -> str:
    """A `kind` spelling of `title` that folds onto it."""
    pad = st.integers(0, 3)
    if kind == "identity":
        variant = canonical
    elif kind == "control":
        variant = draw(control_variant(canonical))
    elif kind == "padded":
        lead, trail = draw(pad), draw(pad)
        variant = " " * lead + canonical + " " * max(trail, 1 - lead)
    else:
        variant = " " * draw(pad) + draw(control_variant(canonical)) + " " * draw(pad)
    # The generator's own check, not an oracle for the routes.
    assert canonicalize_title(variant, plain_space=active) == canonical
    return variant


@st.composite
def cases(draw: st.DrawFn) -> tuple[bool, str, str, str]:
    """(plain-space flag, title, a variant of it, the variant's kind).
    Plain-space padding folds only under the flag, so a padded kind draws
    it on; the others draw it either way."""
    kind = draw(st.sampled_from(["identity", "control", "padded", "padded_control"]))
    active = kind.startswith("padded") or draw(st.booleans())
    canonical = draw(tidy_titles())
    return active, canonical, draw(variant_of(canonical, kind, active)), kind


def label(active: bool, canonical: str, variant: str, kind: str) -> None:
    event(f"flag {'active' if active else 'inactive'}, {kind} variant")
    if canonical in (title_for_date(date.today()), SEEDED_DAILY):
        event("daily title")
    if "\n" in variant.strip(" \t\r\f\v\n")[1:-1]:
        event("newline inside the variant")
    if "%" in canonical:
        event("percent in title")
    if "/" in canonical:
        event("slash in title")
    if "\xa0" in canonical:
        event("NBSP gap in title")


# --- the graph each example starts from --------------------------------------

def _seed_ops(canonical: str) -> list[dict[str, Any]]:
    """`title` with a TODO and a child, linked from AI and mentioned in
    plain text on Paper (unlinked references), on the conftest seed."""
    return [
        {"op": "create_page", "page_title": canonical},
        {"op": "create", "uid": "seed_todo1", "page_title": canonical, "parent_uid": None,
         "order_idx": 900, "text": "{{TODO}} on the page"},
        {"op": "create", "uid": "seed_kid01", "page_title": canonical, "parent_uid": "seed_todo1",
         "order_idx": 0, "text": "a child"},
        {"op": "create", "uid": "seed_link1", "page_title": "AI", "parent_uid": None,
         "order_idx": 900, "text": f"see [[{canonical}]]"},
        {"op": "create", "uid": "seed_ment1", "page_title": "Paper", "parent_uid": None,
         "order_idx": 900, "text": f"mentions {canonical} in plain text"},
    ]


class Rig:
    """One app; each example points it at a fresh database copy."""

    def __init__(self, app: FastAPI, config: Config, cookie: str, root: Path) -> None:
        self.app, self.config, self.cookie, self.root = app, config, cookie, root

    def fresh(self, source: Path) -> Path:
        dest = Path(tempfile.mkdtemp(dir=self.root)) / "pkm.sqlite3"
        shutil.copyfile(source, dest)
        return dest

    def use(self, db_path: Path) -> None:
        self.app.state.config = replace(self.config, db_path=db_path)

    def request(self, db_path: Path, method: str, url: str,
                body: object = None) -> httpx.Response:
        """One request through the ASGI app, decoding the path once as
        uvicorn does (TestClient decodes it twice)."""
        self.use(db_path)

        async def go() -> httpx.Response:
            transport = httpx.ASGITransport(app=self.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver",
                                         cookies={"pkm_session": self.cookie}) as c:
                return await c.request(method, url, json=body)
        return asyncio.run(go())

    def seeded(self, active: bool, canonical: str) -> Path:
        """A fresh database under the flag, seeded with `canonical`'s page;
        a refused title's seed batch is refused whole, leaving the
        conftest graph."""
        db_path = self.fresh(self.config.db_path)
        con = open_db(db_path)
        set_plain_space_title_canonicalization(con, active)
        con.commit()
        con.close()
        r = self.request(db_path, "POST", "/api/ops", {
            "client_id": "props", "batch_id": "seed_batch01", "ops": _seed_ops(canonical)})
        refused = title_syntax_reason(canonical) is not None
        assert r.status_code == (400 if refused else 200), r.text
        con = open_db(db_path)
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        con.close()
        return db_path


@pytest.fixture(scope="module")
def rig(tmp_path_factory) -> Iterator[Rig]:
    root = tmp_path_factory.mktemp("titleroutes")
    config = make_config(root)
    seed_db(config.db_path)
    app = create_app(config)
    login = TestClient(app).post("/api/login", json={"password": TEST_PASSWORD})
    assert login.status_code == 200
    yield Rig(app=app, config=config, cookie=login.cookies["pkm_session"], root=root)


_KNOWN_UID = ("uid_", "seed_", "probe_")


def state(db_path: Path) -> dict[str, list[tuple]]:
    """Everything a title decides, without the clock's columns. A uid the
    server minted (a conflict note's) is random, so it is renamed by its
    block's place."""
    con = connect(db_path, read_only=True)
    try:
        blocks = con.select(
            "SELECT uid, page_id, parent_uid, order_idx, text FROM blocks"
            " ORDER BY page_id, order_idx, text")
        refs = con.select(
            "SELECT src_block_uid, target_page_id, kind AS ref_kind FROM refs")
        pages = con.select("SELECT id AS page_id, title FROM pages ORDER BY id")
        sidebar = con.select(
            "SELECT id AS sidebar_entry_id, title, order_idx AS sidebar_order_idx"
            " FROM sidebar_entries ORDER BY id")
    finally:
        con.close()
    minted = [b["uid"] for b in blocks if not b["uid"].startswith(_KNOWN_UID)]
    alias: dict[str, str] = {u: f"minted{i}" for i, u in enumerate(minted)}

    def stable(u: str | None) -> str | None:
        return alias.get(u, u) if u is not None else None
    return {
        "pages": [tuple(r.values()) for r in pages],
        "blocks": sorted((stable(b["uid"]), b["page_id"], stable(b["parent_uid"]),
                          b["order_idx"], b["text"]) for b in blocks),
        "refs": sorted((stable(r["src_block_uid"]), r["target_page_id"], r["ref_kind"])
                       for r in refs),
        "sidebar": [tuple(r.values()) for r in sidebar],
    }


# /api/changed echoes its window, whose `until` is the request's clock, and
# an ops ack its server time.
_CLOCK_KEYS = {"created_at", "updated_at", "until", "ts"}


def unclocked(value: object) -> object:
    if isinstance(value, dict):
        return {k: unclocked(v) for k, v in value.items() if k not in _CLOCK_KEYS}
    if isinstance(value, list):
        return [unclocked(v) for v in value]
    return value


def outcome(r: httpx.Response) -> tuple[int, object]:
    try:
        body: object = unclocked(r.json())
    except ValueError:
        body = r.text
    return r.status_code, body


def path_title(text: str) -> str:
    return quote(text, safe="/")


# --- the routes ---------------------------------------------------------------
# Each takes a title spelling and returns (method, url, body). Reads are
# compared on one database; writes on two copies, by response and state.

Request = Callable[[str], tuple[str, str, object]]


def _ops(x: str) -> tuple[str, str, object]:
    return "POST", "/api/ops", {"client_id": "props", "batch_id": "probe_batch1", "ops": [
        {"op": "create_page", "page_title": x},
        {"op": "create", "uid": "probe_new1", "page_title": x, "parent_uid": None,
         "order_idx": 950, "text": "added"},
        {"op": "move", "uid": "seed_ment1", "page_title": x, "parent_uid": None,
         "order_idx": 960},
        {"op": "update_text", "uid": "gone_blk01", "text": "edited", "page_title": x},
    ]}


READS: dict[tuple[str, str, str], Request] = {
    ("GET", "/api/page/{title}", "title"):
        lambda x: ("GET", f"/api/page/{path_title(x)}", None),
    ("GET", "/api/export/page/{title}", "title"):
        lambda x: ("GET", f"/api/export/page/{path_title(x)}", None),
    ("GET", "/api/delete-preview", "title"):
        lambda x: ("GET", f"/api/delete-preview?title={quote(x, safe='')}", None),
    ("GET", "/api/unlinked", "title"):
        lambda x: ("GET", f"/api/unlinked?title={quote(x, safe='')}", None),
    ("GET", "/api/todos", "page"):
        lambda x: ("GET", f"/api/todos?page={quote(x, safe='')}", None),
    ("GET", "/api/changed", "page"):
        lambda x: ("GET", f"/api/changed?since=2000-01-01&page={quote(x, safe='')}", None),
    ("GET", "/api/query", "expr"):
        lambda x: ("GET", f"/api/query?expr={quote(f'{{and: [[{x}]]}}', safe='')}", None),
}

WRITES: dict[tuple[str, str, str], Request] = {
    ("DELETE", "/api/page/{title}", "title"):
        lambda x: ("DELETE", f"/api/page/{path_title(x)}", None),
    ("POST", "/api/pages", "CreatePageRequest.title"):
        lambda x: ("POST", "/api/pages", {"title": x}),
    ("POST", "/api/sidebar", "AddSidebarEntryRequest.title"):
        lambda x: ("POST", "/api/sidebar", {"title": x}),
    ("POST", "/api/ops", "CreatePageOp.page_title"): _ops,
    ("POST", "/api/ops", "CreateOp.page_title"): _ops,
    ("POST", "/api/ops", "MoveOp.page_title"): _ops,
    ("POST", "/api/ops", "UpdateTextOp.page_title"): _ops,
}

# The rename takes two titles, so it pairs a variant of each.
RENAME = {("POST", "/api/page/{title}/rename", "title"),
          ("POST", "/api/page/{title}/rename", "RenamePageRequest.new_title")}


def title_inputs(openapi: dict[str, Any]) -> set[tuple[str, str, str]]:
    """(method, path, field) for every parameter or request-body field the
    API names as a title or page, read off the OpenAPI document."""
    schemas = openapi["components"]["schemas"]

    def fields(ref: str, seen: frozenset[str] = frozenset()) -> Iterator[str]:
        name = ref.rsplit("/", 1)[-1]
        if name in seen:
            return
        schema = schemas[name]
        for sub in schema.get("anyOf", []) + schema.get("oneOf", []):
            if "$ref" in sub:
                yield from fields(sub["$ref"], seen | {name})
        for prop, spec in schema.get("properties", {}).items():
            yield f"{name}.{prop}"
            items = spec.get("items", {})
            for nested in [spec, items, *spec.get("anyOf", []),
                           *items.get("anyOf", []), *items.get("oneOf", [])]:
                if "$ref" in nested:
                    yield from fields(nested["$ref"], seen | {name})

    out: set[tuple[str, str, str]] = set()
    for path, operations in openapi["paths"].items():
        for method, op in operations.items():
            names = [p["name"] for p in op.get("parameters", [])]
            for content in op.get("requestBody", {}).get("content", {}).values():
                if "$ref" in content.get("schema", {}):
                    names += fields(content["schema"]["$ref"])
            for name in names:
                leaf = name.rsplit(".", 1)[-1]
                if "title" in leaf or leaf in ("page", "expr"):
                    out.add((method.upper(), path, name))
    return out


def test_every_title_input_is_covered(rig):
    found = title_inputs(rig.app.openapi())
    assert found == set(READS) | set(WRITES) | RENAME


def _differs(rig: Rig, base: Path, request: Request, variant: str, canonical: str) -> None:
    v_db, t_db = rig.fresh(base), rig.fresh(base)
    method, url, body = request(variant)
    got = outcome(rig.request(v_db, method, url, body))
    method, url, body = request(canonical)
    want = outcome(rig.request(t_db, method, url, body))
    assert got == want, url
    assert state(v_db) == state(t_db), url


def _refuses(rig: Rig, base: Path, request: Request, spelling: str) -> None:
    """A refused title reaches no page: no 500, and nothing written. A URL
    client drops a path's dot segments before the server sees them, so the
    path routes are held to that alone."""
    db = rig.fresh(base)
    method, url, body = request(spelling)
    status = rig.request(db, method, url, body).status_code
    assert status < 500, (url, status)
    if method != "GET":
        assert status >= 400, (url, status)
    assert state(db) == state(base), url


@settings(max_examples=EXAMPLES, deadline=None)
@given(cases(), st.data())
def test_a_variant_reaches_the_titles_page_through_every_route(rig, case, data):
    active, canonical, variant, kind = case
    label(*case)
    base = rig.seeded(active, canonical)
    if title_syntax_reason(canonical) is not None:
        event("refused title")
        for request in [*READS.values(), *dict.fromkeys(WRITES.values()),
                        lambda x: ("POST", f"/api/page/{path_title(x)}/rename",
                                   {"new_title": "Renamed", "allow_merge": False})]:
            _refuses(rig, base, request, variant)
            _refuses(rig, base, request, canonical)
        return
    for key, request in READS.items():
        method, url, body = request(variant)
        got = outcome(rig.request(base, method, url, body))
        method, url, body = request(canonical)
        want = outcome(rig.request(base, method, url, body))
        assert got == want, key
        assert want[0] == 200, (key, url, want)
    for request in dict.fromkeys(WRITES.values()):
        _differs(rig, base, request, variant, canonical)
    new_canonical = "Renamed " + canonical
    new_variant = data.draw(variant_of(new_canonical, kind, active))

    def rename(spellings: tuple[str, str]) -> tuple[str, str, object]:
        old, new = spellings
        return ("POST", f"/api/page/{path_title(old)}/rename",
                {"new_title": new, "allow_merge": False})
    v_db, t_db = rig.fresh(base), rig.fresh(base)
    got = outcome(rig.request(v_db, *rename((variant, new_variant))))
    want = outcome(rig.request(t_db, *rename((canonical, new_canonical))))
    assert got == want
    assert state(v_db) == state(t_db)
    shutil.rmtree(base.parent, ignore_errors=True)


# --- the CLI ------------------------------------------------------------------

def cli_title_args() -> set[tuple[str, str]]:
    """(verb, dest) for every CLI argument that names a page."""
    out: set[tuple[str, str]] = set()
    sub = next(a for a in build_parser()._actions if a.dest == "command")
    for verb, parser in sub.choices.items():  # type: ignore[union-attr]
        for action in parser._actions:
            if action.dest in ("title", "new_title", "target", "page", "expr"):
                out.add((verb, action.dest))
    return out


def run_cli(rig: Rig, db_path: Path, argv: list[str], stdin: str = "") -> tuple[int, str]:
    """`pkm <argv>` against the app over `db_path`: (exit code, stdout)."""
    rig.use(db_path)
    http = TestClient(rig.app)
    client = PkmClient(CliConfig(url="http://testserver", token=rig.cookie), http=http)
    out, err = io.StringIO(), io.StringIO()
    saved_stdin = sys.stdin
    sys.stdin = io.StringIO(stdin)
    try:
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv, make_client=lambda: client)
    finally:
        sys.stdin = saved_stdin
    return code, out.getvalue()


# Each takes a title spelling and returns (argv, stdin). The JSON output
# is compared for reads; the text form echoes the caller's spelling. A
# title can start with `-`, so it rides after `--` or as `--page=`.
CliCall = Callable[[str], tuple[list[str], str]]

CLI_READS: dict[tuple[str, str], CliCall] = {
    ("get", "target"): lambda x: (["get", "--json", "--", x], ""),
    ("refs", "title"): lambda x: (["refs", "--json", "--", x], ""),
    ("todos", "page"): lambda x: (["todos", f"--page={x}", "--json"], ""),
    ("changed", "page"): lambda x: (["changed", "--since", "2000-01-01", f"--page={x}", "--json"], ""),
    ("query", "expr"): lambda x: (["query", "--json", "--", f"{{and: [[{x}]]}}"], ""),
}

CLI_WRITES: dict[tuple[str, str], CliCall] = {
    ("save", "page"): lambda x: (["save", f"--page={x}", "saved text"], ""),
    ("upload", "page"): lambda x: (["upload", f"--page={x}", str(UPLOAD)], ""),
    ("batch", "page"): lambda x: (["batch"], json.dumps([
        {"command": "create", "params": {"page": x, "text": "one"}},
        {"command": "todo", "params": {"page": x, "text": "two"}},
        {"command": "move", "params": {"uid": "seed_ment1", "page": x}},
    ])),
}

def _mixed_batch(spelling: str, canonical: str, new_spelling: str, new_canonical: str) -> str:
    return json.dumps([
        {"command": "create", "params": {"page": spelling, "text": "one"}},
        {"command": "create", "params": {"page": canonical, "text": "two"}},
        {"command": "todo", "params": {"page": spelling, "text": "three"}},
        {"command": "create", "params": {"page": new_spelling, "text": "four"}},
        {"command": "create", "params": {"page": new_canonical, "text": "five"}},
    ])


# The rename takes two titles, so it pairs a variant of each.
CLI_RENAME = {("rename", "title"), ("rename", "new_title")}
UPLOAD = Path(tempfile.mkdtemp(prefix="pkm-title-props-")) / "note.txt"
UPLOAD.write_text("an upload\n")


def test_every_cli_title_argument_is_covered():
    """`batch` reads its pages from stdin, so the parser cannot name it."""
    assert cli_title_args() == ({k for k in CLI_READS} | {k for k in CLI_WRITES}
                                | CLI_RENAME) - {("batch", "page")}


# A literal `%` is left out: the CLI's client here is a TestClient, which
# decodes a path's escapes twice.
@settings(max_examples=CLI_EXAMPLES, deadline=None)
@given(cases().filter(lambda c: "%" not in c[1]), st.data())
def test_a_variant_reaches_the_titles_page_through_every_cli_verb(rig, case, data):
    active, canonical, variant, kind = case
    label(*case)
    base = rig.seeded(active, canonical)
    if title_syntax_reason(canonical) is not None:
        event("refused title")
        calls = [*CLI_READS.values(), *CLI_WRITES.values(),
                 lambda x: (["rename", "--json", "--", x, "Renamed"], "")]
        for call in calls:
            for spelling in (variant, canonical):
                db = rig.fresh(base)
                run_cli(rig, db, *call(spelling))
                assert state(db) == state(base)
        return
    for key, call in CLI_READS.items():
        got = run_cli(rig, base, *call(variant))
        want = run_cli(rig, base, *call(canonical))
        assert want[0] == 0, key
        assert got[0] == want[0], key
        assert unclocked(json.loads(got[1])) == unclocked(json.loads(want[1])), key
    for key, call in CLI_WRITES.items():
        v_db, t_db = rig.fresh(base), rig.fresh(base)
        got = run_cli(rig, v_db, *call(variant))
        want = run_cli(rig, t_db, *call(canonical))
        assert got[0] == want[0], key
        assert state(v_db) == state(t_db), key
    new_canonical = "Renamed " + canonical
    new_variant = data.draw(variant_of(new_canonical, kind, active))
    # One batch naming a page by two spellings, one page existing and one
    # not yet: the planner fetches each spelling on its own.
    if title_flag_needed([new_variant, new_canonical]):
        event("batch spellings that only the flag can fold")
    v_db, t_db = rig.fresh(base), rig.fresh(base)
    got = run_cli(rig, v_db, ["batch"], _mixed_batch(variant, canonical, new_variant, new_canonical))
    want = run_cli(rig, t_db, ["batch"], _mixed_batch(canonical, canonical, new_canonical, new_canonical))
    assert got[0] == want[0]
    assert state(v_db) == state(t_db)
    v_db, t_db = rig.fresh(base), rig.fresh(base)
    got = run_cli(rig, v_db, ["rename", "--json", "--", variant, new_variant])
    want = run_cli(rig, t_db, ["rename", "--json", "--", canonical, new_canonical])
    assert got == want
    assert state(v_db) == state(t_db)
    shutil.rmtree(base.parent, ignore_errors=True)
