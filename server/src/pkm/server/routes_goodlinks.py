# pattern: Imperative Shell
"""Proxy the GoodLinks local API for the web app and CLI. GoodLinks only
listens on the host's loopback, so the iPad reaches it through here,
the way /api/local/ fronts the iCloud folder. Every route is behind the
normal session/CLI-token auth. `app.state.goodlinks` is None when no API
key is configured, and then everything here is a 404 except `check`,
which reports `enabled: false`.

GoodLinks not answering (the app is not running) and GoodLinks refusing
the API token are both 503, each with its own fixed detail string, logged
at warning; a GoodLinks 404 passes through as 404; GoodLinks refusing a
save is a 422 carrying its text. A link GoodLinks knows but holds no
reader copy of is the ordinary payload with empty `html`."""
from __future__ import annotations

import logging
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from pkm.contracts.responses import (GoodlinksArticle, GoodlinksCheckPayload,
                                     GoodlinksCheckProblem, GoodlinksLink,
                                     GoodlinksResolveRequest)
from pkm.goodlinks import (GOODLINKS_PREFIX, candidate_urls, extract_goodlinks_hrefs,
                           is_link_id, link_id_from_href, sanitize_article, search_match)
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.goodlinks_gateway import (GoodlinksGateway, GoodlinksRejected,
                                          GoodlinksUnauthorized, GoodlinksUnavailable)

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(require_auth)])

_NOT_FOUND = HTTPException(status_code=404, detail="not found")


def _unavailable(route: str, err: GoodlinksUnavailable) -> HTTPException:
    logger.warning("goodlinks %s: goodlinks unavailable: %s", route, err)
    return HTTPException(status_code=503, detail="Goodlinks is not running on the host")


def _unauthorized(route: str, err: GoodlinksUnauthorized) -> HTTPException:
    logger.warning("goodlinks %s: goodlinks rejected the api token: %s", route, err)
    return HTTPException(status_code=503, detail="Goodlinks rejected the API token")


def get_goodlinks(request: Request) -> GoodlinksGateway:
    gw = request.app.state.goodlinks
    if gw is None:
        raise _NOT_FOUND
    return gw


def _link_payload(raw: dict, created: bool) -> GoodlinksLink:
    return GoodlinksLink(id=str(raw["id"]), title=str(raw.get("title") or ""),
                         url=str(raw["url"]), added_at=str(raw.get("addedAt") or ""),
                         created=created)


@router.post("/api/goodlinks/resolve", response_model=GoodlinksLink)
def resolve_link(body: GoodlinksResolveRequest,
                 gw: GoodlinksGateway = Depends(get_goodlinks)) -> GoodlinksLink:
    candidates = candidate_urls(body.url)
    try:
        for candidate in candidates:
            found = gw.lookup(candidate)
            if found is not None:
                return _link_payload(found, created=False)
        hit = search_match(candidates, gw.search(candidates[-1]))
        if hit is not None:
            return _link_payload(hit, created=False)
        if not body.save:
            raise HTTPException(status_code=404, detail="not in Goodlinks")
        return _link_payload(gw.save(body.url), created=True)
    except GoodlinksUnavailable as e:
        raise _unavailable("resolve", e) from None
    except GoodlinksUnauthorized as e:
        raise _unauthorized("resolve", e) from None
    except GoodlinksRejected as e:
        raise HTTPException(status_code=422, detail=e.detail) from None


@router.get("/api/goodlinks/check", response_model=GoodlinksCheckPayload)
def check_goodlinks_links(request: Request,
                          db: sqlite3.Connection = Depends(get_db)) -> GoodlinksCheckPayload:
    gw: GoodlinksGateway | None = request.app.state.goodlinks
    if gw is None:
        return GoodlinksCheckPayload(enabled=False, total=0, ok=0, problems=[])
    rows = db.execute(
        "SELECT b.uid, p.title, b.text FROM blocks b JOIN pages p ON p.id = b.page_id"
        " WHERE instr(b.text, ?) > 0 ORDER BY p.title, b.uid", (GOODLINKS_PREFIX,)).fetchall()
    total = ok = 0
    problems: list[GoodlinksCheckProblem] = []
    known: dict[str, bool] = {}
    try:
        for uid, title, text in rows:
            for href in extract_goodlinks_hrefs(text):
                total += 1
                link_id = link_id_from_href(href)
                if link_id is None:
                    problems.append(GoodlinksCheckProblem(uid=uid, page=title, href=href, status="invalid"))
                    continue
                if link_id not in known:
                    known[link_id] = gw.link(link_id) is not None
                if known[link_id]:
                    ok += 1
                else:
                    problems.append(GoodlinksCheckProblem(uid=uid, page=title, href=href, status="missing"))
    except GoodlinksUnavailable as e:
        raise _unavailable("check", e) from None
    except GoodlinksUnauthorized as e:
        raise _unauthorized("check", e) from None
    return GoodlinksCheckPayload(enabled=True, total=total, ok=ok, problems=problems)


@router.get("/api/goodlinks/{link_id}", response_model=GoodlinksArticle)
def get_article(link_id: str, response: Response,
                gw: GoodlinksGateway = Depends(get_goodlinks)) -> GoodlinksArticle:
    if not is_link_id(link_id):
        raise _NOT_FOUND
    try:
        meta = gw.link(link_id)
        if meta is None:
            raise _NOT_FOUND
        # A known link with no reader copy (extraction failed, a paywall, a
        # PDF, a page saved seconds ago) still returns its metadata, so the
        # reader can offer the original link.
        html = gw.content(link_id)
    except GoodlinksUnavailable as e:
        raise _unavailable("article", e) from None
    except GoodlinksUnauthorized as e:
        raise _unauthorized("article", e) from None
    # The article can change if it is re-saved, and GoodLinks is local and
    # fast, so nothing is cached.
    response.headers["Cache-Control"] = "private, no-store"
    return GoodlinksArticle(id=link_id, title=str(meta.get("title") or ""), url=str(meta["url"]),
                            added_at=str(meta.get("addedAt") or ""),
                            html=sanitize_article(html) if html is not None else "")
