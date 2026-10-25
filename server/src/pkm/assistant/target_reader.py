# pattern: Imperative Shell
"""Reads the blocks an assistant write replaces, moves or deletes, and
the parents a batch moves blocks under before a delete, and builds its
approval card from them, with the input Allow runs: the same call, plus
what the card showed for the server to check it against.

The uids read, the card and that input come from one deep copy of the
tool input, so a caller mutating its dict mid-read or before Allow cannot
pair one call's card with another's blocks or another's write. A block
the reader returns no entry for has no row: a failed read is a refusal,
never a card that shows the block missing.

A delete target's subtree is walked by `ops_apply.subtree_rows`, the walk
the server's check runs, so the card's count and hash agree with what the
check finds when nothing changed, even on a corrupted parent chain."""
from __future__ import annotations

import asyncio
import copy
import logging
from collections.abc import Callable, Collection, Mapping, Sequence
from pathlib import Path

from pkm.assistant.write_preview import (Approval, Refusal, StoredBlock,
                                         ancestor_uids, approved_input,
                                         build_write_preview,
                                         delete_target_uids,
                                         write_target_uids)
from pkm.contracts.ops import BlockUid, subtree_hash
from pkm.server.db import open_db
from pkm.server.ops_apply import subtree_rows

logger = logging.getLogger("pkm.assistant")

# (uids to read, those whose descendants to count, those whose ancestors
# to list) -> what each existing uid holds; a uid with no row is absent.
BlockReader = Callable[[Sequence[BlockUid], Collection[BlockUid],
                        Collection[BlockUid]],
                       Mapping[BlockUid, StoredBlock]]

# The walk up, parent first, with the visited-path guard `subtree_rows`
# uses on the way down: it stops before a uid it has passed, so a parent
# cycle lists each block on it once. Commas never occur in a uid.
_ANCESTORS_SQL = """WITH RECURSIVE up(uid, depth, path) AS (
      SELECT parent_uid, 1, ',' || uid || ',' || parent_uid || ','
        FROM blocks WHERE uid = ? AND parent_uid IS NOT NULL
         AND parent_uid <> uid
      UNION ALL
      SELECT b.parent_uid, up.depth + 1, up.path || b.parent_uid || ','
        FROM up JOIN blocks b ON b.uid = up.uid
       WHERE b.parent_uid IS NOT NULL
         AND instr(up.path, ',' || b.parent_uid || ',') = 0
    ) SELECT uid FROM up ORDER BY depth"""


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
            db.execute("BEGIN")  # one snapshot for texts, pages and counts
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
                    ancestors = tuple(
                        up["uid"] for up in db.select(_ANCESTORS_SQL, (uid,)))
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
    only `build_write_preview`'s refusal or fixed text, so every refusal
    that quotes input leaves through that function's length cut."""
    try:
        snapshot = copy.deepcopy(dict(tool_input))
        parents = ancestor_uids(short, snapshot)
        uids = list(dict.fromkeys(
            [*write_target_uids(short, snapshot), *parents]))
        blocks: Mapping[BlockUid, StoredBlock] = {}
        if uids:
            blocks = await asyncio.to_thread(
                read_blocks, uids, delete_target_uids(short, snapshot),
                parents)
    except Exception as exc:
        # The type only: a database error can name paths and quote SQL.
        logger.warning("reading the targets of %s failed: %s", short,
                       type(exc).__name__)
        return _unreadable(short)
    preview = build_write_preview(short, snapshot, blocks)
    if isinstance(preview, Refusal):
        return preview
    try:
        approved = approved_input(short, snapshot, blocks)
    except Exception as exc:
        # Never a card whose Allow would carry a weaker guard than it shows.
        logger.warning("the expectations of %s failed: %s", short,
                       type(exc).__name__)
        return _unreadable(short)
    return Approval(preview, approved)


def _unreadable(short: str) -> Refusal:
    return Refusal(f"{short}: the blocks this write changes could not be "
                   "read")
