"""Escaping untrusted text into FTS5 MATCH expressions and LIKE patterns."""
from pathlib import Path

from pkm.server.fts import like_escape

_SRC = Path(__file__).resolve().parents[1] / "src"


def test_like_escape_escapes_the_escape_and_both_wildcards():
    assert like_escape(r"50%_a\b") == r"50\%\_a\\b"
    assert like_escape("plain") == "plain"


def test_like_patterns_are_escaped_in_one_place():
    needle = '.replace("%", "\\\\%")'
    holding = sorted(str(p.relative_to(_SRC)) for p in _SRC.rglob("*.py")
                     if needle in p.read_text(encoding="utf-8"))
    assert holding == ["pkm/server/fts.py"]
