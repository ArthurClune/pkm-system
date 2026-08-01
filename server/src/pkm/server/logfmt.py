# pattern: Functional Core
"""Log formatting: request lines and the uvicorn logging config.

Both exist because the stock uvicorn output proved undiagnosable after
the fact (pkm-0fx3): no timestamps anywhere and no request durations, so
a "the app hung yesterday" report can't be correlated with anything.
"""
from __future__ import annotations


def request_line(client: str | None, method: str, path: str,
                 status: int, duration_ms: float) -> str:
    """One access-log line: who asked for what, result, and how long."""
    return f'{client or "-"} "{method} {path}" {status} {duration_ms:.0f}ms'


def uvicorn_log_config() -> dict:
    """uvicorn's default logging dictconfig, plus timestamps on every
    formatter and a parent `pkm` logger wired to the default (stderr)
    handler at INFO, so every `pkm.*` child - `pkm.assets`, `pkm.assistant`,
    `pkm.describe`, `pkm.export`, and any future addition - inherits
    handlers/level/format by propagation with no per-logger entry needed.
    Without a configured ancestor, a child logger's INFO lines silently
    vanish via root-logger propagation (nothing configures the root
    logger); this bit `pkm.assets`
    and `pkm.assistant` before this parent policy existed, repeating the
    drift once fixed one logger at a time for `pkm.describe` (pkm-4z9r).

    `pkm.access` (the request-duration middleware, replacing uvicorn's own
    duration-less access log disabled in run.py) keeps its own explicit
    override: its lines are pre-formatted request summaries (see
    `request_line`), not level-prefixed lifecycle messages, and belong on
    stdout like uvicorn's own access log did - so launchd's two log files
    keep their roles (lifecycle/errors to stderr, access lines to stdout)."""
    return {
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
