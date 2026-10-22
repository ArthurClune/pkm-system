"""No route answers hostile input with a 500. Every API route the app
serves is found by walking its routes, and each request draws its path,
query and body values from the route's own parameter types (tests/
hostile.py): lone surrogates, control characters, NUL, NFD, padding and
blank titles, `[[`, very long text, NaN and Infinity, the wrong type, a
missing or extra field, and the seeded titles and uids so a request also
reaches the paths a real value opens.

The property: every answer is a 2xx or a 4xx, never a 5xx or an
exception, and after a 2xx every table still passes the row check.
Requests run through tests/asgi_harness.py, which restores the seeded
database before every example."""
import json
from urllib.parse import quote

import httpx
import pytest
from asgi_harness import Harness, check_every_row, encode_segment, open_harness
from fastapi.params import File, Form
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from hostile import (LONE_HIGH, LONE_LOW, REAL_TITLES, count, event,
                     for_annotation,
                     hostile_text, json_value, value_labels, with_floors)
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from pkm.batch import BatchCommand
from pkm.client.api import PkmClient
from pkm.client.core import ApiError, CliConfig
from pkm.client.workflows import apply_batch
from pkm.contracts.text import well_formed_tree
from pkm.planning import BuildError


@pytest.fixture(scope="module")
def harness(tmp_path_factory):
    with open_harness(tmp_path_factory.mktemp("no500")) as opened:
        yield opened


def _path(route: APIRoute, values: dict[str, object]) -> str:
    path = route.path_format
    for name, value in values.items():
        path = path.replace("{" + name + "}", encode_segment(value))
    return path


def _query(values: dict[str, object]) -> str:
    pairs = []
    for name, value in values.items():
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, bool):
                item = "true" if item else "false"
            pairs.append(f"{quote(name)}={encode_segment(item)}")
    return "&".join(pairs)


# Half the requests go to a route that takes titles, uids or block text.
_FOCUS = {"/api/ops", "/api/pages", "/api/page/{title:wholepath}",
          "/api/page/{title:wholepath}/rename", "/api/search", "/api/titles",
          "/api/unlinked", "/api/delete-preview", "/api/sidebar",
          "/api/sync/changes", "/api/sync/snapshot", "/api/journal",
          "/api/block/{uid}", "/api/export/page/{title:wholepath}",
          "/api/current-work"}


# The write routes that take a title or block text; their bodies are
# drawn well-typed but for one request in ten, so most reach the write.
_WRITES = {("POST", "/api/ops"), ("POST", "/api/pages"),
           ("POST", "/api/page/{title:wholepath}/rename"),
           ("DELETE", "/api/page/{title:wholepath}"), ("POST", "/api/sidebar")}


def _op_labels(body: object) -> set[str]:
    """Which ops in an /api/ops body name a blank page title, or carry an
    int past 64 bits."""
    ops = body.get("ops") if isinstance(body, dict) else None
    labels = set()
    for op in ops if isinstance(ops, list) else []:
        if not isinstance(op, dict):
            continue
        title = op.get("page_title")
        if isinstance(title, str) and title and not title.strip():
            labels.add(f"op {op.get('op')} with a blank page_title")
        if "int past 64 bits" in value_labels(list(op.values())):
            labels.add(f"op {op.get('op')} with an int past 64 bits")
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


# Production runs with plain-space title canonicalization on, so two draws in
# three start from a database that has it; the rest keep the old mode.
_TITLE_MODES = st.sampled_from([False, True, True])


def _reset(harness: Harness, data, plain_space: bool | None = None) -> None:
    if plain_space is None:
        plain_space = data.draw(_TITLE_MODES)
    event("title mode: flag on" if plain_space else "title mode: flag off")
    harness.reset(plain_space=plain_space)


def _send_checked(harness: Harness,
                  drawn: tuple[str, str, str, dict, set[str]]
                  ) -> httpx.Response:
    name, method, url, kwargs, labels = drawn
    count("request")
    response = harness.send(method, url, **kwargs)
    status = f"{response.status_code // 100}xx"
    event(f"{name} -> {status}")
    if harness.plain_space:
        event(f"flag on: {name} -> {status}")
    for label in sorted(labels):
        event(f"input: {label}")
        if label.startswith("op "):
            event(f"input: {label} -> {status}")
    assert response.status_code < 500, (name, response.text[:300])
    if response.status_code < 300:
        check_every_row(harness.db_path)
    return response


_SUPPRESSED = [HealthCheck.function_scoped_fixture, HealthCheck.too_slow,
               HealthCheck.data_too_large]


# Floors: see `with_floors` in hostile.py for how they were set.
@with_floors({
    "input: blank": 0.01, "input: lone surrogate": 0.019,
}, per="request")
@settings(max_examples=300, deadline=None, suppress_health_check=_SUPPRESSED)
@given(st.data())
def test_no_route_answers_hostile_input_with_a_500(harness, data):
    focus = [r for r in harness.routes if r.path in _FOCUS]
    routes = st.one_of(st.sampled_from(focus),
                       st.sampled_from(harness.routes))
    _reset(harness, data)
    for _ in range(data.draw(st.integers(1, 3))):
        _send_checked(harness, data.draw(requests(routes, loose_in=4)))


