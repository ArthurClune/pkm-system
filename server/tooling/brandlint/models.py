# pattern: Functional Core
"""Rule 3: every model is strict, and a model is built where pyrefly can
check it.

`model-strict` reports a class that subclasses `BaseModel` or `RootModel`
directly, through any import alias (only the registry's STRICT_BASE may), any
way of switching strictness off (`strict=` or a `"strict"` key set to
anything but True), and the pydantic routes around a
model's checked fields (`create_model`, `pydantic.dataclasses`,
`validate_call`).

`model-unchecked` reports a producer pyrefly cannot see into:
`.model_validate(...)` of a dict built in place (or `json.dumps` of one fed to
`model_validate_json`), and `.model_copy(update=)`.

Stdlib only and runnable under the system `python3`."""
from __future__ import annotations

import ast

from brandlint.registry import Registry


BASES = ("BaseModel", "RootModel")
DICT_BUILT_METHODS = ("model_validate", "model_validate_strings", "validate_python", "validate_strings")
JSON_METHODS = ("model_validate_json", "validate_json")
DATA_KEYWORDS = ("obj", "object", "json_data", "data")
PYDANTIC_MODULES = ("pydantic", "pydantic.main", "pydantic.root_model")


def _leaf(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _is_true(node: ast.expr | None) -> bool:
    return isinstance(node, ast.Constant) and node.value is True


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


def _aliases(tree: ast.AST) -> tuple[set[str], set[str], set[str]]:
    """(local names of pydantic's BaseModel and RootModel, local names of
    the pydantic module, local names of `json.dumps`), through import
    aliases."""
    bases = set(BASES)
    modules = {"pydantic"}
    dumps = {"dumps"}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in PYDANTIC_MODULES:
            bases |= {a.asname for a in node.names if a.name in BASES and a.asname}
        elif isinstance(node, ast.ImportFrom) and node.module == "json":
            dumps |= {a.asname for a in node.names if a.name == "dumps" and a.asname}
        elif isinstance(node, ast.Import):
            modules |= {a.asname for a in node.names if a.name == "pydantic" and a.asname}
    return bases, modules, dumps


def _names_a_base(node: ast.expr, bases: set[str], modules: set[str]) -> bool:
    if isinstance(node, ast.Subscript):
        node = node.value
    if isinstance(node, ast.Name):
        return node.id in bases
    return isinstance(node, ast.Attribute) and node.attr in BASES \
        and (not isinstance(node.value, ast.Name) or node.value.id in modules)


def _data_argument(node: ast.Call) -> ast.expr | None:
    if node.args:
        return node.args[0]
    return next((kw.value for kw in node.keywords if kw.arg in DATA_KEYWORDS), None)


def model_sites(path: str, tree: ast.AST, registry: Registry) -> list[tuple[int, str, str]]:
    """(line, rule, source text) for every model-strict and
    model-unchecked site in `tree`."""
    strict_path, strict_class = registry.strict_base or ("", "")
    bases, modules, dumps = _aliases(tree)
    out: list[tuple[int, str, str]] = []
    fix_base = "inherit `StrictModel` (pkm.contracts.strict)"
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            direct = any(_names_a_base(b, bases, modules) for b in node.bases)
            if direct and not (path == strict_path and node.name == strict_class):
                out.append((node.lineno, "model-strict", f"`class {node.name}` subclasses pydantic's "
                            f"`BaseModel` or `RootModel` directly: {fix_base}"))
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value == "strict" and not _is_true(value):
                    out.append((key.lineno, "model-strict",
                                '`"strict"` other than True turns strictness off: remove it'))
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
                if kw.arg == "strict" and not _is_true(kw.value):
                    out.append((node.lineno, "model-strict",
                                "`strict=` other than True turns strictness off: remove it"))
            data = _data_argument(node)
            if name == "create_model":
                out.append((node.lineno, "model-strict",
                            "`create_model(...)` builds an unchecked model: declare a `StrictModel` class"))
            elif name in DICT_BUILT_METHODS and isinstance(node.func, ast.Attribute) \
                    and data is not None and _built_in_place(data):
                out.append((node.lineno, "model-unchecked",
                            f"`.{name}(...)` of a dict built in place is unchecked: build the model "
                            "with keyword arguments, or decode a JSON string literal with `model_validate_json`"))
            elif name in JSON_METHODS and isinstance(node.func, ast.Attribute) and isinstance(data, ast.Call) \
                    and _leaf(data.func) in dumps:
                out.append((node.lineno, "model-unchecked",
                            f"`.{name}(json.dumps(...))` is a dict built in place in disguise: build the "
                            "model with keyword arguments, or decode a JSON string literal"))
            elif name == "model_copy" and isinstance(node.func, ast.Attribute) \
                    and any(kw.arg == "update" for kw in node.keywords):
                out.append((node.lineno, "model-unchecked",
                            "`.model_copy(update=...)` is unchecked: build the model again with keyword "
                            "arguments"))
    return out
