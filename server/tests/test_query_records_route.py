"""GET /api/query/records: a query's results as table rows, read from the
database in a number of statements that does not grow with the results."""
from __future__ import annotations

import pytest
from rawread import trace

from pkm.server import query_records_db
from pkm.server.db import open_db
from pkm.server.query_records_db import line_insert_points, page_insert_points
from pkm.server.routes_search import query_records
from pkm.server.sync_meta import read_title
from pkm.test_data.ids import order_idx_of, page_id_of, uid_of

_batches = 0


def _ops(client, *ops: dict[str, object]) -> None:
    global _batches
    _batches += 1
    r = client.post("/api/ops", json={
        "client_id": "t-records", "batch_id": f"records_{_batches:08d}",
        "ops": list(ops)})
    assert r.status_code == 200, r.text


def _line(block: str, page: str, text: str, position: int,
          parent: str | None = None) -> dict[str, object]:
    return {"op": "create", "uid": block, "page_title": page,
            "parent_uid": parent, "order_idx": position, "text": text}


def _records(client, expr: str) -> dict:
    r = client.get("/api/query/records", params={"expr": expr})
    assert r.status_code == 200, r.text
    return r.json()


def _by_title(body: dict) -> dict[str, dict]:
    return {rec["row_title"]: rec for rec in body["records"]}


def _seed_books(client) -> None:
    _ops(client,
         _line("dune_tags", "Book/Dune", "Tags:: #Book", 0),
         _line("dune_auth", "Book/Dune", "Author:: Frank Herbert", 1),
         _line("dune_stat", "Book/Dune", "Reading Status:: Read", 2),
         _line("dune_note", "Book/Dune", "A plain note", 3),
         _line("emma_tags", "Book/Emma", "Tags:: #Book", 0),
         _line("emma_auth", "Book/Emma", "Author:: Jane Austen", 1),
         _line("emma_stat", "Book/Emma", "Reading Status::", 2),
         _line("bk_query", "Reading List", "{{query: {and: [[Book]]}}}", 0))


def test_records_books_shape(client):
    _seed_books(client)
    body = _records(client, "{and: [[Book]]}")

    assert body["total"] == 2
    assert [rec["row_title"] for rec in body["records"]] == \
        ["Book/Dune", "Book/Emma"]
    dune, emma = body["records"]
    assert dune["kind"] == "page" and dune["uid"] is None
    assert dune["key"] == f"page:{dune['page_id']}"
    assert dune["result_uids"] == ["dune_tags"]
    assert dune["insert_parent_uid"] is None
    assert emma["cells"]["Reading Status"]["value"] == ""
    assert emma["cells"]["Reading Status"]["uid"] == "emma_stat"
    assert dune["cells"]["Author"]["value"] == "Frank Herbert"
    keys = {k["key"]: k for k in body["keys"]}
    assert keys["Author"]["count"] == 2
    assert keys["Author"]["label"] == "Author"


def test_records_insert_point_after_a_pages_last_attribute(client):
    _seed_books(client)
    dune, emma = _records(client, "{and: [[Book]]}")["records"]
    # Dune's last `::` line is followed by its plain note; Emma's is last.
    assert dune["insert_before_order_idx"] == 3
    assert dune["last_attr_order_idx"] == 2
    assert emma["insert_before_order_idx"] is None
    assert emma["last_attr_order_idx"] == 2


def test_records_line_result(client):
    _ops(client,
         _line("some_paper", "Reading List", "Some Paper", 0),
         _line("sp_tags", "Reading List", "Tags:: #Preprint", 0,
               "some_paper"),
         _line("sp_local", "Reading List", "Local copy:: x", 1,
               "some_paper"))
    body = _records(client, "{and: [[Preprint]]}")

    assert body["total"] == 1
    [rec] = body["records"]
    assert rec["kind"] == "line"
    assert rec["row_title"] == "Some Paper"
    assert rec["uid"] == "some_paper"
    assert rec["key"] == "block:some_paper"
    assert rec["insert_parent_uid"] == "some_paper"
    assert rec["result_uids"] == ["sp_tags"]
    assert rec["page_title"] == "Reading List"
    assert rec["cells"]["Local copy"]["value"] == "x"
    assert rec["insert_before_order_idx"] is None
    assert rec["last_attr_order_idx"] == 1


def test_records_line_insert_point_before_the_sibling_after_its_attributes(
        client):
    _ops(client,
         _line("some_paper", "Reading List", "Some Paper", 0),
         _line("sp_tags", "Reading List", "Tags:: #Preprint", 0,
               "some_paper"),
         _line("sp_local", "Reading List", "Local copy:: x", 1,
               "some_paper"),
         _line("sp_notes", "Reading List", "my notes", 4, "some_paper"))
    [rec] = _records(client, "{and: [[Preprint]]}")["records"]
    assert rec["insert_before_order_idx"] == 4


