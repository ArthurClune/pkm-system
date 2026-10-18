# pattern: Functional Core
"""Rule 1: a parameter or field whose name means a brand carries it.
Rule 2: a brand is minted, `cast` used, `model_construct` called and raw
sqlite touched only where the registry says.

`def f(uid: str)`, `def f(uid)` and `page_id: int` in a dataclass,
TypedDict or model are violations; an annotation passes when any name in
it, or in a string annotation, is one of the brands the registry lists for
that name. A brand is minted by calling it, under any import alias, or by
passing it as a value (`map(BlockUid, xs)`).

Tests are under every rule. They mint through the checked helpers of
`pkm.test_data.ids` (the registry's TEST_MINT_SITES), which product code
may not import, and a message in a test names the helper.

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

SCOPE_ROOTS = ("server/src/", "server/tooling/", "server/tests/")

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
    "test-mint-import": "`pkm.test_data.ids` mints any brand unchecked by the product's rules and is for "
                        "tests only: in product code read the value from a `select()` row, a contract model "
                        "or a parser",
    "brand-launder": "a function that returns a brand must annotate every parameter and none may be `Any`: "
                     "an untyped value passed through `-> BlockUid` becomes a brand with no mint; give the "
                     "parameter its real type and parse it, or read the value from a `select()` row",
    "brand-ignore": "a `pyrefly: ignore` or `type: ignore` silences every argument of its call, a brand "
                    "literal included: pass the value through its helper (`uid_of` and kin from "
                    "pkm.test_data.ids in a test) or its parser",
}

# Matched at the start of a comment token.
_OPT_OUT = re.compile(r"#\s*brand:\s*untrusted\b(?P<rest>.*)$")
_REASON = re.compile(r"^\s*--\s*\S")


def in_scope(path: str) -> bool:
    """Python under server/src, server/tooling and server/tests; tests and
    test-data builders are exempt from nothing."""
    return path.startswith(SCOPE_ROOTS) and PurePosixPath(path).suffix == ".py"


def _test_mint_module(registry: Registry) -> str | None:
    """The dotted name of the server's entry in TEST_MINT_SITES."""
    for site in registry.test_mint_sites:
        if site.startswith("server/src/") and site.endswith(".py"):
            return site[len("server/src/"):-len(".py")].replace("/", ".")
    return None


def _test_fix(brand: str, registry: Registry) -> str:
    """How a test mints `brand`: its helper, and the forging one for a
    deliberately bad value when the brand has a shape."""
    stem = registry.test_helpers.get(brand)
    module = _test_mint_module(registry)
    if stem is None or module is None:
        return ""
    fix = f"use `{stem}_of` from {module}"
    if brand in registry.malformed:
        fix += f" (`malformed_{registry.malformed[brand]}` for a deliberately bad value)"
    return fix


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
    """(name, annotation or None, first line, last line) for every checked
    site. A function parameter without an annotation is checked too, since
    it takes anything; a lambda's is not."""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = node.args
            params = [*a.posonlyargs, *a.args, *a.kwonlyargs]
            params += [p for p in (a.vararg, a.kwarg) if p is not None]
            for p in params:
                yield p.arg, p.annotation, p.lineno, p.end_lineno or p.lineno
        elif isinstance(node, ast.ClassDef):
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    yield stmt.target.id, stmt.annotation, stmt.lineno, stmt.end_lineno or stmt.lineno


def _is_any(node: ast.expr) -> bool:
    """Whether an annotation is `Any`, or a union or `Optional` with `Any`
    as a member. `dict[str, Any]` is not: its values are checked where they
    are used."""
    if isinstance(node, (ast.Name, ast.Attribute)):
        return _leaf(node) == "Any"
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return _is_any(node.left) or _is_any(node.right)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        try:
            return _is_any(ast.parse(node.value.strip(), mode="eval").body)
        except SyntaxError:
            return False
    if isinstance(node, ast.Subscript) and _leaf(node.value) in ("Union", "Optional"):
        args = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
        return any(_is_any(a) for a in args)
    return False


