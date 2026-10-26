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


class _CapturedServer:
    """Stands in for uvicorn.Server: keeps the config it is built with."""
    configs: list = []

    def __init__(self, config) -> None:
        self.configs.append(config)

    def run(self, sockets=None) -> None:
        return None


@pytest.fixture()
def captured(monkeypatch) -> list:
    monkeypatch.setattr(_CapturedServer, "configs", [])
    monkeypatch.setattr(run.uvicorn, "Server", _CapturedServer)
    return _CapturedServer.configs


async def _app(scope, receive, send) -> None:
    pass


def test_the_e2e_and_proptest_servers_serve_as_production_does(
        captured, tmp_path):
    # A launcher that built its own config ran without the deadline
    # protocol, and a protocol that closed every WebSocket passed E2E.
    import e2e_serve
    from proptest import sync_server

    from pkm.server.http_protocol import DeadlineH11Protocol

    e2e_serve.serve(_app, tmp_path / "e2e.log")
    sync_server.serve(_app, tmp_path / "proptest.log")
    assert [(c.http, c.port, c.host) for c in captured] == [
        (DeadlineH11Protocol, e2e_serve.PORT, "127.0.0.1"),
        (DeadlineH11Protocol, sync_server.PORT, "127.0.0.1")]
