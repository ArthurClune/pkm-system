# pattern: Imperative Shell
"""`pkm-mcp`: MCP stdio server exposing the PKM to MCP clients (Claude
Desktop, claude.ai). Thin wrappers over PkmClient + the CLI's pure
planners/renderers; tool docstrings are the LLM-facing contracts."""
from __future__ import annotations

import uuid
from datetime import date
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from pkm.client import api as client_api
from pkm.client.api import PkmClient
from pkm.cli.build import asset_block_text, plan_batch, plan_save, referenced_pages
from pkm.cli.render import (render_backlinks, render_block, render_groups,
                            render_page, render_search)
from pkm.server.daily import title_for_date
from pkm.server.ops_core import text_hash
from pkm.todo import with_state

mcp = FastMCP("pkm")

_client_factory = lambda: PkmClient(client_api.load_config())  # noqa: E731
_cached_client: PkmClient | None = None


def _client() -> PkmClient:
    global _cached_client
    if _cached_client is None:
        _cached_client = _client_factory()
    return _cached_client


def _uids():
    return iter(client_api.new_uid, None)


def _ensure_page(client: PkmClient, title: str) -> dict:
    from pkm.client.core import ApiError
    try:
        return client.get_page(title)
    except ApiError as e:
        if e.status != 404:
            raise
        client.create_page(title)
        return client.get_page(title)


def get_page(title: str) -> str:
    """Fetch a page as a markdown outline. Blocks are annotated with
    trailing ^uid markers usable with update_block/batch. `title` may be
    a daily-note title like 'July 19th, 2026'."""
    return render_page(_client().get_page(title), include_uids=True)


def get_block(uid: str) -> str:
    """Fetch one block's subtree (with its page and breadcrumb context)
    as markdown with ^uid markers."""
    return render_block(_client().get_block(uid), include_uids=True)


def search(q: str, limit: int = 20) -> str:
    """Full-text search over page titles and block text."""
    return render_search(_client().search(q, limit=limit))


def query(expr: str) -> str:
    """Structured block query, Roam syntax: {and: [[A]] [[B]]},
    {or: ...}, {not: ...} (not only inside and). Operands are [[Page
    Title]] references."""
    return render_groups(_client().run_query(expr))


def backlinks(title: str) -> str:
    """Pages and blocks that reference [[title]], grouped by source page."""
    payload = _client().get_page(title)
    return render_backlinks(title, payload["backlinks"])


def todos(page: str | None = None) -> str:
    """List open {{TODO}} blocks, grouped by page; optionally one page."""
    return render_groups(_client().todos(page=page))


def save_note(text: str, page: str | None = None,
              parent: str | None = None, todo: bool = False) -> str:
    """Create block(s). Multi-line `text` becomes an outline (2-space
    indent = nesting). `page` defaults to today's daily note and is
    created if missing. `parent` is '## Heading' (created if missing) or
    '((uid))'. todo=True prefixes top-level items with {{TODO}}."""
    client = _client()
    title = page if page is not None else title_for_date(date.today())
    payload = _ensure_page(client, title)
    ops = plan_save(payload, title, parent, text, todo, uids=_uids())
    client.post_ops(ops, batch_id=uuid.uuid4().hex)
    return "\n".join(f"created ^{op['uid']}" for op in ops)


def update_block(uid: str, text: str | None = None,
                 mark: str | None = None) -> str:
    """Replace a block's text, or set its task marker (mark='TODO' or
    'DONE'). Provide exactly one of text/mark. Concurrent-edit safe: the
    current text's hash rides along."""
    if (text is None) == (mark is None):
        raise ValueError("provide exactly one of text or mark")
    if mark is not None and mark not in ("TODO", "DONE"):
        raise ValueError("mark must be 'TODO' or 'DONE'")
    client = _client()
    current = client.get_block(uid)["block"]["text"]
    new_text = with_state(current, mark) if mark is not None else text
    assert new_text is not None
    client.post_ops([{"op": "update_text", "uid": uid, "text": new_text,
                      "base_text_hash": text_hash(current)}],
                    batch_id=uuid.uuid4().hex)
    return f"updated ^{uid}"


def batch(commands: list[dict]) -> str:
    """Apply several commands in ONE atomic transaction. Each item is
    {"command": ..., "params": {...}} with commands: create (page, text,
    parent?, as?), todo (like create, {{TODO}}-prefixed), update (uid,
    text), move (uid, page, parent?, index?), delete (uid), outline
    (page, parent?, items: nested string arrays). 'as' names a created
    block; later parents may reference it as '{{alias}}'."""
    client = _client()
    pages = {t: _ensure_page(client, t) for t in referenced_pages(commands)}
    ops = plan_batch(commands, pages, uids=_uids())
    result = client.post_ops(ops, batch_id=uuid.uuid4().hex)
    return f"applied {result['applied']} ops"


def upload_asset(path: str, page: str | None = None,
                 parent: str | None = None) -> str:
    """Upload a local file and link it from a page (default: today's
    daily note): images embed as ![](...), PDFs as the {{[[pdf]]}} macro,
    anything else as a plain link."""
    p = Path(path)
    if not p.is_file():
        raise ValueError(f"no such file: {path}")
    client = _client()
    asset = client.upload(p)
    title = page if page is not None else title_for_date(date.today())
    payload = _ensure_page(client, title)
    text = asset_block_text(asset["filename"], asset["mime"], asset["url"])
    ops = plan_save(payload, title, parent, text, todo=False, uids=_uids())
    client.post_ops(ops, batch_id=uuid.uuid4().hex)
    return f"{asset['url']}\ncreated ^{ops[0]['uid']}"


for _fn in (get_page, get_block, search, query, backlinks, todos,
            save_note, update_block, batch, upload_asset):
    mcp.tool()(_fn)


def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
