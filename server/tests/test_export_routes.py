"""Markdown-export HTTP routes: one page as .md, the whole graph as a .zip.
Both are plain downloads (text/markdown or application/zip +
Content-Disposition: attachment), not JSON payloads.

The single-page route is the end-user export: it resolves ((refs))
recursively to plain text and executes {{query: ...}} macros, per
pkm.export.resolve -- unlike the whole-db zip, which reuses the nightly
backup's Core renderer unchanged (raw query command, one-level,
parens-wrapped ref resolution)."""
import asyncio
import tempfile
import time
import unicodedata
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import pytest
from app_seed import seeded_client
from conftest import TEST_PASSWORD
from export_hostile import (
    ASSET_NAMES, add_asset_rows, add_pages, unsafe_arcname_flags,
)
from fastapi.testclient import TestClient

from pkm.database import connect
from pkm.export.markdown import page_filename
from pkm.filenames import attachment_disposition
from pkm.server.app import create_app
from pkm.server import routes_export
from pkm.server.sync_meta import set_plain_space_title_canonicalization
from pkm.test_data.ids import canonical_title_of


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
    con = connect(seeded_config.db_path)
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
    con = connect(seeded_config.db_path)
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
    con = connect(seeded_config.db_path)
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
    tc = seeded_client(
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
    tc = seeded_client(
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
    tc = seeded_client(
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


def test_export_page_markdown_query_operand_is_canonicalised(tmp_path):
    """[[ Tag ]] in an exported {{query}} macro resolves against the
    canonical "Tag" once the plain-space flag is on, the same as the live
    /api/query endpoint and as the [[ Tag ]] link itself."""
    tc = seeded_client(
        tmp_path,
        pages=[(1, "Source", None, None), (2, "Tag", None, None),
              (3, "Matched Page", None, None)],
        blocks=[
            ("uid_q1", 1, None, 0, "notes {{query: {and: [[ Tag ]]}}}",
             None, 0, None, None),
            ("uid_m1", 3, None, 0, "the matched block text",
             None, 0, None, None),
        ],
        refs=[("uid_m1", 2, "tag")])
    con = connect(tmp_path / "pkm.sqlite3")
    set_plain_space_title_canonicalization(con, True)
    con.commit()
    con.close()
    r = tc.get("/api/export/page/Source")
    assert r.status_code == 200
    assert "1 result" in r.text
    assert "the matched block text" in r.text


def test_export_page_markdown_query_with_no_results(tmp_path):
    tc = seeded_client(
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


# --- temp-file-backed archive + cleanup ---

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


@pytest.mark.parametrize("name", ["日本語 notes", "Emoji \U0001f389",
                                  "Café\u00a0menu", 'Say "hi"'])
def test_export_page_names_any_title_in_its_header(client, name):
    """A header is latin-1 on the wire: a title outside printable ASCII
    goes in RFC 6266's UTF-8 `filename*`, with an ASCII `filename` beside
    it for clients that read only that."""
    assert client.post("/api/pages", json={"title": name}).status_code == 200
    r = client.get(f"/api/export/page/{quote(name, safe='')}")
    assert r.status_code == 200
    disposition = r.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="')
    assert f"filename*=UTF-8''{quote(name + '.md', safe='')}" in disposition
    fallback = disposition.split('filename="', 1)[1].split('"', 1)[0]
    assert fallback.isascii() and '"' not in fallback


# --- hostile names: headers, archive entry names, odd paths ---

HEADER_TITLES = [
    'a"b', "a\\b", "x\r\nSet-Cookie: evil=1", "x\nX-Injected: 1",
    'semi; filename="evil.exe"', "evil\u202egpj.md", "café ünïcode 日本",
    "..", "../../etc/passwd", "/abs", "C:\\win", "a\x00b", "a\x7fb",
    "\u2028line", "%0d%0a", "x" * 400, "日" * 200, "CON", "nul.txt",
    'a<b>c|d?e*f"g', "  .  ", "\ufeffbom", "\U0010ffff",
]

ROUTE_TITLES = ['semi; filename="evil.exe"', 'quote"back\\slash',
                "evil\u202egpj", "x\r\nSet-Cookie: e=1"]

ZIP_TITLES = [
    "..", "../../evil", "/abs/path", "C:\\drive", "\\\\server\\share",
    "a\x00b", "CON", "x" * 600, "café", unicodedata.normalize("NFD", "café"),
    "Σίσυφος", "σίσυφος", "ς", "σ", "Straße", "STRASSE", "ǅ", "ǆ", "ﬀ", "ff",
    "K", "\u212a", ".hidden", "...", "a\U000e0001",
]

def _printable_ascii(header: str) -> bool:
    return all(32 <= ord(ch) < 127 for ch in header)


@pytest.mark.parametrize("text", HEADER_TITLES)
def test_attachment_header_is_printable_ascii_for_any_title(text):
    """A title is user text that ends up in a response header: whatever it
    holds, the header stays printable ASCII with no CR or LF, so it cannot
    split the response or smuggle a header."""
    header = attachment_disposition(
        page_filename(canonical_title_of(text), set()))
    assert _printable_ascii(header), header


def test_export_page_route_headers_survive_hostile_titles(seeded_config,
                                                          client):
    add_pages(seeded_config.db_path, ROUTE_TITLES)
    for title in ROUTE_TITLES:
        r = client.get("/api/export/page/" + quote(title, safe=""))
        # A title holding CR/LF is canonicalised to a name no page has, so
        # it answers 404 today: it must add no header either way.
        assert r.status_code in ((200, 404) if "\n" in title else (200,)), title
        assert "set-cookie" not in r.headers, title
        if r.status_code == 200:
            assert _printable_ascii(r.headers["content-disposition"]), title


def test_export_zip_arcnames_never_escape_the_extraction_directory(
        seeded_config, client):
    """Page titles and asset filenames are user text: no entry name in the
    whole-graph zip may carry a parent component, a root, a backslash, a
    drive prefix or a control character, whatever the source holds. The
    page count is deliberately not asserted here."""
    add_pages(seeded_config.db_path, ZIP_TITLES)
    add_asset_rows(seeded_config.db_path, seeded_config.assets_dir,
                   ASSET_NAMES)
    r = client.get("/api/export.zip")
    assert r.status_code == 200
    names = zipfile.ZipFile(BytesIO(r.content)).namelist()
    assert any(n.startswith("assets/") for n in names)
    bad = {n: unsafe_arcname_flags(n) for n in names if unsafe_arcname_flags(n)}
    assert not bad


ODD_PAGE_PATHS = ["", "%00", "AI%00", "..%2F..%2Fx", "AI%0A", "%20AI%20",
                  "a" * 60000, "%ff", "AI/../AI"]


@pytest.mark.parametrize("path", ODD_PAGE_PATHS)
def test_export_page_odd_paths_are_401_anonymously_and_never_500(
        seeded_config, path):
    anon = TestClient(create_app(seeded_config),
                      raise_server_exceptions=False)
    assert anon.get("/api/export/page/" + path).status_code == 401
    authed = TestClient(create_app(seeded_config),
                        raise_server_exceptions=False)
    r = authed.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    assert authed.get("/api/export/page/" + path).status_code < 500


def test_export_page_with_a_ref_cycle_through_query_macros_terminates(
        tmp_path):
    """Two blocks that ((ref)) each other and each hold a query matching
    the page they sit on: the resolver's visited sets and depth caps must
    end the recursion, in time and with a 200."""
    tc = seeded_client(
        tmp_path,
        pages=[(1, "Cyc", None, None)],
        blocks=[
            ("cyc_aaaaaa", 1, None, 0, "A ((cyc_bbbbbb)) {{query: [[Cyc]]}}",
             None, 0, None, None),
            ("cyc_bbbbbb", 1, None, 1, "B ((cyc_aaaaaa)) {{query: [[Cyc]]}}",
             None, 0, None, None),
        ])
    started = time.monotonic()
    r = tc.get("/api/export/page/Cyc")
    assert r.status_code == 200
    assert time.monotonic() - started < 10


# --- temp dirs are removed however the send ends ---

async def _call_asgi(app, cookie, method, path, body, mode):
    """One request straight to the app. In mode `raise` the server's send
    fails on the first body message; in `disconnect` the client is gone
    once the request body has been read. Only `raise` tells the cleanup's
    `finally` from a cleanup that runs after a completed send."""
    reads = []

    async def receive():
        # The request body arrives first; the client leaves after that.
        reads.append(1)
        if mode == "disconnect" and len(reads) > 1:
            return {"type": "http.disconnect"}
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        if mode == "raise" and message["type"] == "http.response.body":
            raise OSError("peer reset")

    headers = [(b"cookie", f"pkm_session={cookie}".encode()),
               (b"host", b"testserver")]
    if body:
        headers.append(
            (b"content-type", b"application/x-www-form-urlencoded"))
    scope = {"type": "http", "asgi": {"version": "3.0"},
             "http_version": "1.1", "method": method, "scheme": "http",
             "path": path, "raw_path": path.encode(), "query_string": b"",
             "root_path": "", "headers": headers,
             "client": ("127.0.0.1", 1), "server": ("testserver", 80)}
    try:
        await app(scope, receive, send)
    except OSError:
        pass


@pytest.mark.parametrize("mode", ["raise", "disconnect"])
@pytest.mark.parametrize("method, path", [
    ("GET", "/api/export.zip"), ("POST", "/api/assets/export.zip")])
def test_export_temp_dirs_are_removed_when_the_send_fails_or_the_client_leaves(
        client, seeded_config, tmp_path, monkeypatch, method, path, mode):
    """A download that never completes must not leave its staged copy of
    the graph or the assets in the temp directory."""
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))
    shas = add_asset_rows(seeded_config.db_path, seeded_config.assets_dir,
                          ["big.bin"])
    body = f"sha256s={shas[0]}".encode() if method == "POST" else b""
    made: list[str] = []
    real_mkdtemp = tempfile.mkdtemp

    def spy_mkdtemp(*args, **kwargs):
        made.append(real_mkdtemp(*args, **kwargs))
        return made[-1]

    monkeypatch.setattr(tempfile, "mkdtemp", spy_mkdtemp)

    asyncio.run(_call_asgi(client.app, client.cookies["pkm_session"],
                           method, path, body, mode))

    assert any(Path(d).name.startswith("pkm-") for d in made)
    assert list(scratch.glob("pkm-*")) == []
