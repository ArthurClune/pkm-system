from pkm.server.db import open_db


def test_current_work_groups_pages_into_exclusive_windows(client, seeded_config):
    con = open_db(seeded_config.db_path)
    now = 1_800_000_000_000
    hour = 60 * 60 * 1000
    con.executemany(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        [
            (20, "Recent B", None, now - hour),
            (21, "Recent A", None, now - hour),
            (22, "Yesterday", None, now - 25 * hour),
            (23, "Two Days", None, now - 49 * hour),
            (24, "Old", None, now - 8 * 24 * hour),
            (25, "Never Changed", None, None),
        ],
    )
    con.commit()
    con.close()

    body = client.get("/api/current-work", params={"now_ms": now}).json()

    assert [section["id"] for section in body["sections"]] == [
        "last-24-hours",
        "24-to-48-hours",
        "48-hours-to-7-days",
    ]
    assert [page["title"] for page in body["sections"][0]["pages"]] == [
        "Recent A",
        "Recent B",
    ]
    assert [page["title"] for page in body["sections"][1]["pages"]] == ["Yesterday"]
    assert [page["title"] for page in body["sections"][2]["pages"]] == ["Two Days"]


def test_current_work_excludes_boundary_from_newer_bucket(client, seeded_config):
    con = open_db(seeded_config.db_path)
    now = 1_800_000_000_000
    hour = 60 * 60 * 1000
    con.executemany(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
        [
            (30, "Exactly 24h", None, now - 24 * hour),
            (31, "Exactly 48h", None, now - 48 * hour),
            (32, "Exactly 7d", None, now - 7 * 24 * hour),
        ],
    )
    con.commit()
    con.close()

    body = client.get("/api/current-work", params={"now_ms": now}).json()

    assert "Exactly 24h" not in [p["title"] for p in body["sections"][0]["pages"]]
    assert "Exactly 24h" in [p["title"] for p in body["sections"][1]["pages"]]
    assert "Exactly 48h" not in [p["title"] for p in body["sections"][1]["pages"]]
    assert "Exactly 48h" in [p["title"] for p in body["sections"][2]["pages"]]
    assert "Exactly 7d" in [p["title"] for p in body["sections"][2]["pages"]]


def test_current_work_requires_auth(anon_client):
    assert anon_client.get("/api/current-work").status_code == 401
