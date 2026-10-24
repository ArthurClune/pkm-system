# pattern: Imperative Shell
"""Transactional database inventory and apply shell for title migration."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from pkm.contracts.ops import Sha256Hex
from pkm.database import Db
from pkm.contracts.titles import RawTitle
from pkm.refs import target_canonical_title, title_syntax_reason
from pkm.title_migration import (
    InventoryBlock,
    InventoryPage,
    InventoryRef,
    InventorySidebar,
    TitleMigrationBlocker,
    TitleMigrationInventory,
    TitleMigrationPlan,
    build_title_migration_plan,
    noncanonical_titles,
)
from pkm.server.db import open_db
from pkm.server.store import (
    append_page_without_rewrite,
    retitle_page_without_rewrite,
    rewrite_snapshotted_blocks,
)
from pkm.server.sync_meta import (
    plain_space_title_canonicalization_active,
    rotate_database_generation,
    set_plain_space_title_canonicalization,
    title_reader,
)

logger = logging.getLogger("pkm.titles")

# How many offending titles the startup report names; the count covers all.
_REPORTED_TITLE_SAMPLE = 20


@dataclass(frozen=True)
class TitleMigrationOutcome:
    digest: Sha256Hex
    groups_applied: int
    pages_retitled: int
    pages_merged: int
    blocks_moved: int
    blocks_rewritten: int
    generation: str


class StaleTitleMigration(RuntimeError):
    def __init__(self, expected_digest: Sha256Hex,
                actual_digest: Sha256Hex) -> None:
        super().__init__("title migration audit digest is stale")
        self.expected_digest = expected_digest
        self.actual_digest = actual_digest


class BlockedTitleMigration(RuntimeError):
    def __init__(self, blockers: tuple[TitleMigrationBlocker, ...]) -> None:
        super().__init__("title migration is blocked by invalid titles")
        self.blockers = blockers


class AlreadyActiveTitleMigration(RuntimeError):
    """Raised when plain-space title canonicalization is already active."""


def _inventory_title_migration(db: Db) -> TitleMigrationInventory:
    """Gather migration-relevant rows inside the caller's transaction.

    This private gatherer never begins, commits, or rolls back. Audit and apply
    deliberately own different transaction modes and call this same function.
    """
    page_rows = db.select(
        "SELECT id AS page_id, title FROM pages ORDER BY id")
    candidate_rows = [
        row
        for row in page_rows
        if row["title"] != target_canonical_title(row["title"])
    ]
    canonical_titles = {
        target_canonical_title(row["title"])
        for row in candidate_rows
        if target_canonical_title(row["title"]) != ""
    }
    forbidden_rows = [
        row
        for row in page_rows
        if title_syntax_reason(
            target_canonical_title(row["title"])
        ) is not None
    ]
    selected_rows = [
        row
        for row in page_rows
        if row in candidate_rows
        or row["title"] in canonical_titles
        or row in forbidden_rows
    ]
    page_ids = {row["page_id"] for row in selected_rows}
    page_titles = {row["title"] for row in selected_rows}

    all_ref_rows = db.select(
        "SELECT src_block_uid, target_page_id,"
        " kind AS ref_kind FROM refs"
    )
    inbound_uids = {
        row["src_block_uid"] for row in all_ref_rows if row["target_page_id"] in page_ids
    }
    all_block_rows = db.select(
        "SELECT uid, page_id, parent_uid, order_idx, text FROM blocks"
    )
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
        for row in db.select(
            "SELECT id AS sidebar_entry_id, title,"
            " order_idx AS sidebar_order_idx FROM sidebar_entries"
        )
        if row["title"] in page_titles or row["title"] in canonical_titles
    ]

    return TitleMigrationInventory(
        active=plain_space_title_canonicalization_active(db),
        pages=tuple(
            InventoryPage(page_id=row["page_id"], title=row["title"])
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
                kind=row["ref_kind"],
            )
            for row in selected_ref_rows
        ),
        sidebars=tuple(
            InventorySidebar(
                sidebar_id=row["sidebar_entry_id"],
                title=row["title"],
                order_idx=row["sidebar_order_idx"],
            )
            for row in selected_sidebar_rows
        ),
    )


def audit_title_migration(db: Db) -> TitleMigrationPlan:
    """Build a stable migration plan in an owned, side-effect-free read
    transaction."""
    if db.in_transaction:
        raise RuntimeError("title migration audit cannot run inside a caller transaction")
    db.execute("BEGIN")
    try:
        return build_title_migration_plan(_inventory_title_migration(db))
    finally:
        db.rollback()


def apply_title_migration(
    db: Db, expected_digest: Sha256Hex, now_ms: int
) -> TitleMigrationOutcome:
    """Re-audit, migrate, activate, and rotate generation in one write
    transaction."""
    if db.in_transaction:
        raise RuntimeError("title migration apply cannot run inside a caller transaction")

    transaction_started = False
    try:
        db.begin_immediate()
        transaction_started = True
        plan = build_title_migration_plan(_inventory_title_migration(db))
        if plan.digest != expected_digest:
            raise StaleTitleMigration(expected_digest, plan.digest)
        if plan.blockers:
            raise BlockedTitleMigration(plan.blockers)
        # An active database still has work when the fold rule changed
        # after it was activated: pages that now share a spelling, which
        # no key can reach apart. Only with nothing to merge or retitle is
        # a second generation rotation pointless.
        if plan.active and not plan.groups:
            raise AlreadyActiveTitleMigration(
                "plain-space title canonicalization is already active"
            )

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
            (uid, block_text_by_uid[uid])
            for uid in sorted(inbound_uids)
        )
        # rewrite_snapshotted_blocks matches replacement keys against raw
        # text spans, so the keys widen to plain str here; the values
        # (CanonicalTitle) pass as RawTitle, which any title kind satisfies.
        replacements: dict[str, RawTitle] = {
            old: new for old, new in plan.replacements.items()
        }

        pages_retitled = 0
        for group in plan.groups:
            if not group.has_clean_twin:
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
                db, source_id, target_id, old_title,
                new_title, now_ms
            )

        blocks_rewritten = rewrite_snapshotted_blocks(
            db, snapshots, replacements, now_ms, title_reader(db)
        )
        set_plain_space_title_canonicalization(db, active=True)
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


def report_noncanonical_titles(db_path: Path) -> int:
    """Log one ERROR naming the stored page and sidebar titles the live
    rule would change, and return how many there are.

    Such a row survives a change to the title rule on a database already
    activated under the old one. A lookup key folds, so nothing reaches
    it until the audited migration merges or retitles it. The check only
    reports: startup never migrates, because a merge is irreversible and
    stays a digest-confirmed operator action, and refusing to start would
    take the HTTP route that remedy needs down with it."""
    db = open_db(db_path)
    try:
        stored = [
            row["title"]
            for row in db.select("SELECT title FROM pages")
            + db.select("SELECT title FROM sidebar_entries")
        ]
        offending = noncanonical_titles(stored, title_reader(db))
    finally:
        db.close()
    if offending:
        sample = ", ".join(
            repr(text) for text in offending[:_REPORTED_TITLE_SAMPLE])
        more = len(offending) - _REPORTED_TITLE_SAMPLE
        logger.error(
            "non-canonical stored titles, which no lookup reaches: %d (%s%s)."
            " Run `pkm migrate-titles` to audit them, then apply its digest.",
            len(offending), sample,
            f" and {more} more" if more > 0 else "",
        )
    return len(offending)
