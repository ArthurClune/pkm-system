import contextlib
import json
import logging
import logging.config
import re
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from pkm.server import run
from pkm.server.logfmt import (EscapePkmMessages, EscapingFormatter,
                               request_line, truncate_for_log,
                               uvicorn_log_config)
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


def test_uvicorn_log_config_configures_a_pkm_parent_logger():
    # A parent "pkm" logger carries the shared level/handler so every
    # pkm.* child (pkm.assets, pkm.assistant, pkm.describe, and any future
    # addition) inherits it by propagation instead of needing its own
    # entry here - a per-logger allowlist would let pkm.assets and
    # pkm.assistant silently lose their INFO logs (they'd inherit from the
    # unconfigured root logger instead).
    config = uvicorn_log_config()
    parent = config["loggers"]["pkm"]
    assert parent["level"] == "INFO"
    assert parent["propagate"] is False
    [handler_name] = parent["handlers"]
    handler = config["handlers"][handler_name]
    assert handler["class"] == "logging.StreamHandler"


def test_uvicorn_log_config_no_longer_lists_pkm_describe_individually():
    # Locks in the parent-policy replacement: pkm.describe needs no own
    # entry; it inherits from "pkm" like any other child.
    config = uvicorn_log_config()
    assert "pkm.describe" not in config["loggers"]


# Only matches a literal getLogger("pkm...") string argument - it can't see
# getLogger(__name__) children. That's fine: the "pkm" parent-logger policy
# (see test above) is what protects those, by propagation, so this enumeration
# doesn't need to catch them too. Don't broaden this regex to try to.
_LOGGER_CALL_RE = re.compile(r'getLogger\(\s*["\'](pkm(?:\.[A-Za-z0-9_]+)+)["\']\s*\)')


def _declared_pkm_loggers() -> set[str]:
    """Every `logging.getLogger("pkm...")` name declared anywhere under
    src/pkm, found by scanning source text rather than importing (so this
    stays cheap and doesn't need every module's runtime deps importable)."""
    src_root = Path(__file__).resolve().parents[1] / "src" / "pkm"
    return {name for path in src_root.rglob("*.py")
            for name in _LOGGER_CALL_RE.findall(path.read_text(encoding="utf-8"))}


@contextlib.contextmanager
def _dict_config_applied(config: dict):
    """Apply `config` via logging.config.dictConfig for the block, then
    restore every affected logger's handlers/level/propagate. dictConfig
    mutates process-global logger state, which would otherwise leak into
    later tests in this same pytest process (e.g. caplog-based ones that
    expect default propagation)."""
    affected = set(config["loggers"]) | _declared_pkm_loggers()
    snapshot = {name: (list(logging.getLogger(name).handlers),
                        logging.getLogger(name).level,
                        logging.getLogger(name).propagate)
                for name in affected}
    logging.config.dictConfig(config)
    try:
        yield
    finally:
        for name, (handlers, level, propagate) in snapshot.items():
            lg = logging.getLogger(name)
            lg.handlers = handlers
            lg.level = level
            lg.propagate = propagate


def _effective_handlers(logger: logging.Logger) -> list[logging.Handler]:
    """Mirrors the walk `Logger.callHandlers` does: collect handlers up the
    propagate=True ancestor chain, stopping at the first propagate=False
    logger (or the root) - i.e. what actually receives a log record."""
    handlers: list[logging.Handler] = []
    current: logging.Logger | None = logger
    while current is not None:
        handlers.extend(current.handlers)
        if not current.propagate:
            break
        current = current.parent
    return handlers


def test_every_declared_pkm_logger_has_an_effective_info_handler():
    # Enumerates every pkm.* logger declared in the codebase and, once
    # uvicorn_log_config() is applied, asserts each resolves to a real
    # handler at INFO. Guards against pkm.assets- or pkm.assistant-style
    # silent loss of lifecycle logs recurring for the next new pkm.*
    # logger.
    declared = _declared_pkm_loggers()
    assert declared >= {"pkm.access", "pkm.assets", "pkm.assistant", "pkm.describe"}
    with _dict_config_applied(uvicorn_log_config()):
        for name in declared:
            logger = logging.getLogger(name)
            assert logger.getEffectiveLevel() <= logging.INFO, (
                f"{name} would drop INFO lifecycle logs")
            assert _effective_handlers(logger), (
                f"{name} has no effective handler - its logs vanish silently")


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


