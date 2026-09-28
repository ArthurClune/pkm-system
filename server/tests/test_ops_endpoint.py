import sqlite3
from datetime import date

import pytest

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import text_hash


_batch_counter = 0

def _post(client, *ops, client_id="c1", batch_id=None):
    global _batch_counter
    if batch_id is None:
        _batch_counter += 1
        batch_id = f"batch_{_batch_counter:08d}"
    return client.post("/api/ops",
                       json={"client_id": client_id, "batch_id": batch_id,
                             "ops": list(ops)})


def test_ops_require_auth(anon_client):
    r = anon_client.post("/api/ops", json={
        "client_id": "c1",
        "batch_id": "auth_test1",
        "ops": [{"op": "delete", "uid": "uid_b1"}]})
    assert r.status_code == 401


def test_create_then_read_back(client):
    r = _post(client, {"op": "create", "uid": "newuid1",
                       "page_title": "Machine Learning", "parent_uid": "uid_b2",
                       "order_idx": 1, "text": "fresh [[Novel Page]]"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["applied"] == 1
    page = client.get("/api/page/Machine Learning").json()
    papers = page["blocks"][1]
    assert [c["text"] for c in papers["children"]] == \
        ["[[Attention Is All You Need]] is a [[Paper]]", "fresh [[Novel Page]]"]
    # implicit page + backlink
    novel = client.get("/api/page/Novel Page").json()
    [group] = novel["backlinks"]["groups"]
    assert group["page_title"] == "Machine Learning"


def test_update_text_moves_search_and_backlinks(client):
    r = _post(client, {"op": "update_text", "uid": "uid_b4",
                       "text": "now about [[Paper]] instead"})
    assert r.status_code == 200
    hits = client.get("/api/search", params={"q": "Studying"}).json()
    assert hits["blocks"] == []
    paper = client.get("/api/page/Paper").json()
    uids = {i["uid"] for g in paper["backlinks"]["groups"] for i in g["items"]}
    assert "uid_b4" in uids
    ml = client.get("/api/page/Machine Learning").json()
    assert ml["backlinks"]["groups"] == []  # old link gone


def test_move_and_collapse_roundtrip(client):
    r = _post(client,
              {"op": "move", "uid": "uid_b3", "parent_uid": None,
               "order_idx": 0},
              {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True})
    assert r.status_code == 200
    page = client.get("/api/page/Machine Learning").json()
    assert [b["text"] for b in page["blocks"]] == \
        ["[[Attention Is All You Need]] is a [[Paper]]", "Tags:: #AI", "Papers"]
    assert page["blocks"][2]["collapsed"] is True
    assert page["blocks"][2]["children"] == []


def test_set_heading_via_endpoint(client):
    r = _post(client, {"op": "set_heading", "uid": "uid_b2", "heading": 2})
    assert r.status_code == 200
    page = client.get("/api/page/Machine Learning").json()
    assert page["blocks"][1]["heading"] == 2


def test_set_heading_rejects_out_of_range(client):
    r = _post(client, {"op": "set_heading", "uid": "uid_b2", "heading": 5})
    assert r.status_code == 422


def test_set_view_type_persists_and_roundtrips_in_page_reads(client):
    before = client.get("/api/page/Machine Learning").json()["blocks"][1]
    assert before["view_type"] is None
    r = _post(client, {"op": "set_view_type", "uid": "uid_b2",
                       "view_type": "numbered"})
    assert r.status_code == 200
    after = client.get("/api/page/Machine Learning").json()["blocks"][1]
    assert after["view_type"] == "numbered"
    assert after["text"] == before["text"]
    assert after["collapsed"] == before["collapsed"]
    assert [c["uid"] for c in after["children"]] == \
        [c["uid"] for c in before["children"]]


def test_set_view_type_rejects_unknown_value(client):
    r = _post(client, {"op": "set_view_type", "uid": "uid_b2",
                       "view_type": "table"})
    assert r.status_code == 422


def test_delete_subtree_via_endpoint(client):
    assert _post(client, {"op": "delete", "uid": "uid_b2"}).status_code == 200
    page = client.get("/api/page/Machine Learning").json()
    assert [b["text"] for b in page["blocks"]] == ["Tags:: #AI"]
    assert client.get("/api/search",
                      params={"q": "Papers"}).json()["blocks"] == []


def _write_state(config):
    queries = {
        "pages": "SELECT * FROM pages ORDER BY id",
        "blocks": "SELECT * FROM blocks ORDER BY uid",
        "refs": (
            "SELECT * FROM refs ORDER BY src_block_uid, target_page_id, kind"
        ),
        "pages_fts": "SELECT rowid, * FROM pages_fts ORDER BY rowid",
        "blocks_fts": "SELECT rowid, * FROM blocks_fts ORDER BY rowid",
        "changes": "SELECT * FROM changes ORDER BY seq",
        "applied_batches": "SELECT * FROM applied_batches ORDER BY batch_id",
    }
    con = sqlite3.connect(config.db_path)
    try:
        return {
            table: con.execute(query).fetchall()
            for table, query in queries.items()
        }
    finally:
        con.close()


@pytest.mark.parametrize(
    ("invalid_op", "source", "title"),
    [
        (
            {"op": "create_page", "page_title": "New #Old"},
            "page_title",
            "New #Old",
        ),
        (
            {"op": "create", "uid": "atomicbad02",
             "page_title": "New #Old", "parent_uid": None,
             "order_idx": 0, "text": "plain"},
            "page_title",
            "New #Old",
        ),
        (
            {"op": "move", "uid": "uid_b4", "parent_uid": None,
             "order_idx": 0, "page_title": "New #Old"},
            "page_title",
            "New #Old",
        ),
        (
            {"op": "create", "uid": "atomicbad03", "page_title": "AI",
             "parent_uid": None, "order_idx": 0,
             "text": "[[Safe Ref]] then [[New #Old]]"},
            "reference",
            "New #Old",
        ),
        (
            {"op": "update_text", "uid": "uid_b4",
             "text": "[[Safe Ref]] then [[New #Old]]"},
            "reference",
            "New #Old",
        ),
        (
            {"op": "create", "uid": "atomicbad04", "page_title": "AI",
             "parent_uid": None, "order_idx": 0,
             "text": "[[Outer [[New #Old]]]]"},
            "reference",
            "Outer [[New #Old]]",
        ),
    ],
    ids=[
        "create_page",
        "create",
        "move",
        "create_ref",
        "update_ref",
        "nested_ref",
    ],
)
def test_forbidden_title_in_second_op_refuses_complete_batch_before_mutation(
        client, seeded_config, invalid_op, source, title):
    before = _write_state(seeded_config)

    response = _post(
        client,
        {"op": "create", "uid": "atomicgood1",
         "page_title": "Atomic First Page", "parent_uid": None,
         "order_idx": 0, "text": "[[Atomic Safe Ref]]"},
        invalid_op,
    )

    assert response.status_code == 400
    assert response.json()["detail"] == {
        "index": 1,
        "reason": f"unsupported {source} title syntax: {title!r}",
    }
    assert _write_state(seeded_config) == before


def test_batch_is_atomic_and_reports_index(client):
    r = _post(client,
              {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
              {"op": "delete", "uid": "ghost99"})
    assert r.status_code == 400
    assert r.json()["detail"]["index"] == 1
    assert "not found" in r.json()["detail"]["reason"]
    page = client.get("/api/page/Machine Learning").json()
    assert page["blocks"][1]["collapsed"] is False  # op 0 rolled back


def test_cycle_move_rejected(client):
    r = _post(client, {"op": "move", "uid": "uid_b2", "parent_uid": "uid_b3",
                       "order_idx": 0})
    assert r.status_code == 400
    assert "cycle" in r.json()["detail"]["reason"]


def test_malformed_batch_422(client):
    r = client.post("/api/ops", json={"client_id": "c1",
                                      "batch_id": "malform1",
                                      "ops": [{"op": "explode"}]})
    assert r.status_code == 422


def test_cross_page_move_under_parent(client, seeded_config):
    # uid_b4 (on "July 7th, 2026") becomes a child of uid_b2 (on "Machine
    # Learning"): subtree page_id follows, uid unchanged.
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "cross_move_1",
                                      "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": "uid_b2",
         "order_idx": 99}]})
    assert r.status_code == 200
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    row = con.execute(
        "SELECT page_id, parent_uid FROM blocks WHERE uid='uid_b4'").fetchone()
    assert row["page_id"] == 1 and row["parent_uid"] == "uid_b2"
    con.close()


