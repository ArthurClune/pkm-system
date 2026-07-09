import sqlite3

from pkm.importer.import_sidebar import SIDEBAR_ENTRIES, main


def _titles_in_order(db_path):
    con = sqlite3.connect(db_path)
    rows = con.execute(
        "SELECT title FROM sidebar_entries ORDER BY order_idx").fetchall()
    con.close()
    return [r[0] for r in rows]


def test_import_creates_table_and_inserts_all_entries(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    con = sqlite3.connect(data_dir / "pkm.sqlite3")
    con.execute("CREATE TABLE pages(id INTEGER PRIMARY KEY, title TEXT)")
    con.commit()
    con.close()

    assert main(["--data-dir", str(data_dir)]) == 0
    assert _titles_in_order(data_dir / "pkm.sqlite3") == list(SIDEBAR_ENTRIES)


def test_import_is_idempotent(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    sqlite3.connect(data_dir / "pkm.sqlite3").close()

    assert main(["--data-dir", str(data_dir)]) == 0
    assert main(["--data-dir", str(data_dir)]) == 0
    titles = _titles_in_order(data_dir / "pkm.sqlite3")
    assert titles == list(SIDEBAR_ENTRIES)
    assert len(titles) == len(set(titles))


def test_import_skips_pre_existing_title_and_appends_the_rest_in_order(tmp_path):
    # A title already present keeps its own order_idx (this script never
    # reorders existing rows); everything still missing is appended after,
    # in SIDEBAR_ENTRIES order.
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    con = sqlite3.connect(data_dir / "pkm.sqlite3")
    con.execute(
        "CREATE TABLE sidebar_entries(id INTEGER PRIMARY KEY,"
        " title TEXT NOT NULL UNIQUE, order_idx INTEGER NOT NULL)")
    con.execute("INSERT INTO sidebar_entries(title, order_idx) VALUES ('AI', 0)")
    con.commit()
    con.close()

    assert main(["--data-dir", str(data_dir)]) == 0
    expected = ["AI"] + [t for t in SIDEBAR_ENTRIES if t != "AI"]
    assert _titles_in_order(data_dir / "pkm.sqlite3") == expected
