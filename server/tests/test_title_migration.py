import sqlite3

import pytest

from pkm.schema import DDL
from pkm.server.sync_meta import (
    database_generation,
    plain_space_title_canonicalization_active,
)
import pkm.server.title_migration as title_migration_shell
from pkm.server.title_migration import (
    AlreadyActiveTitleMigration,
    BlockedTitleMigration,
    StaleTitleMigration,
    TitleMigrationOutcome,
    _inventory_title_migration,
    apply_title_migration,
    audit_title_migration,
)


def _database() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA recursive_triggers=ON")
    db.executescript(DDL)
    return db


def _seed_migration_graph(db: sqlite3.Connection) -> None:
    db.executemany(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [
            (1, "Acme", 10, 11),
            (2, " Acme", 20, 21),
            (3, "Acme ", 30, 31),
            (4, " Beta ", 40, 41),
            (5, "Beta ", 50, 51),
            (6, "Inbound", 60, 61),
            (7, "Unrelated", 70, 71),
            (8, "\u00a0Gamma\u00a0", 80, 81),
        ],
    )
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, collapsed) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        [
            ("target-root", 1, None, 0, "target"),
            ("source-leading", 2, None, 0, "self [[ Acme]] and [[Unrelated]]"),
            ("child-leading", 2, "source-leading", 0, "child"),
            ("source-trailing", 3, None, 0, "trailing"),
            ("beta-first", 4, None, 0, "beta first"),
            ("beta-second", 5, None, 0, "beta second"),
            (
                "inbound",
                6,
                None,
                0,
                "[[ Acme]] + [[Acme ]] + [[ Beta ]] + [[Beta ]] + [[Unrelated]]",
            ),
            ("inbound-two", 6, None, 1, "again [[ Acme]]"),
            ("unrelated-root", 7, None, 0, "untouched"),
        ],
    )
    db.executemany(
        "INSERT INTO refs(src_block_uid, target_page_id, kind) VALUES (?, ?, ?)",
        [
            ("source-leading", 2, "link"),
            ("source-leading", 7, "link"),
            ("beta-first", 7, "link"),
            ("inbound", 2, "link"),
            ("inbound", 3, "link"),
            ("inbound", 4, "link"),
            ("inbound", 5, "link"),
            ("inbound", 7, "link"),
            ("inbound-two", 2, "link"),
        ],
    )
    db.executemany(
        "INSERT INTO sidebar_entries(id, title, order_idx) VALUES (?, ?, ?)",
        [
            (1, "Acme", 0),
            (2, " Acme", 1),
            (3, "Beta ", 2),
            (4, "Unrelated", 3),
        ],
    )
    db.commit()


def _rows(db: sqlite3.Connection, table: str) -> list[tuple[object, ...]]:
    return sorted(tuple(row) for row in db.execute(f"SELECT * FROM {table}"))


