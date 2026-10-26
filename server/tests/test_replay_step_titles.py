"""What a replayed step's titles cost an op of an `/api/ops` batch.

One stale edit linking many deleted titles records a step with a row per
title. Every later hashed edit made before that step replays it, in any
batch, for the rows' retention. Each such op rebuilt the block's steps
from every row, canonicalised and sorted the step's titles, and, when the
step changed its text, recorded the whole step again as new rows, which
the next op then read back: work set by the server's history, not the
request, and quadratic in the ops of a batch. A block's steps are now
built once per batch and kept as the batch records more, their titles
derived once, and an op records only the titles, renames and copies the
step moved in its own text."""
from __future__ import annotations

from collections.abc import Callable

from hypothesis import event, given, settings
from hypothesis import strategies as st
from scaling import loop_steps
from test_text_limits_rewrites import _scalar, _seed, _text

from pkm import refs, spans, text_limits, unlink
from pkm.contracts.ops import (BlockUid, RewriteKind, Sha256Hex,
                               UpdateTextOp, text_hash)
from pkm.refs import CanonicalTitle, normalize_title
from pkm.server import ops_apply, ops_core
from pkm.server.config import Config
from pkm.server.db import open_db
from pkm.test_data.ids import batch_id_of, canonical_title_of, client_id_of, uid_of
from pkm.unlink import unlink_stale_refs

MODULES = (unlink, refs, spans, ops_core, ops_apply, text_limits)
ORIGINAL = "the text the step started from"
_batch_counter = 0
_block_counter = 0


def _post(client, ops) -> None:
    global _batch_counter
    _batch_counter += 1
    r = client.post("/api/ops", json={
        "client_id": client_id_of("steptitles"),
        "batch_id": batch_id_of(f"rst_{_batch_counter:08d}"),
        "ops": ops})
    assert r.status_code == 200, r.text[:300]


def _fresh_uid() -> BlockUid:
    global _block_counter
    _block_counter += 1
    return uid_of(f"rst_blk_{_block_counter:04d}")


