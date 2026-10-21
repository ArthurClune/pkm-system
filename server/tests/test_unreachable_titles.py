"""A title with a `.`, `..` or empty `/` segment has no URL: URL clients
drop dot segments, and the SPA's router collapses `//`. It is refused as a
page title everywhere, and in block text it is no reference at all, like
`[[   ]]`. Two such pages may already be stored (`''` and `.`); reading,
syncing, auditing and deleting them never 500s."""
import pytest

from pkm.database import connect
from pkm.refs import extract
from pkm.server.db import open_db
from pkm.server.sync_meta import set_plain_space_title_canonicalization

_batch = iter(range(10_000))


def _ops(client, *ops):
    return client.post("/api/ops", json={
        "client_id": "c1", "batch_id": f"unreach_{next(_batch):06d}",
        "ops": list(ops)})


def _titles(config) -> list[str]:
    con = connect(config.db_path)
    try:
        return [r["title"] for r in con.select("SELECT title FROM pages")]
    finally:
        con.close()


@pytest.mark.parametrize("title_text", [".", "..", "/x", "x/", "a//b", "a/./b", "a/../b"])
def test_every_page_title_route_refuses_it(client, seeded_config, title_text):
    before = _titles(seeded_config)
    assert client.post("/api/pages", json={"title": title_text}).status_code == 422
    assert client.post("/api/sidebar", json={"title": title_text}).status_code == 422
    renamed = client.post("/api/page/Paper/rename", json={"new_title": title_text})
    assert renamed.status_code == 422
    assert _ops(client, {"op": "create_page", "page_title": title_text}).status_code == 400
    assert _titles(seeded_config) == before


def test_dot_segment_names_stay_allowed(client):
    for title_text in ["...", "a.b", "v1.2/x", "a / b"]:
        assert client.post("/api/pages", json={"title": title_text}).status_code == 200


@pytest.mark.parametrize("text", ["#work/", "(#.)", "#..", "[[Paper/]]",
                                  "[[a/../b]]", "a/:: v", "#[[/x]]"])
def test_such_a_ref_in_block_text_is_no_ref_and_never_refused(
        client, seeded_config, text):
    assert extract(text).refs == ()
    before = _titles(seeded_config)
    r = _ops(client, {"op": "update_text", "uid": "uid_b6", "text": text})
    assert r.status_code == 200
    assert _titles(seeded_config) == before


def test_a_padded_title_is_judged_edge_stripped_under_the_flag(
        client, seeded_config):
    # The ops check judged ` a] ` (allowed) and the store `a]` (refused):
    # an unhandled ForbiddenTitleError, a 500.
    con = open_db(seeded_config.db_path)
    set_plain_space_title_canonicalization(con, True)
    con.commit()
    con.close()
    assert _ops(client, {"op": "create_page", "page_title": " a] "}).status_code == 400
    assert _ops(client, {"op": "update_text", "uid": "uid_b6",
                         "text": "[[ a] ]]"}).status_code == 400
    assert _ops(client, {"op": "create_page", "page_title": " /x "}).status_code == 400


def _store_unreachable_pages(config) -> None:
    con = open_db(config.db_path)
    con.executemany(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?, ?, 1, 1)",
        [(70, "."), (71, "")])
    con.commit()
    con.close()


def test_stored_unreachable_pages_read_sync_and_audit_without_a_500(
        client, seeded_config):
    _store_unreachable_pages(seeded_config)
    # `%2E` reaches the route as `.`: only a literal dot is a dot segment.
    page = client.get("/api/page/%2E")
    assert page.status_code == 200
    assert page.json()["page"]["title"] == "."
    snapshot = client.get("/api/sync/snapshot")
    assert snapshot.status_code == 200
    assert {".", ""} <= {p["title"] for p in snapshot.json()["pages"]}
    assert client.get("/api/sync/changes").status_code == 200
    audit = client.get("/api/migrations/title-canonicalization")
    assert audit.status_code == 200
    blockers = {(b["page_id"], b["reason"]) for b in audit.json()["blockers"]}
    # `''` is already its own canonical form, so the audit has nothing to
    # plan for it; `.` would be stored as itself and is refused.
    assert (70, "forbidden_syntax") in blockers
    assert client.get("/api/journal").status_code == 200
    assert client.get("/api/current-work").status_code == 200


def test_stored_unreachable_pages_can_be_deleted_by_url(client, seeded_config):
    _store_unreachable_pages(seeded_config)
    # DELETE /api/page/%2E (curl keeps the escape; a literal `.` would be
    # dropped as a dot segment) and DELETE /api/page/ for the empty title.
    assert client.delete("/api/page/%2E").status_code == 200
    assert client.delete("/api/page/").status_code == 200
    assert "." not in _titles(seeded_config)
    assert "" not in _titles(seeded_config)
    audit = client.get("/api/migrations/title-canonicalization").json()
    assert {b["page_id"] for b in audit["blockers"]} & {70, 71} == set()
