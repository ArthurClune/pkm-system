"""Property test of `pkm batch` planning against the real server: a batch
of CLI commands on a seeded page, planned by `pkm.batch.plan_batch` inside
the client's `apply_batch` and applied by `POST /api/ops`, must leave every
parent's children in the order the position contract gives
(`props.model.positions_after`). `index` is a 0-based position among the
parent's children as the earlier commands in the batch left them, past
the end appends, and an indexed move counts the destination without the
moving block.

Sometimes another device deletes a block the batch names between the
CLI's fetch and its post. The server then skips what it cannot apply; the
groups those skips touch are checked for membership only, every other
group for order too."""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

import httpx2
import pytest
import time_machine
from hypothesis import event, given, settings, strategies as st

from pkm.client.api import PkmClient
from pkm.client.core import CliConfig
from pkm.client.workflows import apply_batch
from pkm.contracts.ops import (BatchId, BlockOp, CreateOp, CreatePageOp,
                               DeleteOp, MoveOp)
from pkm.contracts.responses import BlockNode, OpsAck, walk_blocks
from pkm.planning import BuildError
from props.harness import (FROZEN_NOW, FreshApp, assert_unique_keys,
                           assert_well_formed, examples, fresh_app, seed_ops,
                           template_db_path)
from props.model import MBlock, positions_after
from props.strategies import PAGES, cli_batch, seed_tree, uid_pool

pytestmark = pytest.mark.proptest

UIDS = uid_pool(12)
PAGE = PAGES[0]
_UID_SPEC = re.compile(r"^\(\((.+)\)\)$")

Groups = dict[str | None, list[str]]
AnyOp = BlockOp | Mapping[str, Any]


class Racing(PkmClient):
    """A client through which another device deletes `concurrent` after the
    CLI has fetched its pages and before its batch lands. It also records
    the ops the CLI posts: the uids the planner minted show up only there."""

    def __init__(self, config: CliConfig, http: httpx2.Client,
                 concurrent: str | None) -> None:
        super().__init__(config, http=http)
        self.concurrent = concurrent
        self.posted: list[AnyOp] = []

    def post_ops(self, ops: Sequence[AnyOp], batch_id: BatchId) -> OpsAck:
        if self.concurrent is not None:
            ack = super().post_ops([{"op": "delete", "uid": self.concurrent}],
                                   batch_id=BatchId("concurrent-delete"))
            assert ack.skipped == []
        self.posted = list(ops)
        return super().post_ops(ops, batch_id)


def _groups(pairs: Iterable[tuple[str | None, str, int]]) -> Groups:
    """(parent, uid, order_idx) triples as parent -> children in key
    order. Every block gets a (possibly empty) group of its own."""
    groups: Groups = {None: []}
    for parent, uid, _ in sorted(pairs, key=lambda t: (t[2], t[1])):
        groups.setdefault(parent, []).append(uid)
        groups.setdefault(uid, [])
    return groups


def _seed_groups(rows: Sequence[MBlock]) -> Groups:
    return _groups((b.parent, b.uid, b.order_idx) for b in rows)


def _page_groups(nodes: Sequence[BlockNode]) -> Groups:
    top = [(None, n.uid, n.order_idx) for n in nodes]
    below = [(n.uid, c.uid, c.order_idx) for n in walk_blocks(nodes)
             for c in n.children]
    return _groups(top + below)


def _parent(groups: Groups, uid: str) -> tuple[bool, str | None]:
    for parent, kids in groups.items():
        if uid in kids:
            return True, parent
    return False, None


def _subtree(groups: Groups, uid: str) -> list[str]:
    found = [uid]
    for kid in groups.get(uid, []):
        found.extend(_subtree(groups, kid))
    return found


def _without(groups: Groups, uid: str) -> Groups:
    """`groups` after `uid` and its subtree are deleted."""
    gone = set(_subtree(groups, uid))
    return {p: [k for k in kids if k not in gone]
            for p, kids in groups.items() if p not in gone}


def _nonempty(groups: Groups) -> Groups:
    return {p: kids for p, kids in groups.items() if kids}


def _named_seed_uids(commands: Sequence[dict], rows: Sequence[MBlock]) -> list[str]:
    """Seeded uids some command names, as its block or its parent, in
    first-mention order."""
    seeded = {b.uid for b in rows}
    named: list[str] = []
    for command in commands:
        params = command["params"]
        m = _UID_SPEC.match(params.get("parent") or "")
        for uid in (params.get("uid"), m.group(1) if m else None):
            if isinstance(uid, str) and uid in seeded and uid not in named:
                named.append(uid)
    return named


def _gapped(rows: Sequence[MBlock]) -> bool:
    """Some sibling group's keys are not its positions."""
    keys: dict[str | None, list[int]] = {}
    for b in rows:
        keys.setdefault(b.parent, []).append(b.order_idx)
    return any(sorted(ks) != list(range(len(ks))) for ks in keys.values())


