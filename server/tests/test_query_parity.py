"""Parity between the two surfaces that execute a query plan: the live
/api/query endpoint (routes_search) and the resolved single-page markdown
export's {{query: ...}} macros (routes_export). Both run the same plan over
the same graph here, so the source-block exclusion, the total count and the
page/uid ordering must agree -- these tests pin that agreement against the
two executions drifting apart again.
"""
from app_seed import seeded_client

# "Zulu Page" is page 3 and "Alpha Page" page 4, so results ordered by page
# title cannot be mistaken for results ordered by page id or insertion order.
_PAGES = [(1, "Source", None, None), (2, "Tag", None, None),
          (3, "Zulu Page", None, None), (4, "Alpha Page", None, None)]
# uid_src and uid_z3 both reference [[Tag]] and both are query macros, so
# both must be excluded from the results (bare and [[bracketed]] variants).
_BLOCKS = [
    ("uid_src", 1, None, 0, "{{query: {and: [[Tag]]}}}", None, 0, None, None),
    ("uid_z1", 3, None, 0, "zulu first #Tag", None, 0, None, None),
    ("uid_z2", 3, None, 1, "zulu second #Tag", None, 0, None, None),
    ("uid_z3", 3, None, 2, "{{[[query]]: {and: [[Tag]]}}}", None, 0, None, None),
    ("uid_a1", 4, None, 0, "alpha only #Tag", None, 0, None, None),
]
_REFS = [(uid, 2, "tag") for uid, *_ in _BLOCKS]
_EXPR = "{and: [[Tag]]}"


def _client(tmp_path):
    return seeded_client(tmp_path, _PAGES, _BLOCKS, _REFS)


def test_query_endpoint_groups_by_page_title_excluding_source_blocks(tmp_path):
    r = _client(tmp_path).get("/api/query", params={"expr": _EXPR})
    assert r.status_code == 200
    body = r.json()

    assert body["total"] == 3  # five referencing blocks, two of them macros
    assert body["ref_counts"] == {"Tag": 3}
    assert [(g["page_id"], g["page_title"], [i["uid"] for i in g["items"]])
            for g in body["groups"]] == [
        (4, "Alpha Page", ["uid_a1"]),
        (3, "Zulu Page", ["uid_z1", "uid_z2"]),
    ]
    assert [i["text"] for g in body["groups"] for i in g["items"]] == [
        "alpha only #Tag", "zulu first #Tag", "zulu second #Tag"]


def test_export_resolves_the_query_to_the_same_total_groups_and_order(tmp_path):
    tc = _client(tmp_path)
    query_r = tc.get("/api/query", params={"expr": _EXPR})
    assert query_r.status_code == 200
    body = query_r.json()

    export_r = tc.get("/api/export/page/Source")
    assert export_r.status_code == 200
    md = export_r.text

    assert md == (
        "# Source\n"
        "\n"
        f"- Query: {_EXPR} — {body['total']} results\n"
        "  - Alpha Page\n"
        "    - alpha only #Tag\n"
        "  - Zulu Page\n"
        "    - zulu first #Tag\n"
        "    - zulu second #Tag\n"
    )


def test_export_query_excludes_the_same_source_blocks_as_the_endpoint(tmp_path):
    tc = _client(tmp_path)
    query_r = tc.get("/api/query", params={"expr": _EXPR})
    assert query_r.status_code == 200
    body = query_r.json()
    uids = {i["uid"] for g in body["groups"] for i in g["items"]}

    export_r = tc.get("/api/export/page/Source")
    assert export_r.status_code == 200
    md = export_r.text

    assert uids == {"uid_a1", "uid_z1", "uid_z2"}
    # The excluded macros never render, in either surface: neither the
    # source block's own text nor the [[bracketed]] one on a result page.
    assert "{{query:" not in md
    assert "{{[[query]]:" not in md
