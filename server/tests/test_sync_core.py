from pkm.server.sync_core import dedupe_window


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