def _insert_rows(config, uid: BlockUid,
                 rows: list[tuple[str, str, str, str, str]]) -> None:
    """`(base_hash, after_hash, kind, old, new)` rows for `uid`, the first
    the newest."""
    con = open_db(config.db_path)
    try:
        con.executemany(
            "INSERT INTO block_rewrites(uid, base_hash, after_hash,"
            " old_title, new_title, created_at, kind)"
            " VALUES (?,?,?,?,?,?,?)",
            [(uid, base, after, old, new, len(rows) - i, kind)
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
    # so it records no rows. Its replay rebuilt the steps from every row
    # and canonicalised every title of the step, per op.
    def work(k: int, ops: int) -> int:
        uid = _titled_step(seeded_config, k)
        return loop_steps(MODULES, lambda: _post(
            client, _edits(uid, [f"x{i}" for i in range(ops)])))

    small = _per_op(work, 100, 10, 40)
    large = _per_op(work, 10_000, 10, 40)
    assert large < 1.5 * small, (small, large)


def test_an_op_a_step_changes_records_only_the_titles_it_links(
        client, seeded_config):
    # The step unlinks the one title each edit links. The rows then named
    # every title of the step, so each op added a row per title.
    k = 2_000
    uid = _titled_step(seeded_config, k)
    _post(client, _edits(uid, [f"[[t0]] y{i}" for i in range(5)]))
    assert _rows_of(seeded_config, uid) == k + 5
    assert _scalar(seeded_config, "SELECT count(*) AS n FROM block_rewrites"
                   " WHERE uid = ? AND old_title = 't0'", (uid,)) == 6
    assert _text(seeded_config, uid) == "t0 y4"


def test_edits_a_step_changes_cost_the_same_per_op_however_many_titles(
        client, seeded_config):
    # The quadratic shape: each op recorded the step's every title again,
    # and the next op of the batch read those rows back.
    def work(k: int, ops: int) -> int:
        uid = _titled_step(seeded_config, k)
        return loop_steps(MODULES, lambda: _post(
            client, _edits(uid, [f"[[t0]] y{i}" for i in range(ops)])))

    small = _per_op(work, 40, 5, 20)
    large = _per_op(work, 4_000, 5, 20)
    assert large < 1.5 * small, (small, large)


def test_a_batch_reads_a_blocks_rows_once_however_many_ops_record(
        client, seeded_config, monkeypatch):
    # Each op that recorded rows dropped the block's rows from the batch's
    # cache, so the next op read every row again.
    uid = _titled_step(seeded_config, 50)
    read = [0]
    real = ops_apply._block_rewrites

    def counted(db, block: BlockUid):
        rows = real(db, block)
        read[0] += len(rows)
        return rows

    monkeypatch.setattr(ops_apply, "_block_rewrites", counted)
    _post(client, _edits(uid, [f"[[t0]] y{i}" for i in range(10)]))
    assert read[0] == 50
    assert _rows_of(seeded_config, uid) == 60


def test_an_edit_replays_the_rows_its_own_batch_recorded(
        client, seeded_config):
    # The batch keeps the rows it records in what it read: the same
    # device's next edit, hashed against the text it sent, replays them
    # onto the text the server wrote, and applies cleanly. Twice the same
    # rows, then a third edit: the step they share replays once.
    uid = _titled_step(seeded_config, 3)
    sent = "[[t0]] [[t1]] y"
    _post(client, [
        *_edits(uid, [sent, sent]),
        {"op": "update_text", "uid": uid, "text": f"{sent} more",
         "base_text_hash": text_hash(sent)}])
    assert _text(seeded_config, uid) == "t0 t1 y more"


def test_tiny_edits_cost_the_same_per_op_however_many_steps_the_block_has(
        client, seeded_config):
    # The steps were rebuilt from every row and searched one by one for
    # the edit's base, per op: work set by the block's stored rows.
    def work(steps: int, ops: int) -> int:
        uid = _fresh_uid()
        _seed(seeded_config, [(uid, "Src", "current")])
        _insert_rows(seeded_config, uid, [
            (text_hash(f"other {i}"), text_hash(f"after {i}"), "unlink",
             "t", "") for i in range(steps)] + [
            (text_hash(ORIGINAL), text_hash("after"), "unlink", "t", "")])
        return loop_steps(MODULES, lambda: _post(
            client, _edits(uid, [f"x{i}" for i in range(ops)])))

    small = _per_op(work, 20, 10, 40)
    large = _per_op(work, 2_000, 10, 40)
    assert large < 1.5 * small, (small, large)


def test_edits_past_the_budget_cost_the_same_per_op_however_many_titles(
        client, seeded_config, monkeypatch):
    # With the budget spent each edit lands as sent, its links to the
    # step's titles made plain. The titles the landing matches were
    # canonicalised again for every op.
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
    # Canonicalising and keying a step's titles is work in the step's
    # size; part of it runs in C, which loop steps do not see, so this
    # counts how often it runs.
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
    # every link and records a row per title and the copy again: writing
    # them costs more than reading the links, which was all the budget
    # charged. The rows are charged too, so the batch writes no more of
    # them than its budget, and the edits past it land as sent.
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


# --- the rows an op records ------------------------------------------------

_UID = "uid_u0000002"
_TOKENS = ["[[z]]", "[[y]]", "[[y z]]", "[[ z ]]", "[[z [[y]]]]", "#z", "#y",
           "#[[y z]]", "[[", "]]", "[", "]", "(", ")", "`", " ", "\n", "x",
           "z::", "y z::", "[#z](", "[lbl](", "zy", "#", "[[w]]",
           "{{embed [[z]]}}", f"(({_UID}))", "[[a[]]"]
_TITLES = ["z", "y", "y z", "z y", "zy", "w", " z", "a["]
_COPIES = ["[[z]] copied", "#y [[w]]", "[[z [[y]]]]", "`[[z]]` x", "plain"]
_RECORD = st.one_of(
    st.tuples(st.just("unlink"), st.sampled_from(_TITLES), st.just("")),
    st.tuples(st.just("retitle"), st.sampled_from(["z", "y", "w"]),
              st.sampled_from(["v", "v v", "z"])),
    st.tuples(st.just("inline"), st.just(_UID), st.sampled_from(_COPIES)))


def _today_chain(
        sent: str, written: str, stale: tuple[CanonicalTitle, ...],
        replayed: list[ops_core.RewriteStep],
        canonical: Callable[[str], str],
) -> tuple[ops_core.BlockRewrite, ...]:
    """The rows before they were narrowed: each replayed step recorded
    with every title, rename and copy it holds."""
    rows: list[ops_core.BlockRewrite] = []
    text, base = sent, text_hash(sent)

    def record(after: str, records) -> None:
        nonlocal text, base
        if after != text:
            rows.extend(ops_core.BlockRewrite(base, text_hash(after), old,
                                              new, kind)
                        for kind, old, new in records)
            base = text_hash(after)
        text = after

    if stale:
        record(unlink_stale_refs(
            sent, lambda raw: canonical(normalize_title(raw)) in stale),
            [("unlink", t, "") for t in stale])
    for step in replayed:
        after, _ = ops_core._replay_step(text, step, canonical)
        if after is None:
            return ()
        record(after, [*(("retitle", o, n) for o, n in step.retitles.items()),
                       *(("unlink", t, "") for t in sorted(step.unlinked)),
                       *(("inline", u, c) for u, c in step.inlines.items())])
    if text != written or not rows:
        return ()
    return tuple(rows)


def _passes(rows: tuple[ops_core.BlockRewrite, ...]
            ) -> list[tuple[Sha256Hex, Sha256Hex]]:
    return list(dict.fromkeys((r.base_hash, r.after_hash) for r in rows))


@settings(max_examples=2000, deadline=None)
@given(st.lists(st.sampled_from(_TOKENS), max_size=10).map("".join),
       st.lists(st.lists(_RECORD, min_size=1, max_size=5),
                min_size=1, max_size=3),
       st.sets(st.sampled_from(_TITLES), max_size=2),
       st.booleans(), st.booleans())
def test_the_rows_an_op_records_replay_as_every_title_did(
        sent_text, chain, stale_titles, conflicting, plain_space):
    # An op records, for each step it replayed, only what the step moved
    # in its text. Replayed onto the text the op sent, those rows make
    # the text the whole step's rows made, and they are some of those
    # rows, pass for pass.
    def canonical(raw: str) -> CanonicalTitle:
        return canonical_title_of(
            refs.canonicalize_title(raw, plain_space=plain_space))

    stale = {canonical(t) for t in stale_titles}
    hashes = [text_hash(f"t{i}") for i in range(len(chain) + 1)]
    rewrites = tuple(
        ops_core.BlockRewrite(hashes[i], hashes[i + 1], old, new, kind)
        for i, records in reversed(list(enumerate(chain)))
        for kind, old, new in records)
    sent = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"),
                        text=sent_text, base_text_hash=hashes[0])
    unlinked = unlink_stale_refs(
        sent_text, lambda raw: canonical(normalize_title(raw)) in stale)
    current = "elsewhere" if conflicting else "unused"
    outcome = ops_core.classify_text_edit(unlinked, hashes[0], current,
                                          rewrites, canonical)
    if outcome.kind == "over_limit":
        event("over limit")
        return
    planned = (ops_core.UpdateText(sent.uid, outcome.text),)
    got = ops_core.rewrite_effects(sent, planned, stale, canonical,
                                   outcome.replayed, outcome.text)
    titles = ops_core.stale_titles_linked(sent_text, stale, canonical)
    # As `apply_batch` calls it, the steps looked up: the same rows, bar
    # when the titles the rows name unlink less than all the stale ones,
    # so the chain meets other texts than the classification did and,
    # given `known`, records none (as before the rows were narrowed).
    looked_up = ops_core.rewrite_effects(sent, planned, stale, canonical,
                                         outcome.replayed, outcome.text,
                                         outcome.known)
    named = unlink_stale_refs(
        sent_text, lambda raw: canonical(normalize_title(raw)) in titles)
    if named == unlinked:
        assert looked_up == got
    else:
        assert looked_up in (got, ())
        if looked_up != got:
            event("looked up, the named titles unlink less: no rows")
    today = _today_chain(sent_text, outcome.text, titles,
                         list(outcome.replayed), canonical) \
        if (titles or outcome.replayed) and outcome.text != sent_text else ()
    rows: tuple[ops_core.BlockRewrite, ...] = ()
    if got:
        assert isinstance(got[0], ops_core.RecordRewrite)
        rows = got[0].rewrites
    assert bool(rows) == bool(today)
    if not rows:
        event("no rows")
        return
    assert set(rows) <= set(today)
    # the same passes, in the same order
    assert _passes(rows) == _passes(today)
    # replayed from scratch, nothing looked up
    for recorded in (rows, today):
        assert ops_core._replay(sent_text, text_hash(sent_text), recorded,
                                canonical).text == outcome.text
    event("rows")
    if len(rows) < len(today):
        event("narrower than every title")
        for token, name in (("[[z [[y]]]]", "nested"), ("](", "aliased"),
                            ("::", "attribute"), ("`", "code span")):
            if token in sent_text:
                event(f"narrower, {name} text")
    if any(r.kind == "unlink" for r in rows) and \
            {r.old_text for r in rows if r.kind == "unlink"} < \
            {r.old_text for r in today if r.kind == "unlink"}:
        event("a step's titles linked in part")
    if any(r.kind == "inline" for r in today) and \
            not any(r.kind == "inline" for r in rows):
        event("a copy the text did not ref")
    if any(r.kind == "retitle" for r in today) and \
            len([r for r in rows if r.kind == "retitle"]) < \
            len([r for r in today if r.kind == "retitle"]):
        event("a rename the text did not name")


# --- the batch's history ---------------------------------------------------

_HASHES = [text_hash(f"h{i}") for i in range(4)]
_ROW = st.tuples(st.sampled_from(_HASHES), st.sampled_from(_HASHES),
                 st.sampled_from(["unlink", "retitle", "inline"]),
                 st.sampled_from(["a", "b", _UID]),
                 st.sampled_from(["", "c", "d"]))


def _rows(drawn) -> tuple[ops_core.BlockRewrite, ...]:
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
       st.lists(st.lists(_ROW, min_size=1, max_size=4), max_size=3))
