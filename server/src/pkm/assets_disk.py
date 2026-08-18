# pattern: Imperative Shell
"""The one place that reads a content-addressed asset file off disk to
decide whether its bytes still match the digest its own path claims
(pkm-x3l7).

The importer's asset copy and the export writer's asset staging both have
to distrust a file that merely exists at the right path -- a truncated or
bit-rotted file from an earlier run must not survive forever. Both used
to hand-roll the same stat -> hash-only-if-the-size-matches ->
`assets_core.asset_needs_repair` dance, so a drift in one of them (hashing
before statting, or dropping the size short circuit) would not have failed
any shared test. This module owns the ritual; `assets_core` still owns the
pure decision it feeds (pkm-6g0l)."""
from __future__ import annotations

from pathlib import Path

from pkm.assets_core import asset_needs_repair, sha256_hex


def asset_on_disk_needs_repair(path: Path, sha256: str,
                               expected_size: int) -> bool:
    """Whether the file at `path` must be (re)written from its
    known-good source to hold the bytes hashing to `sha256`.

    True when nothing usable is there at all (missing, or not a regular
    file), so callers need no separate existence check before this one --
    their "missing" and "present but wrong" branches are the same branch.

    The size is checked with a plain stat first and the bytes are only
    read and hashed once it already matches: a size mismatch alone
    already proves corruption, and paying for a full read of a file
    known to be wrong buys nothing. Only a same-size corruption (bit
    rot, a same-length overwrite) needs the hash."""
    if not path.is_file():
        return True
    actual_size = path.stat().st_size
    actual_sha = (sha256_hex(path.read_bytes())
                  if actual_size == expected_size else None)
    return asset_needs_repair(sha256, expected_size, actual_size, actual_sha)
