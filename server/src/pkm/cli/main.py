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
from pkm.cli.render import (RenderError, clip_depth, render_assets,
                            render_backlinks, render_block, render_groups,
                            render_page, render_search, select_section)
from pkm.server.daily import title_for_date
from pkm.server.ops_core import UID_RE, text_hash
from pkm.todo import with_state

_RELATIVE = {"today": 0, "yesterday": -1, "tomorrow": 1}

_LOGIN_EPILOG = """\
example:
  pkm login --url http://127.0.0.1:8974

Prompts for a password interactively unless --password-stdin is
given, in which case the password is read from stdin (one line, no
prompt) instead -- use this in scripts and CI, e.g.:
  echo "mypassword" | pkm login --url http://host:port --password-stdin
On success the session token is saved to the CLI config file; every
other command reads it from there, so no further auth flags exist.
"""

_GET_EPILOG = """\
target forms:
  "Page Title"                   an exact page title
  today / yesterday / tomorrow   the daily note for that relative date
  a uid (6-32 chars, letters/digits/_/-)   fetches that single block,
                                 e.g. pkm get abcd1234wxyz -- if no
                                 block matches, falls back to a page
                                 lookup on that same string

flags:
  --uids           annotate each block with a trailing ^uid marker
  --resolve-refs   inline ((uid)) block refs as "text" ((uid))
  --section "## Heading"   only the subtree under that heading/block
                            (pages only, not a bare uid target)
  --depth N        clip nesting below N levels deep
  --json           raw JSON payload instead of rendered markdown

example:
  pkm get "Machine Learning" --section "## Papers" --depth 2
"""

_SEARCH_EPILOG = """\
full-text search over page titles and block text. By default the
last word of TERM is prefix-matched (e.g. "test" also matches
"testing"); --exact matches whole words only, no prefix wildcard.
--compact prints titles/uids only, without snippets -- useful when
you just want uids to feed into other commands. --limit caps results
(default 10, and applies separately to pages and blocks).

example:
  pkm search "machine learning" --limit 5
  pkm search proj --exact --compact
"""

_REFS_EPILOG = """\
lists every block that links to TITLE via [[Page Title]], #tag, or
{{alias}} syntax -- i.e. this page's backlinks -- grouped by the page
each linking block lives on.

example:
  pkm refs "Machine Learning"
"""

_QUERY_EPILOG = """\
structured query syntax over [[Page Title]] operands, nestable:
  {and: [[A]] [[B]]}          blocks referencing both A and B
  {or: [[A]] [[B]]}           blocks referencing either A or B
  {and: [[A]] {not: [[B]]}}   blocks referencing A but not B
"not" is only valid nested inside an "and" clause (matching Roam) --
a bare {not: ...} or one nested inside {or: ...} is an error.

--expand makes [[X]] also match blocks that reference some page Y
which itself references X (one hop of transitivity), in addition to
blocks that reference X directly.

When the query's total is 0, the output also lists a per-[[Page]]
block count for each operand, so you can tell an empty operand (typo,
wrong title) apart from operands that individually have matches but
whose combination doesn't.

example:
  pkm query "{and: [[Project Alpha]] {not: [[Done]]}}"
"""

_TODOS_EPILOG = """\
lists every {{TODO}} block (not {{DONE}}), grouped by page.

example:
  pkm todos -p "Project Alpha"
"""

_SAVE_EPILOG = """\
creates one or more blocks. A single-line TEXT creates one block;
multi-line TEXT (or piped via stdin using "-") is parsed as an
outline: each 2-space indent step (a tab also counts as one level)
nests one level deeper than its parent line. A line may not jump more
than one level deeper than the line before it.

--parent nests the new block(s) under an existing block, given as
either "## Heading" (a heading with that exact text; created at page
top level first if it doesn't already exist) or "((uid))" (an
existing block's uid). Without --parent, blocks are appended at page
top level. Without -p/--page, the target is today's daily note.

--todo prefixes only the top-level item(s) with {{TODO}}.

example:
  pkm save "Buy milk" --todo
  printf "Groceries\\n  Milk\\n  Eggs\\n" | pkm save - --parent "## Notes"
"""

_UPDATE_EPILOG = """\
updates a block's text or task state. Exactly one of TEXT, -D/--done,
or -T/--todo is required. TEXT may be "-" to read replacement text
from stdin. -D marks the block {{DONE}}; -T marks it {{TODO}} (both
keep the existing text, only changing the task marker).

Text updates are hash-guarded, but the write always wins -- it is
never rejected. `update` records the hash of the text you fetched; if
the block changed since then (another writer got there first), your
new text is still applied, and the text you overwrote is preserved,
unmodified, as a new sibling block placed right after the target and
tagged "[[conflict]] ..." -- find it via `pkm search`/`pkm refs
conflict` and merge by hand if needed.

example:
  pkm update abcd1234wxyz "Finalize the report"
  pkm update abcd1234wxyz -D
"""

