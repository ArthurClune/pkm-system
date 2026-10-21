"""No route answers hostile input with a 500. Every API route the app
serves is found by walking its routes, and each request draws its path,
query and body values from the route's own parameter types (tests/
hostile.py): lone surrogates, control characters, NUL, NFD, padding and
blank titles, `[[`, very long text, NaN and Infinity, the wrong type, a
missing or extra field, and the seeded titles and uids so a request also
reaches the paths a real value opens.

The property: every answer is a 2xx or a 4xx, never a 5xx or an
exception, and after a 2xx every table still passes the row check.

Requests go through httpx's ASGI transport rather than TestClient, which
decodes a path's percent-escapes twice; uvicorn decodes once. A path or
query value is percent-encoded from its UTF-8 bytes with surrogatepass,
so a lone surrogate arrives as the invalid UTF-8 a client can send. The
database is restored from a seeded copy before every example."""
import asyncio
import json
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
from conftest import make_config, seed_db
from fake_engine import FakeEngine
from fastapi import FastAPI
from fastapi.params import File, Form
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from hostile import (LONE_HIGH, LONE_LOW, event, for_annotation, hostile_text,
                     json_value, value_labels)
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from rawread import read, table_rows
from test_routes_models import _api_routes

from pkm.batch import BatchCommand
from pkm.client.api import PkmClient
from pkm.client.core import ApiError, CliConfig
from pkm.client.workflows import apply_batch
from pkm.contracts.text import well_formed_tree
from pkm.planning import BuildError
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

    def reset(self) -> None:
        self.template.backup_to(self.db_path)

    def send(self, method: str, url: str, **kwargs) -> httpx.Response:
        request = self.client.build_request(method, url, **kwargs)
        return self.loop.run_until_complete(self.client.send(request))


@pytest.fixture(scope="module")
def harness(tmp_path_factory) -> Iterator[Harness]:
    root = tmp_path_factory.mktemp("no500")
    config = make_config(root)
    seed_db(config.db_path)
    seeded = open_db(config.db_path)
    seeded.backup_to(root / "template.sqlite3")
    seeded.close()
    template = open_db(root / "template.sqlite3")
    with pytest.MonkeyPatch.context() as env:
        # Module-scoped, so conftest's per-test scrub has not run yet: a
        # key in the environment would switch on a real upstream.
        for key in ("OPENAI_API_KEY", "ZAI_API_KEY", "GOODLINKS_API_KEY"):
            env.delenv(key, raising=False)
        app = create_app(config, assistant_engine=FakeEngine())
    loop = asyncio.new_event_loop()
    cookie = sign_session(bytes.fromhex(config.session_secret),
                          int(time.time() * 1000))
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver", cookies={COOKIE_NAME: cookie})
    routes = sorted(_api_routes(app.routes), key=lambda r: r.path)
    yield Harness(app, config.db_path, template, loop, client, routes, cookie)
    loop.run_until_complete(client.aclose())
    loop.close()
    template.close()


def _encode(value: object) -> str:
    text = value if isinstance(value, str) else json.dumps(value)
    return quote(text.encode("utf-8", "surrogatepass"), safe="")


def _path(route: APIRoute, values: dict[str, object]) -> str:
    path = route.path_format
    for name, value in values.items():
        path = path.replace("{" + name + "}", _encode(value))
    return path


def _query(values: dict[str, object]) -> str:
    pairs = []
    for name, value in values.items():
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, bool):
                item = "true" if item else "false"
            pairs.append(f"{quote(name)}={_encode(item)}")
    return "&".join(pairs)


# Half the requests go to a route that takes titles, uids or block text.
_FOCUS = {"/api/ops", "/api/pages", "/api/page/{title:path}",
          "/api/page/{title:path}/rename", "/api/search", "/api/titles",
          "/api/unlinked", "/api/delete-preview", "/api/sidebar",
          "/api/sync/changes", "/api/sync/snapshot", "/api/journal",
          "/api/block/{uid}", "/api/export/page/{title:path}"}


# The write routes that take a title or block text; their bodies are
# drawn well-typed but for one request in ten, so most reach the write.
_WRITES = {("POST", "/api/ops"), ("POST", "/api/pages"),
           ("POST", "/api/page/{title:path}/rename"),
           ("DELETE", "/api/page/{title:path}"), ("POST", "/api/sidebar")}


def _op_labels(body: object) -> set[str]:
    """Which ops in an /api/ops body name a blank page title."""
    ops = body.get("ops") if isinstance(body, dict) else None
    labels = set()
    for op in ops if isinstance(ops, list) else []:
        title = op.get("page_title") if isinstance(op, dict) else None
        if isinstance(title, str) and title and not title.strip():
            labels.add(f"op {op.get('op')} with a blank page_title")
    return labels


