# pattern: Imperative Shell
"""Server configuration loaded from data/config.json (never in git)."""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, fields
from pathlib import Path
from types import MappingProxyType
from typing import Any

from pkm.server.origin_core import canonical_origin


@dataclass(frozen=True)
class Config:
    db_path: Path
    assets_dir: Path
    password_salt: str   # hex
    password_hash: str   # hex (scrypt)
    session_secret: str  # hex
    cookie_secure: bool = True
    web_dist: Path | None = None  # built SPA dir; None = API-only server
    bind_hosts: tuple[str, ...] = ("127.0.0.1",)
    # Origins browsers use to reach the server through Tailscale Serve, in
    # canonical form (see origin_core.canonical_origin). Empty means only
    # loopback and the `bind_hosts` listeners may open /api/ws or write.
    serve_origins: tuple[str, ...] = ()
    max_upload_bytes: int = 150 * 1024 * 1024
    image_descriptions: bool = True
    image_description_model: str = "gpt-4o-mini"
    # Where the OpenAI key lives on disk (mode 600, never committed) so the
    # feature can be enabled without launchd plist surgery. Default is one
    # level above the data dir (PKM_HOME root, resolved relative to
    # config.json's parent): the data dir holds servable/exportable content
    # (assets, DB), and the key shouldn't sit somewhere a future
    # export/browse feature might sweep it up. The key file wins over the
    # OPENAI_API_KEY env var when both are present (see
    # server/app._default_describe_service).
    openai_api_key_file: Path = Path("../openai_key")
    # z.ai GLM Coding Plan key: same placement rule and precedence as the
    # OpenAI key above (file wins over the ZAI_API_KEY env var). The key IS
    # the plan credential — z.ai has no machine-login flow like Claude's —
    # and enables the assistant's glm model (see server/app.py).
    zai_api_key_file: Path = Path("../zai_key")
    # Root of the on-disk document tree served read-only by
    # GET /api/local/{path} (see routes_local.py). None disables the
    # feature. Relative values resolve against config.json's directory
    # like every other path key; `Path / absolute` yields the absolute
    # path unchanged, so an absolute value passes through.
    local_docs_root: Path | None = None
    # GoodLinks local API (see goodlinks.py / routes_goodlinks.py). Same
    # placement and precedence as the OpenAI key: the file wins over the
    # GOODLINKS_API_KEY env var; no key at all disables the feature.
    goodlinks_api_key_file: Path = Path("../goodlinks_key")
    # Where the GoodLinks app listens. Only the e2e server points this
    # anywhere but the documented localhost port.
    goodlinks_api_url: str = "http://localhost:9428/api/v1"


def _serve_origins(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, list):
        raise ValueError(f"serve_origins must be a list of origins, got "
                         f"{raw!r}")
    origins = []
    for value in raw:
        try:
            origins.append(canonical_origin(str(value)))
        except ValueError as exc:
            raise ValueError(f"serve_origins: {value!r} is not an origin "
                             f"like https://<host>: {exc}") from exc
    return tuple(origins)


# How each optional JSON value becomes its field. A key the file leaves out
# is not passed, so Config's default applies.
_CONVERT: Mapping[str, Callable[..., object]] = MappingProxyType({
    "cookie_secure": lambda value: value,
    "bind_hosts": tuple,
    "serve_origins": _serve_origins,
    "max_upload_bytes": int,
    "image_descriptions": bool,
    "image_description_model": str,
    "goodlinks_api_url": str,
})
_OPTIONAL_DIRS = ("web_dist", "local_docs_root")
# Always passed: a default here is relative to config.json's directory, and
# Config's own default would resolve against the process's working directory.
_KEY_FILES = ("openai_api_key_file", "zai_api_key_file",
              "goodlinks_api_key_file")


def _field_default(name: str) -> object:
    return next(f.default for f in fields(Config) if f.name == name)


def load_config(path: Path) -> Config:
    raw = json.loads(path.read_text(encoding="utf-8"))
    base = path.parent
    # JSON values, converted per key; Config's field types state the contract.
    given: dict[str, Any] = {name: convert(raw[name])
                             for name, convert in _CONVERT.items()
                             if name in raw}
    given |= {name: base / raw[name] if raw[name] else None
              for name in _OPTIONAL_DIRS if name in raw}
    given |= {name: base / raw.get(name, _field_default(name))
              for name in _KEY_FILES}
    return Config(
        db_path=base / raw["db_file"],
        assets_dir=base / raw["assets_dir"],
        password_salt=raw["password_salt"],
        password_hash=raw["password_hash"],
        session_secret=raw["session_secret"],
        **given,
    )
