import os
import sqlite3
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


def _seed_local_links(db_path):
    con = sqlite3.connect(db_path)
    rows = [
        ("uid_l1", 1, None, 10, "Local copy:: [Title one.pdf](/api/local/Papers/ML/Title%20one.pdf)"),
        ("uid_l2", 1, None, 11, "Local copy:: [x.pdf](/api/local/Papers/ML/nope.pdf)"),
        ("uid_l3", 2, None, 10, "see /api/local/Papers/Gone.pdf and [bad](/api/local/../etc)"),
        ("uid_l4", 2, None, 11, "no local links here"),
    ]
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,NULL,0,NULL,NULL)", rows)
    con.commit()
    con.close()


def test_check_classifies_every_href(local_client, seeded_config, local_root):
    _seed_local_links(seeded_config.db_path)
    r = local_client.get("/api/local/check")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert body["total"] == 4          # four distinct hrefs across blocks
    assert body["ok"] == 1
    assert sorted((p["uid"], p["status"]) for p in body["problems"]) == [
        ("uid_l2", "missing"), ("uid_l3", "evicted"), ("uid_l3", "invalid")]
    by_uid = {(p["uid"], p["status"]): p for p in body["problems"]}
    assert by_uid[("uid_l2", "missing")]["page"] == "Machine Learning"
    assert by_uid[("uid_l3", "evicted")]["href"] == "/api/local/Papers/Gone.pdf"


def test_check_disabled_when_root_unset(client):
    r = client.get("/api/local/check")
    assert r.status_code == 200
    assert r.json() == {"enabled": False, "total": 0, "ok": 0, "problems": []}


def test_check_wins_over_a_file_named_check(local_client, local_root):
    (local_root / "check").write_bytes(b"x")
    assert local_client.get("/api/local/check").json()["enabled"] is True


def test_check_agrees_with_file_route_on_symlinked_evicted_stub(
        local_client, seeded_config, local_root):
    """A stub reachable only by following a symlinked directory out of
    root is not "evicted": the file route 404s it (is_within rejects the
    resolved stub), so /api/local/check must call it "missing", not
    "evicted", or the two would disagree about the same href."""
    outside = local_root.parent / "outside"
    outside.mkdir()
    (outside / ".X.pdf.icloud").write_bytes(b"stub")
    os.symlink(outside, local_root / "link")
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,NULL,0,NULL,NULL)",
        ("uid_l5", 1, None, 12, "[link](/api/local/link/X.pdf)"))
    con.commit()
    con.close()

    assert local_client.get("/api/local/link/X.pdf").status_code == 404

    body = local_client.get("/api/local/check").json()
    by_uid = {p["uid"]: p for p in body["problems"]}
    assert by_uid["uid_l5"]["status"] == "missing"
