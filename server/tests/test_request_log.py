import json
import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from pkm.server import run
from pkm.server.logfmt import request_line, uvicorn_log_config
from pkm.server.request_log import RequestLogMiddleware


def test_request_line_includes_all_fields():
    line = request_line("100.1.2.3", "GET",
                        "/api/page/Politics?bl_offset=20", 200, 34.6)
    assert line == '100.1.2.3 "GET /api/page/Politics?bl_offset=20" 200 35ms'


def test_request_line_without_client_uses_dash():
    assert request_line(None, "POST", "/api/login", 401, 0.4) == \
        '- "POST /api/login" 401 0ms'


def test_uvicorn_log_config_timestamps_all_formatters():
    config = uvicorn_log_config()
    formats = [f.get("fmt") or f.get("format")
               for f in config["formatters"].values()]
    assert formats and all("%(asctime)s" in f for f in formats)


def test_uvicorn_log_config_routes_pkm_access_to_stdout():
    config = uvicorn_log_config()
    access_logger = config["loggers"]["pkm.access"]
    assert access_logger["propagate"] is False
    [handler_name] = access_logger["handlers"]
    handler = config["handlers"][handler_name]
    assert handler["stream"] == "ext://sys.stdout"


def test_uvicorn_log_config_routes_pkm_describe_to_stdout():
    config = uvicorn_log_config()
    describe_logger = config["loggers"]["pkm.describe"]
    assert describe_logger["level"] == "INFO"
    assert describe_logger["propagate"] is False
    [handler_name] = describe_logger["handlers"]
    handler = config["handlers"][handler_name]
    assert handler["stream"] == "ext://sys.stdout"


@pytest.fixture()
def logged_app() -> FastAPI:
    app = FastAPI()

    @app.get("/ping")
    def ping() -> dict:
        return {"ok": True}

    @app.get("/boom")
    def boom() -> dict:
        raise RuntimeError("kaboom")

    app.add_middleware(RequestLogMiddleware)
    return app


def test_middleware_logs_method_path_query_status_duration(logged_app, caplog):
    with caplog.at_level(logging.INFO, logger="pkm.access"):
        TestClient(logged_app).get("/ping?x=1")
    [record] = caplog.records
    assert record.name == "pkm.access"
    assert '"GET /ping?x=1" 200 ' in record.message
    assert record.message.endswith("ms")
    assert record.message.startswith("testclient ")


def test_middleware_logs_unhandled_errors_as_500(logged_app, caplog):
    with caplog.at_level(logging.INFO, logger="pkm.access"):
        with pytest.raises(RuntimeError):
            TestClient(logged_app).get("/boom")
    [record] = caplog.records
    assert '"GET /boom" 500 ' in record.message


def test_middleware_ignores_non_http_scopes(caplog):
    from fastapi import WebSocket

    app = FastAPI()

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.close()

    app.add_middleware(RequestLogMiddleware)
    with caplog.at_level(logging.INFO, logger="pkm.access"):
        with TestClient(app).websocket_connect("/ws"):
            pass
    assert caplog.records == []


def test_create_app_wires_request_logging(anon_client, caplog):
    with caplog.at_level(logging.INFO, logger="pkm.access"):
        anon_client.get("/healthz")
    assert any('"GET /healthz" 200 ' in r.message for r in caplog.records)


def test_main_passes_timestamped_log_config_to_uvicorn(tmp_path, monkeypatch):
    (tmp_path / "assets").mkdir()
    (tmp_path / "config.json").write_text(json.dumps({
        "db_file": "pkm.sqlite3", "assets_dir": "assets",
        "password_salt": "00", "password_hash": "00",
        "session_secret": "cd" * 32, "cookie_secure": False,
    }), encoding="utf-8")
    captured: dict = {}

    class FakeUvicornConfig:
        def __init__(self, app, **kwargs):
            captured.update(kwargs)

    class FakeServer:
        def __init__(self, config):
            pass

        def run(self, sockets=None):
            for s in sockets or []:
                s.close()

    monkeypatch.setattr(run.uvicorn, "Config", FakeUvicornConfig)
    monkeypatch.setattr(run.uvicorn, "Server", FakeServer)
    assert run.main(["--data-dir", str(tmp_path), "--port", "0",
                     "--host", "127.0.0.1"]) == 0
    assert captured["access_log"] is False
    assert captured["log_config"] == uvicorn_log_config()
