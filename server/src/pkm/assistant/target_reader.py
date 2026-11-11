# pattern: Imperative Shell
"""Reads the blocks an assistant write replaces, moves or deletes, and
the parents a batch moves blocks under before a delete, and builds its
approval card from them, with the input Allow runs: the same call, plus
what the card showed for the server to check it against.

The uids read, the card and that input come from the one `CheckedWrite`
`check_write` makes, which owns a deep copy of the tool input, so a caller
mutating its dict mid-read or before Allow cannot pair one call's card
with another's blocks or another's write. A block the reader returns no
entry for has no row: a failed read is a refusal, never a card that shows
the block missing.

A delete target's subtree is walked by `ops_apply.subtree_rows`, the walk
the server's check runs, so the card's count and hash agree with what the
check finds when nothing changed, even on a corrupted parent chain. The
ancestors use `ops_apply.parent_chain`, the same walk as the server's
cycle check."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Collection, Mapping, Sequence
from pathlib import Path

from pkm.assistant.policy import CURRENT_TEXT_ENTRIES, SUBTREE_DELETE_ENTRIES
from pkm.assistant.write_preview import (Approval, Refusal, StoredBlock,
                                         ancestor_uids, approved_input,
                                         build_write_preview, check_write,
                                         target_uids)
from pkm.contracts.ops import BlockUid, subtree_hash
from pkm.server.db import open_db, read_txn
from pkm.server.ops_apply import parent_chain, subtree_rows

logger = logging.getLogger("pkm.assistant")

# (uids to read, those whose descendants to count, those whose ancestors
# to list) -> what each existing uid holds; a uid with no row is absent.
BlockReader = Callable[[Sequence[BlockUid], Collection[BlockUid],
                        Collection[BlockUid]],
                       Mapping[BlockUid, StoredBlock]]

def db_block_reader(db_path: Path) -> BlockReader:
    """A reader over the database at `db_path`: every uid's text and page,
    then one count and subtree hash per delete target and one ancestor
    list per named parent that exists, all in one read transaction, so a
    write committed meanwhile cannot pair a block's text with a count
    taken after it was deleted. A block whose page row is
    missing (possible only with foreign keys off) raises: the write would
    still find the block, so leaving it out would show it as missing."""
    def read(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
             ancestors_of: Collection[BlockUid]
             ) -> Mapping[BlockUid, StoredBlock]:
        if not uids:
            return {}
        db = open_db(db_path)
        try:
            with read_txn(db):  # one snapshot for texts, pages and counts
                marks = ",".join("?" * len(uids))
                rows = db.select(
                    "SELECT uid, text, page_id FROM blocks"
                    f" WHERE uid IN ({marks})", tuple(uids))
                if not rows:
                    return {}
                page_ids = list(dict.fromkeys(row["page_id"] for row in rows))
                titles = {page["page_id"]: page["page_title"]
                          for page in db.select(
                              "SELECT id AS page_id, title AS page_title"
                              " FROM pages WHERE id IN"
                              f" ({','.join('?' * len(page_ids))})",
                              tuple(page_ids))}
                out: dict[BlockUid, StoredBlock] = {}
                for row in rows:
                    uid = row["uid"]
                    if row["page_id"] not in titles:
                        raise LookupError("a target block's page row is missing")
                    descendants = hashed = None
                    if uid in count_under:
                        # the row was just read in this snapshot, so the walk
                        # holds at least the block itself
                        sub = subtree_rows(db, uid)
                        descendants = len(sub) - 1
                        hashed = subtree_hash((r.uid, r.text) for r in sub)
                    ancestors = None
                    if uid in ancestors_of:
                        ancestors = parent_chain(db, uid)[1:]
                    out[uid] = StoredBlock(page_title=titles[row["page_id"]],
                                           text=row["text"],
                                           descendants=descendants,
                                           ancestors=ancestors,
                                           subtree_hash=hashed)
                return out
        finally:
            db.close()
    return read


async def preview_write(short: str, tool_input: Mapping[str, object],
                        read_blocks: BlockReader) -> Approval | Refusal:
    """The approval card for write tool `short`, with the current text of
    each block it replaces, moves or deletes, and the ancestors of each
    parent `ancestor_uids` names, read off the event loop, and the input
    Allow runs (`approved_input`); or why the call is refused. Returns
    only `check_write`'s or `build_write_preview`'s refusal or fixed text,
    so every refusal that quotes input leaves through their length cut.

    `check_write` runs first and never raises, so a refused input reads
    nothing and the model is told the check's reason, or that the input
    could not be previewed (nested past the deep copy's recursion limit,
    say). "Could not be read" means only that the read, or the guard built
    from it, failed."""
    checked = check_write(short, tool_input)
    if isinstance(checked, Refusal):
        return checked
    try:
        parents = ancestor_uids(checked)
        uids = list(dict.fromkeys(
            [*target_uids(checked, CURRENT_TEXT_ENTRIES), *parents]))
        blocks: Mapping[BlockUid, StoredBlock] = {}
        if uids:
            blocks = await asyncio.to_thread(
                read_blocks, uids,
                target_uids(checked, SUBTREE_DELETE_ENTRIES), parents)
    except Exception as exc:
        # The type only: a database error can name paths and quote SQL.
        logger.warning("reading the targets of %s failed: %s", short,
                       type(exc).__name__)
        return _unreadable(short)
    preview = build_write_preview(checked, blocks)
    if isinstance(preview, Refusal):
        return preview
    try:
        approved = approved_input(checked, blocks)
    except Exception as exc:
        # Never a card whose Allow would carry a weaker guard than it shows.
        logger.warning("the expectations of %s failed: %s", short,
                       type(exc).__name__)
        return _unreadable(short)
    return Approval(preview, approved)


def _unreadable(short: str) -> Refusal:
    return Refusal(f"{short}: the blocks this write changes could not be "
                   "read")
