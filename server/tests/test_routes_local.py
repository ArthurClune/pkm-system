import os
import shutil
import threading
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from pkm.local_docs import local_href
from pkm.server import routes_local
from pkm.server.app import create_app
from pkm.server.local_index import TreeScanner
from pkm.server.local_open import OpenProber
from pkm.database import connect


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
    # httpx normalises this before it leaves the client, so the request
    # never reaches the route with a genuine ".." segment; it proves
    # nothing about containment. The two encoded cases below are the
    # real assertions: both arrive at resolve_relative with literal
    # ".." segments and are rejected there.
    assert local_client.get("/api/local/../secret.txt").status_code == 404
    assert local_client.get("/api/local/Papers/%2e%2e/%2e%2e/secret.txt").status_code == 404
    assert local_client.get("/api/local/Papers/..%2f..%2fsecret.txt").status_code == 404


def test_symlink_out_of_root_is_404(local_client, local_root):
    outside = local_root.parent / "secret.pdf"
    outside.write_bytes(b"%PDF")
    os.symlink(outside, local_root / "Papers" / "link.pdf")
    assert local_client.get("/api/local/Papers/link.pdf").status_code == 404


def test_symlink_loop_is_404_not_500(local_client, local_root):
    # a mutual loop (a -> b -> a): resolving a path through it raises
    # RuntimeError("Symlink loop from ...") rather than OSError.
    os.symlink("b", local_root / "a")
    os.symlink("a", local_root / "b")
    assert local_client.get("/api/local/a/x.pdf").status_code == 404


def test_percent_in_filename_is_served(local_client):
    r = local_client.get("/api/local/Papers/ML/50%25%20draft.pdf")
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF")


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
    con = connect(db_path)
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
    con = connect(seeded_config.db_path)
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


def test_check_survives_a_symlink_loop_href(local_client, seeded_config, local_root):
    """One pathological href (a symlink loop) must not abort the whole
    audit with a 500; it is reported as one problem among the rest."""
    os.symlink("b", local_root / "a")
    os.symlink("a", local_root / "b")
    con = connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,NULL,0,NULL,NULL)",
        ("uid_loop", 1, None, 13, "[loop](/api/local/a/x.pdf)"))
    con.commit()
    con.close()

    r = local_client.get("/api/local/check")
    assert r.status_code == 200
    by_uid = {p["uid"]: p for p in r.json()["problems"]}
    assert by_uid["uid_loop"]["status"] == "missing"


def test_overlong_path_is_404_not_500(local_client):
    """An OSError from a stat call (e.g. ENAMETOOLONG), not a symlink
    loop, must also be treated as "not found" rather than a 500."""
    segment = "x" * 300
    assert local_client.get(f"/api/local/{segment}/x.pdf").status_code == 404


def test_check_agrees_with_file_route_on_percent_in_filename(
        local_client, seeded_config, local_root):
    """The href `check` sees is percent-encoded once, the same as a real
    `Local copy::` link built by `local_href`; it must resolve to the
    same file the file route serves, including a literal `%` in the
    real filename."""
    href = local_href("Papers/ML/50% draft.pdf")
    con = connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,NULL,0,NULL,NULL)",
        ("uid_pct", 1, None, 14, f"[pct]({href})"))
    con.commit()
    con.close()

    assert local_client.get(href).status_code == 200

    body = local_client.get("/api/local/check").json()
    by_uid = {p["uid"]: p for p in body["problems"]}
    assert "uid_pct" not in by_uid


# --- open probe and dataless handling -------------------------------------

@pytest.fixture
def blocking_prober(monkeypatch):
    """A prober whose opener blocks until released; swapped in for the
    module default so no state leaks between tests."""
    gate = threading.Event()
    calls = []

    def opener(path):
        calls.append(path)
        gate.wait(10)

    prober = OpenProber(opener=opener, timeout=0.2, cap=4)
    monkeypatch.setattr(routes_local, "default_prober", prober)
    yield prober, calls
    gate.set()


