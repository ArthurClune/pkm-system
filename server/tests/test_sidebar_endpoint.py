import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

from pkm.server.db import get_db, open_db


def _seed_entries(db_path, rows):
    con = sqlite3.connect(db_path)
    con.executemany(
        "INSERT INTO sidebar_entries(title, order_idx) VALUES (?,?)", rows)
    con.commit()
    con.close()


def test_sidebar_returns_entries_in_order(client, seeded_config):
    _seed_entries(seeded_config.db_path, [("Roam", 1), ("AWS", 0), ("AI", 2)])
    r = client.get("/api/sidebar")
    assert r.status_code == 200
    assert r.json() == {"entries": [
        {"id": 2, "title": "AWS"},
        {"id": 1, "title": "Roam"},
        {"id": 3, "title": "AI"},
    ]}


def test_sidebar_empty_when_no_entries(client):
    assert client.get("/api/sidebar").json() == {"entries": []}


def test_sidebar_requires_auth(anon_client):
    assert anon_client.get("/api/sidebar").status_code == 401


def test_add_entry_appends_at_end(client, seeded_config):
    _seed_entries(seeded_config.db_path, [("AWS", 0), ("AI", 1)])
    r = client.post("/api/sidebar", json={"title": "Crypto"})
    assert r.status_code == 200
    assert r.json()["title"] == "Crypto"
    assert client.get("/api/sidebar").json() == {"entries": [
        {"id": 1, "title": "AWS"},
        {"id": 2, "title": "AI"},
        {"id": r.json()["id"], "title": "Crypto"},
    ]}


def test_add_entry_first_when_table_empty(client):
    r = client.post("/api/sidebar", json={"title": "AWS"})
    assert r.status_code == 200
    assert client.get("/api/sidebar").json() == {
        "entries": [{"id": r.json()["id"], "title": "AWS"}]}


def test_add_entry_rejects_duplicate_title(client, seeded_config):
    _seed_entries(seeded_config.db_path, [("AWS", 0)])
    r = client.post("/api/sidebar", json={"title": "AWS"})
    assert r.status_code == 409


_SNAPSHOT_SQL = "SELECT title, order_idx FROM sidebar_entries"
_RENDEZVOUS_TIMEOUT_SECONDS = 5


class _SidebarWriteGate:
    """Coordinate requests only after each real DB snapshot is captured."""

    def __init__(self):
        self._lock = threading.Lock()
        self._begin_attempts = 0
        self._snapshots = 0
        self._connections_opened = 0
        self._connections_closed = 0
        self._competing_request_arrived = threading.Event()
        self._release_first_snapshot = threading.Event()

    def connection_opened(self):
        with self._lock:
            self._connections_opened += 1

    def connection_closed(self):
        with self._lock:
            self._connections_closed += 1

    def before_begin(self):
        with self._lock:
            self._begin_attempts += 1
            is_second = self._begin_attempts == 2
        if is_second:
            self._competing_request_arrived.set()
            self._release_first_snapshot.set()

    def after_snapshot(self):
        with self._lock:
            self._snapshots += 1
            snapshot_number = self._snapshots
        if snapshot_number == 2:
            self._competing_request_arrived.set()
            self._release_first_snapshot.set()
        elif snapshot_number == 1 and not self._release_first_snapshot.wait(
                timeout=_RENDEZVOUS_TIMEOUT_SECONDS):
            raise AssertionError(
                "second sidebar request never reached the database rendezvous")

    def assert_completed(self):
        assert self._competing_request_arrived.is_set()
        assert self._connections_opened == 2
        assert self._connections_closed == 2


class _SnapshotCursor:
    def __init__(self, cursor, gate):
        self._cursor = cursor
        self._gate = gate

    def fetchall(self):
        rows = self._cursor.fetchall()
        self._gate.after_snapshot()
        return rows


class _GatedConnection:
    def __init__(self, connection, gate):
        self._connection = connection
        self._gate = gate

    def execute(self, sql, parameters=()):
        if sql == "BEGIN IMMEDIATE":
            self._gate.before_begin()
        cursor = self._connection.execute(sql, parameters)
        if sql == _SNAPSHOT_SQL:
            return _SnapshotCursor(cursor, self._gate)
        return cursor

    def commit(self):
        self._connection.commit()

    def rollback(self):
        self._connection.rollback()