def _launderers(path: str, tree: ast.AST, registry: Registry):
    """(line, function name, brand) for each function whose return
    annotation carries a brand it may not mint and which takes a parameter
    (not self or cls) with no annotation or an `Any` one: the checker
    cannot see what flows through such a parameter, so returning it as the
    brand mints it unseen."""
    brands = set(registry.shapes) | set(registry.mint_sites) | registry.declared
    declared, derived = _declared_brands(path, tree, brands)
    brands |= derived
    if _site_allowed(path, registry.test_mint_sites):
        return
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node.returns is None:
            continue
        found: list[tuple[str, bool]] = []
        _scan(node.returns, False, found)
        returned = sorted({t for t, _ in found} & brands)
        returned = [b for b in returned if b not in declared
                    and not _site_allowed(path, registry.mint_sites.get(b, ()))]
        if not returned:
            continue
        a = node.args
        positional = [*a.posonlyargs, *a.args]
        if positional and positional[0].arg in ("self", "cls"):
            positional = positional[1:]
        params = [*positional, *a.kwonlyargs]
        params += [p for p in (a.vararg, a.kwarg) if p is not None]
        if any(p.annotation is None or _is_any(p.annotation) for p in params):
            yield node.lineno, node.name, returned[0]


def _site_allowed(path: str, sites: tuple[str, ...]) -> bool:
    return any(path == site or (site.endswith("/") and path.startswith(site)) for site in sites)


def _local_newtypes(tree: ast.AST) -> dict[str, str | None]:
    """Name -> base type name for each `X = NewType(...)`, `typing.NewType`
    or annotated `X: TypeAlias = NewType(...)` this file binds, at any
    depth."""
    out: dict[str, str | None] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target, value = node.targets[0], node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            target, value = node.target, node.value
        else:
            continue
        if isinstance(target, ast.Name) and isinstance(value, ast.Call) and _leaf(value.func) == "NewType":
            out[target.id] = _leaf(value.args[1]) if len(value.args) > 1 else None
    return out


def _declared_brands(path: str, tree: ast.AST, brands: set[str]) -> tuple[set[str], set[str]]:
    """(brands this file declares and may mint, local NewTypes that are
    brands here but not declared). Outside server/src/pkm a NewType over a
    registered brand is a brand-compatible value without the brand's checks,
    so the file may not mint it either."""
    local = _local_newtypes(tree)
    if path.startswith("server/src/pkm/"):
        return set(local), set()
    derived: set[str] = set()
    grew = True
    while grew:
        grew = False
        for name, base in local.items():
            if name not in derived and base is not None and base in brands | derived:
                derived.add(name)
                grew = True
    return set(local) - derived, derived


def _brand_aliases(tree: ast.AST, brands: set[str]) -> dict[str, str]:
    """`from m import BlockUid as U` binds U -> BlockUid."""
    return {
        alias.asname: alias.name
        for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
        for alias in node.names if alias.asname and alias.name in brands
    }


def _package(path: str) -> list[str]:
    """The package a scoped file sits in, for resolving relative imports."""
    rel = next(path[len(root):] for root in SCOPE_ROOTS if path.startswith(root))
    return rel.split("/")[:-1]


def _imports_module(node: ast.Import | ast.ImportFrom, path: str, module: str) -> bool:
    if isinstance(node, ast.Import):
        return any(a.name == module for a in node.names)
    base = node.module or ""
    if node.level:
        package = _package(path)
        base = ".".join([*package[:len(package) - node.level + 1], *([node.module] if node.module else [])])
    return base == module or any(f"{base}.{a.name}" == module for a in node.names)


# Calls whose argument at this position is a type, not a value: the brand
# there is not a function to apply.
_TYPE_SLOTS = {"cast": 0, "NewType": 1, "TypeAdapter": 0, "isinstance": 1, "assert_type": 1}


