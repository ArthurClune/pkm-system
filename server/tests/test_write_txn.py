"""`write_txn` owns the write transaction of every route that advances the
journal; the structural checks below keep it the only way in, so no route
can take the lock after the read its decision rests on, forget the 503, or
await the event loop while it holds the lock."""
from __future__ import annotations

import ast
import re
import sqlite3
from pathlib import Path

import pytest
from fastapi import HTTPException

from pkm.database import connect
from pkm.server.db import open_db, write_txn
from rawread import read

SRC = Path(__file__).resolve().parents[1] / "src"
HELPER_FILE = "pkm/server/db.py"
HELPER = "write_txn"
LOCKING_SQL = re.compile(r"\s*BEGIN\s+(IMMEDIATE|EXCLUSIVE)\b", re.IGNORECASE)


def _is_helper_call(node: ast.expr) -> bool:
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    return ((isinstance(func, ast.Name) and func.id == HELPER)
            or (isinstance(func, ast.Attribute) and func.attr == HELPER))


def _walk_same_scope(nodes: list[ast.stmt]):
    """Every node under `nodes`, not descending into a nested function,
    lambda or class, whose body runs at another time."""
    stack: list[ast.AST] = list(nodes)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                             ast.Lambda, ast.ClassDef)):
            continue
        yield node
        stack.extend(ast.iter_child_nodes(node))


def _enclosing_functions(tree: ast.AST) -> dict[ast.AST, ast.AST | None]:
    owner: dict[ast.AST, ast.AST | None] = {}

    def visit(node: ast.AST, fn: ast.AST | None) -> None:
        for child in ast.iter_child_nodes(node):
            owner[child] = fn
            visit(child, child if isinstance(
                child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))
                else fn)

    visit(tree, None)
    return owner


def write_lock_problems(rel: str, source: str) -> list[str]:
    """Breaches of the write-lock protocol in one module's source:
    `begin_immediate` called outside `write_txn`; `BEGIN IMMEDIATE` or
    `BEGIN EXCLUSIVE` executed outside the `Db` method that wraps it; and,
    inside a `with write_txn(...)` body, an await (in an async def, it
    would let another request on the loop block on the held lock) or a
    commit or rollback, which belong to the helper."""
    tree = ast.parse(source)
    owner = _enclosing_functions(tree)
    out: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "begin_immediate":
            fn = owner.get(node)
            name = getattr(fn, "name", None)
            if not (rel == HELPER_FILE and name == HELPER):
                out.append(f"{rel}:{node.lineno}: begin_immediate outside"
                           f" {HELPER}")
        for arg in node.args:
            if (isinstance(arg, ast.Constant) and isinstance(arg.value, str)
                    and LOCKING_SQL.match(arg.value)
                    and rel != "pkm/database.py"):
                out.append(f"{rel}:{node.lineno}: {arg.value!r} outside"
                           " Db.begin_immediate")
    for node in ast.walk(tree):
        if not isinstance(node, (ast.With, ast.AsyncWith)):
            continue
        if not any(_is_helper_call(item.context_expr) for item in node.items):
            continue
        for inner in _walk_same_scope(node.body):
            if isinstance(inner, (ast.Await, ast.AsyncWith, ast.AsyncFor)):
                out.append(f"{rel}:{inner.lineno}: await while"
                           f" {HELPER} holds the lock")
            elif (isinstance(inner, ast.Call)
                  and isinstance(inner.func, ast.Attribute)
                  and inner.func.attr in ("commit", "rollback")):
                out.append(f"{rel}:{inner.lineno}: {inner.func.attr} inside"
                           f" {HELPER}, which owns it")
    return out


def test_the_write_lock_is_taken_only_through_write_txn() -> None:
    problems = [p for path in sorted(SRC.rglob("*.py"))
                for p in write_lock_problems(
                    path.relative_to(SRC).as_posix(), path.read_text())]
    assert problems == []


def test_the_scan_reaches_a_route_that_uses_the_helper() -> None:
    uses = [path for path in SRC.rglob("*.py")
            if f"with {HELPER}(" in path.read_text()]
    assert len(uses) > 1


