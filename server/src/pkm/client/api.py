# pattern: Imperative Shell
"""HTTP client for the PKM server, shared by the CLI and the MCP server.
Owns all I/O: config file, uid randomness, and HTTP. An injected
httpx2-compatible client (FastAPI's TestClient in tests) replaces the
network.

Every method returns a validated `pkm.contracts` model, never a bare
dict: the same models the server serializes its responses with, so a
payload that drifts fails here -- naming the endpoint and the field --
instead of surfacing as a KeyError inside a renderer or planner
(pkm-0wr8). Nothing in this package imports `pkm.server`; the contracts
package is the only thing both halves share."""
from __future__ import annotations

import mimetypes
import os
import secrets
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, TypeVar
from urllib.parse import quote

import httpx2
from pydantic import BaseModel, ValidationError

from pkm.client.core import (ApiError, CliConfig, ConfigError,
                             ResponseSchemaError, cookie_header,
                             friendly_error, parse_config, serialize_config,
                             validation_detail)
from pkm.contracts.ops import BlockOp, OpBatch
from pkm.contracts.responses import (AssetDeleteAck, AssetSearchPayload,
                                     AssetUploadResponse, Backlinks,
                                     BlockNode, BlockPayload, GroupsPayload,
                                     OpsAck, PagePayload,
                                     QueryPayload, ScanPayload, SearchPayload,
                                     TitleMigrationApplyRequest,
                                     TitleMigrationApplyResponse,
                                     TitleMigrationAuditPayload)
from pkm.refs import normalize_title

CLIENT_ID = "pkm-cli"
_BACKLINK_MAX_ATTEMPTS = 5

M = TypeVar("M", bound=BaseModel)


def config_path() -> Path:
    env = os.environ.get("PKM_CLI_CONFIG")
    if env:
        return Path(env)
    return Path.home() / ".config" / "pkm-cli" / "config.json"


def load_config() -> CliConfig:
    path = config_path()
    if not path.is_file():
        raise ConfigError(f"no config at {path} — run `pkm login` first")
    cfg = parse_config(path.read_text())
    url = os.environ.get("PKM_URL")
    if url:
        cfg = CliConfig(url=url.rstrip("/"), token=cfg.token)
    return cfg


def save_config(cfg: CliConfig) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(serialize_config(cfg))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, path)


def new_uid() -> str:
    # 12 urlsafe chars, matches UID_RE. token_urlsafe's alphabet includes
    # '-' and '_', which argparse would treat as an option prefix in a bare
    # CLI argument (pkm-y5yv); retry until the first char is alphanumeric.
    while True:
        uid = secrets.token_urlsafe(9)
        if uid[0].isalnum():
            return uid


def login(url: str, password: str,
          http: httpx2.Client | None = None) -> str:
    url = url.rstrip("/")
    client = http if http is not None else httpx2.Client(base_url=url)
    try:
        r = client.post("/api/login", json={"password": password})
    except httpx2.TransportError:
        raise ApiError(0, f"cannot reach {url} — is the server running?")
    if r.status_code >= 400:
        raise ApiError(r.status_code, friendly_error(r.status_code,
                                                     _detail(r)))
    token = r.cookies.get("pkm_session")
    if not token:
        raise ApiError(0, "login response did not set a session cookie")
    return token


def _detail(r: httpx2.Response) -> object:
    try:
        return r.json().get("detail", r.text)
    except ValueError:
        return r.text


