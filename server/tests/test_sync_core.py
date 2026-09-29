from pkm.server.sync_core import (CHUNK_SIZE, chunk_ids, dedupe_window,
                                    hydrate_in_order, missing_parent_uids,
                                    tombstone_entities, tombstoned_ids)


def test_next_since_is_last_scanned_row_not_last_distinct_entity():
    # The A@1/B@2/A@100 case from the spec: with the window cut at seq 2,
    # next_since must be 2 (B's row), never 100 -- or B is skipped forever.
    win = dedupe_window([(1, "block", "A", 0), (2, "block", "B", 0)])
    assert win.next_since == 2
    assert set(win.entities) == {("block", "A"), ("block", "B")}


def test_dedupes_within_window_only():
    win = dedupe_window(
        [(1, "block", "A", 0), (2, "block", "B", 0), (3, "block", "A", 0)])
    assert win.next_since == 3
    assert win.entities == (("block", "A"), ("block", "B"))


def test_same_id_different_kind_not_merged():
    win = dedupe_window([(1, "page", "7", 0), (2, "sidebar", "7", 0)])
    assert set(win.entities) == {("page", "7"), ("sidebar", "7")}


def test_empty_window():
    win = dedupe_window([])
    assert win.next_since == 0
    assert win.entities == ()
    assert win.tombstoned == frozenset()


def test_dedupe_window_flags_an_entity_with_a_delete_row():
    win = dedupe_window([(1, "page", "7", 1), (2, "page", "7", 0),
                         (3, "block", "A", 0)])
    assert win.entities == (("page", "7"), ("block", "A"))
    assert win.tombstoned == frozenset({("page", "7")})


def test_dedupe_window_flag_ignores_row_order():
    win = dedupe_window([(1, "page", "7", 0), (2, "page", "7", 1)])
    assert win.tombstoned == frozenset({("page", "7")})


def test_tombstone_entities_absent_entity():
    win = dedupe_window([(1, "block", "A", 0), (2, "page", "7", 0)])
    assert tombstone_entities(
        win, {"block": set(), "page": {"7"}}) == [("block", "A")]


def test_tombstone_entities_missing_kind_counts_as_empty():
    win = dedupe_window([(1, "sidebar", "3", 0)])
    assert tombstone_entities(win, {}) == [("sidebar", "3")]


def test_tombstone_entities_reused_page_and_sidebar_even_when_present():
    win = dedupe_window([(1, "page", "7", 1), (2, "page", "7", 0),
                         (3, "sidebar", "3", 1), (4, "sidebar", "3", 0)])
    present = {"block": set(), "page": {"7"}, "sidebar": {"3"}}
    assert tombstone_entities(win, present) == [("page", "7"),
                                                ("sidebar", "3")]


def test_tombstone_entities_block_keeps_presence_rule():
    # block uids are never reused by the database; one recreated under its
    # old uid is the same block and ships as a live row only
    win = dedupe_window([(1, "block", "A", 1), (2, "block", "A", 0)])
    assert tombstone_entities(win, {"block": {"A"}}) == []


def test_tombstoned_ids_by_kind_in_window_order():
    win = dedupe_window([(1, "page", "9", 1), (2, "sidebar", "9", 1),
                         (3, "page", "4", 1), (4, "page", "5", 0)])
    assert tombstoned_ids(win, "page") == ["9", "4"]


def test_chunk_ids_splits_at_chunk_size():
    ids = list(range(CHUNK_SIZE * 2 + 5))
    chunks = chunk_ids(ids)
    assert [len(c) for c in chunks] == [CHUNK_SIZE, CHUNK_SIZE, 5]
    assert [i for c in chunks for i in c] == ids  # nothing dropped/reordered


def test_chunk_ids_empty_input_yields_no_chunks():
    assert chunk_ids([]) == []


def test_chunk_ids_under_one_chunk_yields_single_chunk():
    assert chunk_ids([1, 2, 3], size=10) == [[1, 2, 3]]


def test_hydrate_in_order_preserves_order_and_skips_missing():
    # Chunked IN-queries come back keyed by id in scan order, not the
    # caller's order -- this is what puts the window's/input's order back,
    # same as a per-uid loop's incidental ordering.
    present = {"a": "A", "c": "C"}
    assert hydrate_in_order(["a", "b", "c"], present) == ["A", "C"]


def test_hydrate_in_order_empty_order_yields_empty():
    assert hydrate_in_order([], {"a": "A"}) == []


def test_missing_parent_uids_skips_known_and_none():
    assert missing_parent_uids(["p1", None, "p2"], {"p1"}) == {"p2"}


def test_missing_parent_uids_empty_when_all_known():
    assert missing_parent_uids(["p1", "p2"], {"p1", "p2"}) == set()


def test_missing_parent_uids_dedupes_repeats():
    assert missing_parent_uids(["p1", "p1", None], set()) == {"p1"}
