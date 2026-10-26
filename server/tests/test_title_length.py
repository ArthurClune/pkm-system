"""A page title is at most MAX_PAGE_TITLE_CHARS code points of its fold:
`/api/ops` refuses the batch, the title routes answer 422, and the store
never creates such a page, while a page stored before the cap stays
readable, renamable to a shorter title and deletable."""
from __future__ import annotations

from collections.abc import Iterator

import pytest

from pkm.contracts.ops import BlockUid
from pkm.contracts.titles import RawTitle
from pkm.server.config import Config
from pkm.server.db import open_db
from pkm.server.store import (TitleTooLongError, get_or_create_page,
                              reindex_refs_for_text)
from pkm.test_data.ids import (batch_id_of, client_id_of, order_idx_of,
                               raw_title_of, uid_of)

T1001 = raw_title_of("t" * 1001)
LEGACY = raw_title_of("Legacy " + "l" * 1493)
LINKER = uid_of("legacy_link")
FINE_01 = uid_of("titlelen_fine1")
NEW_01 = uid_of("titlelen_new1")
OVER_LIMIT = "title of 1001 characters is over the limit of 1000"
_batch_counter = 0


def _post(client, *ops):
    global _batch_counter
    _batch_counter += 1
    return client.post("/api/ops", json={
        "client_id": client_id_of("titlelen"),
        "batch_id": batch_id_of(f"titlelen_{_batch_counter:08d}"),
        "ops": list(ops)})


def _create(uid: BlockUid, text: str,
            page_title: RawTitle = raw_title_of("AI")):
    return {"op": "create", "uid": uid, "page_title": page_title,
            "parent_uid": None, "order_idx": order_idx_of(0), "text": text}


def _rows(config: Config, sql: str, params: tuple = ()) -> list[tuple]:
    con = open_db(config.db_path)
    try:
        return [tuple(r.values()) for r in con.select(sql, params)]
    finally:
        con.close()


def _state(config: Config) -> dict[str, list[tuple]]:
    return {
        "pages": _rows(config, "SELECT id AS page_id, title FROM pages"
                               " ORDER BY id"),
        "blocks": _rows(config, "SELECT uid, page_id, text FROM blocks"
                                " ORDER BY uid"),
        "refs": _rows(config, "SELECT src_block_uid, target_page_id,"
                              " kind AS ref_kind FROM refs ORDER BY 1, 2, 3"),
    }


def _page_exists(config: Config, title: RawTitle) -> bool:
    return bool(_rows(config, "SELECT id AS page_id FROM pages"
                              " WHERE title = ?", (title,)))


def _block_exists(config: Config, uid: BlockUid) -> bool:
    return bool(_rows(config, "SELECT uid FROM blocks WHERE uid = ?",
                      (uid,)))


def _refused(r, index: int, reason: str) -> None:
    assert r.status_code == 400, r.text[:500]
    assert r.json()["detail"] == {"index": index, "reason": reason}


@pytest.fixture()
def legacy(seeded_config: Config) -> Iterator[None]:
    """A page stored before the cap, and a block on "AI" that links it,
    written straight to the tables."""
    con = open_db(seeded_config.db_path)
    try:
        con.execute("INSERT INTO pages(title, created_at, updated_at)"
                    " VALUES (?, 0, 0)", (LEGACY,))
        text = f"see [[{LEGACY}]]"
        con.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " collapsed) VALUES (?, 2, NULL, 9, ?, 0)", (LINKER, text))
        reindex_refs_for_text(con, LINKER, text, 0)
        con.commit()
    finally:
        con.close()
    yield


# --- /api/ops -------------------------------------------------------------


def test_create_page_at_the_cap_is_stored(client):
    title = "t" * 1000
    r = _post(client, {"op": "create_page", "page_title": title})
    assert r.status_code == 200, r.text[:500]
    assert client.get(f"/api/page/{title}").status_code == 200


def test_create_page_over_the_cap_refuses_the_batch(client, seeded_config):
    r = _post(client, _create(FINE_01, "fine"),
              {"op": "create_page", "page_title": T1001})
    _refused(r, 1, f"page_title {OVER_LIMIT}")
    assert not _block_exists(seeded_config, FINE_01)
    assert not _page_exists(seeded_config, T1001)


