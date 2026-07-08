from pkm.server.auth_core import (hash_password, sign_session,
                                  verify_password, verify_session)

SECRET = b"s" * 32
SALT = b"\x01" * 16


def test_password_roundtrip():
    h = hash_password("hunter2", SALT)
    assert verify_password("hunter2", SALT, h)
    assert not verify_password("hunter3", SALT, h)


def test_session_roundtrip_and_tamper():
    token = sign_session(SECRET, 1700000000000)
    now = 1700000000000 + 1000
    assert token.startswith("v1.1700000000000.")
    assert verify_session(SECRET, token, now_ms=now)
    assert not verify_session(SECRET, token[:-1] + ("0" if token[-1] != "0" else "1"), now_ms=now)
    assert not verify_session(b"other" * 8, token, now_ms=now)
    assert not verify_session(SECRET, "garbage", now_ms=now)
    assert not verify_session(SECRET, "v1.123", now_ms=now)


def test_login_flow_and_gate(anon_client):
    # unauthenticated API access is rejected
    assert anon_client.get("/api/page/Machine%20Learning").status_code == 401
    # wrong password rejected
    assert anon_client.post("/api/login", json={"password": "nope"}).status_code == 401
    # login page is reachable without auth
    assert anon_client.get("/login").status_code == 200
    # correct password sets the session cookie
    r = anon_client.post("/api/login", json={"password": "test-pw"})
    assert r.status_code == 200
    assert "pkm_session" in anon_client.cookies


def test_docs_routes_disabled(anon_client):
    assert anon_client.get("/docs").status_code == 404
    assert anon_client.get("/redoc").status_code == 404


def test_openapi_json_requires_auth(anon_client):
    assert anon_client.get("/api/openapi.json").status_code == 401


def test_openapi_json_available_after_login(client):
    r = client.get("/api/openapi.json")
    assert r.status_code == 200
    assert "openapi" in r.json()
