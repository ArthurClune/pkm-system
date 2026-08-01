# pattern: Imperative Shell
"""HTTP client for the PKM server, shared by the CLI and the MCP server.
Owns all I/O: config file, uid randomness, and HTTP. An injected
httpx2-compatible client (FastAPI's TestClient in tests) replaces the
network."""
from __future__ import annotations

import mimetypes
import os
import secrets
from pathlib import Path
from urllib.parse import quote

import httpx2

from pkm.client.core import (ApiError, CliConfig, ConfigError, cookie_header,
                             friendly_error, parse_config, serialize_config)
from pkm.refs import normalize_title
from pkm.server.ops_core import OpBatch

CLIENT_ID = "pkm-cli"


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

    def _request(self, method: str, path: str, **kw) -> dict:
        try:
            r = self._http.request(method, path, headers=self._headers, **kw)
        except httpx2.TransportError:
            raise ApiError(0, f"cannot reach {self._config.url}"
                              " — is the server running?")
        if r.status_code >= 400:
            raise ApiError(r.status_code,
                           friendly_error(r.status_code, _detail(r)))
        return r.json()

    def get_page(self, title: str, bl_limit: int = 100,
                bl_offset: int = 0) -> dict:
        return self._request(
            "GET", f"/api/page/{quote(title, safe='/')}",
            params={"bl_limit": bl_limit, "bl_offset": bl_offset})

    def get_backlinks(self, title: str, page_size: int = 100) -> dict:
        """Every backlink group for `title`, looping /api/page's
        pagination (capped server-side at 100 groups per request,
        routes_pages.py) until none remain. The CLI/MCP wording promises
        the complete backlink list, so returning only the first page
        here would silently truncate it (pkm-3cyg -- no silent
        truncation)."""
        offset = 0
        groups: list[dict] = []
        total = 0
        while True:
            payload = self.get_page(title, bl_limit=page_size,
                                    bl_offset=offset)
            backlinks = payload["backlinks"]
            total = backlinks["total_pages"]
            new_groups = backlinks["groups"]
            if not new_groups:
                break
            groups.extend(new_groups)
            offset += len(new_groups)
            if len(groups) >= total:
                break
        return {"groups": groups, "total_pages": total, "offset": 0,
                "limit": len(groups)}

    def get_page_or_placeholder(self, title: str) -> tuple[dict, bool]:
        """Fetch `title`, or an empty placeholder (no blocks) if it
        doesn't exist yet -- (payload, missing). Never creates the page
        itself: a batch that references a missing title folds a
        create_page op for it into the same OpBatch as whatever else the
        batch does, so creation commits atomically with the rest instead
        of persisting from a separate request even when the batch later
        fails validation (pkm-w80k).

        Looks up `normalize_title(title)`, not `title` verbatim: every page
        creation path (store.get_or_create_page) normalizes a title's
        control whitespace before storing it (pkm-hjhy), so a page born
        from "Foo\\tBar" is only ever addressable as "Foo Bar". A caller
        that still holds the pre-normalization spelling -- e.g. a second
        `pkm save`/`save_note` to the same page -- would otherwise get a
        false "missing" here and plan its next write against an empty
        placeholder instead of the page's real, already-saved blocks
        (pkm-5k8p). The op(s) this caller goes on to build still carry the
        caller's original `title` string for `page_title`: that is fine,
        since the server normalizes it again at the same choke point and
        lands on this identical row either way."""
        try:
            return self.get_page(normalize_title(title)), False
        except ApiError as e:
            if e.status != 404:
                raise
            return {"blocks": []}, True

    def get_block(self, uid: str) -> dict:
        return self._request("GET", f"/api/block/{quote(uid, safe='')}")

    def search(self, q: str, limit: int = 20, exact: bool = False) -> dict:
        params: dict = {"q": q, "limit": limit}
        if exact:
            params["exact"] = "true"
        return self._request("GET", "/api/search", params=params)

    def run_query(self, expr: str, expand: bool = False) -> dict:
        params = {"expr": expr}
        if expand:
            params["expand"] = "true"
        return self._request("GET", "/api/query", params=params)

    def todos(self, page: str | None = None) -> dict:
        params = {} if page is None else {"page": page}
        return self._request("GET", "/api/todos", params=params)

    def create_page(self, title: str) -> dict:
        return self._request("POST", "/api/pages", json={"title": title})

    def post_ops(self, ops: list[dict], batch_id: str) -> dict:
        try:
            batch = OpBatch(client_id=CLIENT_ID, batch_id=batch_id, ops=ops)
        except ValueError as e:
            raise ApiError(422, f"invalid ops: {e}")
        return self._request("POST", "/api/ops",
                             json=batch.model_dump(mode="json"))

    def upload(self, path: Path) -> dict:
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        with open(path, "rb") as fh:
            return self._request(
                "POST", "/api/assets",
                files={"file": (path.name, fh, mime)})

    def search_assets(self, q: str, limit: int = 50) -> dict:
        return self._request("GET", "/api/assets/search",
                             params={"q": q, "limit": limit})

    def scan_assets(self, force: bool = False) -> dict:
        params = {"force": "true"} if force else {}
        return self._request("POST", "/api/assets/scan", params=params)
