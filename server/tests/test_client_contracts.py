"""The client/CLI/MCP side compiles against `pkm.contracts` -- the
transport-neutral request/response models the server also serializes with
(pkm-0wr8). Two things are guarded here:

* dependency direction: nothing under pkm.client/pkm.cli/pkm.mcp may
  import pkm.server.*, so the client half of the codebase can never again
  reach into server internals for a shape it needs;
* response validation: PkmClient hands back validated model instances, so
  a server whose payload drifts from the contract fails loudly on the
  client with a message naming the endpoint and the offending field --
  instead of a KeyError/AttributeError surfacing three call frames later
  in a renderer or planner.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from pkm.client.core import ApiError, ResponseSchemaError

SRC = Path(__file__).resolve().parents[1] / "src" / "pkm"
CLIENT_SIDE_PACKAGES = ("client", "cli", "mcp")


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names.add(node.module)
    return names


def _imports_of(pkg: str, prefixes: tuple[str, ...]) -> list[str]:
    return [f"{path.relative_to(SRC)} -> {mod}"
            for path in sorted((SRC / pkg).rglob("*.py"))
            for mod in sorted(_imported_modules(path))
            if any(mod == p or mod.startswith(p + ".") for p in prefixes)]


def test_client_side_packages_never_import_server_internals():
    offenders = [bad for pkg in CLIENT_SIDE_PACKAGES
                 for bad in _imports_of(pkg, ("pkm.server",))]
    assert offenders == [], (
        "client-side code must depend on pkm.contracts (shared with the "
        "server), never on pkm.server internals: " + ", ".join(offenders))


def test_contracts_depend_on_neither_side():
    # What makes it safe for both halves to depend on the contracts: they
    # are plain domain models with no idea a server or a client exists.
    offenders = _imports_of("contracts",
                            ("pkm.server", "pkm.client", "pkm.cli", "pkm.mcp"))
    assert offenders == [], (
        "pkm.contracts must stay independent of both sides: "
        + ", ".join(offenders))


class _StubResponse:
    """Minimal stand-in for the httpx2 response PkmClient reads."""

    def __init__(self, payload: object, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.text = repr(payload)

    def json(self) -> object:
        return self._payload


@pytest.fixture()
def serving(pkm_client, monkeypatch):
    """Make every request return `payload` verbatim, bypassing the app."""
    def _serve(payload: object) -> None:
        monkeypatch.setattr(
            pkm_client._http, "request",
            lambda method, url, **kw: _StubResponse(payload))
    return _serve


def test_missing_field_fails_with_the_endpoint_and_field_named(
        pkm_client, serving):
    # A page payload that lost its `backlinks` key -- e.g. an older/newer
    # server, or a proxy rewriting the body.
    serving({"page": {"id": 1, "title": "AI", "created_at": None,
                      "updated_at": None},
             "blocks": [], "block_ref_texts": {}})
    with pytest.raises(ResponseSchemaError) as e:
        pkm_client.get_page("AI")
    assert "/api/page/AI" in str(e.value)
    assert "backlinks" in str(e.value)


def test_wrong_typed_field_fails_on_the_client(pkm_client, serving):
    serving({"pages": "not a list", "blocks": []})
    with pytest.raises(ResponseSchemaError) as e:
        pkm_client.search("x")
    assert "/api/search" in str(e.value)
    assert "pages" in str(e.value)


def test_a_nested_field_failure_names_its_full_path(pkm_client, serving):
    serving({"groups": [{"page_id": 1, "page_title": "AI",
                         "items": [{"uid": "u1"}]}],   # item lost its text
             "total": 1})
    with pytest.raises(ResponseSchemaError) as e:
        pkm_client.todos()
    assert "groups.0.items.0.text" in str(e.value)


def test_schema_errors_are_api_errors_so_the_cli_reports_them(
        pkm_client, serving, capsys):
    # main() catches ApiError and exits 1; a contract failure must travel
    # that same path rather than crashing with a traceback.
    from pkm.cli.main import main

    serving({"pages": "not a list", "blocks": []})
    assert issubclass(ResponseSchemaError, ApiError)
    assert main(["search", "x"], make_client=lambda: pkm_client) == 1
    assert "/api/search" in capsys.readouterr().err


def test_several_problems_report_the_first_and_count_the_rest(
        pkm_client, serving):
    # No silent truncation of the diagnosis either: the message names one
    # field but says how many others also failed.
    serving({"pages": "not a list", "blocks": "also not a list"})
    with pytest.raises(ResponseSchemaError) as e:
        pkm_client.search("x")
    assert "and 1 more field problem" in str(e.value)


def test_a_non_json_body_fails_the_same_way(pkm_client, monkeypatch):
    # e.g. a proxy or captive portal returning HTML with a 200.
    class _NotJson:
        status_code = 200
        text = "<html>hello</html>"

        def json(self):
            raise ValueError("no json here")

    monkeypatch.setattr(pkm_client._http, "request",
                        lambda method, url, **kw: _NotJson())
    with pytest.raises(ResponseSchemaError, match="body is not JSON"):
        pkm_client.get_page("AI")


def test_an_unknown_extra_field_is_tolerated(pkm_client, serving):
    # Forward compatibility, the other half of the contract: a NEWER
    # server adding a field must not break an older client, so extras are
    # ignored rather than rejected.
    serving({"pages": [], "blocks": [], "sections": ["something new"]})
    assert pkm_client.search("x").pages == []


def test_ops_ack_is_exactly_what_the_ops_route_returns(pkm_client, client):
    """`OpsAck` is declared in pkm.contracts but deliberately NOT attached
    to POST /api/ops as a response_model (that would add a component to
    the published OpenAPI schema for a route no generated client reads).
    This test is what keeps the two in step instead: the real route's ack
    must validate against the model the client parses it with."""
    from pkm.contracts.responses import OpsAck

    raw = client.post("/api/ops", json={
        "client_id": "test", "batch_id": "ack-contract-1",
        "ops": [{"op": "create_page", "page_title": "Ack Contract"}]})
    assert raw.status_code == 200
    assert OpsAck.model_validate(raw.json()) == OpsAck(
        ok=True, ts=raw.json()["ts"], applied=1)


def test_asset_delete_ack_is_exactly_what_the_delete_route_returns(
        pkm_client, client, tmp_path):
    """Same guard for DELETE /api/assets/{sha256}, the client's
    compensating call after a failed upload link (pkm-c17m)."""
    from pkm.contracts.responses import AssetDeleteAck

    f = tmp_path / "ack.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 40)
    sha = pkm_client.upload(f).sha256
    raw = client.delete(f"/api/assets/{sha}")
    assert raw.status_code == 200
    assert AssetDeleteAck.model_validate(raw.json()) == AssetDeleteAck(
        deleted=True, refs_removed=0)
