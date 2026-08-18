"""The shared on-disk asset verification boundary (pkm-6g0l).

`asset_on_disk_needs_repair` is the one implementation of the "trust
nothing already at a content-addressed path" ritual both the importer's
asset copy and the export writer's asset staging run. These tests pin the
four outcomes and, crucially, the size-before-hash short circuit: a
divergence there would silently cost a full read of every asset already
known to be wrong.
"""
import hashlib

import pkm.assets_disk as assets_disk
from pkm.assets_disk import asset_on_disk_needs_repair

BYTES = b"PNGDATA"
SHA = hashlib.sha256(BYTES).hexdigest()


def _write(tmp_path, data: bytes):
    path = tmp_path / SHA
    path.write_bytes(data)
    return path


def test_missing_file_needs_repair(tmp_path):
    assert asset_on_disk_needs_repair(tmp_path / SHA, SHA, len(BYTES)) is True


def test_directory_at_the_path_needs_repair(tmp_path):
    # Not a regular file: the caller's (re)write branch has to run rather
    # than a stat/read blowing up inside verification.
    (tmp_path / SHA).mkdir()
    assert asset_on_disk_needs_repair(tmp_path / SHA, SHA, len(BYTES)) is True


def test_size_mismatch_needs_repair(tmp_path):
    path = _write(tmp_path, b"PNGDA")  # truncated
    assert asset_on_disk_needs_repair(path, SHA, len(BYTES)) is True


def test_same_size_hash_mismatch_needs_repair(tmp_path):
    path = _write(tmp_path, b"CORRUPT")  # same length, wrong bytes
    assert len(path.read_bytes()) == len(BYTES)
    assert asset_on_disk_needs_repair(path, SHA, len(BYTES)) is True


def test_valid_file_needs_no_repair(tmp_path):
    path = _write(tmp_path, BYTES)
    assert asset_on_disk_needs_repair(path, SHA, len(BYTES)) is False


def test_size_mismatch_short_circuits_before_hashing(tmp_path, monkeypatch):
    # The size check exists to save a full read of a file already proven
    # wrong -- if a refactor ever hashes first, this fails.
    hashed: list[int] = []
    real = assets_disk.sha256_hex
    monkeypatch.setattr(
        assets_disk, "sha256_hex",
        lambda data: (hashed.append(len(data)), real(data))[1])

    truncated = _write(tmp_path, b"PNGDA")
    assert asset_on_disk_needs_repair(truncated, SHA, len(BYTES)) is True
    assert hashed == []

    truncated.write_bytes(BYTES)
    assert asset_on_disk_needs_repair(truncated, SHA, len(BYTES)) is False
    assert hashed == [len(BYTES)]