def _run_main_capturing_uvicorn(tmp_path, monkeypatch, extra_args):
    (tmp_path / "assets").mkdir(exist_ok=True)
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
                     "--host", "127.0.0.1", *extra_args]) == 0
    return captured


def test_main_passes_timestamped_log_config_to_uvicorn(tmp_path, monkeypatch):
    captured = _run_main_capturing_uvicorn(tmp_path, monkeypatch, [])
    assert captured["access_log"] is False
    assert captured["log_config"] == uvicorn_log_config()


def test_main_log_dir_creates_it_and_selects_file_config(tmp_path, monkeypatch):
    log_dir = tmp_path / "logs" / "nested"
    captured = _run_main_capturing_uvicorn(
        tmp_path, monkeypatch, ["--log-dir", str(log_dir)])
    assert log_dir.is_dir()
    assert captured["log_config"] == uvicorn_log_config(log_dir)


_ROTATING = "logging.handlers.TimedRotatingFileHandler"


def test_log_config_without_dir_is_unchanged_stream_config():
    assert uvicorn_log_config(None) == uvicorn_log_config()
    handlers = uvicorn_log_config()["handlers"]
    assert handlers["default"]["class"] == "logging.StreamHandler"
    assert handlers["access"]["class"] == "logging.StreamHandler"


def test_log_config_with_dir_uses_daily_rotating_files(tmp_path):
    config = uvicorn_log_config(tmp_path)
    for name, filename in (("default", "server.log"), ("access", "access.log")):
        h = config["handlers"][name]
        assert h["class"] == _ROTATING
        assert h["filename"] == str(tmp_path / filename)
        assert h["when"] == "midnight"
        assert h["backupCount"] == 30
        assert h["encoding"] == "utf-8"
    assert config["formatters"]["default"]["use_colors"] is False
    assert {k: v["handlers"] for k, v in config["loggers"].items()
            if "handlers" in v} == {
        k: v["handlers"] for k, v in uvicorn_log_config()["loggers"].items()
        if "handlers" in v}


def test_log_config_keep_days_is_honoured(tmp_path):
    config = uvicorn_log_config(tmp_path, keep_days=7)
    assert config["handlers"]["default"]["backupCount"] == 7
    assert config["handlers"]["access"]["backupCount"] == 7


def test_log_dir_config_routes_lines_to_the_right_files(tmp_path, capsys):
    with _dict_config_applied(uvicorn_log_config(tmp_path)):
        try:
            logging.getLogger("pkm.access").info("access-line")
            logging.getLogger("pkm.assets").info("assets-line")
            logging.getLogger("uvicorn.error").info("uvicorn-line")
        finally:
            # _dict_config_applied restores handler lists without closing
            # the file handlers dictConfig opened.
            for h in _effective_handlers(logging.getLogger("pkm.access")) \
                    + _effective_handlers(logging.getLogger("pkm.assets")) \
                    + _effective_handlers(logging.getLogger("uvicorn.error")):
                h.flush()
                h.close()
    server = (tmp_path / "server.log").read_text(encoding="utf-8")
    access = (tmp_path / "access.log").read_text(encoding="utf-8")
    assert "access-line" in access
    assert "assets-line" not in access and "uvicorn-line" not in access
    assert "assets-line" in server and "uvicorn-line" in server
    assert "access-line" not in server
    assert "\x1b[" not in server
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err == ""


def _has_control(text: str) -> bool:
    return not text.isprintable()


def test_request_line_escapes_controls_in_every_field():
    line = request_line("1.2.3.4\n", "GE\tT", "/a\nFORGED\x1b[31m\x7f\x85", 200, 1)
    assert not _has_control(line)
    assert line == ('1.2.3.4\\x0a "GE\\x09T /a\\x0aFORGED\\x1b[31m\\x7f\\x85"'
                    ' 200 1ms')


def test_request_line_escapes_backslash_so_escapes_are_unambiguous():
    assert request_line(None, "GET", "/a\\x0a", 200, 0) == \
        '- "GET /a\\\\x0a" 200 0ms'
    assert request_line(None, "GET", "/a\n", 200, 0) == \
        '- "GET /a\\x0a" 200 0ms'