def _type_expressions(tree: ast.AST) -> set[int]:
    """ids of every node inside a subscript's slice or a type-taking call's
    type slot: `dict[str, BlockUid]`, `isinstance(x, (A, B))`."""
    roots: list[ast.AST] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript):
            roots.append(node.slice)
        elif isinstance(node, ast.Call):
            slot = _TYPE_SLOTS.get(_leaf(node.func) or "")
            if slot is not None and len(node.args) > slot:
                roots.append(node.args[slot])
    return {id(n) for root in roots for n in ast.walk(root)}


def _held_values(tree: ast.AST):
    """Every expression the code holds as a value: a call argument, the value
    of an assignment, walrus or return, and an element of a list, tuple, set
    or dict."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            yield from node.args
            yield from (k.value for k in node.keywords)
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr, ast.Return)) and node.value is not None:
            yield node.value
        elif isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            yield from node.elts
        elif isinstance(node, ast.Dict):
            yield from (k for k in node.keys if k is not None)
            yield from node.values


SQLITE_RAW_NAMES = ("connect", "Connection", "Cursor")


def _escape_hatches(path: str, tree: ast.AST, registry: Registry,
                    is_test: bool) -> list[tuple[int, str, str]]:
    """(line, rule, source text) for every rule-2 site in `tree`."""
    brands = set(registry.shapes) | set(registry.mint_sites) | registry.declared
    declared, derived = _declared_brands(path, tree, brands)
    brands |= derived
    aliases = _brand_aliases(tree, brands)
    cast_ok = _site_allowed(path, registry.cast_sites)
    sqlite_ok = _site_allowed(path, registry.sqlite_sites)
    mint_module = _test_mint_module(registry)
    any_mint_ok = _site_allowed(path, registry.test_mint_sites)

    def brand_of(node: ast.expr) -> str | None:
        """The brand `node` names, through an import alias, unless this
        file may mint it."""
        name = aliases.get(node.id, node.id) if isinstance(node, ast.Name) else _leaf(node)
        if name is None or name not in brands or name in declared or any_mint_ok \
                or _site_allowed(path, registry.mint_sites.get(name, ())):
            return None
        return name

    def mint(brand: str, what: str) -> str:
        fix = _test_fix(brand, registry) if is_test else ""
        return f"{what} in a test: {fix}" if fix else f"{what} outside its mint sites"

    out: list[tuple[int, str, str]] = []
    types = _type_expressions(tree)
    for value in _held_values(tree):
        held = None if id(value) in types else brand_of(value)
        if held is not None:
            out.append((value.lineno, "brand-mint", mint(held, f"`{held}` held as a value")))
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)) and not is_test and mint_module is not None \
                and _imports_module(node, path, mint_module):
            out.append((node.lineno, "test-mint-import", f"`{mint_module}` imported by product code"))
        if isinstance(node, ast.ImportFrom) and node.module == "sqlite3" and not sqlite_ok:
            raw = [a.name for a in node.names if a.name in SQLITE_RAW_NAMES]
            if raw:
                out.append((node.lineno, "raw-sqlite", f"`from sqlite3 import {raw[0]}` outside SQLITE_SITES"))
        elif isinstance(node, ast.Import) and not sqlite_ok:
            if any(a.name == "sqlite3" and a.asname for a in node.names):
                out.append((node.lineno, "raw-sqlite", "`import sqlite3 as ...` outside SQLITE_SITES"))
        elif isinstance(node, ast.Call):
            name = _leaf(node.func) or ""
            called = brand_of(node.func)
            if called is not None:
                out.append((node.lineno, "brand-mint", mint(called, f"`{called}(...)`")))
            elif name == "cast" and not cast_ok:
                target = (_leaf(node.args[0]) if node.args else None) or ""
                fix = _test_fix(target, registry) if is_test and target in brands else ""
                out.append((node.lineno, "brand-cast",
                            f"`cast(...)` in a test: {fix}" if fix else "`cast(...)` outside CAST_SITES"))
            elif name == "model_construct" and isinstance(node.func, ast.Attribute):
                out.append((node.lineno, "model-construct", "`.model_construct(...)` skips validation"))
            elif name == "cursor" and isinstance(node.func, ast.Attribute) and not sqlite_ok:
                out.append((node.lineno, "raw-sqlite", "`.cursor()` outside SQLITE_SITES"))
        elif isinstance(node, ast.Attribute) and not sqlite_ok:
            on_sqlite = isinstance(node.value, ast.Name) and node.value.id == "sqlite3"
            if node.attr == "raw" or (on_sqlite and node.attr in SQLITE_RAW_NAMES):
                text = "`.raw` outside SQLITE_SITES" if node.attr == "raw" \
                    else f"`sqlite3.{node.attr}` outside SQLITE_SITES"
                out.append((node.lineno, "raw-sqlite", text))
    return out


# A comment that silences the type checker for its line.
_IGNORE = re.compile(r"#\s*(?:pyrefly:\s*ignore|type:\s*ignore)\b")


def _is_literal(node: ast.expr) -> bool:
    """A plain literal, or a non-empty list, tuple or set of them."""
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return bool(node.elts) and all(_is_literal(e) for e in node.elts)
    if isinstance(node, ast.UnaryOp):
        node = node.operand
    return isinstance(node, ast.JoinedStr) or (isinstance(node, ast.Constant) and node.value is not None)


def _ignored_literals(tree: ast.AST, ignored: set[int], registry: Registry):
    """(line, name, brand) for each plain literal passed to a keyword with a
    rule-1 name in a call whose lines carry a type-check ignore, or inside
    such a call. A positional literal is not seen: that needs the callee's
    signature."""
    seen: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        span = range(node.lineno, (node.end_lineno or node.lineno) + 1)
        if not any(n in ignored for n in span):
            continue
        for inner in ast.walk(node):
            for k in inner.keywords if isinstance(inner, ast.Call) else ():
                if id(k) not in seen and k.arg in registry.names and _is_literal(k.value):
                    seen.add(id(k))
                    yield k.value.lineno, k.arg, registry.names[k.arg][0]


def check_text(path: str, text: str, registry: Registry) -> list[Violation]:
    """Every brand-lint violation in `text`, in file order."""
    if not in_scope(path):
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
    is_test = _site_allowed(path, registry.test_code)
    out: list[Violation] = []
    opted: set[int] = set()
    ignored: set[int] = set()
    for n, comment in _comments(text):
        if _IGNORE.search(comment):
            ignored.add(n)
            # A comment on a line of its own silences the next line.
            if lines[n - 1].lstrip().startswith("#"):
                ignored.add(n + 1)
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
        if annotation is None:
            problem = f"`{name}` has no annotation: annotate it `{' or '.join(registry.names[name])}`"
        else:
            problem = _problem(name, annotation, registry)
        if problem is None or any(n in opted for n in range(first, last + 1)):
            continue
        fix = _test_fix(registry.names[name][0], registry) if is_test else ""
        if fix:
            problem += f"; for a value in a test, {fix}"
        out.append(Violation(path, first, "brand-name", f"{problem}: {lines[first - 1].strip()}"))
    for line, name, brand in _ignored_literals(tree, ignored, registry):
        fix = _test_fix(brand, registry) if is_test else ""
        what = f"`{name}=` literal on a line whose type check is silenced"
        out.append(Violation(path, line, "brand-ignore",
                             f"{what}: {fix or 'parse it'}: {lines[line - 1].strip()}"))
    for line, name, brand in _launderers(path, tree, registry):
        fix = _test_fix(brand, registry) if is_test else ""
        what = f"`{name}` returns `{brand}` but takes an unannotated or `Any` parameter"
        out.append(Violation(path, line, "brand-launder",
                             f"{what}{'; ' + fix if fix else ''}: {lines[line - 1].strip()}"))
    for line, rule, what in _escape_hatches(path, tree, registry, is_test):
        out.append(Violation(path, line, rule, f"{what}: {lines[line - 1].strip()}"))
    return sorted(out, key=lambda v: v.line)
