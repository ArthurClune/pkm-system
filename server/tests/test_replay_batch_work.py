"""The replay work one `/api/ops` batch does under the write lock is
bounded however many ops it holds.

A stale edit replays the rewrites its block went through since: up to
`MAX_REPLAYED_REWRITES` steps, each splicing a delete's copies in and
unlinking the result. The sent op can be a few characters while the
copies are a megabyte, so a batch of 500 such ops did work set by the
server's history, not by the request: about 0.55 s per step, three
times over (the classification, the rewrite rows, their check), for
thousands of seconds. Each op's steps now run once, and a batch whose
replays would read past `MAX_BATCH_REPLAY_WORK` lands its remaining
edits as sent, as `over_limit` does."""
from __future__ import annotations

import time

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st
from scaling import loop_steps
from test_text_limits_rewrites import _seed, _text

from pkm import refs, spans, text_limits, unlink
from pkm.contracts.ops import BlockUid, UpdateTextOp, text_hash
from pkm.refs import normalize_title
from pkm.server import ops_apply, ops_core
from pkm.server.ops_core import MAX_REPLAYED_REWRITES
from pkm.server.db import open_db
from pkm.test_data.ids import (batch_id_of, canonical_title_of, client_id_of,
                               uid_of)
from pkm.unlink import unlink_stale_refs

MODULES = (unlink, refs, spans, ops_core, text_limits)
SRC = uid_of("rbw_src_001")
COPY = uid_of("rbw_copy_01")
SENT = f"(({COPY})) [[T]] edited offline"
_batch_counter = 0


def _post(client, ops):
    global _batch_counter
    _batch_counter += 1
    return client.post("/api/ops", json={
        "client_id": client_id_of("replaywork"),
        "batch_id": batch_id_of(f"rbw_{_batch_counter:08d}"),
        "ops": ops})


