"""A title's whitespace runs fold to one U+0020, at creation and at lookup,
from the one list `TITLE_WHITESPACE`. A lookup key therefore reaches the
page its spelling names, never a twin: `A  B`, `A\\u00a0B` and `A B\\n` are
all the page `A B`. Characters outside the list (zero-width, U+FEFF, the
U+001C-U+001F separators) are not whitespace to a title and stay byte-exact.
"""
import asyncio

import httpx
import pytest

from pkm.client.api import PkmClient
from pkm.client.core import CliConfig
from pkm.contracts.titles import TITLE_WHITESPACE
from pkm.database import connect
from pkm.refs import canonicalize_title, extract, normalize_title
from pkm.server.db import open_db
from pkm.server.sync_meta import set_plain_space_title_canonicalization
from pkm.test_data.ids import raw_title_of

_batch = iter(range(10_000))


@pytest.fixture(params=[False, True], ids=["flag_off", "flag_on"])
def active(request, seeded_config) -> bool:
    """The plain-space title flag, set on the seeded database."""
    con = open_db(seeded_config.db_path)
    set_plain_space_title_canonicalization(con, request.param)
    con.commit()
    con.close()
    return request.param


def _send(client, method: str, path: str,
          json: dict | None = None) -> httpx.Response:
    """`method` on `path` decoded once, as uvicorn does. TestClient decodes
    a path's percent-escapes twice."""
    cookie = client.cookies["pkm_session"]

    async def run():
        transport = httpx.ASGITransport(app=client.app)
        async with httpx.AsyncClient(
                transport=transport, base_url="http://testserver",
                cookies={"pkm_session": cookie}) as c:
            return await c.request(method, path, json=json)
    return asyncio.run(run())


def _ops(client, *ops):
    return client.post("/api/ops", json={
        "client_id": "c1", "batch_id": f"wsfold_{next(_batch):06d}",
        "ops": list(ops)})


def _titles(config) -> list[str]:
    con = connect(config.db_path)
    try:
        return [r["title"] for r in con.select("SELECT title FROM pages")]
    finally:
        con.close()


def _folding_to(config, words: str) -> list[str]:
    """The stored titles whose words are `words`, joined by one space;
    judged by `str.split` rather than the code under test."""
    return [t for t in _titles(config) if " ".join(t.split()) == words]


SPELLINGS = ["A  B", "A\u00a0B", "A\u3000B", "A\u2009B", "A\tB"]


def test_create_folds_onto_existing_page(client, seeded_config, active):
    assert client.post("/api/pages", json={"title": "A B"}).status_code == 200
    for spelling in SPELLINGS:
        r = client.post("/api/pages", json={"title": spelling})
        assert r.status_code == 200, (spelling, r.text)
        assert r.json()["title"] == "A B", spelling
    titles = _titles(seeded_config)
    assert titles.count("A B") == 1
    assert not set(SPELLINGS) & set(titles)


def test_get_both_spellings_reach_one_page(client, active):
    for t in ["A  B", "A B"]:
        assert client.post("/api/pages", json={"title": t}).status_code == 200
    pages = [_send(client, "GET", p)
             for p in ["/api/page/A%20%20B", "/api/page/A%20%20B%0A",
                       "/api/page/A%20B"]]
    assert [r.status_code for r in pages] == [200, 200, 200]
    assert {r.json()["page"]["id"] for r in pages} == {
        pages[0].json()["page"]["id"]}
    assert {r.json()["page"]["title"] for r in pages} == {"A B"}


def test_delete_with_control_suffix_leaves_no_twin(
        client, seeded_config, active):
    for t in ["A  B", "A B"]:
        assert client.post("/api/pages", json={"title": t}).status_code == 200
    assert _send(client, "DELETE", "/api/page/A%20%20B%0A").status_code == 200
    assert _folding_to(seeded_config, "A B") == []


