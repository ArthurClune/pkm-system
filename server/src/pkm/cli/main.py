# pattern: Imperative Shell
"""`pkm` CLI: argparse dispatch over PkmClient. Output shaping lives in
cli.render, op planning in cli.build; this file is wiring, stdin/stdout,
and exit codes."""
from __future__ import annotations

import argparse
import getpass
import json
import sys
from collections.abc import Callable
from datetime import date, timedelta

import httpx2

from pkm.client import api as client_api
from pkm.client.api import PkmClient
from pkm.client.core import ApiError, CliConfig, ConfigError
from pkm.cli.render import (render_backlinks, render_block, render_groups,
                            render_page, render_search)
from pkm.server.daily import title_for_date
from pkm.server.ops_core import UID_RE

_RELATIVE = {"today": 0, "yesterday": -1, "tomorrow": 1}


def _login_http(url: str) -> httpx2.Client:
    return httpx2.Client(base_url=url)  # seam: tests inject a TestClient


def _emit(data: dict, rendered: str, as_json: bool) -> None:
    print(json.dumps(data, indent=2) if as_json else rendered, end="")
    if as_json:
        print()


def cmd_login(args: argparse.Namespace) -> int:
    url = args.url.rstrip("/")
    if args.password_stdin:
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = getpass.getpass(f"password for {url}: ")
    token = client_api.login(url, password, http=_login_http(url))
    client_api.save_config(CliConfig(url=url, token=token))
    print(f"logged in — config saved to {client_api.config_path()}")
    return 0


def cmd_get(args: argparse.Namespace, client: PkmClient) -> int:
    target = args.target
    if target in _RELATIVE:
        target = title_for_date(date.today()
                                + timedelta(days=_RELATIVE[target]))
    elif UID_RE.fullmatch(target):
        try:
            payload = client.get_block(target)
            _emit(payload, render_block(payload, args.uids), args.json)
            return 0
        except ApiError as e:
            if e.status != 404:
                raise
    payload = client.get_page(target)
    _emit(payload, render_page(payload, args.uids), args.json)
    return 0


def cmd_search(args: argparse.Namespace, client: PkmClient) -> int:
    payload = client.search(args.term, limit=args.limit)
    _emit(payload, render_search(payload), args.json)
    return 0


def cmd_refs(args: argparse.Namespace, client: PkmClient) -> int:
    payload = client.get_page(args.title)
    _emit(payload["backlinks"],
          render_backlinks(args.title, payload["backlinks"]), args.json)
    return 0


def cmd_query(args: argparse.Namespace, client: PkmClient) -> int:
    payload = client.run_query(args.expr)
    _emit(payload, render_groups(payload), args.json)
    return 0


def cmd_todos(args: argparse.Namespace, client: PkmClient) -> int:
    payload = client.todos(page=args.page)
    _emit(payload, render_groups(payload), args.json)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pkm", description="CLI for the PKM server")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("login", help="log in and save the session")
    p.add_argument("--url", default="http://127.0.0.1:8974")
    p.add_argument("--password-stdin", action="store_true",
                   help="read the password from stdin instead of a prompt")

    def _common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--json", action="store_true",
                       help="raw JSON payload instead of markdown")

    p = sub.add_parser("get", help="fetch a page, daily note, or block")
    p.add_argument("target",
                   help='page title, uid, or today/yesterday/tomorrow')
    p.add_argument("--uids", action="store_true",
                   help="annotate blocks with ^uid markers")
    _common(p)

    p = sub.add_parser("search", help="full-text search")
    p.add_argument("term")
    p.add_argument("--limit", type=int, default=20)
    _common(p)

    p = sub.add_parser("refs", help="backlinks for a page")
    p.add_argument("title")
    _common(p)

    p = sub.add_parser("query", help="structured {and:/or:/not:} query")
    p.add_argument("expr")
    _common(p)

    p = sub.add_parser("todos", help="list {{TODO}} blocks")
    p.add_argument("-p", "--page", default=None)
    _common(p)

    return parser


_HANDLERS: dict[str, Callable[[argparse.Namespace, PkmClient], int]] = {
    "get": cmd_get, "search": cmd_search, "refs": cmd_refs,
    "query": cmd_query, "todos": cmd_todos,
}


def main(argv: list[str] | None = None,
         make_client: Callable[[], PkmClient] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "login":
            return cmd_login(args)
        if make_client is None:
            make_client = lambda: PkmClient(client_api.load_config())  # noqa: E731
        return _HANDLERS[args.command](args, make_client())
    except (ApiError, ConfigError) as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
