# pattern: Functional Core
"""Pure pieces of the CLI/MCP HTTP client: config file format, the session
cookie header, and error-message shaping. All I/O lives in client.api."""
from __future__ import annotations

import json
from dataclasses import dataclass


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class CliConfig:
    url: str
    token: str


def parse_config(text: str) -> CliConfig:
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ConfigError(f"config is not valid JSON: {e}")
    if not isinstance(data, dict):
        raise ConfigError("config must be a JSON object")
    url, token = data.get("url"), data.get("token")
    if not isinstance(url, str) or not url.strip():
        raise ConfigError("config is missing 'url'")
    if not isinstance(token, str) or not token.strip():
        raise ConfigError("config is missing 'token'")
    return CliConfig(url=url.rstrip("/"), token=token)


def serialize_config(cfg: CliConfig) -> str:
    return json.dumps({"url": cfg.url, "token": cfg.token}, indent=2) + "\n"


def cookie_header(token: str) -> dict[str, str]:
    return {"Cookie": f"pkm_session={token}"}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


def friendly_error(status: int, detail: object) -> str:
    if status == 401:
        return "session expired or missing — run `pkm login`"
    if isinstance(detail, dict) and "reason" in detail:
        index = detail.get("index")
        prefix = f"op {index}: " if index is not None else ""
        return f"{status}: {prefix}{detail['reason']}"
    return f"{status}: {detail}"
