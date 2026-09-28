"""batch_id dedup: a committed-but-unacknowledged batch retried by the
durable client queue must not double-apply (spec section 1)."""

BATCH = {
    "client_id": "c1",
    "batch_id": "batch-0001-aaaa",
    "ops": [{"op": "create", "uid": "uid_idem1", "page_title": "AI",
             "parent_uid": None, "order_idx": 0, "text": "queued offline"}],
}


def test_replay_returns_stored_ack_and_applies_nothing(client):
    r1 = client.post("/api/ops", json=BATCH)
    assert r1.status_code == 200
    r2 = client.post("/api/ops", json=BATCH)  # retry after lost ack
    assert r2.status_code == 200
    assert r2.json() == r1.json()
    # the create ran once: a second application would 400 (uid exists),
    # and the block must exist exactly once
    page = client.get("/api/page/AI").json()
    uids = [b["uid"] for b in page["blocks"]]
    assert uids.count("uid_idem1") == 1


def test_same_batch_id_different_ops_is_rejected(client):
    r1 = client.post("/api/ops", json=BATCH)
    assert r1.status_code == 200
    evil = dict(BATCH, ops=[{"op": "update_text", "uid": "uid_b1",
                             "text": "different payload"}])
    r2 = client.post("/api/ops", json=evil)
    assert r2.status_code == 409


