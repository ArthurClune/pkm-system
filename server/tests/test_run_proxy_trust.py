"""The login throttle keys on `request.client.host`, which uvicorn's proxy
handling rewrites from `X-Forwarded-For`. These tests drive the app as
`run.uvicorn_config` loads it, so the key each listener produces is the one
production sees: Tailscale Serve reaches the loopback listener and sets the
header; the Tailscale-IP listener has no proxy in front of it."""
import asyncio

import httpx
import pytest

from pkm.server import run
from pkm.server.app import create_app

# cfg.load() imports uvicorn's websockets protocol, which warns on import.
pytestmark = pytest.mark.filterwarnings(
    "ignore:websockets.*is deprecated:DeprecationWarning")

# Set in every test: uvicorn reads it when no value is passed, and `*` trusts
# any peer and takes the left-most, client-chosen entry.
WIDE_OPEN = "*"


def _throttle_key_after_wrong_password(config, peer: str,
                                       headers: dict[str, str]) -> str:
    app = create_app(config)
    cfg = run.uvicorn_config(app, port=0, log_config=None)
    cfg.load()

    async def post() -> int:
        transport = httpx.ASGITransport(app=cfg.loaded_app,
                                        client=(peer, 50000))
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://testserver") as c:
            r = await c.post("/api/login", json={"password": "nope"},
                             headers=headers)
            return r.status_code

    assert asyncio.run(post()) == 401
    keys = list(app.state.login_throttle._attempts)
    assert len(keys) == 1, keys
    return keys[0]


def test_config_trusts_forwarding_only_from_loopback(seeded_config,
                                                     monkeypatch):
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", WIDE_OPEN)
    cfg = run.uvicorn_config(create_app(seeded_config), port=0,
                             log_config=None)
    assert cfg.proxy_headers is True
    assert cfg.forwarded_allow_ips == "127.0.0.1"
    assert cfg.access_log is False


@pytest.mark.parametrize(("peer", "headers", "key"), [
    # Direct Tailscale-IP listener: no proxy, a forged header is ignored.
    ("100.64.0.5", {"X-Forwarded-For": "1.2.3.4"}, "100.64.0.5"),
    # Through Serve: its header names the connecting device.
    ("127.0.0.1", {"X-Forwarded-For": "100.64.0.7"}, "100.64.0.7"),
    # Only the right-most entry, the one the trusted proxy added, counts.
    ("127.0.0.1", {"X-Forwarded-For": "6.6.6.6, 100.64.0.7"}, "100.64.0.7"),
    ("127.0.0.1", {}, "127.0.0.1"),
    # Serve passes X-Real-IP through from the client; neither it nor
    # Forwarded may pick the key.
    ("127.0.0.1", {"X-Real-IP": "8.8.4.4", "Forwarded": "for=8.8.8.8"},
     "127.0.0.1"),
])
def test_throttle_key_per_listener(seeded_config, monkeypatch, peer, headers,
                                   key):
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", WIDE_OPEN)
    assert _throttle_key_after_wrong_password(seeded_config, peer,
                                              headers) == key
