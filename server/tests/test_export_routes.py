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

from pkm.database import Db, connect
from pkm.export.resolve import CHARS_PER_CALL
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
    it for clients that read only that. The header names the stored title,
    whose whitespace runs (the NBSP here) are folded."""
    created = client.post("/api/pages", json={"title": name})
    assert created.status_code == 200
    stored = created.json()["title"]
    r = client.get(f"/api/export/page/{quote(name, safe='')}")
    assert r.status_code == 200
    disposition = r.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="')
    assert f"filename*=UTF-8''{quote(stored + '.md', safe='')}" in disposition
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


@pytest.mark.parametrize("depth", [40, 2000])
def test_export_page_markdown_leaves_a_refused_query_macro_in_place(
        tmp_path, depth):
    """An over-deep {{query}} degrades like any other parse error: the raw
    macro stays in the text and the export still answers 200."""
    macro = "{{query: " + "{and: " * depth + "[[Tag]]" + "}" * depth + "}}"
    tc = seeded_client(
        tmp_path,
        pages=[(1, "Source", None, None), (2, "Tag", None, None)],
        blocks=[("uid_q1", 1, None, 0, f"notes {macro}", None, 0, None, None)],
        refs=[])
    r = tc.get("/api/export/page/Source")
    assert r.status_code == 200
    assert macro in r.text


def _amp_client(tmp_path, k: int, leaf: str, sep: str) -> TestClient:
    # The probe's page: three levels of K refs each over one leaf.
    return seeded_client(
        tmp_path,
        pages=[(1, "Amp", None, None)],
        blocks=[
            ("amp_top0", 1, None, 0, sep.join(["((amp_lvl1))"] * k),
             None, 0, None, None),
            ("amp_lvl1", 1, None, 1, sep.join(["((amp_lvl2))"] * k),
             None, 0, None, None),
            ("amp_lvl2", 1, None, 2, sep.join(["((amp_lvl3))"] * k),
             None, 0, None, None),
            ("amp_lvl3", 1, None, 3, leaf, None, 0, None, None),
        ])


def test_export_page_markdown_refuses_a_fan_out_past_the_bound(tmp_path):
    # K=60 refs a level over a 100-character leaf is 60**3 * 100 = 21.6M
    # characters uncharged, past the real bound.
    tc = _amp_client(tmp_path, 60, "Z" * 100, " ")
    r = tc.get("/api/export/page/Amp")
    assert r.status_code == 422
    assert r.json() == {"detail": "page too large to export: over 10 million"
                        " characters once block refs and queries are expanded"}
    assert "content-disposition" not in r.headers


def test_export_page_markdown_refuses_a_fan_out_that_produces_nothing(
        tmp_path):
    # Adjacent refs over an empty leaf: a few characters of output, but
    # past a million resolve_text calls at K=100.
    tc = _amp_client(tmp_path, 100, "", "")
    r = tc.get("/api/export/page/Amp")
    assert r.status_code == 422
    assert r.json() == {"detail": "page too large to export: its block refs"
                        " and queries expand too many times"}
    assert "content-disposition" not in r.headers


_REFUSED = "page too large to export: "


def _plan_rows_counter(monkeypatch) -> list[int]:
    # Counts query-result rows the database hands back, materialised in one
    # list (select) or streamed one at a time (select_iter).
    seen = [0]
    select, select_iter = Db.select, Db.select_iter

    def counted_select(self, sql, params=()):
        rows = select(self, sql, params)
        if "page_title" in sql:
            seen[0] += len(rows)
        return rows

    def counted_select_iter(self, sql, params=()):
        for row in select_iter(self, sql, params):
            if "page_title" in sql:
                seen[0] += 1
            yield row

    monkeypatch.setattr(Db, "select", counted_select)
    monkeypatch.setattr(Db, "select_iter", counted_select_iter)
    return seen


def _query_graph_client(tmp_path, exprs: list[str], matches: int):
    blocks = [(f"src_{i:05d}", 1, None, i, f"{{{{query: {e}}}}}",
               None, 0, None, None) for i, e in enumerate(exprs)]
    blocks += [(f"hit_{i:05d}", 3, None, i, f"match {i} [[Tag]]",
                None, 0, None, None) for i in range(matches)]
    return seeded_client(
        tmp_path,
        pages=[(1, "Source", None, None), (2, "Tag", None, None),
               (3, "Graph", None, None)],
        blocks=blocks,
        refs=[(f"hit_{i:05d}", 2, "link") for i in range(matches)])


def test_export_refuses_many_equivalent_queries_without_fetching_them_all(
        tmp_path, monkeypatch):
    # String-distinct but equivalent expressions each run once: 50 of them
    # over 40 matches would hold 2_000 rows. A budget of 200 calls stops
    # the gather after a handful, before rendering anything.
    exprs = ["{and: [[Tag]]" + " " * i + "}" for i in range(50)]
    tc = _query_graph_client(tmp_path, exprs, 40)
    monkeypatch.setattr(routes_export, "EXPORT_MAX_CHARS",
                        CHARS_PER_CALL * 200)
    rendered = []
    monkeypatch.setattr(routes_export, "render_page_resolved",
                        lambda *a, **k: rendered.append(a) or "")
    seen = _plan_rows_counter(monkeypatch)
    r = tc.get("/api/export/page/Source")
    assert r.status_code == 422
    assert r.json()["detail"].startswith(_REFUSED)
    assert "content-disposition" not in r.headers
    assert seen[0] <= 200
    assert rendered == []


def test_export_refuses_a_query_matching_past_the_budget_before_any_row(
        tmp_path, monkeypatch):
    tc = _query_graph_client(tmp_path, ["{and: [[Tag]]}"], 500)
    monkeypatch.setattr(routes_export, "EXPORT_MAX_CHARS",
                        CHARS_PER_CALL * 200)
    seen = _plan_rows_counter(monkeypatch)
    r = tc.get("/api/export/page/Source")
    assert r.status_code == 422
    assert r.json() == {"detail": "page too large to export: its block refs"
                        " and queries expand too many times"}
    assert seen[0] == 0


def test_export_under_the_lowered_bound_still_renders_every_match(
        tmp_path, monkeypatch):
    # 150 matches of about 20 rendered characters each fit a lowered
    # bound of 5_000: nothing is refused or dropped.
    tc = _query_graph_client(tmp_path, ["{and: [[Tag]]}"], 150)
    monkeypatch.setattr(routes_export, "EXPORT_MAX_CHARS",
                        CHARS_PER_CALL * 500)
    r = tc.get("/api/export/page/Source")
    assert r.status_code == 200
    assert "150 results" in r.text
    assert all(f"match {i} " in r.text for i in range(150))


def test_iter_plan_rows_streams_what_execute_plan_returns(tmp_path):
    from pkm.server.query import plan_sql
    from pkm.server.query_exec import (
        execute_plan, iter_plan_rows, parse_canonical_query)
    _query_graph_client(tmp_path, ["{and: [[Tag]]}"], 30)
    db = connect(tmp_path / "pkm.sqlite3")
    sql, params = plan_sql(parse_canonical_query(db, "{and: [[Tag]]}"))
    rows = execute_plan(db, sql, params).rows
    assert len(rows) == 30
    assert list(iter_plan_rows(db, sql, params)) == list(rows)


def test_export_refuses_items_whose_query_macros_cannot_render(
        tmp_path, monkeypatch):
    # Each match holds one macro of a 300-character expression, which the
    # renderer writes out whether or not it runs: 10 of them pass a
    # 2_000-character bound, so the gather refuses before rendering.
    # (Text after "see " so the match is not a macro block, which a query
    # never returns.)
    body = "see {{query: " + "Z" * 300 + "}}"
    blocks = [("src_00000", 1, None, 0, "{{query: {and: [[Tag]]}}}",
               None, 0, None, None)]
    blocks += [(f"hit_{i:05d}", 3, None, i, body, None, 0, None, None)
               for i in range(10)]
    tc = seeded_client(
        tmp_path,
        pages=[(1, "Source", None, None), (2, "Tag", None, None),
               (3, "Graph", None, None)],
        blocks=blocks,
        refs=[(f"hit_{i:05d}", 2, "link") for i in range(10)])
    monkeypatch.setattr(routes_export, "EXPORT_MAX_CHARS",
                        CHARS_PER_CALL * 200)
    rendered = []
    monkeypatch.setattr(routes_export, "render_page_resolved",
                        lambda *a, **k: rendered.append(a) or "")
    r = tc.get("/api/export/page/Source")
    assert r.status_code == 422
    assert r.json()["detail"].startswith(_REFUSED)
    assert rendered == []


def test_a_query_matching_nothing_runs_no_rows_query(tmp_path, monkeypatch):
    tc = _query_graph_client(tmp_path, ["{and: [[Nowhere]]}"], 5)
    streamed = []
    real = routes_export.iter_plan_rows
    monkeypatch.setattr(routes_export, "iter_plan_rows",
                        lambda *a: streamed.append(a) or real(*a))
    r = tc.get("/api/export/page/Source")
    assert r.status_code == 200
    assert "0 results" in r.text
    assert streamed == []
