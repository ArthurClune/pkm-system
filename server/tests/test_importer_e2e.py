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


def test_duplicate_content_assets_do_not_crash(tmp_path):
    # Two differently-named files with identical bytes hash to the same
    # sha256, and must be deduped before the INSERT INTO assets (which has
    # sha256 as PRIMARY KEY) or main() raises sqlite3.IntegrityError.
    files = tmp_path / "files"
    files.mkdir()
    (files / "paper-fig.png").write_bytes(b"PNGDATA")
    (files / "paper-fig-copy.png").write_bytes(b"PNGDATA")
    out = tmp_path / "data"

    rc = main([str(FIXTURE), "--files", str(files), "--out", str(out)])
    assert rc == 0

    con = sqlite3.connect(out / "pkm.sqlite3")
    assert con.execute("SELECT count(*) FROM assets").fetchone()[0] == 1

    report = (out / "import-report.txt").read_text()
    assert "assets: 1 in store" in report


def test_stale_tmp_asset_does_not_survive_import(tmp_path):
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    stale_dir = out / "assets" / sha[:2]
    stale_dir.mkdir(parents=True)
    (stale_dir / f"{sha}.tmp").write_bytes(b"PARTIAL-LEFTOVER")

    rc = main([str(FIXTURE), "--files", str(files), "--out", str(out)])
    assert rc == 0

    dest = out / "assets" / sha[:2] / sha
    assert dest.read_bytes() == b"PNGDATA"
    assert list((out / "assets").rglob("*.tmp")) == []


def test_missing_export_file_reports_friendly_error(tmp_path, capsys):
    missing = tmp_path / "nope.edn"
    out = tmp_path / "data"
    rc = main([str(missing), "--out", str(out)])
    assert rc == 2
    captured = capsys.readouterr()
    assert f"error: export file not found: {missing}" in captured.err


def test_missing_files_dir_warns_and_continues(tmp_path, capsys):
    missing_files = tmp_path / "no-such-files-dir"
    out = tmp_path / "data"
    rc = main([str(FIXTURE), "--files", str(missing_files), "--out", str(out)])
    assert rc == 0
    captured = capsys.readouterr()
    assert f"warning: --files dir missing or empty: {missing_files}" in captured.err


def test_index_files_registers_uid_prefix_keys(tmp_path):
    from pkm.importer.run import _index_files
    files = tmp_path / "files"
    files.mkdir()
    (files / "abCdEfGhIj-Screenshot 2025.png").write_bytes(b"X")
    by_name, paths = _index_files(files)
    assert "abcdefghij-screenshot 2025.png" in by_name
    assert "abcdefghij" in by_name
    assert by_name["abcdefghij"].filename == "abCdEfGhIj-Screenshot 2025.png"


def test_index_files_bounds_overlong_and_multibyte_filenames(tmp_path):
    # Roam's linked-files export can contain names up to the local
    # filesystem's own ~255-byte cap (and names with multibyte
    # characters); the stored/displayed filename must be bounded further
    # still, even though the lookup key stays on the raw name so in-text
    # asset URLs still resolve.
    from pkm.importer.run import _index_files
    files = tmp_path / "files"
    files.mkdir()
    overlong = "x" * 230 + ".png"  # 234 bytes: valid on disk, over our cap
    multibyte = "é" * 110 + ".png"  # 224 bytes: valid on disk, over our cap
    (files / overlong).write_bytes(b"X")
    (files / multibyte).write_bytes(b"Y")
    by_name, paths = _index_files(files)

    overlong_asset = by_name[overlong.lower()]
    assert overlong_asset.filename.endswith(".png")
    assert len(overlong_asset.filename.encode("utf-8")) <= 200

    multibyte_asset = by_name[multibyte.lower()]
    assert multibyte_asset.filename.endswith(".png")
    assert len(multibyte_asset.filename.encode("utf-8")) <= 200
    multibyte_asset.filename.encode("utf-8").decode("utf-8")  # no split code point


def test_overlong_filename_import_produces_bounded_asset_row(tmp_path):
    # End-to-end: a linked-files download with an overlong (but locally
    # valid, ~234-byte) name must not leave an unsanitized assets.filename
    # row at rest (the exporter's own defense is a second line of defense,
    # not a substitute for this one).
    files = _setup_files(tmp_path)
    overlong_name = "y" * 230 + ".png"
    (files / overlong_name).write_bytes(b"OVERLONG")
    out = tmp_path / "data"
    rc = main([str(FIXTURE), "--files", str(files), "--out", str(out)])
    assert rc == 0

    con = sqlite3.connect(out / "pkm.sqlite3")
    sha = hashlib.sha256(b"OVERLONG").hexdigest()
    filename = con.execute(
        "SELECT filename FROM assets WHERE sha256 = ?", (sha,)).fetchone()[0]
    assert filename.endswith(".png")
    assert len(filename.encode("utf-8")) <= 200
    assert filename != overlong_name
