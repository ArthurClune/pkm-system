# pattern: Imperative Shell
"""Importer CLI: EDN export + files dir -> data dir (sqlite + assets + report)."""
from __future__ import annotations

import argparse
import hashlib
import mimetypes
import os
import shutil
import sqlite3
import sys
from pathlib import Path

from pkm.edn import parse_edn
from pkm.filenames import safe_filename
from pkm.importer.assets import UID_PREFIX_LEN, Asset, rewrite_asset_urls
from pkm.importer.parse_export import parse_export
from pkm.importer.report import ImportReport, render
from pkm.importer.rows import to_rows
from pkm.schema import DDL


def _index_files(files_dir: Path) -> tuple[dict[str, Asset], dict[str, Path]]:
    by_name: dict[str, Asset] = {}
    paths: dict[str, Path] = {}
    all_files = sorted(p for p in files_dir.rglob("*") if p.is_file())
    for path in all_files:
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        # Lookup keys stay on the raw name (Roam's export text references
        # it); only the stored/displayed filename needs bounding, since a
        # linked-files download can contain arbitrarily long names.
        by_name[path.name.lower()] = Asset(sha, safe_filename(path.name), mime, len(data))
        paths[sha] = path
    # Second pass: register each file's leading uid prefix as a fallback
    # lookup key, without clobbering any exact-name entry above. Roam's
    # linked-files download names files "<uid>-<original name>.<ext>", so
    # this is what lets firebase URLs (named "<uid>.<ext>") resolve.
    for path in all_files:
        by_name.setdefault(path.name[:UID_PREFIX_LEN].lower(), by_name[path.name.lower()])
    return by_name, paths


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import a Roam EDN export.")
    parser.add_argument("export", help="path to the .edn export file")
    parser.add_argument("--files", help="path to the linked-files download dir")
    parser.add_argument("--out", default="data", help="output data directory")
    args = parser.parse_args(argv)

    export_path = Path(args.export)
    if not export_path.is_file():
        print(f"error: export file not found: {export_path}", file=sys.stderr)
        return 2

    sys.setrecursionlimit(20000)  # deep outlines recurse in tree assembly
    export = parse_export(parse_edn(export_path.read_text(encoding="utf-8")))

    files_dir = Path(args.files) if args.files else None
    if files_dir is not None and (
        not files_dir.is_dir() or not any(p.is_file() for p in files_dir.rglob("*"))
    ):
        print(f"warning: --files dir missing or empty: {files_dir}", file=sys.stderr)
        files_dir = None

    by_name, paths = _index_files(files_dir) if files_dir else ({}, {})
    unique_assets = {a.sha256: a for a in by_name.values()}
    used: set[str] = set()
    missing: set[str] = set()

    def transform(text: str) -> str:
        new, u, m = rewrite_asset_urls(text, by_name)
        used.update(u)
        missing.update(m)
        return new

    rows = to_rows(export, transform)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "pkm.sqlite3.tmp"
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    try:
        con.executescript(DDL)
        con.executemany("INSERT INTO pages VALUES (?,?,?,?)", rows.pages)
        con.executemany(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " heading, collapsed, created_at, updated_at, view_type)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)", rows.blocks)
        con.executemany("INSERT INTO refs VALUES (?,?,?)", rows.refs)
        con.executemany(
            "INSERT INTO assets VALUES (?,?,?,?,NULL)",
            [(a.sha256, a.filename, a.mime, a.size) for a in unique_assets.values()])
        con.commit()
    finally:
        con.close()

    for sha, src in paths.items():
        dest = out / "assets" / sha[:2] / sha
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest_tmp = dest.with_name(dest.name + ".tmp")
            shutil.copyfile(src, dest_tmp)
            os.replace(dest_tmp, dest)

    os.replace(tmp, out / "pkm.sqlite3")

    report = ImportReport(
        pages=len(rows.pages),
        implicit_pages=rows.implicit_page_count,
        blocks=len(rows.blocks),
        refs=len(rows.refs),
        orphan_blocks=export.orphan_block_count,
        skipped_entities=export.skipped_entities,
        block_ref_count=rows.block_ref_count,
        embed_count=rows.embed_count,
        assets_total=len(unique_assets),
        assets_used=len(used),
        missing_asset_urls=tuple(sorted(missing)),
        attr_counts=export.attr_counts,
    )
    text = render(report)
    (out / "import-report.txt").write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