def test_cross_page_move_top_level_auto_creates_page(client, seeded_config):
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "auto_page1",
                                      "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": None, "order_idx": 0,
         "page_title": "July 1st, 2026"}]})
    assert r.status_code == 200
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    page = con.execute(
        "SELECT id FROM pages WHERE title='July 1st, 2026'").fetchone()
    assert page is not None
    row = con.execute(
        "SELECT page_id, parent_uid FROM blocks WHERE uid='uid_b4'").fetchone()
    assert row["page_id"] == page["id"] and row["parent_uid"] is None
    con.close()


def test_cross_page_move_subtree_and_backlinks_survive(client, seeded_config):
    # uid_b2 has child uid_b3 ("[[Attention Is All You Need]] is a [[Paper]]").
    # Move uid_b2 to July 7th: child's page_id follows; refs rows untouched;
    # the moved text is still findable via search (FTS keyed by rowid).
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "subtree1",
                                      "ops": [
        {"op": "move", "uid": "uid_b2", "parent_uid": None, "order_idx": 9,
         "page_title": "July 7th, 2026"}]})
    assert r.status_code == 200
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    pages = {r_["uid"]: r_["page_id"] for r_ in con.execute(
        "SELECT uid, page_id FROM blocks WHERE uid IN ('uid_b2','uid_b3')")}
    assert pages == {"uid_b2": 3, "uid_b3": 3}
    refs = con.execute(
        "SELECT count(*) FROM refs WHERE src_block_uid='uid_b3'").fetchone()[0]
    assert refs == 2
    con.close()
    hits = client.get("/api/search", params={"q": "Attention"}).json()
    assert any(b["uid"] == "uid_b3" for b in hits["blocks"])
    assert all(b["page_title"] == "July 7th, 2026"
               for b in hits["blocks"] if b["uid"] == "uid_b3")