def test_request_line_escapes_the_quote_that_closes_the_request_field():
    line = request_line("1.2.3.4", "GET", '/a" 200 4ms', 401, 0)
    assert line == '1.2.3.4 "GET /a\\" 200 4ms" 401 0ms'


def test_request_line_escapes_line_separators_and_format_characters():
    line = request_line(None, "GET", "/a\u2028b\u2029c\u202ed\U000e0001e", 200, 0)
    assert line.isprintable()
    assert line == ('- "GET /a\\u2028b\\u2029c\\u202ed\\U000e0001e" 200 0ms')


def test_request_line_keeps_ordinary_non_ascii_readable():
    assert request_line(None, "GET", "/caf\u00e9/\u65e5\u672c", 200, 0) == \
        '- "GET /caf\u00e9/\u65e5\u672c" 200 0ms'


def test_truncate_for_log_boundary():
    assert truncate_for_log("x" * 10, 10) == "x" * 10
    assert truncate_for_log("x" * 11, 10) == "x" * 10 + "\u2026[truncated: 11 chars]"


def test_an_anonymous_request_cannot_forge_access_log_lines(anon_client, caplog):
    with caplog.at_level(logging.INFO, logger="pkm.access"):
        anon_client.get("/api/local/probe%0aFORGED%20LOG%20ENTRY%1b%5b31m")
    [record] = caplog.records
    assert not _has_control(record.message)
    assert "probe\\x0aFORGED LOG ENTRY\\x1b[31m" in record.message


def test_an_anonymous_request_cannot_forge_a_line_separator_or_status(
        anon_client, caplog):
    with caplog.at_level(logging.INFO, logger="pkm.access"):
        anon_client.get("/api/a%E2%80%A8FORGED%E2%80%A9x%22%20200%204ms")
    [record] = caplog.records
    assert record.message.isprintable()
    assert len(record.message.splitlines()) == 1
    assert '\\u2028FORGED\\u2029x\\" 200 4ms" ' in record.message


def _server_log_after(tmp_path: Path, emit) -> str:
    """server.log after `emit()` runs under the production file config, so
    each record passes through the handler and filters that config wires."""
    with _dict_config_applied(uvicorn_log_config(tmp_path)):
        try:
            emit()
        finally:
            for h in _effective_handlers(logging.getLogger("pkm")) \
                    + _effective_handlers(logging.getLogger("uvicorn.error")):
                h.flush()
                h.close()
    return (tmp_path / "server.log").read_text(encoding="utf-8")


def test_a_requested_local_path_cannot_forge_a_server_log_line(
        tmp_path, monkeypatch):
    from pkm.server import routes_local

    def no_brctl(*_args, **_kwargs):
        raise OSError("no brctl")
    monkeypatch.setattr(routes_local.subprocess, "run", no_brctl)
    forged = 'a.pdf\n2026-10-23 INFO:     forged\u2028"x'
    server = _server_log_after(
        tmp_path, lambda: routes_local._request_download(Path(forged)))
    assert server.count("\n") == 1
    assert 'a.pdf\\x0a2026-10-23 INFO:     forged\\u2028\\"x' in server


def test_a_local_open_probe_cannot_forge_a_server_log_line(tmp_path):
    from pkm.server.local_open import OpenProber

    def refuse(_key: str) -> None:
        raise PermissionError("denied\r\nforged")
    prober = OpenProber(opener=refuse, timeout=1.0)
    server = _server_log_after(
        tmp_path, lambda: prober.probe("doc\n.pdf"))
    assert server.count("\n") == 1
    assert "doc\\x0a.pdf failed: denied\\x0d\\x0aforged" in server


def _record(name: str, msg: str, args: tuple = (),
            exc_info=None) -> logging.LogRecord:
    return logging.LogRecord(name, logging.WARNING, __file__, 1, msg, args,
                             exc_info)


