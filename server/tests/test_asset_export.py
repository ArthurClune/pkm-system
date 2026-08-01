"""POST /api/assets/export.zip: zip of selected assets (pkm-jdu3).

pkm-13ty bounds this route's memory/resource use two ways: a hard
count/byte limit on the selection (enforced from the `assets` table's
`size` column, before any file is opened) and a temp-file-backed archive
instead of building the whole zip in an in-memory BytesIO."""
import io
import time
import zipfile
from datetime import date
from pathlib import Path

import pytest

from pkm.filenames import safe_filename
from pkm.server import routes_assets
from pkm.server.db import open_db


def _upload(client, content, name, mime="image/png"):
    r = client.post("/api/assets", files={"file": (name, content, mime)})
    assert r.status_code == 200
    return r.json()


def _export(client, shas):
    return client.post("/api/assets/export.zip",
                       data={"sha256s": shas})


def _names(resp):
    return sorted(zipfile.ZipFile(io.BytesIO(resp.content)).namelist())


def _seed_assets(seeded_config, n, size_bytes):
    """Insert `n` asset rows directly (bypassing the upload endpoint, far
    too slow at this count) each claiming `size_bytes` in the DB, backed
    by a real but tiny on-disk file so the route's missing-file skip
    doesn't exclude them. The route must trust the DB's `size` column for
    its limit check rather than statting/reading the real (tiny) file --
    that's the whole point of checking the DB first."""
    db = open_db(seeded_config.db_path)
    shas = [f"{i:064x}" for i in range(n)]
    now = int(time.time() * 1000)
    db.executemany(
        "INSERT INTO assets(sha256, filename, mime, size, created_at)"
        " VALUES (?,?,?,?,?)",
        [(sha, f"f{i}.png", "image/png", size_bytes, now)
         for i, sha in enumerate(shas)])
    db.commit()
    db.close()
    for sha in shas:
        d = seeded_config.assets_dir / sha[:2]
        d.mkdir(parents=True, exist_ok=True)
        (d / sha).write_bytes(b"x")
    return shas


def test_export_selected_assets(client):
    a = _upload(client, b"AAA", "a.png")
    b = _upload(client, b"BBB", "b.pdf", "application/pdf")
    _upload(client, b"CCC", "c.png")  # not selected
    r = _export(client, [a["sha256"], b["sha256"]])
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    expected = f'attachment; filename="assets-{date.today().isoformat()}.zip"'
    assert r.headers["content-disposition"] == expected
    assert _names(r) == ["a.png", "b.pdf"]
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert zf.read("a.png") == b"AAA"


def test_export_filename_collision_gets_sha_prefix(client):
    a = _upload(client, b"AAA", "report.pdf", "application/pdf")
    b = _upload(client, b"BBB", "report.pdf", "application/pdf")
    r = _export(client, [a["sha256"], b["sha256"]])
    names = _names(r)
    assert "report.pdf" in names
    assert any(n.startswith("report (") and n.endswith(").pdf")
               for n in names)


def test_export_skips_unknown_and_malformed_and_duplicates(client):
    a = _upload(client, b"AAA", "a.png")
    r = _export(client, [a["sha256"], a["sha256"], "0" * 64, "junk"])
    assert r.status_code == 200
    assert _names(r) == ["a.png"]


def test_export_skips_missing_disk_file(client, seeded_config):
    a = _upload(client, b"AAA", "a.png")
    b = _upload(client, b"BBB", "b.png")
    (seeded_config.assets_dir / b["sha256"][:2] / b["sha256"]).unlink()
    r = _export(client, [a["sha256"], b["sha256"]])
    assert _names(r) == ["a.png"]


def test_export_empty_selection_returns_empty_zip(client):
    r = _export(client, [])
    assert r.status_code == 200
    assert _names(r) == []