def test_batch_rollback_undoes_auto_created_page(client, seeded_config):
    # op 0 moves uid_b4 to a brand-new page (get_or_create_page inserts a
    # pages row mid-batch); op 1 fails. The whole transaction must roll back —
    # the auto-created page and the move both vanish. Exercises the real
    # db.rollback() in routes_ops, not just the pure planner.
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "rollback1",
                                      "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": None, "order_idx": 0,
         "page_title": "Brand New Page"},
        {"op": "delete", "uid": "ghost99"}]})
    assert r.status_code == 400
    assert r.json()["detail"]["index"] == 1
    con = sqlite3.connect(seeded_config.db_path)
    con.row_factory = sqlite3.Row
    assert con.execute(
        "SELECT id FROM pages WHERE title='Brand New Page'").fetchone() is None
    row = con.execute(
        "SELECT page_id, parent_uid FROM blocks WHERE uid='uid_b4'").fetchone()
    assert row["page_id"] == 3 and row["parent_uid"] is None  # move undone
    con.close()


def test_cross_page_move_page_title_parent_mismatch_400(client):
    r = client.post("/api/ops", json={"client_id": "t", "batch_id": "mismatch1",
                                      "ops": [
        {"op": "move", "uid": "uid_b4", "parent_uid": "uid_b2",
         "order_idx": 0, "page_title": "July 7th, 2026"}]})
    assert r.status_code == 400
    assert "page_title does not match" in r.json()["detail"]["reason"]


def test_create_page_op_creates_and_is_idempotent(client):
    body = {"client_id": "c1", "batch_id": "create_page1", "ops": [
        {"op": "create_page", "page_title": "Offline Made Me"}]}
    assert client.post("/api/ops", json=body).status_code == 200
    assert client.post("/api/ops", json=body).status_code == 200  # replayable
    r = client.get("/api/page/Offline%20Made%20Me")
    assert r.status_code == 200
    # exactly one page: titles endpoint returns it once
    titles = client.get("/api/titles?q=Offline%20Made%20Me").json()["titles"]
    assert titles.count("Offline Made Me") == 1


