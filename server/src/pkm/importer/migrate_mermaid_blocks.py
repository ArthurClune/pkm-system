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

A component block is skipped entirely -- left exactly as it was, descendants
and all -- if any of its descendants is still targeted by an inbound
((uid)) reference from a block outside the subtree: flattening would
delete that descendant's row out from under the reference, leaving it
permanently unresolved. plan_migration() reports every such preserved
descendant and its inbound referrer(s) before any deletion happens, in
both --dry-run and normal runs.

All conversions run in a single transaction. Only plain UPDATE/DELETE
statements touch the blocks table, so schema.py's blocks_fts_au/_ad
triggers keep blocks_fts in sync automatically -- no separate FTS
maintenance step is needed.

Idempotent: a block's text no longer matches the trigger once converted,
so a second run finds no candidates and changes nothing (and a preserved
component with a still-live reference is reported as preserved again).
"""
from __future__ import annotations

import argparse
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from pkm.importer.mermaid import convert_to_fence, is_mermaid_trigger
from pkm.refs import extract

MERMAID_PAGE_TITLE = "mermaid"


@dataclass(frozen=True)
class _Node:
    """Lightweight structural stand-in for pkm.importer.mermaid.MermaidNode,
    built from database rows instead of a freshly-parsed export tree."""
    text: str
    children: tuple["_Node", ...]


@dataclass(frozen=True)
class Preserved:
    """A mermaid-component descendant left in place -- uid, text and
    position all untouched -- because a block outside its own subtree
    still holds an inbound ((uid)) reference to it."""
    component_uid: str
    descendant_uid: str
    source_uids: tuple[str, ...]


@dataclass(frozen=True)
class Plan:
    """What plan_migration() decided. Read-only: callers own any
    transaction around applying `candidates`."""
    candidates: tuple[tuple[str, str], ...]  # (uid, fence_text): safe to convert
    preserved: tuple[Preserved, ...]  # left alone, and why


def _load_subtree(con: sqlite3.Connection, parent_uid: str) -> tuple[_Node, ...]:
    rows = con.execute(
        "SELECT uid, text FROM blocks WHERE parent_uid = ? ORDER BY order_idx",
        (parent_uid,),
    ).fetchall()
    return tuple(
        _Node(text=text, children=_load_subtree(con, uid)) for uid, text in rows
    )


def _subtree_uids(con: sqlite3.Connection, parent_uid: str) -> set[str]:
    """Every descendant uid (not including parent_uid itself), gathered
    with plain parent_uid lookups rather than _load_subtree/_Node since
    those deliberately don't carry the uid a caller would need here."""
    uids: set[str] = set()
    frontier = [parent_uid]
    while frontier:
        children = con.execute(
            "SELECT uid FROM blocks WHERE parent_uid = ?", (frontier.pop(),)
        ).fetchall()
        for (uid,) in children:
            uids.add(uid)
            frontier.append(uid)
    return uids


def _all_block_ref_sources(con: sqlite3.Connection) -> dict[str, set[str]]:
    """Map every ((uid)) target found in any block's text in the whole
    database to the set of source block uids that reference it."""
    sources: dict[str, set[str]] = {}
    for uid, text in con.execute("SELECT uid, text FROM blocks").fetchall():
        for target in extract(text).block_refs:
            sources.setdefault(target, set()).add(uid)
    return sources


def plan_migration(con: sqlite3.Connection) -> Plan:
    """Decide which mermaid component blocks are safe to flatten and which
    must stay nested because an inbound ((uid)) reference from outside the
    subtree targets one of their descendants. Read-only: callers own any
    transaction around the writes."""
    ref_sources = _all_block_ref_sources(con)
    candidates: list[tuple[str, str]] = []
    preserved: list[Preserved] = []
    for uid, text in con.execute("SELECT uid, text FROM blocks").fetchall():
        if not is_mermaid_trigger(text):
            continue  # skip the tree fetch below for the common case
        children = _load_subtree(con, uid)
        fence = convert_to_fence(text, children)
        if fence is None:
            continue
        subtree = _subtree_uids(con, uid)
        in_subtree = subtree | {uid}
        referenced = [
            (descendant_uid, tuple(sorted(external)))
            for descendant_uid in sorted(subtree)
            if (external := ref_sources.get(descendant_uid, set()) - in_subtree)
        ]
        if referenced:
            preserved.extend(
                Preserved(uid, descendant_uid, sources)
                for descendant_uid, sources in referenced
            )
        else:
            candidates.append((uid, fence))
    return Plan(candidates=tuple(candidates), preserved=tuple(preserved))


def convert_candidates(con: sqlite3.Connection,
                        candidates: Sequence[tuple[str, str]]) -> None:
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


def _print_preserved(preserved: tuple[Preserved, ...]) -> None:
    print(f"mermaid migration: {len(preserved)} referenced descendant(s) "
          f"preserved, not flattened:")
    for p in preserved:
        print(f"  {p.descendant_uid} (in {p.component_uid}) <- referenced by "
              f"{', '.join(p.source_uids)}")


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
        plan = plan_migration(con)  # read-only; safe to run before any decision
        if args.dry_run:
            print(f"mermaid migration (dry run): {len(plan.candidates)} block(s) "
                 f"would be converted")
            for uid, _ in plan.candidates:
                print(f"  {uid}")
            _print_preserved(plan.preserved)
            return 0

        _print_preserved(plan.preserved)  # report before any deletion happens
        con.execute("BEGIN")
        try:
            convert_candidates(con, plan.candidates)
            con.commit()
        except BaseException:
            con.rollback()
            raise
        print(f"mermaid migration: converted {len(plan.candidates)} block(s)")
        for uid, _ in plan.candidates:
            print(f"  {uid}")
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
