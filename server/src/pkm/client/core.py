# pattern: Functional Core
"""Pure pieces of the CLI/MCP HTTP client: config file format, the session
cookie header, and error-message shaping. All I/O lives in client.api."""
from __future__ import annotations

import json
from dataclasses import dataclass

from pydantic import ValidationError


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


class ResponseSchemaError(ApiError):
    """A 2xx response whose body doesn't match `pkm.contracts` -- the
    models this client was compiled against. Raised at the point of the
    HTTP call, naming the endpoint and the offending field, so contract
    drift surfaces there rather than as a KeyError several frames deep in
    a renderer or planner (pkm-0wr8).

    An ApiError subclass on purpose: the CLI's top-level handler already
    turns ApiError into a one-line stderr message and exit 1, and this is
    a server-side problem the user can do nothing about mid-command.
    `status` is 0, the same "no meaningful HTTP status" value transport
    failures use."""

    def __init__(self, method: str, path: str, detail: str):
        super().__init__(
            0, f"unexpected response from {method} {path}: {detail}"
               " — this client and the server disagree about the payload"
               " contract; one of them is out of date")


def validation_detail(exc: ValidationError) -> str:
    """The first of `exc`'s problems as `field.path: message`, plus a
    count of the rest -- enough to name the field that drifted without
    dumping pydantic's full error list, and without pretending the first
    problem was the only one."""
    errors = exc.errors()
    first = errors[0]
    loc = ".".join(str(p) for p in first["loc"])
    detail = f"{loc}: {first['msg']}" if loc else first["msg"]
    if len(errors) > 1:
        detail += f" (and {len(errors) - 1} more field problem(s))"
    return detail


def friendly_error(status: int, detail: object) -> str:
    if status == 401:
        return "session expired or missing — run `pkm login`"
    if isinstance(detail, dict) and "reason" in detail:
        index = detail.get("index")
        prefix = f"op {index}: " if index is not None else ""
        return f"{status}: {prefix}{detail['reason']}"
    return f"{status}: {detail}"