def test_create_page_op_reaches_changes_feed(client):
    start = client.get("/api/sync/changes").json()["latest_seq"]
    client.post("/api/ops", json={"client_id": "c1", "batch_id": "feed_vis1",
                                  "ops": [
        {"op": "create_page", "page_title": "Feed Visible"}]})
    feed = client.get(f"/api/sync/changes?since={start}").json()
    assert "Feed Visible" in {p["title"] for p in feed["pages"]}


# --- conflicts land in the daily note (pkm-3g4n) ---------------------------
#
# Every text conflict lands on today's daily page as a top-level
# "[[conflict]] [[Page]] — ..." header, with the lost texts as its children,
# one header per block per day.

def _conflicts(client, day=None):
    """(header text, [child texts]) for each [[conflict]] header on the
    daily page for `day` (default: today)."""
    title = title_for_date(day if day is not None else date.today())
    r = client.get(f"/api/page/{title}")
    if r.status_code == 404:
        return []
    return [(b["text"], [c["text"] for c in b["children"]])
            for b in r.json()["blocks"]
            if b["text"].startswith("[[conflict]]")]


def _orphan_edit(uid, text, page_title=None):
    op = {"op": "update_text", "uid": uid, "text": text,
          "base_text_hash": text_hash("whatever")}
    if page_title is not None:
        op["page_title"] = page_title
    return op


ORPHAN_SUFFIX = " — edit to a block the server no longer has"


def test_live_conflict_goes_to_daily_note_not_the_page(client):
    # uid_b1's live text is "Tags:: #AI" (conftest seed); simulate an
    # offline edit based on stale text
    start = client.get("/api/sync/changes").json()["latest_seq"]
    r = _post(client, {"op": "update_text", "uid": "uid_b1",
                       "text": "offline edit",
                       "base_text_hash": text_hash("some stale base")})
    assert r.status_code == 200
    texts = _ml_texts(client)
    assert "offline edit" in texts
    assert not any("[[conflict]]" in t for t in texts)
    header = "[[conflict]] [[Machine Learning]] — overwritten by ((uid_b1))"
    assert _conflicts(client) == [(header, ["Tags:: #AI"])]

    # the header is an ordinary block: its refs are indexed ...
    daily = client.get(f"/api/page/{title_for_date(date.today())}").json()
    [header_block] = [b for b in daily["blocks"] if b["text"] == header]
    header_uid = header_block["uid"]
    child_uid = header_block["children"][0]["uid"]
    for title in ("conflict", "Machine%20Learning"):
        page = client.get(f"/api/page/{title}").json()
        uids = {i["uid"] for g in page["backlinks"]["groups"]
                for i in g["items"]}
        assert header_uid in uids
    # ... and both new blocks reach the changes journal
    feed = client.get(f"/api/sync/changes?since={start}").json()
    assert {header_uid, child_uid} <= {b["uid"] for b in feed["blocks"]}


def test_clean_hashed_edit_does_not_create_todays_daily_page(
        client, seeded_config):
    from pkm.server.db import open_db

    r = _post(client, {"op": "update_text", "uid": "uid_b1",
                       "text": "clean edit",
                       "base_text_hash": text_hash("Tags:: #AI")})
    assert r.status_code == 200
    # checked in the DB: a GET of today's page would itself create it
    con = open_db(seeded_config.db_path)
    row = con.execute("SELECT 1 FROM pages WHERE title = ?",
                      (title_for_date(date.today()),)).fetchone()
    con.close()
    assert row is None


def test_orphan_conflict_names_hinted_page(client):
    _post(client, {"op": "delete", "uid": "uid_b6"})
    r = _post(client, _orphan_edit("uid_b6", "edited after delete",
                                   page_title="Machine Learning"))
    assert r.status_code == 200
    assert _conflicts(client) == [
        ("[[conflict]] [[Machine Learning]]" + ORPHAN_SUFFIX,
         ["edited after delete"])]


def test_repeated_orphan_edits_group_under_one_header(client):
    for text in ("O", "Op", "Ope"):
        assert _post(client, _orphan_edit("uid_zz1", text)).status_code == 200
    assert _conflicts(client) == [
        ("[[conflict]] (page unknown)" + ORPHAN_SUFFIX, ["O", "Op", "Ope"])]


