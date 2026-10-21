"""Hostile input to a route is a 2xx or a 4xx, never a 500. Each test here
is one input a probe or the no-500 properties found answering 500.

A lone surrogate in any request body becomes U+FFFD before the route sees
it, as it does for ops: every request body model derives from
WellFormedModel, and a test walks the app's routes to keep it so. A 422
echoes the input it refused, so its renderer makes that echo well-formed
JSON, whatever the input held.

Bodies are built with json.dumps' default ASCII escapes, as a browser's
JSON.stringify sends a lone surrogate, because httpx's own json= encoding
refuses one before it is sent."""
import json
import types
import typing

import pytest
from fastapi.params import File, Form
from fastapi.routing import APIRoute
from test_routes_models import _api_routes

from annotated_types import Interval

from pkm.contracts.int64 import INT64_MAX, INT64_MIN
from pkm.contracts.strict import StrictModel
from pkm.contracts.text import WellFormedModel
from pkm.server.app import create_app
from pkm.server.db import open_db
from pkm.server.fts import escape_fts_query, phrase_query

LONE_HIGH = "\ud800"
LONE_LOW = "\udc00"


def _post(client, url: str, raw: str):
    return client.post(url, content=raw,
                       headers={"content-type": "application/json"})


def _post_escaped(client, url: str, body: object):
    return _post(client, url, json.dumps(body))


def test_create_page_with_a_lone_surrogate_makes_the_replacement_title(client):
    r = _post_escaped(client, "/api/pages", {"title": f"x{LONE_HIGH}"})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "x�"


def test_rename_to_a_lone_surrogate_title_renames(client):
    r = _post_escaped(client, "/api/page/Paper/rename",
                      {"new_title": f"ML{LONE_LOW}"})
    assert r.status_code == 200, r.text
    assert client.get("/api/page/ML�").status_code == 200


def test_sidebar_entry_with_a_lone_surrogate_is_added(client):
    r = _post_escaped(client, "/api/sidebar", {"title": f"S{LONE_HIGH}"})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "S�"


def test_login_with_a_lone_surrogate_password_is_refused(anon_client):
    r = _post_escaped(anon_client, "/api/login",
                      {"password": f"pw{LONE_HIGH}"})
    assert r.status_code == 401


def test_goodlinks_resolve_with_a_lone_surrogate_url_is_a_404_when_off(client):
    r = _post_escaped(client, "/api/goodlinks/resolve",
                      {"url": f"https://a.example/{LONE_HIGH}"})
    assert r.status_code == 404


def test_diagnostics_normalise_nested_strings(client, caplog):
    r = _post_escaped(client, "/api/client/diagnostics", {
        "kind": f"k{LONE_HIGH}", "error": "e",
        "report": {f"key{LONE_LOW}": [f"v{LONE_HIGH}", {"deep": LONE_LOW}]},
        "client": {}})
    assert r.status_code == 200, r.text
    (logged,) = [rec.getMessage() for rec in caplog.records
                 if rec.getMessage().startswith("client diagnostics")]
    assert "\\ud800" not in logged and "\\udc00" not in logged
    assert logged.count("\\ufffd") == 4


def _echo_inputs(r) -> list[object]:
    return [err.get("input") for err in r.json()["detail"]]


def test_an_unknown_op_with_a_lone_surrogate_is_a_well_formed_422(client):
    """The ops union dispatches on `op`, which OpBatch has already made
    well-formed with the rest of the batch."""
    r = _post_escaped(client, "/api/ops", {
        "client_id": "c1", "batch_id": "b1", "ops": [{"op": f"x{LONE_HIGH}"}]})
    assert r.status_code == 422
    assert "x�" in json.dumps(r.json(), ensure_ascii=False)


def test_a_422_echoing_a_lone_surrogate_is_well_formed(client):
    """A body that is not an object reaches no model validator, so the 422
    echoes it as sent."""
    r = _post_escaped(client, "/api/pages", f"x{LONE_HIGH}")
    assert r.status_code == 422
    assert _echo_inputs(r) == ["x�"]


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_a_422_echoing_a_non_finite_number_is_valid_json(client, literal):
    r = _post(client, "/api/pages", '{"title": %s}' % literal)
    assert r.status_code == 422
    assert _echo_inputs(r) == [literal]
    json.loads(r.text)