def test_export_sanitizes_legacy_unsafe_filename(client, seeded_config):
    """A row written before the sanitization bound existed may hold an
    unsafe filename (e.g. path traversal) -- export must re-sanitize on
    the way out, same as the whole-db exporter, so a legacy row can
    never produce a zip-slip-shaped arcname."""
    a = _upload(client, b"AAA", "a.png")
    unsafe = "../../evil.png"
    db = open_db(seeded_config.db_path)
    db.execute("UPDATE assets SET filename = ? WHERE sha256 = ?",
               (unsafe, a["sha256"]))
    db.commit()
    db.close()
    r = _export(client, [a["sha256"]])
    assert r.status_code == 200
    names = _names(r)
    expected = safe_filename(unsafe)
    assert expected == "-..-evil.png"
    assert names == [expected]
    # safe_filename replaces path separators but leaves other characters
    # (including dots) alone, so the sanitized name can still contain a
    # literal ".." substring -- that's harmless on its own. What actually
    # matters for zip-slip is that no arcname carries a path separator or
    # is absolute, since only those let an entry escape the target dir.
    assert all("/" not in n for n in names)
    assert all(not n.startswith("/") for n in names)


# --- pkm-13ty: count/byte limits ---

def test_export_refuses_over_count_limit_with_413(client, seeded_config):
    shas = _seed_assets(seeded_config, routes_assets.MAX_EXPORT_ASSET_COUNT + 1, 1)
    r = _export(client, shas)
    assert r.status_code == 413
    detail = r.json()["detail"]
    assert str(routes_assets.MAX_EXPORT_ASSET_COUNT + 1) in detail
    assert str(routes_assets.MAX_EXPORT_ASSET_COUNT) in detail


def test_export_at_count_limit_still_succeeds(client, seeded_config):
    shas = _seed_assets(seeded_config, routes_assets.MAX_EXPORT_ASSET_COUNT, 1)
    r = _export(client, shas)
    assert r.status_code == 200
    assert len(_names(r)) == routes_assets.MAX_EXPORT_ASSET_COUNT


def test_export_refuses_over_byte_limit_with_413(client, seeded_config):
    # One asset whose declared size alone exceeds the total-byte limit --
    # the on-disk file is one byte, proving the check reads the DB's
    # `size` column rather than statting the real file.
    over = routes_assets.MAX_EXPORT_TOTAL_BYTES + 1
    shas = _seed_assets(seeded_config, 1, over)
    r = _export(client, shas)
    assert r.status_code == 413
    detail = r.json()["detail"]
    assert str(over) in detail


def test_export_over_limit_never_returns_a_partial_zip(client, seeded_config):
    # No silent truncation: an over-limit request must refuse outright,
    # never respond 200 with only some of the selection zipped.
    shas = _seed_assets(seeded_config, routes_assets.MAX_EXPORT_ASSET_COUNT + 5, 1)
    r = _export(client, shas)
    assert r.status_code == 413
    assert r.headers["content-type"] != "application/zip"


# --- pkm-13ty: temp-file-backed archive + cleanup ---

def test_export_builds_zip_via_a_temp_dir_removed_after_response(
        client, monkeypatch):
    """The archive must not be built fully in an in-memory BytesIO --
    confirm a real temp directory backs it, and that it's gone once the
    response has been sent."""
    seen: list[Path] = []
    real_mkdtemp = routes_assets.tempfile.mkdtemp

    def spy_mkdtemp(*args, **kwargs):
        d = real_mkdtemp(*args, **kwargs)
        seen.append(Path(d))
        return d

    monkeypatch.setattr(routes_assets.tempfile, "mkdtemp", spy_mkdtemp)
    a = _upload(client, b"AAA", "a.png")
    r = _export(client, [a["sha256"]])
    assert r.status_code == 200
    assert _names(r) == ["a.png"]
    assert len(seen) == 1
    assert not seen[0].exists()


def test_export_cleans_up_temp_dir_on_build_error(client, monkeypatch):
    """A failure while assembling the archive (after the temp dir is
    created) must still remove it, not leak it, and the error must
    propagate rather than returning a partial zip."""
    seen: list[Path] = []
    real_mkdtemp = routes_assets.tempfile.mkdtemp

    def spy_mkdtemp(*args, **kwargs):
        d = real_mkdtemp(*args, **kwargs)
        seen.append(Path(d))
        return d

    def boom(*args, **kwargs):
        raise RuntimeError("simulated build failure")

    monkeypatch.setattr(routes_assets.tempfile, "mkdtemp", spy_mkdtemp)
    monkeypatch.setattr(routes_assets.zipfile, "ZipFile", boom)
    a = _upload(client, b"AAA", "a.png")
    with pytest.raises(RuntimeError, match="simulated build failure"):
        _export(client, [a["sha256"]])
    assert len(seen) == 1
    assert not seen[0].exists()