# A rename answering 2xx has no floor here: it fell under five events, so
# `test_a_successful_rename_leaves_every_read_serialisable` guarantees it.
@with_floors({
    "POST /api/ops -> 2xx": 0.039,
    "flag on: POST /api/ops -> 2xx": 0.019, "flag on: POST /api/ops -> 4xx": 0.02,
    "flag on: POST /api/page/{title:wholepath}/rename -> 4xx": 0.089, "input: NUL": 0.011,
    "input: blank": 0.063, "input: lone surrogate": 0.046, "input: very long": 0.011,
}, per="request")
@settings(max_examples=200, deadline=None, suppress_health_check=_SUPPRESSED)
@given(st.data())
def test_hostile_writes_leave_every_read_serialisable(harness, data):
    """Writes with hostile titles and text, then the reads that serialise
    every stored row: each must still answer 200."""
    writes = [r for r in harness.routes
              if any((m, r.path) in _WRITES for m in r.methods or ())]
    ops = [r for r in writes if r.path == "/api/ops"]
    renames = [r for r in writes if r.path.endswith("/rename")]
    routes = st.one_of(st.sampled_from(ops), st.sampled_from(renames),
                       st.sampled_from(renames), st.sampled_from(writes))
    _reset(harness, data)
    for _ in range(data.draw(st.integers(1, 4))):
        _send_checked(harness, data.draw(requests(routes, loose_in=10)))
    for url in ("/api/sync/snapshot", "/api/sync/changes?since=0",
                "/api/journal", "/api/sidebar"):
        response = harness.send("GET", url)
        assert response.status_code == 200, (url, response.text[:300])
    titles = [p["title"] for p in harness.send(
        "GET", "/api/sync/snapshot").json()["pages"]]
    for title in titles:
        response = harness.send("GET", "/api/page/" + encode_segment(title))
        assert response.status_code == 200, (title, response.text[:300])


# A rename that succeeds is too rare an outcome of the hostile draws to
# floor, so it gets a property of its own: a seeded page renamed to a plain
# new title always answers 200, and every read still serialises.
@pytest.mark.parametrize("plain_space", [False, True])
@settings(max_examples=20, deadline=None, database=None,
          suppress_health_check=_SUPPRESSED)
# A daily note cannot be renamed, so its title is left out.
@given(seeded=st.sampled_from([t for t in REAL_TITLES if "2026" not in t]),
       renamed=st.from_regex(r"Renamed [A-Z][a-z]{3,8}", fullmatch=True))
def test_a_successful_rename_leaves_every_read_serialisable(
        harness, plain_space, seeded, renamed):
    harness.reset(plain_space=plain_space)
    response = harness.send(
        "POST", f"/api/page/{encode_segment(seeded)}/rename",
        json={"new_title": renamed, "allow_merge": False})
    assert response.status_code == 200, (seeded, response.text[:300])
    for url in ("/api/sync/snapshot", "/api/sync/changes?since=0",
                "/api/journal", "/api/sidebar",
                "/api/page/" + encode_segment(renamed)):
        response = harness.send("GET", url)
        assert response.status_code == 200, (url, response.text[:300])
    check_every_row(harness.db_path)


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


# The title mode is a parameter, not a draw, so both are reached by
# construction and each gets half the examples.
@pytest.mark.parametrize("plain_space", [False, True])
@with_floors({"twins: lone surrogate spliced": 0.31}, per="case")
@settings(max_examples=75, deadline=None, suppress_health_check=_SUPPRESSED)
@given(data=st.data())
def test_a_lone_surrogate_is_answered_as_its_replacement(harness, data,
                                                         plain_space):
    """Arthur's ruling: every request body normalises a lone surrogate to
    U+FFFD rather than refusing it. So a body holding one gets the answer
    its well-formed twin gets, from the same starting database."""
    count("case")
    routes = [r for r in harness.routes
              if any(not isinstance(p.field_info, (File, Form))
                     for p in r.dependant.body_params)
              and not r.path.startswith(_OUTSIDE_THE_DB)]
    name, method, url, hostile, twin = data.draw(surrogate_twins(routes))
    if hostile is None:
        return
    answers = []
    for body in (hostile, twin):
        harness.reset(plain_space=plain_space)
        response = harness.send(method, url, content=json.dumps(body),
                                headers={"content-type": "application/json"})
        answers.append(response)
    event(f"twins: {name} -> {answers[1].status_code // 100}xx")
    raw, fixed = answers
    assert raw.status_code == fixed.status_code, (name, raw.text[:300],
                                                  fixed.text[:300])
    if raw.status_code >= 400:
        assert raw.json() == fixed.json()


# `batch input: NUL` and `very long` have no floor: each fell under five
# events in a half-size run.
@pytest.mark.parametrize("plain_space", [False, True])
@with_floors({
    "batch input: blank": 0.058, "batch input: lone surrogate": 0.06,
    "batch: applied": 0.054,
    "batch: refused by the planner": 0.11,
}, per="case")
@settings(max_examples=75, deadline=None, suppress_health_check=_SUPPRESSED)
@given(data=st.data())
def test_a_hostile_cli_batch_is_applied_or_refused(harness, data, plain_space):
    """The CLI and MCP batch path: commands drawn from the batch command
    models are applied, or refused before any request with a BuildError,
    or refused by the server with a 4xx. Never a 5xx, and never another
    exception."""
    count("case")
    loose = data.draw(st.integers(1, 10)) == 2
    commands = data.draw(st.lists(
        for_annotation(BatchCommand, loose=loose), min_size=1, max_size=4))
    for label in sorted(value_labels(commands)):
        event(f"batch input: {label}")
    _reset(harness, data, plain_space)
    config = CliConfig(url="http://testserver", token=harness.token)
    try:
        apply_batch(PkmClient(config, http=TestClient(harness.app)), commands)
        event("batch: applied")
    except BuildError:
        event("batch: refused by the planner")
    except ApiError as exc:
        event(f"batch: refused with {exc.status // 100}xx")
        assert 400 <= exc.status < 500, exc
    check_every_row(harness.db_path)
