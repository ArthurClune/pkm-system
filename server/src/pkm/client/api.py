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
    return secrets.token_urlsafe(9)  # 12 urlsafe chars, matches UID_RE


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

    def get_page(self, title: str, bl_limit: int = 100) -> dict:
        return self._request(
            "GET", f"/api/page/{quote(title, safe='/')}",
            params={"bl_limit": bl_limit})

    def get_block(self, uid: str) -> dict:
        return self._request("GET", f"/api/block/{quote(uid, safe='')}")

    def search(self, q: str, limit: int = 20) -> dict:
        return self._request("GET", "/api/search",
                             params={"q": q, "limit": limit})

    def run_query(self, expr: str) -> dict:
        return self._request("GET", "/api/query", params={"expr": expr})

    def todos(self, page: str | None = None) -> dict:
        params = {} if page is None else {"page": page}
        return self._request("GET", "/api/todos", params=params)

    def create_page(self, title: str) -> dict:
        return self._request("POST", "/api/pages", json={"title": title})

    def post_ops(self, ops: list[dict],
                 batch_id: str | None = None) -> dict:
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