def test_batch_without_batch_id_is_rejected(client):
    """Id-less batches dedupe nowhere, so replays re-apply; the server now
    rejects them outright (2026-07-22 incident, bean pkm-ri5b)."""
    body = {"client_id": "c1", "ops": [
        {"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]}
    assert client.post("/api/ops", json=body).status_code == 422


def test_rejected_batch_is_not_recorded(client):
    bad = {"client_id": "c1", "batch_id": "batch-0002-bbbb",
           "ops": [{"op": "move", "uid": "uid_b2", "parent_uid": "uid_b3",
                    "order_idx": 0}]}  # a cycle: still a 400
    assert client.post("/api/ops", json=bad).status_code == 400
    # the same batch_id with a now-valid payload must not be poisoned
    ok = {"client_id": "c1", "batch_id": "batch-0002-bbbb",
          "ops": [{"op": "update_text", "uid": "uid_b1", "text": "fixed"}]}
    assert client.post("/api/ops", json=ok).status_code == 200


def test_conflicting_batch_id_409_detail_shape_matches_400(client):
    """pkm-x7a5: both op-route error responses carry a dict detail with a
    'reason' key, so clients parse one shape."""
    r1 = client.post("/api/ops", json=BATCH)
    assert r1.status_code == 200
    evil = dict(BATCH, ops=[{"op": "update_text", "uid": "uid_b1",
                             "text": "different payload"}])
    r2 = client.post("/api/ops", json=evil)
    assert r2.status_code == 409
    detail = r2.json()["detail"]
    assert detail["reason"].startswith("batch_id")
    assert detail["index"] is None


def test_batch_id_insert_race_serves_winner_ack_and_rolls_back(client,
                                                               monkeypatch):
    """pkm-x7a5 item 5: the applied_batches IntegrityError branch. A
    concurrent submission of the same batch_id commits between this
    request's dedup SELECT and its INSERT: the loser rolls back its own
    effects and returns the winner's stored acknowledgement."""
    import json

    from pkm.server import routes_ops
    from pkm.server.db import open_db
    from pkm.server.ops_core import batch_request_hash

    real = routes_ops.apply_batch
    winner_ack = {"ok": True, "ts": 1, "applied": 99}

    def racing(db, batch, now):
        # the winner commits first, on its own connection, before the
        # loser's write transaction starts
        con = open_db(client.app.state.config.db_path)
        con.execute("INSERT INTO applied_batches VALUES (?,?,?,?)",
                    (batch.batch_id, batch_request_hash(batch),
                     json.dumps(winner_ack), 1))
        con.commit()
        con.close()
        return real(db, batch, now)

    monkeypatch.setattr(routes_ops, "apply_batch", racing)
    r = client.post("/api/ops", json=BATCH)
    assert r.status_code == 200
    assert r.json() == winner_ack  # stored ack, not this request's own
    # the loser's effects were rolled back: the block does not exist
    monkeypatch.setattr(routes_ops, "apply_batch", real)
    page = client.get("/api/page/AI").json()
    assert "uid_idem1" not in {b["uid"] for b in page["blocks"]}


def _journal_max(client) -> int:
    return client.get("/api/sync/changes?since=0&limit=1").json()["latest_seq"]


def test_ack_carries_the_journal_seq_that_includes_the_batch(client):
    """pkm-ur2n: the ack names the journal max as of the batch's own commit,
    so a replica can tell a sync window that already carries the batch
    (latest_seq >= ack seq) from one that might predate it."""
    before = _journal_max(client)
    ack = client.post("/api/ops", json=BATCH).json()
    after = _journal_max(client)
    assert after > before  # the batch journalled rows
    assert ack["seq"] == after
    # a later batch moves the journal on; the replayed ack still names the
    # seq of the original commit, verbatim
    other = {"client_id": "c1", "batch_id": "batch-0003-cccc",
             "ops": [{"op": "update_text", "uid": "uid_b1", "text": "later"}]}
    assert client.post("/api/ops", json=other).json()["seq"] > after
    assert client.post("/api/ops", json=BATCH).json()["seq"] == after


def _request_hash(ops) -> str:
    from pkm.contracts.ops import OpBatch
    from pkm.server.ops_core import batch_request_hash
    return batch_request_hash(OpBatch.model_validate(
        {"client_id": "c1", "batch_id": "batch-gold-0001", "ops": ops}))


HINTLESS = [{"op": "update_text", "uid": "uid_b1", "text": "golden",
             "base_text_hash": "0" * 64}]


def test_hintless_update_text_hash_is_unchanged_across_deploys():
    """applied_batches stores this hash, so a batch committed before a
    deploy and retried after it must hash the same or it 409s. Both values
    were computed with the code before page_title existed (770af38)."""
    assert _request_hash(HINTLESS) == (
        "dad8c889b2956a264f6eb8a10486d50ed0e6d9314b294fdd813988d828cf9e14")
    hashless = [{"op": "update_text", "uid": "uid_b1", "text": "golden"}]
    assert _request_hash(hashless) == (
        "06914b5c0599a33509bbc46f3da86a3e3e931924fdf6121c976738960b28fac1")


def test_page_title_hint_is_part_of_the_request_hash():
    hinted = [dict(HINTLESS[0], page_title="AI")]
    assert _request_hash(hinted) != _request_hash(HINTLESS)


# pkm-95ss: base_text_hash and page_title are guard/label metadata the
# worker may fill into a durable copy of a batch and not the in-memory
# fallback-lane copy of the same batch_id (a lost enqueue reply). They
# never change which op is applied, so the replay hash must ignore them
# while the strict request hash above stays pinned unchanged.
def _replay_hash(ops) -> str:
    from pkm.contracts.ops import OpBatch
    from pkm.server.ops_core import batch_replay_hash
    return batch_replay_hash(OpBatch.model_validate(
        {"client_id": "c1", "batch_id": "batch-gold-0001", "ops": ops}))


def test_replay_hash_ignores_worker_filled_guard_fields():
    bare = [{"op": "update_text", "uid": "uid_b1", "text": "golden"}]
    hashed = [dict(bare[0], base_text_hash="0" * 64)]
    hashed_and_titled = [dict(hashed[0], page_title="AI")]
    assert (_replay_hash(bare) == _replay_hash(hashed)
            == _replay_hash(hashed_and_titled))


def test_replay_hash_still_differs_for_a_genuinely_different_batch():
    base = [{"op": "update_text", "uid": "uid_b1", "text": "golden"}]
    base_hash = _replay_hash(base)
    assert _replay_hash(
        [{"op": "update_text", "uid": "uid_b1", "text": "other"}]
    ) != base_hash
    assert _replay_hash(
        [{"op": "update_text", "uid": "uid_b2", "text": "golden"}]
    ) != base_hash
    assert _replay_hash(
        [{"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]
    ) != base_hash
    assert _replay_hash(
        base + [{"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]
    ) != base_hash


def test_worker_filled_then_bare_replays_with_one_effect(client):
    """(a) post a batch without base_text_hash/page_title, then the same
    batch_id with them filled in -> 200, the stored ack, no second effect
    (pkm-95ss)."""
    bare = {"client_id": "c1", "batch_id": "batch-95ss-0001",
           "ops": [{"op": "update_text", "uid": "uid_b1", "text": "v1"}]}
    r1 = client.post("/api/ops", json=bare)
    assert r1.status_code == 200
    filled = dict(bare, ops=[dict(bare["ops"][0], base_text_hash="0" * 64,
                                 page_title="AI")])
    r2 = client.post("/api/ops", json=filled)
    assert r2.status_code == 200
    assert r2.json() == r1.json()  # replayed ack, same seq: no second apply


def test_bare_then_worker_filled_replays_with_one_effect(client):
    """(b) the reverse order: the worker-filled (hashed + titled) copy lands
    first, the original bare copy retries under the same batch_id."""
    from pkm.contracts.ops import text_hash

    filled = {"client_id": "c1", "batch_id": "batch-95ss-0002",
             "ops": [{"op": "update_text", "uid": "uid_b1", "text": "v1",
                      "base_text_hash": text_hash("Tags:: #AI"),
                      "page_title": "AI"}]}
    r1 = client.post("/api/ops", json=filled)
    assert r1.status_code == 200
    bare = dict(filled, ops=[{"op": "update_text", "uid": "uid_b1",
                              "text": "v1"}])
    r2 = client.post("/api/ops", json=bare)
    assert r2.status_code == 200
    assert r2.json() == r1.json()


def test_genuinely_different_payload_still_409s_with_guard_fields(client):
    """(c) a real payload change under the same batch_id must still be
    rejected, even once base_text_hash/page_title are in play."""
    filled = {"client_id": "c1", "batch_id": "batch-95ss-0003",
             "ops": [{"op": "update_text", "uid": "uid_b1", "text": "v1",
                      "base_text_hash": "0" * 64, "page_title": "AI"}]}
    r1 = client.post("/api/ops", json=filled)
    assert r1.status_code == 200
    different = dict(filled, ops=[dict(filled["ops"][0], text="v2")])
    r2 = client.post("/api/ops", json=different)
    assert r2.status_code == 409


def test_pre_deploy_strict_hash_row_still_replays_and_still_409s(client):
    """(d) an applied_batches row written before this change stores the
    strict batch_request_hash. A retry of the identical batch must still
    replay it, and a different payload under the same id must still 409."""
    import json as jsonlib

    from pkm.server.db import open_db
    from pkm.contracts.ops import OpBatch
    from pkm.server.ops_core import batch_request_hash

    batch = {"client_id": "c1", "batch_id": "batch-95ss-0004",
            "ops": [{"op": "update_text", "uid": "uid_b1", "text": "v1"}]}
    strict = batch_request_hash(OpBatch.model_validate(batch))
    ack = {"ok": True, "ts": 1, "applied": 1, "seq": 0}
    con = open_db(client.app.state.config.db_path)
    con.execute("INSERT INTO applied_batches VALUES (?,?,?,?)",
                (batch["batch_id"], strict, jsonlib.dumps(ack), 1))
    con.commit()
    con.close()

    r_same = client.post("/api/ops", json=batch)
    assert r_same.status_code == 200
    assert r_same.json() == ack  # the pre-deploy row's own stored ack

    different = dict(batch, ops=[dict(batch["ops"][0], text="v2")])
    r_diff = client.post("/api/ops", json=different)
    assert r_diff.status_code == 409
