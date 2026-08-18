# pattern: Imperative Shell
"""The write workflows the CLI and the MCP server both perform, in one
place: fetch what a plan needs, plan it, post it as one atomic batch.

Each of these was duplicated line-for-line between `pkm.cli.main` and
`pkm.mcp.server`, which is how a fix could land in one and not the other
(the ordering rules below are all bought by past bugs). What is
deliberately NOT here is presentation: the CLI prints, the MCP server
returns strings, and each shell keeps its own argument handling (stdin,
argparse exit codes, MCP's tool docstrings). These functions return
values -- created ops, an applied count -- for the shells to phrase.

The pure planners they call are `pkm.planning` and `pkm.batch`, which sit
outside every shell for the same reason this module does."""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from pkm.batch import plan_batch, referenced_pages, validate_batch
from pkm.client.api import PkmClient, new_uid
from pkm.client.core import ApiError
from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import BlockOp, CreateOp
from pkm.planning import (asset_block_text, create_page_ops, plan_mark,
                          plan_save, plan_update, resolve_parent)


def _uids():
    return iter(new_uid, None)


def _batch_id() -> str:
    return uuid.uuid4().hex


def default_page_title(page: str | None) -> str:
    """`page`, or today's daily note when none was given -- the default
    target for every write the CLI and MCP server can perform without an
    explicit page."""
    return page if page is not None else title_for_date(date.today())


@dataclass(frozen=True)
class LinkedUpload:
    """An asset that landed AND is linked from a block."""
    url: str
    uid: str


def save_blocks(client: PkmClient, text: str, page: str | None = None,
                parent: str | None = None,
                todo: bool = False) -> list[CreateOp]:
    """Create the block(s) `text` outlines, returning the create ops that
    were applied so the caller can report their uids.

    A missing page is created by an op *inside* the same batch rather than
    by a separate request, so a plan that fails validation later leaves no
    empty page behind (pkm-w80k)."""
    title = default_page_title(page)
    blocks, missing = client.get_page_blocks(title)
    save_ops = plan_save(blocks, title, parent, text, todo, uids=_uids())
    ops: list[BlockOp] = [*(create_page_ops([title]) if missing else []),
                          *save_ops]
    client.post_ops(ops, batch_id=_batch_id())
    return save_ops


def edit_block(client: PkmClient, uid: str, text: str | None = None,
               mark: str | None = None) -> None:
    """Replace a block's text, or set its task marker. Exactly one of
    `text`/`mark`.

    Both paths read the block first, and must: a text edit rides a
    `base_text_hash` guard computed from what was actually stored, and
    passes the block's current heading level so an unchanged level emits
    no `set_heading` (which would turn the server's conflict rescue into
    a hard failure -- see `plan_update`). A marker change goes through
    `plan_mark` precisely so it does NOT re-derive the heading from text
    the API already returned bare."""
    if (text is None) == (mark is None):
        raise ValueError("provide exactly one of text or mark")
    if mark is not None and mark not in ("TODO", "DONE"):
        raise ValueError("mark must be 'TODO' or 'DONE'")
    block = client.get_block(uid).block
    if mark is not None:
        ops: list[BlockOp] = list(plan_mark(uid, block.text, mark))
    else:
        assert text is not None
        ops = plan_update(uid, text, block.text, block.heading)
    client.post_ops(ops, batch_id=_batch_id())


def apply_batch(client: PkmClient, commands: object) -> int:
    """Apply a `{command, params}` batch atomically; returns the op count
    the server applied.

    Validation runs before any page is fetched or created, so a malformed
    batch triggers no I/O at all (pkm-4w23), and every page the batch
    names is fetched once up front -- planning needs each page's existing
    blocks to compute append positions."""
    parsed = validate_batch(commands)
    fetched = {title: client.get_page_blocks(title)
               for title in referenced_pages(parsed)}
    pages = {title: blocks for title, (blocks, _) in fetched.items()}
    missing = [title for title, (_, is_missing) in fetched.items()
               if is_missing]
    ops: list[BlockOp] = [*create_page_ops(missing),
                          *plan_batch(parsed, pages, uids=_uids())]
    return client.post_ops(ops, batch_id=_batch_id()).applied


def upload_and_link(client: PkmClient, path: Path, page: str | None = None,
                    parent: str | None = None) -> LinkedUpload:
    """Upload `path` and link it from a block, as one outcome: either both
    happened or neither did.

    The destination is resolved BEFORE the upload, so an invalid parent
    can't leave an unreferenced asset on the server; and if the linking
    batch fails afterwards, the asset is deleted again -- but only when
    this call is what created it, since the same bytes may already be
    referenced by an older block (pkm-c17m)."""
    title = default_page_title(page)
    blocks, missing = client.get_page_blocks(title)
    resolve_parent(blocks, parent)
    asset = client.upload(path)
    text = asset_block_text(asset.filename, asset.mime, asset.url)
    save_ops = plan_save(blocks, title, parent, text, todo=False,
                         uids=_uids())
    ops: list[BlockOp] = [*(create_page_ops([title]) if missing else []),
                          *save_ops]
    try:
        client.post_ops(ops, batch_id=_batch_id())
    except ApiError:
        if not asset.existing:
            client.delete_asset(asset.sha256)
        raise
    return LinkedUpload(url=asset.url, uid=save_ops[0].uid)
