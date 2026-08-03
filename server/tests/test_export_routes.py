"""Markdown-export HTTP routes: one page as .md, the whole graph as a .zip.
Both are plain downloads (text/markdown or application/zip +
Content-Disposition: attachment), not JSON payloads.

The single-page route (pkm-kplp) is the end-user export: it resolves
((refs)) recursively to plain text and executes {{query: ...}} macros, per
pkm.export.resolve -- unlike the whole-db zip (pkm-uvqf), which reuses the
nightly backup's Core renderer unchanged (raw query command, one-level,
parens-wrapped ref resolution)."""
import sqlite3
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from pkm.server import routes_export
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db, open_db

# Kept as its own copy rather than importing conftest.py's constants: pytest
# resolves that import fine via rootdir insertion, but pyrefly's module
# resolution does not, and these two values are trivial to duplicate.
_TEST_PASSWORD = "test-pw"
_TEST_SALT = bytes.fromhex("00" * 16)


def _client(tmp_path, pages, blocks, refs=()):
    """A logged-in TestClient over a from-scratch seed, for scenarios
    (nested/cyclic refs, query blocks) that would otherwise bloat the
    shared conftest fixture other test files also rely on."""
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    con.executemany("INSERT INTO pages VALUES (?,?,?,?)", pages)
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", blocks)
    con.executemany("INSERT INTO refs VALUES (?,?,?)", refs)
    con.commit()
    con.close()
    (tmp_path / "assets").mkdir()
    config = Config(
        db_path=db_path,
        assets_dir=tmp_path / "assets",
        password_salt=_TEST_SALT.hex(),
        password_hash=hash_password(_TEST_PASSWORD, _TEST_SALT),
        session_secret="cd" * 32,
        cookie_secure=False,
    )
    tc = TestClient(create_app(config))
    r = tc.post("/api/login", json={"password": _TEST_PASSWORD})
    assert r.status_code == 200
    return tc


def test_export_page_markdown_returns_rendered_page(client):
    r = client.get("/api/export/page/Machine Learning")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.headers["content-disposition"] == \
        'attachment; filename="Machine Learning.md"'
    body = r.text
    assert body.startswith("# Machine Learning\n")
    assert "Tags:: #AI" in body
    assert "[[Attention Is All You Need]] is a [[Paper]]" in body


def test_export_page_markdown_resolves_block_refs(client):
    # uid_b5 on "July 7th, 2026" is "See ((uid_b3)) for details"; uid_b3's
    # text lives on "Machine Learning" and is inlined as plain text (no
    # wrapping parens) -- the end-user export's recursive resolution, not
    # the nightly export_graph()'s one-level, parens-wrapped substitution
    # (see test_export_writer.py for that path, unchanged).
    r = client.get("/api/export/page/July 7th, 2026")
    assert r.status_code == 200
    assert "See [[Attention Is All You Need]] is a [[Paper]] for details" in r.text
    assert "((" not in r.text


def test_export_page_markdown_404s_for_missing_page(client):
    assert client.get("/api/export/page/No Such Page").status_code == 404


def test_export_page_markdown_normalizes_routable_control_whitespace(
        client, seeded_config):
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (99, "Ctrl Title", 100, 100),
    )
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("uid_ctrl_export", 99, None, 0, "export body", None, 0, None, None),
    )
    con.commit()
    con.close()

    r = client.get(f"/api/export/page/{quote('Ctrl\tTitle', safe='/')}")

    assert r.status_code == 200
    assert r.text.startswith("# Ctrl Title\n")
    assert "export body" in r.text


def test_export_page_markdown_canonicalizes_padded_title_when_plain_space_migration_is_active(
        client, seeded_config):
    canonical = "Legacy Export"
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (99, canonical, 100, 100),
    )
    con.execute(
        "UPDATE sync_meta SET value = '1'"
        " WHERE key = 'plain_space_title_canonicalization'"
    )
    con.commit()
    con.close()

    r = client.get(f"/api/export/page/{quote(f' {canonical} ', safe='/')}")

    assert r.status_code == 200
    assert r.headers["content-disposition"] == (
        'attachment; filename="Legacy Export.md"'
    )
    assert r.text.startswith("# Legacy Export\n")


def test_export_page_markdown_preserves_inactive_padded_exact_reads(
        client, seeded_config):
    padded = " Legacy Export "
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (99, padded, 100, 100),
    )
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("uid_ctrl_export", 99, None, 0, "export body", None, 0, None, None),
    )
    con.commit()
    con.close()

    exact = client.get(f"/api/export/page/{quote(padded, safe='/')}")
    stripped = client.get(f"/api/export/page/{quote(padded.strip(), safe='/')}")

    assert exact.status_code == 200
    assert exact.text.splitlines()[0] == f"# {padded}"
    assert "export body" in exact.text
    assert stripped.status_code == 404


def test_export_page_markdown_requires_auth(anon_client):
    r = anon_client.get("/api/export/page/Machine Learning")
    assert r.status_code == 401


def test_export_page_markdown_resolves_refs_two_levels_deep(tmp_path):
    # P1 -uid_a1-> uid_b1 (on P2) -uid_c1-> uid_c1's text (also on P2): the
    # export of P1 must show uid_c1's actual text, not stop at uid_b1's raw
    # ((uid_c1)). (uids are >= 6 chars: server/src/pkm/refs.py's
    # _BLOCK_REF regex requires it, matching real Roam-style uids.)
    tc = _client(
        tmp_path,
        pages=[(1, "P1", None, None), (2, "P2", None, None)],
        blocks=[
            ("uid_a1", 1, None, 0, "root -> ((uid_b1))", None, 0, None, None),
            ("uid_b1", 2, None, 0, "mid -> ((uid_c1))", None, 0, None, None),
            ("uid_c1", 2, None, 1, "leaf text", None, 0, None, None),
        ])
    r = tc.get("/api/export/page/P1")
    assert r.status_code == 200
    assert "root -> mid -> leaf text" in r.text
    assert "((" not in r.text


