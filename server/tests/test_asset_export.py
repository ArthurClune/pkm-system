"""POST /api/assets/export.zip: zip of selected assets (pkm-jdu3)."""
import io
import zipfile
from datetime import date

from pkm.filenames import safe_filename
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
