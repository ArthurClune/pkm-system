# pattern: Imperative Shell
"""Generate a safe local data directory from the committed synthetic graph."""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import tempfile
import uuid
from pathlib import Path

from pkm.filenames import safe_filename
from pkm.importer.assets import Asset
from pkm.server.db import init_db, open_db
from pkm.server.mime_sniff import sniff_mime
from pkm.test_data.core import build_rows, parse_graph_source

DEFAULT_SOURCE = Path(__file__).resolve().parents[4] / "test-data" / "graph.json"


def _index_assets(asset_dir: Path) -> tuple[dict[str, Asset], dict[str, Path]]:
    """Index regular asset files by source name and content hash."""
    assets: dict[str, Asset] = {}
    paths: dict[str, Path] = {}
    for path in sorted(asset_dir.iterdir()):
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"asset is not a regular file: {path}")
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        sniffed = sniff_mime(data[:4096])
        mime = sniffed or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        asset = Asset(sha, safe_filename(path.name), mime, len(data))
        assets[path.name] = asset
        paths[sha] = path
    return assets, paths


def _copy_config(config_path: Path, staging: Path) -> None:
    (staging / "config.json").write_bytes(config_path.read_bytes())


def _backup_path(output_dir: Path) -> Path:
    return output_dir.parent / f".{output_dir.name}.backup-{uuid.uuid4().hex}"


def _claim_output(output_dir: Path) -> tuple[Path, bool]:
    backup_dir = _backup_path(output_dir)
    claimed_absent = False
    try:
        os.mkdir(output_dir)
        claimed_absent = True
    except FileExistsError:
        pass
    os.replace(output_dir, backup_dir)
    return backup_dir, claimed_absent


def _validate_claimed_output(backup_dir: Path, output_dir: Path) -> Path | None:
    if backup_dir.is_symlink() or not backup_dir.is_dir():
        raise FileExistsError(f"refusing to replace non-empty output: {output_dir}")

    entries = list(backup_dir.iterdir())
    if not entries:
        return None
    if (
        len(entries) == 1
        and entries[0].name == "config.json"
        and entries[0].is_file()
        and not entries[0].is_symlink()
    ):
        return entries[0]
    raise FileExistsError(f"refusing to replace non-empty output: {output_dir}")


def _restore_claimed_output(
    backup_dir: Path,
    output_dir: Path,
    claimed_absent: bool,
    exc: Exception,
) -> None:
    try:
        if claimed_absent:
            os.rmdir(backup_dir)
        else:
            os.replace(backup_dir, output_dir)
    except OSError as restore_exc:
        raise RuntimeError(f"{exc}; backup retained at {backup_dir}") from restore_exc


def _publish_staged(staging_dir: Path, output_dir: Path) -> None:
    """Atomically publish a staged data directory without discarding live data."""
    backup_dir, claimed_absent = _claim_output(output_dir)
    try:
        config_path = _validate_claimed_output(backup_dir, output_dir)
        if config_path is not None:
            _copy_config(config_path, staging_dir)
        os.replace(staging_dir, output_dir)
    except Exception as exc:
        _restore_claimed_output(backup_dir, output_dir, claimed_absent, exc)
        raise

    shutil.rmtree(backup_dir)


def generate(source_path: Path, output_dir: Path) -> None:
    """Build and publish a synthetic PKM data directory from one graph source."""
    if output_dir.is_symlink() or (output_dir.exists() and not output_dir.is_dir()):
        raise ValueError(f"output path is not a regular directory: {output_dir}")

    asset_dir = source_path.parent / "assets"
    if not asset_dir.is_dir() or asset_dir.is_symlink():
        raise ValueError(f"asset directory is not a regular directory: {asset_dir}")

    raw = json.loads(source_path.read_text(encoding="utf-8"))
    assets_by_name, asset_paths = _index_assets(asset_dir)
    source = parse_graph_source(raw, asset_names=set(assets_by_name))
    prepared = build_rows(source, assets_by_name)

    staging_dir: Path | None = None
    try:
        staging_dir = Path(
            tempfile.mkdtemp(
                dir=output_dir.parent,
                prefix=f".{output_dir.name}.staging-",
            )
        )
        db_path = staging_dir / "pkm.sqlite3"
        init_db(db_path)
        con = open_db(db_path)
        try:
            con.executemany("INSERT INTO pages VALUES (?,?,?,?)", prepared.rows.pages)
            con.executemany(
                "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading, "
                "collapsed, created_at, updated_at, view_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
                prepared.rows.blocks,
            )
            con.executemany("INSERT INTO refs VALUES (?,?,?)", prepared.rows.refs)
            con.executemany(
                "INSERT INTO assets VALUES (?,?,?,?,NULL)",
                [
                    (asset.sha256, asset.filename, asset.mime, asset.size)
                    for asset in assets_by_name.values()
                ],
            )
            con.executemany(
                "INSERT INTO sidebar_entries(title, order_idx) VALUES (?,?)",
                prepared.sidebar_rows,
            )
            con.commit()
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            con.close()

        for sha256, source_asset in asset_paths.items():
            dest = staging_dir / "assets" / sha256[:2] / sha256
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_asset, dest)

        _publish_staged(staging_dir, output_dir)
        staging_dir = None
    finally:
        if staging_dir is not None and staging_dir.exists():
            shutil.rmtree(staging_dir)


def main(argv: list[str] | None = None) -> int:
    """Run the staged test-data generator CLI."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=Path("data"))
    args = parser.parse_args(argv)
    try:
        generate(args.source, args.out)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=os.sys.stderr)
        return 2
    print(f"generated {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
