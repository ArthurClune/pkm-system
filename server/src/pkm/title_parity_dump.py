# pattern: Imperative Shell
"""Dump the title parity fixture for the web replica:
uv run python -m pkm.title_parity_dump > ../shared/fixtures/title_parity.json
The replica decides a title's identity on its own while offline
(`web/src/replica/titles.ts`, `grammar/scan.ts`), so every verdict the
server reaches from a title's text is pinned here on a seeded corpus of
whitespace- and syntax-heavy titles: the normalized and target-canonical
spellings, the syntax reason, blankness, and the refs read back from the
title written as a link and as an attribute. Guarded by
tests/test_title_parity_fixture.py; replayed by
web/src/replica/titleParity.test.ts."""
from __future__ import annotations

import json
import random
from collections.abc import Iterable

from pkm.contracts.titles import TITLE_WHITESPACE
from pkm.refs import (extract, has_unreachable_segment, is_blank_title,
                      normalize_title, target_canonical_title,
                      title_syntax_reason)

GENERATED_SEED = 20261021
GENERATED_COUNT = 600

# Whitespace the two languages trim differently: Python's str.strip()
# also drops U+001C-U+001F and U+0085, JS's trim() also drops U+FEFF.
PY_ONLY_SPACE = "\x1c\x1d\x1e\x1f\x85"
JS_ONLY_SPACE = "﻿"
CONTROL_SPACE = "\t\n\r\f\v"
UNICODE_SPACE = "\xa0　   "
# The rest of the title fold's list, so the corpus draws every character
# the fold takes, not only the ones the two trims disagree on.
LISTED_SPACE = "".join(c for c in TITLE_WHITESPACE
                       if c not in " " + CONTROL_SPACE + UNICODE_SPACE
                       + PY_ONLY_SPACE)

# Each case glues 1-7 of these together, so padding, control runs,
# separators the two trims disagree on, and the refused syntax all fall out
# of the draw rather than being listed by hand. The padded words keep a
# share of titles whose only whitespace is one edge space, the one shape
# the fold leaves for the plain-space flag to strip.
_PIECES = [
    "Title", "Title", "Alpha", "Beta", "Café", "Café", "✨",
    "\U0001f600", "2026", "a/b", "50%", "?", "&", "+", ".", "-", ":",
    " ", " ", " ", "  ", "   ", " Alpha", "Beta ",
    *CONTROL_SPACE, "\n", "\t",
    *UNICODE_SPACE, *LISTED_SPACE, *PY_ONLY_SPACE, JS_ONLY_SPACE,
    JS_ONLY_SPACE,
    "​", "‍",
    "#", "[[", "]]", "[", "]", "`", "::", "{", "}", "(", ")",
    "/", "/", ".", "..",
]


def generated_cases(
    seed: int = GENERATED_SEED, count: int = GENERATED_COUNT
) -> list[str]:
    """`count` seeded titles, de-duplicated and stable across runs and
    Python versions (random.Random is specified)."""
    rng = random.Random(seed)
    out: list[str] = []
    seen: set[str] = set()
    while len(out) < count:
        text = "".join(rng.choice(_PIECES) for _ in range(rng.randint(1, 7)))
        if text not in seen:
            seen.add(text)
            out.append(text)
    return out


def _boundary(text: str, chars: str) -> bool:
    return bool(text) and (text[0] in chars or text[-1] in chars)


# Judged on the title alone, not on the generator's choices, so the tally
# says what the corpus actually contains.
SHAPES = {
    "control_space": lambda t: any(c in t for c in CONTROL_SPACE),
    "plain_padding": lambda t: _boundary(t, " "),
    "padding_only_canonical_drops": lambda t: (
        target_canonical_title(t) != normalize_title(t)),
    "control_beside_py_only_space": lambda t: (
        any(c in t for c in CONTROL_SPACE)
        and any(c in t for c in PY_ONLY_SPACE)),
    "control_beside_js_only_space": lambda t: (
        any(c in t for c in CONTROL_SPACE) and JS_ONLY_SPACE in t),
    "unicode_space_boundary": lambda t: _boundary(t, UNICODE_SPACE),
    "internal_space_run": lambda t: "  " in t[1:-1],
    "listed_space_inside": lambda t: any(
        c in TITLE_WHITESPACE and c != " " for c in t[1:-1]),
    "py_only_space_boundary": lambda t: _boundary(t, PY_ONLY_SPACE),
    "js_only_space_boundary": lambda t: _boundary(t, JS_ONLY_SPACE),
    "blank": is_blank_title,
    "forbidden": lambda t: title_syntax_reason(t) is not None,
    "allowed": lambda t: title_syntax_reason(t) is None and not is_blank_title(t),
    "trailing_bracket": lambda t: normalize_title(t).endswith("]"),
    "trailing_open_bracket": lambda t: normalize_title(t).endswith("["),
    "backtick": lambda t: "`" in t,
    "astral": lambda t: any(ord(c) > 0xFFFF for c in t),
    "unreachable_segment": has_unreachable_segment,
    "dot_segment_free_dots": lambda t: "." in t and not has_unreachable_segment(t),
}


def shape_tally(titles: Iterable[str]) -> dict[str, int]:
    """How many of `titles` show each interesting shape."""
    titles = list(titles)
    return {name: sum(1 for t in titles if pred(t))
            for name, pred in SHAPES.items()}


def _refs(text: str) -> list[dict[str, str]]:
    return [{"title": r.title, "kind": r.kind} for r in extract(text).refs]


def case(text: str) -> dict[str, object]:
    """Every verdict the server reaches from `text` as a title."""
    return {
        "title": text,
        "normalized": normalize_title(text),
        "canonical": target_canonical_title(text),
        "reason": title_syntax_reason(text),
        "blank": is_blank_title(text),
        "link_refs": _refs(f"[[{text}]]"),
        "attribute_refs": _refs(f"{text}:: v"),
    }


def fixture() -> dict[str, list[dict[str, object]]]:
    return {"cases": [case(t) for t in generated_cases()]}


def render() -> str:
    """The fixture as JSON, one case per line, so a diff names the titles
    whose verdicts moved."""
    rows = ",\n".join("  " + json.dumps(c, ensure_ascii=False)
                       for c in fixture()["cases"])
    return '{"cases": [\n' + rows + "\n]}"


def main() -> int:
    print(render())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