def test_two_conflicts_in_one_batch_group(client):
    r = _post(client, _orphan_edit("uid_zz2", "first"),
              _orphan_edit("uid_zz2", "second"))
    assert r.status_code == 200
    assert _conflicts(client) == [
        ("[[conflict]] (page unknown)" + ORPHAN_SUFFIX, ["first", "second"])]


def test_deleted_header_starts_a_fresh_one(client):
    _post(client, _orphan_edit("uid_zz3", "before"))
    daily = client.get(f"/api/page/{title_for_date(date.today())}").json()
    [header] = [b for b in daily["blocks"]
                if b["text"].startswith("[[conflict]]")]
    assert _post(client, {"op": "delete", "uid": header["uid"]}
                 ).status_code == 200
    _post(client, _orphan_edit("uid_zz3", "after"))
    assert _conflicts(client) == [
        ("[[conflict]] (page unknown)" + ORPHAN_SUFFIX, ["after"])]


def test_new_day_starts_a_fresh_header_and_prunes(client, seeded_config,
                                                   monkeypatch):
    from pkm.server import ops_apply
    from pkm.server.db import open_db

    def on(day):
        class _Date:
            @staticmethod
            def today():
                return day
        monkeypatch.setattr(ops_apply, "date", _Date)

    day1, day2 = date(2026, 9, 27), date(2026, 9, 28)
    on(day1)
    _post(client, _orphan_edit("uid_zz4", "day one"))
    on(day2)
    _post(client, _orphan_edit("uid_zz4", "day two"))

    label = "[[conflict]] (page unknown)" + ORPHAN_SUFFIX
    assert _conflicts(client, day1) == [(label, ["day one"])]
    assert _conflicts(client, day2) == [(label, ["day two"])]
    con = open_db(seeded_config.db_path)
    days = [r["day"] for r in con.execute("SELECT day FROM conflict_headers")]
    con.close()
    assert days == [title_for_date(day2)]


def test_unusable_hint_is_labelled_not_rejected(client):
    r = _post(client, _orphan_edit("uid_zz5", "kept",
                                   page_title="bad[[title"))
    assert r.status_code == 200
    assert _conflicts(client) == [
        ("[[conflict]] (page unknown)" + ORPHAN_SUFFIX, ["kept"])]


def test_replayed_conflict_batch_adds_nothing(client):
    op = _orphan_edit("uid_zz6", "once")
    assert _post(client, op, batch_id="replayed_conflict1").status_code == 200
    assert _post(client, op, batch_id="replayed_conflict1").status_code == 200
    assert _conflicts(client) == [
        ("[[conflict]] (page unknown)" + ORPHAN_SUFFIX, ["once"])]


