"""One app, driven in-process the way uvicorn drives it, for properties
that send many requests: requests go through httpx's ASGI transport (one
event loop for the whole module), logged in with a minted session cookie
(logging in costs a scrypt per call), and `reset` restores the database
from a template between examples.

Not TestClient: starlette's decodes a path's percent-escapes a second
time before routing; uvicorn decodes once, as the ASGI transport does."""
import asyncio
import json
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
from conftest import make_config, seed_db
from fake_engine import FakeEngine
from fastapi import FastAPI
from fastapi.routing import APIRoute
from rawread import read, table_rows
from test_routes_models import _api_routes

from pkm.database import Db
from pkm.server.app import create_app
from pkm.server.auth import COOKIE_NAME
from pkm.server.auth_core import sign_session
from pkm.server.db import open_db


@dataclass
class Harness:
    app: FastAPI
    db_path: Path
    template: Db
    loop: asyncio.AbstractEventLoop
    client: httpx.AsyncClient
    routes: list[APIRoute]
    token: str

    def reset(self, source: Db | None = None) -> None:
        """Restore the database from the seeded template, or from
        `source`."""
        (source or self.template).backup_to(self.db_path)

    def send(self, method: str, url: str, **kwargs) -> httpx.Response:
        request = self.client.build_request(method, url, **kwargs)
        return self.loop.run_until_complete(self.client.send(request))


@contextmanager
def open_harness(root: Path, **app_kwargs) -> Generator[Harness]:
    """A harness over the conftest seed database in `root`, its app built
    with `app_kwargs` passed to create_app."""
    config = make_config(root)
    seed_db(config.db_path)
    seeded = open_db(config.db_path)
    seeded.backup_to(root / "template.sqlite3")
    seeded.close()
    template = open_db(root / "template.sqlite3")
    with pytest.MonkeyPatch.context() as env:
        # Built once per module, before conftest's per-test scrub runs: a
        # key in the environment would switch on a real upstream.
        for key in ("OPENAI_API_KEY", "ZAI_API_KEY", "GOODLINKS_API_KEY"):
            env.delenv(key, raising=False)
        app = create_app(config, assistant_engine=FakeEngine(), **app_kwargs)
    loop = asyncio.new_event_loop()
    token = sign_session(bytes.fromhex(config.session_secret),
                         int(time.time() * 1000))
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver", cookies={COOKIE_NAME: token})
    routes = sorted(_api_routes(app.routes), key=lambda r: r.path)
    try:
        yield Harness(app, config.db_path, template, loop, client, routes,
                      token)
    finally:
        loop.run_until_complete(client.aclose())
        loop.close()
        template.close()


def encode_segment(value: object) -> str:
    """`value` percent-encoded from its UTF-8 bytes, a lone surrogate
    included (as the invalid UTF-8 a client can send)."""
    text = value if isinstance(value, str) else json.dumps(value)
    return quote(text.encode("utf-8", "surrogatepass"), safe="")


_TABLES = ("SELECT name FROM sqlite_master WHERE type = 'table'"
           " AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%'")


def check_every_row(db_path: Path) -> None:
    """Read every row of every table under its row key, so the row check
    (PKM_ROW_CHECK, set by conftest) validates all of them."""
    db = open_db(db_path)
    try:
        for (table,) in read(db, _TABLES).fetchall():
            table_rows(db, table)
    finally:
        db.close()
