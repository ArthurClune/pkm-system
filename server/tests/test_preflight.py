import json

from pkm.server import openapi_dump
from pkm.server.auth_core import sign_session, verify_session

SECRET = b"s" * 32
NOW = 1_700_000_000_000


def test_non_ascii_digit_timestamp_rejected():
    # Arabic-Indic digits pass str.isdigit() (and int()) but must not pass
    # session verification.
    sig = sign_session(SECRET, NOW).split(".")[2]
    assert not verify_session(SECRET, f"v1.١٢٣.{sig}", now_ms=NOW)


def test_create_heading_bounds(client):
    def create(heading):
        return client.post("/api/ops", json={"client_id": "c1", "ops": [
            {"op": "create", "uid": "newuid7",
             "page_title": "Machine Learning", "parent_uid": None,
             "order_idx": 5, "text": "h", "heading": heading}]})
    assert create(4).status_code == 422
    assert create(0).status_code == 422
    assert create(3).status_code == 200


def test_openapi_dump_prints_schema(capsys):
    assert openapi_dump.main() == 0
    schema = json.loads(capsys.readouterr().out)
    assert "/api/ops" in schema["paths"]
    assert "/api/page/{title}" in schema["paths"]
    assert "OpBatch" in schema["components"]["schemas"]
