"""Rewrites the server makes itself -- rename, merge, the title migration,
the copies a page delete inlines and the tokens an asset delete strips --
judge the text they would store, and refuse rather than store a block over
the length cap or nested past the `[[` cap."""
from __future__ import annotations

import pytest
from rawread import read

from pkm import unlink
from pkm.assets_core import strip_asset_tokens
from pkm.contracts.ops import BlockUid
from pkm.contracts.responses import BLOCKER_EXCERPT_CHARS
from pkm.server.db import open_db
from pkm.server.store import reindex_refs_for_text
from pkm.test_data.ids import sha_of, uid_of
from pkm.text_limits import TextLimitViolation, rewrite_text_limit_violation

SRC_BLOCK_1 = uid_of("src_block_1")
TGT_BLOCK_1 = uid_of("tgt_block_1")
DEL_TARGET1 = uid_of("del_target1")
DEL_SOURCE1 = uid_of("del_source1")
ASSET_NEST1 = uid_of("asset_nest1")
LONG_TITLE = "A Twenty Char Title!"
assert len(LONG_TITLE) == 20


def nest(depth: int) -> str:
    """`depth` runs that are no refs, so the title guard passes them."""
    return "[[a//" * depth + "x" + "]]" * depth


def test_a_rewrite_within_the_limits_is_stored():
    assert rewrite_text_limit_violation("[[Old]]", "[[New title]]") is None


def test_a_rewrite_that_crosses_a_limit_is_refused():
    assert rewrite_text_limit_violation("y", "y" * 1_000_001) == \
        TextLimitViolation("length", 1_000_001, 1_000_000)
    assert rewrite_text_limit_violation(nest(32), nest(33)) == \
        TextLimitViolation("nesting", 33, 32)


def test_a_rewrite_of_a_row_already_over_a_limit_may_not_worsen_it():
    long_row = "y" * 1_000_005
    assert rewrite_text_limit_violation(long_row, long_row[:-1]) is None
    assert rewrite_text_limit_violation(long_row, long_row + "y") == \
        TextLimitViolation("length", 1_000_006, 1_000_000)
    assert rewrite_text_limit_violation(nest(40), nest(40) + " ") is None
    assert rewrite_text_limit_violation(nest(40), nest(39)) is None
    assert rewrite_text_limit_violation(nest(40), nest(41)) == \
        TextLimitViolation("nesting", 41, 32)
    # Over length before, within it after: its nesting is what is compared.
    assert rewrite_text_limit_violation(nest(40) + long_row,
                                        nest(40)) is None
    assert rewrite_text_limit_violation(nest(33) + long_row,
                                        nest(40)) == \
        TextLimitViolation("nesting", 40, 32)


def test_a_rewrite_judges_each_limit_on_its_own():
    # An asset strip on a legacy row over the length cap: the length falls,
    # but the stripped tokens join `[` + `[` into a nest 200 deep. (Few
    # tokens: the strip is quadratic in them.)
    sha = sha_of("ab" * 32)
    padding = "y" * 1_000_000
    before = (("[" + f"![p](/assets/{sha}/p.png)" + "[a//") * 200
              + "x" + "]]" * 200 + padding)
    assert len(before) > 1_010_000
    after = strip_asset_tokens(before, sha)
    assert after == nest(200) + padding
    assert rewrite_text_limit_violation(before, after) == \
        TextLimitViolation("nesting", 200, 32)


def test_a_rewrite_of_equal_length_may_not_deepen_past_the_cap():
    padding = "y" * 1_000_000
    before = "[Q[a//" * 40 + "x" + "]]" * 40 + padding
    after = "Q[[a//" * 40 + "x" + "]]" * 40 + padding
    assert len(after) == len(before)
    assert rewrite_text_limit_violation(before, after) == \
        TextLimitViolation("nesting", 40, 32)


def test_a_rewrite_that_shrinks_both_limits_is_stored():
    assert rewrite_text_limit_violation(
        nest(40) + "y" * 1_000_005, nest(39) + "y" * 1_000_000) is None


def _page_id(con, page: str) -> int:
    row = con.select_one("SELECT id AS page_id FROM pages WHERE title = ?",
                         (page,))
    if row is not None:
        return row["page_id"]
    con.execute("INSERT INTO pages(title, created_at, updated_at)"
                " VALUES (?, 0, 0)", (page,))
    return _page_id(con, page)


def _seed(config, blocks: list[tuple[BlockUid, str, str]],
          pages: tuple[str, ...] = ()) -> None:
    """Straight to the tables: `(uid, page title, text)` per block."""
    con = open_db(config.db_path)
    try:
        for page in pages:
            _page_id(con, page)
        for order, (uid, page, text) in enumerate(blocks):
            con.execute(
                "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
                " collapsed) VALUES (?,?,NULL,?,?,0)",
                (uid, _page_id(con, page), order, text))
            reindex_refs_for_text(con, uid, text, 0)
        con.commit()
    finally:
        con.close()


