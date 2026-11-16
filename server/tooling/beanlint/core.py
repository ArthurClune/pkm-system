# pattern: Functional Core
"""Rule `bean-handover`: a bean never points to a handover note.

Handover notes live in `docs/superpowers/handoffs/`, which is gitignored:
they exist only in the main checkout and are deleted once their work lands,
so a bean that names one ends up pointing at nothing. The pointer is the
directory name; prose about a handover (a bean's own "Handover" section, a
technical handoff) names no file and passes.

Stdlib only and runnable under the system `python3`."""
from __future__ import annotations

import re
from pathlib import PurePosixPath

from commentlint.core import Violation

RULES = {
    "bean-handover": "beans never point to a handover note: handovers are gitignored and deleted once "
                     "their work lands, so put what the bean needs in the bean itself",
}

_POINTER = re.compile(r"\bhandoffs\b")


def is_scanned(path: str) -> bool:
    pure = PurePosixPath(path)
    return pure.parent == PurePosixPath(".beans") and pure.suffix == ".md"


def check_text(path: str, text: str) -> list[Violation]:
    if not is_scanned(path):
        return []
    return [Violation(path, n, "bean-handover", line.strip())
            for n, line in enumerate(text.splitlines(), start=1) if _POINTER.search(line)]
