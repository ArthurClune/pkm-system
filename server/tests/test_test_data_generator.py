from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
from pathlib import Path

import pytest

import pkm.test_data.generate as generate_module
from pkm.test_data.generate import _publish_staged, generate, main

TEST_DATA = Path(__file__).parents[2] / "test-data"


def test_generate_builds_queryable_graph_and_content_addressed_assets(tmp_path: Path) -> None:
    output = tmp_path / "data"
    generate(TEST_DATA / "graph.json", output)

    con = sqlite3.connect(output / "pkm.sqlite3")
    try:
        titles = {row[0] for row in con.execute("SELECT title FROM pages")}
        assert {"Project Atlas", "Formatting Lab", "Garden 🌱", "July 18th, 2026"} <= titles
        assert {"Active", "Research", "Status", "TODO"} <= titles
        block = con.execute(
            "SELECT parent_uid, order_idx, heading, collapsed, view_type, text "
            "FROM blocks WHERE uid = 'atlas-outline'"
        ).fetchone()
        assert block[:5] == (None, 0, 1, 1, "numbered")
        assert "{{asset:" not in block[5]
        refs = set(con.execute(
            "SELECT b.uid, p.title, r.kind FROM refs r "
            "JOIN blocks b ON b.uid = r.src_block_uid "
            "JOIN pages p ON p.id = r.target_page_id"
        ))
        assert ("atlas-todo", "Research", "tag") in refs
        assert ("atlas-status", "Status", "attribute") in refs
        assert list(con.execute(
            "SELECT title, order_idx FROM sidebar_entries ORDER BY order_idx"
        )) == [("Project Atlas", 0), ("Formatting Lab", 1), ("Garden 🌱", 2)]
        assert con.execute(
            "SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'synthetic'"
        ).fetchone()[0] > 0
        assets = list(con.execute(
            "SELECT sha256, filename, mime, size FROM assets ORDER BY filename"
        ))
        fixture_text = dict(con.execute(
            "SELECT uid, text FROM blocks WHERE uid IN ('atlas-image', 'format-pdf')"
        ))
    finally:
        con.close()

    assert [row[1] for row in assets] == ["sample.pdf", "sample.svg"]
    assets_by_name = {row[1]: row for row in assets}
    assert f"/assets/{assets_by_name['sample.svg'][0]}/sample.svg" in fixture_text["atlas-image"]
    assert f"/assets/{assets_by_name['sample.pdf'][0]}/sample.pdf" in fixture_text["format-pdf"]
    assert all("{{asset:" not in text for text in fixture_text.values())
    for sha, filename, _mime, size in assets:
        source = TEST_DATA / "assets" / filename
        assert sha == hashlib.sha256(source.read_bytes()).hexdigest()
        assert size == source.stat().st_size
        assert (output / "assets" / sha[:2] / sha).read_bytes() == source.read_bytes()


def test_generate_preserves_lone_config_file(tmp_path: Path) -> None:
    output = tmp_path / "data"
    output.mkdir()
    config = b'{"session_secret":"synthetic-config"}\n'
    (output / "config.json").write_bytes(config)
    generate(TEST_DATA / "graph.json", output)
    assert (output / "config.json").read_bytes() == config


@pytest.mark.parametrize("existing", ["pkm.sqlite3", "unexpected.txt"])
def test_generate_refuses_existing_graph_without_mutation(tmp_path: Path, existing: str) -> None:
    output = tmp_path / "data"
    output.mkdir()
    marker = output / existing
    marker.write_bytes(b"keep-me")
    with pytest.raises(FileExistsError, match="refusing to replace non-empty output"):
        generate(TEST_DATA / "graph.json", output)
    assert marker.read_bytes() == b"keep-me"
    assert set(output.iterdir()) == {marker}


def test_generate_refuses_existing_assets_directory(tmp_path: Path) -> None:
    output = tmp_path / "data"
    (output / "assets").mkdir(parents=True)
    with pytest.raises(FileExistsError, match="refusing to replace non-empty output"):
        generate(TEST_DATA / "graph.json", output)
    assert (output / "assets").is_dir()


def test_generate_invalid_source_does_not_create_output(tmp_path: Path) -> None:
    source = tmp_path / "graph.json"
    source.write_text('{"pages": [], "sidebar_entries": ["missing"]}', encoding="utf-8")
    shutil.copytree(TEST_DATA / "assets", tmp_path / "assets")
    output = tmp_path / "data"
    with pytest.raises(ValueError, match="sidebar title is not an explicit page"):
        generate(source, output)
    assert not output.exists()


