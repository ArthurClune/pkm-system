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

from pkm.assets_core import _remove_spans, asset_label, asset_url, strip_asset_tokens
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
    # A leading `[` is drawn on purpose: left to the pieces it is rare
    # enough that the reach floor below missed it on some seeds.
    lead = draw(st.sampled_from(["", "", "", "["]))
    name = lead + "".join(draw(name_pieces))
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
    # About half the lowest rate each shape reached over 30 unseeded runs: a
    # floor near the typical rate fails on an unlucky draw with nothing wrong.
    floor = {
        "encoded": 0.2, "legacy": 0.15, "markdown": 0.29, "macro": 0.07, "bare": 0.03,
        "image": 0.19, "pdf": 0.055, "space": 0.03, "paren": 0.055, "bracket": 0.07,
        "backslash": 0.015, "percent": 0.03, "nested": 0.018, "leading-bracket": 0.03,
        "unicode": 0.16, "other-token": 0.4,
    }
    cases_run = seen["cases"]
    for shape, share in floor.items():
        assert seen[shape] > cases_run * share, (shape, seen[shape], cases_run)


def test_a_token_of_another_asset_with_the_same_name_survives():
    name = "[draft] a).pdf"
    mine = token("markdown", name, SHA_A, False, False)
    other = token("markdown", name, SHA_B, False, False)
    assert strip_asset_tokens(f"{mine} {other}", SHA_A) == other


# A verbatim copy of strip_asset_tokens and its link helpers as they were
# before the linear rewrite: an oracle for the rewrite, run on small texts
# only, since its scan rescans to the end of the line from every opener.

def _reference_destination_close(text: str, start: int) -> int:
    depth = 0
    i = start
    while i < len(text) and text[i] != "\n":
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            if depth == 0:
                return i
            depth -= 1
        i += 1
    return text.find(")", start)


def _reference_link_span_at(text: str, start: int) -> tuple[int, int, str] | None:
    image = text[start] == "!"
    open_ = start + 1 if image else start
    if (open_ >= len(text) or text[open_] != "["
            or text.startswith("[[", open_)):
        return None
    depth = 1
    cursor = open_ + 1
    while cursor < len(text) and depth > 0:
        if text[cursor] == "\n":
            return None
        if text[cursor] == "[":
            depth += 1
        elif text[cursor] == "]":
            depth -= 1
        cursor += 1
    if depth != 0 or cursor >= len(text) or text[cursor] != "(":
        return None
    close = _reference_destination_close(text, cursor + 1)
    if close == -1 or "\n" in text[cursor + 1:close]:
        return None
    return start, close + 1, text[cursor + 1:close]


def _reference_asset_spans(text: str, prefix: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    cursor = 0
    n = len(text)
    while cursor < n:
        looks_like_link = (
            (text[cursor] == "!" and text[cursor + 1:cursor + 2] == "[")
            or (text[cursor] == "[" and not text.startswith("[[", cursor)))
        span = _reference_link_span_at(text, cursor) if looks_like_link else None
        if span is not None:
            span_start, span_end, destination = span
            if destination.startswith(prefix):
                spans.append((span_start, span_end))
            cursor = span_end
        else:
            cursor += 1
    return spans


def _reference_strip(text: str, sha256: Sha256Hex) -> str:
    prefix = f"/assets/{sha256}/"
    spans = _reference_asset_spans(text, prefix)
    macro = (r"\{\{(?:\[\[pdf\]\]|pdf):\s*" + re.escape(prefix)
             + r"[^\n]*?\}\}")
    spans += [m.span() for m in re.finditer(macro, text)]
    bare_url = re.escape(prefix) + r"[^\s)}]*"
    spans += [m.span() for m in re.finditer(bare_url, text)]
    if not spans:
        return text
    rest = _remove_spans(text, spans)
    return rest if rest.strip() else ""


ORACLE_TOKENS = [
    "[", "]", "(", ")", "!", "{{pdf: ", "{{[[pdf]]: ", "}}", "}", "\n", " ",
    "a", "[[", "]]", f"/assets/{SHA_A}/f.png", f"/assets/{SHA_B}/g.png",
    # Composites, so a link or macro around an asset URL is drawn often
    # enough.
    "](", f"](/assets/{SHA_A}/f.png", f"[a](/assets/{SHA_A}/f.png)",
    f"{{{{pdf: /assets/{SHA_A}/f", f"{{{{[[pdf]]: /assets/{SHA_A}/f",
]


def test_the_linear_strip_equals_the_reference():
    seen = Counter()

    @settings(max_examples=3000, deadline=None, suppress_health_check=list(HealthCheck))
    @given(st.lists(st.sampled_from(ORACLE_TOKENS), max_size=40).map("".join))
    def prop(text):
        expected = _reference_strip(text, SHA_A)
        assert strip_asset_tokens(text, SHA_A) == expected
        prefix = f"/assets/{SHA_A}/"
        seen["cases"] += 1
        seen["stripped"] += expected != text
        seen["markdown"] += bool(_reference_asset_spans(text, prefix))
        seen["macro"] += bool(re.search(
            r"\{\{(?:\[\[pdf\]\]|pdf):\s*" + re.escape(prefix) + r"[^\n]*?\}\}", text))

    prop()
    # Each shape must be drawn often enough that a broken pairing or macro
    # close shows: an oracle that never sees the case passes vacuously.
    # The floors are about half the lowest rate seen over unseeded runs.
    for shape, share in {"stripped": 0.35, "markdown": 0.12, "macro": 0.04}.items():
        assert seen[shape] > seen["cases"] * share, (shape, seen[shape], seen["cases"])
