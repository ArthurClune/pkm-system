# pattern: Imperative Shell
"""Dump the text-limit parity fixture for the web's judge:
uv run python -m pkm.text_limits_parity_dump \\
    > ../shared/fixtures/text_limits_parity.json
The web refuses an edit over a limit before it queues an op, so its judge
(grammar/textLimits.ts) and nesting measure must say what text_limits.py
and refs.link_nesting_depth say. Guarded by
tests/test_text_limits_parity_fixture.py.

A hand case's text is the concatenation of `unit * count` over its parts,
so a case a million code points long costs a few bytes. The output is
ASCII JSON: a lone surrogate case cannot be written as UTF-8."""
from __future__ import annotations

import json
import random
import re
from collections.abc import Callable, Iterable
from typing import TypedDict

from pkm.contracts.ops import MAX_BLOCK_TEXT_CHARS, MAX_LINK_NESTING
from pkm.refs import (
    bracket_spans,
    iter_bracket_spans,
    link_nesting_depth,
    strip_code,
)
from pkm.text_limits import describe_text_limit, text_limit_violation


class HandCase(TypedDict):
    name: str
    parts: list[tuple[str, int]]


def _nest(depth: int, opener: str = "[[a//") -> list[tuple[str, int]]:
    return [(opener, depth), ("x", 1), ("]]", depth)]


CASES: list[HandCase] = [
    {"name": "empty", "parts": []},
    {"name": "length_at_the_cap", "parts": [("x", 1_000_000)]},
    {"name": "length_over_the_cap", "parts": [("x", 1_000_001)]},
    # An emoji is two UTF-16 units: the cap counts code points.
    {"name": "astral_at_the_cap", "parts": [("\U0001f600", 1_000_000)]},
    {"name": "astral_over_the_cap", "parts": [("\U0001f600", 1_000_001)]},
    # A lone surrogate is one code point on both sides.
    {"name": "lone_surrogate_at_the_cap",
     "parts": [("\ud800", 1), ("x", 999_999)]},
    {"name": "nest_at_the_limit", "parts": _nest(32)},
    {"name": "nest_over_the_limit", "parts": _nest(33)},
    {"name": "peeled_nest_over_the_limit", "parts": _nest(33, "[[")},
    {"name": "tag_nest_over_the_limit", "parts": _nest(33, "#[[a//")},
    {"name": "multi_line_nest_over_the_limit",
     "parts": [("[[a\n", 33), ("x", 1), ("]]\n", 33)]},
    {"name": "length_judged_before_nesting",
     "parts": [*_nest(40), ("x", 1_000_000)]},
    {"name": "unclosed_openers", "parts": [("[[", 100)]},
    {"name": "inline_code_hides_a_nest",
     "parts": [("`", 1), *_nest(40, "[["), ("`", 1)]},
    {"name": "closed_fence_hides_a_nest",
     "parts": [("```\n", 1), *_nest(40), ("\n```", 1)]},
    {"name": "unclosed_fence_hides_nothing",
     "parts": [("```\n", 1), *_nest(40)]},
    {"name": "backtick_titles_are_no_runs",
     "parts": [("[[a`", 40), ("x", 1), ("]]", 40)]},
    {"name": "stray_closers", "parts": [("]]", 100), ("[[a]]", 1)]},
    {"name": "side_by_side", "parts": [("[[x]] ", 500)]},
    # The character after ``` decides opener or closer; only an ASCII word
    # character makes an opener, whatever either side's Unicode table says.
    {"name": "ascii_letter_after_fence_opens_one",
     "parts": [("```\n", 1), *_nest(40), ("```x", 1)]},
    {"name": "latin_letter_after_closer_hides_a_nest",
     "parts": [("```\n", 1), *_nest(40), ("```\u00e9", 1)]},
    {"name": "latin_letter_after_closer_exposes_a_nest",
     "parts": [("```\nx```\u00e9", 1), *_nest(40), ("```", 1)]},
    {"name": "astral_letter_after_closer_hides_a_nest",
     "parts": [("```\n", 1), *_nest(40), ("```\U0001d400", 1)]},
    {"name": "astral_letter_after_closer_exposes_a_nest",
     "parts": [("```\nx```\U0001d400", 1), *_nest(40), ("```", 1)]},
    # U+A7CB is a letter from Unicode 16, which Python 3.12's table lacks.
    {"name": "unicode_16_letter_after_closer_hides_a_nest",
     "parts": [("```\n", 1), *_nest(40), ("```\ua7cb", 1)]},
    {"name": "unicode_16_letter_after_closer_exposes_a_nest",
     "parts": [("```\nx```\ua7cb", 1), *_nest(40), ("```", 1)]},
]


