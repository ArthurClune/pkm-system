"""What a block's rewrite rows cost an op of an `/api/ops` batch.

One stale edit linking many deleted titles records a step with a row per
title. Every later hashed edit made before that step replays it, in any
batch, for the rows' retention. Each such op read every row of the block,
canonicalised and sorted the step's titles, and, when the step changed
its text, recorded the whole step again as new rows, which the next op
then read back: work set by the server's history, not the request, and
quadratic in the ops of a batch. A batch now reads only the base hashes
an edit's walk reaches, charged to its replay budget, keeps them as it
records more, derives each step once, and charges the rows it records;
an identical row is never stored twice. Past the budget an edit lands as
sent."""
from __future__ import annotations

from collections.abc import Callable

from hypothesis import event, given, settings
from hypothesis import strategies as st
from scaling import loop_steps
from test_text_limits_rewrites import _scalar, _seed, _text

from pkm import refs, spans, text_limits, unlink
from pkm.contracts.ops import BlockUid, Sha256Hex, SyncSeq, text_hash
from pkm.refs import normalize_title
from pkm.server import ops_apply, ops_core
from pkm.server.config import Config
from pkm.server.db import open_db
from pkm.test_data.ids import batch_id_of, client_id_of, seq_of, uid_of

MODULES = (unlink, refs, spans, ops_core, ops_apply, text_limits)
ORIGINAL = "the text the step started from"
_batch_counter = 0
_block_counter = 0


def _skipped(client, ops, seen_seq: SyncSeq | None = None) -> list[str]:
    """Post one batch; the reasons its ack gives for the ops it skipped."""
    global _batch_counter
    _batch_counter += 1
    body: dict[str, object] = {
        "client_id": client_id_of("steptitles"),
        "batch_id": batch_id_of(f"rst_{_batch_counter:08d}"), "ops": ops}
    if seen_seq is not None:
        body["seen_seq"] = seen_seq
    r = client.post("/api/ops", json=body)
    assert r.status_code == 200, r.text[:300]
    return [s["reason"] for s in r.json()["skipped"]]


def _post(client, ops, seen_seq: SyncSeq | None = None) -> None:
    _skipped(client, ops, seen_seq)


def _fresh_uid() -> BlockUid:
    global _block_counter
    _block_counter += 1
    return uid_of(f"rst_blk_{_block_counter:04d}")


def _insert_rows(config, uid: BlockUid,
                 rows: list[tuple[str, str, str, str, str]]) -> None:
    """`(base_hash, after_hash, kind, old, new)` rows for `uid`, written in
    that order, so the last is the newest."""
    con = open_db(config.db_path)
    try:
        con.executemany(
            "INSERT INTO block_rewrites(uid, base_hash, after_hash,"
            " old_title, new_title, created_at, kind)"
            " VALUES (?,?,?,?,?,?,?)",
            [(uid, base, after, old, new, i, kind)
             for i, (base, after, kind, old, new) in enumerate(rows)])
        con.commit()
    finally:
        con.close()


def _titled_step(config: Config, k: int) -> BlockUid:
    """A fresh block holding `current`, whose one recorded step, from
    `ORIGINAL`, unlinked `k` titles: what one stale edit linking `k`
    deleted titles leaves."""
    uid = _fresh_uid()
    _seed(config, [(uid, "Src", "current")])
    _insert_rows(config, uid, [
        (text_hash(ORIGINAL), text_hash("after"), "unlink", f"t{i}", "")
        for i in range(k)])
    return uid


def _edits(uid: BlockUid, texts: list[str]) -> list[dict[str, object]]:
    return [{"op": "update_text", "uid": uid, "text": text,
             "base_text_hash": text_hash(ORIGINAL)} for text in texts]


def _rows_of(config, uid: BlockUid) -> object:
    return _scalar(config, "SELECT count(*) AS n FROM block_rewrites"
                   " WHERE uid = ?", (uid,))


def _per_op(work: Callable[[int, int], int], k: int, few: int,
            many: int) -> int:
    """The work `many - few` more ops add against a step of `k` titles:
    what each op costs, less what the batch pays once."""
    return work(k, many) - work(k, few)


