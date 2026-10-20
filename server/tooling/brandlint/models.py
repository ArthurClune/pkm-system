# pattern: Functional Core
"""Rule 3: every model is strict, and a model is built where pyrefly can
check it.

`model-strict` reports a class that subclasses `BaseModel` directly (only
the registry's STRICT_BASE may), any way of switching strictness off
(`strict=False`, `{"strict": False}`), and the pydantic routes around a
model's checked fields (`create_model`, `pydantic.dataclasses`,
`validate_call`).

`model-unchecked` reports a producer pyrefly cannot see into:
`.model_validate(...)` of a dict built in place, and `.model_copy(update=)`.

Stdlib only and runnable under the system `python3`."""
from __future__ import annotations

import ast

from brandlint.registry import Registry


def _leaf(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _is_false(node: ast.expr | None) -> bool:
    return isinstance(node, ast.Constant) and node.value is False


def _built_in_place(node: ast.expr) -> bool:
    return isinstance(node, (ast.Dict, ast.DictComp)) \
        or (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict")


def _imports_pydantic_dataclasses(node: ast.stmt) -> bool:
    if isinstance(node, ast.Import):
        return any(a.name == "pydantic.dataclasses" or a.name.startswith("pydantic.dataclasses.")
                   for a in node.names)
    if isinstance(node, ast.ImportFrom) and node.module is not None:
        return node.module == "pydantic.dataclasses" or node.module.startswith("pydantic.dataclasses.") \
            or (node.module == "pydantic" and any(a.name == "dataclasses" for a in node.names))
    return False


def model_sites(path: str, tree: ast.AST, registry: Registry) -> list[tuple[int, str, str]]:
    """(line, rule, source text) for every model-strict and
    model-unchecked site in `tree`."""
    strict_path, strict_class = registry.strict_base or ("", "")
    out: list[tuple[int, str, str]] = []
    fix_base = "inherit `StrictModel` (pkm.contracts.strict)"
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            direct = any(_leaf(b) == "BaseModel" for b in node.bases)
            if direct and not (path == strict_path and node.name == strict_class):
                out.append((node.lineno, "model-strict", f"`class {node.name}(BaseModel)`: {fix_base}"))
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value == "strict" and _is_false(value):
                    out.append((key.lineno, "model-strict", '`"strict": False` turns strictness off: remove it'))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            if _imports_pydantic_dataclasses(node):
                out.append((node.lineno, "model-strict",
                            "`pydantic.dataclasses` is unchecked: declare a `StrictModel`"))
        elif isinstance(node, ast.Attribute) and node.attr == "dataclasses" \
                and isinstance(node.value, ast.Name) and node.value.id == "pydantic":
            out.append((node.lineno, "model-strict", "`pydantic.dataclasses` is unchecked: declare a `StrictModel`"))
        elif isinstance(node, (ast.Name, ast.Attribute)) and _leaf(node) == "validate_call":
            out.append((node.lineno, "model-strict", "`validate_call` is unchecked: validate in the function body"))
        if isinstance(node, ast.Call):
            name = _leaf(node.func)
            for kw in node.keywords:
                if kw.arg == "strict" and _is_false(kw.value):
                    out.append((node.lineno, "model-strict", "`strict=False` turns strictness off: remove it"))
            if name == "create_model":
                out.append((node.lineno, "model-strict",
                            "`create_model(...)` builds an unchecked model: declare a `StrictModel` class"))
            elif name == "model_validate" and isinstance(node.func, ast.Attribute) \
                    and node.args and _built_in_place(node.args[0]):
                out.append((node.lineno, "model-unchecked",
                            "`.model_validate(...)` of a dict built in place is unchecked: build the model "
                            "with keyword arguments, or decode JSON text with `model_validate_json`"))
            elif name == "model_copy" and isinstance(node.func, ast.Attribute) \
                    and any(kw.arg == "update" for kw in node.keywords):
                out.append((node.lineno, "model-unchecked",
                            "`.model_copy(update=...)` is unchecked: build the model again with keyword "
                            "arguments"))
    return out
