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
import hashlib
import json
import os
import types
import typing
from unittest import mock

from datetime import date
from urllib.parse import quote

import pytest
from fastapi.params import File, Form
from fastapi.routing import APIRoute
from test_routes_models import _api_routes, fill_path

from annotated_types import Interval

from pkm.contracts.daily import title_for_date
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


def _diagnostics_lines(caplog) -> list[str]:
    return [rec.getMessage() for rec in caplog.records
            if rec.getMessage().startswith("client diagnostics")]


def test_diagnostics_log_line_is_bounded_and_names_the_total(client, caplog):
    r = _post_escaped(client, "/api/client/diagnostics", {
        "kind": "k", "error": "e", "report": {"dump": "x" * (2 * 1024 * 1024)},
        "client": {}})
    assert r.status_code == 200, r.text
    (logged,) = _diagnostics_lines(caplog)
    total = len(json.dumps({"client": {}, "error": "e", "kind": "k",
                            "report": {"dump": "x" * (2 * 1024 * 1024)}},
                           sort_keys=True))
    marker = f"\u2026[truncated: {total} chars]"
    prefix = len("client diagnostics ")
    assert logged.endswith(marker)
    assert len(logged) == prefix + 64 * 1024 + len(marker)


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


@pytest.mark.parametrize("value", [INT64_MAX + 1, INT64_MIN - 1])
def test_an_int_past_sqlite_range_in_a_body_is_a_422(client, value):
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "batch-wide-int",
        "ops": [{"op": "create", "uid": "newwide01", "page_title": "Paper",
                 "parent_uid": None, "order_idx": value, "text": ""}]})
    assert r.status_code == 422
    r = client.put("/api/sidebar", json={"order": [value]})
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


def _titles(config) -> set[str]:
    con = open_db(config.db_path)
    try:
        return {r["title"] for r in con.select("SELECT title FROM pages")}
    finally:
        con.close()


@pytest.mark.parametrize("depth", [990, 2000])
def test_ops_refuse_text_nesting_references_past_any_sane_depth(
        client, seeded_config, depth):
    """Nested `[[` reaches rename and delete as one recursion level per
    layer, so the write path must refuse it where it enters."""
    text = "[[" * depth + "Target" + "]]" * depth
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": f"batch-nest-{depth}", "ops": [
            {"op": "create", "uid": f"nest_{depth:06d}",
             "page_title": f"Src{depth}", "order_idx": 0, "text": text}]})
    assert 400 <= r.status_code < 500, r.text[:200]
    assert f"Src{depth}" not in _titles(seeded_config)


_INT64_EXTREMES = [INT64_MIN, INT64_MAX, 0, -1]


@pytest.mark.parametrize("since,until", [
    ("0001-01-01", None),
    ("0001-01-01T00:00:00+23:59", None),
    ("0001-01-01T00:00:00-23:59", "9999-12-31T23:59:59.999999+23:59"),
    ("9999-12-31T23:59:59.999999-23:59", None),
    ("2026-02-30", None),
    ("x", None),
    ("2026-01-01", "2026-01-01"),
    ("0001-01-01", "9999-12-31"),
    ("2026-01-01T00:00:00+00:00\n", None),
    ("２０２６-01-01", None),
])
def test_changed_window_extremes_answer_below_500(client, since, until):
    params: dict[str, object] = {"since": since, "limit": INT64_MAX}
    if until:
        params["until"] = until
    r = client.get("/api/changed", params=params)
    assert r.status_code < 500, r.text[:200]


def test_changed_limit_is_clamped_at_int64_max(client, seeded_config):
    con = open_db(seeded_config.db_path)
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " updated_at) VALUES (?,?,NULL,?,?,?)",
        [(f"chg_{i:07d}", 1, 100 + i, "x", 5_000) for i in range(2001)])
    con.commit()
    con.close()
    r = client.get("/api/changed", params={"since": "1970-01-01",
                                           "until": "1971-01-01",
                                           "limit": INT64_MAX})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2001
    assert sum(len(g["items"]) for g in body["groups"]) == 2000


