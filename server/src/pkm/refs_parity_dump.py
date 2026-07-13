# pattern: Imperative Shell
"""Dump ref-extraction parity fixtures for the TS port (spec section 3):
uv run python -m pkm.refs_parity_dump > ../shared/fixtures/refs_parity.json
The web replica extracts refs locally for offline edits; these cases pin
refs.py's exact semantics so the TS port cannot drift. Guarded by
tests/test_refs_parity_fixture.py."""
from __future__ import annotations

import json

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
]


def fixture() -> dict:
    return {"cases": [
        {
            "text": text,
            "refs": [{"title": r.title, "kind": r.kind}
                     for r in extract(text).refs],
            "block_refs": list(extract(text).block_refs),
        }
        for text in CASES
    ]}


def main() -> int:
    print(json.dumps(fixture(), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
