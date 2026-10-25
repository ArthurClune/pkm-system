# pattern: Imperative Shell
"""Reads the blocks an assistant write replaces, moves or deletes, and
builds its approval card from them.

The uids read and the card come from one deep copy of the tool input, so
a caller mutating its dict mid-read cannot pair one call's card with
another's blocks. A block the reader returns no entry for has no row:
a failed read is a refusal, never a card that shows the block missing."""
from __future__ import annotations

import asyncio
import copy
import logging
from collections.abc import Callable, Collection, Mapping, Sequence
from pathlib import Path

from pkm.assistant.write_preview import (Refusal, StoredBlock, WritePreview,
                                         build_write_preview,
                                         delete_target_uids,
                                         write_target_uids)
from pkm.contracts.ops import BlockUid
from pkm.server.db import open_db

logger = logging.getLogger("pkm.assistant")

# (uids to read, those whose descendants to count) -> what each existing
# uid holds; a uid with no row is absent.
BlockReader = Callable[[Sequence[BlockUid], Collection[BlockUid]],
                       Mapping[BlockUid, StoredBlock]]

# The subtree walk follows parent -> child links with a visited-path
# guard, as ops_apply's `_subtree_with_height` does, so a corrupted parent
# cycle ends instead of recursing forever. Commas never occur in a uid.
_DESCENDANTS_SQL = """WITH RECURSIVE sub(uid, path) AS (
      SELECT uid, ',' || uid || ',' FROM blocks WHERE uid = ?
      UNION ALL
      SELECT b.uid, s.path || b.uid || ','
        FROM sub s JOIN blocks b ON b.parent_uid = s.uid
       WHERE instr(s.path, ',' || b.uid || ',') = 0
    ) SELECT COUNT(*) - 1 AS n FROM sub"""


def db_block_reader(db_path: Path) -> BlockReader:
    """A reader over the database at `db_path`: one query for every uid's
    text and page, then one count per delete target that exists."""
    def read(uids: Sequence[BlockUid], count_under: Collection[BlockUid]
             ) -> Mapping[BlockUid, StoredBlock]:
        if not uids:
            return {}
        db = open_db(db_path)
        try:
            marks = ",".join("?" * len(uids))
            rows = db.select(
                "SELECT b.uid, b.text, p.title AS page_title FROM blocks b"
                f" JOIN pages p ON p.id = b.page_id WHERE b.uid IN ({marks})",
                tuple(uids))
            out: dict[BlockUid, StoredBlock] = {}
            for row in rows:
                uid = row["uid"]
                descendants = None
                if uid in count_under:
                    counted = db.select_one(_DESCENDANTS_SQL, (uid,))
                    assert counted is not None  # an aggregate yields a row
                    descendants = counted["n"]
                out[uid] = StoredBlock(page_title=row["page_title"],
                                       text=row["text"],
                                       descendants=descendants)
            return out
        finally:
            db.close()
    return read


async def preview_write(short: str, tool_input: Mapping[str, object],
                        read_blocks: BlockReader) -> WritePreview | Refusal:
    """The approval card for write tool `short`, with the current text of
    each block it replaces, moves or deletes read off the event loop, or
    why the call is refused. Returns only `build_write_preview`'s result
    or fixed text, so every refusal that quotes input leaves through that
    function's length cut."""
    try:
        snapshot = copy.deepcopy(dict(tool_input))
        uids = write_target_uids(short, snapshot)
        blocks: Mapping[BlockUid, StoredBlock] = {}
        if uids:
            blocks = await asyncio.to_thread(
                read_blocks, uids, delete_target_uids(short, snapshot))
    except Exception as exc:
        # The type only: a database error can name paths and quote SQL.
        logger.warning("reading the targets of %s failed: %s", short,
                       type(exc).__name__)
        return Refusal(f"{short}: the blocks this write changes could not "
                       "be read")
    return build_write_preview(short, snapshot, blocks)
