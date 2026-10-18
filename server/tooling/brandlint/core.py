# pattern: Functional Core
"""Rule 1: a parameter or field whose name means a brand carries it.
Rule 2: a brand is minted, `cast` used, `model_construct` called and raw
sqlite touched only where the registry says.

`def f(uid: str)` and `page_id: int` in a dataclass, TypedDict or model
are violations; an annotation passes when any name in it, or in a string
annotation, is one of the brands the registry lists for that name.

A line may carry `# brand: untrusted -- <reason>` to say the value is
untrusted input parsed on that line. The opt-out is allowed only in the
registry's OPT_OUT_FILES (route modules) and must give a reason.

Stdlib only and runnable under the system `python3`."""
from __future__ import annotations

import ast
import io
import re
import sys
import tokenize
from pathlib import PurePosixPath

from brandlint.registry import Registry
from commentlint.core import Violation

SCOPE_ROOTS = ("server/src/", "server/tooling/")

RULES = {
    "brand-name": "a name that means a brand must carry it: read the value from a `select()` row, take it "
                  "from a contract model, or parse it with the brand's parser; untrusted route input may "
                  "carry `# brand: untrusted -- <reason>`",
    "brand-mint": "a brand is minted only at its registered parse points: read the value from a `select()` "
                  "row, take it from a contract model, or parse it with a `parse_*` function in a "
                  "MINT_SITES file",
    "brand-cast": "`cast` is allowed only in CAST_SITES files: read the value from a `select()` row or "
                  "narrow it with a parser instead of asserting a type",
    "model-construct": "`model_construct` skips validation: build the model with its constructor or "
                       "`model_validate`",
    "raw-sqlite": "raw sqlite belongs to pkm.database: use `Db` (`select`, `select_one`, `execute`, "
                  "`executemany`) instead of `sqlite3.connect`, cursors or `.raw`",
    "brand-parse": "brandlint could not parse this file; it needs Python >= 3.12 (PEP 695 syntax): run it "
                   "under a newer python3",
    "brand-opt-out": "`# brand: untrusted -- <reason>` is allowed only in route modules (routes_*.py) and "
                     "must give a reason",
}

# Matched at the start of a comment token.
_OPT_OUT = re.compile(r"#\s*brand:\s*untrusted\b(?P<rest>.*)$")
_REASON = re.compile(r"^\s*--\s*\S")


def in_scope(path: str, registry: Registry) -> bool:
    """Python under server/src and server/tooling; test-data builders count
    as tests."""
    if not path.startswith(SCOPE_ROOTS) or PurePosixPath(path).suffix != ".py":
        return False
    return not any(path.startswith(prefix) for prefix in registry.test_support)


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def _opt_out_allowed(path: str, registry: Registry) -> bool:
    return any(_glob_to_regex(p).match(path) for p in registry.opt_out_files)


def _comments(text: str) -> list[tuple[int, str]]:
    """(line, text) of every real comment, so a marker quoted inside a string
    or docstring is not mistaken for one."""
    try:
        return [(t.start[0], t.string)
                for t in tokenize.generate_tokens(io.StringIO(text).readline)
                if t.type == tokenize.COMMENT]
    except (tokenize.TokenError, IndentationError):
        return []


_BASES = {"text": "str", "int": "int"}
_ANY_TYPES = frozenset({"Any", "object"})


def _leaf(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _scan(node: ast.expr, in_union: bool, found: list[tuple[str, bool]]) -> None:
    """Collect (type name, whether it is a union member) from the type
    positions of an annotation. Calls, `Literal[...]` and `Annotated`
    metadata are not type positions; a string constant is parsed as one."""
    if isinstance(node, (ast.Name, ast.Attribute)):
        found.append((_leaf(node) or "", in_union))
    elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        _scan(node.left, True, found)
        _scan(node.right, True, found)
    elif isinstance(node, ast.Constant) and isinstance(node.value, str):
        try:
            inner = ast.parse(node.value.strip(), mode="eval").body
        except SyntaxError:
            return
        _scan(inner, in_union, found)
    elif isinstance(node, ast.Subscript):
        head = _leaf(node.value)
        found.append((head or "", in_union))
        args = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
        if head == "Literal":
            return
        if head == "Annotated":
            _scan(args[0], in_union, found)
            return
        union = head in ("Union", "Optional")
        for arg in args:
            _scan(arg, union, found)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for elt in node.elts:
            _scan(elt, in_union, found)


def _problem(name: str, annotation: ast.expr, registry: Registry) -> str | None:
    """Why `annotation` does not carry the brand of `name`, or None."""
    brands = registry.names[name]
    found: list[tuple[str, bool]] = []
    _scan(annotation, False, found)
    bases = {_BASES.get(registry.shapes.get(b, ("", None))[0], "") for b in brands} - {""}
    loose = _ANY_TYPES | bases
    allows = sorted({t for t, member in found if member and t in loose})
    if allows:
        return f"`{name}` must be {' or '.join(brands)}, but the annotation also allows `{allows[0]}`"
    if not {t for t, _ in found} & set(brands):
        return f"`{name}` must be {' or '.join(brands)}"
    return None


def _annotated_names(tree: ast.AST):
    """(name, annotation, first line, last line) for every checked site."""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = node.args
            params = [*a.posonlyargs, *a.args, *a.kwonlyargs]
            params += [p for p in (a.vararg, a.kwarg) if p is not None]
            for p in params:
                if p.annotation is not None:
                    yield p.arg, p.annotation, p.lineno, p.end_lineno or p.lineno
        elif isinstance(node, ast.ClassDef):
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    yield stmt.target.id, stmt.annotation, stmt.lineno, stmt.end_lineno or stmt.lineno


def _site_allowed(path: str, sites: tuple[str, ...]) -> bool:
    return any(path == site or (site.endswith("/") and path.startswith(site)) for site in sites)


def _declared_brands(tree: ast.AST) -> set[str]:
    """Names this file binds with `X = NewType(...)`."""
    return {
        node.targets[0].id
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign) and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and isinstance(node.value, ast.Call) and _leaf(node.value.func) == "NewType"
    }


