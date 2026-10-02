"""Stateful property test of `POST /api/ops`: random batches against a
fresh app, each checked against the reference model in `props.model`, with
replays and batch_id reuse mixed in. After every step the database must
agree with the model on every generator-pool block, keep sibling keys
unique and the tree well formed, hold every text the conflict rules say
to keep, and carry exactly the refs its block texts derive."""
from __future__ import annotations

import copy
from datetime import timedelta
from typing import Any

import pytest
import time_machine
from hypothesis import event, settings, strategies as st
from hypothesis.stateful import (RuleBasedStateMachine, initialize, invariant,
                                 precondition, rule)

from conftest import SEED_BLOCKS
from pkm.contracts.ops import subtree_hash, text_hash
from pkm.refs import canonicalize_title, extract, is_blank_title
from pkm.server.sync_meta import plain_space_title_canonicalization_active
from props.harness import (DAILY_TITLE, FROZEN_NOW, FreshApp,
                           assert_unique_keys, assert_well_formed, examples,
                           fresh_app, read_db, template_db_path)
from props.model import MBlock, Model
from props.strategies import PAGES, batch_for, seed_tree, uid_pool

pytestmark = pytest.mark.proptest

UIDS = uid_pool(8)
CLIENT_ID = "proptest"
CONFLICT_PREFIX = "[[conflict]]"
# The conftest seed rows were inserted by hand with a partial refs index
# (uid_b1's `Tags::` attribute has no row), and no generated op touches
# them, so the derived-refs invariant covers only rows the write path made.
HAND_SEEDED = frozenset(row[0] for row in SEED_BLOCKS)


def _hash_events(model: Model, ops: list[dict]) -> list[str]:
    """How each hashed op's base hash compares with the block as the
    earlier ops in its batch leave it: matching, stale, absent, or aimed
    at a block that is gone."""
    sim = copy.deepcopy(model)
    labels: list[str] = []
    for op in ops:
        kind, uid = op["op"], op.get("uid")
        if kind in ("update_text", "delete"):
            field = "base_text_hash" if kind == "update_text" else "base_subtree_hash"
            base = op.get(field)
            if base is None:
                label = "absent"
            elif uid not in sim.blocks:
                label = "block gone"
            else:
                current = (text_hash(sim.blocks[uid].text) if kind == "update_text"
                           else subtree_hash((u, sim.blocks[u].text)
                                             for u in sim.subtree(uid)))
                label = "match" if base == current else "stale"
            labels.append(f"{kind} hash: {label}")
        sim.apply([op])
    return labels


def _snapshot(app: FreshApp) -> tuple[Any, ...]:
    """Every table an op can write, plus the journal head."""
    with read_db(app.config.db_path) as con:
        return tuple(
            con.execute(sql).fetchall() for sql in (
                "SELECT * FROM blocks ORDER BY uid",
                "SELECT * FROM pages ORDER BY id",
                "SELECT * FROM refs ORDER BY 1, 2, 3",
                "SELECT * FROM block_refs ORDER BY 1, 2",
                "SELECT COALESCE(MAX(seq), 0) FROM changes"))


class OpsMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.app: FreshApp | None = None
        self.clock: Any = None
        self.traveller: Any = None
        self.model = Model()
        # (batch_id, payload, ack) for every batch the server applied
        self.sent: list[tuple[str, dict, dict]] = []
        # texts that must now sit under a conflict header on DAILY_TITLE
        self.kept: set[str] = set()
        self.batches = 0

    def _batch_id(self) -> str:
        self.batches += 1
        return f"batch{self.batches:06d}"

    def _post(self, payload: dict) -> Any:
        assert self.app is not None
        # Each request a second later, so a replayed ack carrying a
        # freshly minted ts could never pass for the stored one.
        self.clock.shift(timedelta(seconds=1))
        return self.app.client.post("/api/ops", json=payload)

    @initialize(rows=seed_tree(UIDS))
    def seed(self, rows: list[MBlock]) -> None:
        self.traveller = time_machine.travel(FROZEN_NOW, tick=False)
        self.clock = self.traveller.start()
        self.app = fresh_app(template_db_path())
        # The seed always goes up as one batch, led by a create_page so it
        # is never empty: `replay` and `reuse` then have a batch to address
        # from the first step, rather than Hypothesis discarding examples
        # whose first draws pick a rule whose precondition fails.
        ops: list[dict] = [{"op": "create_page", "page_title": PAGES[0]}]
        ops += [{"op": "create", "uid": b.uid, "page_title": b.page,
                 "parent_uid": b.parent, "order_idx": b.order_idx,
                 "text": b.text, "heading": b.heading,
                 "view_type": b.view_type} for b in rows]
        payload = {"client_id": CLIENT_ID, "batch_id": self._batch_id(),
                   "ops": ops}
        r = self._post(payload)
        assert r.status_code == 200, r.text
        assert r.json()["skipped"] == []
        self.sent.append((payload["batch_id"], payload, r.json()))
        self.model = Model.from_rows((PAGES[0],), rows)
        gapped = any(b.order_idx > 0 for b in rows)
        event(f"seed: {'gapped' if gapped else 'dense or empty'}")

    def teardown(self) -> None:
        if self.app is not None:
            self.app.close()
        if self.traveller is not None:
            self.traveller.stop()

    @rule(data=st.data())
    def submit(self, data: st.DataObject) -> None:
        ops = data.draw(batch_for(self.model, UIDS), label="ops")
        for label in _hash_events(self.model, ops):
            event(label)
        payload = {"client_id": CLIENT_ID, "batch_id": self._batch_id(),
                   "ops": ops}
        outcome = self.model.apply(ops)
        r = self._post(payload)
        assert r.status_code == outcome.status, r.text
        event(f"status: {r.status_code}")
        if r.status_code != 200:
            return
        ack = r.json()
        assert ack["applied"] == len(ops)
        skipped = tuple((s["index"], s["op"], s["uid"], s["reason"])
                        for s in ack["skipped"])
        assert skipped == outcome.skipped
        for s in skipped:
            event(f"skip: {s[3]}")
        if outcome.kept_texts:
            event("kept texts")
        self.sent.append((payload["batch_id"], payload, ack))
        self.kept.update(outcome.kept_texts)

    @precondition(lambda self: self.sent)
    @rule(data=st.data())
    def replay(self, data: st.DataObject) -> None:
        _, payload, ack = data.draw(st.sampled_from(self.sent), label="earlier")
        assert self.app is not None
        before = _snapshot(self.app)
        r = self._post(payload)
        assert r.status_code == 200, r.text
        assert r.json() == ack
        assert _snapshot(self.app) == before
        event("replay")

    @precondition(lambda self: self.sent)
    @rule(data=st.data())
    def reuse(self, data: st.DataObject) -> None:
        batch_id, _, _ = data.draw(st.sampled_from(self.sent), label="earlier")
        assert self.app is not None
        before = _snapshot(self.app)
        # No generated batch names this page, so the payload differs from
        # whatever the batch_id first carried.
        r = self._post({"client_id": CLIENT_ID, "batch_id": batch_id,
                        "ops": [{"op": "create_page",
                                 "page_title": "Reused batch id"}]})
        assert r.status_code == 409, r.text
        assert _snapshot(self.app) == before
        event("reuse")

    # --- invariants ----------------------------------------------------------

    @invariant()
    def model_agrees(self) -> None:
        """Every pool block the model holds is in the database exactly as
        the model says, and no pool block the model lacks is."""
        assert self.app is not None
        with read_db(self.app.config.db_path) as con:
            rows = con.execute(
                "SELECT b.uid, p.title, b.parent_uid, b.order_idx, b.text,"
                " b.heading, b.collapsed, b.view_type"
                " FROM blocks b JOIN pages p ON p.id = b.page_id"
                f" WHERE b.uid IN ({','.join('?' * len(UIDS))})",
                UIDS).fetchall()
        actual = {r[0]: MBlock(uid=r[0], page=r[1], parent=r[2],
                               order_idx=r[3], text=r[4], heading=r[5],
                               collapsed=bool(r[6]), view_type=r[7])
                  for r in rows}
        assert actual == self.model.snapshot()

    @invariant()
    def unique_sibling_keys(self) -> None:
        assert self.app is not None
        assert_unique_keys(self.app.config.db_path)

    @invariant()
    def well_formed_tree(self) -> None:
        assert self.app is not None
        assert_well_formed(self.app.config.db_path)

    @invariant()
    def no_text_lost(self) -> None:
        """Each kept text is the text of some block on today's daily page
        with a `[[conflict]]` header among its ancestors."""
        assert self.app is not None
        with read_db(self.app.config.db_path) as con:
            rows = {uid: (parent, text) for uid, parent, text in con.execute(
                "SELECT b.uid, b.parent_uid, b.text FROM blocks b"
                " JOIN pages p ON p.id = b.page_id WHERE p.title = ?",
                (DAILY_TITLE,))}
        under_header: set[str] = set()
        for parent, text in rows.values():
            cur = parent
            while cur is not None and cur in rows:
                if rows[cur][1].startswith(CONFLICT_PREFIX):
                    under_header.add(text)
                    break
                cur = rows[cur][0]
        missing = self.kept - under_header
        assert not missing, f"kept texts not under a conflict header: {missing}"

    @invariant()
    def refs_derived_from_text(self) -> None:
        """`refs` and `block_refs` hold exactly what each block's text
        extracts to, and no row outlives its source block."""
        assert self.app is not None
        with read_db(self.app.config.db_path) as con:
            plain_space = plain_space_title_canonicalization_active(con)
            texts = dict(con.execute("SELECT uid, text FROM blocks"))
            refs: dict[str, set[tuple[str, str]]] = {}
            for src, title, kind in con.execute(
                    "SELECT r.src_block_uid, p.title, r.kind FROM refs r"
                    " JOIN pages p ON p.id = r.target_page_id"):
                refs.setdefault(src, set()).add((title, kind))
            block_refs: dict[str, set[str]] = {}
            for src, dst in con.execute("SELECT * FROM block_refs"):
                block_refs.setdefault(src, set()).add(dst)
        assert set(refs) <= set(texts), "refs row without its block"
        assert set(block_refs) <= set(texts), "block_refs row without its block"
        for uid, text in texts.items():
            if uid in HAND_SEEDED:
                continue
            parsed = extract(text)
            want = {(canonicalize_title(r.title, plain_space=plain_space),
                     r.kind) for r in parsed.refs if not is_blank_title(r.title)}
            assert refs.get(uid, set()) == want, uid
            assert block_refs.get(uid, set()) == set(parsed.block_refs), uid


TestOps = OpsMachine.TestCase
TestOps.settings = settings(max_examples=examples("ops_state"),
                            stateful_step_count=30)
