# pattern: Functional Core
"""Find the comments that rot.

A comment that explains the code beside it holds up; one that points
elsewhere by bean id, by position or by a document's nickname goes stale
without anyone noticing. Three rules, applied to comment text only (and to
every line of an architecture doc, which is all prose):

- bean-id: history lives in git, the beans and docs/troubleshooting.md.
- line-number: a position moves on every edit above it; name the symbol.
- orphan-pointer: a spec or plan named by section number or nickname
  cannot be followed; the pointer is a `docs/` path or a `.md` filename,
  which also exempts the line.

A fourth rule, line-length, applies to every line of a scanned source
file (not markdown, whose tables cannot wrap): a comment line -- one where
only a comment marker precedes the text, or the inside of a block comment
or docstring -- is at most COMMENT_WIDTH columns, any other line at most
CODE_WIDTH. A line carrying `noqa: E501` is exempt; ruff's E501 shares
the override on the Python side.

Stdlib only and runnable under the system `python3`: the hook must not
depend on a synced venv."""
from __future__ import annotations

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import PurePosixPath

CODE_ROOTS = ("web/src", "web/e2e", "web/tooling", "server/src", "server/tests", "server/tooling",
              "perf", "proptest")
DOC_ROOTS = ("docs/architecture",)
CODE_EXTENSIONS = frozenset({".py", ".ts", ".tsx", ".mjs", ".js", ".css", ".sh"})
# Generated files are fixed at their source; perf baseline reports are records
# of a measurement and are named after the bean that asked for it.
EXCLUDED_SUFFIXES = (".gen.ts", ".d.ts")
EXCLUDED_DIRS = ("web/tooling/perf/baselines/",)
COMMENT_WIDTH = 80
CODE_WIDTH = 120
NOQA = "noqa: E501"

RULES = {
    "bean-id": "bean ids: state the rule the comment enforces; the history is in git, the bean and "
               "docs/troubleshooting.md",
    "line-number": "line numbers: they move on every edit above them; name the function, selector or "
                   "constant instead",
    "orphan-pointer": "spec/plan pointers: name the document by path (docs/...) so the reference can be "
                      "followed, or drop it",
    "line-length": f"line length: a comment line is at most {COMMENT_WIDTH} columns and any other line "
                   f"{CODE_WIDTH}; a line that cannot wrap (a URL, exact copy) carries `{NOQA}`",
}

# Bean ids are `pkm-` plus four lowercase alphanumerics. A further hyphen,
# underscore or path separator makes it a file or directory name instead.
_BEAN_ID = re.compile(r"\bpkm-[a-z0-9]{4}\b(?![-/_])")
_NOT_BEAN_IDS = frozenset({"pkm-perf", "pkm-data"})
_LINE_NUMBER = re.compile(
    r"\bline ~?\d+\b"
    r"|\blines ~?\d+\s*[-–—]\s*\d+\b"
    r"|[\w./-]+\.(?:py|ts|tsx|mjs|js|css|md|sh):\d+\b",
    re.IGNORECASE)
_ORPHAN_POINTER = re.compile(
    r"\bspec(?:ification)?s?\s+sections?\b"
    r"|\bspec\s*§"
    r"|\bplan[- ]\d+(?:/\d+)?\b"
    r"|\bper the (?:spec|plan)\b"
    r"|\bsee (?:the )?(?:spec|plan)\b"
    r"|\bdesign docs?\b",
    re.IGNORECASE)
_PATH_POINTER = re.compile(r"\bdocs/|\b[\w-]+\.md\b")

_HASH_COMMENT = re.compile(r"(?:^|(?<=\s))#(.*)")
_TRIPLE_QUOTE = re.compile(r'"""|\'\'\'')
# What may precede a comment's text on a line that is only a comment.
_MARKERS = frozenset({"", "#", "//", "/*", "/**", "*", '"""', "'''", "///"})


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    rule: str
    text: str


def is_scanned(path: str) -> bool:
    """Whether the lint reads this repo-relative path at all."""
    if path.endswith(EXCLUDED_SUFFIXES) or any(path.startswith(d) for d in EXCLUDED_DIRS):
        return False
    suffix = PurePosixPath(path).suffix
    if _under(path, DOC_ROOTS):
        return suffix == ".md"
    return _under(path, CODE_ROOTS) and suffix in CODE_EXTENSIONS


def _under(path: str, roots: Iterable[str]) -> bool:
    return any(path == root or path.startswith(root + "/") for root in roots)


def comment_spans(text: str, suffix: str) -> Iterator[tuple[int, str]]:
    """(line number, comment text) for every non-blank comment in `text`,
    where comments are what the language of `suffix` makes them."""
    return ((n, piece) for n, _, piece in _spans(text, suffix))


def comment_lines(text: str, suffix: str) -> set[int]:
    """The lines that are only a comment: a marker and the text, or the inside
    of a block comment or docstring. Code with a trailing comment is not one."""
    lines = text.splitlines()
    return {n for n, col, _ in _spans(text, suffix) if lines[n - 1][:col].strip() in _MARKERS}