def _scalar(config, sql: str, params: tuple[object, ...] = ()) -> object:
    con = open_db(config.db_path)
    try:
        row = read(con, sql, params).fetchone()
        return None if row is None else row[0]
    finally:
        con.close()


def _text(config, uid: BlockUid) -> object:
    return _scalar(config, "SELECT text AS t FROM blocks WHERE uid = ?",
                   (uid,))


def _rewrite_rows(config) -> object:
    return _scalar(config, "SELECT count(*) AS n FROM block_rewrites")


def _page_exists(config, page: str) -> bool:
    return _scalar(config, "SELECT 1 AS one FROM pages WHERE title = ?",
                   (page,)) is not None


def test_rename_that_grows_a_block_past_the_cap_is_refused(
        client, seeded_config):
    text = "[[Old]] " * 125_000
    assert len(text) == 1_000_000
    _seed(seeded_config, [(SRC_BLOCK_1, "Src", text)], pages=("Old",))
    rewrites = _rewrite_rows(seeded_config)
    r = client.post("/api/page/Old/rename", json={"new_title": LONG_TITLE})
    assert r.status_code == 422, r.text
    assert r.json()["detail"].startswith(
        f"rename refused: block {SRC_BLOCK_1} on 'Src': text of ")
    assert _page_exists(seeded_config, "Old")
    assert not _page_exists(seeded_config, LONG_TITLE)
    assert _text(seeded_config, SRC_BLOCK_1) == text
    assert _rewrite_rows(seeded_config) == rewrites


def test_merge_that_grows_a_block_past_the_cap_is_refused(
        client, seeded_config):
    text = "[[Old]] " * 125_000
    _seed(seeded_config, [(SRC_BLOCK_1, "Src", text),
                          (TGT_BLOCK_1, LONG_TITLE, "target block")],
          pages=("Old",))
    rewrites = _rewrite_rows(seeded_config)
    r = client.post("/api/page/Old/rename",
                    json={"new_title": LONG_TITLE, "allow_merge": True})
    assert r.status_code == 422, r.text
    assert r.json()["detail"].startswith(
        f"rename refused: block {SRC_BLOCK_1} on 'Src': text of ")
    assert _page_exists(seeded_config, "Old")
    assert _text(seeded_config, SRC_BLOCK_1) == text
    assert _scalar(
        seeded_config,
        "SELECT count(*) AS n FROM blocks b JOIN pages p ON p.id = b.page_id"
        " WHERE p.title = ?", (LONG_TITLE,)) == 1
    assert _rewrite_rows(seeded_config) == rewrites


def test_rename_within_the_cap_still_rewrites(client, seeded_config):
    _seed(seeded_config, [(SRC_BLOCK_1, "Src", "[[Old]] " * 1_000)],
          pages=("Old",))
    r = client.post("/api/page/Old/rename", json={"new_title": LONG_TITLE})
    assert r.status_code == 200, r.text
    assert _text(seeded_config, SRC_BLOCK_1) == f"[[{LONG_TITLE}]] " * 1_000
    assert not _page_exists(seeded_config, "Old")


def _assert_delete_blocked(client, config, source_text: str,
                           page: str = "P") -> None:
    preview = client.get("/api/delete-preview", params={"title": page})
    assert preview.status_code == 200, preview.text
    blocker = {"uid": DEL_SOURCE1, "page_title": "Src",
               "excerpt": source_text[:BLOCKER_EXCERPT_CHARS],
               "text_length": len(source_text),
               "reason": "limit"}
    assert preview.json()["blockers"] == [blocker]
    r = client.delete(f"/api/page/{page}")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["blockers"] == [blocker]
    assert _page_exists(config, page)
    assert _text(config, DEL_SOURCE1) == source_text


def test_delete_inlining_past_the_cap_is_blocked(client, seeded_config):
    source = f"(({DEL_TARGET1})) (({DEL_TARGET1}))"
    _seed(seeded_config, [(DEL_TARGET1, "P", "y" * 600_000),
                          (DEL_SOURCE1, "Src", source)])
    _assert_delete_blocked(client, seeded_config, source)
    assert _text(seeded_config, DEL_TARGET1) == "y" * 600_000


def test_delete_preview_reports_a_projected_limit_without_building_it(
        client, seeded_config):
    # 100 refs to a 200,000-character block: the copies would come to
    # 20M characters, which the judge projects rather than builds.
    source = " ".join([f"(({DEL_TARGET1}))"] * 100)
    _seed(seeded_config, [(DEL_TARGET1, "T", "x" * 200_000),
                          (DEL_SOURCE1, "Src", source)])
    _assert_delete_blocked(client, seeded_config, source, page="T")
    assert _text(seeded_config, DEL_TARGET1) == "x" * 200_000


