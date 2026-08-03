import hashlib
import sqlite3
from pathlib import Path

import pytest

import pkm.importer.run as run_module
from pkm.importer.rows import RECOVERY_PAGE_TITLE
from pkm.importer.run import main
from pkm.refs import title_syntax_reason

FIXTURE = Path(__file__).parent / "fixtures" / "sample_export.edn"

MERGE_EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Acme" 1]
  [1 :block/children 2 1]
  [2 :block/uid "uid-clean-root" 1]
  [2 :block/string "clean root" 1]
  [2 :block/order 0 1]
  [10 :node/title " Acme " 1]
  [10 :block/children 11 1]
  [11 :block/uid "uid-padded-root" 1]
  [11 :block/string "self [[ Acme ]] and [[Other]]" 1]
  [11 :block/order 0 1]
  [11 :block/children 12 1]
  [12 :block/uid "uid-padded-child" 1]
  [12 :block/string "nested child" 1]
  [12 :block/order 0 1]
  [20 :node/title "Watcher" 1]
  [20 :block/children 21 1]
  [21 :block/uid "uid-watcher" 1]
  [21 :block/string "[[Acme]] and [[ Acme ]]" 1]
  [21 :block/order 0 1]
 ]}"""

ORDINARY_EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Solo" 1]
  [1 :block/children 2 1]
  [2 :block/uid "uid-solo" 1]
  [2 :block/string "hello" 1]
  [2 :block/order 0 1]
 ]}"""

TITLE_SYNTAX_EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "#Project" 1]
  [1 :create/time 100 1]
  [1 :edit/time 101 1]
  [1 :block/children 2 1]
  [2 :block/uid "uid-dirty-root" 1]
  [2 :block/string "[[Outer [[Inner]]]] [[Topic #One]] #Tag #[[Tag]] [[#Project]]" 1]
  [2 :block/order 0 1]
  [2 :block/children 3 1]
  [3 :block/uid "uid-dirty-child" 1]
  [3 :block/string "keep ((uid-clean-root))" 1]
  [3 :block/order 0 1]
  [10 :node/title "Project" 1]
  [10 :create/time 200 1]
  [10 :edit/time 201 1]
  [10 :block/children 11 1]
  [11 :block/uid "uid-clean-root" 1]
  [11 :block/string "clean root" 1]
  [11 :block/order 0 1]
  [20 :node/title "Watcher" 1]
  [20 :block/children 21 1]
  [21 :block/uid "uid-watcher" 1]
  [21 :block/string "[[#Project]]" 1]
  [21 :block/order 0 1]
 ]}"""

EXTRACTOR_NORMALIZATION_EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Source" 1]
  [1 :block/children 2 1]
  [2 :block/uid "uid-source" 1]
  [2 :block/string "  Bad#Title:: value and [[Bad
#Title]] tail" 1]
  [2 :block/order 0 1]
  [2 :block/children 3 1]
  [3 :block/uid "uid-child" 1]
  [3 :block/string "unchanged child" 1]
  [3 :block/order 0 1]
 ]}"""

MALFORMED_TITLE_EXPORT = """#datascript/DB {:schema {}
 :datoms [[1 :node/title "Bad [[Title" 1]]}"""

BLANK_MARKER_TITLE_EXPORT = """#datascript/DB {:schema {}
 :datoms [[1 :node/title "[[#]]" 1]]}"""

POST_SANITIZATION_MALFORMED_TITLE_EXPORT = """#datascript/DB {:schema {}
 :datoms [[1 :node/title "[#[" 1]]}"""

DUPLICATE_UID_EXPORT = """#datascript/DB {:schema {:block/children {:db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Tree" 1]
  [1 :block/children 2 1]
  [1 :block/children 3 1]
  [2 :block/uid "duplicate" 1]
  [2 :block/string "first" 1]
  [2 :block/order 0 1]
  [3 :block/uid "duplicate" 1]
  [3 :block/string "second" 1]
  [3 :block/order 1 1]
 ]}"""

