"""Breadcrumb ancestor reads against the path-string walk they replaced.

`routes_pages._fetch_ancestors` used to carry, on every row of its
recursive CTE, a string of every uid above that row, and to search it to
stop on a parent cycle. Breadcrumbs for every block of a chain `d` deep then
cost about `d³`. The walk now reads each distinct ancestor once and rebuilds
the trails in `tree.ancestor_texts`. Its output must match the old query's
exactly, cycles and dangling parents included, so the old query is kept
here verbatim as the oracle."""
from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import patch

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from hostile import count, event
from pkm.contracts.ops import MAX_OUTLINE_DEPTH, BlockUid
from pkm.database import Db
from pkm.schema import DDL
from pkm.server import routes_pages
from pkm.server.db import init_db, open_db
from pkm.server.routes_pages import _fetch_ancestors
from pkm.server.sync_core import chunk_ids
from pkm.server.tree import ancestor_texts
from pkm.test_data.ids import uid_of


def _reference_fetch_ancestors(db: Db, uids: list[BlockUid]
                               ) -> dict[BlockUid, list[str]]:
    """`_fetch_ancestors` as it was with the per-row path string."""
    out: dict[BlockUid, list[str]] = {}
    for chunk in chunk_ids(list(dict.fromkeys(uids))):
        marks = ",".join("?" * len(chunk))
        rows = db.select(
            f"""WITH RECURSIVE anc(start_uid, uid, parent_uid, text, depth,
                                   path) AS (
                  SELECT uid, uid, parent_uid, text, 0, ',' || uid || ','
                    FROM blocks WHERE uid IN ({marks})
                  UNION ALL
                  SELECT a.start_uid, b.uid, b.parent_uid, b.text,
                         a.depth + 1, a.path || b.uid || ','
                    FROM anc a JOIN blocks b ON b.uid = a.parent_uid
                   WHERE instr(a.path, ',' || b.uid || ',') = 0
                )
                SELECT start_uid AS uid, text FROM anc
                 WHERE depth > 0 ORDER BY start_uid, depth DESC""", chunk)
        for r in rows:
            out.setdefault(r["uid"], []).append(r["text"])
    return out


@pytest.fixture(scope="module")
def db(tmp_path_factory) -> Iterator[Db]:
    path = tmp_path_factory.mktemp("ancestors") / "t.sqlite3"
    init_db(path)
    con = open_db(path)
    con.executescript(DDL)
    # Dangling parents and cycles are corrupt data no write path makes;
    # the read must still cope with them.
    con.execute("PRAGMA foreign_keys=OFF")
    con.execute("INSERT INTO pages(id, title) VALUES (1, 'P')")
    con.commit()
    yield con
    con.close()


def _store(db: Db, parents: dict[str, str | None]) -> None:
    db.execute("DELETE FROM blocks")
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
        " VALUES (?, 1, ?, 0, ?)",
        [(uid, parent, f"text of {uid}") for uid, parent in parents.items()])
    db.commit()


def _chain(n: int) -> dict[str, str | None]:
    return {f"chain_{i:05d}": f"chain_{i - 1:05d}" if i else None
            for i in range(n)}


# --- the pure trail walk ---------------------------------------------------

def _u(name: str) -> BlockUid:
    return uid_of(f"block_{name}")


def _rows(parents: dict[str, str | None]
          ) -> dict[BlockUid, tuple[BlockUid | None, str]]:
    """Single-letter names to rows whose text is the name upper-cased."""
    return {_u(u): (_u(p) if p else None, u.upper())
            for u, p in parents.items()}


def test_trails_run_root_first_and_skip_starts_without_ancestors():
    rows = _rows({"a": None, "b": "a", "c": "b"})
    assert ancestor_texts([_u("c"), _u("a")], rows) == {_u("c"): ["A", "B"]}


def test_a_trail_stops_at_the_first_uid_already_on_it():
    rows = _rows({"a": "c", "b": "a", "c": "b", "x": "a"})
    assert ancestor_texts([_u("a"), _u("x")], rows) == {
        _u("a"): ["B", "C"], _u("x"): ["B", "C", "A"]}


