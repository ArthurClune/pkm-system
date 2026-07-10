# pattern: Imperative Shell
"""One-off migration: python -m pkm.importer.migrate_mermaid_blocks --db PATH [--dry-run]

Fixes already-imported Roam mermaid diagrams. The Roam importer used to
import a mermaid component block ({{[[mermaid]]}}, diagram source as child
blocks -- see pkm.importer.mermaid) verbatim, so the diagram never
rendered. For each such block still in this shape, this script:

  * rewrites the block's own text to a ```mermaid fenced block built from
    its descendant subtree (pkm.importer.mermaid.convert_to_fence);
  * deletes its descendant blocks (schema.py's ON DELETE CASCADE on
    blocks.parent_uid recursively removes the whole subtree, and each
    deleted block's own refs rows, in one statement per top-level
    candidate -- this requires PRAGMA foreign_keys=ON, which open_db()
    always sets but a bare sqlite3.connect() does not, so this script
    sets it explicitly on its own connection);
  * deletes this block's own refs rows that point at the "mermaid" page
    (the old {{[[mermaid]]}} text linked it via [[mermaid]]; the fence
    text doesn't reference it at all).

All conversions run in a single transaction. Only plain UPDATE/DELETE
statements touch the blocks table, so schema.py's blocks_fts_au/_ad
triggers keep blocks_fts in sync automatically -- no separate FTS
maintenance step is needed.

Idempotent: a block's text no longer matches the trigger once converted,
so a second run finds no candidates and changes nothing.
"""
from __future__ import annotations

import argparse
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from pkm.importer.mermaid import convert_to_fence, is_mermaid_trigger

MERMAID_PAGE_TITLE = "mermaid"


@dataclass(frozen=True)
class _Node:
    """Lightweight structural stand-in for pkm.importer.mermaid.MermaidNode,
    built from database rows instead of a freshly-parsed export tree."""
    text: str
    children: tuple["_Node", ...]


def _load_subtree(con: sqlite3.Connection, parent_uid: str) -> tuple[_Node, ...]:
    rows = con.execute(
        "SELECT uid, text FROM blocks WHERE parent_uid = ? ORDER BY order_idx",
        (parent_uid,),
    ).fetchall()
    return tuple(
        _Node(text=text, children=_load_subtree(con, uid)) for uid, text in rows
    )


def find_candidates(con: sqlite3.Connection) -> list[tuple[str, str]]:
    """Return (uid, fence_text) for every block that needs converting.
    Read-only: callers own any transaction around the writes."""
    candidates: list[tuple[str, str]] = []
    for uid, text in con.execute("SELECT uid, text FROM blocks").fetchall():
        if not is_mermaid_trigger(text):
            continue  # skip the tree fetch below for the common case
        children = _load_subtree(con, uid)
        fence = convert_to_fence(text, children)
        if fence is not None:
            candidates.append((uid, fence))
    return candidates


def convert_candidates(con: sqlite3.Connection,
                        candidates: list[tuple[str, str]]) -> None:
    """Apply the conversions. Caller owns the transaction (commits/rolls
    back) and must have PRAGMA foreign_keys=ON set on `con`."""
    mermaid_page = con.execute(
        "SELECT id FROM pages WHERE title = ?", (MERMAID_PAGE_TITLE,)
    ).fetchone()
    mermaid_page_id = mermaid_page[0] if mermaid_page else None

    for uid, fence in candidates:
        con.execute("UPDATE blocks SET text = ? WHERE uid = ?", (fence, uid))
        # ON DELETE CASCADE (schema.py) recursively removes the whole
        # descendant subtree below `uid`, plus each removed block's own
        # refs rows -- but not `uid`'s own refs row, since `uid` itself is
        # not deleted.
        con.execute("DELETE FROM blocks WHERE parent_uid = ?", (uid,))
        if mermaid_page_id is not None:
            con.execute(
                "DELETE FROM refs WHERE src_block_uid = ? AND target_page_id = ?",
                (uid, mermaid_page_id),
            )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Convert imported Roam mermaid component blocks to "
                    "fenced ```mermaid blocks (idempotent).")
    ap.add_argument("--db", required=True, help="path to pkm.sqlite3")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change without writing")
    args = ap.parse_args(argv)

    con = sqlite3.connect(Path(args.db))
    try:
        con.execute("PRAGMA foreign_keys=ON")
        candidates = find_candidates(con)
        if args.dry_run:
            print(f"mermaid migration (dry run): {len(candidates)} block(s) "
                 f"would be converted")
            for uid, _ in candidates:
                print(f"  {uid}")
            return 0

        con.execute("BEGIN")
        try:
            convert_candidates(con, candidates)
            con.commit()
        except BaseException:
            con.rollback()
            raise
        print(f"mermaid migration: converted {len(candidates)} block(s)")
        for uid, _ in candidates:
            print(f"  {uid}")
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
