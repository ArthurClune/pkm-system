# pattern: Functional Core
"""Log formatting: request lines and the uvicorn logging config.

Both exist because the stock uvicorn output proved undiagnosable after
the fact: no timestamps anywhere and no request durations, so
a "the app hung yesterday" report can't be correlated with anything.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any


def request_line(client: str | None, method: str, path: str,
                 status: int, duration_ms: float) -> str:
    """One access-log line: who asked for what, result, and how long."""
    return f'{client or "-"} "{method} {path}" {status} {duration_ms:.0f}ms'


def uvicorn_log_config(log_dir: Path | None = None,
                       keep_days: int = 30) -> dict:
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
    (tests, e2e and scratch servers). Pure: dictConfig opens the files."""
    config: dict[str, Any] = {
        "version": 1,
        "disable_existing_loggers": False,
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
            "default": {"formatter": "default",
                        "filename": str(log_dir / "server.log"), **rotation},
            "access": {"formatter": "access",
                       "filename": str(log_dir / "access.log"), **rotation},
        }
        # DefaultFormatter otherwise colours by sys.stdout.isatty(), which
        # would put ANSI codes in the file when run from a terminal.
        config["formatters"]["default"]["use_colors"] = False
    return config