def test_a_batch_keeps_the_rows_it_records_as_a_read_of_them_would(
        stored, recorded):
    # The rows an op records are newer than every row the batch read, and
    # read back newest first they come in reverse of the order they were
    # written. Kept in the history the batch read, they make the steps a
    # fresh read of every row makes, in the same order.
    history = ops_core.RewriteHistory(_rows(stored))
    newest_first = list(_rows(stored))
    for rows in recorded:
        history.record(_rows(rows))
        newest_first = [*reversed(_rows(rows)), *newest_first]
    assert _walks(history) == _walks(ops_core.RewriteHistory(newest_first))
    stored_pairs = {(b, a) for b, a, *_ in stored}
    if any((b, a) in stored_pairs for rows in recorded
           for b, a, *_ in rows):
        event("a recorded row joins a step the batch read")


def _one_step(records: list[tuple[RewriteKind, str, str]]
              ) -> tuple[ops_core.BlockRewrite, ...]:
    return tuple(ops_core.BlockRewrite(text_hash("a"), text_hash("b"), old,
                                       new, kind)
                 for kind, old, new in records)


def _recorded(sent: str, rows: tuple[ops_core.BlockRewrite, ...],
              canonical: Callable[[str], str]
              ) -> list[tuple[RewriteKind, str, str]]:
    outcome = ops_core.classify_text_edit(sent, text_hash("a"), "elsewhere",
                                          rows, canonical)
    op = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"),
                      text=sent, base_text_hash=text_hash("a"))
    planned = (ops_core.UpdateText(op.uid, outcome.text),)
    [effect] = ops_core.rewrite_effects(op, planned, frozenset(), canonical,
                                        outcome.replayed, outcome.text,
                                        outcome.known)
    assert isinstance(effect, ops_core.RecordRewrite)
    return sorted((r.kind, r.old_text, r.new_text) for r in effect.rewrites)


