import asyncio
import hashlib
from dataclasses import replace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from pkm.export.writer import export_graph
from pkm.server.app import create_app
from pkm.server.db import open_db
from pkm.server.routes_assets import _stream_to_temp

TEST_PASSWORD = "test-pw"  # must match conftest.py


def _upload(client, content=b"PNGDATA", name="pic.png", mime="image/png"):
    return client.post("/api/assets", files={"file": (name, content, mime)})


def test_upload_roundtrip(client, seeded_config):
    r = _upload(client)
    assert r.status_code == 200
    body = r.json()
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    assert body == {"sha256": sha, "filename": "pic.png",
                    "mime": "image/png", "size": 7,
                    "url": f"/assets/{sha}/pic.png"}
    assert (seeded_config.assets_dir / sha[:2] / sha).read_bytes() == b"PNGDATA"
    fetched = client.get(body["url"])
    assert fetched.status_code == 200
    assert fetched.content == b"PNGDATA"
    assert fetched.headers["content-type"] == "image/png"


def test_upload_requires_auth(anon_client):
    assert _upload(anon_client).status_code == 401


def test_upload_dedupes_by_content(client, seeded_config):
    first = _upload(client, name="a.png").json()
    second = _upload(client, name="b.png").json()
    assert second["sha256"] == first["sha256"]
    assert second["filename"] == "a.png"  # first row wins
    sha = first["sha256"]
    stored = list((seeded_config.assets_dir / sha[:2]).iterdir())
    assert [p.name for p in stored] == [sha]  # one file, no temp leftovers


def test_upload_empty_400(client):
    assert _upload(client, content=b"").status_code == 400


def _small_cap_client(seeded_config, cap=10):
    c = TestClient(create_app(replace(seeded_config, max_upload_bytes=cap)))
    assert c.post("/api/login", json={"password": TEST_PASSWORD}).status_code == 200
    return c


def test_upload_over_cap_413(seeded_config):
    c = _small_cap_client(seeded_config)
    assert _upload(c, content=b"x" * 11).status_code == 413


def test_upload_exactly_at_cap_ok(seeded_config):
    c = _small_cap_client(seeded_config)
    assert _upload(c, content=b"x" * 10).status_code == 200


def test_upload_disallowed_mime_415(client):
    r = _upload(client, name="evil.html", mime="text/html")
    assert r.status_code == 415


def test_upload_pdf_allowed(client):
    assert _upload(client, name="doc.pdf", mime="application/pdf").status_code == 200


def test_asset_serving_headers_inline_for_png(client):
    url = _upload(client).json()["url"]
    r = client.get(url)
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-disposition"].startswith("inline")


def test_asset_serving_svg_forced_to_attachment(client):
    url = _upload(client, content=b"<svg onload=alert(1)/>", name="a.svg",
                  mime="image/svg+xml").json()["url"]
    r = client.get(url)
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["x-content-type-options"] == "nosniff"


def test_upload_bounds_overlong_ascii_filename(client, seeded_config):
    # A direct tailnet API client (not a browser file picker) can send an
    # arbitrarily long filename; it must not disable later nightly exports.
    body = _upload(client, name="x" * 300 + ".png").json()
    assert body["filename"].endswith(".png")
    assert len(body["filename"].encode("utf-8")) <= 200


def test_upload_bounds_multibyte_filename_by_byte_length(client, seeded_config):
    # "é" is 2 UTF-8 bytes: under a naive char-count limit but over the
    # documented byte limit once repeated.
    body = _upload(client, name="é" * 120 + ".png").json()
    assert len(body["filename"].encode("utf-8")) <= 200
    body["filename"].encode("utf-8").decode("utf-8")  # no split code point


def test_upload_dot_filename_falls_back_to_default_stem(client, seeded_config):
    body = _upload(client, name="..").json()
    assert body["filename"] == "file"


def test_upload_spoofed_svg_content_forces_download_despite_png_declared_type(
        client, seeded_config):
    # Client claims this is a PNG (inline-eligible); the bytes are really
    # an SVG (script-capable, forced to download). The stored/served type
    # must follow the sniffed bytes, not the client's Content-Type.
    body = _upload(client, content=b"<svg onload=alert(1)/>", name="fake.png",
                   mime="image/png")
    assert body.status_code == 200
    result = body.json()
    assert result["mime"] == "image/svg+xml"
    fetched = client.get(result["url"])
    assert fetched.headers["content-disposition"].startswith("attachment")


def test_upload_spoofed_pdf_declared_but_real_png_bytes_stores_sniffed_mime(
        client, seeded_config):
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"restofdata"
    body = _upload(client, content=png_bytes, name="fake.pdf",
                   mime="application/pdf").json()
    assert body["mime"] == "image/png"


def test_upload_unsniffable_content_falls_back_to_declared_mime(client, seeded_config):
    body = _upload(client, content=b"hello world, just plain text",
                   name="notes.txt", mime="text/plain").json()
    assert body["mime"] == "text/plain"


def test_upload_over_cap_leaves_no_tmp_files(seeded_config):
    c = _small_cap_client(seeded_config)
    assert _upload(c, content=b"x" * 11).status_code == 413
    assert list(seeded_config.assets_dir.iterdir()) == []


class _FakeUploadFile:
    """Duck-types the subset of UploadFile._stream_to_temp relies on."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = list(chunks)
        self.read_calls = 0

    async def read(self, size: int) -> bytes:
        self.read_calls += 1
        if not self._chunks:
            return b""
        return self._chunks.pop(0)


def test_stream_to_temp_stops_reading_once_cap_exceeded(tmp_path):
    # 3 chunks of 7 bytes each; cap of 10 is exceeded by the 2nd chunk.
    # The loop must reject immediately rather than draining the 3rd chunk
    # into memory/disk first.
    fake = _FakeUploadFile([b"a" * 7, b"b" * 7, b"c" * 7])
    tmp_file = tmp_path / "upload.tmp"
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(_stream_to_temp(fake, tmp_file, max_bytes=10))
    assert exc_info.value.status_code == 413
    assert fake.read_calls == 2


def test_stream_to_temp_hashes_and_writes_incrementally(tmp_path):
    fake = _FakeUploadFile([b"hello ", b"world"])
    tmp_file = tmp_path / "upload.tmp"
    sha, size, first_chunk = asyncio.run(
        _stream_to_temp(fake, tmp_file, max_bytes=100))
    assert sha == hashlib.sha256(b"hello world").hexdigest()
    assert size == 11
    assert first_chunk == b"hello "
    assert tmp_file.read_bytes() == b"hello world"


def test_overlong_filename_upload_then_export_succeeds(client, seeded_config, tmp_path):
    # End-to-end regression for review finding 4: an asset row created via
    # the HTTP API with an overlong filename used to make export_graph()
    # raise OSError [Errno 63] File name too long on every nightly export.
    _upload(client, name="x" * 300 + ".png")
    db = open_db(seeded_config.db_path)
    try:
        counts = export_graph(db, seeded_config.assets_dir, tmp_path / "export")
    finally:
        db.close()
    assert counts["assets_copied"] == 1
    assert counts["assets_pruned"] == 0
