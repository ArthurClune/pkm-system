import hashlib
import os
import sqlite3
from pathlib import Path

import pytest

from pkm.export.writer import export_graph
from pkm.schema import DDL


def _snapshot(export_dir: Path) -> dict[str, bytes]:
    """Every file under `export_dir`, by relative path, with its bytes."""
    return {str(p.relative_to(export_dir)): p.read_bytes()
           for p in export_dir.rglob("*") if p.is_file()}


@pytest.fixture()
def graph(tmp_path):
    db = sqlite3.connect(tmp_path / "g.sqlite3")
    db.row_factory = sqlite3.Row
    db.executescript(DDL)
    db.executemany("INSERT INTO pages VALUES (?,?,?,?)", [
        (1, "Alpha", None, None),
        (2, "July 7th, 2026", None, None),
    ])
    # pkm-x3l7: export_graph now verifies an existing asset's sha256/size
    # before hardlinking it forward, so the fixture's sha must be the
    # real hash of its bytes (b"png") -- a placeholder would look
    # corrupt on every run after the first.
    sha = hashlib.sha256(b"png").hexdigest()
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", [
        ("u1u1u1", 1, None, 0, "root block", None, 0, None, None),
        ("u2u2u2", 1, "u1u1u1", 0, f"![pic](/assets/{sha}/pic.png)", None, 0, None, None),
        ("u3u3u3", 2, None, 0, "journal refs ((u1u1u1))", None, 0, None, None),
        ])
    db.execute("INSERT INTO assets(sha256, filename, mime, size, created_at)"
               " VALUES (?,?,?,?,?)",
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
    assert (export / ".gitignore").read_text() == "assets/\n.export-staging-*/\n"


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
    db.execute("INSERT INTO assets(sha256, filename, mime, size, created_at)"
              " VALUES (?,?,?,?,?)",
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
    db.executemany(
        "INSERT INTO assets(sha256, filename, mime, size, created_at)"
        " VALUES (?,?,?,?,?)", [
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


def test_render_failure_preserves_previous_export(graph, monkeypatch):
    # A crash while rendering a page must not touch the last good export:
    # the old export is only replaced once a full new one is ready.
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)
    before = _snapshot(export)

    db.execute("INSERT INTO pages VALUES (?,?,?,?)", (3, "Beta", None, None))
    db.commit()

    def boom(*a, **kw):
        raise RuntimeError("simulated render failure")
    monkeypatch.setattr("pkm.export.writer.render_page", boom)

    with pytest.raises(RuntimeError):
        export_graph(db, live_assets, export)

    assert _snapshot(export) == before


def test_asset_copy_failure_preserves_previous_export(graph, monkeypatch):
    # A crash while copying a *new* asset into the export must not touch
    # the last good export either -- not even a brand-new page that
    # rendered fine before the copy blew up.
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)
    before = _snapshot(export)

    db.execute("INSERT INTO pages VALUES (?,?,?,?)", (3, "Beta", None, None))
    db.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        ("u4u4u4", 3, None, 0, "new content", None, 0, None, None))
    new_sha = "ef" * 32
    db.execute("INSERT INTO assets(sha256, filename, mime, size, created_at)"
              " VALUES (?,?,?,?,?)",
              (new_sha, "new.png", "image/png", 3, None))
    db.commit()
    (live_assets / new_sha[:2]).mkdir(parents=True, exist_ok=True)
    (live_assets / new_sha[:2] / new_sha).write_bytes(b"new")

    def boom(*a, **kw):
        raise OSError("simulated disk failure during asset copy")
    monkeypatch.setattr("pkm.export.writer.shutil.copy2", boom)

    with pytest.raises(OSError):
        export_graph(db, live_assets, export)

    assert _snapshot(export) == before


def test_recovers_from_an_abandoned_stale_dir(graph):
    # If a process died after both renames in _publish_dir landed but
    # before the final "<name>.stale" cleanup ran, `target` already holds
    # the correct new content and an orphaned "<name>.stale" sits beside
    # it. The next run must clear that leftover on its own.
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)
    (export / "pages.stale").mkdir()
    (export / "pages.stale" / "leftover.md").write_text("garbage")

    counts = export_graph(db, live_assets, export)

    assert counts == {"pages": 1, "journal": 1,
                      "assets_copied": 0, "assets_pruned": 0}
    assert not (export / "pages.stale").exists()
    assert (export / "pages" / "Alpha.md").is_file()