@pytest.mark.parametrize("now_ms", _INT64_EXTREMES)
def test_current_work_answers_at_int64_extremes(client, now_ms):
    r = client.get("/api/current-work", params={"now_ms": now_ms})
    assert r.status_code < 500, r.text[:200]


@pytest.mark.parametrize("offset", [-5, INT64_MIN, INT64_MAX])
def test_page_backlink_window_extremes_are_clamped(client, offset):
    r = client.get("/api/page/AI",
                   params={"bl_offset": offset, "bl_limit": INT64_MIN})
    assert r.status_code == 200, r.text[:200]
    assert r.json()["backlinks"]["limit"] == 1


def test_todos_for_a_nul_page_answers(client):
    r = client.get("/api/todos", params={"page": "\x00"})
    assert r.status_code < 500


# The tables SQLite's FTS5 keeps behind `pages_fts`.
_FTS_SHADOWS = tuple(f"pages_fts_{k}"
                     for k in ("config", "data", "docsize", "idx"))


def _digest(config, skip: tuple[str, ...] = ()) -> str:
    """A hash of every row of every table, whatever the row order. The row
    check is off because it knows the product's columns, not the full-text
    shadow tables or `changes`."""
    with mock.patch.dict(os.environ):
        os.environ.pop("PKM_ROW_CHECK", None)
        con = open_db(config.db_path)
    try:
        h = hashlib.sha256()
        for t in con.select("SELECT name AS title FROM sqlite_master"
                            " WHERE type = 'table' ORDER BY name"):
            if t["title"] in skip or (
                    "pages_fts" in skip
                    and t["title"].startswith(_FTS_SHADOWS)):
                continue
            rows = con.select(f"SELECT * FROM {t['title']}")
            h.update(t["title"].encode())
            for text in sorted(repr(sorted(row.items())) for row in rows):
                h.update(text.encode())
        return h.hexdigest()
    finally:
        con.close()


_READ_ONLY_GETS = [
    "/api/delete-preview?title=AI",
    "/api/block/uid_b3",
    "/api/block/uid_b3/backlinks",
    "/api/changed?since=2000-01-01",
    "/api/todos",
    "/api/current-work",
    "/api/page/AI",
    "/api/page/Nope",
    "/api/page/July%207th,%202026",
    "/api/query?expr=%7Bor:%20[[AI]]%7D",
    "/api/page/" + quote(title_for_date(date(2030, 1, 1))),
]


def test_reading_routes_leave_the_database_byte_identical(client,
                                                          seeded_config):
    """A GET that writes is reachable cross-site by top-level navigation,
    so reads stay writes-free apart from today's daily page."""
    before = _digest(seeded_config)
    for url in _READ_ONLY_GETS:
        assert client.get(url).status_code < 500, url
    assert _digest(seeded_config) == before


# What a new page row moves: the row, its change feed entry, the id counter
# and the page full-text index (`pages_fts` and its shadow tables).
_TODAY_WRITES = ("pages", "changes", "sqlite_sequence", "pages_fts")


def test_getting_todays_page_creates_that_page_and_nothing_else(
        client, seeded_config):
    today = title_for_date(date.today())
    titles_before = _titles(seeded_config)
    assert today not in titles_before
    others_before = _digest(seeded_config, skip=_TODAY_WRITES)

    assert client.get("/api/page/" + quote(today)).status_code == 200

    assert _titles(seeded_config) - titles_before == {today}
    assert titles_before <= _titles(seeded_config)
    assert _digest(seeded_config, skip=_TODAY_WRITES) == others_before


def _json_body_routes(app) -> list[APIRoute]:
    """Routes with a JSON body parameter, not form, file or no body."""
    found = []
    for route in _api_routes(app.routes):
        params = route.dependant.body_params
        if params and not any(isinstance(p.field_info, (Form, File))
                              for p in params):
            found.append(route)
    return found