def _post_concurrently(client, seeded_config, titles):
    gate = _SidebarWriteGate()

    def gated_db():
        connection = open_db(seeded_config.db_path)
        gate.connection_opened()
        try:
            yield _GatedConnection(connection, gate)
        finally:
            connection.close()
            gate.connection_closed()

    missing = object()
    previous_override = client.app.dependency_overrides.get(get_db, missing)
    client.app.dependency_overrides[get_db] = gated_db
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(
                client.post, "/api/sidebar", json={"title": title})
                for title in titles]
        responses = [future.result() for future in futures]
    finally:
        if previous_override is missing:
            client.app.dependency_overrides.pop(get_db, None)
        else:
            client.app.dependency_overrides[get_db] = previous_override

    gate.assert_completed()
    return responses


def test_concurrent_different_titles_get_distinct_append_indexes(
        client, seeded_config):
    _seed_entries(seeded_config.db_path, [("AWS", 0)])
    responses = _post_concurrently(
        client, seeded_config, ["Crypto", "Databases"])
    assert [r.status_code for r in responses] == [200, 200]

    con = sqlite3.connect(seeded_config.db_path)
    rows = con.execute(
        "SELECT title, order_idx FROM sidebar_entries"
        " WHERE title IN ('Crypto', 'Databases') ORDER BY order_idx"
    ).fetchall()
    con.close()
    assert [row[1] for row in rows] == [1, 2]
    assert {row[0] for row in rows} == {"Crypto", "Databases"}


def test_concurrent_same_title_returns_one_conflict(
        client, seeded_config):
    responses = _post_concurrently(
        client, seeded_config, ["Crypto", "Crypto"])
    assert sorted(r.status_code for r in responses) == [200, 409]
    conflict = next(r for r in responses if r.status_code == 409)
    assert conflict.json() == {"detail": "entry already exists"}

    con = sqlite3.connect(seeded_config.db_path)
    count = con.execute(
        "SELECT count(*) FROM sidebar_entries WHERE title = 'Crypto'"
    ).fetchone()[0]
    con.close()
    assert count == 1


def test_add_entry_rejects_blank_title(client):
    r = client.post("/api/sidebar", json={"title": "   "})
    assert r.status_code == 422


def test_add_entry_requires_auth(anon_client):
    assert anon_client.post("/api/sidebar", json={"title": "AWS"}).status_code == 401


def test_delete_entry_removes_it(client, seeded_config):
    _seed_entries(seeded_config.db_path, [("AWS", 0), ("AI", 1)])
    r = client.delete("/api/sidebar/1")
    assert r.status_code == 200
    assert client.get("/api/sidebar").json() == {
        "entries": [{"id": 2, "title": "AI"}]}


def test_delete_entry_404_when_missing(client):
    assert client.delete("/api/sidebar/999").status_code == 404


def test_delete_entry_requires_auth(anon_client):
    assert anon_client.delete("/api/sidebar/1").status_code == 401


def test_reorder_updates_order_idx(client, seeded_config):
    _seed_entries(seeded_config.db_path, [("AWS", 0), ("AI", 1), ("Crypto", 2)])
    r = client.put("/api/sidebar", json={"order": [3, 1, 2]})
    assert r.status_code == 200
    assert client.get("/api/sidebar").json() == {"entries": [
        {"id": 3, "title": "Crypto"},
        {"id": 1, "title": "AWS"},
        {"id": 2, "title": "AI"},
    ]}


def test_reorder_rejects_partial_list(client, seeded_config):
    _seed_entries(seeded_config.db_path, [("AWS", 0), ("AI", 1)])
    r = client.put("/api/sidebar", json={"order": [1]})
    assert r.status_code == 400


def test_reorder_rejects_unknown_id(client, seeded_config):
    _seed_entries(seeded_config.db_path, [("AWS", 0)])
    r = client.put("/api/sidebar", json={"order": [1, 999]})
    assert r.status_code == 400


def test_reorder_requires_auth(anon_client):
    assert anon_client.put("/api/sidebar", json={"order": []}).status_code == 401
