# pattern: Imperative Shell
"""Authenticated title-canonicalization audit/apply routes."""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request

from pkm.contracts.responses import (
    TitleMigrationApplyRequest,
    TitleMigrationApplyResponse,
    TitleMigrationAuditPayload,
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
        groups=list(plan.groups),
        blockers=list(plan.blockers),
        sidebar_retitles=list(plan.sidebar_retitles),
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
    return outcome
