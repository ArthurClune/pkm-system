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
edits as sent, as `over_limit` does. A rename step is charged too: a
longer title grows every link, so ten renames of a small edit rebuilt a
megabyte each. And the rows of a stale unlink find the deleted titles a
text links in one pass, not one unlink per title the client calls
stale."""
from __future__ import annotations

import time
from collections.abc import Callable

import pytest
from hypothesis import event, given, settings
from hypothesis import strategies as st
from scaling import loop_steps
from test_text_limits_rewrites import _scalar, _seed, _text

from pkm import refs, spans, text_limits, unlink
from pkm.contracts.ops import BlockUid, UpdateTextOp, text_hash
from pkm.contracts.titles import as_raw_title
from pkm.refs import CanonicalTitle, normalize_title
from pkm.server import ops_apply, ops_core
from pkm.server.ops_core import MAX_REPLAYED_REWRITES
from pkm.server.db import open_db
from pkm.test_data.ids import (batch_id_of, canonical_title_of, client_id_of,
                               order_idx_of, seq_of, uid_of)
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



def _retitle_history(config, uid: BlockUid) -> str:
    """`uid` on page Src, and the rows of `MAX_REPLAYED_REWRITES` renames
    of its 1,000 links, each to a distinct title of 990 characters: the
    text a replay builds reaches 995,000 characters at the first step and
    stays there, under the cap, from a 6,000-character edit. Returns the
    text the first rename started from."""
    original = "[[A]] " * 1_000
    titles = ["A", *(f"r{i:02d}" + "t" * 987
                     for i in range(MAX_REPLAYED_REWRITES))]
    _seed(config, [(uid, "Src", "current")])
    hashes = [text_hash(original)] + [
        text_hash(f"renamed {i}") for i in range(MAX_REPLAYED_REWRITES)]
    con = open_db(config.db_path)
    try:
        for i in range(MAX_REPLAYED_REWRITES):
            con.execute(
                "INSERT INTO block_rewrites(uid, base_hash, after_hash,"
                " old_title, new_title, created_at, kind)"
                " VALUES (?,?,?,?,?,?,'retitle')",
                (uid, hashes[i], hashes[i + 1], titles[i], titles[i + 1], i))
        con.commit()
    finally:
        con.close()
    return original


def test_a_batch_of_renamed_edits_stops_at_its_work_budget(
        client, seeded_config):
    # A rename step splices no copies, but a longer title grows each link,
    # so ten of them rebuild and rescan a megabyte each from a small edit.
    # They are charged to the batch's budget like an unlink: four times
    # the ops cost about the same work, and the edits past it land as
    # sent.
    uids = [uid_of(f"rbw_ren_{i:03d}") for i in range(20)]
    originals = {uid: _retitle_history(seeded_config, uid) for uid in uids}

    def run(first: int, ops: int) -> tuple[int, list[str]]:
        got = []
        work = loop_steps(MODULES, lambda: got.append(_post(client, [
            {"op": "update_text", "uid": uid, "text": originals[uid],
             "base_text_hash": text_hash(originals[uid])}
            for uid in uids[first:first + ops]])))
        assert got[0].status_code == 200, got[0].text[:300]
        return work, [s["reason"] for s in got[0].json()["skipped"]]

    (small, _), (large, skipped) = run(0, 4), run(4, 16)
    assert large < 2 * small, (small, large)
    assert skipped.count("text_limit") > 8


def test_a_rename_step_is_charged_what_it_scans_and_splices():
    # The text it scans and the text it builds; past what is left it stops
    # and spends all of it, as an unlink does. A step that renames and
    # unlinks leaves its unlink only what the rename did not spend.
    text = "[[A]] " * 10
    renamed = "[[Bbbbbbbbbb]] " * 10
    step = ops_core.RewriteStep(text_hash("a"), text_hash("b"),
                                {"A": as_raw_title("Bbbbbbbbbb")}, set(), {})
    cost = len(text) + len(renamed)
    assert ops_core._replay_step(text, step, normalize_title) == \
        (renamed, cost)
    assert ops_core._replay_step(text, step, normalize_title, cost) == \
        (renamed, cost)
    assert ops_core._replay_step(text, step, normalize_title, cost - 1) == \
        (None, cost - 1)
    both = ops_core.RewriteStep(text_hash("a"), text_hash("b"),
                                {"A": as_raw_title("Bbbbbbbbbb")},
                                {"Bbbbbbbbbb"}, {})
    plain, reads = ops_core._replay_step(text, both, normalize_title)
    assert plain == "Bbbbbbbbbb " * 10
    assert reads == cost + unlink.unlink_reads(renamed)
    assert ops_core._replay_step(text, both, normalize_title, reads) == \
        (plain, reads)
    assert ops_core._replay_step(text, both, normalize_title, reads - 1) == \
        (None, reads - 1)


def test_once_renames_run_the_budget_out_later_renames_land_as_sent(
        client, seeded_config):
    # The first edit's ten renames stop with part of the budget left; that
    # step spends it, so the small renames after it, each of which would
    # fit in what was left, land as sent rather than replaying.
    big = uid_of("rbw_ren_big")
    original = _retitle_history(seeded_config, big)
    small = [uid_of(f"rbw_ren_s{i:02d}") for i in range(10)]
    _seed(seeded_config, [(uid, "Src", "current") for uid in small])
    con = open_db(seeded_config.db_path)
    try:
        for uid in small:
            con.execute(
                "INSERT INTO block_rewrites(uid, base_hash, after_hash,"
                " old_title, new_title, created_at, kind)"
                " VALUES (?,?,?,?,?,0,'retitle')",
                (uid, text_hash("[[A]] " * 20), text_hash("renamed"), "A",
                 "s" * 990))
        con.commit()
    finally:
        con.close()
    r = _post(client, [
        {"op": "update_text", "uid": big, "text": original,
         "base_text_hash": text_hash(original)},
        *({"op": "update_text", "uid": uid, "text": "[[A]] " * 20,
           "base_text_hash": text_hash("[[A]] " * 20)} for uid in small)])
    assert r.status_code == 200, r.text[:300]
    skipped = {s["index"]: s["reason"] for s in r.json()["skipped"]}
    assert skipped == {i: "text_limit" for i in range(11)}

def test_the_stale_titles_cost_one_pass_however_many_were_deleted(
        client, seeded_config):
    # The rows of a stale unlink name each deleted title the sent text
    # links. Finding them took one unlink of the text per title deleted
    # since the batch's `seen_seq`, which the client picks: twenty titles
    # cost twenty unlinks of a megabyte. One pass now finds them all.
    text = "[[gone0]] " + "[[x]] " * 30_000
    _seed(seeded_config, [], pages=("Src",))

    def delete(titles: range) -> None:
        con = open_db(seeded_config.db_path)
        try:
            for i in titles:
                con.execute("INSERT INTO page_deletions(title, seq,"
                            " deleted_at) VALUES (?, ?, 0)",
                            (f"gone{i}", i + 1))
            con.commit()
        finally:
            con.close()

    def run(k: int) -> int:
        got = []
        work = loop_steps(MODULES, lambda: got.append(client.post(
            "/api/ops", json={
                "client_id": client_id_of("replaywork"),
                "batch_id": batch_id_of(f"rbw_stale_{k:04d}"),
                "seen_seq": seq_of(0),
                "ops": [{"op": "create", "uid": uid_of(f"rbw_stl_{k:03d}"),
                         "page_title": "Src", "parent_uid": None,
                         "order_idx": order_idx_of(k), "text": text}]})))
        assert got[0].status_code == 200, got[0].text[:300]
        return work

    delete(range(1))
    small = run(1)
    delete(range(1, 20))
    large = run(20)
    assert _scalar(seeded_config, "SELECT count(*) AS n FROM block_rewrites"
                   " WHERE old_title = 'gone0'") == 2
    assert large < 1.5 * small, (small, large)

def test_a_stale_edit_costs_its_own_links_however_many_were_deleted(
        client, seeded_config):
    # The titles a stale unlink's rows name were found by walking every
    # title deleted since the batch's `seen_seq` for each op the unlink
    # changed: a tiny edit cost the deletion count. Now each op looks up
    # the titles its own text links.
    _seed(seeded_config, [], pages=("Src",))

    def delete(titles: range) -> None:
        con = open_db(seeded_config.db_path)
        try:
            con.executemany(
                "INSERT INTO page_deletions(title, seq, deleted_at)"
                " VALUES (?, ?, 0)", ((f"gone{i}", i + 1) for i in titles))
            con.commit()
        finally:
            con.close()

    def run(k: int) -> int:
        got = []
        work = loop_steps(MODULES, lambda: got.append(client.post(
            "/api/ops", json={
                "client_id": client_id_of("replaywork"),
                "batch_id": batch_id_of(f"rbw_many_{k:04d}"),
                "seen_seq": seq_of(0),
                "ops": [{"op": "create",
                         "uid": uid_of(f"rbw_mny_{k:03d}_{i:02d}"),
                         "page_title": "Src", "parent_uid": None,
                         "order_idx": order_idx_of(i),
                         "text": "[[gone0]] y"} for i in range(20)]})))
        assert got[0].status_code == 200, got[0].text[:300]
        return work

    delete(range(1))
    small = run(1)
    delete(range(1, 20_000))
    large = run(2)
    assert _scalar(seeded_config, "SELECT count(*) AS n FROM block_rewrites"
                   " WHERE old_title = 'gone0'") == 40
    assert large < 1.5 * small, (small, large)


def test_naming_the_stale_titles_walks_the_text_not_the_deletions():
    # The intersection runs in C, which loop steps do not see, so this is
    # wall clock, and generous: walking a million deleted titles per call
    # takes seconds over these calls, the text's two titles microseconds.
    stale = frozenset(canonical_title_of(f"gone{i}")
                      for i in range(1_000_000))
    started = time.perf_counter()
    for _ in range(200):
        assert ops_core.stale_titles_linked(
            "[[gone0]] y [[kept]]", stale, normalize_title) == ("gone0",)
    elapsed = time.perf_counter() - started
    assert elapsed < 0.5, elapsed

_COPY_UID = uid_of("rbw_copy_02")


def _over_limit_batch(text: str, rows: tuple[ops_core.BlockRewrite, ...],
                      ops: int) -> int:
    """Loop steps of `ops` copies of one stale edit, the batch's budget
    threaded through them as `apply_batch` threads it. Each lands
    `over_limit`, and the budget never goes below 0."""
    def run() -> None:
        allowance = ops_core.MAX_BATCH_REPLAY_WORK
        for _ in range(ops):
            outcome = ops_core.classify_text_edit(
                text, text_hash(text), "current", rows, allowance=allowance)
            assert outcome.kind == "over_limit"
            allowance -= outcome.reads
            assert allowance >= 0
    return loop_steps(MODULES, run)


def test_a_step_refused_its_unlink_pays_for_the_splice_it_measured():
    # The copy nests the sent link one level deeper, past the unlink's
    # work limit, so the step is refused after splicing the copy in and
    # measuring its depth. That work was charged nothing and a refused
    # step is not kept, so every op in a batch did it again.
    copy = "[[[[a]]]] " * 70_000
    text = f"[[x (({_COPY_UID}))]]"
    rows = (ops_core.BlockRewrite(text_hash(text), text_hash("after"),
                                  _COPY_UID, copy, "inline"),)
    small, large = _over_limit_batch(text, rows, 8), \
        _over_limit_batch(text, rows, 32)
    assert large < 2 * small, (small, large)


def test_a_rename_then_a_copy_too_long_pays_for_the_rename(monkeypatch):
    # One step renames the text's links to a long title, then finds the
    # copy it inlines would carry the text past the cap. The rename was
    # charged and then dropped, so every op rebuilt the megabyte again.
    # Loop steps see the scan of each op's own links alike either way;
    # the megabyte is built in C, so the count is the characters spliced.
    text = "[[A]] " * 1_000 + f"(({_COPY_UID}))"
    hashes = (text_hash(text), text_hash("after"))
    rows = (ops_core.BlockRewrite(*hashes, "A", "t" * 990, "retitle"),
            ops_core.BlockRewrite(*hashes, _COPY_UID, "c" * 10_000,
                                  "inline"))
    built = [0]

    def counted(text: str, found: list[spans.Span]) -> str:
        out = spans.splice(text, found)
        built[0] += len(out)
        return out

    monkeypatch.setattr(ops_core, "splice", counted)

    def chars(ops: int) -> int:
        built[0] = 0
        _over_limit_batch(text, rows, ops)
        return built[0]

    small, large = chars(8), chars(32)
    assert small > 0
    assert large < 2 * small, (small, large)


def test_every_exit_of_a_step_charges_what_it_scanned_or_built():
    # A rename over the cap scanned the text; a copy over the cap after a
    # rename scanned the renamed text too; a refused unlink spliced and
    # measured. None charges more than the batch has left.
    renaming = ops_core.RewriteStep(
        text_hash("a"), text_hash("b"), {"A": as_raw_title("t" * 990)},
        set(), {})
    long_text = "[[A]] " * 2_000
    assert ops_core._replay_step(long_text, renaming, normalize_title) == \
        (None, len(long_text))
    assert ops_core._replay_step(long_text, renaming, normalize_title,
                                 5) == (None, 5)
    text = "[[A]] " * 1_000 + f"(({_COPY_UID}))"
    both = ops_core.RewriteStep(
        text_hash("a"), text_hash("b"), {"A": as_raw_title("t" * 990)},
        set(), {_COPY_UID: "c" * 10_000})
    renamed = "[[" + "t" * 990 + "]] "
    built = len(renamed) * 1_000 + len(f"(({_COPY_UID}))")
    rename_cost = len(text) + built
    assert ops_core._replay_step(text, both, normalize_title) == \
        (None, rename_cost + built)
    assert ops_core._replay_step(text, both, normalize_title,
                                 rename_cost + 7) == (None, rename_cost + 7)
    copy = "[[[[a]]]] " * 70_000
    refused_text = f"[[x (({_COPY_UID}))]]"
    refusing = ops_core.RewriteStep(text_hash("a"), text_hash("b"), {},
                                    set(), {_COPY_UID: copy})
    spliced = f"[[x {copy}]]"
    assert text_limits.unlink_refused(refused_text, spliced)
    assert ops_core._replay_step(refused_text, refusing, normalize_title) \
        == (None, unlink.unlink_reads(spliced))

_UID = "uid_u0000002"
_STEPS = [("retitle", "A", "B"), ("retitle", "B", "C d"), ("unlink", "A", ""),
          ("unlink", "B", ""), ("inline", _UID, "copied [[A]] text"),
          ("inline", _UID, "[[B]] #A")]


@settings(max_examples=1500, deadline=None)
@given(st.lists(st.sampled_from(["[[A]]", "[[B]]", f"(({_UID}))", "#A", " ",
                                 "x", "[[Z]]", "A::", "[[ A ]]", "[[Y]]",
                                 "[[Z [[Y]]]]", "#Y", "[[", "]]"]),
                max_size=8).map("".join),
       st.lists(st.lists(st.sampled_from(_STEPS), min_size=1, max_size=2),
                min_size=1, max_size=3),
       st.sets(st.sampled_from(["Z", "Y", "Z Y", "A"]), max_size=3),
       st.booleans())
def test_the_rows_reuse_the_replay_and_record_the_same(
        sent_text, chain, stale_titles, conflicting):
    # The classification's steps, looked up, give the rows a full replay
    # of every step gives: `_replay_step` is a pure function of what the
    # key holds. Unbudgeted, so neither side stops for work. Several stale
    # titles, one nested in another's link, reach the case where the
    # titles the rows name unlink less than all of them did.
    stale = {canonical_title_of(t) for t in stale_titles}
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
    if len(stale) > 1:
        event("several stale titles, rows" if reused
              else "several stale titles, no rows")
    named = ops_core.stale_titles_linked(sent_text, stale, normalize_title)
    if unlink_stale_refs(
            sent_text, lambda raw: normalize_title(raw) in named) != unlinked:
        event("the titles named unlink less than all")


def _probed_titles(
        text: str, stale: set[CanonicalTitle],
        canonical: Callable[[str], CanonicalTitle],
) -> tuple[CanonicalTitle, ...]:
    """The titles the rows named before one pass found them: each stale
    title whose unlink alone changes the text."""
    return tuple(sorted(
        title for title in stale
        if unlink_stale_refs(
            text, lambda raw, t=title: canonical(normalize_title(raw)) == t)
        != text))


_TOKENS = ["[[z]]", "[[y]]", "[[y z]]", "[[ z ]]", "[[z [[y]]]]", "#z", "#y",
           "#[[y z]]", "[[", "]]", "[", "]", "(", ")", "`", " ", "\n", "x",
           "z::", "y z::", "[#z](", "[lbl](", "[[a[]]", "[a[]]", "zy", "#",
           "{{embed [[z]]}}"]


@settings(max_examples=2000, deadline=None)
@given(st.lists(st.sampled_from(_TOKENS), max_size=10).map("".join),
       st.sets(st.sampled_from(["z", "y", "y z", "z y", "zy", "a[", " z"]),
               min_size=1, max_size=3),
       st.booleans())
def test_one_pass_finds_the_stale_titles_probing_each_found(
        text, titles, plain_space):
    # One pass names the stale titles a text links; probing each title
    # with its own unlink did. Same titles, so the same rows.
    def canonical(raw: str) -> CanonicalTitle:
        return canonical_title_of(
            refs.canonicalize_title(raw, plain_space=plain_space))

    stale = {canonical(t) for t in titles}
    probed = _probed_titles(text, stale, canonical)
    assert ops_core.stale_titles_linked(text, stale, canonical) == probed
    written = unlink_stale_refs(
        text, lambda raw: canonical(normalize_title(raw)) in stale)
    sent = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"),
                        text=text, base_text_hash=text_hash("base"))
    planned = (ops_core.UpdateText(sent.uid, written),)
    rows = ops_core.rewrite_effects(sent, planned, stale, canonical)
    expected = ops_core._rewrite_chain(text, written, probed, (), canonical) \
        if probed and written != text else ()
    assert rows == ((ops_core.RecordRewrite(sent.uid, expected),)
                    if expected else ())
    event(f"{len(probed)} of {len(stale)} titles linked")
    if unlink_stale_refs(
            text, lambda raw: canonical(normalize_title(raw)) in probed) \
            != written:
        # a title only another's unlink exposes, which no row names
        event("the titles named unlink less than all")
    if expected and len(probed) > 1:
        event("rows naming several titles")
