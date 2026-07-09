from pkm.importer.sidebar_rows import (missing_entry_rows, next_order_idx,
                                       reorder_is_valid)


def test_missing_entry_rows_skips_existing_preserves_order():
    rows = missing_entry_rows(
        existing_titles={"AI"}, desired_titles=("AWS", "AI", "Crypto"),
        start_order=0)
    assert rows == [("AWS", 0), ("Crypto", 1)]


def test_missing_entry_rows_continues_order_from_start():
    rows = missing_entry_rows(
        existing_titles=set(), desired_titles=("AWS", "AI"), start_order=5)
    assert rows == [("AWS", 5), ("AI", 6)]


def test_missing_entry_rows_empty_when_all_present():
    assert missing_entry_rows(
        existing_titles={"AWS", "AI"}, desired_titles=("AWS", "AI"),
        start_order=0) == []


def test_next_order_idx_continues_after_max():
    assert next_order_idx([0, 2, 1]) == 3


def test_next_order_idx_zero_when_empty():
    assert next_order_idx([]) == 0


def test_reorder_is_valid_accepts_a_permutation_of_existing_ids():
    assert reorder_is_valid(existing_ids={1, 2, 3}, new_order=[3, 1, 2])


def test_reorder_is_valid_rejects_missing_id():
    assert not reorder_is_valid(existing_ids={1, 2, 3}, new_order=[1, 2])


def test_reorder_is_valid_rejects_unknown_id():
    assert not reorder_is_valid(existing_ids={1, 2}, new_order=[1, 2, 99])


def test_reorder_is_valid_rejects_duplicate_id():
    assert not reorder_is_valid(existing_ids={1, 2}, new_order=[1, 1])