@st.composite
def requests(draw, routes: st.SearchStrategy[APIRoute],
             loose_in: int) -> tuple[str, str, str, dict, set[str]]:
    """One request to a route `routes` draws; one in `loose_in` has
    loosely typed values."""
    route = draw(routes)
    method = draw(st.sampled_from(sorted(route.methods or ())))
    loose = draw(st.integers(1, loose_in)) == 2
    dependant = route.dependant
    path_values = {p.name: draw(for_annotation(p.field_info.annotation,
                                               loose=loose))
                   for p in dependant.path_params}
    query_values: dict[str, object] = {}
    for p in dependant.query_params:
        if p.field_info.is_required() or draw(st.booleans()):
            query_values[p.alias] = draw(for_annotation(
                p.field_info.annotation, loose=loose))
    url = _path(route, path_values)
    query = _query(query_values)
    if query:
        url += "?" + query
    labels = value_labels([*path_values.values(), *query_values.values()])
    content: bytes | None = None
    headers: dict[str, str] = {}
    files = data = None
    for p in dependant.body_params:
        info = p.field_info
        if isinstance(info, File):
            name = draw(hostile_text).encode("utf-8", "replace").decode()
            files = {p.alias: (name, draw(st.binary(max_size=64)))}
        elif isinstance(info, Form):
            value = draw(for_annotation(info.annotation, loose=loose))
            items = value if isinstance(value, list) else [value]
            data = {p.alias: [str(v).encode("utf-8", "replace").decode()
                              for v in items]}
        else:
            if draw(st.integers(0, 19)) == 7:
                content = draw(st.one_of(
                    st.binary(max_size=16),
                    st.integers(1, 5000).map(
                        lambda d: ("[" * d + "]" * d).encode()),
                    json_value.map(lambda v: json.dumps(v).encode())))
                labels.add("raw body")
            else:
                body = draw(for_annotation(info.annotation, loose=loose))
                labels |= value_labels(body) | _op_labels(body)
                content = json.dumps(body).encode()
            headers["content-type"] = "application/json"
    kwargs = {"content": content, "headers": headers, "files": files,
              "data": data}
    return f"{method} {route.path}", method, url, kwargs, labels


_RAW_TABLES = ("SELECT name FROM sqlite_master WHERE type = 'table'"
               " AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%'")


def _check_every_row(harness: Harness) -> None:
    db = open_db(harness.db_path)
    try:
        for (table,) in read(db, _RAW_TABLES).fetchall():
            table_rows(db, table)
    finally:
        db.close()


def _send_checked(harness: Harness,
                  drawn: tuple[str, str, str, dict, set[str]]
                  ) -> httpx.Response:
    name, method, url, kwargs, labels = drawn
    response = harness.send(method, url, **kwargs)
    status = f"{response.status_code // 100}xx"
    event(f"{name} -> {status}")
    for label in sorted(labels):
        event(f"input: {label}")
        if label.startswith("op "):
            event(f"input: {label} -> {status}")
    assert response.status_code < 500, (name, response.text[:300])
    if response.status_code < 300:
        _check_every_row(harness)
    return response


_SUPPRESSED = [HealthCheck.function_scoped_fixture, HealthCheck.too_slow,
               HealthCheck.data_too_large]


@settings(max_examples=300, deadline=None, suppress_health_check=_SUPPRESSED)
@given(st.data())
def test_no_route_answers_hostile_input_with_a_500(harness, data):
    focus = [r for r in harness.routes if r.path in _FOCUS]
    routes = st.one_of(st.sampled_from(focus),
                       st.sampled_from(harness.routes))
    harness.reset()
    for _ in range(data.draw(st.integers(1, 3))):
        _send_checked(harness, data.draw(requests(routes, loose_in=4)))


@settings(max_examples=200, deadline=None, suppress_health_check=_SUPPRESSED)
@given(st.data())
def test_hostile_writes_leave_every_read_serialisable(harness, data):
    """Writes with hostile titles and text, then the reads that serialise
    every stored row: each must still answer 200."""
    writes = [r for r in harness.routes
              if any((m, r.path) in _WRITES for m in r.methods or ())]
    ops = [r for r in writes if r.path == "/api/ops"]
    routes = st.one_of(st.sampled_from(ops), st.sampled_from(writes))
    harness.reset()
    for _ in range(data.draw(st.integers(1, 4))):
        _send_checked(harness, data.draw(requests(routes, loose_in=10)))
    for url in ("/api/sync/snapshot", "/api/sync/changes?since=0",
                "/api/journal", "/api/sidebar"):
        response = harness.send("GET", url)
        assert response.status_code == 200, (url, response.text[:300])
    titles = [p["title"] for p in harness.send(
        "GET", "/api/sync/snapshot").json()["pages"]]
    for title in titles:
        response = harness.send("GET", "/api/page/" + _encode(title))
        assert response.status_code == 200, (title, response.text[:300])