def test_a_422_echoing_a_deeply_nested_input_renders(client):
    depth = 5000
    r = _post(client, "/api/pages",
              '{"title": ' + "[" * depth + "]" * depth + "}")
    assert r.status_code == 422


def test_search_for_a_nul_answers(client):
    r = client.get("/api/search", params={"q": "a\x00b"})
    assert r.status_code == 200


def test_unlinked_mentions_of_a_title_holding_a_nul_answer(client,
                                                          seeded_config):
    con = open_db(seeded_config.db_path)
    con.execute("INSERT INTO pages(title) VALUES (?)", ("nul\x00page",))
    con.commit()
    con.close()
    r = client.get("/api/unlinked", params={"title": "nul\x00page"})
    assert r.status_code == 200


def test_fts_queries_never_carry_a_nul():
    assert "\x00" not in escape_fts_query("a\x00b \x00")
    assert "\x00" not in phrase_query("a\x00b")
    assert escape_fts_query("\x00") == '""'


def test_an_int_past_sqlite_range_in_a_query_is_a_422(client):
    r = client.get("/api/assets/search", params={"to_ms": INT64_MAX + 1})
    assert r.status_code == 422
    r = client.get("/api/sync/changes", params={"since": INT64_MIN - 1})
    assert r.status_code == 422


def _json_body_models(annotation: object) -> list[object]:
    """The JSON body types a body parameter's annotation can carry."""
    args = typing.get_args(annotation)
    if args:
        return [m for a in args for m in _json_body_models(a)]
    return [annotation]


def _non_well_formed_bodies(app) -> list[str]:
    bad = []
    for route in _api_routes(app.routes):
        assert isinstance(route, APIRoute)
        for param in route.dependant.body_params:
            info = param.field_info
            if isinstance(info, (Form, File)):
                # Form and multipart values are decoded from bytes, which
                # cannot spell a lone surrogate.
                continue
            for body in _json_body_models(info.annotation):
                if body is type(None):
                    continue
                if not (isinstance(body, type)
                        and issubclass(body, WellFormedModel)):
                    bad.append(f"{sorted(route.methods or ())} {route.path}:"
                               f" {param.name}: {body!r}")
    return bad


def test_every_json_request_body_is_a_well_formed_model(seeded_config):
    app = create_app(seeded_config)
    assert _non_well_formed_bodies(app) == []


def test_the_body_walk_names_a_plain_model(seeded_config):
    from fastapi import FastAPI

    class Plain(StrictModel):
        text: str

    app = FastAPI()

    @app.post("/plain")
    def plain(body: Plain) -> None:
        return None

    assert _non_well_formed_bodies(app) == [
        f"['POST'] /plain: body: {Plain!r}"]


def _unbounded_int(annotation: object, metadata: list[object]) -> bool:
    """Does `annotation` admit an int with no INT64 bound around it?"""
    origin = typing.get_origin(annotation)
    if origin is typing.Annotated:
        inner, *extra = typing.get_args(annotation)
        return _unbounded_int(inner, [*metadata, *extra])
    if origin is typing.Union or origin is types.UnionType:
        return any(_unbounded_int(a, metadata)
                   for a in typing.get_args(annotation))
    if isinstance(annotation, typing.NewType):
        return _unbounded_int(annotation.__supertype__, metadata)
    if annotation is not int:
        return False
    return not any(isinstance(m, Interval) and m.ge is not None
                   and m.le is not None and m.ge >= INT64_MIN
                   and m.le <= INT64_MAX for m in metadata)


def _unbounded_int_params(app) -> list[str]:
    bad = []
    for route in _api_routes(app.routes):
        dependant = route.dependant
        for param in dependant.path_params + dependant.query_params:
            info = param.field_info
            if _unbounded_int(info.annotation, list(info.metadata)):
                bad.append(f"{sorted(route.methods or ())} {route.path}:"
                           f" {param.name}")
    return bad


def test_every_int_parameter_is_bounded_to_sqlite_range(seeded_config):
    app = create_app(seeded_config)
    assert _unbounded_int_params(app) == []


def test_the_int_walk_names_an_unbounded_parameter():
    from fastapi import FastAPI

    app = FastAPI()

    @app.get("/n/{n}")
    def n(n: int, m: int | None = None) -> None:
        return None

    assert _unbounded_int_params(app) == ["['GET'] /n/{n}: n",
                                          "['GET'] /n/{n}: m"]
