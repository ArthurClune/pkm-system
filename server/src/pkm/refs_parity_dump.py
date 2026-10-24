# pattern: Imperative Shell
"""Dump ref-extraction parity fixtures for the TS port
(offline-editing-design.md §3):
uv run python -m pkm.refs_parity_dump > ../shared/fixtures/refs_parity.json
The web replica extracts refs locally for offline edits; these cases pin
refs.py's exact semantics so the TS port cannot drift. Guarded by
tests/test_refs_parity_fixture.py."""
from __future__ import annotations

import json
import random
import re
from collections.abc import Iterable

from pkm.refs import extract

CASES = [
    "plain text without any references",
    "a [[Simple Link]] in a sentence",
    "two [[Alpha]] and [[Beta]] links",
    "duplicate [[Alpha]] and [[Alpha]] dedupes",
    "nested [[Outer [[Inner]] Link]] yields outer then inner",
    "#tag and #another-tag",
    "#[[Bracketed Tag]] is a tag",
    "#tag/with/slash and #dotted.tag and #dash-tag",
    "mid#word is not a tag",
    "(#parenthesised) tag",
    "Attribute:: value with [[Link]]",
    "  Indented Attribute:: still an attribute",
    "not an attribute because :: comes after [[brackets]]:: here",
    "Tags:: #AI #ML",
    "inline `code with [[NotALink]]` stays code",
    "```\nfenced [[NotALink]] #not-a-tag\n```",
    "before ```fence [[X]]``` after [[Real Link]]",
    # An inner fence's opener (info string) must not close the
    # outer fence — the exposed css body used to mint #ffcdd2 as a tag.
    "```markdown\nouter\n```css\n.err { color: #ffcdd2; }\n```\nafter #RealTag",
    "```mermaid\ngraph TD\n  style A fill:#0277bd\n```\n#Diagrams",
    "a block ref ((abcdef123)) is not a page ref",
    "short ((abc)) is not a block ref",
    "{{embed: ((abcdef123))}}",
    "{{[[embed]]: ((abcdef123))}}",
    "unclosed [[bracket stays plain",
    "[[Unicode Tîtle ✨]] survives",
    "trailing hash # alone",
    "a [[Link]] with #tag and Attr:: no — attr only at line start",
    "empty [[]] link",
    "#[[Nested [[Inside]] Tag]]",
    # A title the whitespace fold changes is unreachable through the
    # API, so extraction folds it; one that folds to empty is not a
    # reference at all.
    "a [[Multi\nLine Title]] link",
    "#[[Multi\nLine Tag]]",
    "[[Padded  Title]] folds its double space",
    "[[\n]] references nothing",
    "skip [[   ]] but keep [[ Valid ]]",
    # Block-ref tokens are bounded at 32 to match UID_RE: a 32-char token is
    # a block ref, a 33-char one can never have been minted and stays text.
    "ref ((" + "a" * 32 + ")) here",
    "ref ((" + "a" * 33 + ")) here",
]


GENERATED_SEED = 20260421
GENERATED_COUNT = 400

_UID = "abcdef123"
_NFD = "Cafe\u0301"
# Bracket soup: every piece is a hostile fragment, and a case glues 2-9 of
# them together, so nested, unclosed and overlapping runs fall out of the
# draw rather than being listed by hand.
_PIECES = [
    "[[", "[[", "[[", "]]", "]]", "]]", "[", "]", "[[[", "]]]", "[[[[", "]]]]",
    "#", "#", "#[[", "#tag", "#a/b.c-d", "((" + _UID + "))", "((", "))",
    "((^" + _UID + "))", "`", "`", "```", "```css\n", "\n", "\n", "\n",
    " ", " ", "  ", "Title", "Title", "Alpha", "Beta", "Attr::", "Tags::",
    "::", "{{embed: ", "}}", "{{[[embed]]: ", _NFD, "\u00e9", "\u2728",
    "`code [[X]] #t`", "```\n[[X]] #t\n```", "\nAttr:: ", "\n  Key:: ",
    "[[ Padded ]]", "[[ ]]", "[[ \n ]]", "\U0001f600", "\u200d", "((" + "b" * 32 + "))", "((" + "b" * 33 + "))",
]


def generated_cases(
    seed: int = GENERATED_SEED, count: int = GENERATED_COUNT
) -> list[str]:
    """`count` seeded bracket-soup block texts, de-duplicated and stable
    across runs and Python versions (random.Random is specified)."""
    rng = random.Random(seed)
    out: list[str] = []
    seen = set(CASES)
    while len(out) < count:
        text = "".join(rng.choice(_PIECES) for _ in range(rng.randint(2, 9)))
        if text not in seen:
            seen.add(text)
            out.append(text)
    return out


def _max_depth(text: str) -> int:
    depth = best = i = 0
    while i < len(text) - 1:
        pair = text[i : i + 2]
        if pair == "[[":
            depth += 1
            best = max(best, depth)
            i += 2
        elif pair == "]]" and depth:
            depth -= 1
            i += 2
        else:
            i += 1
    return best


# Each shape is judged on the text alone, not on the generator's choices,
# so the tally says what the corpus actually contains.
SHAPES = {
    "nested_brackets": lambda t: _max_depth(t) >= 2,
    "unclosed_open": lambda t: t.count("[[") > t.count("]]"),
    "stray_close": lambda t: t.count("]]") > t.count("[["),
    "overlapping_run": lambda t: "[[[" in t or "]]]" in t,
    "block_ref": lambda t: bool(extract(t).block_refs),
    "block_ref_caret": lambda t: "((^" in t,
    "bare_tag": lambda t: any(r.kind == "tag" for r in extract(t).refs)
    and "#[[" not in t,
    "bracket_tag": lambda t: bool(re.search(r"#\[\[[^\]]*\]\]", t)),
    "inline_code": lambda t: bool(re.search(r"`[^`\n]*\[\[[^`\n]*`", t)),
    "fenced_code": lambda t: t.count("```") >= 2,
    "attr_first_line": lambda t: any(
        r.kind == "attribute" for r in extract(t).refs),
    "attr_after_newline": lambda t: bool(re.search(r"\n\s*\w+::", t)),
    "padded_title": lambda t: bool(re.search(r"\[\[ +[^\[\] ]", t)),
    "blank_title": lambda t: bool(re.search(r"\[\[\s*\]\]", t)),
    "nfd": lambda t: "\u0301" in t,
    "emoji": lambda t: any(ord(c) > 0xFFFF for c in t),
}


def shape_tally(texts: Iterable[str]) -> dict[str, int]:
    """How many of `texts` show each interesting shape."""
    texts = list(texts)
    return {name: sum(1 for t in texts if pred(t))
            for name, pred in SHAPES.items()}


def fixture() -> dict[str, list[dict[str, object]]]:
    return {"cases": [
        {
            "text": text,
            "refs": [{"title": r.title, "kind": r.kind}
                     for r in extract(text).refs],
            "block_refs": list(extract(text).block_refs),
        }
        for text in [*CASES, *generated_cases()]
    ]}


def main() -> int:
    print(json.dumps(fixture(), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
