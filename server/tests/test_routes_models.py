"""Every JSON route returns its response model, and a read whose joined row
has gone missing still passes the row check."""
from __future__ import annotations

import typing

from fastapi.routing import APIRoute

from pkm.server.app import create_app
from pkm.server.db import open_db


def _api_routes(routes) -> typing.Iterator[APIRoute]:
    """Every APIRoute under `routes`, descending into included routers."""
    for route in routes:
        if isinstance(route, APIRoute):
            yield route
        else:
            inner = getattr(route, "original_router", None)
            if inner is not None:
                yield from _api_routes(inner.routes)


def _bare_dict_handlers(app) -> list[str]:
    bad = []
    for route in _api_routes(app.routes):
        hints = typing.get_type_hints(route.endpoint)
        ret = hints.get("return")
        if ret is dict or typing.get_origin(ret) is dict:
            bad.append(f"{sorted(route.methods or ())} {route.path}")
    return bad


def test_no_handler_returns_a_bare_dict(seeded_config):
    app = create_app(seeded_config)
    assert len(list(_api_routes(app.routes))) > 40  # the walk found them
    assert _bare_dict_handlers(app) == []


def test_a_ref_to_a_missing_page_does_not_fail_the_reads(client, seeded_config):
    """A refs row whose target page row is gone (foreign keys off, as in a
    damaged file) is skipped by the backlink and journal reads, not raised
    on by the row check."""
    con = open_db(seeded_config.db_path)
    con.execute("PRAGMA foreign_keys = OFF")
    con.execute("INSERT INTO refs VALUES (?,?,?)", ("uid_b4", 999, "link"))
    con.commit()
    con.close()
    assert client.get("/api/page/Paper").status_code == 200
    assert client.get("/api/journal").status_code == 200
    assert client.get("/api/page/Machine Learning").status_code == 200
