"""Stateful property test of `POST /api/ops`: random batches against a
fresh app, each checked against the reference model in `props.model`, with
replays, batch_id reuse and page deletes (`DELETE /api/page/{title}`)
mixed in. A batch may carry a `seen_seq` from before a delete, which makes
it stale for the deleted titles. After every step the database must agree
with the model on every generator-pool block, on which pool pages exist
(so no stale batch re-creates a deleted page), on the recorded rewrites
and deletions, keep sibling keys unique and the tree well formed, hold
every text the conflict rules say to keep, and carry exactly the refs its
block texts derive."""
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
from pkm.contracts.ops import BlockUid, SyncSeq, subtree_hash, text_hash
from pkm.refs import canonicalize_title, extract, is_blank_title
from pkm.server.sync_meta import plain_space_title_canonicalization_active
from props.harness import (DAILY_TITLE, FROZEN_NOW, FreshApp,
                           assert_unique_keys, assert_well_formed, examples,
                           fresh_app, read_db, seed_ops, template_db_path)
from props.model import MBlock, Model
from props.strategies import PAGES, batch_for, seed_tree, texts, uid_pool
from pkm.test_data.ids import seq_of

pytestmark = pytest.mark.proptest

UIDS = uid_pool(8)
CLIENT_ID = "proptest"
CONFLICT_PREFIX = "[[conflict]]"
# The conftest seed rows were inserted by hand with a partial refs index
# (uid_b1's `Tags::` attribute has no row), and no generated op touches
# them, so the derived-refs invariant covers only rows the write path made.
HAND_SEEDED = frozenset(row[0] for row in SEED_BLOCKS)


def _hash_events(model: Model, ops: list[dict],
                 seen_seq: SyncSeq | None) -> list[str]:
    """How each hashed op's base hash compares with the block as the
    earlier ops in its batch leave it: matching, stale, absent, aimed at a
    block that is gone, or the base of a recorded rewrite (a replay)."""
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
            elif kind == "update_text" and any(
                    r.base_hash == base for r in sim.rewrites.get(uid, ())):
                label = "replay"
            else:
                current = (text_hash(sim.blocks[uid].text) if kind == "update_text"
                           else subtree_hash((u, sim.blocks[u].text)
                                             for u in sim.subtree(uid)))
                label = "match" if base == current else "stale"
            labels.append(f"{kind} hash: {label}")
        sim.apply([op], seen_seq)
    return labels


def _snapshot(app: FreshApp) -> tuple[Any, ...]:
    """Every table an op or a page delete can write, plus the journal
    head."""
    with read_db(app.config.db_path) as con:
        return tuple(
            con.select(sql) for sql in (
                "SELECT * FROM blocks ORDER BY uid",
                "SELECT id AS page_id, title, created_at, updated_at"
                " FROM pages ORDER BY id",
                "SELECT src_block_uid, target_page_id, kind AS ref_kind"
                " FROM refs ORDER BY 1, 2, 3",
                "SELECT * FROM block_refs ORDER BY 1, 2",
                "SELECT uid, base_hash, after_hash, old_title, new_title,"
                " created_at AS rewrite_created_at, kind AS rewrite_kind"
                " FROM block_rewrites ORDER BY rowid",
                "SELECT * FROM page_deletions ORDER BY rowid",
                "SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM changes"))


def _head(app: FreshApp) -> SyncSeq:
    with read_db(app.config.db_path) as con:
        return con.select(
            "SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM changes"
        )[0]["latest_seq"]