def _state(db: sqlite3.Connection) -> dict[str, list[tuple[object, ...]]]:
    return {
        table: _rows(db, table)
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


def test_audit_inventories_only_migration_rows_without_side_effects():
    """Mutation caught: inventory all pages/partial refs or commit audit state."""
    db = _database()
    _seed_migration_graph(db)
    before = _state(db)
    generation = database_generation(db)

    plan = audit_title_migration(db)

    assert plan.active is False
    assert plain_space_title_canonicalization_active(db) is False
    assert [(page.page_id, page.title) for page in plan.pages] == [
        (1, "Acme"),
        (2, " Acme"),
        (3, "Acme "),
        (4, " Beta "),
        (5, "Beta "),
    ]
    assert [
        (group.canonical_title, group.survivor.page_id, [p.page_id for p in group.sources])
        for group in plan.groups
    ] == [("Acme", 1, [2, 3]), ("Beta", 4, [5])]
    assert [
        (group.block_count, group.inbound_ref_count, group.sidebar_count)
        for group in plan.groups
    ] == [(4, 4, 2), (2, 2, 1)]
    assert (plan.page_count, plan.block_count, plan.ref_count, plan.sidebar_count) == (
        5,
        8,
        8,
        3,
    )
    assert plan.digest == "6e315eba00d731a0765d07495d9022196c869d49d22eb49ce10d2c7d517583c8"
    assert _state(db) == before
    assert database_generation(db) == generation
    assert db.in_transaction is False


def test_audit_and_apply_include_orphan_canonical_sidebar_identity():
    """Mutation caught: omit an orphan canonical sidebar from migration inventory."""
    db = _database()
    db.executemany(
        "INSERT INTO pages(id, title) VALUES (?, ?)",
        [(1, " Beta "), (2, "Beta ")],
    )
    db.executemany(
        "INSERT INTO sidebar_entries(id, title, order_idx) VALUES (?, ?, ?)",
        [(10, " Beta ", 8), (11, "Beta ", 4), (12, "Beta", 2)],
    )
    db.commit()

    plan = audit_title_migration(db)

    assert [
        (sidebar.sidebar_id, sidebar.title, sidebar.order_idx)
        for sidebar in plan.sidebars
    ] == [(10, " Beta ", 8), (11, "Beta ", 4), (12, "Beta", 2)]
    assert plan.sidebar_count == 3

    apply_title_migration(db, plan.digest, now_ms=9_999)

    assert [tuple(row) for row in db.execute(
        "SELECT id, title, order_idx FROM sidebar_entries ORDER BY id"
    )] == [(12, "Beta", 2)]
    assert [tuple(row) for row in db.execute(
        "SELECT id, title FROM pages ORDER BY id"
    )] == [(1, "Beta")]


def test_apply_detects_stale_digest_when_orphan_canonical_sidebar_changes():
    """Mutation caught: omit a surviving canonical orphan's order from the digest."""
    db = _database()
    db.execute("INSERT INTO pages(id, title) VALUES (1, ' Beta ')")
    db.execute(
        "INSERT INTO sidebar_entries(id, title, order_idx) VALUES (12, 'Beta', 2)"
    )
    db.commit()
    plan = audit_title_migration(db)
    db.execute("UPDATE sidebar_entries SET order_idx=7 WHERE id=12")
    db.commit()
    before = _state(db)

    with pytest.raises(StaleTitleMigration) as raised:
        apply_title_migration(db, plan.digest, now_ms=10_000)

    assert raised.value.expected_digest == plan.digest
    assert raised.value.actual_digest != plan.digest
    assert _state(db) == before
    assert db.in_transaction is False


def test_audit_refuses_to_terminate_a_caller_owned_transaction():
    """Mutation caught: remove the pre-existing transaction ownership guard."""
    db = _database()
    _seed_migration_graph(db)
    db.execute("BEGIN")
    db.execute("INSERT INTO pages(title) VALUES ('caller-owned')")

    with pytest.raises(RuntimeError, match="transaction"):
        audit_title_migration(db)

    assert db.in_transaction is True
    assert db.execute("SELECT count(*) FROM pages WHERE title='caller-owned'").fetchone()[0] == 1
    db.rollback()


def test_private_inventory_never_changes_caller_transaction_ownership():
    """Mutation caught: add BEGIN/COMMIT/ROLLBACK to the private gatherer."""
    db = _database()
    _seed_migration_graph(db)
    db.execute("BEGIN")

    inventory = _inventory_title_migration(db)

    assert inventory.active is False
    assert db.in_transaction is True
    db.rollback()


def test_apply_merges_rewrites_reindexes_and_activates_in_one_immediate_transaction():
    """Mutation caught: merge by group order, rewrite incrementally, or rotate later."""
    db = _database()
    _seed_migration_graph(db)
    plan = audit_title_migration(db)
    old_generation = database_generation(db)
    trace: list[str] = []
    db.set_trace_callback(trace.append)

    outcome = apply_title_migration(db, plan.digest, now_ms=10_000)

    assert outcome == TitleMigrationOutcome(
        digest=plan.digest,
        groups_applied=2,
        pages_retitled=1,
        pages_merged=3,
        blocks_moved=4,
        blocks_rewritten=3,
        generation=database_generation(db),
    )
    assert trace[0] == "BEGIN IMMEDIATE"
    assert [statement for statement in trace if statement.startswith("BEGIN")] == [
        "BEGIN IMMEDIATE"
    ]
    assert plain_space_title_canonicalization_active(db) is True
    assert database_generation(db) != old_generation
    assert [tuple(row) for row in db.execute(
        "SELECT id, title FROM pages ORDER BY id"
    )] == [
        (1, "Acme"),
        (4, "Beta"),
        (6, "Inbound"),
        (7, "Unrelated"),
        (8, "\u00a0Gamma\u00a0"),
    ]
    assert [tuple(row) for row in db.execute(
        "SELECT uid, order_idx FROM blocks WHERE page_id=1 AND parent_uid IS NULL "
        "ORDER BY order_idx"
    )] == [("target-root", 0), ("source-leading", 1), ("source-trailing", 2)]
    assert [tuple(row) for row in db.execute(
        "SELECT uid, order_idx FROM blocks WHERE page_id=4 AND parent_uid IS NULL "
        "ORDER BY order_idx"
    )] == [("beta-first", 0), ("beta-second", 1)]
    assert tuple(db.execute(
        "SELECT page_id, parent_uid, order_idx FROM blocks WHERE uid='child-leading'"
    ).fetchone()) == (1, "source-leading", 0)
    assert db.execute("SELECT text FROM blocks WHERE uid='inbound'").fetchone()[0] == (
        "[[Acme]] + [[Acme]] + [[Beta]] + [[Beta]] + [[Unrelated]]"
    )
    assert db.execute(
        "SELECT text FROM blocks WHERE uid='source-leading'"
    ).fetchone()[0] == "self [[Acme]] and [[Unrelated]]"
    assert [tuple(row) for row in db.execute(
        "SELECT target_page_id, kind FROM refs WHERE src_block_uid='inbound' "
        "ORDER BY target_page_id, kind"
    )] == [(1, "link"), (4, "link"), (7, "link")]
    assert [tuple(row) for row in db.execute(
        "SELECT id, title, order_idx FROM sidebar_entries ORDER BY id"
    )] == [(1, "Acme", 0), (3, "Beta", 2), (4, "Unrelated", 3)]
    assert db.execute(
        "SELECT count(*) FROM pages_fts WHERE pages_fts MATCH '\"Beta\"'"
    ).fetchone()[0] == 1
    assert db.execute(
        "SELECT count(*) FROM pages_fts WHERE pages_fts MATCH '\"Acme\"'"
    ).fetchone()[0] == 1
    assert db.execute(
        "SELECT count(*) FROM blocks_fts JOIN blocks ON blocks.rowid=blocks_fts.rowid "
        "WHERE blocks.uid='inbound' AND blocks_fts MATCH '\"Acme\"'"
    ).fetchone()[0] == 1
    assert db.in_transaction is False


def test_nested_final_orphan_sidebar_identity_is_inventoried_and_digested():
    """Mutation caught: omit the nested final title from sidebar inventory."""
    db = _database()
    db.executemany(
        "INSERT INTO pages(id, title) VALUES (?, ?)",
        [(1, " Outer [[ Inner ]] "), (2, " Inner ")],
    )
    db.execute(
        "INSERT INTO sidebar_entries(id, title, order_idx) "
        "VALUES (9, 'Outer [[Inner]]', 3)"
    )
    db.commit()

    plan = audit_title_migration(db)

    assert [
        (sidebar.sidebar_id, sidebar.title, sidebar.order_idx)
        for sidebar in plan.sidebars
    ] == [(9, "Outer [[Inner]]", 3)]
    db.execute("UPDATE sidebar_entries SET order_idx=4 WHERE id=9")
    db.commit()
    with pytest.raises(StaleTitleMigration):
        apply_title_migration(db, plan.digest, now_ms=10_001)


def test_apply_canonicalizes_nested_sources_without_recreating_padded_pages():
    """Mutation caught: suppress inner rewrite or reindex before activation."""
    db = _database()
    db.executemany(
        "INSERT INTO pages(id, title) VALUES (?, ?)",
        [
            (1, " Outer [[ Inner ]] "),
            (2, " Inner "),
            (3, "Watcher"),
        ],
    )
    db.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text) "
        "VALUES ('nested-watcher', 3, NULL, 0, '[[ Outer [[ Inner ]] ]]')"
    )
    db.executemany(
        "INSERT INTO refs(src_block_uid, target_page_id, kind) VALUES (?, ?, 'link')",
        [("nested-watcher", 1), ("nested-watcher", 2)],
    )
    db.commit()
    plan = audit_title_migration(db)
    audited_digest = plan.digest

    outcome = apply_title_migration(db, audited_digest, now_ms=10_001)

    assert outcome.digest == audited_digest
    assert plain_space_title_canonicalization_active(db) is True
    assert [tuple(row) for row in db.execute(
        "SELECT id, title FROM pages ORDER BY id"
    )] == [
        (1, "Outer [[Inner]]"),
        (2, "Inner"),
        (3, "Watcher"),
    ]
    assert db.execute(
        "SELECT text FROM blocks WHERE uid='nested-watcher'"
    ).fetchone()[0] == "[[Outer [[Inner]]]]"
    assert [tuple(row) for row in db.execute(
        "SELECT target_page_id, kind FROM refs "
        "WHERE src_block_uid='nested-watcher' ORDER BY target_page_id, kind"
    )] == [(1, "link"), (2, "link")]
    assert db.execute(
        "SELECT count(*) FROM pages WHERE title != rtrim(ltrim(title, ' '), ' ')"
    ).fetchone()[0] == 0