_UPLOAD_EPILOG = """\
uploads FILE to the server's asset store and prints its URL. Unless
--no-block is given, a block linking the asset is also created (on
-p PAGE, default today's daily note; optionally nested under
--parent, same "## Heading"/"((uid))" forms as `pkm save`). The block
text depends on FILE's mime type: an image (image/*) embeds as
"![filename](url)", a PDF (application/pdf) links via the
{{[[pdf]]: url}} viewer macro, anything else links as a plain
"[filename](url)".

example:
  pkm upload ./diagram.png
  pkm upload ./report.pdf --parent "## Attachments"
  pkm upload ./data.csv --no-block
"""

_BATCH_EPILOG = """\
applies a JSON array of {"command": "...", "params": {...}} objects,
read from stdin, as one atomic write. Commands and their params:

  create   {page, text, parent?, index?, as?}
      appends one block. "as": "name" lets later commands in the same
      batch reference the created block via a parent/uid param of
      "{{name}}".
  todo     same params as create; text is stored {{TODO}}-prefixed.
  update   {uid, text}
      replaces a block's text (uid may be "{{alias}}"). Unlike
      standalone `pkm update`, batch update carries NO hash guard: it
      always overwrites, and never preserves a concurrent edit as a
      conflict sibling.
  move     {uid, page, parent?, index?}
      relocates a block to page/parent (uid and parent may use
      "{{alias}}"). Unlike create/todo/outline, move's "## Heading"
      destination is NOT created if missing -- the whole batch fails
      during planning (before any op is applied) if it doesn't
      already exist on the page.
  delete   {uid}
      removes a block (uid may be "{{alias}}").
  outline  {page, parent?, items}
      creates a nested outline; items is a list of strings and
      nested lists, one nesting level per indent, e.g.
      ["Groceries", ["Milk", "Eggs"]].

parent (create/todo/outline) accepts, and move's destination accepts
except where noted:
  "## Heading"   a heading with that exact text; create/todo/outline
                 create it once at page top level if missing --
                 repeating the same missing "## Heading" text (same
                 page, same level) elsewhere in the batch reuses that
                 one heading rather than creating it again (a repeat
                 on a different page, or at a different level, e.g.
                 "###", makes its own heading). move requires the
                 heading to already exist; see above.
  "((uid))"      an existing block's uid
  "{{alias}}"    a block created earlier in this same batch via "as"

"index" (create/todo/move only) inserts at that exact order_idx; the
server shifts existing siblings at/after it down to make room. Avoid
mixing an indexed create/todo with plain (appending) creates/todos
under the same parent within one batch: the plain ones count from the
parent's original child count and can interleave with the indexed one
instead of landing after it.

example:
  pkm batch <<'EOF'
  [
    {"command": "create",
     "params": {"page": "Groceries", "text": "Shopping list",
                "as": "list"}},
    {"command": "todo",
     "params": {"page": "Groceries", "parent": "{{list}}",
                "text": "Buy milk"}},
    {"command": "outline",
     "params": {"page": "Groceries", "parent": "## Notes",
                "items": ["Aisle 4", ["Oat milk", "Almond milk"]]}}
  ]
  EOF
"""

_ASSETS_EPILOG = """\
examples:
  # find images by their LLM-generated description or filename
  pkm assets search "bar chart revenue"

  # queue undescribed images for description; --force retries failures
  pkm assets scan
  pkm assets scan --force

search output: one asset per block — filename (mime, size, status), URL
path usable in a block as ![](url), then the description when present.
scan requires the server to have image descriptions enabled
(OPENAI_API_KEY set); when disabled it prints the reason and exits 1.
"""


def _login_http(url: str) -> httpx2.Client:
    return httpx2.Client(base_url=url)  # seam: tests inject a TestClient


def _emit(data: dict, rendered: str, as_json: bool) -> None:
    # minified: agent loops resend tool output every turn (pkm-roph)
    print(json.dumps(data, separators=(",", ":")) if as_json else rendered,
          end="")
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
            if args.section:
                print("--section only applies to pages", file=sys.stderr)
                return 1
            if args.depth:
                block = clip_depth([payload["block"]], args.depth)[0]
                payload = {**payload, "block": block}
            _emit(payload, render_block(payload, args.uids,
                                        resolve_refs=args.resolve_refs),
                 args.json)
            return 0
        except ApiError as e:
            if e.status != 404:
                raise
    payload = client.get_page(target)
    blocks = payload["blocks"]
    if args.section:
        blocks = select_section(blocks, args.section)
    if args.depth:
        blocks = clip_depth(blocks, args.depth)
    payload = {**payload, "blocks": blocks}
    _emit(payload, render_page(payload, args.uids,
                               resolve_refs=args.resolve_refs), args.json)
    return 0


def cmd_search(args: argparse.Namespace, client: PkmClient) -> int:
    payload = client.search(args.term, limit=args.limit, exact=args.exact)
    _emit(payload, render_search(payload, compact=args.compact), args.json)
    return 0


def cmd_refs(args: argparse.Namespace, client: PkmClient) -> int:
    payload = client.get_page(args.title)
    _emit(payload["backlinks"],
          render_backlinks(args.title, payload["backlinks"]), args.json)
    return 0