_NON_JSON_TYPES = ["text/plain;charset=UTF-8", None,
                   "application/x-www-form-urlencoded"]


def _is_refusal(status: int, locs: list[object]) -> bool:
    """A refusal of the whole body: 415, or a 422 whose only error is on
    `body` itself. A 2xx, or a 422 on `["body", <field>]`, means the body
    was parsed."""
    return status == 415 or (status == 422 and locs == [["body"]])


def _non_json_answers(app, client) -> dict[str, tuple[int, list[object]]]:
    """Status and error locations of each JSON-body route sent `{}` under a
    content type a cross-site form or Blob can send without preflight."""
    answers = {}
    for route in _json_body_routes(app):
        url = fill_path(route.path)
        for method in sorted(route.methods or ()):
            for ctype in _NON_JSON_TYPES:
                headers = {"content-type": ctype} if ctype else {}
                r = client.request(method, url, content=b"{}",
                                   headers=headers)
                detail = r.json().get("detail", []) if r.status_code == 422 \
                    else []
                locs = [err["loc"] for err in detail]
                answers[f"{method} {route.path} {ctype}"] = (r.status_code,
                                                             locs)
    return answers


def _not_refused(answers: dict[str, tuple[int, list[object]]]) -> list[str]:
    return [k for k, v in answers.items() if not _is_refusal(*v)]


def test_every_json_body_route_refuses_a_non_json_content_type(
        goodlinks_client, seeded_config):
    """A body parsed whatever its Content-Type can be written by a
    cross-origin simple request, which carries the session cookie. Refusal
    is a single error on the whole body: a parsed `{}` would instead fail
    on a missing field, `["body", <field>]`, which is no refusal. The
    goodlinks gateway is on so its route reaches body validation."""
    client = goodlinks_client
    before = _digest(seeded_config)
    answers = _non_json_answers(client.app, client)
    assert len(answers) > 20  # the walk found the routes
    assert _not_refused(answers) == []
    assert _digest(seeded_config) == before


def test_the_content_type_walk_names_a_route_that_parses_any_body():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    class Body(WellFormedModel):
        text: str

    app = FastAPI(strict_content_type=False)

    @app.post("/lenient")
    def lenient(body: Body) -> None:
        return None

    assert [r.path for r in _json_body_routes(app)] == ["/lenient"]
    answers = _non_json_answers(app, TestClient(app))
    # The flag governs a body with no Content-Type; FastAPI refuses the
    # other two types whatever it says.
    assert _not_refused(answers) == ["POST /lenient None"]


def test_diagnostics_dump_at_the_cap_logs_unchanged_and_one_over_is_cut(
        client, caplog):
    from pkm.server import routes_sync
    cap = routes_sync._MAX_DIAGNOSTICS_LOG_CHARS
    base = len(json.dumps({"client": {}, "error": "e", "kind": "k",
                           "report": {"d": ""}}, sort_keys=True))
    for extra, cut in ((0, False), (1, True)):
        caplog.clear()
        report = {"d": "x" * (cap - base + extra)}
        r = _post_escaped(client, "/api/client/diagnostics", {
            "kind": "k", "error": "e", "report": report, "client": {}})
        assert r.status_code == 200, r.text
        (logged,) = _diagnostics_lines(caplog)
        dump = json.dumps({"client": {}, "error": "e", "kind": "k",
                           "report": report}, sort_keys=True)
        assert len(dump) == cap + extra
        assert (logged != "client diagnostics " + dump) is cut
        assert logged.endswith("chars]") is cut


def test_diagnostics_report_holding_the_marker_text_is_not_a_marker(
        client, caplog):
    r = _post_escaped(client, "/api/client/diagnostics", {
        "kind": "k", "error": "e", "client": {},
        "report": {"d": "\u2026[truncated: 5 chars]\u2028"}})
    assert r.status_code == 200, r.text
    (logged,) = _diagnostics_lines(caplog)
    assert logged.isprintable() and "\u2026" not in logged