def test_export_page_markdown_cyclic_refs_terminate(tmp_path):
    # uid_a1 <-> uid_b1 on P2, reached from P1's uid_root: must not hang,
    # and must fall back to a raw ((ref)) once the depth cap trips.
    tc = _client(
        tmp_path,
        pages=[(1, "P1", None, None), (2, "P2", None, None)],
        blocks=[
            ("uid_root", 1, None, 0, "start -> ((uid_a1))", None, 0, None, None),
            ("uid_a1", 2, None, 0, "A loops to ((uid_b1))", None, 0, None, None),
            ("uid_b1", 2, None, 1, "B loops to ((uid_a1))", None, 0, None, None),
        ])
    r = tc.get("/api/export/page/P1")
    assert r.status_code == 200
    assert "start -> A loops to B loops to A loops to ((uid_b1))" in r.text
    assert r.text.count("loops to") == 3


def test_export_page_markdown_resolves_query_block(tmp_path):
    tc = _client(
        tmp_path,
        pages=[(1, "Source", None, None), (2, "Tag", None, None),
              (3, "Matched Page", None, None)],
        blocks=[
            ("uid_q1", 1, None, 0, "notes {{query: {and: [[Tag]]}}}",
             None, 0, None, None),
            ("uid_m1", 3, None, 0, "the matched block text",
             None, 0, None, None),
        ],
        refs=[("uid_m1", 2, "tag")])
    r = tc.get("/api/export/page/Source")
    assert r.status_code == 200
    assert "{{query:" not in r.text  # the raw command is gone
    assert "1 result" in r.text
    assert "Matched Page" in r.text
    assert "the matched block text" in r.text


def test_export_page_markdown_query_with_no_results(tmp_path):
    tc = _client(
        tmp_path,
        pages=[(1, "Source", None, None)],
        blocks=[
            ("uid_q2", 1, None, 0, "nothing here: {{query: {and: [[Nowhere]]}}}",
             None, 0, None, None),
        ])
    r = tc.get("/api/export/page/Source")
    assert r.status_code == 200
    assert "{{query:" not in r.text
    assert "0 result" in r.text
    assert "no matching blocks" in r.text.lower()


def test_export_all_markdown_returns_a_zip(client):
    r = client.get("/api/export.zip")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"].startswith("attachment;")
    with zipfile.ZipFile(BytesIO(r.content)) as zf:
        names = zf.namelist()
        assert "pages/Machine Learning.md" in names
        assert "pages/AI.md" in names
        assert any(n.startswith("journal/") for n in names)
        assert ".gitignore" in names
        page = zf.read("pages/Machine Learning.md").decode("utf-8")
        assert page.startswith("# Machine Learning\n")


def test_export_all_markdown_requires_auth(anon_client):
    r = anon_client.get("/api/export.zip")
    assert r.status_code == 401


# --- pkm-13ty: temp-file-backed archive + cleanup ---

def test_export_all_markdown_builds_zip_via_a_temp_dir_removed_after_response(
        client, monkeypatch):
    """Same fix as the selected-asset export: the whole-graph zip must not
    be built fully in an in-memory BytesIO. Confirm a real temp
    directory backs it (the route's own, not export_graph's internal
    rendering-staging dir, which cleans itself up independently), and
    it's gone once the response has been sent."""
    seen: list[Path] = []
    real_mkdtemp = routes_export.tempfile.mkdtemp

    def spy_mkdtemp(*args, **kwargs):
        d = real_mkdtemp(*args, **kwargs)
        seen.append(Path(d))
        return d

    monkeypatch.setattr(routes_export.tempfile, "mkdtemp", spy_mkdtemp)
    r = client.get("/api/export.zip")
    assert r.status_code == 200
    with zipfile.ZipFile(BytesIO(r.content)) as zf:
        assert "pages/Machine Learning.md" in zf.namelist()
    route_dirs = [d for d in seen if d.name.startswith("pkm-export-")]
    assert len(route_dirs) == 1
    assert not route_dirs[0].exists()


def test_export_all_markdown_cleans_up_temp_dir_on_build_error(
        client, monkeypatch):
    """A failure while assembling the archive must still remove the temp
    directory rather than leaking it, and the error must propagate
    instead of returning a partial zip."""
    seen: list[Path] = []
    real_mkdtemp = routes_export.tempfile.mkdtemp

    def spy_mkdtemp(*args, **kwargs):
        d = real_mkdtemp(*args, **kwargs)
        seen.append(Path(d))
        return d

    def boom(*args, **kwargs):
        raise RuntimeError("simulated build failure")

    monkeypatch.setattr(routes_export.tempfile, "mkdtemp", spy_mkdtemp)
    monkeypatch.setattr(routes_export.zipfile, "ZipFile", boom)
    with pytest.raises(RuntimeError, match="simulated build failure"):
        client.get("/api/export.zip")
    route_dirs = [d for d in seen if d.name.startswith("pkm-export-")]
    assert len(route_dirs) == 1
    assert not route_dirs[0].exists()
