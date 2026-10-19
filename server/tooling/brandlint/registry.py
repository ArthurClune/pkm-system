# pattern: Imperative Shell
"""Load `server/src/pkm/brand_registry.py` by path.

The registry is import-free data, so it loads under a bare `python3`
without the server's package or its dependencies."""
from __future__ import annotations

import importlib.util
import re
from dataclasses import dataclass, field
from pathlib import Path

REGISTRY_RELPATH = "server/src/pkm/brand_registry.py"
SOURCE_RELPATH = "server/src/pkm"

# `X = NewType(`, `X = typing.NewType(` or `X: TypeAlias = NewType(`, at
# any indent.
_NEWTYPE = re.compile(r"^[ \t]*(\w+)\s*(?::[^=\n]*)?=\s*(?:\w+\.)*NewType\(", re.MULTILINE)


def declared_newtypes(repo: Path) -> frozenset[str]:
    """Every `X = NewType(...)` under server/src/pkm, however spelled, so a
    new brand is under rule 2 the moment it is declared."""
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


def load_registry(repo: Path) -> Registry:
    path = repo / REGISTRY_RELPATH
    if not path.exists():
        return Registry({}, (), declared=declared_newtypes(repo))
    spec = importlib.util.spec_from_file_location("pkm_brand_registry", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return Registry(
        names=dict(module.NAMES),
        opt_out_files=tuple(module.OPT_OUT_FILES),
        shapes=dict(module.SHAPES),
        mint_sites=dict(module.MINT_SITES),
        cast_sites=tuple(module.CAST_SITES),
        sqlite_sites=tuple(module.SQLITE_SITES),
        declared=declared_newtypes(repo),
        test_mint_sites=tuple(module.TEST_MINT_SITES),
        test_helpers=dict(module.TEST_HELPERS),
        malformed=dict(module.MALFORMED),
        test_code=tuple(module.TEST_CODE),
    )
