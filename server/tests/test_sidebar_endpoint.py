import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

from pkm.server import routes_sidebar


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


def _post_concurrently(client, monkeypatch, titles):
    real_next = routes_sidebar.next_order_idx
    second_arrived = threading.Event()
    call_lock = threading.Lock()
    calls = 0

    def rendezvous(values):
        nonlocal calls
        with call_lock:
            calls += 1
            call = calls
        if call == 1:
            second_arrived.wait(timeout=0.25)
        else:
            second_arrived.set()
        return real_next(values)

    monkeypatch.setattr(routes_sidebar, "next_order_idx", rendezvous)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(
            client.post, "/api/sidebar", json={"title": title})
            for title in titles]
    return [future.result() for future in futures]


def test_concurrent_different_titles_get_distinct_append_indexes(
        client, seeded_config, monkeypatch):
    _seed_entries(seeded_config.db_path, [("AWS", 0)])
    responses = _post_concurrently(
        client, monkeypatch, ["Crypto", "Databases"])
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
        client, seeded_config, monkeypatch):
    responses = _post_concurrently(
        client, monkeypatch, ["Crypto", "Crypto"])
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