def test_rename_with_control_suffix_renames_the_one_page(
        client, seeded_config, active):
    for t in ["A  B", "A B"]:
        assert client.post("/api/pages", json={"title": t}).status_code == 200
    r = _send(client, "POST", "/api/page/A%20%20B%09/rename",
              json={"new_title": "Renamed"})
    assert r.status_code == 200, r.text
    assert "Renamed" in _titles(seeded_config)
    assert _folding_to(seeded_config, "A B") == []


def test_pkm_client_rename_path(client, seeded_config, active):
    pc = PkmClient(CliConfig(url="http://testserver",
                             token=client.cookies["pkm_session"]),
                   http=client)
    for t in ["A  B", "A B"]:
        assert client.post("/api/pages", json={"title": t}).status_code == 200
    res = pc.rename_page(raw_title_of("A  B\n"), raw_title_of("ViaClient"))
    assert (res.result, res.title) == ("renamed", "ViaClient")
    assert _folding_to(seeded_config, "A B") == []


def test_rename_to_fold_equal_title_is_unchanged(client):
    assert client.post("/api/pages", json={"title": "A B"}).status_code == 200
    for spelling in ["A  B", "A\u00a0B"]:
        r = client.post("/api/page/A%20B/rename",
                        json={"new_title": spelling})
        assert r.status_code == 400, (spelling, r.text)
        assert "title is unchanged" in r.text


def test_rename_onto_fold_twin_conflicts(client, seeded_config):
    for t in ["A B", "Foo"]:
        assert client.post("/api/pages", json={"title": t}).status_code == 200
    r = client.post("/api/page/Foo/rename", json={"new_title": "A\u00a0B"})
    assert r.status_code == 409, r.text
    r = client.post("/api/page/Foo/rename",
                    json={"new_title": "A\u00a0B", "allow_merge": True})
    assert r.status_code == 200, r.text
    assert (r.json()["result"], r.json()["title"]) == ("merged", "A B")
    assert "Foo" not in _titles(seeded_config)


@pytest.mark.parametrize("title_text", ["\u3000", "\u00a0\u00a0", "\u2028"])
def test_whitespace_only_titles_are_blank(client, seeded_config, title_text):
    before = _titles(seeded_config)
    assert client.post("/api/pages",
                       json={"title": title_text}).status_code == 422
    assert _titles(seeded_config) == before
    r = _ops(client, {"op": "create_page", "page_title": title_text})
    assert r.status_code == 200, r.text
    assert sorted(_titles(seeded_config)) == sorted([*before, "Untitled"])
    assert extract(f"[[{title_text}]]").refs == ()


@pytest.mark.parametrize("title_text",
                         ["A\u200bB", "A\ufeffB", "A\x1cB", "A\u180eB"])
def test_lookalikes_outside_the_list_are_not_folded(
        client, seeded_config, title_text):
    assert normalize_title(title_text) == title_text
    assert client.post("/api/pages", json={"title": "A B"}).status_code == 200
    r = client.post("/api/pages", json={"title": title_text})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == title_text
    titles = _titles(seeded_config)
    assert title_text in titles and "A B" in titles


def test_title_whitespace_is_unicode_white_space():
    python_space = {chr(c) for c in range(0x110000) if chr(c).isspace()}
    assert set(TITLE_WHITESPACE) == python_space - set("\x1c\x1d\x1e\x1f")
    assert list(TITLE_WHITESPACE) == sorted(set(TITLE_WHITESPACE))


@pytest.mark.parametrize(("text", "inactive", "active_result"), [
    ("A  B", "A B", "A B"),
    ("A\u00a0B", "A B", "A B"),
    (" A ", " A ", "A"),
    ("  A", "A", "A"),
    ("\tA\u3000", "A", "A"),
    ("Foo\n", "Foo", "Foo"),
    ("A B", "A B", "A B"),
    ("", "", ""),
])
def test_normalize_title_fold_table(text, inactive, active_result):
    assert normalize_title(text) == inactive
    assert canonicalize_title(text, plain_space=False) == inactive
    assert canonicalize_title(text, plain_space=True) == active_result
    assert normalize_title(inactive) == inactive
    assert canonicalize_title(active_result, plain_space=True) == active_result
