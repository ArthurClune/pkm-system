import sqlite3


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
