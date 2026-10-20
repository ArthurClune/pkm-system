# pattern: Imperative Shell
"""Load `server/src/pkm/brand_registry.py` by path.

The registry is import-free data, so it loads under a bare `python3`
without the server's package or its dependencies."""
from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REGISTRY_RELPATH = "server/src/pkm/brand_registry.py"
SOURCE_RELPATH = "server/src/pkm"

# `X = NewType(`, `X = typing.NewType(` or `X: TypeAlias = NewType(`, at
# any indent.
_NEWTYPE = re.compile(r"^[ \t]*(\w+)\s*(?::[^=\n]*)?=\s*(?:\w+\.)*NewType\(", re.MULTILINE)


# Reads one repo-relative file: the staged copy in the pre-commit hook.
Reader = Callable[[Path, str], str]


def declared_newtypes(repo: Path, read: Reader | None = None, paths: list[str] | None = None) -> frozenset[str]:
    """Every `X = NewType(...)` under server/src/pkm, however spelled, so a
    new brand is under rule 2 the moment it is declared. With `read` and
    `paths` (the files the commit would contain), those are scanned instead
    of the working tree."""
    if read is not None and paths is not None:
        return frozenset(
            name
            for path in paths
            if path.startswith(SOURCE_RELPATH + "/") and path.endswith(".py")
            for name in _NEWTYPE.findall(read(repo, path))
        )
    root = repo / SOURCE_RELPATH
    if not root.is_dir():
        return frozenset()
    return frozenset(
        name
        for path in root.rglob("*.py")
        for name in _NEWTYPE.findall(path.read_text(encoding="utf-8", errors="replace"))
    )


@dataclass(frozen=True)
class Registry:
    names: dict[str, tuple[str, ...]]
    opt_out_files: tuple[str, ...]
    shapes: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    mint_sites: dict[str, tuple[str, ...]] = field(default_factory=dict)
    cast_sites: tuple[str, ...] = ()
    sqlite_sites: tuple[str, ...] = ()
    declared: frozenset[str] = frozenset()
    test_mint_sites: tuple[str, ...] = ()
    test_helpers: dict[str, str] = field(default_factory=dict)
    malformed: dict[str, str] = field(default_factory=dict)
    test_code: tuple[str, ...] = ()
    strict_base: tuple[str, str] | None = None


def load_registry(repo: Path, read: Reader | None = None, paths: list[str] | None = None) -> Registry:
    """The registry of the working tree, or with `read` and `paths` the one
    the commit would contain: a commit that stages a registry change with
    the code it allows is judged against the staged registry."""
    if read is not None and paths is not None:
        present = REGISTRY_RELPATH in paths
        source = read(repo, REGISTRY_RELPATH) if present else ""
    else:
        present = (repo / REGISTRY_RELPATH).exists()
        source = (repo / REGISTRY_RELPATH).read_text(encoding="utf-8") if present else ""
    declared = declared_newtypes(repo, read, paths)
    if not present:
        return Registry({}, (), declared=declared)
    namespace: dict[str, Any] = {}
    exec(compile(source, REGISTRY_RELPATH, "exec"), namespace)
    return Registry(
        names=dict(namespace["NAMES"]),
        opt_out_files=tuple(namespace["OPT_OUT_FILES"]),
        shapes=dict(namespace["SHAPES"]),
        mint_sites=dict(namespace["MINT_SITES"]),
        cast_sites=tuple(namespace["CAST_SITES"]),
        sqlite_sites=tuple(namespace["SQLITE_SITES"]),
        declared=declared,
        test_mint_sites=tuple(namespace["TEST_MINT_SITES"]),
        test_helpers=dict(namespace["TEST_HELPERS"]),
        malformed=dict(namespace["MALFORMED"]),
        test_code=tuple(namespace["TEST_CODE"]),
        strict_base=tuple(namespace["STRICT_BASE"]) if "STRICT_BASE" in namespace else None,
    )
