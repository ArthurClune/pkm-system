# pattern: Imperative Shell
"""Run the PKM server: python -m pkm.server.run --data-dir ../data

Binds every host in config `bind_hosts` (or repeated --host flags) on one
port — deployment listens on 127.0.0.1 (Tailscale Serve's proxy target)
plus the machine's Tailscale IP for direct tailnet clients."""
from __future__ import annotations

import argparse
import dataclasses
import socket
from pathlib import Path
from typing import Any

import uvicorn
from starlette.types import ASGIApp

from pkm.server.app import create_app
from pkm.server.config import load_config
from pkm.server.http_protocol import DeadlineH11Protocol
from pkm.server.logfmt import uvicorn_log_config

# The only peer whose X-Forwarded-For uvicorn believes: Tailscale Serve's
# upstream connection, which install.sh's `serve` line points at
# http://127.0.0.1:<port>. Serve replaces any X-Forwarded-For the client
# sent, so on loopback request.client.host (the login throttle's key) is
# the connecting device's tailnet address; peers on the Tailscale-IP
# listener are never trusted, so a forged header there is ignored. Passed
# explicitly because otherwise uvicorn takes the FORWARDED_ALLOW_IPS
# environment variable, and `*` there would key on the left-most entry,
# which the client chooses. Must change if Serve's upstream ever does.
FORWARDED_ALLOW_IPS = "127.0.0.1"


def bind_sockets(hosts: list[str], port: int) -> list[socket.socket]:
    """One bound (not yet listening) socket per host, all on `port`.
    On any failure, close everything already bound and re-raise — launchd
    KeepAlive retries until e.g. the Tailscale IP becomes bindable."""
    socks: list[socket.socket] = []
    try:
        for host in hosts:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
            socks.append(s)
    except OSError:
        for s in socks:
            s.close()
        raise
    return socks


def uvicorn_config(app: ASGIApp, port: int,
                   log_config: dict[str, Any] | None) -> uvicorn.Config:
    """How every listener serves `app`. access_log=False: the
    RequestLogMiddleware in create_app() emits the access lines instead
    (stdout, or access.log under --log-dir, plus durations).
    DeadlineH11Protocol closes a connection whose request head is late,
    which uvicorn's own protocols never do."""
    return uvicorn.Config(app, port=port, log_config=log_config,
                          access_log=False, proxy_headers=True,
                          forwarded_allow_ips=FORWARDED_ALLOW_IPS,
                          http=DeadlineH11Protocol)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the PKM server.")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--port", type=int, default=8974)
    ap.add_argument("--host", action="append", dest="hosts", default=None,
                    help="repeatable; overrides config bind_hosts")
    ap.add_argument("--log-dir", default=None,
                    help="write rotating log files here instead of "
                         "stdout/stderr")
    args = ap.parse_args(argv)
    config = load_config(Path(args.data_dir) / "config.json")
    hosts = args.hosts if args.hosts else list(config.bind_hosts)
    sockets = bind_sockets(hosts, args.port)
    # create_app() runs init_db() (WAL mode + base schema) itself, so
    # serving is never accidentally started against a non-WAL or
    # schema-less (e.g. brand-new, never-imported) database.
    if args.log_dir:
        Path(args.log_dir).mkdir(parents=True, exist_ok=True)
        log_config = uvicorn_log_config(Path(args.log_dir))
    else:
        log_config = uvicorn_log_config()
    server = uvicorn.Server(uvicorn_config(
        # The bound hosts, not the config's, are the listeners whose
        # origins the guard allows.
        create_app(dataclasses.replace(config, bind_hosts=tuple(hosts)),
                   api_port=args.port),
        port=args.port, log_config=log_config))
    server.run(sockets=sockets)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