@pytest.mark.parametrize("op", [
    _create(NEW_01, "body", page_title=T1001),
    {"op": "move", "uid": "uid_b4", "parent_uid": None,
     "order_idx": 0, "page_title": T1001},
], ids=["create", "move"])
def test_a_create_or_move_page_title_over_the_cap_is_refused(
        client, seeded_config, op):
    before = _state(seeded_config)
    _refused(_post(client, op), 0, f"page_title {OVER_LIMIT}")
    assert _state(seeded_config) == before


@pytest.mark.parametrize("text", [
    f"[[{T1001}]]", f"#{T1001}", f"{T1001}:: v",
], ids=["link", "tag", "attribute"])
@pytest.mark.parametrize("kind", ["create", "update_text"])
def test_a_link_tag_or_attribute_to_a_long_title_is_refused(
        client, seeded_config, kind, text):
    op = (_create(NEW_01, text) if kind == "create"
          else {"op": "update_text", "uid": "uid_b4", "text": text})
    before = _state(seeded_config)
    _refused(_post(client, op), 0, f"reference {OVER_LIMIT}")
    assert not _page_exists(seeded_config, T1001)
    assert _state(seeded_config) == before


def test_a_fold_that_brings_a_title_to_the_cap_is_accepted(
        client, seeded_config):
    r = _post(client, {"op": "create_page",
                       "page_title": "t" * 500 + "\n\n" + "t" * 499})
    assert r.status_code == 200, r.text[:500]
    assert _page_exists(seeded_config,
                        raw_title_of("t" * 500 + " " + "t" * 499))


def test_length_is_judged_before_syntax_and_never_echoed(client):
    r = _post(client, {"op": "create_page",
                       "page_title": "#" + "t" * 2_000_000})
    _refused(r, 0, "page_title title of 2000001 characters is over the"
                   " limit of 1000")
    assert len(r.text) < 500


def test_an_update_text_page_title_hint_is_never_judged(
        client, seeded_config):
    r = _post(client, {"op": "update_text", "uid": "uid_b4",
                       "text": "edited", "page_title": T1001})
    assert r.status_code == 200, r.text[:500]
    assert _rows(seeded_config, "SELECT text FROM blocks WHERE uid = ?",
                 ("uid_b4",)) == [("edited",)]


# --- title routes ---------------------------------------------------------


def test_post_pages_over_the_cap_is_422(client, seeded_config):
    before = _state(seeded_config)
    r = client.post("/api/pages", json={"title": T1001})
    assert r.status_code == 422, r.text[:500]
    assert r.json()["detail"] == OVER_LIMIT
    assert _state(seeded_config) == before


def test_rename_to_a_title_over_the_cap_is_422_before_any_mutation(
        client, seeded_config):
    before = _state(seeded_config)
    r = client.post("/api/page/Machine Learning/rename",
                    json={"new_title": T1001, "allow_merge": True})
    assert r.status_code == 422, r.text[:500]
    assert r.json()["detail"] == OVER_LIMIT
    assert _state(seeded_config) == before


def test_a_sidebar_pin_over_the_cap_is_422(client, seeded_config):
    r = client.post("/api/sidebar", json={"title": T1001})
    assert r.status_code == 422, r.text[:500]
    assert r.json()["detail"] == OVER_LIMIT
    assert _rows(seeded_config, "SELECT title FROM sidebar_entries") == []


# A title both too long and of unsupported syntax: the length is judged
# first, since the syntax detail echoes the title.
LONG_AND_UNSUPPORTED = "#" + "t" * 2_000_000


