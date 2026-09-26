from perfcheck.sqlplan import full_scans, plannable

TABLES = {"blocks", "pages", "refs"}


def test_plannable_only_dml_and_select():
    assert plannable("SELECT 1")
    assert plannable("  with x as (select 1) select * from x")
    assert plannable("UPDATE blocks SET text='a' WHERE uid='b'")
    assert not plannable("-- TRIGGER blocks_fts_ai")
    assert not plannable("PRAGMA foreign_keys=ON")
    assert not plannable("BEGIN")


def test_full_scans_ignores_indexed_virtual_and_cte():
    details = ["SCAN blocks", "SCAN pages USING INDEX idx_x", "SEARCH refs USING INDEX r (b=?)",
               "SCAN blocks_fts VIRTUAL TABLE INDEX 0:M1", "SCAN chain", "SCAN CONSTANT ROW",
               "SCAN refs USING COVERING INDEX r2"]
    assert full_scans(details, TABLES) == ["SCAN blocks"]
