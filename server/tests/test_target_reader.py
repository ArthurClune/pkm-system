import asyncio
import logging
import sqlite3
from collections.abc import Collection, Mapping, Sequence

from conftest import SEED_BLOCKS, SEED_PAGES

from pkm.assistant.target_reader import db_block_reader, preview_write
from pkm.assistant.write_preview import (FoundBlock, MissingBlock, Refusal,
                                         StoredBlock, WritePreview,
                                         delete_target_uids,
                                         write_target_uids)
from pkm.contracts.ops import BlockUid
from pkm.database import connect
from pkm.server.db import open_db
from pkm.test_data.ids import canonical_title_of, uid_of

_GONE = uid_of("GONEGONE01")


def _seed(seed: str) -> tuple[BlockUid, StoredBlock]:
    """A seed block's uid and what the reader should return for it."""
    row = next(b for b in SEED_BLOCKS if b[0] == seed)
    title = next(p[1] for p in SEED_PAGES if p[0] == row[1])
    return uid_of(seed), StoredBlock(canonical_title_of(title), row[4])


def test_reader_returns_text_and_page_of_existing_uids(seeded_config):
    uid, stored = _seed("uid_b4")
    read = db_block_reader(seeded_config.db_path)
    assert read([uid, _GONE], [], []) == {uid: stored}


def test_reader_counts_the_blocks_under_each_delete_target(seeded_config):
    # uid_b2 has one child (uid_b3); uid_b4 has none
    parent, parent_stored = _seed("uid_b2")
    leaf, leaf_stored = _seed("uid_b4")
    read = db_block_reader(seeded_config.db_path)
    got = read([parent, leaf, _GONE], [parent, leaf, _GONE], [])
    assert got == {
        parent: StoredBlock(parent_stored.page_title, parent_stored.text, 1),
        leaf: StoredBlock(leaf_stored.page_title, leaf_stored.text, 0)}


def test_reader_counts_the_whole_subtree(seeded_config):
    con = open_db(seeded_config.db_path)
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        [("uid_c1", 1, "uid_b3", 0, "c1", None, 0, None, None),
         ("uid_c2", 1, "uid_c1", 0, "c2", None, 0, None, None),
         ("uid_c3", 1, "uid_b3", 1, "c3", None, 0, None, None)])
    con.commit()
    con.close()
    parent = uid_of("uid_b2")
    got = db_block_reader(seeded_config.db_path)([parent], [parent], [])
    assert got[parent].descendants == 4


def test_reader_count_ends_on_a_cycle(seeded_config):
    # a corrupted parent chain must not walk forever
    con = open_db(seeded_config.db_path)
    con.execute("UPDATE blocks SET parent_uid = 'uid_b3' WHERE uid = 'uid_b2'")
    con.commit()
    con.close()
    uid = uid_of("uid_b2")
    got = db_block_reader(seeded_config.db_path)([uid], [uid], [])
    assert got[uid].descendants == 1


def test_reader_counts_only_what_it_is_asked_to(seeded_config):
    uid = uid_of("uid_b2")
    got = db_block_reader(seeded_config.db_path)([uid], [], [])
    assert got[uid].descendants is None


def test_reader_closes_its_connection(seeded_config, monkeypatch):
    from pkm.assistant import target_reader

    closed: list[bool] = []
    real_open = target_reader.open_db

    def tracking_open(path):
        db = real_open(path)
        real_close = db.close

        def close():
            closed.append(True)
            real_close()
        db.close = close
        return db
    monkeypatch.setattr(target_reader, "open_db", tracking_open)
    read = db_block_reader(seeded_config.db_path)
    read([uid_of("uid_b2")], [uid_of("uid_b2")], [])
    assert closed == [True]


def test_reader_reads_text_and_counts_from_one_snapshot(seeded_config,
                                                       monkeypatch):
    # a delete committed between the text read and the count must not
    # pair the old text with a count of the block gone (-1)
    from pkm.assistant import target_reader

    leaf, stored = _seed("uid_b4")
    real_open = target_reader.open_db

    def racing_open(path):
        db = real_open(path)
        real_select = db.select
        raced: list[bool] = []

        def select(sql, params=()):
            rows = real_select(sql, params)
            if not raced:
                raced.append(True)
                other = real_open(path)
                other.execute("DELETE FROM blocks WHERE uid = ?",
                              (str(leaf),))
                other.commit()
                other.close()
            return rows
        db.select = select
        return db
    monkeypatch.setattr(target_reader, "open_db", racing_open)
    got = db_block_reader(seeded_config.db_path)([leaf], [leaf], [])
    assert got == {leaf: StoredBlock(stored.page_title, stored.text, 0)}


