# pattern: Imperative Shell
"""Authenticated title-canonicalization audit/apply routes."""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request

from pkm.contracts.responses import (
    TitleMigrationApplyRequest,
    TitleMigrationApplyResponse,
    TitleMigrationAuditPayload,
    TitleMigrationBlocker,
    TitleMigrationGroup,
    TitleMigrationPage,
    TitleMigrationSidebarRetitle,
)
from pkm.database import Db
from pkm.server import notify
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.store import RewriteTextLimitError
from pkm.server.title_migration import (
    AlreadyActiveTitleMigration,
    BlockedTitleMigration,
    StaleTitleMigration,
    TitleMigrationPlan,
    apply_title_migration,
    audit_title_migration,
)

router = APIRouter(dependencies=[Depends(require_auth)])


def _audit_payload(plan: TitleMigrationPlan) -> TitleMigrationAuditPayload:
    return TitleMigrationAuditPayload(
        active=plan.active,
        digest=plan.digest,
        groups=[
            TitleMigrationGroup(
                canonical_title=group.canonical_title,
                survivor=TitleMigrationPage(
                    page_id=group.survivor.page_id,
                    title=group.survivor.title,
                ),
                sources=[
                    TitleMigrationPage(page_id=page.page_id, title=page.title)
                    for page in group.sources
                ],
                has_clean_twin=group.has_clean_twin,
                block_count=group.block_count,
                inbound_ref_count=group.inbound_ref_count,
                sidebar_count=group.sidebar_count,
            )
            for group in plan.groups
        ],
        blockers=[
            TitleMigrationBlocker(
                page_id=blocker.page_id,
                title=blocker.title,
                reason=blocker.reason,
            )
            for blocker in plan.blockers
        ],
        sidebar_retitles=[
            TitleMigrationSidebarRetitle(
                sidebar_id=retitle.sidebar_id,
                title=retitle.title,
                canonical_title=retitle.canonical_title,
            )
            for retitle in plan.sidebar_retitles
        ],
    )


@router.get(
    "/api/migrations/title-canonicalization",
    response_model=TitleMigrationAuditPayload,
)
def audit_title_canonicalization(
    db: Db = Depends(get_db),
) -> TitleMigrationAuditPayload:
    return _audit_payload(audit_title_migration(db))


@router.post(
    "/api/migrations/title-canonicalization",
    response_model=TitleMigrationApplyResponse,
)
def apply_title_canonicalization(
    request: Request,
    body: TitleMigrationApplyRequest,
    db: Db = Depends(get_db),
) -> TitleMigrationApplyResponse:
    try:
        outcome = apply_title_migration(
            db, body.audit_digest, now_ms=int(time.time() * 1000)
        )
    except (
        StaleTitleMigration,
        BlockedTitleMigration,
        AlreadyActiveTitleMigration,
    ) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except RewriteTextLimitError as exc:
        raise HTTPException(status_code=409,
                            detail=f"title migration refused: {exc}") from None
    notify.nudge_threadpool(
        request,
        db,
        force=True,
        generation=outcome.generation,
    )
    return TitleMigrationApplyResponse(
        digest=outcome.digest,
        groups_applied=outcome.groups_applied,
        pages_retitled=outcome.pages_retitled,
        pages_merged=outcome.pages_merged,
        blocks_moved=outcome.blocks_moved,
        blocks_rewritten=outcome.blocks_rewritten,
        sidebars_retitled=outcome.sidebars_retitled,
        generation=outcome.generation,
    )
