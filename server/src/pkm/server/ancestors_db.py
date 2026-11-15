# pattern: Imperative Shell
"""Read the ancestor chains of a set of blocks: shared by every route that
shows a block's parent line (page backlinks, query results)."""
from __future__ import annotations

from pkm.contracts.ops import BlockUid
from pkm.database import Db
from pkm.server.sync_core import chunk_ids
from pkm.server.tree import Ancestors, ancestors_of


def fetch_ancestors(db: Db, uids: list[BlockUid]) -> Ancestors:
    """Breadcrumb trails (ancestor uids, root first) for each uid that has
    ancestors, and each ancestor's text once. The CTE holds `uid` alone
    and joins with UNION, which queues a row only once, so each distinct
    ancestor is read once however many starts share it, and a corrupt
    parent cycle ends the walk without a depth bound that would cut real
    deep chains short. It must never carry a per-row path string: one row
    per (start, ancestor), each building and searching an O(depth) string,
    made breadcrumbs cost O(depth^3).
    `ancestor_trails` rebuilds the trails and stops on a repeated uid."""
    starts = list(dict.fromkeys(uids))
    blocks: dict[BlockUid, tuple[BlockUid | None, str]] = {}
    for chunk in chunk_ids(starts):
        marks = ",".join("?" * len(chunk))
        for r in db.select(
                f"""WITH RECURSIVE anc(uid) AS (
                      SELECT uid FROM blocks WHERE uid IN ({marks})
                      UNION
                      SELECT b.parent_uid FROM anc a
                        JOIN blocks b ON b.uid = a.uid
                       WHERE b.parent_uid IS NOT NULL
                    )
                    SELECT b.uid, b.parent_uid, b.text
                      FROM anc JOIN blocks b ON b.uid = anc.uid""", chunk):
            blocks[r["uid"]] = (r["parent_uid"], r["text"])
    return ancestors_of(starts, blocks)
