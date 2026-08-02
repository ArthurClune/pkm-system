# pattern: Imperative Shell
"""Transactional database inventory and apply shell for title migration."""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from pkm.refs import canonicalize_title
from pkm.rename import rewrite_title_refs_map
from pkm.title_migration import (
    InventoryBlock,
    InventoryPage,
    InventoryRef,
    InventorySidebar,
    TitleMigrationInventory,
    TitleMigrationPlan,
    build_title_migration_plan,
)
from pkm.server.store import (
    append_page_without_rewrite,
    retitle_page_without_rewrite,
    rewrite_snapshotted_blocks,
)
from pkm.server.sync_meta import (
    plain_space_title_canonicalization_active,
    rotate_database_generation,
    set_plain_space_title_canonicalization,
)


@dataclass(frozen=True)
class TitleMigrationOutcome:
    digest: str
    groups_applied: int
    pages_retitled: int
    pages_merged: int
    blocks_moved: int
    blocks_rewritten: int
    generation: str


class StaleTitleMigration(RuntimeError):
    def __init__(self, expected_digest: str, actual_digest: str) -> None:
        super().__init__("title migration audit digest is stale")
        self.expected_digest = expected_digest
        self.actual_digest = actual_digest


class BlockedTitleMigration(RuntimeError):
    def __init__(self, blockers: tuple[InventoryPage, ...]) -> None:
        super().__init__("title migration is blocked by all-space titles")
        self.blockers = blockers


class AlreadyActiveTitleMigration(RuntimeError):
    """Raised when plain-space title canonicalization is already active."""


def _inventory_title_migration(db: sqlite3.Connection) -> TitleMigrationInventory:
    """Gather migration-relevant rows inside the caller's transaction.

    This private gatherer never begins, commits, or rolls back. Audit and apply
    deliberately own different transaction modes and call this same function.
    """
    page_rows = db.execute("SELECT id, title FROM pages ORDER BY id").fetchall()
    candidate_rows = [
        row
        for row in page_rows
        if row["title"] != canonicalize_title(row["title"], plain_space=True)
    ]
    boundary_replacements = {
        row["title"]: canonicalize_title(row["title"], plain_space=True)
        for row in candidate_rows
        if canonicalize_title(row["title"], plain_space=True) != ""
    }
    canonical_titles = set(boundary_replacements.values())
    final_titles = {
        rewrite_title_refs_map(title, boundary_replacements)
        for title in canonical_titles
    }
    selected_rows = [
        row
        for row in page_rows
        if row in candidate_rows
        or row["title"] in canonical_titles
        or row["title"] in final_titles
    ]
    page_ids = {row["id"] for row in selected_rows}
    page_titles = {row["title"] for row in selected_rows}

    all_ref_rows = db.execute(
        "SELECT src_block_uid, target_page_id, kind FROM refs"
    ).fetchall()
    inbound_uids = {
        row["src_block_uid"] for row in all_ref_rows if row["target_page_id"] in page_ids
    }
    all_block_rows = db.execute(
        "SELECT uid, page_id, parent_uid, order_idx, text FROM blocks"
    ).fetchall()
    selected_block_rows = [
        row
        for row in all_block_rows
        if row["page_id"] in page_ids or row["uid"] in inbound_uids
    ]
    selected_ref_rows = [
        row for row in all_ref_rows if row["src_block_uid"] in inbound_uids
    ]
    selected_sidebar_rows = [
        row
        for row in db.execute(
            "SELECT id, title, order_idx FROM sidebar_entries"
        ).fetchall()
        if row["title"] in page_titles
        or row["title"] in canonical_titles
        or row["title"] in final_titles
    ]

    return TitleMigrationInventory(
        active=plain_space_title_canonicalization_active(db),
        pages=tuple(
            InventoryPage(page_id=row["id"], title=row["title"])
            for row in selected_rows
        ),
        blocks=tuple(
            InventoryBlock(
                uid=row["uid"],
                page_id=row["page_id"],
                parent_uid=row["parent_uid"],
                order_idx=row["order_idx"],
                text=row["text"],
            )
            for row in selected_block_rows
        ),
        refs=tuple(
            InventoryRef(
                src_block_uid=row["src_block_uid"],
                target_page_id=row["target_page_id"],
                kind=row["kind"],
            )
            for row in selected_ref_rows
        ),
        sidebars=tuple(
            InventorySidebar(
                sidebar_id=row["id"],
                title=row["title"],
                order_idx=row["order_idx"],
            )
            for row in selected_sidebar_rows
        ),
    )