def _str_leaves(value: object) -> list[tuple[list[object], str]]:
    """(path, text) of every str value in a JSON value, keys excluded."""
    found: list[tuple[list[object], str]] = []
    stack: list[tuple[list[object], object]] = [([], value)]
    while stack:
        path, item = stack.pop()
        if isinstance(item, str):
            found.append((path, item))
        elif isinstance(item, dict):
            stack.extend(([*path, k], v) for k, v in item.items())
        elif isinstance(item, list):
            stack.extend(([*path, i], v) for i, v in enumerate(item))
    return found


def _replaced(value: object, path: list[object], new: str) -> object:
    if not path:
        return new
    head, *rest = path
    if isinstance(value, dict):
        return {**value, head: _replaced(value[head], rest, new)}
    assert isinstance(value, list) and isinstance(head, int)
    return [*value[:head], _replaced(value[head], rest, new), *value[head + 1:]]


@st.composite
def surrogate_twins(draw, routes: list[APIRoute]
                    ) -> tuple[str, str, str, object | None, object | None]:
    """A well-typed request to a JSON-body route with a lone surrogate
    spliced into one str of its body, and the same body made well-formed."""
    route = draw(st.sampled_from(routes))
    method = draw(st.sampled_from(sorted(route.methods or ())))
    dependant = route.dependant
    url = _path(route, {p.name: draw(for_annotation(
        p.field_info.annotation, loose=False)) for p in dependant.path_params})
    (body_param,) = dependant.body_params
    body = draw(for_annotation(body_param.field_info.annotation, loose=False))
    leaves = _str_leaves(body)
    if not leaves:
        event("twins: body holds no str")
        return f"{method} {route.path}", method, url, None, None
    path, text = draw(st.sampled_from(leaves))
    at = draw(st.integers(0, len(text)))
    lone = draw(st.sampled_from([LONE_HIGH, LONE_LOW]))
    hostile = _replaced(body, path, text[:at] + lone + text[at:])
    event("twins: lone surrogate spliced")
    return (f"{method} {route.path}", method, url, hostile,
            well_formed_tree(hostile))


# State these routes keep outside the database (the assistant's open
# conversations, the login throttle) survives the reset between the two
# requests, so their answers to a pair differ for reasons of their own.
_OUTSIDE_THE_DB = ("/api/assistant", "/api/login")


@settings(max_examples=150, deadline=None, suppress_health_check=_SUPPRESSED)
@given(st.data())
def test_a_lone_surrogate_is_answered_as_its_replacement(harness, data):
    """Arthur's ruling: every request body normalises a lone surrogate to
    U+FFFD rather than refusing it. So a body holding one gets the answer
    its well-formed twin gets, from the same starting database."""
    routes = [r for r in harness.routes
              if any(not isinstance(p.field_info, (File, Form))
                     for p in r.dependant.body_params)
              and not r.path.startswith(_OUTSIDE_THE_DB)]
    name, method, url, hostile, twin = data.draw(surrogate_twins(routes))
    if hostile is None:
        return
    answers = []
    for body in (hostile, twin):
        harness.reset()
        response = harness.send(method, url, content=json.dumps(body),
                                headers={"content-type": "application/json"})
        answers.append(response)
    event(f"twins: {name} -> {answers[1].status_code // 100}xx")
    raw, fixed = answers
    assert raw.status_code == fixed.status_code, (name, raw.text[:300],
                                                  fixed.text[:300])
    if raw.status_code >= 400:
        assert raw.json() == fixed.json()


@settings(max_examples=150, deadline=None, suppress_health_check=_SUPPRESSED)
@given(st.data())
def test_a_hostile_cli_batch_is_applied_or_refused(harness, data):
    """The CLI and MCP batch path: commands drawn from the batch command
    models are applied, or refused before any request with a BuildError,
    or refused by the server with a 4xx. Never a 5xx, and never another
    exception."""
    loose = data.draw(st.integers(1, 10)) == 2
    commands = data.draw(st.lists(
        for_annotation(BatchCommand, loose=loose), min_size=1, max_size=4))
    for label in sorted(value_labels(commands)):
        event(f"batch input: {label}")
    harness.reset()
    config = CliConfig(url="http://testserver", token=harness.token)
    try:
        apply_batch(PkmClient(config, http=TestClient(harness.app)), commands)
        event("batch: applied")
    except BuildError:
        event("batch: refused by the planner")
    except ApiError as exc:
        event(f"batch: refused with {exc.status // 100}xx")
        assert 400 <= exc.status < 500, exc
    _check_every_row(harness)
