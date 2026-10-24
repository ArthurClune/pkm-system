"""The committed web/src/grammar/titleWhitespace.gen.ts must hold exactly
contracts/titles.py TITLE_WHITESPACE, or the replica folds a title by
another list than the server and names another page. Regenerate with
`uv run python -m pkm.title_whitespace_dump` into that file."""
import re
from pathlib import Path

from pkm.contracts.titles import TITLE_WHITESPACE
from pkm.title_whitespace_dump import main, ts_module

ARTIFACT = (Path(__file__).resolve().parents[2]
            / "web" / "src" / "grammar" / "titleWhitespace.gen.ts")


def test_committed_title_whitespace_artifact_matches_the_list():
    assert ARTIFACT.exists(), f"missing artifact: {ARTIFACT}"
    assert ARTIFACT.read_text() == ts_module(TITLE_WHITESPACE)


def test_ts_module_writes_each_character_as_one_escape():
    chars = "\t \u00a0\u3000"
    out = ts_module(chars)
    assert out.isascii()
    literal = re.search(r'TITLE_WHITESPACE = "([^"]*)";', out)
    assert literal is not None
    escapes = re.findall(r"\\u([0-9a-f]{4})", literal.group(1))
    assert "".join(f"\\u{e}" for e in escapes) == literal.group(1)
    assert "".join(chr(int(e, 16)) for e in escapes) == chars


def test_main_prints_the_module(capsys):
    assert main() == 0
    assert capsys.readouterr().out == ts_module(TITLE_WHITESPACE)