def test_records_line_without_attributes_inserts_before_its_first_child(
        client):
    _ops(client,
         _line("an_idea", "Reading List", "An idea [[Preprint]]", 0),
         _line("idea_one", "Reading List", "first", 5, "an_idea"),
         _line("idea_two", "Reading List", "second", 7, "an_idea"))
    [rec] = _records(client, "{and: [[Preprint]]}")["records"]
    assert rec["kind"] == "line"
    assert rec["row_title"] == "An idea [[Preprint]]"
    assert rec["cells"] == {}
    assert rec["insert_before_order_idx"] == 5
    assert rec["last_attr_order_idx"] is None


def test_records_page_cells_are_top_level_attributes_only(client):
    _ops(client,
         _line("dune_tags", "Book/Dune", "Tags:: #Book", 0),
         _line("dune_part", "Book/Dune", "Part one", 1),
         _line("dune_fake", "Book/Dune", "Author:: Not a page cell", 0,
               "dune_part"))
    [rec] = _records(client, "{and: [[Book]]}")["records"]
    assert set(rec["cells"]) == {"Tags"}


def test_records_line_cells_are_direct_children_only(client):
    _ops(client,
         _line("some_paper", "Reading List", "Some Paper", 0),
         _line("sp_tags", "Reading List", "Tags:: #Preprint", 0,
               "some_paper"),
         _line("sp_local", "Reading List", "Local copy:: x", 1,
               "some_paper"),
         _line("sp_venue", "Reading List", "Venue:: a grandchild", 0,
               "sp_local"))
    [rec] = _records(client, "{and: [[Preprint]]}")["records"]
    assert set(rec["cells"]) == {"Tags", "Local copy"}
    assert rec["cells"]["Local copy"]["child_count"] == 1
    assert "child_count" not in rec["cells"]["Tags"]


def test_records_key_spelling_follows_page(client, seeded_config):
    _ops(client,
         _line("a_tags", "Book/A", "Tags:: #Novel", 0),
         _line("a_stat", "Book/A", "Reading status:: read", 1),
         _line("b_tags", "Book/B", "Tags:: #Novel", 0),
         _line("b_stat", "Book/B", "Reading Status:: unread", 1))
    body = _records(client, "{and: [[Novel]]}")

    db = open_db(seeded_config.db_path)
    try:
        lower = read_title(db, "Reading status")
        upper = read_title(db, "Reading Status")
    finally:
        db.close()
    keys = {k["key"]: k["count"] for k in body["keys"] if k["key"] != "Tags"}
    a, b = body["records"]
    if lower == upper:
        assert keys == {lower: 2}
    else:
        assert keys == {lower: 1, upper: 1}
    assert a["cells"][lower]["key_raw"] == "Reading status"
    assert b["cells"][upper]["key_raw"] == "Reading Status"


def _seed_paper(client) -> None:
    _ops(client,
         _line("some_paper", "Reading List", "Some Paper", 0),
         _line("sp_tags", "Reading List", "Tags:: #Preprint", 0,
               "some_paper"),
         _line("sp_local", "Reading List", "Local copy:: x", 1,
               "some_paper"))


@pytest.mark.parametrize("fetch,deleted", [
    ("_result_blocks", "sp_tags"),
    ("_lines", "some_paper"),
])
def test_records_read_one_snapshot(client, seeded_config, monkeypatch,
                                   fetch, deleted):
    """A sync write that deletes a result or its record between the
    route's statements must not reach half the payload: the read sees the
    graph as it was when the plan ran."""
    _seed_paper(client)
    before = _records(client, "{and: [[Preprint]]}")
    real = getattr(query_records_db, fetch)

    def racing(db, *args):
        other = open_db(seeded_config.db_path)
        try:
            other.execute("DELETE FROM blocks WHERE uid = ?", (deleted,))
            other.commit()
        finally:
            other.close()
        return real(db, *args)

    monkeypatch.setattr(query_records_db, fetch, racing)
    assert _records(client, "{and: [[Preprint]]}") == before


def test_records_bad_expr_400(client):
    r = client.get("/api/query/records", params={"expr": "{between: [[A]]}"})
    assert r.status_code == 400
    assert "between" in r.json()["detail"]


def test_page_insert_points(seeded_config):
    db = open_db(seeded_config.db_path)
    try:
        db.executemany(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " collapsed) VALUES (?,?,?,?,?,0)",
            [("ip_plain1", 5, None, 9, "plain"),
             ("ip_plain2", 5, None, 11, "plain")])
        db.commit()
        # The page has no top-level `::` line: a new one goes first.
        assert page_insert_points(db, [page_id_of(5)]) == \
            {page_id_of(5): order_idx_of(9)}
        assert page_insert_points(db, []) == {}
    finally:
        db.close()


def test_line_insert_points(seeded_config):
    db = open_db(seeded_config.db_path)
    try:
        db.executemany(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " collapsed) VALUES (?,?,?,?,?,0)",
            [("lp_parent", 5, None, 20, "parent"),
             ("lp_child1", 5, "lp_parent", 2, "first"),
             ("lp_child2", 5, "lp_parent", 4, "second"),
             ("lp_leaf01", 5, None, 21, "no children")])
        db.commit()
        assert line_insert_points(
            db, [uid_of("lp_parent"), uid_of("lp_leaf01")]) == \
            {uid_of("lp_parent"): order_idx_of(2)}
    finally:
        db.close()