MULTI_PARENT_EXPORT = """#datascript/DB {:schema {:block/children {:db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Tree" 1]
  [1 :block/children 2 1]
  [1 :block/children 3 1]
  [2 :block/uid "left" 1]
  [2 :block/string "left" 1]
  [2 :block/order 0 1]
  [2 :block/children 4 1]
  [3 :block/uid "right" 1]
  [3 :block/string "right" 1]
  [3 :block/order 1 1]
  [3 :block/children 4 1]
  [4 :block/uid "shared" 1]
  [4 :block/string "shared" 1]
  [4 :block/order 0 1]
 ]}"""


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
                      "query", "Paper", RECOVERY_PAGE_TITLE}
    # the fixture's one orphan block ("uid-orphan") is now preserved, not dropped
    assert con.execute("SELECT count(*) FROM blocks").fetchone()[0] == 8

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
    assert f"recovered to '{RECOVERY_PAGE_TITLE}'" in report
    assert "not imported" not in report


def test_orphan_block_is_preserved_not_silently_dropped(tmp_path):
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0

    con = sqlite3.connect(out / "pkm.sqlite3")
    row = con.execute(
        "SELECT page_id, parent_uid, text FROM blocks WHERE uid='uid-orphan'").fetchone()
    assert row is not None, "orphan block must still exist somewhere in the database"
    page_id, parent_uid, text = row
    assert text == "unreachable block"
    assert parent_uid is None  # top-level on the recovery page, not nested under anything
    recovery_page_id = con.execute(
        "SELECT id FROM pages WHERE title=?", (RECOVERY_PAGE_TITLE,)).fetchone()[0]
    assert page_id == recovery_page_id


