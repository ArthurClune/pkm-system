import sqlite3

import pkm.server.notify as notify
from pkm.server.db import get_db, open_db
from pkm.server.sync_meta import (
    database_generation,
    plain_space_title_canonicalization_active,
)


def _seed_migration_graph(db_path) -> None:
    con = sqlite3.connect(db_path)
    con.executemany(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [
            (10, "Acme", 10, 11),
            (11, " Acme", 20, 21),
            (12, "Acme ", 30, 31),
            (13, " Beta ", 40, 41),
            (14, "Beta ", 50, 51),
            (15, "Inbound", 60, 61),
            (16, "Unrelated", 70, 71),
            (17, "\u00a0Gamma\u00a0", 80, 81),
        ],
    )
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, collapsed) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        [
            ("target-root", 10, None, 0, "target"),
            ("source-leading", 11, None, 0, "self [[ Acme]] and [[Unrelated]]"),
            ("child-leading", 11, "source-leading", 0, "child"),
            ("source-trailing", 12, None, 0, "trailing"),
            ("beta-first", 13, None, 0, "beta first"),
            ("beta-second", 14, None, 0, "beta second"),
            (
                "inbound",
                15,
                None,
                0,
                "[[ Acme]] + [[Acme ]] + [[ Beta ]] + [[Beta ]] + [[Unrelated]]",
            ),
            ("inbound-two", 15, None, 1, "again [[ Acme]]"),
            ("unrelated-root", 16, None, 0, "untouched"),
        ],
    )
    con.executemany(
        "INSERT INTO refs(src_block_uid, target_page_id, kind) VALUES (?, ?, ?)",
        [
            ("source-leading", 11, "link"),
            ("source-leading", 16, "link"),
            ("beta-first", 16, "link"),
            ("inbound", 11, "link"),
            ("inbound", 12, "link"),
            ("inbound", 13, "link"),
            ("inbound", 14, "link"),
            ("inbound", 16, "link"),
            ("inbound-two", 11, "link"),
        ],
    )
    con.executemany(
        "INSERT INTO sidebar_entries(id, title, order_idx) VALUES (?, ?, ?)",
        [
            (10, "Acme", 0),
            (11, " Acme", 1),
            (12, "Beta ", 2),
            (13, "Unrelated", 3),
        ],
    )
    con.commit()
    con.close()


def _table_rows(db_path, table: str) -> list[tuple[object, ...]]:
    con = sqlite3.connect(db_path)
    try:
        return sorted(tuple(row) for row in con.execute(f"SELECT * FROM {table}"))
    finally:
        con.close()


def _state(db_path) -> dict[str, list[tuple[object, ...]]]:
    return {
        table: _table_rows(db_path, table)
        for table in (
            "pages",
            "blocks",
            "refs",
            "sidebar_entries",
            "sync_meta",
            "changes",
            "pages_fts",
            "blocks_fts",
        )
    }


def test_title_migration_audit_requires_auth(anon_client):
    r = anon_client.get("/api/migrations/title-canonicalization")
    assert r.status_code == 401


def test_title_migration_apply_requires_auth(anon_client):
    r = anon_client.post(
        "/api/migrations/title-canonicalization",
        json={"audit_digest": "0" * 64},
    )
    assert r.status_code == 401


def test_title_migration_audit_returns_truthful_payload_without_side_effects(
    client, seeded_config
):
    _seed_migration_graph(seeded_config.db_path)
    before = _state(seeded_config.db_path)
    db = open_db(seeded_config.db_path)
    generation = database_generation(db)
    active = plain_space_title_canonicalization_active(db)
    db.close()

    r = client.get("/api/migrations/title-canonicalization")

    assert r.status_code == 200
    assert r.json() == {
        "active": False,
        "digest": "d621560f1350eda15118dbd597ccd82bb80bc18ddbc646fc4165fe332dabb647",
        "groups": [
            {
                "canonical_title": "Acme",
                "survivor": {"page_id": 10, "title": "Acme"},
                "sources": [
                    {"page_id": 11, "title": " Acme"},
                    {"page_id": 12, "title": "Acme "},
                ],
                "has_clean_twin": True,
                "block_count": 4,
                "inbound_ref_count": 4,
                "sidebar_count": 2,
            },
            {
                "canonical_title": "Beta",
                "survivor": {"page_id": 13, "title": " Beta "},
                "sources": [{"page_id": 14, "title": "Beta "}],
                "has_clean_twin": False,
                "block_count": 2,
                "inbound_ref_count": 2,
                "sidebar_count": 1,
            },
        ],
        "blockers": [],
    }
    db = open_db(seeded_config.db_path)
    assert database_generation(db) == generation
    assert plain_space_title_canonicalization_active(db) is active
    db.close()
    assert _state(seeded_config.db_path) == before