def test_a_delete_past_its_copy_budget_is_blocked(
        client, seeded_config, monkeypatch):
    # Each referrer is within the cap alone; together they count more copy
    # text than the delete may build.
    monkeypatch.setattr(unlink, "MAX_DELETE_COPY_CHARS", 1_000)
    others = [uid_of("del_source2")]
    _seed(seeded_config, [(DEL_TARGET1, "T", "y" * 600),
                          (DEL_SOURCE1, "Src", f"(({DEL_TARGET1}))"),
                          (others[0], "Src", f"(({DEL_TARGET1}))")])
    preview = client.get("/api/delete-preview", params={"title": "T"})
    assert preview.status_code == 200, preview.text
    blockers = preview.json()["blockers"]
    assert [b["reason"] for b in blockers] == ["limit"]
    assert blockers[0]["uid"] in (DEL_SOURCE1, others[0])
    r = client.delete("/api/page/T")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["blockers"] == blockers
    assert _page_exists(seeded_config, "T")
    assert _text(seeded_config, DEL_SOURCE1) == f"(({DEL_TARGET1}))"


def test_delete_inlining_past_the_nesting_limit_is_blocked(
        client, seeded_config):
    source = "[[a//" * 20 + f"(({DEL_TARGET1}))" + "]]" * 20
    _seed(seeded_config, [(DEL_TARGET1, "P", nest(20)),
                          (DEL_SOURCE1, "Src", source)])
    _assert_delete_blocked(client, seeded_config, source)


def test_title_migration_maps_the_error(client, seeded_config, monkeypatch):
    _seed(seeded_config, [(SRC_BLOCK_1, "Src", "see [[ Acme]]")],
          pages=("Acme", " Acme"))
    audit = client.get("/api/migrations/title-canonicalization")
    assert audit.status_code == 200, audit.text
    over = TextLimitViolation("length", 1_000_001, 1_000_000)
    monkeypatch.setattr(
        "pkm.server.store.rewrite_text_limit_violation",
        lambda before, after: over if after == "see [[Acme]]" else None)
    r = client.post("/api/migrations/title-canonicalization",
                    json={"audit_digest": audit.json()["digest"]})
    assert r.status_code == 409, r.text
    assert r.json()["detail"].startswith("title migration refused: block ")
    assert _text(seeded_config, SRC_BLOCK_1) == "see [[ Acme]]"
    assert _page_exists(seeded_config, " Acme")


@pytest.fixture()
def asset(client):
    r = client.post("/api/assets",
                    files={"file": ("pic.png", b"PNGDATA", "image/png")})
    assert r.status_code == 200, r.text
    return r.json()


def test_asset_delete_that_would_nest_a_block_past_the_cap_is_refused(
        client, seeded_config, asset):
    # Each `[` + token + `[a//` reads at depth 0; with the token gone the
    # two brackets join, and the block nests 40 deep.
    text = ("[" + f"![p]({asset['url']})" + "[a//") * 40 + "x" + "]]" * 40
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": "batch-asset-nest",
        "ops": [{"op": "create", "uid": ASSET_NEST1, "page_title": "Src",
                 "parent_uid": None, "order_idx": 0, "text": text}]})
    assert r.status_code == 200, r.text
    r = client.delete(f"/api/assets/{asset['sha256']}")
    assert r.status_code == 409, r.text
    # The refusal carries an excerpt and the whole text's length, not text
    # up to a million characters per blocked block.
    assert len(text) > 200
    assert r.json()["detail"]["blockers"] == [
        {"uid": ASSET_NEST1, "page_title": "Src", "excerpt": text[:200],
         "text_length": len(text), "reason": "limit"}]
    assert _text(seeded_config, ASSET_NEST1) == text
    sha = asset["sha256"]
    assert _scalar(seeded_config,
                   "SELECT 1 AS one FROM assets WHERE sha256 = ?",
                   (sha,)) == 1
    assert (seeded_config.assets_dir / sha[:2] / sha).is_file()


def test_asset_delete_within_the_cap_still_strips(
        client, seeded_config, asset):
    text = ("[" + f"![p]({asset['url']})" + "[a//") * 3 + "x" + "]]" * 3
    r = client.post("/api/ops", json={
        "client_id": "test", "batch_id": "batch-asset-shallow",
        "ops": [{"op": "create", "uid": ASSET_NEST1, "page_title": "Src",
                 "parent_uid": None, "order_idx": 0, "text": text}]})
    assert r.status_code == 200, r.text
    r = client.delete(f"/api/assets/{asset['sha256']}")
    assert r.status_code == 200, r.text
    assert _text(seeded_config, ASSET_NEST1) == nest(3)