SQLITE_RAW_NAMES = ("connect", "Connection", "Cursor")


def _escape_hatches(path: str, tree: ast.AST, registry: Registry) -> list[tuple[int, str, str]]:
    """(line, rule, source text) for every rule-2 site in `tree`."""
    brands = set(registry.shapes) | set(registry.mint_sites) | registry.declared
    declared = _declared_brands(tree)
    cast_ok = _site_allowed(path, registry.cast_sites)
    sqlite_ok = _site_allowed(path, registry.sqlite_sites)
    out: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "sqlite3" and not sqlite_ok:
            raw = [a.name for a in node.names if a.name in SQLITE_RAW_NAMES]
            if raw:
                out.append((node.lineno, "raw-sqlite", f"`from sqlite3 import {raw[0]}` outside pkm.database"))
        elif isinstance(node, ast.Import) and not sqlite_ok:
            if any(a.name == "sqlite3" and a.asname for a in node.names):
                out.append((node.lineno, "raw-sqlite", "`import sqlite3 as ...` outside pkm.database"))
        elif isinstance(node, ast.Call):
            name = _leaf(node.func) or ""
            if name in brands and name not in declared \
                    and not _site_allowed(path, registry.mint_sites.get(name, ())):
                out.append((node.lineno, "brand-mint", f"`{name}(...)` outside its mint sites"))
            elif name == "cast" and not cast_ok:
                out.append((node.lineno, "brand-cast", "`cast(...)` outside CAST_SITES"))
            elif name == "model_construct" and isinstance(node.func, ast.Attribute):
                out.append((node.lineno, "model-construct", "`.model_construct(...)` skips validation"))
            elif name == "cursor" and isinstance(node.func, ast.Attribute) and not sqlite_ok:
                out.append((node.lineno, "raw-sqlite", "`.cursor()` outside pkm.database"))
        elif isinstance(node, ast.Attribute) and not sqlite_ok:
            on_sqlite = isinstance(node.value, ast.Name) and node.value.id == "sqlite3"
            if node.attr == "raw" or (on_sqlite and node.attr in SQLITE_RAW_NAMES):
                text = "`.raw` outside pkm.database" if node.attr == "raw" \
                    else f"`sqlite3.{node.attr}` outside pkm.database"
                out.append((node.lineno, "raw-sqlite", text))
    return out


def check_text(path: str, text: str, registry: Registry) -> list[Violation]:
    """Every brand-lint violation in `text`, in file order."""
    if not in_scope(path, registry):
        return []
    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        v = sys.version_info
        return [Violation(path, exc.lineno or 1, "brand-parse",
                          f"{exc.msg}: does not parse under Python {v.major}.{v.minor}.{v.micro} "
                          "(brandlint needs >= 3.12 for PEP 695 syntax)")]
    lines = text.splitlines()
    allowed = _opt_out_allowed(path, registry)
    out: list[Violation] = []
    opted: set[int] = set()
    for n, comment in _comments(text):
        m = _OPT_OUT.match(comment)
        if m is None:
            continue
        if not allowed or not _REASON.match(m.group("rest")):
            out.append(Violation(path, n, "brand-opt-out", comment.strip()))
        else:
            opted.add(n)
    for name, annotation, first, last in _annotated_names(tree):
        if name not in registry.names:
            continue
        problem = _problem(name, annotation, registry)
        if problem is None or any(n in opted for n in range(first, last + 1)):
            continue
        out.append(Violation(path, first, "brand-name", f"{problem}: {lines[first - 1].strip()}"))
    for line, rule, what in _escape_hatches(path, tree, registry):
        out.append(Violation(path, line, rule, f"{what}: {lines[line - 1].strip()}"))
    return sorted(out, key=lambda v: v.line)