def test_apply_rejects_stale_digest_without_mutation():
    """Mutation caught: trust the audit digest without re-inventory under write lock."""
    db = _database()
    _seed_migration_graph(db)
    before = _state(db)

    with pytest.raises(StaleTitleMigration) as raised:
        apply_title_migration(db, "0" * 64, now_ms=10_001)

    assert raised.value.expected_digest == "0" * 64
    assert raised.value.actual_digest == audit_title_migration(db).digest
    assert _state(db) == before
    assert db.in_transaction is False


def test_apply_rejects_all_space_blocker_without_mutation():
    """Mutation caught: silently drop or invent a title for an all-space page."""
    db = _database()
    _seed_migration_graph(db)
    db.execute("INSERT INTO pages(id, title) VALUES (9, '   ')")
    db.commit()
    plan = audit_title_migration(db)
    before = _state(db)

    with pytest.raises(BlockedTitleMigration) as raised:
        apply_title_migration(db, plan.digest, now_ms=10_002)

    assert [(page.page_id, page.title) for page in raised.value.blockers] == [(9, "   ")]
    assert _state(db) == before
    assert plain_space_title_canonicalization_active(db) is False


def test_apply_rejects_already_active_database_without_rotation():
    """Mutation caught: reapply migration after activation and rotate generation again."""
    db = _database()
    _seed_migration_graph(db)
    db.execute(
        "UPDATE sync_meta SET value='1' WHERE key='plain_space_title_canonicalization'"
    )
    db.commit()
    plan = audit_title_migration(db)
    before = _state(db)

    with pytest.raises(AlreadyActiveTitleMigration):
        apply_title_migration(db, plan.digest, now_ms=10_003)

    assert _state(db) == before