def test_a_block_whose_page_row_is_missing_is_not_read_as_absent(
        seeded_config):
    # possible only with foreign keys off; the write would still find the
    # block, so the card must not say no block has this uid
    con = connect(seeded_config.db_path)
    con.execute("PRAGMA foreign_keys=OFF")
    con.execute("UPDATE blocks SET page_id = 999999 WHERE uid = 'uid_b4'")
    con.commit()
    con.close()
    uid = uid_of("uid_b4")
    out = asyncio.run(preview_write(
        "update_block", {"uid": uid, "text": "t"},
        db_block_reader(seeded_config.db_path)))
    assert out == Refusal(
        "update_block: the blocks this write changes could not be read")


class _Recording:
    def __init__(self, blocks: Mapping[BlockUid, StoredBlock]) -> None:
        self.calls: list[tuple[list[BlockUid], list[BlockUid],
                               list[BlockUid]]] = []
        self._blocks = blocks

    def __call__(self, uids: Sequence[BlockUid],
                 count_under: Collection[BlockUid],
                 ancestors_of: Collection[BlockUid]
                 ) -> Mapping[BlockUid, StoredBlock]:
        self.calls.append((list(uids), list(count_under), list(ancestors_of)))
        return self._blocks


_A = uid_of("AAAAAAAA")
_B = uid_of("BBBBBBBB")
_INBOX = canonical_title_of("Inbox")
_BATCH = {"commands": [
    {"command": "update", "params": {"uid": _A, "text": "t"}},
    {"command": "delete", "params": {"uid": _B}},
    {"command": "move", "params": {"uid": "((CCCCCC))", "page": "P"}},
    {"command": "create", "params": {"page": "P", "text": "t",
                                     "parent": "((DDDDDD))"}}]}


def test_preview_write_reads_only_what_the_card_shows():
    reader = _Recording({_A: StoredBlock(_INBOX, "old"),
                         _B: StoredBlock(_INBOX, "gone", 2)})
    out = asyncio.run(preview_write("batch", _BATCH, reader))
    assert reader.calls == [(write_target_uids("batch", _BATCH),
                             delete_target_uids("batch", _BATCH), [])]
    assert reader.calls == [([_A, _B], [_B], [])]
    assert isinstance(out, WritePreview)
    assert [op.current for op in out.ops] == [
        FoundBlock(_INBOX, "old", 3), FoundBlock(_INBOX, "gone", 4, 2),
        MissingBlock(), None]


def test_preview_write_reads_the_parents_a_move_before_a_delete_names():
    parent = uid_of("PARENT01")
    raw = {"commands": [
        {"command": "move", "params": {"uid": _A, "page": "P",
                                       "parent": f"(({parent}))"}},
        {"command": "delete", "params": {"uid": _B}}]}
    reader = _Recording({parent: StoredBlock(_INBOX, "p", ancestors=())})
    out = asyncio.run(preview_write("batch", raw, reader))
    assert reader.calls == [([_A, _B, parent], [_B], [parent])]
    assert isinstance(out, WritePreview)


def test_preview_write_reads_nothing_for_a_write_without_targets():
    reader = _Recording({})
    out = asyncio.run(preview_write("save_note", {"text": "t"}, reader))
    assert reader.calls == []
    assert isinstance(out, WritePreview)


def test_preview_write_of_refused_input_reads_nothing():
    reader = _Recording({})
    out = asyncio.run(preview_write("batch", {"commands": "nope"}, reader))
    assert reader.calls == []
    assert isinstance(out, Refusal)


def test_a_failing_read_is_a_refusal_not_a_raise(caplog):
    def failing(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
            ancestors_of: Collection[BlockUid]):
        raise sqlite3.OperationalError("secret-path/pkm.sqlite3 is locked")

    with caplog.at_level(logging.WARNING, logger="pkm.assistant"):
        out = asyncio.run(preview_write(
            "update_block", {"uid": _A, "text": "t"}, failing))
    assert out == Refusal(
        "update_block: the blocks this write changes could not be read")
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "OperationalError" in logged
    assert "secret-path" not in logged


def test_preview_write_is_a_snapshot():
    tool_input: dict[str, object] = {"uid": _A, "text": "original"}

    def mutating(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
            ancestors_of: Collection[BlockUid]):
        tool_input["text"] = "swapped"
        tool_input["uid"] = _B
        return {_A: StoredBlock(_INBOX, "old"),
                _B: StoredBlock(_INBOX, "other")}

    out = asyncio.run(preview_write("update_block", tool_input, mutating))
    assert isinstance(out, WritePreview)
    (op,) = out.ops
    assert op.targets[0] == ("uid", _A)
    assert op.content == [("text", "original", 8)]
    assert op.current == FoundBlock(_INBOX, "old", 3)


