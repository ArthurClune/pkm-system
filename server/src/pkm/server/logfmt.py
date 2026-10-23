# pattern: Functional Core
"""Log formatting: request lines and the uvicorn logging config.

Both exist because the stock uvicorn output proved undiagnosable after
the fact: no timestamps anywhere and no request durations, so
a "the app hung yesterday" report can't be correlated with anything.
"""
from __future__ import annotations

import copy
import logging
from pathlib import Path
from typing import Any


def _escape_char(char: str) -> str:
    if char == "\\" or char == '"':
        return "\\" + char
    if char.isprintable():
        return char
    code = ord(char)
    if code < 0x100:
        return f"\\x{code:02x}"
    return f"\\u{code:04x}" if code < 0x10000 else f"\\U{code:08x}"


def escape_controls(text: str) -> str:
    """`text` with each non-printable character (controls, DEL, line and
    paragraph separators, format characters) as `\\xNN`, `\\uNNNN` or
    `\\UNNNNNNNN`, and each backslash or double quote backslash-escaped, so
    an escape never reads as typed text and a quote never ends a field."""
    return "".join(_escape_char(c) for c in text)


def truncate_for_log(text: str, cap: int) -> str:
    """`text` unchanged up to `cap` characters; longer text is cut at the cap
    and followed by a marker naming the full length."""
    if len(text) <= cap:
        return text
    return f"{text[:cap]}\u2026[truncated: {len(text)} chars]"


class EscapePkmMessages(logging.Filter):
    """Escapes the rendered message of every `pkm` and `pkm.*` record with
    `escape_controls`, so a path, filename or error text a request put in a
    message cannot forge a server-log line whichever logger carries it.

    It returns an escaped copy with `args` emptied, covering `%`-style and
    pre-formatted messages alike, and leaves the record other handlers see
    untouched. Tracebacks stay multi-line: the formatter renders `exc_info`
    from code, not from the request. uvicorn's records pass unchanged:
    they carry no request text, end a message with the newline before a
    traceback on purpose, and its formatter re-renders `color_message`
    with the record's `args`."""

    def filter(self, record: logging.LogRecord) -> logging.LogRecord:
        if record.name != "pkm" and not record.name.startswith("pkm."):
            return record
        escaped = copy.copy(record)
        escaped.msg = escape_controls(record.getMessage())
        escaped.args = ()
        return escaped


def request_line(client: str | None, method: str, path: str,
                 status: int, duration_ms: float) -> str:
    """One access-log line: who asked for what, result, and how long.

    The client controls `path` and `method`, so each field is escaped: a
    raw newline, ESC, quote or line separator would forge a log line or
    status, or recolour a terminal."""
    return (f'{escape_controls(client or "-")} '
            f'"{escape_controls(method)} {escape_controls(path)}" '
            f'{status} {duration_ms:.0f}ms')


def uvicorn_log_config(log_dir: Path | None = None,
                       keep_days: int = 30) -> dict[str, Any]:
    """uvicorn's default logging dictconfig, plus timestamps on every
    formatter and a parent `pkm` logger wired to the default (stderr)
    handler at INFO, so every `pkm.*` child - `pkm.assets`, `pkm.assistant`,
    `pkm.describe`, `pkm.export`, and any future addition - inherits
    handlers/level/format by propagation with no per-logger entry needed.
    Without a configured ancestor, a child logger's INFO lines silently
    vanish via root-logger propagation (nothing configures the root
    logger); this bit `pkm.assets`
    and `pkm.assistant` before this parent policy existed, repeating the
    drift once fixed one logger at a time for `pkm.describe`.

    `pkm.access` (the request-duration middleware, replacing uvicorn's own
    duration-less access log disabled in run.py) keeps its own explicit
    override: its lines are pre-formatted request summaries (see
    `request_line`), not level-prefixed lifecycle messages, and belong on
    stdout like uvicorn's own access log did.

    With `log_dir`, lifecycle/errors go to `server.log` and access lines to
    `access.log` there, each rotated at midnight with `keep_days` dated
    copies kept (`server.log.YYYY-MM-DD`); launchd's own files then catch
    only what escapes logging. Without one, the stderr/stdout split above
    (tests, e2e and scratch servers). Either way the default handler runs
    `EscapePkmMessages`; `pkm.access` lines are escaped by `request_line`
    and never reach it. Pure: dictConfig opens the files."""
    config: dict[str, Any] = {
        "version": 1,
        "disable_existing_loggers": False,
        "filters": {
            "escape_pkm": {"()": EscapePkmMessages},
        },
        "formatters": {
            "default": {
                "()": "uvicorn.logging.DefaultFormatter",
                "fmt": "%(asctime)s %(levelprefix)s %(message)s",
            },
            "access": {
                "format": "%(asctime)s %(levelname)s:     %(message)s",
            },
        },
        "handlers": {
            "default": {
                "formatter": "default",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stderr",
                "filters": ["escape_pkm"],
            },
            "access": {
                "formatter": "access",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
            },
        },
        "loggers": {
            "uvicorn": {"handlers": ["default"], "level": "INFO",
                        "propagate": False},
            "uvicorn.error": {"level": "INFO"},
            "pkm": {"handlers": ["default"], "level": "INFO",
                    "propagate": False},
            "pkm.access": {"handlers": ["access"], "level": "INFO",
                           "propagate": False},
        },
    }
    if log_dir is not None:
        rotation: dict[str, Any] = {"class": "logging.handlers.TimedRotatingFileHandler",
                    "when": "midnight", "backupCount": keep_days,
                    "encoding": "utf-8"}
        config["handlers"] = {
            "default": {"formatter": "default", "filters": ["escape_pkm"],
                        "filename": str(log_dir / "server.log"), **rotation},
            "access": {"formatter": "access",
                       "filename": str(log_dir / "access.log"), **rotation},
        }
        # DefaultFormatter otherwise colours by sys.stdout.isatty(), which
        # would put ANSI codes in the file when run from a terminal.
        config["formatters"]["default"]["use_colors"] = False
    return config
