# pattern: Imperative Shell
"""Shared page fetch/create. get_or_create_page never commits: the caller
owns the transaction (read routes commit; the ops batch commits once)."""
from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Mapping, Sequence

from pkm.refs import (canonicalize_title, extract, is_blank_title,
                      title_syntax_reason)
from pkm.rename import rewrite_title_refs_map
from pkm.server.sync_meta import plain_space_title_canonicalization_active


class ForbiddenTitleError(ValueError):
    def __init__(self, title: str) -> None:
        super().__init__(f"unsupported page-title syntax: {title!r}")
        self.title = title


class BlankTitleError(ValueError):
    """Raised by get_or_create_page when the title normalizes to "" (e.g. a
    whitespace-only string -- pydantic's `min_length=1` on ops page_title
    fields lets that through untouched). This function never commits a
    blank-titled page itself; every caller must pick an explicit policy:
    reject before mutation (the plain HTTP routes do), or -- on the ops
    path, where a rejection wedges an offline client's replay queue
    (pkm-hjhy) -- substitute a fixed fallback title (see ops_apply.py)."""


def fetch_page(db: sqlite3.Connection, title: str) -> sqlite3.Row | None:
    return db.execute(
        "SELECT id, title, created_at, updated_at FROM pages WHERE title = ?",
        (title,)).fetchone()


def get_or_create_page(db: sqlite3.Connection, title: str,
                       now_ms: int) -> sqlite3.Row:
    """Canonicalize at the choke point shared by every creation path.

    Control whitespace is always normalized because such titles are
    unreachable through the HTTP path. Boundary U+0020 remains byte-exact
    before the title migration, then is stripped only after the durable
    activation flag is set. This lets pre-migration padded rows keep resolving
    to themselves while preventing their recreation after migration.

    Blankness remains a separate policy: a title that is all whitespace is
    refused with BlankTitleError. Interactive routes translate that to 422;
    offline-replayed ops substitute their fixed fallback rather than wedging
    the durable queue."""
    title = canonicalize_title(
        title,
        plain_space=plain_space_title_canonicalization_active(db),
    )
    if is_blank_title(title):
        raise BlankTitleError(title)
    if title_syntax_reason(title) is not None:
        raise ForbiddenTitleError(title)
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


def index_ref(db: sqlite3.Connection, src_uid: str, ref_title: str,
             ref_kind: str, now_ms: int) -> None:
    """Resolve one extracted Ref onto a page and record it in `refs`.

    refs.extract() now filters blank titles itself, including plain-space
    `[[   ]]`, while still leaving valid padded nonblank titles byte-exact.
    The BlankTitleError catch remains defense in depth at the store boundary:
    if a caller ever hands us a blank title anyway, index nothing rather than
    inventing a fallback page for a non-reference.
    """
    try:
        page = get_or_create_page(db, ref_title, now_ms)
    except BlankTitleError:
        return
    db.execute("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
              (src_uid, page["id"], ref_kind))


def reindex_block_refs(db: sqlite3.Connection, src_uid: str,
                       targets: Iterable[str]) -> None:
    """Replace one block's outgoing ((uid)) rows (pkm-d31f). Targets may
    dangle -- an unresolved ((uid)) is a legal state -- so no existence
    check. Never commits."""
    db.execute("DELETE FROM block_refs WHERE src_block_uid = ?", (src_uid,))
    db.executemany("INSERT OR IGNORE INTO block_refs VALUES (?,?)",
                   [(src_uid, t) for t in targets])


def delete_page_rows(db: sqlite3.Connection, page_id: int,
                     title: str) -> None:
    """Deletes a page, its blocks, and any sidebar entry. Never commits --
    the caller owns the transaction. Blocks are deleted explicitly (not left
    to the pages FK cascade) so the blocks_fts_ad trigger fires for every
    row; cascade-triggered deletes are not guaranteed to fire triggers."""
    db.execute("DELETE FROM blocks WHERE page_id = ?", (page_id,))
    db.execute("DELETE FROM pages WHERE id = ?", (page_id,))
    db.execute("DELETE FROM sidebar_entries WHERE title = ?", (title,))


def _snapshot_referencing_blocks(
    db: sqlite3.Connection, page_id: int
) -> tuple[tuple[str, str], ...]:
    rows = db.execute(
        """SELECT DISTINCT b.uid, b.text FROM refs r
             JOIN blocks b ON b.uid = r.src_block_uid
            WHERE r.target_page_id = ?
            ORDER BY b.uid""",
        (page_id,),
    ).fetchall()
    return tuple((row["uid"], row["text"]) for row in rows)