def _spans(text: str, suffix: str) -> Iterator[tuple[int, int, str]]:
    """(line number, column the comment text starts at, comment text)."""
    lines = text.splitlines()
    if suffix == ".md":
        raw: Iterator[tuple[int, int, str]] = ((n, 0, line) for n, line in enumerate(lines, 1))
    elif suffix == ".py":
        raw = _python_comments(lines)
    elif suffix == ".sh":
        raw = ((n, m.start(1), m.group(1)) for n, line in enumerate(lines, 1) if (m := _HASH_COMMENT.search(line)))
    else:
        raw = _slash_comments(lines)
    return ((n, col, piece) for n, col, piece in raw if piece.strip())


def _python_comments(lines: list[str]) -> Iterator[tuple[int, int, str]]:
    """`#` comments and docstrings: docstrings are prose, and the pointers that
    rot live there as readily as in comments. A triple-quoted string that does
    not open its line (`DDL = \"\"\"`) is data, not prose, and is skipped."""
    in_string = False
    prose = False
    for n, line in enumerate(lines, 1):
        pos = 0
        while True:
            if in_string:
                close = _TRIPLE_QUOTE.search(line, pos)
                end = close.start() if close else len(line)
                if prose:
                    yield n, pos, line[pos:end]
                if not close:
                    break
                in_string, pos = False, close.end()
            else:
                opener = _TRIPLE_QUOTE.search(line, pos)
                comment = _HASH_COMMENT.search(line, pos)
                if comment and (not opener or comment.start() < opener.start()):
                    yield n, comment.start(1), comment.group(1)
                    break
                if not opener:
                    break
                in_string, pos = True, opener.end()
                prose = line[:opener.start()].strip() == ""


def _slash_comments(lines: list[str]) -> Iterator[tuple[int, int, str]]:
    """`//` to end of line and `/* */` blocks, for TypeScript, JavaScript
    and CSS alike. String literals are skipped, so `"/page/*"` opens no block
    and `"https://"` no line comment; a template literal may span lines, a
    quoted string ends with its line."""
    in_block = False
    quote: str | None = None
    for n, line in enumerate(lines, 1):
        i = 0
        if quote in ("'", '"'):
            quote = None
        while i < len(line):
            if in_block:
                close = line.find("*/", i)
                end = len(line) if close < 0 else close
                yield n, i, line[i:end]
                if close < 0:
                    break
                in_block, i = False, close + 2
            elif quote:
                if line[i] == "\\":
                    i += 2
                    continue
                if line[i] == quote:
                    quote = None
                i += 1
            else:
                two = line[i:i + 2]
                if two == "//":
                    yield n, i + 2, line[i + 2:]
                    break
                if two == "/*":
                    in_block, i = True, i + 2
                    continue
                if line[i] in ("'", '"', "`"):
                    quote = line[i]
                i += 1


def check_text(path: str, text: str) -> list[Violation]:
    """Every rule each comment of `path` breaks, in file order."""
    if not is_scanned(path):
        return []
    suffix = PurePosixPath(path).suffix
    lines = text.splitlines()
    out: list[Violation] = []
    prose = comment_lines(text, suffix) if suffix != ".md" else set()
    comments: dict[int, list[str]] = {}
    for n, _, piece in _spans(text, suffix):
        comments.setdefault(n, []).append(piece)
    for n, line in enumerate(lines, 1):
        for comment in comments.get(n, ()):
            for rule in _rules_broken(comment):
                out.append(Violation(path, n, rule, comment.strip()))
        if suffix != ".md" and NOQA not in line and len(line) > (COMMENT_WIDTH if n in prose else CODE_WIDTH):
            out.append(Violation(path, n, "line-length", line.strip()))
    return out


def _rules_broken(comment: str) -> list[str]:
    broken = []
    if any(m.group(0) not in _NOT_BEAN_IDS for m in _BEAN_ID.finditer(comment)):
        broken.append("bean-id")
    if _LINE_NUMBER.search(comment):
        broken.append("line-number")
    if _ORPHAN_POINTER.search(comment) and not _PATH_POINTER.search(comment):
        broken.append("orphan-pointer")
    return broken


def format_report(violations: list[Violation], extra_rules: dict[str, str] | None = None) -> str:
    """One line per site, then the remedy for each rule hit; empty when clean.
    `extra_rules` are the remedies of other rule families sharing the report."""
    if not violations:
        return ""
    rules = {**RULES, **(extra_rules or {})}
    sites = [f"{v.path}:{v.line}: {v.rule}: {v.text}" for v in violations]
    remedies = [f"  {rules[rule]}" for rule in rules if any(v.rule == rule for v in violations)]
    return "\n".join([
        "pre-commit: comments must not carry what rots" + (
            ", and names must carry their brand." if any(v.rule in (extra_rules or {}) for v in violations)
            else "."),
        *sites,
        "",
        *remedies,
        "",
        "Fix the sites above and commit again. To bypass in a genuine emergency: git commit --no-verify",
    ]) + "\n"
