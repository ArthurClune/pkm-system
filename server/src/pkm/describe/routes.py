# pattern: Imperative Shell
"""Describe-feature routes: status + retro-scan (pkm-zc0c). Asset search
lives in routes_assets.py with the other asset routes."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Request

from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.response_models import DescribeStatusPayload, ScanPayload

router = APIRouter(dependencies=[Depends(require_auth)])


@router.get("/api/assets/describe-status", response_model=DescribeStatusPayload)
async def describe_status(request: Request) -> dict:
    service = request.app.state.describe
    return {"enabled": service.enabled, "reason": service.reason}


@router.post("/api/assets/scan", response_model=ScanPayload)
async def scan(request: Request, force: bool = False,
               db: sqlite3.Connection = Depends(get_db)) -> dict:
    service = request.app.state.describe
    queued = service.scan(db, force=force)
    return {"queued": queued, "enabled": service.enabled,
            "reason": service.reason}
