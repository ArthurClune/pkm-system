"""pkm-t3qw: every server path that re-derives a block's refs goes through
one composition, `store.reindex_refs_for_text`.

Two call sites own that ritual -- op application (`ops_apply._execute`'s
ReindexRefs effect) and snapshot rewriting (`store.rewrite_snapshotted_blocks`,
used by rename/merge and the title migration). The delegation tests below fail
if either site re-inlines delete -> extract -> insert; the equivalence test
fails if the two sites ever index the same text differently, whatever code
they run.
"""
from __future__ import annotations

import sqlite3

import pytest

from pkm.contracts.ops import OpBatch
from pkm.server import ops_apply, store
from pkm.server.db import open_db
from pkm.server.ops_apply import apply_batch
from pkm.server.store import reindex_refs_for_text, rewrite_snapshotted_blocks

# Texts exercising every branch the composition owns: no refs, all three ref
# kinds, duplicates, a blank-normalizing ref (skipped, never indexed onto a
# fallback page), resolved and dangling ((uid)) targets, and a fenced ref the
# extractor strips.
REF_TEXTS = [
    "no references at all",
    "[[AI]] plus #Tag plus Attr:: value",
    "[[AI]] twice: [[AI]]",
    "hello [[   ]] world",
    "see ((uid_b1)) and ((uid_absent))",
    "```\n[[Fenced]] is not a ref\n```",
    "[[Machine Learning]] and ((uid_b3)) together",
]


@pytest.fixture()
def con(seeded_config):
    c = open_db(seeded_config.db_path)
    try:
        yield c
    finally:
        c.close()


def _spy(monkeypatch, module, name: str) -> list[tuple]:
    """Wrap `module.name` so behaviour is unchanged and calls are recorded."""
    real = getattr(module, name)
    calls: list[tuple] = []

    def recording(*args, **kwargs):
        calls.append(args[1:] + tuple(kwargs.values()))
        return real(*args, **kwargs)

    monkeypatch.setattr(module, name, recording)
    return calls


def _update_text(con: sqlite3.Connection, uid: str, text: str,
                 now_ms: int) -> None:
    apply_batch(
        con,
        OpBatch(client_id="t-t3qw", batch_id="batch-t3qw-01",
                ops=[{"op": "update_text", "uid": uid, "text": text}]),
        now_ms)


def _ref_titles(con: sqlite3.Connection, uid: str) -> set[tuple[str, str]]:
    return {(row["title"], row["kind"]) for row in con.execute(
        "SELECT p.title AS title, r.kind AS kind FROM refs r"
        " JOIN pages p ON p.id = r.target_page_id"
        " WHERE r.src_block_uid = ?", (uid,))}


def _block_ref_targets(con: sqlite3.Connection, uid: str) -> set[str]:
    return {row[0] for row in con.execute(
        "SELECT target_block_uid FROM block_refs WHERE src_block_uid = ?",
        (uid,))}


def test_op_application_reindexes_through_the_shared_composition(
        con, monkeypatch):
    calls = _spy(monkeypatch, ops_apply, "reindex_refs_for_text")

    _update_text(con, "uid_b4", "now [[AI]] and ((uid_b1))", 4242)

    assert calls == [("uid_b4", "now [[AI]] and ((uid_b1))", 4242)]
    assert _ref_titles(con, "uid_b4") == {("AI", "link")}
    assert _block_ref_targets(con, "uid_b4") == {"uid_b1"}


def test_snapshot_rewriting_reindexes_through_the_shared_composition(
        con, monkeypatch):
    calls = _spy(monkeypatch, store, "reindex_refs_for_text")

    rewritten = rewrite_snapshotted_blocks(
        con, [("uid_b3", "[[Paper]] and ((uid_b1))")], {"Paper": "Papers"},
        5150)

    assert rewritten == 1
    # the rewritten text is what gets indexed, never the original snapshot
    assert calls == [("uid_b3", "[[Papers]] and ((uid_b1))", 5150)]
    assert ("Papers", "link") in _ref_titles(con, "uid_b3")
    assert ("Paper", "link") not in _ref_titles(con, "uid_b3")
    assert _block_ref_targets(con, "uid_b3") == {"uid_b1"}


@pytest.mark.parametrize("text", REF_TEXTS)
def test_both_call_sites_index_the_same_text_identically(con, text):
    """Semantic drift check: whatever each site runs, the rows it derives from
    one text must match the other's (page titles, not ids -- creation order
    differs) and match the composition called directly."""
    _update_text(con, "uid_b4", text, 7000)
    # an empty replacement map leaves the snapshot text alone, so this
    # reindexes uid_b6 from exactly `text`
    rewrite_snapshotted_blocks(con, [("uid_b6", text)], {}, 7000)
    reindex_refs_for_text(con, "uid_b1", text, 7000)

    assert _ref_titles(con, "uid_b6") == _ref_titles(con, "uid_b4")
    assert _ref_titles(con, "uid_b1") == _ref_titles(con, "uid_b4")
    assert _block_ref_targets(con, "uid_b6") == _block_ref_targets(con, "uid_b4")
    assert _block_ref_targets(con, "uid_b1") == _block_ref_targets(con, "uid_b4")


def test_composition_replaces_rather_than_appends(con):
    # uid_b3 seeds refs to "Attention Is All You Need" and "Paper"
    reindex_refs_for_text(con, "uid_b3", "only [[AI]] now", 1)

    assert _ref_titles(con, "uid_b3") == {("AI", "link")}
    # uid_b5's seeded block_refs row must survive: only src_uid's rows go
    assert _block_ref_targets(con, "uid_b5") == {"uid_b3"}


def test_composition_skips_a_blank_ref_without_minting_a_page(con):
    reindex_refs_for_text(con, "uid_b4", "hello [[   ]] world", 1)

    assert _ref_titles(con, "uid_b4") == set()
    assert con.execute(
        "SELECT count(*) FROM pages WHERE trim(title) = ''").fetchone()[0] == 0


def test_composition_creates_a_missing_page_stamped_with_now_ms(con):
    reindex_refs_for_text(con, "uid_b4", "[[Brand New Page]]", 9999)

    row = con.execute(
        "SELECT created_at, updated_at FROM pages WHERE title = ?",
        ("Brand New Page",)).fetchone()
    assert (row["created_at"], row["updated_at"]) == (9999, 9999)


def test_composition_keeps_dangling_block_refs(con):
    reindex_refs_for_text(con, "uid_b4", "((uid_absent))", 1)

    assert _block_ref_targets(con, "uid_b4") == {"uid_absent"}


def test_composition_never_commits(con, seeded_config):
    reindex_refs_for_text(con, "uid_b4", "[[Uncommitted Page]]", 1)
    con.rollback()

    assert con.execute(
        "SELECT count(*) FROM pages WHERE title = ?",
        ("Uncommitted Page",)).fetchone()[0] == 0
    assert _ref_titles(con, "uid_b4") == {("Machine Learning", "link")}