def test_escape_filter_renders_percent_args_before_escaping():
    original = _record("pkm.local", "probe for %s failed: %d", ("a\nb", 3))
    out = EscapePkmMessages().filter(original)
    assert out.msg == "probe for a\\x0ab failed: 3" and out.args == ()
    assert out.getMessage() == "probe for a\\x0ab failed: 3"
    assert original.msg == "probe for %s failed: %d"
    assert original.args == ("a\nb", 3)


def test_escape_filter_escapes_a_preformatted_message():
    name = 'x\u2028"y'
    out = EscapePkmMessages().filter(_record("pkm", f"asset {name} missing"))
    assert out.getMessage() == 'asset x\\u2028\\"y missing'


def test_escape_filter_keeps_the_traceback_for_the_formatter():
    try:
        raise ValueError("boom")
    except ValueError:
        exc_info = sys.exc_info()
    out = EscapePkmMessages().filter(
        _record("pkm.describe", "describe failed for %s", ("a\nb",),
                exc_info=exc_info))
    assert out.exc_info is exc_info
    rendered = logging.Formatter("%(message)s").format(out)
    assert rendered.startswith("describe failed for a\\x0ab\nTraceback")


def test_escape_filter_passes_uvicorn_records_unchanged():
    record = _record("uvicorn.error", "Exception in ASGI application\n")
    assert EscapePkmMessages().filter(record) is record
    assert EscapePkmMessages().filter(_record("pkmx", "a\nb")).msg == "a\nb"


@pytest.mark.parametrize("log_dir", [None, Path("/logs")])
def test_only_the_default_handler_escapes(log_dir):
    handlers = uvicorn_log_config(log_dir)["handlers"]
    assert handlers["default"]["filters"] == ["escape_pkm"]
    # pkm.access lines are already escaped by request_line.
    assert "filters" not in handlers["access"]


def test_an_access_line_is_escaped_once(tmp_path):
    line = request_line("c", "GET", '/a\n"b', 200, 1.0)
    with _dict_config_applied(uvicorn_log_config(tmp_path)):
        try:
            logging.getLogger("pkm.access").info(line)
        finally:
            for h in _effective_handlers(logging.getLogger("pkm.access")):
                h.flush()
                h.close()
    access = (tmp_path / "access.log").read_text(encoding="utf-8")
    assert '"GET /a\\x0a\\"b" 200' in access


_FORGED = "2026-10-23 12:00:00,000 INFO:     FORGED"


@pytest.mark.parametrize("logger_name, message", [
    ("pkm.describe", "describe failed for sha"),
    ("uvicorn.error", "Exception in ASGI application\n"),
])
def test_exception_text_cannot_forge_a_server_log_line(
        tmp_path, logger_name, message):
    def emit() -> None:
        try:
            raise ValueError(f"bad title x\n{_FORGED}\u2028\x1b[31m")
        except ValueError:
            logging.getLogger(logger_name).exception(message)
    server = _server_log_after(tmp_path, emit)
    lines = server.splitlines()
    assert not [line for line in lines if line.startswith(_FORGED)]
    assert lines[0][:4].isdigit()
    assert all(line.startswith("  ") for line in lines[1:])
    assert "\u2028" not in server and "\x1b" not in server
    assert "\\u2028\\x1b[31m" in server


def test_a_malformed_pkm_log_call_does_not_raise_into_the_caller(tmp_path):
    def emit() -> None:
        logging.getLogger("pkm.local").warning("probe %s failed: %s", "k")
    _server_log_after(tmp_path, emit)


def test_the_stderr_config_escapes_messages_and_tracebacks(capsys):
    # Production uses the file config; this drives the stream variant that
    # tests, e2e and scratch servers log through.
    with _dict_config_applied(uvicorn_log_config()):
        try:
            raise ValueError("bad\nforged")
        except ValueError:
            logging.getLogger("pkm.describe").exception("failed for %s",
                                                        "a\nb")
    err = capsys.readouterr().err.splitlines()
    assert err[0].endswith("failed for a\\x0ab")
    assert err[1:] and all(line.startswith("  ") for line in err[1:])
    assert err[-1] == "  forged"


def test_escaping_formatter_escapes_and_indents_a_stack():
    stack = 'Stack (most recent call last):\n  File "x\u2028y"'
    assert EscapingFormatter().formatStack(stack) == (
        '  Stack (most recent call last):\n    File "x\\u2028y"')
