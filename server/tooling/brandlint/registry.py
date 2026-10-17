# pattern: Imperative Shell
"""Load `server/src/pkm/brand_registry.py` by path.

The registry is import-free data, so it loads under a bare `python3`
without the server's package or its dependencies."""
from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from pathlib import Path

REGISTRY_RELPATH = "server/src/pkm/brand_registry.py"


@dataclass(frozen=True)
class Registry:
    names: dict[str, tuple[str, ...]]
    opt_out_files: tuple[str, ...]
    test_support: tuple[str, ...]


def load_registry(repo: Path) -> Registry:
    path = repo / REGISTRY_RELPATH
    if not path.exists():
        return Registry({}, (), ())
    spec = importlib.util.spec_from_file_location("pkm_brand_registry", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return Registry(
        names=dict(module.NAMES),
        opt_out_files=tuple(module.OPT_OUT_FILES),
        test_support=tuple(module.TEST_SUPPORT),
    )
