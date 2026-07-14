import sqlite3

import pytest

from pkm.export.writer import export_graph
from pkm.schema import DDL


@pytest.fixture()
def graph(tmp_path):
    db = sqlite3.connect(tmp_path / "g.sqlite3")
    db.row_factory = sqlite3.Row
    db.executescript(DDL)
    db.executemany("INSERT INTO pages VALUES (?,?,?,?)", [
        (1, "Alpha", None, None),
        (2, "July 7th, 2026", None, None),
    ])
    sha = "ab" * 32
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", [
        ("u1u1u1", 1, None, 0, "root block", None, 0, None, None),
        ("u2u2u2", 1, "u1u1u1", 0, f"![pic](/assets/{sha}/pic.png)", None, 0, None, None),
        ("u3u3u3", 2, None, 0, "journal refs ((u1u1u1))", None, 0, None, None),
        ])
    db.execute("INSERT INTO assets VALUES (?,?,?,?,?)",
               (sha, "pic.png", "image/png", 3, None))
    db.commit()
    live_assets = tmp_path / "live-assets"
    (live_assets / sha[:2]).mkdir(parents=True)
    (live_assets / sha[:2] / sha).write_bytes(b"png")
    return db, live_assets, tmp_path / "export", sha


def test_export_writes_pages_journal_assets(graph):
    db, live_assets, export, sha = graph
    counts = export_graph(db, live_assets, export)
    assert counts == {"pages": 1, "journal": 1,
                      "assets_copied": 1, "assets_pruned": 0}
    page = (export / "pages" / "Alpha.md").read_text()
    assert f"  - ![pic](../assets/{sha}/pic.png)" in page
    journal = (export / "journal" / "2026-07-07.md").read_text()
    assert "- journal refs ((root block))" in journal
    assert (export / "assets" / sha / "pic.png").read_bytes() == b"png"
    assert (export / ".gitignore").read_text() == "assets/\n"


def test_export_is_incremental_and_prunes(graph):
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)
    counts = export_graph(db, live_assets, export)
    assert counts["assets_copied"] == 0  # second run copies nothing
    db.execute("DELETE FROM assets WHERE sha256 = ?", (sha,))
    db.commit()
    counts = export_graph(db, live_assets, export)
    assert counts["assets_pruned"] == 1
    assert not (export / "assets" / sha).exists()


def test_deleted_page_disappears_from_export(graph):
    db, live_assets, export, _ = graph
    export_graph(db, live_assets, export)
    db.execute("DELETE FROM pages WHERE id = 1")
    db.commit()
    counts = export_graph(db, live_assets, export)
    assert counts["pages"] == 0
    assert not (export / "pages" / "Alpha.md").exists()


def test_export_survives_overlong_asset_filename(tmp_path):
    # Regression: a DB row with an unbounded filename (e.g. from a direct
    # API client, not the upload route's own guard) used to make
    # export_graph() raise OSError [Errno 63] File name too long.
    db = sqlite3.connect(tmp_path / "g.sqlite3")
    db.row_factory = sqlite3.Row
    db.executescript(DDL)
    sha = "cd" * 32
    db.execute("INSERT INTO assets VALUES (?,?,?,?,?)",
              (sha, "x" * 300 + ".png", "image/png", 3, None))
    db.commit()
    live_assets = tmp_path / "live-assets"
    (live_assets / sha[:2]).mkdir(parents=True)
    (live_assets / sha[:2] / sha).write_bytes(b"png")
    counts = export_graph(db, live_assets, tmp_path / "export")
    assert counts["assets_copied"] == 1
    copied = list((tmp_path / "export" / "assets" / sha).iterdir())
    assert len(copied) == 1
    assert copied[0].name.endswith(".png")
    assert len(copied[0].name.encode("utf-8")) <= 200


def test_export_does_not_clobber_assets_that_collide_after_truncation(tmp_path):
    # Two different overlong filenames can truncate to the same string, but
    # each asset lives under its own sha256 directory, so they must not
    # overwrite each other.
    db = sqlite3.connect(tmp_path / "g.sqlite3")
    db.row_factory = sqlite3.Row
    db.executescript(DDL)
    sha_a, sha_b = "aa" * 32, "bb" * 32
    db.executemany("INSERT INTO assets VALUES (?,?,?,?,?)", [
        (sha_a, "A" * 250 + ".png", "image/png", 3, None),
        (sha_b, "A" * 250 + "Z" * 50 + ".png", "image/png", 3, None),
    ])
    db.commit()
    live_assets = tmp_path / "live-assets"
    for sha, content in ((sha_a, b"one"), (sha_b, b"two")):
        (live_assets / sha[:2]).mkdir(parents=True, exist_ok=True)
        (live_assets / sha[:2] / sha).write_bytes(content)
    counts = export_graph(db, live_assets, tmp_path / "export")
    assert counts["assets_copied"] == 2
    assets_dir = tmp_path / "export" / "assets"
    name_a = next((assets_dir / sha_a).iterdir()).name
    name_b = next((assets_dir / sha_b).iterdir()).name
    assert name_a == name_b  # truncation collides...
    assert (assets_dir / sha_a / name_a).read_bytes() == b"one"
    assert (assets_dir / sha_b / name_b).read_bytes() == b"two"  # ...but not the files
