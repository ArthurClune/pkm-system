# pattern: Imperative Shell
"""Write data/config.json, prompting for the password:
python -m pkm.server.setup --data-dir ../data"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import secrets
from pathlib import Path

from pkm.server.auth_core import hash_password


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Initialise PKM server config.")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--password", help="omit to be prompted")
    ap.add_argument("--insecure-cookie", action="store_true",
                    help="allow the session cookie over plain http (dev only)")
    ap.add_argument("--web-dist",
                    help="path to the built SPA dist dir, relative to the"
                         " data dir (e.g. ../web/dist); omit for API-only")
    args = ap.parse_args(argv)
    password = args.password or getpass.getpass("password: ")
    salt = secrets.token_bytes(16)
    cfg = {
        "db_file": "pkm.sqlite3",
        "assets_dir": "assets",
        "password_salt": salt.hex(),
        "password_hash": hash_password(password, salt),
        "session_secret": secrets.token_bytes(32).hex(),
        "cookie_secure": not args.insecure_cookie,
    }
    if args.web_dist:
        cfg["web_dist"] = args.web_dist
    out = Path(args.data_dir) / "config.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.name}.{secrets.token_hex(8)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(cfg, indent=2))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, out)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