def test_a_step_records_what_it_moved_in_the_text():
    # The rename the text names, the copy it refs and the titles the
    # unlink matched, the copy's among them; not the rest of the step.
    # The rows rebuild a step with another key, which the chain's check
    # finds rather than replaying it unbudgeted, which would stop it.
    rows = _one_step([("retitle", "w", "v"), ("retitle", "q", "r"),
                      ("unlink", "z", ""), ("unlink", "y", ""),
                      ("unlink", "q", ""), ("inline", _UID, "[[z]] copied"),
                      ("inline", "uid_u0000003", "unused")])
    assert _recorded(f"[[w]] (({_UID})) [[y]]", rows, normalize_title) == [
        ("inline", _UID, "[[z]] copied"), ("retitle", "w", "v"),
        ("unlink", "y", ""), ("unlink", "z", "")]


def test_a_title_spelled_two_ways_records_both_spellings():
    # Two of a step's titles fold to one canonical title under
    # plain-space canonicalisation. A row naming either replays the same
    # here, but the step held both, and another canonicalisation tells
    # them apart.
    def canonical(raw: str) -> CanonicalTitle:
        return canonical_title_of(
            refs.canonicalize_title(raw, plain_space=True))

    rows = _one_step([("unlink", " A", ""), ("unlink", "A", ""),
                      ("unlink", "B", "")])
    assert _recorded("[[A]] x", rows, canonical) == [
        ("unlink", " A", ""), ("unlink", "A", "")]


def test_a_pass_no_record_names_leaves_no_rows():
    # A step's result names what it moved, and a change it moved nothing
    # for could not be replayed from rows: the chain records none rather
    # than rows that do not rebuild the step.
    step = ops_core.RewriteStep(text_hash("a"), text_hash("b"), {}, {"z"},
                                {})
    known = {ops_core._step_key("x", step, normalize_title):
             ops_core.StepResult("y")}
    assert ops_core._rewrite_chain("x", "y", (), [step], normalize_title,
                                   known) == ()