def rewrite_snapshotted_blocks(
    db: sqlite3.Connection,
    snapshots: Sequence[tuple[str, str]],
    replacements: Mapping[str, str],
    now_ms: int,
) -> int:
    """Rewrite each original block snapshot once, then replace its ref index.

    The complete replacement map is applied to original text rather than to
    intermediate database text, so multi-source migrations never hide a later
    source reference. Never commits.
    """
    rewritten = 0
    seen: set[str] = set()
    for uid, original_text in snapshots:
        if uid in seen:
            continue
        seen.add(uid)
        new_text = rewrite_title_refs_map(original_text, replacements)
        if new_text != original_text:
            db.execute(
                "UPDATE blocks SET text = ?, updated_at = ? WHERE uid = ?",
                (new_text, now_ms, uid),
            )
            rewritten += 1
        parsed = extract(new_text)
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (uid,))
        for ref in parsed.refs:
            index_ref(db, uid, ref.title, ref.kind, now_ms)
        reindex_block_refs(db, uid, parsed.block_refs)
    return rewritten


def rewrite_referencing_blocks(db: sqlite3.Connection, page_id: int,
                               old_title: str, new_title: str,
                               now_ms: int) -> None:
    """Preserved single-page rewrite helper. Never commits."""
    snapshots = _snapshot_referencing_blocks(db, page_id)
    rewrite_snapshotted_blocks(db, snapshots, {old_title: new_title}, now_ms)


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


def retitle_page_without_rewrite(
    db: sqlite3.Connection,
    page_id: int,
    old_title: str,
    new_title: str,
    now_ms: int,
) -> None:
    """Retitle a page and reconcile its sidebar entry without touching refs."""
    db.execute(
        "UPDATE pages SET title = ?, updated_at = ? WHERE id = ?",
        (new_title, now_ms, page_id),
    )
    retitle_sidebar_entry(db, old_title, new_title)


def append_page_without_rewrite(
    db: sqlite3.Connection,
    source_id: int,
    target_id: int,
    old_title: str,
    new_title: str,
    now_ms: int,
) -> int:
    """Append a source page's stable top-level order and preserve its subtrees."""
    moved = db.execute(
        "SELECT count(*) FROM blocks WHERE page_id = ?", (source_id,)
    ).fetchone()[0]
    base = db.execute(
        "SELECT COALESCE(MAX(order_idx) + 1, 0) FROM blocks"
        " WHERE page_id = ? AND parent_uid IS NULL",
        (target_id,),
    ).fetchone()[0]
    tops = db.execute(
        "SELECT uid FROM blocks WHERE page_id = ? AND parent_uid IS NULL"
        " ORDER BY order_idx, uid",
        (source_id,),
    ).fetchall()
    for offset, row in enumerate(tops):
        db.execute(
            "UPDATE blocks SET page_id = ?, order_idx = ?, updated_at = ?"
            " WHERE uid = ?",
            (target_id, base + offset, now_ms, row["uid"]),
        )
    db.execute(
        "UPDATE blocks SET page_id = ?, updated_at = ? WHERE page_id = ?",
        (target_id, now_ms, source_id),
    )
    db.execute("UPDATE pages SET updated_at = ? WHERE id = ?", (now_ms, target_id))
    db.execute("DELETE FROM pages WHERE id = ?", (source_id,))
    retitle_sidebar_entry(db, old_title, new_title)
    return moved


def rename_page_rows(db: sqlite3.Connection, page_id: int, old_title: str,
                     new_title: str, now_ms: int) -> None:
    """Rename in place while preserving the public composed behavior."""
    snapshots = _snapshot_referencing_blocks(db, page_id)
    retitle_page_without_rewrite(db, page_id, old_title, new_title, now_ms)
    rewrite_snapshotted_blocks(db, snapshots, {old_title: new_title}, now_ms)


def merge_page_rows(db: sqlite3.Connection, source_id: int, target_id: int,
                    old_title: str, new_title: str, now_ms: int) -> None:
    """Merge a page while preserving stable blocks, subtrees, refs and sidebar."""
    snapshots = _snapshot_referencing_blocks(db, source_id)
    append_page_without_rewrite(
        db, source_id, target_id, old_title, new_title, now_ms
    )
    rewrite_snapshotted_blocks(db, snapshots, {old_title: new_title}, now_ms)