def _seed_many(db, start: int, count: int) -> None:
    """`count` Book pages, each with a top-level `Tags:: #Book` and
    `Author::` line (a page record), and a plain `Notes` line whose child
    is `Tags:: #Book` (a line record), with the refs ops would derive."""
    pages, blocks, refs = [], [], []
    for i in range(start, start + count):
        pid = 10_000 + i
        pages.append((pid, f"Book/{i:05d}", None, None))
        tags, author = f"many_t{i:05d}", f"many_a{i:05d}"
        notes, note_tags = f"many_n{i:05d}", f"many_nt{i:05d}"
        blocks += [(tags, pid, None, 0, "Tags:: #Book"),
                   (author, pid, None, 1, f"Author:: A{i}"),
                   (notes, pid, None, 2, f"Notes {i}"),
                   (note_tags, pid, notes, 0, "Tags:: #Book")]
        refs += [(tags, 9_001, "attribute"), (tags, 9_002, "tag"),
                 (author, 9_003, "attribute"),
                 (note_tags, 9_001, "attribute"), (note_tags, 9_002, "tag")]
    db.executemany("INSERT INTO pages VALUES (?,?,?,?)", pages)
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " collapsed) VALUES (?,?,?,?,?,0)", blocks)
    db.executemany("INSERT INTO refs VALUES (?,?,?)", refs)
    db.commit()


def _counted(db, expr: str):
    statements: list[str] = []
    trace(db, statements.append)
    try:
        payload = query_records(expr=expr, db=db)
    finally:
        trace(db, None)
    return payload, len(statements)


def test_records_many(seeded_config):
    db = open_db(seeded_config.db_path)
    try:
        db.executemany("INSERT INTO pages VALUES (?,?,?,?)",
                       [(9_001, "Tags", None, None),
                        (9_002, "Book", None, None),
                        (9_003, "Author", None, None)])
        _seed_many(db, 0, 3)
        few, few_statements = _counted(db, "{and: [[Book]]}")
        _seed_many(db, 3, 597)
        many, many_statements = _counted(db, "{and: [[Book]]}")
    finally:
        db.close()

    assert few.total == 6
    assert many.total == 1200
    pages = [r for r in many.records if r.kind == "page"]
    lines = [r for r in many.records if r.kind == "line"]
    assert len(pages) == len(lines) == 600
    assert all(set(r.cells) == {"Tags", "Author"} for r in pages)
    assert all(set(r.cells) == {"Tags"} for r in lines)
    assert all(r.insert_before_order_idx == 2 for r in pages)
    assert [(k.key, k.count) for k in many.keys] == \
        [("Tags", 1200), ("Author", 600)]
    # Past CHUNK_SIZE (500) each chunked fetch runs one more chunk per 500
    # ids: the 1200 results two more, and the 600 pages and 600 lines one
    # more each for their `::` lines, insert points and (lines) holders.
    # Nothing else grows.
    assert many_statements == few_statements + 2 + 2 + 3


def _plain_query_groups(client, expr: str) -> list[dict]:
    r = client.get("/api/query", params={"expr": expr})
    assert r.status_code == 200, r.text
    return r.json()["groups"]


def test_records_without_cells_carry_the_query_groups(client):
    """No record has a `::` cell, so the web defaults to the blocks view:
    the records answer carries what `/api/query` would, and that view takes
    one request."""
    _ops(client,
         _line("todo_a", "Page A", "first #Topic", 0),
         _line("todo_b", "Page B", "second #Topic", 0),
         _line("todo_c", "Page B", "nested #Topic third", 1, "todo_b"))
    expr = "{and: [[Topic]]}"
    body = _records(client, expr)

    assert all(not rec["cells"] for rec in body["records"])
    assert body["groups"]
    assert body["groups"] == _plain_query_groups(client, expr)


def test_records_with_no_results_carry_empty_groups(client):
    """An empty list, not an absent field: nothing matched, so no record
    has cells and the blocks view is the default."""
    body = _records(client, "{and: [[Nothing Matches This]]}")
    assert body["records"] == []
    assert body["groups"] == []


def test_records_with_cells_carry_no_groups(client):
    _seed_books(client)
    body = _records(client, "{and: [[Book]]}")
    assert any(rec["cells"] for rec in body["records"])
    assert body["groups"] is None


def test_records_groups_come_from_the_records_snapshot(client, seeded_config,
                                                       monkeypatch):
    """A write landing between the records read and the groups read must
    not leave the groups showing a result the records lack."""
    _ops(client, _line("todo_a", "Page A", "first #Topic", 0))
    before = _records(client, "{and: [[Topic]]}")
    real = query_records_db._result_blocks

    def racing(db, *args):
        other = open_db(seeded_config.db_path)
        try:
            other.execute("DELETE FROM blocks WHERE uid = ?", ("todo_a",))
            other.commit()
        finally:
            other.close()
        return real(db, *args)

    monkeypatch.setattr(query_records_db, "_result_blocks", racing)
    assert _records(client, "{and: [[Topic]]}") == before
