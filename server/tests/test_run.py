import socket

import pytest
from test_config import write_config

from pkm.server import run
from pkm.server.run import bind_sockets


def test_bind_sockets_binds_each_host():
    socks = bind_sockets(["127.0.0.1"], 0)
    try:
        assert len(socks) == 1
        host, port = socks[0].getsockname()
        assert host == "127.0.0.1" and port > 0
    finally:
        for s in socks:
            s.close()


def test_bind_failure_releases_partial_binds():
    tmp = socket.socket()
    tmp.bind(("127.0.0.1", 0))
    port = tmp.getsockname()[1]
    tmp.close()
    # second bind to the same host:port collides; the first must be released
    with pytest.raises(OSError):
        bind_sockets(["127.0.0.1", "127.0.0.1"], port)
    s = socket.socket()
    s.bind(("127.0.0.1", port))  # would EADDRINUSE if the first bind leaked
    s.close()


def test_main_hands_create_app_the_hosts_it_binds(tmp_path, monkeypatch):
    """`--host` replaces `bind_hosts`, and the guard's allowed origins are
    built from what the app is handed, so it must get the bound hosts."""
    captured = {}

    def fake_create_app(config, *, api_port):
        captured.update(config=config, api_port=api_port)
        return object()

    class FakeServer:
        def __init__(self, config) -> None:
            pass

        def run(self, sockets) -> None:
            return None

    monkeypatch.setattr(run, "bind_sockets", lambda hosts, port: [])
    monkeypatch.setattr(run.uvicorn, "Server", FakeServer)
    monkeypatch.setattr(run, "create_app", fake_create_app)
    write_config(tmp_path, {})
    assert run.main(["--data-dir", str(tmp_path), "--port", "8975",
                     "--host", "127.0.0.1", "--host", "100.64.0.9"]) == 0
    assert captured["config"].bind_hosts == ("127.0.0.1", "100.64.0.9")
    assert captured["api_port"] == 8975


def test_uvicorn_config_uses_the_deadline_protocol():
    from pkm.server.http_protocol import DeadlineH11Protocol

    async def app(scope, receive, send) -> None:
        pass

    config = run.uvicorn_config(app, port=0, log_config=None)
    assert config.http is DeadlineH11Protocol
