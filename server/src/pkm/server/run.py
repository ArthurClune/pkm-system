# pattern: Imperative Shell
"""Run the PKM server: python -m pkm.server.run --data-dir ../data"""
from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from pkm.server.app import create_app
from pkm.server.config import load_config


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the PKM server.")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--port", type=int, default=8974)
    args = ap.parse_args(argv)
    config = load_config(Path(args.data_dir) / "config.json")
    uvicorn.run(create_app(config), host="127.0.0.1", port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
