import hashlib
import sqlite3
from pathlib import Path

from pkm.importer.run import main

FIXTURE = Path(__file__).parent / "fixtures" / "sample_export.edn"


def _setup_files(tmp_path: Path) -> Path:
    files = tmp_path / "files"
    files.mkdir()
    (files / "paper-fig.png").write_bytes(b"PNGDATA")
    (files / "unused.pdf").write_bytes(b"PDFDATA")
    return files


def test_end_to_end_import(tmp_path):
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    rc = main([str(FIXTURE), "--files", str(files), "--out", str(out)])
    assert rc == 0

    con = sqlite3.connect(out / "pkm.sqlite3")
    titles = {r[0] for r in con.execute("SELECT title FROM pages")}
    assert titles == {"Machine Learning", "July 8th, 2026", "Tags", "AI",
                      "Generative Models", "Attention Is All You Need",
                      "query", "Paper"}
    assert con.execute("SELECT count(*) FROM blocks").fetchone()[0] == 7

    # asset url rewritten to content-addressed path
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    text = con.execute("SELECT text FROM blocks WHERE uid='uid-link1x'").fetchone()[0]
    assert f"/assets/{sha}/paper-fig.png" in text
    assert "firebasestorage" not in text
    assert (out / "assets" / sha[:2] / sha).read_bytes() == b"PNGDATA"

    # assets table has both files; fts works; refs derived
    assert con.execute("SELECT count(*) FROM assets").fetchone()[0] == 2
    assert con.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                       " MATCH 'Attention'").fetchone()[0] == 1
    kinds = dict(con.execute(
        "SELECT kind, count(*) FROM refs GROUP BY kind").fetchall())
    assert kinds["attribute"] == 1
    assert kinds["tag"] == 2

    report = (out / "import-report.txt").read_text()
    assert "block refs ((...)): 1" in report
    assert ":block/refs (1)" in report
    assert "missing asset urls: none" in report


def test_rerun_replaces_database(tmp_path):
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0
    con = sqlite3.connect(out / "pkm.sqlite3")
    con.execute("INSERT INTO pages VALUES (999, 'Scribble', NULL, NULL)")
    con.commit()
    con.close()
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0
    con = sqlite3.connect(out / "pkm.sqlite3")
    assert con.execute("SELECT count(*) FROM pages WHERE title='Scribble'"
                       ).fetchone()[0] == 0
