# pattern: Imperative Shell
"""Shared page fetch/create. get_or_create_page never commits: the caller
owns the transaction (read routes commit; the ops batch commits once)."""
from __future__ import annotations

import sqlite3
from collections.abc import Mapping, Sequence

from pkm.refs import extract, is_blank_title, normalize_title
from pkm.rename import rewrite_title_refs_map


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
    """Normalizes the title first: this is the one choke point every
    creation path funnels through (ref indexing, ops create/move
    page_title, POST /api/pages, rename, the CLI, the importer), so a
    title holding control whitespace -- unreachable through the API, see
    refs.normalize_title -- cannot be minted by any of them. Normalizing
    rather than rejecting is deliberate: an offline client replaying a
    queued op must never meet a permanent 422, or its queue wedges.

    A title that is nothing but whitespace once normalized is different:
    unlike a normalized-but-nonempty title, it can never be addressed (no
    [[link]] resolves to it, no route can name it), so it would sit in the
    pages table as permanently unreachable dead weight. This function
    refuses to create it -- raising BlankTitleError rather than silently
    minting the page -- and leaves the recovery policy to the caller.

    Blankness and canonicalization are deliberately separate checks here
    (pkm-1rb5 review round 2): normalize_title is narrow and only acts on
    a title holding a *control* whitespace char, so a title of plain
    spaces alone ("   ") comes back byte for byte -- not touched by
    normalize_title, but still all-whitespace, so `.strip()` is used ONLY
    to test for that, never to decide what gets stored or looked up. A
    title that is merely *padded* (e.g. " EvilCorp", real content, just a
    leading space -- production has pages exactly like this, minted back
    when refs/ops never stripped) is not blank and must keep matching
    itself byte for byte, the same as before this function existed: a
    caller passing the padded title again must find the same row, not
    stamp out a second, empty page under some canonicalized variant it
    never actually asked to look up."""
    title = normalize_title(title)
    if is_blank_title(title):
        raise BlankTitleError(title)
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
    refs.extract()'s own "drop a blank ref" check reuses normalize_title,
    which is narrow (control whitespace only, see get_or_create_page's
    docstring) -- so a spaces-only bracket ref like "[[   ]]" is NOT
    dropped there, and ref_title can still be blank-once-stripped here.
    get_or_create_page would raise BlankTitleError for that, which this
    function catches and swallows: per extract()'s own docstring, a title
    that normalizes to blank "is not a reference at all", so the fix is to
    index nothing, the same as if extract() had dropped it -- not to
    invent a fallback page (a phantom backlink onto some sentinel page
    would be wrong, unlike the ops path's page_title fallback, where the
    op itself needs *some* page to land on)."""
    try:
        page = get_or_create_page(db, ref_title, now_ms)
    except BlankTitleError:
        return
    db.execute("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
              (src_uid, page["id"], ref_kind))


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
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (uid,))
        for ref in extract(new_text).refs:
            index_ref(db, uid, ref.title, ref.kind, now_ms)
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