def test_tiny_edits_after_a_step_of_many_titles_cost_the_same_per_op(
        client, seeded_config):
    # Each edit is a few characters and changes nothing the step names,
    # so it records no rows. Its replay read every row, rebuilt the steps
    # and canonicalised every title of the step, per op.
    def work(k: int, ops: int) -> int:
        uid = _titled_step(seeded_config, k)
        return loop_steps(MODULES, lambda: _post(
            client, _edits(uid, [f"x{i}" for i in range(ops)])))

    small = _per_op(work, 100, 10, 40)
    large = _per_op(work, 10_000, 10, 40)
    assert large < 1.5 * small, (small, large)


def test_edits_a_step_changes_cost_what_the_budget_affords(
        client, seeded_config):
    # Each edit links one of the step's titles, so the step changes it and
    # the op records the whole step again, and the batch's next op read
    # those rows back: quadratic in the ops. The rows are charged now, so
    # a few edits record them and the rest land as sent; four times the
    # ops cost about what the budget does.
    k = 20_000

    def work(ops: int) -> tuple[int, list[str]]:
        uid = _titled_step(seeded_config, k)
        got: list[list[str]] = []

        def run() -> None:
            got.append(_skipped(client, _edits(
                uid, [f"[[t0]] y{i}" for i in range(ops)])))

        return loop_steps(MODULES, run), got[0]

    (few, _), (many, skipped) = work(10), work(40)
    assert many < 1.5 * few, (few, many)
    assert skipped.count("text_limit") > 30


def test_an_op_a_step_changes_records_the_whole_step(client, seeded_config):
    # The next edit of the client's queue is hashed on what this op sent
    # and replays these rows, so they name every title of the step, not
    # only the one this text links.
    k = 50
    uid = _titled_step(seeded_config, k)
    _post(client, _edits(uid, [f"[[t0]] y{i}" for i in range(3)]))
    assert _rows_of(seeded_config, uid) == k + 3 * k
    assert _text(seeded_config, uid) == "t0 y2"


def test_a_batch_reads_a_hashs_rows_once_however_many_ops_record(
        client, seeded_config, monkeypatch):
    # Each op that recorded rows dropped the block's rows from the batch's
    # cache, so the next op read every row again.
    uid = _titled_step(seeded_config, 50)
    read = [0]
    real = ops_apply._rewrites_within

    def counted(db, block: BlockUid, base: Sha256Hex, allowance: int):
        got = real(db, block, base, allowance)
        read[0] += 0 if got is None else len(got[0])
        return got

    monkeypatch.setattr(ops_apply, "_rewrites_within", counted)
    _post(client, _edits(uid, [f"[[t0]] y{i}" for i in range(10)]))
    assert read[0] == 50
    assert _rows_of(seeded_config, uid) == 50 + 10 * 50


def test_an_edit_replays_the_rows_its_own_batch_recorded(
        client, seeded_config):
    # The batch keeps the rows it records in what it read: the same
    # device's next edit, hashed against the text it sent, replays them
    # onto the text the server wrote, and applies cleanly. The second
    # edit's rows are the first's, stored once; the third records its own.
    uid = _titled_step(seeded_config, 3)
    sent = "[[t0]] [[t1]] y"
    _post(client, [
        *_edits(uid, [sent, sent]),
        {"op": "update_text", "uid": uid, "text": f"{sent} more",
         "base_text_hash": text_hash(sent)}])
    assert _text(seeded_config, uid) == "t0 t1 y more"
    assert _rows_of(seeded_config, uid) == 3 + 3 + 3


def test_tiny_edits_cost_the_same_per_op_however_many_steps_the_block_has(
        client, seeded_config):
    # The steps were rebuilt from every row and searched one by one for
    # the edit's base, per op: work set by the block's stored rows.
    def work(steps: int, ops: int) -> int:
        uid = _fresh_uid()
        _seed(seeded_config, [(uid, "Src", "current")])
        _insert_rows(seeded_config, uid, [
            (text_hash(ORIGINAL), text_hash("after"), "unlink", "t", ""),
            *((text_hash(f"other {i}"), text_hash(f"after {i}"), "unlink",
               "t", "") for i in range(steps))])
        return loop_steps(MODULES, lambda: _post(
            client, _edits(uid, [f"x{i}" for i in range(ops)])))

    small = _per_op(work, 20, 10, 40)
    large = _per_op(work, 2_000, 10, 40)
    assert large < 1.5 * small, (small, large)