ORPHAN_CLASSES_EXPORT = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Page" 1]
  [1 :block/children 2 1]
  [2 :block/uid "uid-page-child" 1]
  [2 :block/string "reachable" 1]
  [2 :block/order 0 1]
  [20 :block/uid "uid-skipped-parent" 1]
  [20 :block/children 21 1]
  [21 :block/uid "uid-real-orphan-child" 1]
  [21 :block/string "real orphan child text" 1]
  [21 :block/order 0 1]
  [30 :block/uid "uid-cycle-a" 1]
  [30 :block/string "cycle A" 1]
  [30 :block/children 31 1]
  [31 :block/uid "uid-cycle-b" 1]
  [31 :block/string "cycle B" 1]
  [31 :block/children 30 1]
 ]}"""


def test_orphan_classes_survive_the_full_pipeline_without_integrity_error(tmp_path):
    # A block whose parent has a uid but no :block/string, and a cyclic
    # pair (A <-> B) with no external entry point, both used to be
    # silently dropped by parse_export's root selection. Reproduced
    # end-to-end (not just at the parse_export unit level) since the
    # earlier, buggy root-selection could also double-embed a shared
    # descendant across two roots and raise sqlite3.IntegrityError on the
    # blocks.uid primary key -- rc == 0 here means neither happened.
    export_file = tmp_path / "orphan-classes.edn"
    export_file.write_text(ORPHAN_CLASSES_EXPORT, encoding="utf-8")
    out = tmp_path / "data"

    rc = main([str(export_file), "--out", str(out)])
    assert rc == 0

    con = sqlite3.connect(out / "pkm.sqlite3")
    recovered = {r[0] for r in con.execute(
        "SELECT uid FROM blocks WHERE uid != 'uid-page-child'")}
    assert recovered == {"uid-real-orphan-child", "uid-cycle-a", "uid-cycle-b"}

    report = (out / "import-report.txt").read_text()
    assert f"recovered to '{RECOVERY_PAGE_TITLE}'): 3" in report


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


def test_report_failure_leaves_existing_database_untouched(tmp_path, monkeypatch):
    # The report must be fully written before the database is published: a
    # failure while rendering/writing it (disk full, permissions, ...) must
    # not leave a swapped-in database with no report, or a stale one.
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0
    original_db = (out / "pkm.sqlite3").read_bytes()
    original_report = (out / "import-report.txt").read_text()

    def boom(report):
        raise RuntimeError("simulated report failure")
    monkeypatch.setattr(run_module, "render", boom)

    with pytest.raises(RuntimeError, match="simulated report failure"):
        main([str(FIXTURE), "--files", str(files), "--out", str(out)])

    assert (out / "pkm.sqlite3").read_bytes() == original_db
    assert (out / "import-report.txt").read_text() == original_report
    assert not (out / "pkm.sqlite3.tmp").exists()


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


def test_truncated_existing_asset_is_repaired(tmp_path):
    # pkm-x3l7: a content-addressed asset file that survived a previous
    # truncated write must not be trusted just because it exists at its
    # sha-named path -- a re-run has to notice and rewrite it.
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    dest = out / "assets" / sha[:2] / sha
    dest.write_bytes(b"PNGDA")  # truncated

    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0

    assert dest.read_bytes() == b"PNGDATA"


def test_same_size_corrupted_existing_asset_is_repaired(tmp_path):
    # Same byte count as the real asset but wrong content -- a size
    # check alone can't catch this, only a hash comparison can.
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    dest = out / "assets" / sha[:2] / sha
    assert len(dest.read_bytes()) == len(b"PNGDATA")
    dest.write_bytes(b"CORRUPTX")  # same length, wrong bytes

    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0

    assert dest.read_bytes() == b"PNGDATA"


def test_repair_is_atomic_no_tmp_leftover(tmp_path):
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    dest = out / "assets" / sha[:2] / sha
    dest.write_bytes(b"GARBAGE!")

    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0

    assert dest.read_bytes() == b"PNGDATA"
    assert list((out / "assets").rglob("*.tmp")) == []


def test_valid_existing_asset_is_not_rewritten(tmp_path, monkeypatch):
    # The common case must stay cheap and not touch a byte-identical file.
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    dest = out / "assets" / sha[:2] / sha
    before_mtime = dest.stat().st_mtime_ns

    assert main([str(FIXTURE), "--files", str(files), "--out", str(out)]) == 0

    assert dest.stat().st_mtime_ns == before_mtime
    assert dest.read_bytes() == b"PNGDATA"


def test_missing_export_file_reports_friendly_error(tmp_path, capsys):
    missing = tmp_path / "nope.edn"
    out = tmp_path / "data"
    rc = main([str(missing), "--out", str(out)])
    assert rc == 2
    captured = capsys.readouterr()
    assert f"error: export file not found: {missing}" in captured.err


def test_malformed_export_reports_friendly_error_before_output(tmp_path, capsys):
    malformed = tmp_path / "malformed.edn"
    malformed.write_text('"\\/"', encoding="utf-8")
    out = tmp_path / "data"

    rc = main([str(malformed), "--out", str(out)])

    assert rc == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        "error: malformed export at offset 1: unsupported escape '\\/'\n"
    )
    assert not out.exists()


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


def _write_export(tmp_path: Path, name: str, raw: str) -> Path:
    export_file = tmp_path / name
    export_file.write_text(raw, encoding="utf-8")
    return export_file


def test_import_canonicalizes_padded_titles_before_publication(tmp_path):
    export_file = _write_export(tmp_path, "merge.edn", MERGE_EXPORT)
    out = tmp_path / "data"

    rc = main([str(export_file), "--out", str(out)])

    assert rc == 0
    con = sqlite3.connect(out / "pkm.sqlite3")
    assert con.execute(
        "SELECT value FROM sync_meta WHERE key='plain_space_title_canonicalization'"
    ).fetchone()[0] == "1"
    page_ids = {
        title: page_id
        for page_id, title in con.execute("SELECT id, title FROM pages ORDER BY id")
    }
    assert page_ids.keys() == {"Acme", "Watcher", "Other"}
    assert [tuple(row) for row in con.execute(
        "SELECT uid, page_id, parent_uid, order_idx, text FROM blocks ORDER BY uid"
    )] == [
        ("uid-clean-root", page_ids["Acme"], None, 0, "clean root"),
        (
            "uid-padded-child",
            page_ids["Acme"],
            "uid-padded-root",
            0,
            "nested child",
        ),
        (
            "uid-padded-root",
            page_ids["Acme"],
            None,
            1,
            "self [[Acme]] and [[Other]]",
        ),
        ("uid-watcher", page_ids["Watcher"], None, 0, "[[Acme]] and [[Acme]]"),
    ]
    assert [tuple(row) for row in con.execute(
        "SELECT src_block_uid, target_page_id, kind FROM refs ORDER BY 1, 2, 3"
    )] == [
        ("uid-padded-root", page_ids["Acme"], "link"),
        ("uid-padded-root", page_ids["Other"], "link"),
        ("uid-watcher", page_ids["Acme"], "link"),
    ]


def test_import_sanitizes_title_syntax_before_rows_and_reports_merges(tmp_path):
    export_file = _write_export(tmp_path, "title-syntax.edn", TITLE_SYNTAX_EXPORT)
    out = tmp_path / "data"

    rc = main([str(export_file), "--out", str(out)])

    assert rc == 0
    con = sqlite3.connect(out / "pkm.sqlite3")
    assert con.execute(
        "SELECT value FROM sync_meta WHERE key='plain_space_title_canonicalization'"
    ).fetchone()[0] == "1"
    page_ids = {
        title: page_id
        for page_id, title in con.execute("SELECT id, title FROM pages ORDER BY id")
    }
    assert page_ids.keys() == {
        "Project",
        "Watcher",
        "Outer Inner",
        "Topic One",
        "Tag",
    }
    assert all(title_syntax_reason(title) is None for title in page_ids)
    assert con.execute(
        "SELECT created_at, updated_at FROM pages WHERE title='Project'"
    ).fetchone() == (200, 201)
    assert [tuple(row) for row in con.execute(
        "SELECT uid, parent_uid, order_idx, text FROM blocks "
        "WHERE page_id=? ORDER BY CASE WHEN parent_uid IS NULL THEN order_idx ELSE 99 END",
        (page_ids["Project"],),
    )] == [
        ("uid-clean-root", None, 0, "clean root"),
        (
            "uid-dirty-root",
            None,
            1,
            "[[Outer Inner]] [[Topic One]] #Tag #[[Tag]] [[Project]]",
        ),
        ("uid-dirty-child", "uid-dirty-root", 0, "keep ((uid-clean-root))"),
    ]
    assert con.execute(
        "SELECT text FROM blocks WHERE uid='uid-watcher'"
    ).fetchone()[0] == "[[Project]]"
    assert [tuple(row) for row in con.execute(
        "SELECT src_block_uid, target_page_id, kind FROM refs ORDER BY 1, 2, 3"
    )] == sorted([
        ("uid-dirty-root", page_ids["Outer Inner"], "link"),
        ("uid-dirty-root", page_ids["Topic One"], "link"),
        ("uid-dirty-root", page_ids["Tag"], "tag"),
        ("uid-dirty-root", page_ids["Project"], "link"),
        ("uid-watcher", page_ids["Project"], "link"),
    ])

    report = (out / "import-report.txt").read_text(encoding="utf-8")
    assert "title spellings sanitized: 3" in report
    assert (
        '  "#Project" -> "Project" '
        "(merged; page[0], block uid-dirty-root, block uid-watcher)"
    ) in report
    assert (
        '  "Outer [[Inner]]" -> "Outer Inner" (block uid-dirty-root)'
    ) in report


def test_import_rewrites_every_extracted_title_before_rows(tmp_path):
    export_file = _write_export(
        tmp_path, "extractor-normalization.edn", EXTRACTOR_NORMALIZATION_EXPORT
    )
    out = tmp_path / "data"

    assert main([str(export_file), "--out", str(out)]) == 0

    con = sqlite3.connect(out / "pkm.sqlite3")
    page_ids = {
        title: page_id
        for page_id, title in con.execute("SELECT id, title FROM pages ORDER BY id")
    }
    assert page_ids.keys() == {"Source", "BadTitle", "Bad Title"}
    assert all(title_syntax_reason(title) is None for title in page_ids)
    assert con.execute(
        "SELECT text FROM blocks WHERE uid='uid-source'"
    ).fetchone()[0] == "  BadTitle:: value and [[Bad Title]] tail"
    assert con.execute(
        "SELECT parent_uid, text FROM blocks WHERE uid='uid-child'"
    ).fetchone() == ("uid-source", "unchanged child")
    assert [tuple(row) for row in con.execute(
        "SELECT src_block_uid, target_page_id, kind FROM refs ORDER BY kind"
    )] == [
        ("uid-source", page_ids["BadTitle"], "attribute"),
        ("uid-source", page_ids["Bad Title"], "link"),
    ]


def test_import_marks_ordinary_database_active(tmp_path):
    export_file = _write_export(tmp_path, "ordinary.edn", ORDINARY_EXPORT)
    out = tmp_path / "data"

    rc = main([str(export_file), "--out", str(out)])

    assert rc == 0
    con = sqlite3.connect(out / "pkm.sqlite3")
    assert con.execute(
        "SELECT value FROM sync_meta WHERE key='plain_space_title_canonicalization'"
    ).fetchone()[0] == "1"
    assert con.execute("SELECT title FROM pages").fetchall() == [("Solo",)]


@pytest.mark.parametrize(
    ("raw", "original_title", "reason"),
    [
        (MALFORMED_TITLE_EXPORT, "Bad [[Title", "malformed_syntax"),
        (BLANK_MARKER_TITLE_EXPORT, "[[#]]", "blank"),
        (POST_SANITIZATION_MALFORMED_TITLE_EXPORT, "[#[", "malformed_syntax"),
    ],
)
def test_title_syntax_refusal_preserves_published_output(
    tmp_path, capsys, raw, original_title, reason
):
    baseline_export = _write_export(tmp_path, "baseline.edn", ORDINARY_EXPORT)
    blocked_export = _write_export(tmp_path, "blocked.edn", raw)
    out = tmp_path / "data"

    assert main([str(baseline_export), "--out", str(out)]) == 0
    original_db = (out / "pkm.sqlite3").read_bytes()
    original_report = (out / "import-report.txt").read_text(encoding="utf-8")

    rc = main([str(blocked_export), "--out", str(out)])

    assert rc == 2
    captured = capsys.readouterr()
    assert (
        f"error: import refused at page[0]: {reason}: {original_title!r}"
        in captured.err
    )
    assert (out / "pkm.sqlite3").read_bytes() == original_db
    assert (out / "import-report.txt").read_text(encoding="utf-8") == original_report
    assert not (out / "pkm.sqlite3.tmp").exists()


def test_title_syntax_refusal_precedes_output_directory_creation(tmp_path):
    blocked_export = _write_export(
        tmp_path, "malformed.edn", MALFORMED_TITLE_EXPORT
    )
    out = tmp_path / "new-data"

    assert main([str(blocked_export), "--out", str(out)]) == 2

    assert not out.exists()


@pytest.mark.parametrize(
    ("raw", "detail"),
    [
        (
            DUPLICATE_UID_EXPORT,
            "duplicate block UID 'duplicate': "
            "pages[0] 'Tree'.children[0]; pages[0] 'Tree'.children[1]",
        ),
        (
            MULTI_PARENT_EXPORT,
            "block with multiple parents 'shared': "
            "pages[0] 'Tree'.children[0].children[0]; "
            "pages[0] 'Tree'.children[1].children[0]",
        ),
    ],
)
def test_invalid_tree_refuses_before_sanitization_or_linked_file_work(
    tmp_path, monkeypatch, capsys, raw, detail
):
    export_file = _write_export(tmp_path, "invalid-tree.edn", raw)
    files = _setup_files(tmp_path)
    out = tmp_path / "data"
    out.mkdir()
    database = out / "pkm.sqlite3"
    report = out / "import-report.txt"
    database.write_bytes(b"database-sentinel")
    report.write_text("report-sentinel", encoding="utf-8")

    def unexpected_work(*_args, **_kwargs):
        raise AssertionError("structural refusal happened too late")

    monkeypatch.setattr(run_module, "sanitize_export_titles", unexpected_work)
    monkeypatch.setattr(run_module, "_index_files", unexpected_work)

    rc = main(
        [str(export_file), "--files", str(files), "--out", str(out)]
    )

    assert rc == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == f"error: invalid export structure: {detail}\n"
    assert database.read_bytes() == b"database-sentinel"
    assert report.read_text(encoding="utf-8") == "report-sentinel"
    assert not (out / "pkm.sqlite3.tmp").exists()
    assert not (out / "import-report.txt.tmp").exists()