class PkmClient:
    def __init__(self, config: CliConfig,
                 http: httpx2.Client | None = None):
        self._config = config
        self._http = http if http is not None else httpx2.Client(
            base_url=config.url, timeout=30)
        self._headers = cookie_header(config.token)

    def _request(self, method: str, path: str, model: type[M], **kw) -> M:
        """One request, decoded into `model`. A body that isn't JSON, or
        that doesn't satisfy the contract, raises ResponseSchemaError --
        the client refuses to hand a half-understood payload onward."""
        try:
            r = self._http.request(method, path, headers=self._headers, **kw)
        except httpx2.TransportError:
            raise ApiError(0, f"cannot reach {self._config.url}"
                              " — is the server running?")
        if r.status_code >= 400:
            raise ApiError(r.status_code,
                           friendly_error(r.status_code, _detail(r)))
        try:
            body = r.json()
        except ValueError:
            raise ResponseSchemaError(method, path,
                                      "body is not JSON") from None
        try:
            return model.model_validate(body)
        except ValidationError as e:
            raise ResponseSchemaError(method, path,
                                      validation_detail(e)) from None

    def get_page(self, title: str, bl_limit: int = 100,
                bl_offset: int = 0) -> PagePayload:
        title = normalize_title(title)
        return self._request(
            "GET", f"/api/page/{quote(title, safe='/')}", PagePayload,
            params={"bl_limit": bl_limit, "bl_offset": bl_offset})

    def get_backlinks(self, title: str, page_size: int = 100) -> Backlinks:
        """Every backlink group for `title`, looping /api/page's
        pagination (capped server-side at 100 groups per request,
        routes_pages.py) until none remain. The CLI/MCP wording promises
        the complete backlink list, so returning only the first page
        here would silently truncate it (pkm-3cyg -- no silent
        truncation).

        The route sorts backlink sources by (updated_at DESC, title) --
        an order that's only stable across this method's sequential
        requests if no source page's updated_at changes in between, e.g.
        a concurrent write landing mid-fetch (plausible with a
        multi-process CLI/MCP). If a source's rank shifts across a page
        boundary while fetching, `_fetch_backlinks_once` detects the
        resulting duplicate/mismatch and the whole fetch restarts from
        offset 0, up to `_BACKLINK_MAX_ATTEMPTS` times -- never silently
        returning the skipped/duplicated set that ordering shift would
        otherwise produce."""
        title = normalize_title(title)
        for _ in range(_BACKLINK_MAX_ATTEMPTS):
            attempt = self._fetch_backlinks_once(title, page_size)
            if attempt is not None:
                return attempt
        raise ApiError(
            0, f"backlinks for {title!r} kept reordering mid-fetch across"
               f" {_BACKLINK_MAX_ATTEMPTS} attempts — try again")

    def _fetch_backlinks_once(self, title: str,
                              page_size: int) -> Backlinks | None:
        """One attempt at fetching every backlink group for `title`.
        Returns None if the server's reported ordering shifted mid-fetch
        -- a page_id reappearing, `total_pages` changing between
        requests, or fewer distinct pages arriving than promised -- so
        the caller can restart instead of accepting a possibly
        incomplete or duplicated result."""
        offset = 0
        seen_page_ids: set[int] = set()
        groups = []
        total: int | None = None
        observed_limit: int | None = None
        while True:
            backlinks = self.get_page(title, bl_limit=page_size,
                                      bl_offset=offset).backlinks
            if observed_limit is None:
                observed_limit = backlinks.limit
            if total is None:
                total = backlinks.total_pages
            elif backlinks.total_pages != total:
                return None  # total shifted mid-fetch -- restart
            new_groups = backlinks.groups
            if not new_groups:
                break
            for g in new_groups:
                if g.page_id in seen_page_ids:
                    return None  # a source reappeared -- restart
                seen_page_ids.add(g.page_id)
            groups.extend(new_groups)
            offset += len(new_groups)
            if len(groups) >= total:
                break
        total = total or 0
        if len(groups) != total:
            return None  # fewer distinct pages arrived than promised
        return Backlinks(groups=groups, total_pages=total, offset=0,
                         limit=observed_limit or 0)

    def get_page_blocks(self, title: str) -> tuple[list[BlockNode], bool]:
        """The blocks of `title`, or an empty list if the page doesn't
        exist yet -- (blocks, missing). Never creates the page itself: a
        batch that references a missing title folds a create_page op for
        it into the same OpBatch as whatever else the batch does, so
        creation commits atomically with the rest instead of persisting
        from a separate request even when the batch later fails
        validation (pkm-w80k). This client deliberately exposes no
        page-creation method at all -- `POST /api/pages` is the web app's
        route -- so that separate-request shape has nowhere to come back
        from.

        Blocks are all a planner needs, and are the only part of a page
        payload a missing page could honestly stand in for -- there is no
        page id or timestamp to invent.

        Looks up `normalize_title(title)`, not `title` verbatim: every page
        creation path (store.get_or_create_page) normalizes a title's
        control whitespace before storing it (pkm-hjhy), so a page born
        from "Foo\\tBar" is only ever addressable as "Foo Bar". A caller
        that still holds the pre-normalization spelling -- e.g. a second
        `pkm save`/`save_note` to the same page -- would otherwise get a
        false "missing" here and plan its next write against an empty
        page instead of the page's real, already-saved blocks (pkm-5k8p).
        The op(s) this caller goes on to build still carry the caller's
        original `title` string for `page_title`: that is fine, since the
        server normalizes it again at the same choke point and lands on
        this identical row either way."""
        try:
            return self.get_page(normalize_title(title)).blocks, False
        except ApiError as e:
            if e.status != 404:
                raise
            return [], True

    def get_block(self, uid: str) -> BlockPayload:
        return self._request("GET", f"/api/block/{quote(uid, safe='')}",
                             BlockPayload)

    def search(self, q: str, limit: int = 20,
               exact: bool = False) -> SearchPayload:
        params: dict = {"q": q, "limit": limit}
        if exact:
            params["exact"] = "true"
        return self._request("GET", "/api/search", SearchPayload,
                             params=params)

    def run_query(self, expr: str, expand: bool = False) -> QueryPayload:
        params = {"expr": expr}
        if expand:
            params["expand"] = "true"
        return self._request("GET", "/api/query", QueryPayload, params=params)

    def todos(self, page: str | None = None) -> GroupsPayload:
        params = {} if page is None else {"page": page}
        return self._request("GET", "/api/todos", GroupsPayload,
                             params=params)

    def audit_title_migration(self) -> TitleMigrationAuditPayload:
        return self._request("GET", "/api/migrations/title-canonicalization",
                             TitleMigrationAuditPayload)

    def apply_title_migration(
        self, audit_digest: str
    ) -> TitleMigrationApplyResponse:
        try:
            request = TitleMigrationApplyRequest(audit_digest=audit_digest)
        except ValueError as e:
            raise ApiError(422, f"invalid title migration apply request: {e}")
        return self._request(
            "POST", "/api/migrations/title-canonicalization",
            TitleMigrationApplyResponse,
            json=request.model_dump(mode="json"),
        )

    def post_ops(self, ops: Sequence[BlockOp | Mapping[str, Any]],
                 batch_id: str) -> OpsAck:
        """Apply `ops` as one atomic batch. The planners in `pkm.cli.build`
        hand over contract models; raw mappings are accepted too (tests and
        one-off scripts write ops by hand) and validated identically by
        OpBatch, so a malformed op fails here with 422 rather than on the
        wire."""
        try:
            batch = OpBatch(client_id=CLIENT_ID, batch_id=batch_id,
                            ops=list(ops))
        except ValueError as e:
            raise ApiError(422, f"invalid ops: {e}")
        return self._request("POST", "/api/ops", OpsAck,
                             json=batch.model_dump(mode="json"))

    def upload(self, path: Path) -> AssetUploadResponse:
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        with open(path, "rb") as fh:
            return self._request(
                "POST", "/api/assets", AssetUploadResponse,
                files={"file": (path.name, fh, mime)})

    def search_assets(self, q: str, limit: int = 50) -> AssetSearchPayload:
        return self._request("GET", "/api/assets/search", AssetSearchPayload,
                             params={"q": q, "limit": limit})

    def delete_asset(self, sha256: str) -> AssetDeleteAck:
        return self._request("DELETE", f"/api/assets/{sha256}",
                             AssetDeleteAck)

    def scan_assets(self, force: bool = False) -> ScanPayload:
        params = {"force": "true"} if force else {}
        return self._request("POST", "/api/assets/scan", ScanPayload,
                             params=params)