def _states(start: Groups, commands: Sequence[dict],
            created: Sequence[str]) -> list[Groups]:
    """The arrangement before each command, from `start`: entry i is
    `positions_after` over the first i commands."""
    states: list[Groups] = []
    spent = 0
    for i, command in enumerate(commands):
        states.append(positions_after(start, commands[:i],
                                      iter(created[:spent])))
        spent += command["command"] in ("create", "todo")
    return states


def _index_events(commands: Sequence[dict], ops: Sequence[AnyOp],
                  views: Sequence[Groups]) -> None:
    """Where each index fell in the group the planner saw: absent, inside
    (0 through the group's length) or past the end."""
    for command, op, view in zip(commands, ops, views):
        index = command["params"].get("index")
        if not isinstance(op, CreateOp | MoveOp):
            continue
        if index is None:
            event("index: none")
            continue
        group = [k for k in view.get(op.parent_uid, []) if k != op.uid]
        event("index: past end" if index > len(group) else "index: inside")


def _check(app: FreshApp, rows: Sequence[MBlock], commands: list[dict],
           concurrent: str | None) -> None:
    r = app.client.post("/api/ops", json={
        "client_id": "proptest", "batch_id": "seed-batch",
        "ops": seed_ops(PAGE, rows)})
    assert r.status_code == 200, r.text
    assert r.json()["skipped"] == []
    token = app.client.cookies["pkm_session"]
    app.client.cookies.clear()
    client = Racing(CliConfig(url="http://testserver", token=token),
                    app.client, concurrent)
    try:
        ack = apply_batch(client, commands)
    except BuildError:
        event("build_error")
        return

    # The posted ops: the page's create_page when it was missing, then one
    # op per command (cli_batch never names a `## Heading` parent, the one
    # spec that would make a command plan two creates).
    offset = sum(isinstance(op, CreatePageOp) for op in client.posted)
    ops = client.posted[offset:]
    assert len(ops) == len(commands)
    created = [op.uid for op in ops if isinstance(op, CreateOp)]

    seed = _seed_groups(rows)
    start = seed if concurrent is None else _without(seed, concurrent)
    expected = positions_after(start, commands, iter(created))
    actual = _page_groups(client.get_page_blocks(PAGE)[0])
    states = _states(start, commands, created)
    views = _states(seed, commands, created)
    _index_events(commands, ops, views)

    # Groups whose order the server may legitimately leave off the
    # contract: the planner placed later commands against keys that a
    # skipped op never shifted, or (concurrent delete) against a sibling
    # that was already gone.
    excluded: set[str | None] = set()
    if concurrent is not None:
        excluded.add(_parent(seed, concurrent)[1])
    for skip in ack.skipped:
        op = ops[skip.index - offset]
        assert isinstance(op, CreateOp | MoveOp | DeleteOp), skip
        assert skip.uid == op.uid, skip
        before = states[skip.index - offset]
        if skip.reason == "cycle":
            assert isinstance(op, MoveOp), skip
            assert op.parent_uid in _subtree(before, op.uid), skip
        else:
            # Only the concurrent delete, or a create it diverted, can
            # leave a block or parent missing: cli_batch names only blocks
            # the batch has not deleted.
            assert concurrent is not None, skip
            if skip.reason == "block_not_found":
                assert not _parent(before, op.uid)[0], skip
            else:
                assert isinstance(op, CreateOp | MoveOp), skip
                assert op.parent_uid is not None, skip
                assert not _parent(before, op.parent_uid)[0], skip
        event(f"skip: {skip.reason}")
        if isinstance(op, CreateOp | MoveOp):
            excluded.add(op.parent_uid)
        for state in (before, views[skip.index - offset]):
            found, parent = _parent(state, op.uid)
            if found:
                excluded.add(parent)
    if not ack.skipped:
        assert concurrent is None
        event("skipped: none")

    exp, act = _nonempty(expected), _nonempty(actual)
    assert set(act) == set(exp), (act, exp)
    for parent, kids in exp.items():
        assert sorted(act[parent]) == sorted(kids), (parent, act, exp)
        if parent not in excluded:
            assert act[parent] == kids, (parent, act, exp)
    assert_unique_keys(app.config.db_path)
    assert_well_formed(app.config.db_path)


@settings(max_examples=examples("planner"))
@given(data=st.data())
def test_cli_batch_positions(data: st.DataObject) -> None:
    rows = [b for b in data.draw(seed_tree(UIDS), label="seed")
            if b.page == PAGE]
    commands = data.draw(cli_batch(rows, PAGE), label="commands")
    named = _named_seed_uids(commands, rows)
    concurrent = None
    if named and data.draw(st.integers(0, 2), label="race") == 2:
        concurrent = data.draw(st.sampled_from(named),
                               label="concurrent delete")
        event("concurrent delete")
    if _gapped(rows):
        event("seed: gapped")
    if any((c["params"].get("parent") or "").startswith("{{")
           for c in commands):
        event("parent: alias")
    with time_machine.travel(FROZEN_NOW, tick=False):
        app = fresh_app(template_db_path())
        try:
            _check(app, rows, commands, concurrent)
        finally:
            app.close()