def test_preview_write_reads_off_the_event_loop():
    # a slow disk must not stall every other conversation's stream
    loop_threads: list[bool] = []

    async def scenario():
        import threading
        main = threading.get_ident()

        def reader(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
            ancestors_of: Collection[BlockUid]):
            loop_threads.append(threading.get_ident() == main)
            return {}
        return await preview_write("update_block", {"uid": _A, "text": "t"},
                                   reader)

    asyncio.run(scenario())
    assert loop_threads == [False]


# -- the reader places the parents a move before a delete names ----------

def _add_tree(config) -> None:
    """A big root with 50 children on page "Big", and a one-block page
    "Junk" whose block has a child, as the final review's reproduction
    built them."""
    con = open_db(config.db_path)
    con.execute("INSERT INTO pages VALUES (10, 'Big', NULL, NULL)")
    con.execute("INSERT INTO pages VALUES (11, 'Junk', NULL, NULL)")
    rows = [("bigroot01", 10, None, 0, "Projects", None, 0, None, None),
            ("junkleaf1", 11, None, 0, "tmp", None, 0, None, None),
            ("junkkid01", 11, "junkleaf1", 0, "kid", None, 0, None, None)]
    rows += [(f"bigkid{i:03d}", 10, "bigroot01", i, f"kid {i}", None, 0,
              None, None) for i in range(50)]
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    con.close()


def test_reader_returns_the_ancestors_it_is_asked_for(seeded_config):
    _add_tree(seeded_config)
    kid, leaf = uid_of("junkkid01"), uid_of("junkleaf1")
    got = db_block_reader(seeded_config.db_path)([kid, leaf], [], [kid,
                                                                   leaf])
    assert got[kid].ancestors == (leaf,)
    assert got[leaf].ancestors == ()
    assert db_block_reader(seeded_config.db_path)(
        [kid], [], [])[kid].ancestors is None


def test_reader_ancestors_end_on_a_cycle(seeded_config):
    con = open_db(seeded_config.db_path)
    con.execute("UPDATE blocks SET parent_uid = 'uid_b3' WHERE uid = 'uid_b2'")
    con.commit()
    con.close()
    uid = uid_of("uid_b3")
    got = db_block_reader(seeded_config.db_path)([uid], [], [uid])
    assert got[uid].ancestors == (uid_of("uid_b2"),)


def _batch_preview(config, commands):
    return asyncio.run(preview_write(
        "batch", {"commands": commands}, db_block_reader(config.db_path)))


def test_a_move_under_a_leaf_then_its_delete_is_refused(seeded_config):
    _add_tree(seeded_config)
    out = _batch_preview(seeded_config, [
        {"command": "move", "params": {"uid": "bigroot01", "page": "Junk",
                                       "parent": "((junkleaf1))"}},
        {"command": "delete", "params": {"uid": "junkleaf1"}}])
    assert isinstance(out, Refusal)
    assert out.message.startswith(
        'batch: write 2 deletes "junkleaf1" and every block under it, and '
        "write 1 moves an existing block there first")


def test_a_move_under_an_alias_then_its_delete_is_refused(seeded_config):
    _add_tree(seeded_config)
    out = _batch_preview(seeded_config, [
        {"command": "create", "params": {"page": "Junk", "text": "x",
                                         "as": "t"}},
        {"command": "move", "params": {"uid": "bigroot01", "page": "Junk",
                                       "parent": "{{t}}"}},
        {"command": "delete", "params": {"uid": "{{t}}"}}])
    assert isinstance(out, Refusal)
    assert out.message.startswith(
        'batch: write 3 deletes "{{t}}" and every block under it, and '
        "write 2 moves an existing block there first")


def test_a_move_under_a_descendant_then_the_delete_is_refused(
        seeded_config):
    _add_tree(seeded_config)
    out = _batch_preview(seeded_config, [
        {"command": "move", "params": {"uid": "bigroot01", "page": "Junk",
                                       "parent": "((junkkid01))"}},
        {"command": "delete", "params": {"uid": "junkleaf1"}}])
    assert isinstance(out, Refusal)
    assert out.message.startswith(
        'batch: write 2 deletes "junkleaf1" and every block under it, and '
        "write 1 moves an existing block there first")


def test_a_move_elsewhere_then_a_delete_is_previewed(seeded_config):
    _add_tree(seeded_config)
    out = _batch_preview(seeded_config, [
        {"command": "move", "params": {"uid": "junkkid01", "page": "Big",
                                       "parent": "((bigroot01))"}},
        {"command": "delete", "params": {"uid": "junkleaf1"}}])
    assert isinstance(out, WritePreview)
    assert out.ops[1].current == FoundBlock(canonical_title_of("Junk"),
                                            "tmp", 3, 1)