def test_a_self_parent_has_no_trail():
    assert ancestor_texts([_u("a")], _rows({"a": "a"})) == {}


def test_a_trail_ends_at_a_missing_parent_and_unknown_starts_are_absent():
    rows = _rows({"b": "gone", "c": "b"})
    assert ancestor_texts([_u("c"), _u("nope")], rows) == {_u("c"): ["B"]}


# --- the query against the oracle ------------------------------------------

_UIDS = [f"blk_{i:02d}" for i in range(12)]
_MISSING = "blk_missing"


@st.composite
def _graphs(draw: st.DrawFn) -> tuple[dict[str, str | None], list[BlockUid], int]:
    n = draw(st.integers(1, len(_UIDS)))
    uids = _UIDS[:n]
    parent = st.one_of(st.none(), st.sampled_from(uids),
                       st.just(_MISSING))
    parents = {u: draw(parent) for u in uids}
    starts = draw(st.lists(st.sampled_from([*uids, "blk_unknown"]),
                           min_size=1, max_size=2 * n))
    chunk = draw(st.integers(1, 4))
    return parents, [uid_of(s) for s in starts], chunk


def _label(parents: dict[str, str | None], starts: list[BlockUid],
           chunk: int) -> None:
    count("case")
    reached: dict[str, int] = {}
    for start in dict.fromkeys(starts):
        seen = {start}
        cur = parents.get(start)
        while cur is not None and cur in parents and cur not in seen:
            seen.add(cur)
            reached[cur] = reached.get(cur, 0) + 1
            cur = parents[cur]
        if cur is not None and cur in seen:
            event("trail met a cycle")
        if cur == _MISSING:
            event("trail ended at a missing parent")
    if any(n > 1 for n in reached.values()):
        event("starts shared an ancestor")
    if len(set(starts)) > chunk:
        event("starts split across chunks")


@settings(max_examples=400, deadline=None)
@given(_graphs())
def test_fetch_ancestors_matches_the_path_string_walk(db, case):
    parents, starts, chunk = case
    _label(parents, starts, chunk)
    _store(db, parents)
    with patch.object(routes_pages, "chunk_ids",
                      lambda ids: chunk_ids(ids, chunk)):
        got = _fetch_ancestors(db, starts)
    assert got == _reference_fetch_ancestors(db, starts)


def test_a_chain_at_the_outline_cap_matches(db):
    parents = _chain(MAX_OUTLINE_DEPTH + 1)
    _store(db, parents)
    starts = [uid_of(u) for u in parents]
    got = _fetch_ancestors(db, starts)
    assert got == _reference_fetch_ancestors(db, starts)
    assert len(got[starts[-1]]) == MAX_OUTLINE_DEPTH


def test_a_cycle_as_long_as_the_outline_cap_matches(db):
    parents = _chain(MAX_OUTLINE_DEPTH + 1)
    first, last = next(iter(parents)), list(parents)[-1]
    parents[first] = last
    _store(db, parents)
    starts = [uid_of(u) for u in parents]
    got = _fetch_ancestors(db, starts)
    assert got == _reference_fetch_ancestors(db, starts)
    assert all(len(trail) == MAX_OUTLINE_DEPTH for trail in got.values())


# --- the work it does --------------------------------------------------------

def _vm_steps(db: Db, depth: int) -> int:
    parents = _chain(depth)
    _store(db, parents)
    steps = 0

    def tick() -> int:
        nonlocal steps
        steps += 1
        return 0

    db.raw.set_progress_handler(tick, 100)
    try:
        _fetch_ancestors(db, [uid_of(u) for u in parents])
    finally:
        db.raw.set_progress_handler(None, 0)
    return steps


def test_ancestor_query_work_is_linear_in_depth(db):
    # Every block of the chain is a start, as when each links the page
    # whose backlinks are read. Reading each ancestor once doubles the
    # SQL work when the depth doubles; one row per (start, ancestor), as
    # the path-string walk made, quadruples it.
    shallow, deep = _vm_steps(db, 200), _vm_steps(db, 400)
    assert deep < 3 * shallow, (shallow, deep)