def test_unreadable_file_is_503(local_client, blocking_prober):
    r = local_client.get("/api/local/Papers/ML/Title%20one.pdf")
    assert r.status_code == 503
    assert r.headers["retry-after"] == "5"
    assert r.json() == {"detail": "the host can't open this file",
                        "path": "Papers/ML/Title one.pdf"}


def test_busy_prober_is_503(local_client, monkeypatch):
    monkeypatch.setattr(routes_local, "default_prober",
                        OpenProber(opener=lambda p: None, timeout=0.2, cap=0))
    r = local_client.get("/api/local/Papers/ML/Title%20one.pdf")
    assert r.status_code == 503
    assert r.headers["retry-after"] == "5"
    assert r.json() == {
        "detail": "too many file opens are in flight on the host; see the server log",
        "path": "Papers/ML/Title one.pdf"}


def test_check_reports_busy_as_unchecked(local_client, seeded_config, monkeypatch):
    monkeypatch.setattr(routes_local, "default_prober",
                        OpenProber(opener=lambda p: None, timeout=0.2, cap=0))
    _seed_local_links(seeded_config.db_path)
    body = local_client.get("/api/local/check").json()
    assert ("uid_l1", "unchecked") in {(p["uid"], p["status"]) for p in body["problems"]}


def test_permission_error_is_503(local_client, monkeypatch):
    def deny(path):
        raise PermissionError(1, "denied")
    monkeypatch.setattr(routes_local, "default_prober",
                        OpenProber(opener=deny, timeout=1, cap=2))
    assert local_client.get("/api/local/Papers/ML/Title%20one.pdf").status_code == 503


def test_dataless_file_is_evicted_and_never_opened(local_client, local_root, monkeypatch):
    calls = []
    monkeypatch.setattr(routes_local, "default_prober",
                        OpenProber(opener=calls.append, timeout=1, cap=2))
    monkeypatch.setattr(routes_local, "_is_dataless", lambda p: True)
    asked = []
    monkeypatch.setattr(routes_local, "_request_download", lambda p: asked.append(p))
    r = local_client.get("/api/local/Papers/ML/Title%20one.pdf")
    assert r.status_code == 503
    assert r.json()["detail"] == "not downloaded on the host"
    assert calls == []
    assert asked == [local_root / "Papers" / "ML" / "Title one.pdf"]


def test_check_reports_unreadable_file(local_client, seeded_config, blocking_prober):
    _seed_local_links(seeded_config.db_path)
    body = local_client.get("/api/local/check").json()
    statuses = {(p["uid"], p["status"]) for p in body["problems"]}
    assert ("uid_l1", "unreadable") in statuses
    assert body["ok"] == 0


def test_check_reports_dataless_as_evicted_without_opening(
        local_client, seeded_config, monkeypatch):
    calls = []
    monkeypatch.setattr(routes_local, "default_prober",
                        OpenProber(opener=calls.append, timeout=1, cap=2))
    monkeypatch.setattr(routes_local, "_is_dataless", lambda p: True)
    _seed_local_links(seeded_config.db_path)
    body = local_client.get("/api/local/check").json()
    assert ("uid_l1", "evicted") in {(p["uid"], p["status"]) for p in body["problems"]}
    assert calls == []


def test_is_dataless_reads_the_stat_flag(tmp_path, monkeypatch):
    f = tmp_path / "x"
    f.write_text("x")
    assert routes_local._is_dataless(f) is False
    with monkeypatch.context() as m:
        m.setattr(routes_local, "_st_flags", lambda p: 0x40000000)
        assert routes_local._is_dataless(f) is True
    assert routes_local._is_dataless(tmp_path / "missing") is False


