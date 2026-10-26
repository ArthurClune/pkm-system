"""The committed contracts/tag_chars.py and web/src/grammar/tagChars.gen.ts
must hold one tag-name class, or the server and the replica read different
tags out of the same block. Regenerate with `uv run python -m
pkm.tag_chars_dump` (and `--table` for the Python module)."""
import re
import unicodedata
from pathlib import Path

import pytest

from pkm.contracts import tag_chars
from pkm.contracts.tag_chars import TAG_CHARS_UNICODE_VERSION, TAG_WORD_RANGES
from pkm.tag_chars_dump import main, python_module, ts_module, word_ranges

TS_ARTIFACT = (Path(__file__).resolve().parents[2]
               / "web" / "src" / "grammar" / "tagChars.gen.ts")
PY_ARTIFACT = Path(tag_chars.__file__)


def test_committed_ts_artifact_matches_the_table():
    assert TS_ARTIFACT.exists(), f"missing artifact: {TS_ARTIFACT}"
    assert TS_ARTIFACT.read_text() == ts_module(TAG_WORD_RANGES)


def test_committed_table_matches_this_interpreters_word_class():
    if unicodedata.unidata_version != TAG_CHARS_UNICODE_VERSION:
        pytest.skip(
            f"the table is Unicode {TAG_CHARS_UNICODE_VERSION}; this "
            f"interpreter has {unicodedata.unidata_version}, so its \\w "
            "is not the one the table froze")
    assert PY_ARTIFACT.read_text() == python_module(
        word_ranges(), TAG_CHARS_UNICODE_VERSION)


def test_ts_module_is_ascii_and_its_escapes_round_trip():
    out = ts_module(TAG_WORD_RANGES)
    assert out.isascii()
    literal = re.search(r'TAG_WORD_CLASS = "([^"]*)";', out)
    assert literal is not None
    bound = r"\\\\u\{([0-9a-f]+)\}"
    pairs = re.findall(rf"{bound}(?:-{bound})?", literal.group(1))
    rebuilt = "".join(
        f"\\\\u{{{lo}}}" + (f"-\\\\u{{{hi}}}" if hi else "") for lo, hi in pairs)
    assert rebuilt == literal.group(1)
    assert [(int(lo, 16), int(hi or lo, 16)) for lo, hi in pairs] \
        == list(TAG_WORD_RANGES)


def test_ranges_are_ascending_disjoint_and_surrogate_free():
    assert TAG_WORD_RANGES
    for lo, hi in TAG_WORD_RANGES:
        assert lo <= hi
        assert hi < 0xD800 or lo > 0xDFFF
    for (_, hi), (lo, _) in zip(TAG_WORD_RANGES, TAG_WORD_RANGES[1:]):
        assert hi + 1 < lo  # adjacent ranges would have been merged


def _in_table(cp: int) -> bool:
    return any(lo <= cp <= hi for lo, hi in TAG_WORD_RANGES)


@pytest.mark.parametrize("ch", ["_", "é", "日"])
def test_table_holds_word_characters(ch):
    assert _in_table(ord(ch))


def test_table_leaves_out_a_letter_newer_than_it():
    assert not _in_table(0xA7CB)


def test_main_prints_the_ts_module(capsys):
    assert main([]) == 0
    assert capsys.readouterr().out == ts_module(TAG_WORD_RANGES)


def test_main_table_prints_the_python_module(capsys):
    assert main(["--table"]) == 0
    assert capsys.readouterr().out == python_module(
        word_ranges(), unicodedata.unidata_version)