def _history(config, copy: str, steps: int, uid: BlockUid = SRC) -> str:
    """`uid` on page Src, and the rows of `steps` page deletes, each of
    which inlined `copy` for `((COPY))` and unlinked `T`. Each copy ends
    in its step's number, so no two steps are the same and none is
    replayed once for another. Returns the text the first delete started
    from, the base a stale edit names."""
    original = f"(({COPY})) [[T]]"
    _seed(config, [(uid, "Src", "current")])
    hashes = [text_hash(original)] + [
        text_hash(f"after step {i}") for i in range(steps)]
    con = open_db(config.db_path)
    try:
        con.execute("DELETE FROM block_rewrites WHERE uid = ?", (uid,))
        for i in range(steps):
            for kind, old, new in (("unlink", "T", ""),
                                   ("inline", COPY, f"{copy}{i}")):
                con.execute(
                    "INSERT INTO block_rewrites(uid, base_hash, after_hash,"
                    " old_title, new_title, created_at, kind)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (uid, hashes[i], hashes[i + 1], old, new, i, kind))
        con.commit()
    finally:
        con.close()
    return original


def _stale_edit(original: str, uid: BlockUid = SRC) -> dict[str, object]:
    return {"op": "update_text", "uid": uid, "text": SENT,
            "base_text_hash": text_hash(original)}


def test_an_edit_pays_for_its_replay_once(client, seeded_config):
    # The classification replays the steps; the rewrite rows replayed them
    # again and then checked them with a third replay. The rows reuse the
    # classification's steps, so the route costs about one replay.
    original = _history(seeded_config, "[[a]] " * 30_000, 1)
    con = open_db(seeded_config.db_path)
    try:
        rows = ops_apply._block_rewrites(con, SRC)
    finally:
        con.close()
    once = loop_steps(MODULES, lambda: ops_core.classify_text_edit(
        SENT, text_hash(original), "current", rows))
    got = []
    route = loop_steps(MODULES, lambda: got.append(
        _post(client, [_stale_edit(original)])))
    assert got[0].status_code == 200, got[0].text[:300]
    assert got[0].json()["skipped"] == []
    assert route < 1.6 * once, (once, route)


@pytest.mark.parametrize("blocks", ["one", "each"])
def test_a_batch_stops_replaying_at_its_work_budget(
        client, seeded_config, blocks):
    # Each op replays ten steps over a 180,000-character copy. Past the
    # batch's budget the rest land as sent, so four times the ops cost
    # about the same work, not four times it. On one block the first edit
    # conflicts and the rest are identical to what it left; on a block
    # each, never edited before, every edit conflicts.
    uids = [uid_of(f"rbw_blk_{i:03d}") for i in range(20)] \
        if blocks == "each" else [SRC] * 20
    originals = {uid: _history(seeded_config, "[[a]] " * 30_000,
                               MAX_REPLAYED_REWRITES, uid)
                 for uid in dict.fromkeys(uids)}

    def run(first: int, ops: int) -> tuple[int, list[str]]:
        got = []
        work = loop_steps(MODULES, lambda: got.append(
            _post(client, [_stale_edit(originals[uid], uid)
                           for uid in uids[first:first + ops]])))
        assert got[0].status_code == 200, got[0].text[:300]
        return work, [s["reason"] for s in got[0].json()["skipped"]]

    (small, _), (large, skipped) = run(0, 4), run(4, 16)
    assert large < 2 * small, (small, large)
    assert skipped.count("text_limit") > 8


def test_once_the_budget_runs_out_later_edits_splice_nothing(
        client, seeded_config):
    # A copy of 62,000 characters nested to the cap reads 2.2M to unlink,
    # but its splice is short enough to pass the cheap check for a while
    # after the budget can no longer afford it. The edit that runs the
    # budget out spends the rest, so later ones stop before splicing and
    # measuring it: forty edits cost what eight do.
    copy = ("[[" * 31 + "[[T]]" + "]]" * 31) * (62_000 // 129)
    uids = [uid_of(f"rbw_deep_{i:03d}") for i in range(48)]
    originals = {uid: _history(seeded_config, copy, 1, uid) for uid in uids}

    def run(first: int, ops: int) -> tuple[int, list[str]]:
        got = []
        work = loop_steps(MODULES, lambda: got.append(
            _post(client, [_stale_edit(originals[uid], uid)
                           for uid in uids[first:first + ops]])))
        assert got[0].status_code == 200, got[0].text[:300]
        return work, [s["reason"] for s in got[0].json()["skipped"]]

    (small, _), (large, skipped) = run(0, 8), run(8, 40)
    # the 32 more edits, together, cost under a quarter of one replay
    assert large - small < small / 8 / 4, (small, large)
    assert skipped.count("text_limit") >= 32


def test_the_reviewed_batch_lands_every_op_in_bounded_time(
        client, seeded_config):
    # The review's shape: 500 tiny stale edits, each replaying ten steps
    # over a copy of about a megabyte nested two deep, just within the
    # per-step budget (0.55 s an unlink). Every op lands, as sent, under
    # today's conflict header; the block keeps its text.
    copy = ("[[[[a]]]]" + "x" * 991) * 999
    assert refs.link_nesting_depth(copy) * len(copy) <= \
        text_limits.MAX_UNLINK_WORK
    original = _history(seeded_config, copy, MAX_REPLAYED_REWRITES)
    started = time.perf_counter()
    r = _post(client, [_stale_edit(original)] * 500)
    elapsed = time.perf_counter() - started
    assert r.status_code == 200, r.text[:300]
    reasons = [s["reason"] for s in r.json()["skipped"]]
    assert len(reasons) == 500 and set(reasons) == {"text_limit"}
    assert _text(seeded_config, SRC) == "current"
    # generous: about 1 s here. The splices past the budget run in C, so
    # this is wall clock, not loop steps: splicing each op's megabyte
    # before judging the budget took about 55 s.
    assert elapsed < 20, elapsed



_UID = "uid_u0000002"
_STEPS = [("retitle", "A", "B"), ("retitle", "B", "C d"), ("unlink", "A", ""),
          ("unlink", "B", ""), ("inline", _UID, "copied [[A]] text"),
          ("inline", _UID, "[[B]] #A")]


@settings(max_examples=1500, deadline=None)
@given(st.lists(st.sampled_from(["[[A]]", "[[B]]", f"(({_UID}))", "#A", " ",
                                 "x", "[[Z]]", "A::", "[[ A ]]"]),
                max_size=8).map("".join),
       st.lists(st.lists(st.sampled_from(_STEPS), min_size=1, max_size=2),
                min_size=1, max_size=3),
       st.booleans(), st.booleans())
def test_the_rows_reuse_the_replay_and_record_the_same(
        sent_text, chain, stale_z, conflicting):
    # The classification's steps, looked up, give the rows a full replay
    # of every step gives: `_replay_step` is a pure function of what the
    # key holds. Unbudgeted, so neither side stops for work.
    stale = {canonical_title_of("Z")} if stale_z else set()
    hashes = [text_hash(f"t{i}") for i in range(len(chain) + 1)]
    rewrites = tuple(
        ops_core.BlockRewrite(hashes[i], hashes[i + 1], old, new, kind)
        for i, records in reversed(list(enumerate(chain)))
        for kind, old, new in records)
    sent = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"),
                        text=sent_text, base_text_hash=hashes[0])
    unlinked = unlink_stale_refs(
        sent_text, lambda raw: canonical_title_of(normalize_title(raw))
        in stale)
    current = "elsewhere" if conflicting else "unused"
    outcome = ops_core.classify_text_edit(unlinked, hashes[0], current,
                                          rewrites)
    if outcome.kind == "over_limit":
        return
    # the replay itself, against one that keeps nothing
    plain = unlinked
    for step in outcome.replayed:
        stepped, _ = ops_core._replay_step(plain, step, normalize_title)
        assert stepped is not None
        plain = stepped
    assert outcome.text == plain
    planned = (ops_core.UpdateText(sent.uid, outcome.text),)
    reused = ops_core.rewrite_effects(sent, planned, stale, normalize_title,
                                      outcome.replayed, outcome.text,
                                      outcome.known)
    replayed = ops_core.rewrite_effects(sent, planned, stale,
                                        normalize_title, outcome.replayed,
                                        outcome.text)
    assert reused == replayed
    event("rows" if reused else "no rows")