def test_an_edit_reads_only_the_rows_its_walk_reaches(client, seeded_config):
    # An ordinary edit, hashed on the text the block holds, has no step
    # to replay; it read every row the block held all the same.
    def work(rows: int) -> int:
        uid = _fresh_uid()
        _seed(seeded_config, [(uid, "Src", "current")])
        _insert_rows(seeded_config, uid, [
            (text_hash(ORIGINAL), text_hash("after"), "unlink", f"t{i}", "")
            for i in range(rows)])
        return loop_steps(MODULES, lambda: _post(client, [
            {"op": "update_text", "uid": uid, "text": "edited",
             "base_text_hash": text_hash("current")}]))

    assert work(100_000) < 1.5 * work(1_000)


def test_rows_past_the_budget_cost_what_the_budget_does(
        client, seeded_config, monkeypatch):
    # The edit's base hash holds more rows than the batch may read. They
    # were read whole; now the read measures what the budget could pay
    # for, stops, and the edit lands as sent.
    monkeypatch.setattr(ops_apply, "MAX_BATCH_REPLAY_WORK",
                        1_000 * ops_core.ROW_CHARS)

    def work(k: int) -> tuple[int, list[str]]:
        uid = _titled_step(seeded_config, k)
        got: list[list[str]] = []
        steps = loop_steps(MODULES, lambda: got.append(
            _skipped(client, _edits(uid, ["x"]))))
        return steps, got[0]

    (small, skipped), (large, _) = work(5_000), work(50_000)
    assert skipped == ["text_limit"]
    assert large < 1.5 * small, (small, large)


