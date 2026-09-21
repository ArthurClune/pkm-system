import os
from dataclasses import replace

from fastapi.testclient import TestClient

from pkm.server import routes_local
from pkm.server.app import create_app


def test_serves_pdf_inline_with_headers(local_client):
    r = local_client.get("/api/local/Papers/ML/Title%20one.pdf")
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF")
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.headers["content-disposition"].startswith("inline")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "private, max-age=0, must-revalidate"


def test_serves_zip_as_attachment(local_client):
    r = local_client.get("/api/local/Papers/ML/bundle.zip")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("attachment")


def test_missing_file_is_404(local_client):
    assert local_client.get("/api/local/Papers/ML/nope.pdf").status_code == 404


def test_directory_is_404(local_client):
    assert local_client.get("/api/local/Papers/ML").status_code == 404
    assert local_client.get("/api/local/Papers/ML/").status_code == 404


def test_traversal_is_404_raw_and_encoded(local_client, local_root):
    outside = local_root.parent / "secret.txt"
    outside.write_text("no")
    assert local_client.get("/api/local/../secret.txt").status_code == 404
    assert local_client.get("/api/local/Papers/%2e%2e/%2e%2e/secret.txt").status_code == 404
    assert local_client.get("/api/local/Papers/..%2f..%2fsecret.txt").status_code == 404


def test_symlink_out_of_root_is_404(local_client, local_root):
    outside = local_root.parent / "secret.pdf"
    outside.write_bytes(b"%PDF")
    os.symlink(outside, local_root / "Papers" / "link.pdf")
    assert local_client.get("/api/local/Papers/link.pdf").status_code == 404


def test_evicted_file_is_503_and_requests_download(local_client, local_root, monkeypatch):
    asked = []
    monkeypatch.setattr(routes_local, "_request_download", lambda p: asked.append(p))
    r = local_client.get("/api/local/Papers/Gone.pdf")
    assert r.status_code == 503
    assert r.headers["retry-after"] == "5"
    assert r.json() == {"detail": "not downloaded on the host", "path": "Papers/Gone.pdf"}
    assert asked == [local_root / "Papers" / "Gone.pdf"]


def test_request_download_swallows_missing_brctl(monkeypatch, tmp_path):
    monkeypatch.setattr(routes_local.subprocess, "run",
                        lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()))
    routes_local._request_download(tmp_path / "x.pdf")  # must not raise


def test_disabled_when_root_unset(client):
    assert client.get("/api/local/Papers/ML/Title%20one.pdf").status_code == 404


def test_requires_auth(seeded_config, local_root):
    anon = TestClient(create_app(replace(seeded_config, local_docs_root=local_root)))
    assert anon.get("/api/local/Papers/ML/Title%20one.pdf").status_code == 401
