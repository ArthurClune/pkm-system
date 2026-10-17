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

_NEWTYPE = re.compile(r"^(\w+)\s*=\s*NewType\(", re.MULTILINE)


def declared_newtypes(repo: Path) -> frozenset[str]:
    """Every module-level `X = NewType(...)` under server/src/pkm, so a new
    brand is under rule 2 the moment it is declared."""
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
    test_support: tuple[str, ...]
    shapes: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    mint_sites: dict[str, tuple[str, ...]] = field(default_factory=dict)
    cast_sites: tuple[str, ...] = ()
    declared: frozenset[str] = frozenset()


def load_registry(repo: Path) -> Registry:
    path = repo / REGISTRY_RELPATH
    if not path.exists():
        return Registry({}, (), (), declared=declared_newtypes(repo))
    spec = importlib.util.spec_from_file_location("pkm_brand_registry", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return Registry(
        names=dict(module.NAMES),
        opt_out_files=tuple(module.OPT_OUT_FILES),
        test_support=tuple(module.TEST_SUPPORT),
        shapes=dict(module.SHAPES),
        mint_sites=dict(module.MINT_SITES),
        cast_sites=tuple(module.CAST_SITES),
        declared=declared_newtypes(repo),
    )