def test_no_false_conflict_after_structural_change(client):
    base = "Tags:: #AI"
    # a collapse (structural op) between base and push must NOT conflict
    client.post("/api/ops", json={"client_id": "c1", "batch_id": "struct_chg1",
                                  "ops": [
        {"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]})
    r = client.post("/api/ops", json={"client_id": "c1", "batch_id": "struct_chg2",
                                      "ops": [
        {"op": "update_text", "uid": "uid_b1", "text": "clean edit",
         "base_text_hash": text_hash(base)}]})
    assert r.status_code == 200
    page = client.get("/api/page/Machine%20Learning").json()
    assert not any("[[conflict]]" in b["text"] for b in page["blocks"])


def test_hashless_update_on_missing_block_still_400s(client):
    r = client.post("/api/ops", json={"client_id": "c1", "batch_id": "gone_uid1",
                                      "ops": [
        {"op": "update_text", "uid": "gone_uid1", "text": "x"}]})
    assert r.status_code == 400


# --- stale edits across a rename or merge ---------------------------------
#
# uid_b1's seeded text is "Tags:: #AI", so renaming the "AI" page rewrites
# it. A device that edited the block before syncing that rename pushes the
# old spelling with the pre-rename hash; the rename is replayed over the
# incoming text rather than letting the old title win (pkm-x5w0).

STALE_BASE = "Tags:: #AI"
STALE_EDIT = "Tags:: #AI plus offline words"


def _rename(client, title, new_title, allow_merge=False):
    r = client.post(f"/api/page/{title}/rename",
                    json={"new_title": new_title, "allow_merge": allow_merge})
    assert r.status_code == 200, r.text
    return r


def _ml_texts(client):
    page = client.get("/api/page/Machine%20Learning").json()
    return [b["text"] for b in page["blocks"]]


def _stale_push(client, base_text, text=STALE_EDIT):
    r = _post(client, {"op": "update_text", "uid": "uid_b1", "text": text,
                       "base_text_hash": text_hash(base_text)})
    assert r.status_code == 200, r.text
    return r


def test_stale_edit_replays_a_rename_instead_of_resurrecting_the_title(client):
    start = client.get("/api/sync/changes").json()["latest_seq"]
    _rename(client, "AI", "Artificial Intelligence")
    _stale_push(client, STALE_BASE)

    rewritten = "Tags:: #[[Artificial Intelligence]] plus offline words"
    assert _ml_texts(client)[0] == rewritten
    assert client.get("/api/page/AI").status_code == 404
    assert client.get("/api/page/conflict").status_code == 404
    feed = client.get(f"/api/sync/changes?since={start}").json()
    assert {b["uid"]: b["text"] for b in feed["blocks"]}["uid_b1"] == rewritten


def test_stale_edit_replays_a_merge_instead_of_resurrecting_the_title(client):
    _rename(client, "AI", "Paper", allow_merge=True)
    _stale_push(client, STALE_BASE)

    assert _ml_texts(client)[0] == "Tags:: #Paper plus offline words"
    assert client.get("/api/page/AI").status_code == 404
    assert client.get("/api/page/conflict").status_code == 404


def test_stale_edit_replays_a_chain_of_renames(client):
    _rename(client, "AI", "Artificial Intelligence")
    _rename(client, "Artificial Intelligence", "Cognition")
    _stale_push(client, STALE_BASE)

    assert _ml_texts(client)[0] == "Tags:: #[[Cognition]] plus offline words"
    assert client.get("/api/page/AI").status_code == 404
    assert client.get("/api/page/Artificial%20Intelligence").status_code == 404
    assert client.get("/api/page/conflict").status_code == 404


def test_stale_edit_matching_no_rewrite_still_takes_the_conflict_path(client):
    _rename(client, "AI", "Artificial Intelligence")
    _stale_push(client, "some stale base", text="offline edit")

    assert "offline edit" in _ml_texts(client)
    [(_, lost)] = _conflicts(client)
    assert lost == ["Tags:: #[[Artificial Intelligence]]"]


def test_edit_after_a_rename_keeps_the_conflict_path_under_the_new_title(client):
    _rename(client, "AI", "Artificial Intelligence")
    r = _post(client, {"op": "update_text", "uid": "uid_b1",
                       "text": "Tags:: #[[Artificial Intelligence]] fresh"})
    assert r.status_code == 200
    _stale_push(client, STALE_BASE)

    texts = _ml_texts(client)
    assert texts[0] == "Tags:: #[[Artificial Intelligence]] plus offline words"
    [(_, lost)] = _conflicts(client)
    assert lost == ["Tags:: #[[Artificial Intelligence]] fresh"]
    assert not any("#AI" in t for t in texts + lost)
    assert client.get("/api/page/AI").status_code == 404


def test_rewrite_records_are_pruned_past_the_retention_window(
        client, seeded_config):
    from pkm.server.db import open_db

    con = open_db(seeded_config.db_path)
    con.execute(
        "INSERT INTO block_rewrites(uid, base_hash, after_hash, old_title,"
        " new_title, created_at) VALUES ('uid_b1','h0','h1','Old','New',1)")
    con.commit()
    con.close()

    _rename(client, "AI", "Artificial Intelligence")

    con = open_db(seeded_config.db_path)
    rows = [(r["uid"], r["old_title"], r["new_title"]) for r in con.execute(
        "SELECT uid, old_title, new_title FROM block_rewrites")]
    con.close()
    assert rows == [("uid_b1", "AI", "Artificial Intelligence")]