@pytest.mark.parametrize("path, body", [
    ("/api/pages", {"title": LONG_AND_UNSUPPORTED}),
    ("/api/page/Machine Learning/rename",
     {"new_title": LONG_AND_UNSUPPORTED, "allow_merge": True}),
    ("/api/sidebar", {"title": LONG_AND_UNSUPPORTED}),
], ids=["create", "rename", "sidebar"])
def test_a_title_route_judges_length_before_syntax_and_never_echoes(
        client, seeded_config, path, body):
    before = _state(seeded_config)
    r = client.post(path, json=body)
    assert r.status_code == 422, r.text[:500]
    assert r.json()["detail"] == ("title of 2000001 characters is over the"
                                  " limit of 1000")
    assert len(r.text) < 500
    assert _state(seeded_config) == before
    assert _rows(seeded_config, "SELECT title FROM sidebar_entries") == []


# --- a page stored before the cap -----------------------------------------


def test_a_legacy_long_page_stays_readable_renamable_and_deletable(
        client, seeded_config, legacy):
    assert client.get(f"/api/page/{LEGACY}").status_code == 200
    r = client.post(f"/api/page/{LEGACY}/rename",
                    json={"new_title": "Short"})
    assert r.status_code == 200, r.text[:500]
    assert _rows(seeded_config, "SELECT text FROM blocks WHERE uid = ?",
                 (LINKER,)) == [("see [[Short]]",)]
    assert client.delete("/api/page/Short").status_code == 200
    assert not _page_exists(seeded_config, raw_title_of("Short"))


def test_reindexing_a_block_keeps_its_backlink_to_a_legacy_long_page(
        client, seeded_config, legacy):
    con = open_db(seeded_config.db_path)
    try:
        text = f"Studying [[Machine Learning]] and [[{LEGACY}]]"
        con.execute("UPDATE blocks SET text = ? WHERE uid = 'uid_b4'",
                    (text,))
        reindex_refs_for_text(con, uid_of("uid_b4"), text, 0)
        con.commit()
    finally:
        con.close()
    r = client.post("/api/page/Machine Learning/rename",
                    json={"new_title": "ML Stuff"})
    assert r.status_code == 200, r.text[:500]
    assert _rows(
        seeded_config,
        "SELECT r.src_block_uid FROM refs r JOIN pages p"
        " ON p.id = r.target_page_id WHERE p.title = ? ORDER BY 1",
        (LEGACY,)) == [("legacy_link",), ("uid_b4",)]


def test_an_op_naming_a_legacy_long_title_is_refused_until_renamed(
        client, legacy):
    r = _post(client, _create(NEW_01, "body", page_title=LEGACY))
    _refused(r, 0, "page_title title of 1500 characters is over the limit"
                   " of 1000")


def test_post_pages_with_a_legacy_long_title_is_422(client, legacy):
    r = client.post("/api/pages", json={"title": LEGACY})
    assert r.status_code == 422, r.text[:500]
    assert r.json()["detail"] == (
        "title of 1500 characters is over the limit of 1000")


def test_a_rename_onto_a_legacy_long_title_is_422(
        client, seeded_config, legacy):
    before = _state(seeded_config)
    r = client.post("/api/page/AI/rename",
                    json={"new_title": LEGACY, "allow_merge": True})
    assert r.status_code == 422, r.text[:500]
    assert _state(seeded_config) == before


# --- the store ------------------------------------------------------------


def test_get_or_create_page_refuses_only_creating_a_long_page(
        seeded_config, legacy):
    con = open_db(seeded_config.db_path)
    try:
        with pytest.raises(TitleTooLongError) as caught:
            get_or_create_page(con, T1001, 0)
        assert caught.value.measured == 1001
        assert caught.value.title == T1001
        assert str(caught.value) == OVER_LIMIT
        assert get_or_create_page(con, LEGACY, 0)[
            "title"] == LEGACY
    finally:
        con.close()
    assert not _page_exists(seeded_config, T1001)


def test_index_ref_never_creates_a_long_page(seeded_config):
    con = open_db(seeded_config.db_path)
    try:
        reindex_refs_for_text(con, uid_of("uid_b4"), f"[[{T1001}]]", 0)
        con.commit()
    finally:
        con.close()
    assert not _page_exists(seeded_config, T1001)
    assert _rows(seeded_config, "SELECT target_page_id FROM refs"
                                " WHERE src_block_uid = 'uid_b4'") == []
