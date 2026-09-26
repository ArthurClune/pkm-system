# pattern: Imperative Shell
import sqlite3

import e2e_serve


def test_prepare_db_empty(tmp_path):
    db = e2e_serve.prepare_db(tmp_path, None)
    con = sqlite3.connect(db)
    assert con.execute("SELECT COUNT(*) FROM blocks").fetchone()[0] == 0


def test_prepare_db_copies_source(tmp_path):
    src = e2e_serve.prepare_db(tmp_path / "seed", None)
    con = sqlite3.connect(src)
    con.execute("INSERT INTO pages(id, title) VALUES (1, 'Copied')")
    con.commit()
    con.close()
    db = e2e_serve.prepare_db(tmp_path / "data", src)
    assert sqlite3.connect(db).execute("SELECT title FROM pages").fetchone()[0] == "Copied"
    assert db.parent == tmp_path / "data" and db != src