def test_recovers_from_a_crash_between_the_two_publish_renames(graph):
    # The riskier crash window: a process died *between* _publish_dir's
    # two renames, so `target` itself moved aside to "<name>.stale" and
    # was never replaced -- `target` is missing outright and the real
    # (old) content lives only under the stale name. The next run must
    # still recover: the stale content is superseded by a freshly
    # rendered `target`, and the stale dir is cleared.
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)
    (export / "pages").rename(export / "pages.stale")
    assert not (export / "pages").exists()

    counts = export_graph(db, live_assets, export)

    assert counts == {"pages": 1, "journal": 1,
                      "assets_copied": 0, "assets_pruned": 0}
    assert not (export / "pages.stale").exists()
    assert (export / "pages" / "Alpha.md").is_file()


def test_repairs_truncated_existing_asset_from_live_store(graph):
    # pkm-x3l7: a previously-exported asset file that got truncated on
    # disk must not be hardlinked forward as-is -- the next export has
    # to notice the size mismatch and re-copy the correct bytes from the
    # live store instead.
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)
    corrupt = export / "assets" / sha / "pic.png"
    corrupt.write_bytes(b"pn")  # truncated: live bytes are b"png"

    counts = export_graph(db, live_assets, export)

    assert counts["assets_copied"] == 1  # re-copied, not hardlinked
    assert (export / "assets" / sha / "pic.png").read_bytes() == b"png"


def test_repairs_same_size_corrupted_existing_asset_from_live_store(graph):
    # Same byte count as the real asset but different content (bit rot,
    # a same-length overwrite) -- undetectable by size alone, so this
    # only gets caught once the hash is actually compared.
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)
    corrupt = export / "assets" / sha / "pic.png"
    assert len(corrupt.read_bytes()) == len(b"png")
    corrupt.write_bytes(b"bad")  # same length as b"png", wrong bytes

    counts = export_graph(db, live_assets, export)

    assert counts["assets_copied"] == 1
    assert (export / "assets" / sha / "pic.png").read_bytes() == b"png"


def test_valid_existing_asset_is_still_hardlinked_not_recopied(graph):
    # The common case must stay cheap: a byte-identical existing asset
    # is still hardlinked, not re-copied, after verification.
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)
    before_inode = (export / "assets" / sha / "pic.png").stat().st_ino

    counts = export_graph(db, live_assets, export)

    assert counts["assets_copied"] == 0
    after = export / "assets" / sha / "pic.png"
    assert after.read_bytes() == b"png"
    assert after.stat().st_ino == before_inode


def test_cross_subtree_publish_failure_recovers_on_next_run(graph, monkeypatch):
    # _publish_dir is called once per subtree (pages, then journal, then
    # assets); each call is individually atomic, but the three together
    # are not a single transaction. If journal's publish fails after
    # pages' already landed, this run leaves pages/ on the new content
    # while journal/ is stuck mid-swap (moved aside to journal.stale,
    # never replaced) and assets/ untouched -- a real mixed state, not
    # byte-identical to the pre-run export. What must still hold: nothing
    # is corrupted or silently lost, the failure is raised (so the
    # nightly job exits nonzero and never git-commits this run's output,
    # per backup/__main__.py), and the very next successful run converges
    # to a fully consistent export.
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)

    db.execute("INSERT INTO pages VALUES (?,?,?,?)", (3, "Beta", None, None))
    db.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        ("u4u4u4", 3, None, 0, "new content", None, 0, None, None))
    db.commit()

    real_replace = os.replace

    def flaky_replace(src, dst):
        if Path(dst).name == "journal":  # the *second* replace inside
            raise OSError("simulated failure publishing journal/")  # _publish_dir(journal)
        return real_replace(src, dst)
    monkeypatch.setattr("pkm.export.writer.os.replace", flaky_replace)

    with pytest.raises(OSError):
        export_graph(db, live_assets, export)

    # pages/ already published this run's new content...
    assert (export / "pages" / "Beta.md").is_file()
    # ...journal/ is missing outright (mid-swap), old content preserved
    # under journal.stale rather than lost...
    assert not (export / "journal").exists()
    assert (export / "journal.stale" / "2026-07-07.md").is_file()
    # ...and assets/ was never reached, so it's still exactly as before.
    assert (export / "assets" / sha / "pic.png").read_bytes() == b"png"

    monkeypatch.undo()  # restore the real os.replace for the recovery run
    counts = export_graph(db, live_assets, export)

    assert counts == {"pages": 2, "journal": 1,
                      "assets_copied": 0, "assets_pruned": 0}
    assert not (export / "journal.stale").exists()
    assert (export / "journal" / "2026-07-07.md").is_file()
    assert (export / "pages" / "Beta.md").is_file()
