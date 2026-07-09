# pattern: Imperative Shell
"""Write the full markdown + assets export for a graph database.

*.md files are wiped and rewritten every run (renames/deletes stay honest;
git still diffs minimally because unchanged content is byte-identical).
The asset mirror is incremental: content-hashed files never change, so
only new hashes are copied and vanished hashes pruned."""
from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

from pkm.export.markdown import page_filename, render_page, safe_filename
from pkm.server.daily import date_for_title
from pkm.server.tree import build_tree, collect_block_ref_uids

GITIGNORE = "assets/\n"


def export_graph(db: sqlite3.Connection, live_assets_dir: Path,
                 export_dir: Path) -> dict:
    pages_dir = export_dir / "pages"
    journal_dir = export_dir / "journal"
    assets_dir = export_dir / "assets"
    for d in (pages_dir, journal_dir, assets_dir):
        d.mkdir(parents=True, exist_ok=True)
    (export_dir / ".gitignore").write_text(GITIGNORE, encoding="utf-8")

    texts = [r["text"] for r in db.execute("SELECT text FROM blocks")]
    uid_to_text: dict[str, str] = {}
    for uid in collect_block_ref_uids(texts):
        row = db.execute("SELECT text FROM blocks WHERE uid = ?",
                         (uid,)).fetchone()
        if row is not None:
            uid_to_text[uid] = row["text"]

    for d in (pages_dir, journal_dir):
        for old in d.glob("*.md"):
            old.unlink()

    counts = {"pages": 0, "journal": 0, "assets_copied": 0, "assets_pruned": 0}
    taken: set[str] = set()
    for page in db.execute("SELECT id, title FROM pages ORDER BY title"):
        rows = db.execute(
            "SELECT uid, parent_uid, order_idx, text, heading, collapsed,"
            " created_at, updated_at FROM blocks WHERE page_id = ?",
            (page["id"],)).fetchall()
        body = render_page(page["title"], build_tree(rows), uid_to_text)
        day = date_for_title(page["title"])
        if day is not None:
            (journal_dir / f"{day.isoformat()}.md").write_text(
                body, encoding="utf-8")
            counts["journal"] += 1
        else:
            (pages_dir / page_filename(page["title"], taken)).write_text(
                body, encoding="utf-8")
            counts["pages"] += 1

    wanted: dict[str, str] = {
        row["sha256"]: safe_filename(row["filename"])
        for row in db.execute("SELECT sha256, filename FROM assets")}
    for sha, fname in wanted.items():
        src = live_assets_dir / sha[:2] / sha
        out = assets_dir / sha / fname
        if not src.is_file():
            continue  # row without a stored file: known import residue
        if not out.is_file():
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, out)
            counts["assets_copied"] += 1
    for d in assets_dir.iterdir():
        if d.is_dir() and d.name not in wanted:
            shutil.rmtree(d)
            counts["assets_pruned"] += 1
    return counts