def test_title_migration_audit_surfaces_reasoned_blockers(client, seeded_config):
    _seed_migration_graph(seeded_config.db_path)
    con = sqlite3.connect(seeded_config.db_path)
    con.executemany(
        "INSERT INTO pages(id, title) VALUES (?, ?)",
        [(18, "   "), (19, "Bad #Title")],
    )
    con.commit()
    con.close()

    r = client.get("/api/migrations/title-canonicalization")

    assert r.status_code == 200
    assert r.json()["blockers"] == [
        {"page_id": 18, "title": "   ", "reason": "all_space"},
        {
            "page_id": 19,
            "title": "Bad #Title",
            "reason": "forbidden_syntax",
        },
    ]


class _CountingConnection:
    def __init__(self, connection):
        self._connection = connection
        self.commit_calls = 0

    def execute(self, sql, parameters=()):
        return self._connection.execute(sql, parameters)

    def executemany(self, sql, seq_of_parameters):
        return self._connection.executemany(sql, seq_of_parameters)

    def executescript(self, sql_script):
        return self._connection.executescript(sql_script)

    def commit(self):
        self.commit_calls += 1
        return self._connection.commit()

    def rollback(self):
        return self._connection.rollback()

    def close(self):
        return self._connection.close()

    def __getattr__(self, name):
        return getattr(self._connection, name)


def test_title_migration_apply_activates_rotates_generation_and_nudges_once(
    client, seeded_config, monkeypatch
):
    _seed_migration_graph(seeded_config.db_path)
    audit = client.get("/api/migrations/title-canonicalization")
    assert audit.status_code == 200
    db = open_db(seeded_config.db_path)
    old_generation = database_generation(db)
    db.close()

    counting_db = _CountingConnection(open_db(seeded_config.db_path))

    def override_db():
        try:
            yield counting_db
        finally:
            counting_db.close()

    nudges: list[tuple[object, _CountingConnection, bool, str | None]] = []

    def fake_nudge(request, db, *, force=False, generation=None):
        nudges.append((request, db, force, generation))

    previous_override = client.app.dependency_overrides.get(get_db)
    client.app.dependency_overrides[get_db] = override_db
    monkeypatch.setattr(notify, "nudge_threadpool", fake_nudge)
    try:
        r = client.post(
            "/api/migrations/title-canonicalization",
            json={"audit_digest": audit.json()["digest"]},
        )
    finally:
        if previous_override is None:
            client.app.dependency_overrides.pop(get_db, None)
        else:
            client.app.dependency_overrides[get_db] = previous_override

    assert r.status_code == 200
    assert r.json() == {
        "digest": audit.json()["digest"],
        "groups_applied": 2,
        "pages_retitled": 1,
        "pages_merged": 3,
        "blocks_moved": 4,
        "blocks_rewritten": 3,
        "generation": r.json()["generation"],
    }
    assert counting_db.commit_calls == 1
    assert len(nudges) == 1
    assert nudges[0][1] is counting_db
    assert nudges[0][2:] == (True, r.json()["generation"])

    db = open_db(seeded_config.db_path)
    assert plain_space_title_canonicalization_active(db) is True
    assert database_generation(db) != old_generation
    assert database_generation(db) == r.json()["generation"]
    assert [tuple(row) for row in db.execute(
        "SELECT id, title FROM pages ORDER BY id"
    )] == [
        (1, "Machine Learning"),
        (2, "AI"),
        (3, "July 7th, 2026"),
        (4, "Paper"),
        (5, "Attention Is All You Need"),
        (10, "Acme"),
        (13, "Beta"),
        (15, "Inbound"),
        (16, "Unrelated"),
        (17, "\u00a0Gamma\u00a0"),
    ]
    db.close()


def test_title_migration_apply_rejects_malformed_digest_with_422(client):
    r = client.post(
        "/api/migrations/title-canonicalization",
        json={"audit_digest": "not-a-sha256"},
    )
    assert r.status_code == 422


def test_title_migration_apply_returns_409_for_stale_digest(client, seeded_config):
    _seed_migration_graph(seeded_config.db_path)

    r = client.post(
        "/api/migrations/title-canonicalization",
        json={"audit_digest": "0" * 64},
    )

    assert r.status_code == 409
    assert r.json() == {"detail": "title migration audit digest is stale"}


def test_title_migration_apply_returns_409_for_blocked_migration(client, seeded_config):
    _seed_migration_graph(seeded_config.db_path)
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages(id, title) VALUES (?, ?)", (18, "   "))
    con.commit()
    con.close()
    audit = client.get("/api/migrations/title-canonicalization")
    assert audit.status_code == 200

    r = client.post(
        "/api/migrations/title-canonicalization",
        json={"audit_digest": audit.json()["digest"]},
    )

    assert r.status_code == 409
    assert r.json() == {"detail": "title migration is blocked by invalid titles"}


def test_title_migration_apply_returns_409_for_already_active_database(
    client, seeded_config
):
    _seed_migration_graph(seeded_config.db_path)
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "UPDATE sync_meta SET value='1' WHERE key='plain_space_title_canonicalization'"
    )
    con.commit()
    con.close()
    audit = client.get("/api/migrations/title-canonicalization")
    assert audit.status_code == 200

    r = client.post(
        "/api/migrations/title-canonicalization",
        json={"audit_digest": audit.json()["digest"]},
    )

    assert r.status_code == 409
    assert r.json() == {
        "detail": "plain-space title canonicalization is already active"
    }
