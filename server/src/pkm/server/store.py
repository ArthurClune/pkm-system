# pattern: Imperative Shell
"""Shared page fetch/create. get_or_create_page never commits: the caller
owns the transaction (read routes commit; the ops batch commits once)."""
from __future__ import annotations

import sqlite3


def fetch_page(db: sqlite3.Connection, title: str) -> sqlite3.Row | None:
    return db.execute(
        "SELECT id, title, created_at, updated_at FROM pages WHERE title = ?",
        (title,)).fetchone()


def get_or_create_page(db: sqlite3.Connection, title: str,
                       now_ms: int) -> sqlite3.Row:
    page = fetch_page(db, title)
    if page is not None:
        return page
    try:
        db.execute(
            "INSERT INTO pages(title, created_at, updated_at) VALUES (?,?,?)",
            (title, now_ms, now_ms))
    except sqlite3.IntegrityError:
        pass  # lost a create race — the row exists now
    page = fetch_page(db, title)
    assert page is not None  # inserted above, or the race winner inserted it
    return page


def delete_page_rows(db: sqlite3.Connection, page_id: int,
                     title: str) -> None:
    """Deletes a page, its blocks, and any sidebar entry. Never commits --
    the caller owns the transaction. Blocks are deleted explicitly (not left
    to the pages FK cascade) so the blocks_fts_ad trigger fires for every
    row; cascade-triggered deletes are not guaranteed to fire triggers."""
    db.execute("DELETE FROM blocks WHERE page_id = ?", (page_id,))
    db.execute("DELETE FROM pages WHERE id = ?", (page_id,))
    db.execute("DELETE FROM sidebar_entries WHERE title = ?", (title,))