def _untracked_texts(app: FreshApp, page: str) -> dict[BlockUid, str]:
    """The text of every block the model does not track (conflict
    entries, seed rows) that is off `page`."""
    with read_db(app.config.db_path) as con:
        return {r["uid"]: r["text"] for r in con.select(
            "SELECT b.uid, b.text FROM blocks b"
            " JOIN pages p ON p.id = b.page_id"
            f" WHERE p.title <> ? AND b.uid NOT IN ({','.join('?' * len(UIDS))})",
            (page, *UIDS))}


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
        # the journal head just before each page delete that applied: a
        # batch sent with one is stale for that delete and every later one
        self.before_deletes: list[int] = []
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
        payload = {"client_id": CLIENT_ID, "batch_id": self._batch_id(),
                   "ops": seed_ops(PAGES[0], rows)}
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
        """A batch with no `seen_seq` or the journal head's: stale for
        nothing."""
        assert self.app is not None
        current = data.draw(st.booleans(), label="seen_seq is the head")
        self._submit(data, _head(self.app) if current else None)

    @rule(data=st.data())
    def stale_submit(self, data: st.DataObject) -> None:
        """A batch built before a page delete it never saw: its `seen_seq`
        is the journal head just before that delete, so it is stale for
        that title and every one deleted after it. Until a delete applies
        it sends the journal head instead; a precondition would make
        Hypothesis discard the examples whose rule draws keep missing it.
        A head past the journal's is never drawn."""
        assert self.app is not None
        self._submit(data, seq_of(data.draw(st.sampled_from(self.before_deletes),
                                     label="seen_seq")
                     if self.before_deletes else _head(self.app)))

    @rule(data=st.data())
    def offline_edit(self, data: st.DataObject) -> None:
        """Another device writes a live block online, then an edit from a
        device that missed something arrives:

        - "conflict": the edit is of the text the block held before a
          recorded rewrite (a page delete's or a stale unlink's), hashed on
          it. The replay rewrites the edit, which then conflicts with the
          online write, and the replayed steps are recorded.
        - "stale identical": the online write is `D w` for a deleted title
          D, and the edit, stale for every delete, is `[[D]] w` (or `#D w`,
          or `D:: w` against `` `D`:: w ``). Its unlink makes it identical
          to the block, and it still records that unlink, so the device's
          next edit replays onto the block's text.

        With neither possible it does nothing."""
        assert self.app is not None
        live = sorted(self.model.blocks)
        rewritten = [(uid, step) for uid, steps
                     in sorted(self.model.rewrites.items())
                     if uid in self.model.blocks for step in steps]
        kinds = ([*(["conflict"] if rewritten else []),
                  *(["stale identical"] if live and self.before_deletes
                    else [])])
        if not kinds:
            return
        word = data.draw(st.sampled_from(("apple", "river")), label="word")
        if data.draw(st.sampled_from(kinds), label="offline") == "conflict":
            uid, step = data.draw(st.sampled_from(rewritten), label="rewrite")
            text = step.before
            if data.draw(st.booleans(), label="extend"):
                text += " " + word
            self._send([{"op": "update_text", "uid": uid,
                         "text": data.draw(texts(UIDS), label="online")}],
                       None)
            self._send([{"op": "update_text", "uid": uid, "text": text,
                         "base_text_hash": step.base_hash}], None)
            return
        uid = data.draw(st.sampled_from(live), label="block")
        title = data.draw(st.sampled_from(
            sorted({t for t, _ in self.model.deletions})), label="deleted")
        online, offline = data.draw(st.sampled_from((
            (f"{title} {word}", f"[[{title}]] {word}"),
            (f"{title} {word}", f"#{title} {word}"),
            (f"`{title}`:: {word}", f"{title}:: {word}"))), label="form")
        self._send([{"op": "update_text", "uid": uid, "text": online}], None)
        self._send([{"op": "update_text", "uid": uid, "text": offline,
                     "base_text_hash": text_hash(offline)}],
                   seq_of(self.before_deletes[0]))

    def _submit(self, data: st.DataObject, seen_seq: SyncSeq | None) -> None:
        ops = data.draw(batch_for(self.model, UIDS, seen_seq), label="ops")
        self._send(ops, seen_seq)

    def _send(self, ops: list[dict], seen_seq: SyncSeq | None) -> None:
        """Post one batch and check the ack and the database against the
        model's outcome."""
        assert self.app is not None
        for label in _hash_events(self.model, ops, seen_seq):
            event(label)
        payload: dict[str, Any] = {"client_id": CLIENT_ID,
                                   "batch_id": self._batch_id(), "ops": ops}
        if seen_seq is not None:
            payload["seen_seq"] = seen_seq
        if self.model.stale_titles(seen_seq):
            event("batch: stale")
        rewrites = self.model.rewrite_rows()
        outcome = self.model.apply(ops, seen_seq)
        if self.model.rewrite_rows() != rewrites:
            event("batch: records a rewrite")
        for path in outcome.paths:
            event(path)
        before = _snapshot(self.app)
        r = self._post(payload)
        assert r.status_code == outcome.status, r.text
        event(f"status: {r.status_code}")
        if r.status_code != 200:
            assert _snapshot(self.app) == before
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

    @rule(data=st.data())
    def delete_page(self, data: st.DataObject) -> None:
        """`DELETE /api/page/{title}`, through the route itself, so a page
        whose blocks it cannot rewrite is refused as in production. Three
        times in four the title is a page that exists. Today's daily page
        is never drawn: deleting it would take the conflict entries
        `no_text_lost` checks with it, and a date title records no
        `page_deletions` row, so it never makes a batch stale."""
        assert self.app is not None
        live = sorted(self.model.pages & set(PAGES))
        pool = (live if live and data.draw(st.integers(0, 3)) < 3
                else list(PAGES))
        title = data.draw(st.sampled_from(pool), label="title")
        others = _untracked_texts(self.app, title)
        head = _head(self.app)
        before = _snapshot(self.app)
        self.clock.shift(timedelta(seconds=1))
        r = self.app.client.delete(f"/api/page/{title}")
        outcome = self.model.delete_page(title, others, seq_of(_head(self.app)))
        assert r.status_code == outcome.status, r.text
        event(f"delete page: {r.status_code}")
        if r.status_code != 200:
            assert _snapshot(self.app) == before
            if r.status_code == 409:
                blockers = r.json()["detail"]["blockers"]
                assert {b["uid"]: b["reason"] for b in blockers} == \
                    outcome.blockers
                for reason in {b["reason"] for b in blockers}:
                    event(f"delete page blocker: {reason}")
            return
        self.before_deletes.append(head)
        # the blocks the model does not track are rewritten as the pool's
        # are: conflict entries and the kept texts among them included
        assert _untracked_texts(self.app, title) == {
            u: outcome.rewrite(t)[0] for u, t in others.items()}
        self.kept = {outcome.rewrite(t)[0] for t in self.kept}

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
            rows = con.select(
                "SELECT b.uid, p.title AS page_title, b.parent_uid,"
                " b.order_idx, b.text, b.heading, b.collapsed, b.view_type"
                " FROM blocks b JOIN pages p ON p.id = b.page_id"
                f" WHERE b.uid IN ({','.join('?' * len(UIDS))})",
                UIDS)
        actual = {r["uid"]: MBlock(
                      uid=r["uid"], page=r["page_title"],
                      parent=r["parent_uid"], order_idx=r["order_idx"],
                      text=r["text"], heading=r["heading"],
                      collapsed=bool(r["collapsed"]), view_type=r["view_type"])
                  for r in rows}
        assert actual == self.model.snapshot()

    @invariant()
    def deletes_agree(self) -> None:
        """Exactly the pool pages the model holds exist, so a page delete
        removes one and only a batch that saw the delete (or a later write
        naming the title) brings it back; `block_rewrites` holds exactly
        the rewrites the model recorded for pool blocks, and
        `page_deletions` exactly its deletes. One invariant, so one
        connection per step."""
        assert self.app is not None
        with read_db(self.app.config.db_path) as con:
            pages = {r["title"] for r in con.select(
                f"SELECT title FROM pages WHERE title IN"
                f" ({','.join('?' * len(PAGES))})", PAGES)}
            rows = {(r["uid"], r["base_hash"], r["after_hash"],
                     r["rewrite_kind"], r["old_title"], r["new_title"])
                    for r in con.select(
                "SELECT uid, base_hash, after_hash, kind AS rewrite_kind,"
                " old_title, new_title FROM block_rewrites"
                f" WHERE uid IN ({','.join('?' * len(UIDS))})", UIDS)}
            deletions = [(r["title"], r["seq"]) for r in con.select(
                "SELECT title, seq FROM page_deletions ORDER BY rowid")]
        assert pages == self.model.pages & set(PAGES)
        assert rows == self.model.rewrite_rows()
        assert deletions == self.model.deletions

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
            rows = {r["uid"]: (r["parent_uid"], r["text"]) for r in con.select(
                "SELECT b.uid, b.parent_uid, b.text FROM blocks b"
                " JOIN pages p ON p.id = b.page_id WHERE p.title = ?",
                (DAILY_TITLE,))}
        under_header: set[str] = set()
        for parent, text in rows.values():
            cur = parent
            for _ in range(len(rows) + 1):
                if cur is None or cur not in rows:
                    break
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
            texts = {r["uid"]: r["text"]
                     for r in con.select("SELECT uid, text FROM blocks")}
            refs: dict[BlockUid, set[tuple[str, str]]] = {}
            for r in con.select(
                    "SELECT r.src_block_uid, p.title, r.kind AS ref_kind"
                    " FROM refs r JOIN pages p ON p.id = r.target_page_id"):
                refs.setdefault(r["src_block_uid"], set()).add(
                    (r["title"], r["ref_kind"]))
            block_refs: dict[BlockUid, set[BlockUid]] = {}
            for r in con.select("SELECT * FROM block_refs"):
                block_refs.setdefault(r["src_block_uid"], set()).add(
                    r["target_block_uid"])
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
