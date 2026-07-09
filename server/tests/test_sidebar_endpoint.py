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
