from pkm.importer.sidebar_rows import missing_entry_rows


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
