# pattern: Imperative Shell
"""Shared page fetch/create. get_or_create_page never commits: the caller
owns the transaction (read routes commit; the ops batch commits once)."""
from __future__ import annotations

import sqlite3

from pkm.refs import extract
from pkm.rename import rewrite_title_refs


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


def rewrite_referencing_blocks(db: sqlite3.Connection, page_id: int,
                               old_title: str, new_title: str,
                               now_ms: int) -> None:
    """Rewrite [[old]]/#old/old:: in every block that refs `page_id`, then
    reindex those blocks' refs from the rewritten text. Must run AFTER the
    new title exists in pages (rename applied / merge target present) so
    the reindex resolves [[new]] to the surviving row instead of creating
    a page. Never commits."""
    rows = db.execute(
        """SELECT DISTINCT b.uid, b.text FROM refs r
             JOIN blocks b ON b.uid = r.src_block_uid
            WHERE r.target_page_id = ?""", (page_id,)).fetchall()
    for row in rows:
        new_text = rewrite_title_refs(row["text"], old_title, new_title)
        if new_text != row["text"]:
            db.execute(
                "UPDATE blocks SET text = ?, updated_at = ? WHERE uid = ?",
                (new_text, now_ms, row["uid"]))
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (row["uid"],))
        for ref in extract(new_text).refs:
            page = get_or_create_page(db, ref.title, now_ms)
            db.execute("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
                       (row["uid"], page["id"], ref.kind))


def retitle_sidebar_entry(db: sqlite3.Connection, old_title: str,
                          new_title: str) -> None:
    """Follow a rename/merge in the title-keyed sidebar table. If an entry
    already exists under the new title (merge target pinned, or an orphan),
    the old entry is dropped instead of violating UNIQUE(title)."""
    if db.execute("SELECT 1 FROM sidebar_entries WHERE title = ?",
                  (new_title,)).fetchone() is not None:
        db.execute("DELETE FROM sidebar_entries WHERE title = ?",
                   (old_title,))
    else:
        db.execute("UPDATE sidebar_entries SET title = ? WHERE title = ?",
                   (new_title, old_title))


def rename_page_rows(db: sqlite3.Connection, page_id: int, old_title: str,
                     new_title: str, now_ms: int) -> None:
    """Rename in place. Refs stay valid (keyed by page id); pages_fts is
    trigger-maintained. Never commits."""
    db.execute("UPDATE pages SET title = ?, updated_at = ? WHERE id = ?",
               (new_title, now_ms, page_id))
    rewrite_referencing_blocks(db, page_id, old_title, new_title, now_ms)
    retitle_sidebar_entry(db, old_title, new_title)
