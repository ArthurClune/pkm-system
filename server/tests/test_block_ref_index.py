"""pkm-d31f: block_refs stays current through every text write path."""
from pkm.server.db import open_db


def _rows(config) -> set[tuple[str, str]]:
    con = open_db(config.db_path)
    try:
        # open_db sets row_factory = sqlite3.Row, which does not compare
        # equal to plain tuples in a set -- cast explicitly.
        return {tuple(row) for row in con.execute(
            "SELECT src_block_uid, target_block_uid FROM block_refs")}
    finally:
        con.close()


def _post_ops(client, ops, batch_id):
    r = client.post("/api/ops", json={
        "client_id": "t-d31f", "batch_id": batch_id, "ops": ops})
    assert r.status_code == 200, r.text
    return r


def test_create_indexes_block_refs(client, seeded_config):
    _post_ops(client, [{
        "op": "create", "uid": "uid_new01", "page_title": "AI",
        "parent_uid": None, "order_idx": 5,
        "text": "see ((uid_b3)) and ((uid_b3)) twice, plus ((uid_b1))",
    }], "batch_d31f01")
    assert {("uid_new01", "uid_b3"), ("uid_new01", "uid_b1")} <= _rows(seeded_config)
    # duplicate mentions collapse to one row (count = referencing blocks)
    assert len([r for r in _rows(seeded_config) if r[0] == "uid_new01"]) == 2


def test_update_text_replaces_block_refs(client, seeded_config):
    _post_ops(client, [{"op": "update_text", "uid": "uid_b5",
                        "text": "now points at ((uid_b1))"}], "batch_d31f02")
    rows = _rows(seeded_config)
    assert ("uid_b5", "uid_b1") in rows
    assert ("uid_b5", "uid_b3") not in rows


def test_delete_block_cascades_block_refs(client, seeded_config):
    _post_ops(client, [{"op": "delete", "uid": "uid_b5"}], "batch_d31f03")
    assert all(src != "uid_b5" for src, _ in _rows(seeded_config))


def test_rename_rewrite_preserves_block_refs(client, seeded_config):
    # uid_b3's text holds [[Paper]]; renaming Paper rewrites uid_b3's text.
    # uid_b5 -> uid_b3 must survive, and uid_b3's own outgoing rows (none)
    # must be re-derived from the rewritten text without error.
    r = client.post("/api/page/Paper/rename",
                    json={"new_title": "Papers Renamed"})
    assert r.status_code == 200, r.text
    assert ("uid_b5", "uid_b3") in _rows(seeded_config)
