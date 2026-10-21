import pytest

from regexlint.core import check_text

BAD = [
    'import re\nX = re.compile(r"^a$")\n',
    'import re\nre.match("a$", s)\n',
    'import re\nre.search(r"\\d+$", s)\n',
    'import re\nre.sub(r"a$", "", s)\n',
    'import re\nP = r"^a" r"$"\nX = re.compile(P)\n',
    'import re\nX = re.compile(r"^a" + "$")\n',
    'import re\nX = re.compile("".join(["^a", "$"]))\n',
    'import re\nX = re.compile(rf"^{y}$")\n',
    'import re as r\nX = r.compile("a$")\n',
    'from re import compile as c\nX = c("a$")\n',
    'import re\nX = re.compile("[a]$|b")\n',
    'import re\nX = re.compile("[$]$")\n',
    'import re\nX = re.compile("(?i)a$")\n',
    'import re\nX = re.compile("a$", re.I)\n',
    'class C:\n    regex = "a.*$"\n',
    'import re\nX = re.compile(r"\\\\\\\\$")\n',
]
GOOD = [
    'import re\nX = re.compile(r"^a\\Z")\n',
    'import re\nX = re.compile(r"a")\nX.fullmatch(s)\n',
    'import re\nX = re.compile(r"a\\$")\n',
    'import re\nX = re.compile(r"[$]a")\n',
    'import re\nX = re.compile(r"[^$]a[]$]")\n',
    'import re\nX = re.compile(r"(?m)a$")\n',
    'import re\nX = re.compile(r"a$", re.M)\n',
    'import re\nX = re.compile(r"a$", re.M | re.I)\n',
    'import re\nX = re.compile(r"a$", flags=re.MULTILINE)\n',
    'import re\nre.findall(r"^a$", s, re.MULTILINE)\n',
    'import re\nX = re.compile("a(?#$)")\n',
    'x = "price $5"\nprint(x.replace("$", ""))\n',
    'from pydantic import Field\nf = Field(pattern=r"^a$")\n',
    'class C:\n    regex = "(?s:.*)"\n',
]


@pytest.mark.parametrize("src", BAD)
def test_a_bare_dollar_is_reported_with_its_remedy(src):
    found = check_text("x.py", src)
    assert [v.rule for v in found] == ["regex-dollar"]
    assert "\\Z or fullmatch" in found[0].text


@pytest.mark.parametrize("src", GOOD)
def test_an_anchored_escaped_or_multiline_pattern_passes(src):
    assert check_text("x.py", src) == []


def test_other_files_and_unparsable_python_are_skipped():
    assert check_text("a.ts", 'const r = /a$/;\n') == []
    assert check_text("x.py", "def (:\n") == []


def test_extensionless_python_script_is_read():
    src = '#!/usr/bin/env python3\nimport re\nre.compile("a$")\n'
    assert len(check_text(".githooks/x", src)) == 1