NAV = {"Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
       "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}


def _assert_html_error(r, status):
    assert r.status_code == status
    assert r.headers["content-type"] == "text/html; charset=utf-8"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "no-store"


def test_navigation_to_missing_file_gets_html_404(local_client):
    r = local_client.get("/api/local/Papers/ML/nope.pdf", headers=NAV)
    _assert_html_error(r, 404)
    assert "Papers/ML/nope.pdf" in r.text


def test_navigation_404_escapes_the_path(local_client):
    r = local_client.get("/api/local/Papers/%3Cscript%3Ex%3C/script%3E.pdf", headers=NAV)
    _assert_html_error(r, 404)
    assert "<script>" not in r.text
    assert "&lt;script&gt;" in r.text


def test_navigation_404_for_rejected_path_is_html(local_client):
    r = local_client.get("/api/local/Papers/..%2f..%2fsecret.txt", headers=NAV)
    _assert_html_error(r, 404)
    # same shape as a missing file: it only echoes what the client sent
    assert "Papers/../../secret.txt" in r.text or "secret.txt" in r.text
    assert "icloud" not in r.text.lower()


def test_navigation_404_when_root_unset_is_html(client):
    r = client.get("/api/local/Papers/x.pdf", headers=NAV)
    _assert_html_error(r, 404)


def test_navigation_to_evicted_file_gets_html_503(local_client, monkeypatch):
    monkeypatch.setattr(routes_local, "_request_download", lambda p: None)
    r = local_client.get("/api/local/Papers/Gone.pdf", headers=NAV)
    _assert_html_error(r, 503)
    assert r.headers["retry-after"] == "5"
    assert "Papers/Gone.pdf" in r.text


def test_navigation_to_dataless_file_gets_html_503(local_client, monkeypatch):
    monkeypatch.setattr(routes_local, "_request_download", lambda p: None)
    monkeypatch.setattr(routes_local, "_is_dataless", lambda p: True)
    r = local_client.get("/api/local/Papers/ML/Title%20one.pdf", headers=NAV)
    _assert_html_error(r, 503)
    assert r.headers["retry-after"] == "5"


def test_navigation_to_busy_prober_gets_html_503(local_client, monkeypatch):
    monkeypatch.setattr(routes_local, "default_prober",
                        OpenProber(opener=lambda p: None, timeout=0.2, cap=0))
    r = local_client.get("/api/local/Papers/ML/Title%20one.pdf", headers=NAV)
    _assert_html_error(r, 503)
    assert r.headers["retry-after"] == "5"
    assert "in flight" in r.text


def test_navigation_to_unreadable_file_gets_html_503(local_client, blocking_prober):
    r = local_client.get("/api/local/Papers/ML/Title%20one.pdf", headers=NAV)
    _assert_html_error(r, 503)
    assert "open this file" in r.text


def test_accept_html_without_sec_fetch_gets_html(local_client):
    r = local_client.get("/api/local/Papers/ML/nope.pdf",
                         headers={"Accept": "text/html,*/*;q=0.8"})
    _assert_html_error(r, 404)


@pytest.mark.parametrize("headers", [
    {}, {"Accept": "*/*"}, {"Accept": "application/json"},
    {"Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "Accept": "*/*"},
])
def test_fetch_style_requests_keep_json_errors(local_client, headers):
    r = local_client.get("/api/local/Papers/ML/nope.pdf", headers=headers)
    assert r.status_code == 404
    assert r.json() == {"detail": "not found"}
    r = local_client.get("/api/local/Papers/Gone.pdf", headers=headers)
    assert r.status_code == 503
    assert r.json() == {"detail": "not downloaded on the host", "path": "Papers/Gone.pdf"}


def test_navigation_to_existing_file_is_served_unchanged(local_client):
    r = local_client.get("/api/local/Papers/ML/Title%20one.pdf", headers=NAV)
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF")


# --- GET /api/local-index --------------------------------------------------

def test_local_index_lists_files_with_hrefs(local_client):
    r = local_client.get("/api/local-index")
    assert r.status_code == 200
    paths = [f["path"] for f in r.json()["files"]]
    assert paths == ["Papers/Gone.pdf", "Papers/ML/50% draft.pdf",
                     "Papers/ML/bundle.zip", "Papers/ML/Title one.pdf"]
    by_path = {f["path"]: f["href"] for f in r.json()["files"]}
    assert by_path["Papers/ML/Title one.pdf"] == local_href("Papers/ML/Title one.pdf")


def test_every_index_href_is_served(local_client, local_root):
    for name in ["a#b.pdf", "q?.pdf", "Programme (Public).pdf",
                 "br[ack]et.pdf", "Caf\u00e9.pdf", "Cafe\u0301 nfd.pdf"]:
        (local_root / "Papers" / name).write_bytes(b"%PDF-1.4\n")
    names = ["a#b.pdf", "q?.pdf", "Programme (Public).pdf",
             "br[ack]et.pdf", "Caf\u00e9.pdf", "Cafe\u0301 nfd.pdf"]
    files = local_client.get("/api/local-index").json()["files"]
    assert {f"Papers/{n}" for n in names} <= {f["path"] for f in files}
    for f in files:
        if f["path"] == "Papers/Gone.pdf":
            continue  # evicted stub: the file route answers 503 by design
        assert local_client.get(f["href"]).status_code == 200, f["path"]


def test_local_index_skips_symlinks_out_and_hidden(local_client, local_root):
    outside = local_root.parent / "outside"
    outside.mkdir()
    (outside / "secret.pdf").write_bytes(b"%PDF")
    os.symlink(outside, local_root / "Papers" / "out")
    os.symlink(outside / "secret.pdf", local_root / "Papers" / "s.pdf")
    os.symlink(local_root / "Papers", local_root / "Papers" / "loop")
    (local_root / ".Trash").mkdir()
    (local_root / ".Trash" / "old.pdf").write_bytes(b"%PDF")
    (local_root / "Papers" / ".DS_Store").write_bytes(b"x")
    paths = [f["path"] for f in local_client.get("/api/local-index").json()["files"]]
    assert paths == ["Papers/Gone.pdf", "Papers/ML/50% draft.pdf",
                     "Papers/ML/bundle.zip", "Papers/ML/Title one.pdf"]


def test_local_index_stub_and_real_file_list_once(local_client, local_root):
    (local_root / "Papers" / "Gone.pdf").write_bytes(b"%PDF")
    paths = [f["path"] for f in local_client.get("/api/local-index").json()["files"]]
    assert paths.count("Papers/Gone.pdf") == 1


def test_local_index_404_when_root_unset(client):
    assert client.get("/api/local-index").status_code == 404


def test_local_index_requires_auth(seeded_config, local_root):
    anon = TestClient(create_app(replace(seeded_config, local_docs_root=local_root)))
    assert anon.get("/api/local-index").status_code == 401


@pytest.mark.parametrize("make_root", ["missing", "blocking", "denied"])
def test_local_index_unreadable_is_503(local_client, local_root, monkeypatch, make_root):
    gate = threading.Event()
    try:
        if make_root == "missing":
            shutil.rmtree(local_root)
        elif make_root == "blocking":
            def blocked(root):
                gate.wait(10)
                return []
            monkeypatch.setattr(routes_local, "default_scanner",
                                TreeScanner(walker=blocked, timeout=0.1))
        else:
            def denied(root):
                raise PermissionError("no")
            monkeypatch.setattr(routes_local, "default_scanner",
                                TreeScanner(walker=denied, timeout=0.1))
        r = local_client.get("/api/local-index")
    finally:
        gate.set()
    assert r.status_code == 503
    assert r.headers["retry-after"] == "5"
    assert r.json() == {"detail": "the host can't read the local documents folder"}


def test_local_index_unreadable_subdirectory_is_503(local_client, local_root):
    locked = local_root / "Papers" / "locked"
    locked.mkdir()
    locked.chmod(0)
    try:
        r = local_client.get("/api/local-index")
    finally:
        locked.chmod(0o755)
    assert r.status_code == 503
    assert r.json() == {"detail": "the host can't read the local documents folder"}


def test_local_index_skips_a_dangling_symlink(local_client, local_root):
    os.symlink(local_root / "nowhere.pdf", local_root / "Papers" / "dangling.pdf")
    paths = [f["path"] for f in local_client.get("/api/local-index").json()["files"]]
    assert paths == ["Papers/Gone.pdf", "Papers/ML/50% draft.pdf",
                     "Papers/ML/bundle.zip", "Papers/ML/Title one.pdf"]