def test_apply_rolls_back_all_effects_when_rewrite_fails(monkeypatch):
    """Mutation caught: commit page merges before final block rewrite/activation."""
    db = _database()
    _seed_migration_graph(db)
    plan = audit_title_migration(db)
    before = _state(db)

    activation_seen_during_reindex: list[bool] = []

    def fail_rewrite(rewrite_db, *args, **kwargs):
        activation_seen_during_reindex.append(
            plain_space_title_canonicalization_active(rewrite_db)
        )
        raise RuntimeError("injected rewrite failure")

    monkeypatch.setattr(
        title_migration_shell, "rewrite_snapshotted_blocks", fail_rewrite
    )

    with pytest.raises(RuntimeError, match="injected rewrite failure"):
        apply_title_migration(db, plan.digest, now_ms=10_004)

    assert activation_seen_during_reindex == [True]
    assert _state(db) == before
    assert plain_space_title_canonicalization_active(db) is False
    assert db.in_transaction is False


def test_apply_rolls_back_all_effects_when_base_exception_propagates(monkeypatch):
    """Mutation caught: catch Exception and strand partial writes on BaseException."""
    db = _database()
    _seed_migration_graph(db)
    plan = audit_title_migration(db)
    before = _state(db)

    def interrupt_rewrite(*args, **kwargs):
        raise KeyboardInterrupt("injected migration interrupt")

    monkeypatch.setattr(
        title_migration_shell, "rewrite_snapshotted_blocks", interrupt_rewrite
    )

    with pytest.raises(KeyboardInterrupt, match="injected migration interrupt"):
        apply_title_migration(db, plan.digest, now_ms=10_005)

    assert _state(db) == before
    assert plain_space_title_canonicalization_active(db) is False
    assert db.in_transaction is False


def test_apply_rolls_back_earlier_sources_when_sqlite_aborts_later_delete():
    """Mutation caught: commit each source append rather than the complete migration."""
    db = _database()
    _seed_migration_graph(db)
    db.executescript(
        """
        CREATE TRIGGER abort_third_source BEFORE DELETE ON pages
        WHEN OLD.id = 3 BEGIN
          SELECT RAISE(ABORT, 'injected source delete abort');
        END;
        """
    )
    plan = audit_title_migration(db)
    before = _state(db)

    with pytest.raises(sqlite3.IntegrityError, match="injected source delete abort"):
        apply_title_migration(db, plan.digest, now_ms=10_005)

    assert _state(db) == before
    assert plain_space_title_canonicalization_active(db) is False
    assert db.in_transaction is False


def test_apply_refuses_to_rollback_a_caller_owned_transaction():
    """Mutation caught: attempt nested BEGIN then roll back the caller's transaction."""
    db = _database()
    _seed_migration_graph(db)
    plan = audit_title_migration(db)
    db.execute("BEGIN")
    db.execute("INSERT INTO pages(title) VALUES ('caller-owned')")

    with pytest.raises(RuntimeError, match="transaction"):
        apply_title_migration(db, plan.digest, now_ms=10_006)

    assert db.in_transaction is True
    assert db.execute("SELECT count(*) FROM pages WHERE title='caller-owned'").fetchone()[0] == 1
    db.rollback()
