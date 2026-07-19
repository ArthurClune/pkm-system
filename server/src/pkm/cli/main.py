# pattern: Imperative Shell
"""`pkm` CLI: argparse dispatch over PkmClient. Output shaping lives in
cli.render, op planning in cli.build; this file is wiring, stdin/stdout,
and exit codes."""
from __future__ import annotations

import argparse
import getpass
import json
import sys
import uuid
from collections.abc import Callable
from datetime import date, timedelta
from pathlib import Path

import httpx2

from pkm.client import api as client_api
from pkm.client.api import PkmClient
from pkm.client.core import ApiError, CliConfig, ConfigError
from pkm.cli.build import (BuildError, asset_block_text, plan_batch,
                           plan_save, referenced_pages)
from pkm.cli.render import (render_backlinks, render_block, render_groups,
                            render_page, render_search)
from pkm.server.daily import title_for_date
from pkm.server.ops_core import UID_RE, text_hash
from pkm.todo import with_state

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


def _read_text_arg(text: str | None) -> str:
    if text is None or text == "-":
        return sys.stdin.read()
    return text


def _ensure_page(client: PkmClient, title: str) -> dict:
    try:
        return client.get_page(title)
    except ApiError as e:
        if e.status != 404:
            raise
        client.create_page(title)
        return client.get_page(title)


def _default_page(page: str | None) -> str:
    return page if page is not None else title_for_date(date.today())


def cmd_save(args: argparse.Namespace, client: PkmClient) -> int:
    title = _default_page(args.page)
    payload = _ensure_page(client, title)
    ops = plan_save(payload, title, args.parent,
                    _read_text_arg(args.text), args.todo,
                    uids=iter(client_api.new_uid, None))
    client.post_ops(ops, batch_id=uuid.uuid4().hex)
    for op in ops:
        print(f"created ^{op['uid']}")
    return 0


def cmd_update(args: argparse.Namespace, client: PkmClient) -> int:
    changes = [args.text is not None, args.done, args.todo]
    if sum(changes) != 1:
        print("exactly one of TEXT, -D, or -T is required", file=sys.stderr)
        return 1
    current = client.get_block(args.uid)["block"]["text"]
    if args.done:
        new_text = with_state(current, "DONE")
    elif args.todo:
        new_text = with_state(current, "TODO")
    else:
        new_text = _read_text_arg(args.text)
    client.post_ops([{"op": "update_text", "uid": args.uid,
                      "text": new_text,
                      "base_text_hash": text_hash(current)}],
                    batch_id=uuid.uuid4().hex)
    print(f"updated ^{args.uid}")
    return 0


def cmd_upload(args: argparse.Namespace, client: PkmClient) -> int:
    asset = client.upload(Path(args.file))
    print(asset["url"])
    if args.no_block:
        return 0
    title = _default_page(args.page)
    payload = _ensure_page(client, title)
    text = asset_block_text(asset["filename"], asset["mime"], asset["url"])
    ops = plan_save(payload, title, args.parent, text, todo=False,
                    uids=iter(client_api.new_uid, None))
    client.post_ops(ops, batch_id=uuid.uuid4().hex)
    print(f"created ^{ops[0]['uid']}")
    return 0


def cmd_batch(args: argparse.Namespace, client: PkmClient) -> int:
    raw = sys.stdin.read()
    try:
        commands = json.loads(raw)
    except ValueError as e:
        print(f"stdin is not valid JSON: {e}", file=sys.stderr)
        return 1
    if not isinstance(commands, list):
        print("batch input must be a JSON array", file=sys.stderr)
        return 1
    pages = {title: _ensure_page(client, title)
             for title in referenced_pages(commands)}
    ops = plan_batch(commands, pages, uids=iter(client_api.new_uid, None))
    result = client.post_ops(ops, batch_id=uuid.uuid4().hex)
    print(f"applied {result['applied']} ops")
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

    p = sub.add_parser("save", help="create block(s); outline via stdin")
    p.add_argument("text", nargs="?", default=None,
                   help='block text, or "-" for stdin (multi-line = outline)')
    p.add_argument("-p", "--page", default=None,
                   help="target page (default: today's daily note)")
    p.add_argument("--parent", default=None,
                   help='"## Heading" (created if missing) or "((uid))"')
    p.add_argument("--todo", action="store_true",
                   help="prefix top-level items with {{TODO}}")

    p = sub.add_parser("update", help="update a block's text or task state")
    p.add_argument("uid")
    p.add_argument("text", nargs="?", default=None)
    p.add_argument("-D", "--done", action="store_true",
                   help="mark {{DONE}}")
    p.add_argument("-T", "--todo", action="store_true",
                   help="mark {{TODO}}")

    p = sub.add_parser("upload", help="upload a file and link it in a page")
    p.add_argument("file")
    p.add_argument("-p", "--page", default=None)
    p.add_argument("--parent", default=None)
    p.add_argument("--no-block", action="store_true",
                   help="upload only; print the URL, create no block")

    sub.add_parser("batch",
                   help="apply a JSON array of commands from stdin atomically")

    return parser


_HANDLERS: dict[str, Callable[[argparse.Namespace, PkmClient], int]] = {
    "get": cmd_get, "search": cmd_search, "refs": cmd_refs,
    "query": cmd_query, "todos": cmd_todos,
    "save": cmd_save, "update": cmd_update, "upload": cmd_upload,
    "batch": cmd_batch,
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
    except (ApiError, BuildError, ConfigError) as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
