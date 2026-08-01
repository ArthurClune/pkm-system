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
    formatter and `pkm.access` (the request-duration middleware, replacing
    uvicorn's own duration-less access log disabled in run.py),
    `pkm.describe` (the image-description service), and `pkm.export` (the
    markdown+assets export writer, pkm-x3l7's asset-repair warnings)
    loggers wired to the same stdout handler, so their INFO+ lines don't
    silently drop via root-logger propagation. Streams match uvicorn's
    defaults: lifecycle/errors to stderr, access lines to stdout, so
    launchd's two log files keep their roles."""
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
            "pkm.access": {"handlers": ["access"], "level": "INFO",
                           "propagate": False},
            "pkm.describe": {"handlers": ["access"], "level": "INFO",
                             "propagate": False},
            "pkm.export": {"handlers": ["access"], "level": "INFO",
                          "propagate": False},
        },
    }
