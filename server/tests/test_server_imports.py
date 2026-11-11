"""The importer drives the server's write path (`importer/run.py` opens a
database and runs the title migration through `pkm.server`), so the arrow
points from the importer to the server. A server module importing from
`pkm.importer` reverses it and drags the one-shot import tooling into the
running app."""
from __future__ import annotations

import ast
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1] / "src" / "pkm" / "server"


def _imported_modules(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


def test_server_modules_import_nothing_from_the_importer():
    files = sorted(SERVER.glob("*.py"))
    assert files, f"no server modules under {SERVER}"
    offenders = [
        f"{path.name} -> {module}"
        for path in files
        for module in sorted(_imported_modules(path))
        if module == "pkm.importer" or module.startswith("pkm.importer.")
    ]
    assert offenders == []