def _text(parts: Iterable[tuple[str, int]]) -> str:
    return "".join(unit * count for unit, count in parts)


GENERATED_SEED = 20261024
GENERATED_COUNT = 400

# The token alphabet of test_text_limits' properties, with the run tokens
# repeated so draws nest. The non-ASCII tokens reach the one place the two
# sides could disagree: whether the character after ``` closes a fence.
_PIECES = ["[[", "[[", "[[", "]]", "]]", "]]", "[", "]", "`", "```", "\n",
           "#", "a", "a//", " ", "```\U0001d400", "```\ua7cb", "```\u00e9",
           "\U0001f600", "\ud800"]


def generated_cases(
    seed: int = GENERATED_SEED, count: int = GENERATED_COUNT
) -> list[str]:
    """`count` seeded bracket-soup texts, de-duplicated and stable across
    runs and Python versions (random.Random is specified)."""
    rng = random.Random(seed)

    def soup(most: int) -> str:
        return "".join(rng.choice(_PIECES) for _ in range(rng.randint(0, most)))

    out: list[str] = []
    seen: set[str] = set()
    while len(out) < count:
        # A backtick anywhere in a run's title drops the run, so a long
        # soup seldom nests deep by chance: a chain of runs around a short
        # soup, between two more, reaches depth without hiding the rest.
        depth = rng.choice([0, 0, 1, 2, 3, 5])
        opener = rng.choice(["[[", "#[[", "[[a//"])
        text = (soup(20) + opener * depth + soup(4) + "]]" * depth
                + soup(20))
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def _runs(text: str, source: str) -> int:
    return sum(1 for _ in iter_bracket_spans(bracket_spans(text, source)))


# Each shape is judged on the text alone, not on the generator's choices,
# so the tally says what the corpus actually contains.
SHAPES: dict[str, Callable[[str], bool]] = {
    "deep": lambda t: link_nesting_depth(t) >= 3,
    "code hides brackets": lambda t: strip_code(t).count("[[") < t.count("[["),
    # The same pairing with every backtick erased from the source finds a
    # run the real text drops.
    "backtick-held run": lambda t: _runs(
        strip_code(t), t.replace("`", " ")) > _runs(strip_code(t), t),
    "unclosed opener": lambda t: strip_code(t).count("[[")
    > strip_code(t).count("]]"),
    "stray closer": lambda t: strip_code(t).count("]]")
    > strip_code(t).count("[["),
    "triple bracket": lambda t: "[[[" in t or "]]]" in t,
    "fence closer followed by non-ASCII": lambda t: bool(
        re.search(r"```[^\x00-\x7f]", t)),
}


def shape_tally(texts: Iterable[str]) -> dict[str, int]:
    """How many of `texts` show each shape."""
    texts = list(texts)
    return {name: sum(1 for t in texts if pred(t))
            for name, pred in SHAPES.items()}


def _verdict(text: str) -> dict[str, object] | None:
    violation = text_limit_violation(text)
    if violation is None:
        return None
    return {"kind": violation.kind, "measured": violation.measured,
            "limit": violation.limit,
            "describe": describe_text_limit(violation)}


def fixture() -> dict[str, object]:
    cases = []
    for case in CASES:
        parts = case["parts"]
        text = _text(parts)
        cases.append({
            "name": case["name"],
            "parts": [[unit, count] for unit, count in parts],
            "code_points": len(text),
            "nesting_depth": link_nesting_depth(text),
            "violation": _verdict(text),
        })
    return {
        "max_block_text_chars": MAX_BLOCK_TEXT_CHARS,
        "max_link_nesting": MAX_LINK_NESTING,
        "cases": cases,
        "generated": [{"text": text, "nesting_depth": link_nesting_depth(text)}
                      for text in generated_cases()],
    }


def main() -> int:
    print(json.dumps(fixture(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
