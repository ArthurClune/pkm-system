# pattern: Imperative Shell
"""Idempotent sidebar-entries import: python -m pkm.importer.import_sidebar --data-dir DATA

Inserts the fixed, ordered SIDEBAR_ENTRIES list below into an existing
database, skipping any title already present. Opens the target database
directly (not via server.db.open_db, to keep this script's transaction
scope explicit) and does all reads/writes in one short transaction, safe
to run against a live WAL-mode server."""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

from pkm.importer.sidebar_rows import missing_entry_rows
from pkm.schema import SIDEBAR_ENTRIES_DDL

SIDEBAR_ENTRIES = (
    "AWS", "AI", "Crypto", "Cyber Security", "Economics", "Education",
    "Environmentalism", "Exercise", "Internet Harm", "LLMs", "Management",
    "Mathematics", "Metacognition", "MacOS", "My Setup", "Politics",
    "Philosophy", "Raspberry Pi", "Research Computing", "Roam",
    "Software Development", "Work Notes",
)


def import_sidebar_entries(con: sqlite3.Connection) -> int:
    """Insert any SIDEBAR_ENTRIES titles missing from sidebar_entries,
    preserving SIDEBAR_ENTRIES order. Returns the number inserted. Caller
    owns the transaction (commits/rolls back)."""
    con.execute(SIDEBAR_ENTRIES_DDL)  # ensure table exists on older dbs
    existing = {r[0] for r in con.execute("SELECT title FROM sidebar_entries")}
    next_order = con.execute(
        "SELECT COALESCE(MAX(order_idx) + 1, 0) FROM sidebar_entries").fetchone()[0]
    rows = missing_entry_rows(existing, SIDEBAR_ENTRIES, next_order)
    con.executemany(
        "INSERT INTO sidebar_entries(title, order_idx) VALUES (?, ?)", rows)
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Import the fixed sidebar-entries list (idempotent).")
    ap.add_argument("--data-dir", default="data",
                    help="data dir containing pkm.sqlite3")
    args = ap.parse_args(argv)
    db_path = Path(args.data_dir) / "pkm.sqlite3"

    con = sqlite3.connect(db_path)
    try:
        con.execute("BEGIN")
        inserted = import_sidebar_entries(con)
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()
    skipped = len(SIDEBAR_ENTRIES) - inserted
    print(f"sidebar import: inserted {inserted}, skipped {skipped}"
         f" already-present (of {len(SIDEBAR_ENTRIES)} total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