@pytest.mark.parametrize(("rel", "source", "expected"), [
    ("pkm/server/routes_x.py",
     "def route(db):\n    db.begin_immediate()\n",
     "begin_immediate outside write_txn"),
    (HELPER_FILE,
     "def other(db):\n    db.begin_immediate()\n",
     "begin_immediate outside write_txn"),
    ("pkm/server/routes_x.py",
     "def route(db):\n    db.execute('BEGIN IMMEDIATE')\n",
     "'BEGIN IMMEDIATE' outside Db.begin_immediate"),
    ("pkm/server/routes_x.py",
     "def route(con):\n    con.execute(' begin exclusive')\n",
     "outside Db.begin_immediate"),
    ("pkm/server/routes_x.py",
     "async def route(db, hub):\n"
     "    with write_txn(db):\n"
     "        await hub.broadcast()\n",
     "await while write_txn holds the lock"),
    ("pkm/server/routes_x.py",
     "async def route(db, hub):\n"
     "    with write_txn(db):\n"
     "        if db:\n"
     "            async with hub:\n"
     "                pass\n",
     "await while write_txn holds the lock"),
    ("pkm/server/routes_x.py",
     "def route(db):\n    with write_txn(db):\n        db.commit()\n",
     "commit inside write_txn"),
    ("pkm/server/routes_x.py",
     "def route(db):\n    with db_mod.write_txn(db):\n"
     "        db.rollback()\n",
     "rollback inside write_txn"),
])
def test_the_scan_flags(rel: str, source: str, expected: str) -> None:
    problems = write_lock_problems(rel, source)
    assert len(problems) == 1 and expected in problems[0], problems


@pytest.mark.parametrize("source", [
    f"def {HELPER}(db):\n    db.begin_immediate()\n",
    "async def route(db, hub):\n"
    "    with write_txn(db):\n"
    "        async def later():\n"
    "            await hub.broadcast()\n"
    "    await hub.broadcast()\n",
    "def route(db):\n    with write_txn(db):\n        pass\n    db.commit()\n",
    "def route(db):\n    db.execute('BEGIN')\n",
])
def test_the_scan_passes(source: str) -> None:
    assert write_lock_problems(HELPER_FILE, source) == []


def _table(tmp_path: Path) -> Path:
    path = tmp_path / "t.sqlite3"
    db = connect(path)
    db.execute("CREATE TABLE t (x INTEGER)")
    db.commit()
    db.close()
    return path


def test_clean_exit_commits(tmp_path: Path) -> None:
    path = _table(tmp_path)
    db = open_db(path)
    with write_txn(db):
        assert db.in_transaction
        db.execute("INSERT INTO t VALUES (1)")
    assert not db.in_transaction
    assert list(read(connect(path), "SELECT x FROM t")) == [(1,)]


def test_a_raise_rolls_back_and_propagates(tmp_path: Path) -> None:
    path = _table(tmp_path)
    db = open_db(path)
    with pytest.raises(HTTPException) as exc:
        with write_txn(db):
            db.execute("INSERT INTO t VALUES (1)")
            raise HTTPException(status_code=409)
    assert exc.value.status_code == 409
    assert not db.in_transaction
    assert list(read(db, "SELECT x FROM t")) == []


def test_a_held_lock_is_a_503_with_retry_after(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _table(tmp_path)
    monkeypatch.setattr("pkm.server.db.BUSY_TIMEOUT_MS", 50)
    holder = connect(path)
    holder.begin_immediate()
    db = open_db(path)
    entered = False
    with pytest.raises(HTTPException) as exc:
        with write_txn(db):
            entered = True
    holder.rollback()
    assert not entered
    assert exc.value.status_code == 503
    assert exc.value.headers == {"Retry-After": "1"}
    assert isinstance(exc.value.__cause__, sqlite3.OperationalError)


def test_another_begin_failure_is_not_a_503(tmp_path: Path) -> None:
    db = open_db(_table(tmp_path))
    db.begin_immediate()
    with pytest.raises(sqlite3.OperationalError, match="within a transaction"):
        with write_txn(db):
            pass
