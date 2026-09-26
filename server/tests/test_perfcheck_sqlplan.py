from perfcheck.sqlplan import aliases, full_scans, plannable

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


def test_aliases_maps_from_and_join_aliases_to_tables():
    sql = ("WITH RECURSIVE anc(uid) AS (SELECT uid FROM blocks WHERE uid='x') "
           "SELECT b.uid FROM blocks b JOIN pages AS p ON p.title = b.page_title "
           "LEFT JOIN refs r ON r.src = b.uid JOIN anc a ON a.uid = b.uid "
           "WHERE b.text LIKE '%x%'")
    assert aliases(sql) == {"b": "blocks", "p": "pages", "r": "refs", "a": "anc"}


def test_aliases_skips_keywords_after_unaliased_tables():
    sql = "SELECT * FROM blocks WHERE uid IN (SELECT uid FROM refs JOIN pages ON 1) ORDER BY 1"
    assert aliases(sql) == {}


def test_full_scans_resolves_aliased_rows():
    details = ["SCAN b", "SCAN p USING INDEX idx_p", "SCAN a", "SEARCH r USING INDEX r (src=?)"]
    names = {"b": "blocks", "p": "pages", "a": "anc", "r": "refs"}
    assert full_scans(details, TABLES, names) == ["SCAN b"]
