# pattern: Functional Core
"""Rule `regex-dollar`: a Python regex never anchors with a bare `$`.

`$` matches at the end of the string and also just before a trailing
newline, so a validation regex ending in `$` accepts `"abc\\n"`. The fix is
`\\Z`, or `fullmatch` with no anchor at all. The one legitimate `$` is end of
line, and a pattern says so with `re.MULTILINE` or an inline `(?m)`; the lint
reads that flag, so there is no comment or allow-list.

A pattern is found at the regex sinks: the `re` functions (and the ones
imported by name) and a class attribute named `regex` (Starlette's
convertors). Pydantic's `Field(pattern=)` is not a sink: it runs on Rust's
engine, where `$` has no newline case and `\\Z` is rejected.

The pattern argument is followed through a string
literal, implicit or `+` concatenation, an f-string's literal parts, a
`"".join([...])` of those, and a name assigned once in the file.

Stdlib only and runnable under the system `python3`."""
from __future__ import annotations

import ast
import re

from commentlint.core import Violation

RULES = {
    "regex-dollar": "a bare `$` also matches before a trailing newline: end the pattern with `\\Z` or "
                    "call `fullmatch`; only a pattern compiled with re.MULTILINE or (?m) may use `$`",
}

# function -> index of its `flags` positional parameter.
SINK_FLAGS = {
    "compile": 1, "match": 2, "search": 2, "fullmatch": 2, "findall": 2, "finditer": 2,
    "sub": 4, "subn": 4, "split": 3,
}
_HOLE = "\x00"
_INLINE_FLAGS = re.compile(r"\(\?([aiLmsux]+)(?:-[imsx]+)?\)")


def has_bare_dollar(pattern: str) -> bool:
    """Whether `pattern` has a `$` that is neither escaped nor inside a
    character class nor in a `(?#...)` comment."""
    i, n = 0, len(pattern)
    while i < n:
        c = pattern[i]
        if c == "\\":
            i += 2
        elif c == "[":
            i += 1
            if pattern[i:i + 1] == "^":
                i += 1
            if pattern[i:i + 1] == "]":
                i += 1
            while i < n and pattern[i] != "]":
                i += 2 if pattern[i] == "\\" else 1
            i += 1
        elif pattern.startswith("(?#", i):
            end = pattern.find(")", i)
            i = n if end < 0 else end + 1
        elif c == "$":
            return True
        else:
            i += 1
    return False


def declares_multiline(pattern: str) -> bool:
    return any("m" in m.group(1) for m in _INLINE_FLAGS.finditer(pattern))


def _flags_multiline(node: ast.expr) -> bool:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Attribute) and sub.attr in ("M", "MULTILINE"):
            return True
        if isinstance(sub, ast.Name) and sub.id in ("M", "MULTILINE"):
            return True
    return False


def _assigned_once(tree: ast.AST) -> dict[str, ast.expr]:
    """Names bound by exactly one simple assignment in the file, to their
    value, so a constant pattern defined apart from its use is followed."""
    seen: dict[str, list[ast.expr]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    seen.setdefault(target.id, []).append(node.value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            seen.setdefault(node.target.id, []).append(node.value)
        elif isinstance(node, (ast.AugAssign, ast.For, ast.comprehension)):
            for sub in ast.walk(node.target):
                if isinstance(sub, ast.Name):
                    seen.setdefault(sub.id, []).append(ast.Constant(value=None))
    return {name: values[0] for name, values in seen.items() if len(values) == 1}


def _text(node: ast.expr, env: dict[str, ast.expr], depth: int = 0) -> str | None:
    """The literal text of a pattern expression, an unknown part as a hole
    that is not `$`; None when no part is a known string."""
    if depth > 8:
        return None
    if isinstance(node, ast.Constant):
        return node.value if isinstance(node.value, str) else None
    if isinstance(node, ast.JoinedStr):
        return "".join(
            _text(v, env, depth + 1) or _HOLE if isinstance(v, ast.Constant) else _HOLE for v in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _text(node.left, env, depth + 1), _text(node.right, env, depth + 1)
        if left is None and right is None:
            return None
        return (left or _HOLE) + (right or _HOLE)
    if isinstance(node, ast.Name) and node.id in env:
        return _text(env[node.id], env, depth + 1)
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "join"
            and isinstance(node.func.value, ast.Constant) and isinstance(node.func.value.value, str)
            and len(node.args) == 1 and isinstance(node.args[0], (ast.List, ast.Tuple))):
        parts = [_text(e, env, depth + 1) or _HOLE for e in node.args[0].elts]
        return node.func.value.value.join(parts)
    return None


def _re_names(tree: ast.AST) -> tuple[set[str], dict[str, str]]:
    """(local names of the `re` module, local name -> `re` function for
    `from re import ...`), through aliases."""
    modules: set[str] = set()
    functions: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules |= {a.asname or a.name for a in node.names if a.name == "re"}
        elif isinstance(node, ast.ImportFrom) and node.module == "re":
            functions |= {a.asname or a.name: a.name for a in node.names if a.name in SINK_FLAGS}
    return modules, functions


def _sink(call: ast.Call, modules: set[str], functions: dict[str, str]) -> str | None:
    func = call.func
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) \
            and func.value.id in modules and func.attr in SINK_FLAGS:
        return func.attr
    if isinstance(func, ast.Name) and func.id in functions:
        return functions[func.id]
    return None


def _flags(call: ast.Call, index: int) -> ast.expr | None:
    for kw in call.keywords:
        if kw.arg == "flags":
            return kw.value
    return call.args[index] if len(call.args) > index else None


def check_tree(path: str, tree: ast.AST) -> list[Violation]:
    env = _assigned_once(tree)
    modules, functions = _re_names(tree)
    out: list[Violation] = []

    def report(node: ast.AST, pattern: str, flags: ast.expr | None) -> None:
        if not has_bare_dollar(pattern) or declares_multiline(pattern):
            return
        if flags is not None and _flags_multiline(flags):
            return
        out.append(Violation(path, getattr(node, "lineno", 1), "regex-dollar",
                             f"bare `$` in a regex: use \\Z or fullmatch ({pattern.replace(_HOLE, '...')!r})"))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _sink(node, modules, functions)
            if name is not None and node.args:
                pattern = _text(node.args[0], env)
                if pattern is not None:
                    report(node, pattern, _flags(node, SINK_FLAGS[name]))
        elif isinstance(node, ast.ClassDef):
            for stmt in node.body:
                targets = stmt.targets if isinstance(stmt, ast.Assign) else \
                    [stmt.target] if isinstance(stmt, ast.AnnAssign) else []
                value = getattr(stmt, "value", None)
                if value is not None and any(isinstance(t, ast.Name) and t.id == "regex" for t in targets):
                    pattern = _text(value, env)
                    if pattern is not None:
                        report(stmt, pattern, None)
    return sorted(out, key=lambda v: v.line)


def check_text(path: str, text: str) -> list[Violation]:
    """Every regex-dollar violation in a Python file; other files and a file
    that does not parse (brandlint reports that) give none."""
    if not path.endswith(".py") and "python" not in text[:80].split("\n", 1)[0]:
        return []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    return check_tree(path, tree)
