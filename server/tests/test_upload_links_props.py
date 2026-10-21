"""Properties of strip_asset_tokens over hostile upload names.

Deleting an asset strips every token that names it from block text. The
tokens come in two spellings: the encoded URL the server returns now, for
any name, and the raw-name URL older uploads wrote, which only ever
rendered when its parens and brackets were balanced. The property builds
text from prose and tokens of two assets, removes the first asset's tokens
by construction, and expects exactly the rest: every other character
byte for byte, apart from one space beside each removed token.
"""
import re
from collections import Counter

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from pkm.assets_core import asset_label, asset_url, strip_asset_tokens
from pkm.contracts.ops import Sha256Hex
from pkm.test_data.ids import sha_of

SHA_A = sha_of("a" * 64)
SHA_B = sha_of("b" * 64)

PIECES = [
    "a", "b", "Z", "x y", " ", "  ", ".", "..", "_", "-", "~", "%", "%41", "#",
    "?", "&", "+", "=", "[", "]", "(", ")", "'", '"', "`", "*", "!", "$", "{",
    "}", ":", "::", "<", ">", "|", "@", ";", "\\", "\\)", "((", "))", "[[",
    "]]", "\U0001F4C4", "é", "é", "中文", ".pdf", "[draft]",
    "(Public)", "[[x]]", "](", "](x)", "[a](b)",
]
ILLEGAL = re.compile(r"[/\x00-\x1f\x7f-\x9f]")

name_pieces = st.lists(st.sampled_from(PIECES) | st.text(max_size=3), min_size=1, max_size=6)


@st.composite
def new_names(draw):
    name = "".join(draw(name_pieces))
    name = ILLEGAL.sub("_", name).rstrip(". ").lstrip(".")
    return name or "a"


LEGACY_PIECES = [
    "a", "Z", "9", " ", "x y", "(Public)", "((a))", "(x)", "[draft]", "%", "%41", "&",
    "#", "+", "\\", ":", "'", "é", "é", "\U0001F4C4", "中文", "-",
    "_", "~", ",", ";", "=", "@", "!", "$",
]


@st.composite
def legacy_names(draw):
    parts = draw(st.lists(st.sampled_from(LEGACY_PIECES), max_size=6))
    return "x" + "".join(parts) + draw(st.sampled_from(["", ".pdf", ".PDF", ".png", ".txt"]))


def token(form: str, name: str, sha: Sha256Hex, legacy: bool, image: bool) -> str:
    url = f"/assets/{sha}/{name}" if legacy else asset_url(sha, name)
    if form == "macro":
        return "{{[[pdf]]: " + url + "}}"
    if form == "bare":
        return url
    label = name if legacy else asset_label(name)
    return f"{'!' if image else ''}[{label}]({url})"


def expected_after_removal(text: str, spans: list[tuple[int, int]]) -> str:
    """The text with each span gone and one adjacent space with it (the
    one before, else the one after, and never a space another span took);
    whitespace-only text becomes empty. Everything else is untouched."""
    if not spans:
        return text
    taken: set[int] = set()
    for start, end in spans:
        taken.update(range(start, end))
        if start > 0 and text[start - 1] == " " and start - 1 not in taken:
            taken.add(start - 1)
        elif end < len(text) and text[end] == " ":
            taken.add(end)
    rest = "".join(c for i, c in enumerate(text) if i not in taken)
    return rest if rest.strip() else ""


@st.composite
def cases(draw):
    legacy = draw(st.booleans())
    names = legacy_names() if legacy else new_names()
    pieces = draw(st.lists(st.one_of(
        st.tuples(st.just("prose"), st.from_regex(r"[a-z]{1,5}", fullmatch=True)),
        st.tuples(st.just("own"), st.just("")),
        st.tuples(st.just("other"), st.just("")),
    ), min_size=1, max_size=5))
    text = ""
    spans: list[tuple[int, int]] = []
    shapes = Counter()
    for i, (kind, prose) in enumerate(pieces):
        sep = draw(st.sampled_from([" ", "  ", "\n"])) if i < len(pieces) - 1 else ""
        if kind == "prose":
            text += prose + sep
            continue
        name = draw(names)
        form = draw(st.sampled_from(["markdown", "markdown", "macro", "bare"]))
        if legacy and form == "bare" or kind == "other" and form == "macro":
            form = "markdown"
        image = draw(st.booleans())
        sha = SHA_A if kind == "own" else SHA_B
        t = token(form, name, sha, legacy, image)
        if kind == "own":
            spans.append((len(text), len(text) + len(t)))
        text += t + sep
        if kind == "own":
            shapes["legacy" if legacy else "encoded"] += 1
            shapes[form] += 1
            if image:
                shapes["image"] += 1
            if name.lower().endswith(".pdf"):
                shapes["pdf"] += 1
            for label, probe in (("space", " "), ("paren", "("), ("bracket", "["),
                                 ("backslash", "\\"), ("percent", "%")):
                if probe in name:
                    shapes[label] += 1
            if "((" in name or "))" in name:
                shapes["nested"] += 1
            if name.startswith("["):
                shapes["leading-bracket"] += 1
            if not name.isascii():
                shapes["unicode"] += 1
        else:
            shapes["other-token"] += 1
    return text, expected_after_removal(text, spans), shapes


def test_strip_asset_tokens_removes_exactly_the_asset_tokens():
    seen = Counter()

    @settings(max_examples=1500, deadline=None, suppress_health_check=list(HealthCheck))
    @given(cases())
    def prop(case):
        text, expected, shapes = case
        assert strip_asset_tokens(text, SHA_A) == expected
        seen.update(shapes)
        seen["cases"] += 1

    prop()
    floor = {
        "encoded": 0.3, "legacy": 0.3, "markdown": 0.3, "macro": 0.1, "bare": 0.05,
        "image": 0.2, "pdf": 0.1, "space": 0.05, "paren": 0.15, "bracket": 0.06,
        "backslash": 0.03, "percent": 0.05, "nested": 0.04, "leading-bracket": 0.01,
        "unicode": 0.2, "other-token": 0.5,
    }
    cases_run = seen["cases"]
    for shape, share in floor.items():
        assert seen[shape] > cases_run * share, (shape, seen[shape], cases_run)


def test_a_token_of_another_asset_with_the_same_name_survives():
    name = "[draft] a).pdf"
    mine = token("markdown", name, SHA_A, False, False)
    other = token("markdown", name, SHA_B, False, False)
    assert strip_asset_tokens(f"{mine} {other}", SHA_A) == other
