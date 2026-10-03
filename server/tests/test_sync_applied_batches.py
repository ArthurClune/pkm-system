"""The changes feed and the snapshot name which of the client's pending
batches (the repeated `pending` query param) they already hold: the ids
found in applied_batches, each with its stored ack's seq and skipped list,
read in the same read transaction that hydrates the payload."""
import json
import sqlite3

from pkm.server.db import open_db
from pkm.server.routes_sync import sync_changes, sync_snapshot


def _post(client, batch_id, ops):
    r = client.post("/api/ops", json={"client_id": "c1", "batch_id": batch_id,
                                      "ops": ops})
    assert r.status_code == 200
    return r.json()


def _latest(client):
    return client.get("/api/sync/changes?since=0").json()["latest_seq"]


def test_changes_name_the_pending_batches_already_applied(client):
    start = _latest(client)
    ack = _post(client, "applied_one",
                [{"op": "update_text", "uid": "uid_b1", "text": "x"}])
    r = client.get(f"/api/sync/changes?since={start}"
                   "&pending=applied_one&pending=never_posted")
    assert r.status_code == 200
    assert r.json()["applied_batches"] == [
        {"batch_id": "applied_one", "seq": ack["seq"], "skipped": []}]


def test_snapshot_names_the_pending_batches_already_applied(client):
    ack = _post(client, "applied_snap",
                [{"op": "update_text", "uid": "uid_b1", "text": "y"}])
    r = client.get("/api/sync/snapshot?pending=never_posted&pending=applied_snap")
    assert r.status_code == 200
    assert r.json()["applied_batches"] == [
        {"batch_id": "applied_snap", "seq": ack["seq"], "skipped": []}]


def test_a_named_batch_carries_its_stored_skipped_ops(client):
    ack = _post(client, "skips_one",
                [{"op": "update_text", "uid": "ghost_uid", "text": "z"}])
    assert ack["skipped"] != []
    feed = client.get("/api/sync/changes?since=0&pending=skips_one").json()
    assert feed["applied_batches"] == [
        {"batch_id": "skips_one", "seq": ack["seq"], "skipped": ack["skipped"]}]


def test_an_ack_stored_before_seq_and_skipped_existed_reads_as_unknown(
        seeded_config, client):
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO applied_batches VALUES (?,?,?,?)",
                ("old_ack_row", "h", json.dumps(
                    {"ok": True, "ts": 1, "applied": 1}), 1))
    con.commit()
    con.close()
    feed = client.get("/api/sync/changes?since=0&pending=old_ack_row").json()
    assert feed["applied_batches"] == [
        {"batch_id": "old_ack_row", "seq": None, "skipped": []}]


def test_no_pending_param_leaves_the_field_out(client):
    # the payload is the one a server without the field sent, byte for byte
    _post(client, "never_asked", [{"op": "update_text", "uid": "uid_b1", "text": "w"}])
    assert "applied_batches" not in client.get("/api/sync/changes?since=0").json()
    assert "applied_batches" not in client.get("/api/sync/snapshot").json()


def test_named_batches_none_applied_leaves_the_field_out(client):
    feed = client.get("/api/sync/changes?since=0&pending=never_posted").json()
    assert "applied_batches" not in feed
    assert feed["reset"] is False


def test_a_reset_answer_names_nothing(client):
    _post(client, "before_reset",
          [{"op": "update_text", "uid": "uid_b1", "text": "v"}])
    feed = client.get(
        "/api/sync/changes?since=999999&pending=before_reset").json()
    assert feed["reset"] is True
    assert "applied_batches" not in feed


def _traced(con, fn):
    queries: list[str] = []
    con.set_trace_callback(queries.append)
    try:
        return fn(), queries
    finally:
        con.set_trace_callback(None)


def test_no_applied_batches_query_without_pending_ids(seeded_config):
    con = open_db(seeded_config.db_path)
    try:
        _, changes_sql = _traced(
            con, lambda: sync_changes(since=0, limit=1000, db=con))
        _, snapshot_sql = _traced(con, lambda: sync_snapshot(db=con))
    finally:
        con.close()
    assert not any("applied_batches" in q for q in changes_sql + snapshot_sql)


def test_one_applied_batches_query_for_a_few_pending_ids(seeded_config):
    con = open_db(seeded_config.db_path)
    try:
        _, sql = _traced(con, lambda: sync_changes(
            since=0, limit=1000, pending=["a1234567", "b1234567"], db=con))
    finally:
        con.close()
    assert sum("applied_batches" in q for q in sql) == 1


def _commit_elsewhere(path, batch_id):
    other = sqlite3.connect(path)
    try:
        other.execute("INSERT INTO applied_batches VALUES (?,?,?,?)",
                      (batch_id, "h", json.dumps(
                          {"ok": True, "ts": 1, "applied": 1, "seq": 1,
                           "skipped": []}), 1))
        other.commit()
    finally:
        other.close()


def _commit_during(con, path, batch_id, marker):
    """Commit `batch_id` from another connection when the route starts the
    statement containing `marker`, a read after its first: the read
    transaction already holds its snapshot by then, so a lookup inside it
    must not see the row."""
    done = False

    def trace(sql: str) -> None:
        nonlocal done
        if not done and marker in sql:
            done = True
            _commit_elsewhere(path, batch_id)

    con.set_trace_callback(trace)
    return lambda: con.set_trace_callback(None)


def test_changes_read_applied_batches_in_the_window_read_transaction(
        seeded_config):
    con = open_db(seeded_config.db_path)
    stop = _commit_during(con, seeded_config.db_path, "late_batch",
                          "SELECT seq, kind, entity_id, deleted FROM changes")
    try:
        feed = sync_changes(since=0, limit=1000, pending=["late_batch"], db=con)
    finally:
        stop()
        con.close()
    # committed after the window's snapshot: the window lacks it
    assert feed.applied_batches == []
    con = open_db(seeded_config.db_path)
    try:
        again = sync_changes(since=0, limit=1000, pending=["late_batch"], db=con)
    finally:
        con.close()
    assert [a.batch_id for a in again.applied_batches] == ["late_batch"]


def test_snapshot_reads_applied_batches_in_its_read_transaction(seeded_config):
    con = open_db(seeded_config.db_path)
    stop = _commit_during(con, seeded_config.db_path, "late_snap",
                          "SELECT uid FROM blocks")
    try:
        snap = sync_snapshot(pending=["late_snap"], db=con)
    finally:
        stop()
        con.close()
    assert snap.applied_batches == []
    con = open_db(seeded_config.db_path)
    try:
        again = sync_snapshot(pending=["late_snap"], db=con)
    finally:
        con.close()
    assert [a.batch_id for a in again.applied_batches] == ["late_snap"]
