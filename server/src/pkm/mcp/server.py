# pattern: Imperative Shell
"""`pkm-mcp`: MCP stdio server exposing the PKM to MCP clients (Claude
Desktop, claude.ai). Thin wrappers over PkmClient, the shared write
workflows in `pkm.client.workflows`, and the pure renderers; the only
thing this file owns is how a result is phrased for an LLM, and the tool
docstrings, which are the LLM-facing contracts."""
from __future__ import annotations

from pathlib import Path

from mcp.server.fastmcp import FastMCP

from pkm.client import api as client_api
from pkm.client.api import PkmClient
from pkm.client.workflows import (apply_batch, edit_block, save_blocks,
                                  upload_and_link)
from pkm.render import (render_assets, render_backlinks, render_block,
                        render_groups, render_page, render_search)

mcp = FastMCP("pkm")

_client_factory = lambda: PkmClient(client_api.load_config())  # noqa: E731
_cached_client: PkmClient | None = None


def _client() -> PkmClient:
    global _cached_client
    if _cached_client is None:
        _cached_client = _client_factory()
    return _cached_client


def get_page(title: str, resolve_refs: bool = False) -> str:
    """Fetch a page as a markdown outline. Blocks are annotated with
    trailing ^uid markers usable with update_block/batch. `title` may be
    a daily-note title like 'July 19th, 2026'. resolve_refs=True inlines
    ((uid)) block refs as '"referenced text" ((uid))'."""
    return render_page(_client().get_page(title), include_uids=True,
                       resolve_refs=resolve_refs)


def get_block(uid: str, resolve_refs: bool = False) -> str:
    """Fetch one block's subtree (with its page and breadcrumb context)
    as markdown with ^uid markers. resolve_refs=True inlines ((uid)) block
    refs as '"referenced text" ((uid))'."""
    return render_block(_client().get_block(uid), include_uids=True,
                        resolve_refs=resolve_refs)


def search(q: str, limit: int = 20, exact: bool = False) -> str:
    """Full-text search over page titles and block text. exact=True
    matches whole words only (default prefix-matches the last term)."""
    return render_search(_client().search(q, limit=limit, exact=exact))


def query(expr: str, expand: bool = False) -> str:
    """Structured block query, Roam syntax: {and: [[A]] [[B]]},
    {or: ...}, {not: ...} (not only inside and). Operands are [[Page
    Title]] references. expand=True also matches blocks referencing a
    page that itself references the operand (one hop). An empty result
    includes per-operand match counts to steer the next query."""
    return render_groups(_client().run_query(expr, expand=expand))


def backlinks(title: str) -> str:
    """Pages and blocks that reference [[title]], grouped by source page."""
    return render_backlinks(title, _client().get_backlinks(title))


def todos(page: str | None = None) -> str:
    """List open {{TODO}} blocks, grouped by page; optionally one page."""
    return render_groups(_client().todos(page=page))


def save_note(text: str, page: str | None = None,
              parent: str | None = None, todo: bool = False) -> str:
    """Create block(s). Multi-line `text` becomes an outline (2-space
    indent = nesting). A line beginning '# ', '## ' or '### ' becomes a
    real heading at that level (1-3) with the hashes stripped; '#Tag' (no
    space) and '#### ' or deeper stay literal text. `page` defaults to
    today's daily note and is created if missing. `parent` is '## Heading'
    (created if missing) or '((uid))'. todo=True prefixes top-level items
    with {{TODO}}."""
    save_ops = save_blocks(_client(), text, page=page, parent=parent,
                           todo=todo)
    return "\n".join(f"created ^{op.uid}" for op in save_ops)


def update_block(uid: str, text: str | None = None,
                 mark: str | None = None) -> str:
    """Replace a block's text, or set its task marker (mark='TODO' or
    'DONE'). Provide exactly one of text/mark. A `text` beginning '# ',
    '## ' or '### ' makes the block a heading at that level (1-3); '#Tag'
    (no space) and '#### ' or deeper stay literal text. Text without
    those hashes clears any heading it had. `mark` only changes the task
    marker and never the heading level. Concurrent-edit safe: the current
    text's hash rides along."""
    edit_block(_client(), uid, text=text, mark=mark)
    return f"updated ^{uid}"


def batch(commands: list[dict]) -> str:
    """Apply several commands in ONE atomic transaction. Each item is
    {"command": ..., "params": {...}} with commands: create (page, text,
    parent?, as?), todo (like create, {{TODO}}-prefixed), update (uid,
    text), move (uid, page, parent?, index?), delete (uid), outline
    (page, parent?, items: nested string arrays). 'as' names a created
    block; later parents may reference it as '{{alias}}'. A '## Heading'
    parent is matched on the page or created once per batch: repeating
    the same spec across commands reuses the heading already created.
    A create/todo/outline text beginning '# ', '## ' or '### ' becomes a
    heading at that level; an `update` text sets or clears the level the
    same way."""
    return f"applied {apply_batch(_client(), commands)} ops"


def upload_asset(path: str, page: str | None = None,
                 parent: str | None = None) -> str:
    """Upload a local file and link it from a page (default: today's
    daily note): images embed as ![](...), PDFs as the {{[[pdf]]}} macro,
    anything else as a plain link."""
    p = Path(path)
    if not p.is_file():
        raise ValueError(f"no such file: {path}")
    linked = upload_and_link(_client(), p, page=page, parent=parent)
    return f"{linked.url}\ncreated ^{linked.uid}"


def rename_page(title: str, new_title: str, allow_merge: bool = False) -> str:
    """Rename a page, rewriting every [[link]]/#tag/attr:: reference to it
    in block text so it points at new_title instead. Case-sensitive;
    daily-note pages cannot be renamed. If new_title already names an
    existing page, this fails unless allow_merge=True, in which case
    title's page is merged into new_title (its top-level blocks appended
    after new_title's, its page row then dropped) -- irreversible, so
    default to False and confirm with the user first."""
    result = _client().rename_page(title, new_title, allow_merge=allow_merge)
    if result.result == "merged":
        return f'merged "{title}" into "{result.title}"'
    return f'renamed "{title}" -> "{result.title}"'


def search_assets(q: str, limit: int = 20) -> str:
    """Find uploaded images/files by LLM-generated image description or
    filename. Returns filename, status, a /assets/... URL embeddable in a
    block as ![](url), the description, and every block referencing the
    asset as 'in [[page title]] ((uid))' — cite those directly instead of
    searching for the asset's page with get_page. Images are described
    automatically after upload when the feature is enabled."""
    return render_assets(_client().search_assets(q, limit=limit))


for _fn in (get_page, get_block, search, query, backlinks, todos,
            save_note, update_block, batch, upload_asset, search_assets,
            rename_page):
    mcp.tool()(_fn)


def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
