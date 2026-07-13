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


def test_batch_without_batch_id_behaves_as_today(client):
    body = {"client_id": "c1", "ops": [
        {"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]}
    assert client.post("/api/ops", json=body).status_code == 200
    # replaying WITHOUT batch_id re-applies (idempotent op, still 200):
    assert client.post("/api/ops", json=body).status_code == 200


def test_rejected_batch_is_not_recorded(client):
    bad = {"client_id": "c1", "batch_id": "batch-0002-bbbb",
           "ops": [{"op": "update_text", "uid": "no_such_uid", "text": "x"}]}
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