def test_main_reports_failure_and_returns_two(tmp_path: Path, capsys) -> None:
    code = main(["--source", str(tmp_path / "missing.json"), "--out", str(tmp_path / "data")])
    assert code == 2
    assert "error:" in capsys.readouterr().err


@pytest.mark.parametrize("kind", ["file", "symlink"])
def test_generate_refuses_non_directory_output(tmp_path: Path, kind: str) -> None:
    output = tmp_path / "data"
    if kind == "file":
        output.write_bytes(b"keep-me")
    else:
        target = tmp_path / "target"
        target.mkdir()
        output.symlink_to(target, target_is_directory=True)
    with pytest.raises((FileExistsError, ValueError)):
        generate(TEST_DATA / "graph.json", output)
    assert output.exists()


def test_generate_rejects_symlink_asset(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    (source_dir / "graph.json").write_text(
        (TEST_DATA / "graph.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (source_dir / "assets").symlink_to(TEST_DATA / "assets", target_is_directory=True)
    with pytest.raises(ValueError, match="asset directory is not a regular directory"):
        generate(source_dir / "graph.json", tmp_path / "data")


def test_publish_restores_config_when_publication_fails(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "data"
    output.mkdir()
    config = output / "config.json"
    config.write_bytes(b"keep-me")
    staging = tmp_path / ".data.staging"
    staging.mkdir()
    (staging / "pkm.sqlite3").write_bytes(b"new-db")
    real_replace = os.replace

    def fail_staging_publish(src: Path, dst: Path) -> None:
        if Path(src) == staging and Path(dst) == output:
            raise OSError("simulated publication failure")
        real_replace(src, dst)

    monkeypatch.setattr(generate_module.os, "replace", fail_staging_publish)
    with pytest.raises(OSError, match="simulated publication failure"):
        _publish_staged(staging, output)
    assert (output / "config.json").read_bytes() == b"keep-me"
    assert not (output / "pkm.sqlite3").exists()


def test_generate_rejects_missing_asset_directory(tmp_path: Path) -> None:
    source = tmp_path / "graph.json"
    source.write_text((TEST_DATA / "graph.json").read_text(encoding="utf-8"), encoding="utf-8")
    with pytest.raises(ValueError, match="asset directory is not a regular directory"):
        generate(source, tmp_path / "data")


def test_generate_rejects_non_file_asset_entry(tmp_path: Path) -> None:
    source = tmp_path / "graph.json"
    source.write_text((TEST_DATA / "graph.json").read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "assets" / "nested").mkdir(parents=True)
    with pytest.raises(ValueError, match="asset is not a regular file"):
        generate(source, tmp_path / "data")


def test_publish_refuses_symlink_config_and_restores_output(tmp_path: Path) -> None:
    target = tmp_path / "config-target.json"
    target.write_bytes(b"keep-me")
    output = tmp_path / "data"
    output.mkdir()
    (output / "config.json").symlink_to(target)
    staging = tmp_path / ".data.staging"
    staging.mkdir()
    with pytest.raises(FileExistsError, match="refusing to replace non-empty output"):
        _publish_staged(staging, output)
    assert (output / "config.json").is_symlink()
    assert target.read_bytes() == b"keep-me"


def test_publish_removes_backup_after_success(tmp_path: Path) -> None:
    output = tmp_path / "data"
    output.mkdir()
    (output / "config.json").write_bytes(b"keep-me")
    staging = tmp_path / ".data.staging"
    staging.mkdir()
    (staging / "pkm.sqlite3").write_bytes(b"new-db")
    _publish_staged(staging, output)
    assert (output / "config.json").read_bytes() == b"keep-me"
    assert not list(tmp_path.glob(".data.backup-*"))


def test_publish_reports_retained_backup_when_restore_fails(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "data"
    output.mkdir()
    (output / "config.json").write_bytes(b"keep-me")
    staging = tmp_path / ".data.staging"
    staging.mkdir()
    real_replace = os.replace

    def fail_publish_and_restore(src: Path, dst: Path) -> None:
        source = Path(src)
        destination = Path(dst)
        if destination == output and source == staging:
            raise OSError("publish failed")
        if destination == output and source.name.startswith(".data.backup-"):
            raise OSError("restore failed")
        real_replace(source, destination)

    monkeypatch.setattr(generate_module.os, "replace", fail_publish_and_restore)
    with pytest.raises(RuntimeError, match="backup retained at"):
        _publish_staged(staging, output)
    backups = list(tmp_path.glob(".data.backup-*"))
    assert len(backups) == 1
    assert (backups[0] / "config.json").read_bytes() == b"keep-me"


def test_main_uses_default_source(tmp_path: Path) -> None:
    output = tmp_path / "data"
    assert main(["--out", str(output)]) == 0
    assert (output / "pkm.sqlite3").is_file()
