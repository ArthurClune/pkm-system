"""POST /api/assets/export.zip: zip of selected assets (pkm-jdu3)."""
import io
import zipfile
from datetime import date


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
