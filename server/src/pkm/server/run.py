# pattern: Imperative Shell
"""Run the PKM server: python -m pkm.server.run --data-dir ../data

Binds every host in config `bind_hosts` (or repeated --host flags) on one
port — deployment listens on 127.0.0.1 (Tailscale Serve's proxy target)
plus the machine's Tailscale IP for direct tailnet clients."""
from __future__ import annotations

import argparse
import socket
from pathlib import Path

import uvicorn

from pkm.server.app import create_app
from pkm.server.config import load_config


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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the PKM server.")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--port", type=int, default=8974)
    ap.add_argument("--host", action="append", dest="hosts", default=None,
                    help="repeatable; overrides config bind_hosts")
    args = ap.parse_args(argv)
    config = load_config(Path(args.data_dir) / "config.json")
    hosts = args.hosts if args.hosts else list(config.bind_hosts)
    sockets = bind_sockets(hosts, args.port)
    server = uvicorn.Server(uvicorn.Config(create_app(config), port=args.port))
    server.run(sockets=sockets)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