def cmd_query(args: argparse.Namespace, client: PkmClient) -> int:
    payload = client.run_query(args.expr, expand=args.expand)
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
        if args.text in (None, "-"):
            new_text = new_text.rstrip("\n")
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


def cmd_assets(args: argparse.Namespace, client: PkmClient) -> int:
    if args.assets_action == "search":
        print(render_assets(client.search_assets(args.query,
                                                 limit=args.limit)))
        return 0
    result = client.scan_assets(force=args.force)
    if not result["enabled"]:
        print(f"image descriptions are disabled: {result['reason']}",
              file=sys.stderr)
        return 1
    print(f"queued {result['queued']} asset(s) for description")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pkm", description="CLI for the PKM server")
    sub = parser.add_subparsers(dest="command", required=True)

    def _add(name: str, help: str, epilog: str) -> argparse.ArgumentParser:
        # every verb gets a worked example in its own --help: agents call
        # `pkm <verb> --help` in isolation and need it self-sufficient.
        return sub.add_parser(
            name, help=help,
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog=epilog)

    p = _add("login", "log in and save the session", _LOGIN_EPILOG)
    p.add_argument("--url", default="http://127.0.0.1:8974")
    p.add_argument("--password-stdin", action="store_true",
                   help="read the password from stdin instead of a prompt")

    def _common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--json", action="store_true",
                       help="raw JSON payload instead of markdown")

    p = _add("get", "fetch a page, daily note, or block", _GET_EPILOG)
    p.add_argument("target",
                   help='page title, uid, or today/yesterday/tomorrow')
    p.add_argument("--uids", action="store_true",
                   help="annotate blocks with ^uid markers")
    p.add_argument("--resolve-refs", action="store_true",
                   help="inline ((uid)) block refs as '\"text\" ((uid))'")
    p.add_argument("--section", default=None, metavar='"## Heading"',
                   help="only the subtree under this heading/block text")
    p.add_argument("--depth", type=int, default=None,
                   help="clip nesting deeper than N levels")
    _common(p)

    p = _add("search", "full-text search", _SEARCH_EPILOG)
    p.add_argument("term")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--exact", action="store_true",
                   help="match whole words only (no prefix wildcard)")
    p.add_argument("--compact", action="store_true",
                   help="titles and uids only, no snippets")
    _common(p)

    p = _add("refs", "backlinks for a page", _REFS_EPILOG)
    p.add_argument("title")
    _common(p)

    p = _add("query", "structured {and:/or:/not:} query", _QUERY_EPILOG)
    p.add_argument("expr")
    p.add_argument("--expand", action="store_true",
                   help="[[X]] also matches blocks referencing a page that"
                        " itself references X (one hop)")
    _common(p)

    p = _add("todos", "list {{TODO}} blocks", _TODOS_EPILOG)
    p.add_argument("-p", "--page", default=None)
    _common(p)

    p = _add("save", "create block(s); outline via stdin", _SAVE_EPILOG)
    p.add_argument("text", nargs="?", default=None,
                   help='block text, or "-" for stdin (multi-line = outline)')
    p.add_argument("-p", "--page", default=None,
                   help="target page (default: today's daily note)")
    p.add_argument("--parent", default=None,
                   help='"## Heading" (created if missing) or "((uid))"')
    p.add_argument("--todo", action="store_true",
                   help="prefix top-level items with {{TODO}}")

    p = _add("update", "update a block's text or task state", _UPDATE_EPILOG)
    p.add_argument("uid")
    p.add_argument("text", nargs="?", default=None)
    p.add_argument("-D", "--done", action="store_true",
                   help="mark {{DONE}}")
    p.add_argument("-T", "--todo", action="store_true",
                   help="mark {{TODO}}")

    p = _add("upload", "upload a file and link it in a page",
             _UPLOAD_EPILOG)
    p.add_argument("file")
    p.add_argument("-p", "--page", default=None)
    p.add_argument("--parent", default=None)
    p.add_argument("--no-block", action="store_true",
                   help="upload only; print the URL, create no block")

    _add("batch", "apply a JSON array of commands from stdin atomically",
         _BATCH_EPILOG)

    p = _add("assets", "search asset descriptions / queue a describe scan",
             _ASSETS_EPILOG)
    sub_assets = p.add_subparsers(dest="assets_action", required=True)
    sp = sub_assets.add_parser("search", help="search descriptions+filenames")
    sp.add_argument("query")
    sp.add_argument("--limit", type=int, default=50)
    sub_assets.add_parser("scan", help="queue undescribed images") \
        .add_argument("--force", action="store_true",
                      help="also retry previously failed images")

    return parser


_HANDLERS: dict[str, Callable[[argparse.Namespace, PkmClient], int]] = {
    "get": cmd_get, "search": cmd_search, "refs": cmd_refs,
    "query": cmd_query, "todos": cmd_todos,
    "save": cmd_save, "update": cmd_update, "upload": cmd_upload,
    "batch": cmd_batch, "assets": cmd_assets,
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
    except (ApiError, BuildError, ConfigError, RenderError) as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
