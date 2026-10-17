# pattern: Functional Core
"""Rule 1: a parameter or field whose name means a brand carries it.

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
import tokenize
from pathlib import PurePosixPath

from brandlint.registry import Registry
from commentlint.core import Violation

SCOPE_ROOT = "server/src/"

RULES = {
    "brand-name": "a name that means a brand must carry it: read the value from a `select()` row, take it "
                  "from a contract model, or parse it with the brand's parser; untrusted route input may "
                  "carry `# brand: untrusted -- <reason>`",
    "brand-opt-out": "`# brand: untrusted -- <reason>` is allowed only in route modules (routes_*.py) and "
                     "must give a reason",
}

# Matched at the start of a comment token.
_OPT_OUT = re.compile(r"#\s*brand:\s*untrusted\b(?P<rest>.*)$")
_REASON = re.compile(r"^\s*--\s*\S")
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def in_scope(path: str, registry: Registry) -> bool:
    """Product Python under server/src; test-data builders count as tests."""
    if not path.startswith(SCOPE_ROOT) or PurePosixPath(path).suffix != ".py":
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


def _annotation_words(node: ast.expr) -> set[str]:
    """Every name an annotation mentions, looking inside string annotations."""
    words: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name):
            words.add(sub.id)
        elif isinstance(sub, ast.Attribute):
            words.add(sub.attr)
        elif isinstance(sub, ast.Constant) and isinstance(sub.value, str):
            words.update(_WORD.findall(sub.value))
    return words


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


def check_text(path: str, text: str, registry: Registry) -> list[Violation]:
    """Every rule-1 violation in `text`, in file order."""
    if not in_scope(path, registry):
        return []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
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
        brands = registry.names.get(name)
        if brands is None or _annotation_words(annotation) & set(brands):
            continue
        if any(n in opted for n in range(first, last + 1)):
            continue
        shown = " or ".join(brands)
        out.append(Violation(path, first, "brand-name", f"`{name}` must be {shown}: {lines[first - 1].strip()}"))
    return sorted(out, key=lambda v: v.line)