def audit_title_migration(db: sqlite3.Connection) -> TitleMigrationPlan:
    """Build a stable migration plan in an owned, side-effect-free read transaction."""
    if db.in_transaction:
        raise RuntimeError("title migration audit cannot run inside a caller transaction")
    db.execute("BEGIN")
    try:
        return build_title_migration_plan(_inventory_title_migration(db))
    finally:
        db.rollback()


def apply_title_migration(
    db: sqlite3.Connection, expected_digest: str, now_ms: int
) -> TitleMigrationOutcome:
    """Re-audit, migrate, activate, and rotate generation in one write transaction."""
    if db.in_transaction:
        raise RuntimeError("title migration apply cannot run inside a caller transaction")

    transaction_started = False
    try:
        db.execute("BEGIN IMMEDIATE")
        transaction_started = True
        plan = build_title_migration_plan(_inventory_title_migration(db))
        if plan.digest != expected_digest:
            raise StaleTitleMigration(expected_digest, plan.digest)
        if plan.active:
            raise AlreadyActiveTitleMigration(
                "plain-space title canonicalization is already active"
            )
        if plan.blockers:
            raise BlockedTitleMigration(plan.blockers)

        affected_page_ids = {
            page.page_id
            for group in plan.groups
            for page in (group.survivor, *group.sources)
        }
        inbound_uids = {
            ref.src_block_uid
            for ref in plan.refs
            if ref.target_page_id in affected_page_ids
        }
        block_text_by_uid = {block.uid: block.text for block in plan.blocks}
        snapshots = tuple(
            (uid, block_text_by_uid[uid]) for uid in sorted(inbound_uids)
        )
        replacements = dict(plan.replacements)

        pages_retitled = 0
        for group in plan.groups:
            if group.survivor.title != group.canonical_title:
                retitle_page_without_rewrite(
                    db,
                    group.survivor.page_id,
                    group.survivor.title,
                    group.canonical_title,
                    now_ms,
                )
                pages_retitled += 1

        sources = sorted(
            (
                source.page_id,
                source.title,
                group.survivor.page_id,
                group.canonical_title,
            )
            for group in plan.groups
            for source in group.sources
        )
        blocks_moved = 0
        for source_id, old_title, target_id, new_title in sources:
            blocks_moved += append_page_without_rewrite(
                db, source_id, target_id, old_title, new_title, now_ms
            )

        # Reindex must already use the post-activation title rule. This flag is
        # still transaction-local until COMMIT, and every BaseException below
        # rolls it back with page/text/ref changes, so partial activation is
        # never externally visible.
        set_plain_space_title_canonicalization(db, active=True)
        blocks_rewritten = rewrite_snapshotted_blocks(
            db, snapshots, replacements, now_ms
        )
        generation = rotate_database_generation(db)
        outcome = TitleMigrationOutcome(
            digest=plan.digest,
            groups_applied=len(plan.groups),
            pages_retitled=pages_retitled,
            pages_merged=len(sources),
            blocks_moved=blocks_moved,
            blocks_rewritten=blocks_rewritten,
            generation=generation,
        )
        db.commit()
        return outcome
    except BaseException:
        if transaction_started:
            db.rollback()
        raise