def test_one_statement_charges_a_hashs_rows_and_reads_only_what_fits(
        seeded_config):
    # The charge and the read are one statement. Its sum is each row's
    # titles in bytes and ROW_CHARS; past the allowance it joins no row,
    # so no title the batch cannot pay for is loaded, and the read
    # returns None.
    uid = _fresh_uid()
    base = text_hash(ORIGINAL)
    _insert_rows(seeded_config, uid, [
        (base, text_hash("after"), "unlink", f"é{i}", "") for i in range(5)]
        + [(text_hash("other"), text_hash("after"), "unlink", "o", "")])
    each = ops_core.ROW_CHARS + len("é0".encode())
    con = open_db(seeded_config.db_path)
    try:
        def read(allowance: int):
            return ops_apply._rewrites_within(con, uid, base, allowance)

        def raw(allowance: int):
            return con.select(ops_apply._CHARGED_REWRITES, {
                "uid": uid, "base_hash": base, "allowance": allowance,
                "row_chars": ops_core.ROW_CHARS,
                "rows": allowance // ops_core.ROW_CHARS + 1})

        got = read(5 * each)
        assert got is not None
        rows, cost = got
        assert cost == 5 * each
        assert [r.old_text for r in rows] == [f"é{i}" for i in range(4, -1, -1)]
        assert read(5 * each - 1) is None
        assert [(r["rewrite_old_text"], r["n"]) for r in raw(5 * each - 1)] \
            == [("", 5 * each)]
        # past the rows the allowance could pay for, none are measured
        assert [r["n"] for r in raw(2 * each)] == [3 * each]
        assert read(0) is None
        assert ops_apply._rewrites_within(
            con, uid, text_hash("nothing"), 0) == ((), 0)
        assert ops_apply._rewrites_within(
            con, uid, text_hash("other"), each) == (
                (ops_core.BlockRewrite(text_hash("other"), text_hash("after"),
                                       "o", "", "unlink"),),
                ops_core.ROW_CHARS + 1)
    finally:
        con.close()


def test_an_edit_whose_rows_cost_past_the_budget_lands_every_link_plain(
        client, seeded_config, monkeypatch):
    # Rows too costly to read leave the titles the chain deleted unknown,
    # so the landing makes every link plain: any could name a deleted page,
    # and left linked it would re-create it. The block keeps its text.
    monkeypatch.setattr(ops_apply, "MAX_BATCH_REPLAY_WORK",
                        10 * ops_core.ROW_CHARS)
    uid = _titled_step(seeded_config, 100)
    assert _skipped(client, _edits(uid, ["[[t0]] [[AI]] #t1 x"])) == \
        ["text_limit"]
    assert _text(seeded_config, uid) == "current"
    assert _scalar(seeded_config, "SELECT count(*) AS n FROM blocks"
                   " WHERE text = 't0 AI t1 x'") == 1
    assert _scalar(seeded_config, "SELECT count(*) AS n FROM pages"
                   " WHERE title IN ('t0', 't1')") == 0


def test_the_same_stale_edit_posted_again_adds_no_rows(
        client, seeded_config):
    # Each post of one stale edit recorded its unlink's rows again, so
    # posting it repeatedly multiplied the block's rows without bound.
    k = 1_000
    con = open_db(seeded_config.db_path)
    try:
        con.executemany("INSERT INTO page_deletions(title, seq, deleted_at)"
                        " VALUES (?, 1, 0)", [(f"t{i}",) for i in range(k)])
        con.commit()
    finally:
        con.close()
    text = " ".join(f"[[t{i}]]" for i in range(k))
    for _ in range(3):
        _post(client, [{"op": "update_text", "uid": "uid_b4", "text": text}],
              seen_seq=seq_of(0))
    assert _rows_of(seeded_config, uid_of("uid_b4")) == k


def test_a_batch_touching_many_blocks_reads_what_its_budget_pays_for(
        client, seeded_config, monkeypatch):
    # One tiny edit each on blocks whose step holds many titles: the batch
    # read every block's rows, however many blocks it touched. The reads
    # are charged now, so past the budget the edits land as sent.
    monkeypatch.setattr(ops_apply, "MAX_BATCH_REPLAY_WORK",
                        5 * 2_000 * (ops_core.ROW_CHARS + 5))

    def work(blocks: int) -> int:
        uids = [_titled_step(seeded_config, 2_000) for _ in range(blocks)]
        return loop_steps(MODULES, lambda: _post(
            client, [op for uid in uids for op in _edits(uid, ["x"])]))

    assert work(40) < 1.5 * work(10)


def test_a_row_is_stored_again_under_another_step_of_the_same_text(
        client, seeded_config):
    # The same stale text sent with two `seen_seq`s unlinks two sets of
    # titles from it: two steps from one hash, both naming t0. The second
    # step's t0 row is no copy of the first's, and without it the client's
    # next edit, which replays the newest step, would leave t0 linked.
    con = open_db(seeded_config.db_path)
    try:
        con.executemany("INSERT INTO page_deletions(title, seq, deleted_at)"
                        " VALUES (?, ?, 0)", [("t1", 5), ("t0", 10)])
        con.commit()
    finally:
        con.close()
    x = _fresh_uid()
    _seed(seeded_config, [(x, "Src", "current")])
    sent = "[[t0]] [[t1]] w"
    _post(client, [{"op": "update_text", "uid": x, "text": sent}], seen_seq=seq_of(7))
    _post(client, [{"op": "update_text", "uid": x, "text": sent}], seen_seq=seq_of(0))
    # t0 from the first step; t0 and t1 from the second
    assert _rows_of(seeded_config, x) == 3
    _post(client, [{"op": "update_text", "uid": x, "text": "[[t0]] [[t1]] z",
                    "base_text_hash": text_hash(sent)}])
    assert _text(seeded_config, x) == "t0 t1 z"


def test_edits_past_the_budget_cost_the_same_per_op_however_many_titles(
        client, seeded_config, monkeypatch):
    # With the budget spent each edit lands as sent, its links made plain.
    # The step's titles were canonicalised again for every op.
    monkeypatch.setattr(ops_apply, "MAX_BATCH_REPLAY_WORK", 0)

    def work(k: int, ops: int) -> int:
        uid = _titled_step(seeded_config, k)
        return loop_steps(MODULES, lambda: _post(
            client, _edits(uid, [f"[[t0]] x{i}" for i in range(ops)])))

    small = _per_op(work, 100, 10, 40)
    large = _per_op(work, 10_000, 10, 40)
    assert large < 1.5 * small, (small, large)


def test_each_step_derives_its_titles_once_per_batch(
        client, seeded_config, monkeypatch):
    # Canonicalising a step's titles is work in the step's size; part of
    # it runs in C, which loop steps do not see, so this counts how often
    # it runs.
    uid = _titled_step(seeded_config, 1_000)
    derived = [0]
    real = ops_core._derive

    def counted(step, canonical):
        derived[0] += 1
        return real(step, canonical)

    monkeypatch.setattr(ops_core, "_derive", counted)
    _post(client, _edits(uid, [f"x{i}" for i in range(20)]))
    assert derived[0] == 1


def test_the_rows_a_batch_records_for_its_replays_fit_its_budget(
        client, seeded_config):
    # A delete step inlined a copy dense with links to the step's own
    # titles. Each tiny edit referring to the copy replays it, unlinks
    # every link and records the step again, a row per title and the copy:
    # writing them costs more than reading the links, which was all the
    # budget charged. The rows are charged too, so the batch writes no
    # more of them than its budget, and the edits past it land as sent.
    k = 2_000
    copy = " ".join(f"[[t{i}]]" for i in range(k))
    ref = f"(({_UID}))"
    uid = _fresh_uid()
    _seed(seeded_config, [(uid, "Src", "current")])
    _insert_rows(seeded_config, uid, [
        (text_hash(ref), text_hash("after"), "inline", _UID, copy),
        *((text_hash(ref), text_hash("after"), "unlink", f"t{i}", "")
          for i in range(k))])
    _post(client, [{"op": "update_text", "uid": uid, "text": f"{ref} x{i}",
                    "base_text_hash": text_hash(ref)} for i in range(500)])
    recorded = _scalar(
        seeded_config,
        "SELECT sum(? + length(old_title) + length(new_title)) AS n"
        " FROM block_rewrites WHERE uid = ? AND base_hash <> ?",
        (ops_core.ROW_CHARS, uid, text_hash(ref)))
    assert isinstance(recorded, int)
    assert 0 < recorded <= ops_core.MAX_BATCH_REPLAY_WORK, recorded


def test_a_step_keeps_its_key_for_every_op():
    # The step's share of its key is frozensets of its titles, built once:
    # rebuilt for each op, it hashed every title per op, in C.
    step = ops_core.RewriteStep(text_hash("a"), text_hash("b"), {},
                                {f"t{i}" for i in range(100)}, {})
    first = ops_core._step_key("x0", step, normalize_title)
    assert ops_core._step_key("x1", step, normalize_title)[1] is first[1]


# --- a later edit of the same queue -----------------------------------------
#
# A replay's rows are keyed by the text the op sent, and the client's next
# queued edit is hashed on that text. These pin what that edit gets when it
# adds back a ref or link the op's own text had dropped.


def test_a_queued_edit_that_adds_a_ref_back_gets_its_copy(
        client, seeded_config):
    ua, ub, x = uid_of("rruaaa"), uid_of("rrubbb"), uid_of("rrxxxx")
    _seed(seeded_config, [(ua, "Gone", "alpha"), (ub, "Gone", "beta")])
    t0 = f"(({ua})) (({ub})) x"
    _seed(seeded_config, [(x, "Src", t0)])
    assert client.delete("/api/page/Gone").status_code == 200
    e1 = f"(({ua})) y"
    _post(client, [
        {"op": "update_text", "uid": x, "text": e1,
         "base_text_hash": text_hash(t0)},
        {"op": "update_text", "uid": x, "text": f"(({ua})) (({ub})) z",
         "base_text_hash": text_hash(e1)}])
    assert _text(seeded_config, x) == "alpha beta z"


def test_a_queued_edit_that_adds_a_link_back_does_not_recreate_the_page(
        client, seeded_config):
    # The second batch carries no seen_seq, so no stale unlink catches it.
    x = uid_of("rrx222")
    _seed(seeded_config, [(x, "Src2", "current")])
    con = open_db(seeded_config.db_path)
    try:
        con.executemany("INSERT INTO page_deletions(title, seq, deleted_at)"
                        " VALUES (?, 1, 0)", [("rra",), ("rrb",)])
        con.commit()
    finally:
        con.close()
    e0 = "[[rra]] [[rrb]] w"
    _post(client, [{"op": "update_text", "uid": x, "text": e0}], seen_seq=seq_of(0))
    e1 = "[[rra]] y"
    _post(client, [
        {"op": "update_text", "uid": x, "text": e1,
         "base_text_hash": text_hash(e0)},
        {"op": "update_text", "uid": x, "text": "[[rra]] [[rrb]] z",
         "base_text_hash": text_hash(e1)}])
    assert _text(seeded_config, x) == "rra rrb z"
    assert _scalar(seeded_config, "SELECT count(*) AS n FROM pages"
                   " WHERE title = 'rrb'") == 0


# --- the batch's history ---------------------------------------------------

_UID = "uid_u0000002"
_HASHES = [text_hash(f"h{i}") for i in range(4)]
_ROW = st.tuples(st.sampled_from(_HASHES), st.sampled_from(_HASHES),
                 st.sampled_from(["unlink", "retitle", "inline"]),
                 st.sampled_from(["a", "b", _UID]),
                 st.sampled_from(["", "c", "d"]))


def _rows(drawn) -> tuple[ops_core.BlockRewrite, ...]:
    """Drawn rows in the order written."""
    return tuple(ops_core.BlockRewrite(base, after, old, new, kind)
                 for base, after, kind, old, new in drawn)


def _walks(history: ops_core.RewriteHistory
           ) -> dict[Sha256Hex, list[tuple[object, ...]]]:
    """Each base hash's steps, newest first, as what they hold."""
    out: dict[Sha256Hex, list[tuple[object, ...]]] = {}
    for base in _HASHES:
        taken: set[int] = set()
        while (step := history.newest(base, taken)) is not None:
            taken.add(id(step))
            out.setdefault(base, []).append(
                (step.after_hash, list(step.retitles.items()),
                 step.unlinked, list(step.inlines.items())))
    return out


@settings(max_examples=1000, deadline=None)
@given(st.lists(_ROW, max_size=8),
       st.lists(st.lists(_ROW, min_size=1, max_size=4), max_size=3),
       st.lists(st.sampled_from(_HASHES), max_size=4))
def test_a_batch_keeps_the_rows_it_reads_and_records_as_a_read_of_all(
        stored, recorded, reached):
    # The batch reads one base hash's rows at a time, in the order its
    # walks reach them, then keeps what it records. The rows it records
    # are newer than every stored row, and read back newest first they
    # come in reverse of the order they were written. For each hash it
    # has read, its steps are the ones a read of every row makes, in the
    # same order.
    newest_first = list(reversed(_rows(stored)))
    history = ops_core.RewriteHistory.lazy()
    for base in reached:
        if not history.is_read(base):
            history.add_read(base, [r for r in newest_first
                                    if r.base_hash == base])
    for rows in recorded:
        for base in {b for b, *_ in rows}:
            if not history.is_read(base):
                history.add_read(base, [r for r in newest_first
                                        if r.base_hash == base])
        history.record(_rows(rows))
        newest_first = [*reversed(_rows(rows)), *newest_first]
    whole = ops_core.RewriteHistory(newest_first)
    read = {b for b in _HASHES if history.is_read(b)}
    assert {b: w for b, w in _walks(history).items() if b in read} == \
        {b: w for b, w in _walks(whole).items() if b in read}
    for base in read:
        assert history.stored(base) == whole.stored(base)
    stored_pairs = {(b, a) for b, a, *_ in stored}
    if any((b, a) in stored_pairs for rows in recorded
           for b, a, *_ in rows):
        event("a recorded row joins a step the batch read")
    if read and len(read) < len({b for b, *_ in stored}):
        event("some hashes never read")


def test_a_walk_stops_blind_at_a_hash_too_costly_to_read():
    # The shell reads each hash the walk reaches; one too costly is marked
    # unread, and the replay stops there, an over_limit edit whose landing
    # knows no titles.
    history = ops_core.RewriteHistory.lazy()
    first, second = text_hash("a"), text_hash("b")
    assert history.next_unread(first) == first
    history.add_read(first, [ops_core.BlockRewrite(first, second, "z", "",
                                                   "unlink")])
    assert history.next_unread(first) == second
    history.add_unread(second)
    assert history.next_unread(first) is None
    outcome = ops_core.classify_text_edit("[[z]] [[y]]", first, "current",
                                          history)
    assert outcome.kind == "over_limit" and outcome.blind
    assert ops_core.over_limit_landing_text(
        "[[z]] [[y]] #w", outcome.replayed, normalize_title, True) == "z y w"
