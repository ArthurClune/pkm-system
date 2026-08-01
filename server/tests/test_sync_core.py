from pkm.server.sync_core import CHUNK_SIZE, chunk_ids, dedupe_window, hydrate_in_order


def test_next_since_is_last_scanned_row_not_last_distinct_entity():
    # The A@1/B@2/A@100 case from the spec: with the window cut at seq 2,
    # next_since must be 2 (B's row), never 100 -- or B is skipped forever.
    win = dedupe_window([(1, "block", "A"), (2, "block", "B")])
    assert win.next_since == 2
    assert set(win.entities) == {("block", "A"), ("block", "B")}


def test_dedupes_within_window_only():
    win = dedupe_window(
        [(1, "block", "A"), (2, "block", "B"), (3, "block", "A")])
    assert win.next_since == 3
    assert win.entities == (("block", "A"), ("block", "B"))


def test_same_id_different_kind_not_merged():
    win = dedupe_window([(1, "page", "7"), (2, "sidebar", "7")])
    assert set(win.entities) == {("page", "7"), ("sidebar", "7")}


def test_empty_window():
    win = dedupe_window([])
    assert win.next_since == 0
    assert win.entities == ()


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
    # pkm-ldqx: chunked IN-queries come back keyed by id in scan order, not
    # the caller's order -- this is what puts the window's/input's order
    # back, same as the old per-uid loop's incidental ordering.
    present = {"a": "A", "c": "C"}
    assert hydrate_in_order(["a", "b", "c"], present) == ["A", "C"]


def test_hydrate_in_order_empty_order_yields_empty():
    assert hydrate_in_order([], {"a": "A"}) == []
