"""Properties of rename.rewrite_title_refs / rewrite_title_refs_map over
generated block texts.

Two kinds of oracle, neither of which calls rename.py:

* A piece model. Texts are glued from pieces whose rewrite is stated by hand
  (`[[Old]]` -> `[[New]]`, `#Old` -> `#New` or `#[[New]]`, ...), joined by
  separators that cannot fuse two pieces, so the expected text is the join of
  the expected pieces: anything outside a ref, code spans and fences
  included, must come out byte for byte.
* `refs.extract`, the pinned grammar: read the rewritten text back and
  compare it with the original's refs under the title substitution.

Whether a title can be spelled as a given ref form is asked of
`refs.extract` on the probe text, never of the rewriter's own helpers."""
import re

from hostile import count, event, with_floors
from hypothesis import given, settings
from hypothesis import strategies as st

from pkm.refs import (
    extract,
    normalize_title,
    strip_code,
    target_canonical_title,
    title_syntax_reason,
)
from pkm.rename import rewrite_title_refs as _rewrite_raw
from pkm.rename import rewrite_title_refs_map as _rewrite_map_raw
from pkm.rename import spelled_or_canonical
from pkm.test_data.ids import raw_title_of


def rewrite_title_refs(text: str, old: str, new: str) -> str:
    return _rewrite_raw(text, raw_title_of(old), raw_title_of(new))


def rewrite_title_refs_map(text: str, replacements: dict[str, str],
                           **kwargs) -> str:
    return _rewrite_map_raw(
        text, {k: raw_title_of(v) for k, v in replacements.items()}, **kwargs)


# --- titles ---------------------------------------------------------------

_SYNTAX_FRAGMENTS = ["#", "[[", "]]", "[[x]]", "#x"]
_TITLE_FRAGMENTS = [
    "a", "B", "Old", "New", "x y", "1", "_", "é", " ", " ", "/", ".",
    "-", ":", "::", "]", "[", "{", "}", "(", ")", "`", "*", "Re: ", "a::b",
]


def _fix_title(raw: str) -> str:
    """Make a drawn string a title `title_syntax_reason` accepts: no `#`,
    `[[` or `]]`, no backtick, no trailing `]` or `[`, no `.`, `..` or
    empty `/` segment, no whitespace run to fold, no boundary padding, not
    blank."""
    title = raw.replace("#", "").replace("`", "")
    while "[[" in title or "]]" in title:
        title = title.replace("[[", "[ [").replace("]]", "] ]")
    while "  " in title:
        title = title.replace("  ", " ")
    title = title.strip(" ")
    if title:
        title = "/".join(seg if seg not in ("", ".", "..") else "s"
                         for seg in title.split("/"))
    if title.endswith(("]", "[")):
        title += "z"
    return title or "T"


_fragments = st.lists(st.sampled_from(_TITLE_FRAGMENTS), min_size=1,
                      max_size=5).map("".join)
titles = _fragments.map(_fix_title)
# Whatever a person could type: ref syntax included. Only the titles the
# product accepts are rewritten into, so the property filters on the verdict
# of title_syntax_reason, not on a spelling check of its own.
raw_titles = st.lists(
    st.sampled_from(_TITLE_FRAGMENTS + _SYNTAX_FRAGMENTS), min_size=1,
    max_size=5).map("".join)


def _other_than(old: str, new: str) -> str:
    return new if new != old else new + "2"


def _is_link(title_text: str) -> bool:
    return any(r.kind == "link" and r.title == title_text
               for r in extract(f"[[{title_text}]]").refs)


def _is_bracket_tag(title_text: str) -> bool:
    return any(r.kind == "tag" and r.title == title_text
               for r in extract(f"#[[{title_text}]]").refs)


def _is_hashtag(title_text: str) -> bool:
    return any(r.kind == "tag" and r.title == title_text
               for r in extract(f"#{title_text} x").refs)


def _is_attribute(title_text: str) -> bool:
    return any(r.kind == "attribute" and r.title == title_text
               for r in extract(f"{title_text}:: x").refs)


# --- pieces ---------------------------------------------------------------

_OTHERS = ["Other", "Older", "Alpha", "old", "Old Two", "x/y", "Q"]
_SEPARATORS = [" ", " ", "\n", "\n  ", " (", ") ", ", "]


def _plain_pieces(old: str, new: str, other: str) -> list[tuple[str, str]]:
    """(source, expected) for pieces that are not refs to `old`, or that are
    refs the rewrite must leave alone."""
    return [
        ("plain words", "plain words"),
        (f"[[{other}]]", f"[[{other}]]"),
        (f"#[[{other}]]", f"#[[{other}]]"),
        (f"#{other.replace(' ', '')}", f"#{other.replace(' ', '')}"),
        (f"[[ {old} ]]", f"[[ {old} ]]"),
        (f"#[[ {old} ]]", f"#[[ {old} ]]"),
        (f"[[{old} tail]]", f"[[{old} tail]]"),
        (f"[[{old.lower()}x]]", f"[[{old.lower()}x]]"),
        (f"`[[{old}]]`", f"`[[{old}]]`"),
        (f"`#{old} {old}::`", f"`#{old} {old}::`"),
        (f"```\n[[{old}]] #{old}\n{old}::\n```",
         f"```\n[[{old}]] #{old}\n{old}::\n```"),
        (f"```lang\n[[{old}]]\n```", f"```lang\n[[{old}]]\n```"),
        (f"mid#{old}", f"mid#{old}"),
        (f"see {old}:: here", f"see {old}:: here"),
        ("((abcdef123))", "((abcdef123))"),
    ] + _tick_pieces(old)


def _tick_pieces(old: str) -> list[tuple[str, str]]:
    """Pieces with a backtick inside a link, tag or attribute title as
    written: no refs at all, so a rename leaves every byte. A lone backtick
    ends its line, or it would pair with one in the next piece."""
    return [
        (f"[[{old}`]]\n", f"[[{old}`]]\n"),
        (f"#[[{old}`]]\n", f"#[[{old}`]]\n"),
        (f"[[{old}`b`]]", f"[[{old}`b`]]"),
        (f"[[`c` {old}]]", f"[[`c` {old}]]"),
        (f"[[the `{old}` fn]]", f"[[the `{old}` fn]]"),
        (f"[[{old}`b]] and #[[{old}`]]", f"[[{old}`b]] and #[[{old}`]]"),
        (f"[[x [[{old}`y]] z]]\n", f"[[x [[{old}`y]] z]]\n"),
    ]


def _ref_pieces(old: str, new: str) -> list[tuple[str, str]]:
    """Pieces that are refs to `old` when `old` can be spelled that way."""
    out: list[tuple[str, str]] = []
    if _is_link(old):
        out += [
            (f"[[{old}]]", f"[[{new}]]"),
            (f"[[x [[{old}]] y]]", f"[[x [[{new}]] y]]"),
            (f"[[[[{old}]]]]", f"[[[[{new}]]]]"),
            # The outer title holds a backtick, so only the inner is a ref.
            (f"[[x [[{old}]] `y`]]", f"[[x [[{new}]] `y`]]"),
        ]
    if _is_bracket_tag(old):
        out.append((f"#[[{old}]]", f"#[[{new}]]"))
    if _is_hashtag(old):
        bare = f"#{new}" if _is_hashtag(new) else f"#[[{new}]]"
        out.append((f"#{old}", bare))
    return out


def _attribute_piece(old: str, new: str, indent: str,
                     padded: bool) -> tuple[str, str] | None:
    if not _is_attribute(old):
        return None
    colons = " ::" if padded else "::"
    source = f"{indent}{old}{colons} value [[Other]]"
    head = f"{new}::" if _is_attribute(new) else f"[[{new}]]"
    return source, f"{indent}{head} value [[Other]]"


@st.composite
def block_cases(draw, *, padded_attribute: bool = True, nested: bool = True):
    """(old, new, text, expected): `expected` is what a rename old -> new
    must produce, built piece by piece."""
    old = draw(titles)
    new = _other_than(old, draw(titles))
    other = draw(st.sampled_from(_OTHERS))
    # Where a ref sits inside another ref's title (a link in a longer link,
    # a tag in the first line's attribute name) the outer title changes too,
    # so `nested=False` keeps those out of the read-back oracle.
    candidates = [
        p for p in _plain_pieces(old, new, other)
        if nested or "::" not in p[0] or p[0].startswith("`")
    ] + [
        p for p in _ref_pieces(old, new)
        if nested or ("[[x " not in p[0] and "[[[[" not in p[0])
    ]
    pieces = draw(st.lists(st.sampled_from(candidates), max_size=7))
    if draw(st.booleans()):
        # Both titles in one text: what a swap or a merge reads.
        pieces += [(f"[[{new}]]", f"[[{new}]]"), *_ref_pieces(old, new)[:1]]
    if draw(st.booleans()):
        indent = draw(st.sampled_from(["", " ", "  ", "\t", "\n"]))
        lead = _attribute_piece(
            old, new, indent, padded_attribute and draw(st.booleans()))
        if lead is not None:
            pieces.insert(0, lead)
    seps = draw(st.lists(st.sampled_from(_SEPARATORS),
                         min_size=len(pieces), max_size=len(pieces)))
    source = ""
    expected = ""
    for k, (src, exp) in enumerate(pieces):
        sep = seps[k - 1] if k else ""
        source += sep + src
        expected += sep + exp
    return old, new, source, expected


_BACKTICK_IN_LINK = re.compile(r"\[\[[^\]\n]*`")


# --- properties -----------------------------------------------------------

# Each floor is about half the lowest share of cases the label reached over
# 30 unseeded runs: a floor near the typical share fails on an unlucky draw
# with nothing wrong, and one far below it lets a generator change drop the
# case unnoticed.

@with_floors({
    "changed": 0.3,
    "unchanged": 0.08,
    "code-bearing": 0.14,
    "no code": 0.2,
    "attribute lead": 0.07,
    "no attribute lead": 0.35,
    "backtick in a link": 0.18,
    "no backtick in a link": 0.22,
}, per="case")
@settings(max_examples=400, deadline=None)
@given(block_cases())
def test_rewrite_changes_only_the_refs_to_the_old_title(case):
    count("case")
    old, new, text, expected = case
    out = rewrite_title_refs(text, old, new)
    event("changed" if out != text else "unchanged")
    event("code-bearing" if "`" in text else "no code")
    event("backtick in a link" if _BACKTICK_IN_LINK.search(text)
          else "no backtick in a link")
    assert title_syntax_reason(new) is None
    event("attribute lead" if _is_attribute(old) and "::" in text
          else "no attribute lead")
    assert out == expected


@with_floors({"identity over a text with refs": 0.39, "no refs": 0.056},
             per="case")
@settings(max_examples=400, deadline=None)
@given(block_cases(padded_attribute=False))
def test_rewriting_with_the_same_title_is_the_identity(case):
    count("case")
    old, _new, text, _expected = case
    assert rewrite_title_refs(text, old, old) == text
    event("identity over a text with refs" if old in text else "no refs")


def _substituted(text: str, old: str, new: str,
                 *, title_after: str | None = None) -> set[tuple[str, str]]:
    """The (title, kind) set of `text`, with `old` replaced by `new` where
    the rewrite is entitled to spell it differently: an attribute that
    cannot be written `New::` becomes a link."""
    out = set()
    for ref in extract(text).refs:
        if ref.title == old:
            kind = ref.kind
            if kind == "attribute" and not _is_attribute(new):
                kind = "link"
            out.add((new if title_after is None else title_after, kind))
        else:
            out.add((ref.title, ref.kind))
    return out


@with_floors({"code to preserve": 0.17, "no code": 0.2},
             per="case")
@settings(max_examples=400, deadline=None)
@given(block_cases(nested=False))
def test_rewritten_text_reads_back_as_refs_to_the_new_title(case):
    count("case")
    old, new, text, _expected = case
    out = rewrite_title_refs(text, old, new)
    assert title_syntax_reason(new) is None
    assert _is_link(new)
    assert {(r.title, r.kind) for r in extract(out).refs} == \
        _substituted(text, old, new)
    # What the grammar calls code is exactly what it was.
    assert _code_chars(out) == _code_chars(text)
    event("code to preserve" if _code_chars(text) else "no code")


@settings(max_examples=400, deadline=None)
@given(block_cases())
def test_a_rename_never_drops_a_backtick_or_a_code_span(case):
    """Text may shrink only inside a rewritten ref, and a code span is never
    in one: `[[a`b]]` holds code, so it is no ref and survives whole. Run
    under plain-space canonicalisation, where the blanks a code span leaves
    in a title would otherwise canonicalise away."""
    old, new, text, _expected = case
    replacements = {old: new}
    out = rewrite_title_refs_map(
        text, replacements, normalize=spelled_or_canonical(
            _plain_space_canonical, replacements))
    assert _code_chars(out) == _code_chars(text)
    assert out.count("`") == text.count("`")


def _code_chars(text: str) -> str:
    """The non-space characters `strip_code` blanks out of `text`."""
    return "".join(c for c, kept in zip(text, strip_code(text))
                   if kept == " " and c != " ")


@with_floors({"accepted title": 0.2, "refused title": 0.2},
             per="case")
@settings(max_examples=400, deadline=None)
@given(raw_titles, st.sampled_from(
    ["[[a]]", "x [[a]] y [[a]]", "#[[a]] #[[a]]", "[[a]] `c` [[a]]",
     "a:: v [[a]] `c`", "#a [[a]] `c`"]))
def test_every_title_the_product_accepts_reads_back_after_a_rewrite(
        new, text):
    count("case")
    new = normalize_title(new).strip(" ") or "T"
    if title_syntax_reason(new) is not None:
        event("refused title")
        return
    event("accepted title")
    out = rewrite_title_refs(text, "a", new)
    titles_after = {r.title for r in extract(out).refs}
    assert new in titles_after
    assert "a" not in titles_after - {new}


@with_floors({"new already occurs: skipped": 0.17, "round trip by refs": 0.16, "round trip exact": 0.051},
             per="case")
@settings(max_examples=400, deadline=None)
@given(block_cases(padded_attribute=False, nested=False))
def test_old_to_new_and_back_restores_the_text(case):
    count("case")
    old, new, text, _expected = case
    if any(r.title == new for r in extract(text).refs):
        event("new already occurs: skipped")
        return
    forward = rewrite_title_refs(text, old, new)
    back = rewrite_title_refs(forward, new, old)
    if _is_link(new) and _is_attribute(new) and _is_hashtag(new):
        event("round trip exact")
        assert back == text
    else:
        # `#New` spelled `#[[New]]` and `New::` spelled `[[New]]` do not
        # shrink back, but every ref still points where it did.
        event("round trip by refs")
        assert {(r.title, r.kind) for r in extract(back).refs} == \
            _substituted(text, old, new, title_after=old)


@with_floors({"swap over a text mentioning both": 0.14, "swap over a text mentioning one": 0.2},
             per="case")
@settings(max_examples=200, deadline=None)
@given(block_cases())
def test_a_swap_exchanges_the_two_titles_rather_than_chaining(case):
    """{old: new, new: old} reads the original text once: the same result as
    parking `old` on a sentinel, moving `new` to `old`, then the sentinel to
    `new`, which is the only way to swap one title at a time."""
    count("case")
    old, new, text, _expected = case
    park = "SentinelParked"
    swapped = rewrite_title_refs_map(text, {old: new, new: old})
    stepwise = rewrite_title_refs(
        rewrite_title_refs(rewrite_title_refs(text, old, park), new, old),
        park, new)
    mentions = {r.title for r in extract(text).refs}
    event("swap over a text mentioning both" if {old, new} <= mentions
          else "swap over a text mentioning one")
    assert swapped == stepwise


def _plain_space_canonical(raw: str) -> str:
    """The canonical form once plain-space canonicalisation is active."""
    return normalize_title(raw).strip(" ")


_PADS = st.sampled_from(["", " ", "  ", "   "])


@st.composite
def padded_cases(draw):
    """(old, new, text, expected): refs to `old` spelled with plain-space
    padding, among refs to another title, and code spans holding the same
    spellings. Every ref whose canonical form is `old` is rewritten to
    `new`; every other byte stays."""
    old = draw(titles.map(
        lambda t: t if _is_link(t) and _is_bracket_tag(t) else "Old"))
    new = _other_than(old, draw(titles))
    other = _other_than(old, draw(st.sampled_from(_OTHERS)))
    pieces = []
    for _ in range(draw(st.integers(1, 6))):
        left, right = draw(_PADS), draw(_PADS)
        kind = draw(st.sampled_from(
            ["link", "tag", "other link", "code", "words", "backtick link"]))
        if kind == "backtick link":
            # Code between the brackets pads the title with blanks that
            # canonicalise away, yet the title as written holds a backtick.
            same = draw(st.sampled_from([
                f"[[{left}{old}`b`{right}]]",
                f"#[[{left}`c`{old}{right}]]",
                f"[[{left}{old}`b]] and [[c`{right}]]",
            ]))
            pieces.append((same, same, ""))
            # The outer title holds a backtick; the inner link is a ref.
            pieces.append((f"[[x `y` [[{left}{old}{right}]]]]",
                           f"[[x `y` [[{new}]]]]", left + right))
        elif kind == "link":
            pieces.append((f"[[{left}{old}{right}]]", f"[[{new}]]", left + right))
        elif kind == "tag":
            pieces.append((f"#[[{left}{old}{right}]]", f"#[[{new}]]",
                           left + right))
        elif kind == "other link":
            piece = f"[[{left}{other}{right}]]"
            pieces.append((piece, piece, ""))
        elif kind == "code":
            piece = f"`[[{left}{old}{right}]]`"
            pieces.append((piece, piece, ""))
        else:
            pieces.append(("plain words", "plain words", ""))
    seps = draw(st.lists(st.sampled_from(_SEPARATORS),
                         min_size=len(pieces), max_size=len(pieces)))
    source = expected = ""
    for k, (src, exp, _pad) in enumerate(pieces):
        sep = seps[k - 1] if k else ""
        source += sep + src
        expected += sep + exp
    padded = any(pad and src != exp for src, exp, pad in pieces)
    return old, new, source, expected, padded


@with_floors({"rewrote a padded spelling": 0.24, "no padded spelling": 0.115,
              "backtick in a link": 0.15, "no backtick in a link": 0.26},
             per="case")
@settings(max_examples=400, deadline=None)
@given(padded_cases())
def test_a_padded_spelling_is_rewritten_when_its_canonical_form_is_a_key(case):
    """The map's `normalize` is `spelled_or_canonical`: `[[ Old ]]` and
    `#[[ Old ]]` name the page `Old` once plain spaces are canonical, so a
    rename of `Old` must not leave them behind."""
    count("case")
    old, new, text, expected, padded = case
    replacements = {old: new}
    out = rewrite_title_refs_map(
        text, replacements, normalize=spelled_or_canonical(
            _plain_space_canonical, replacements))
    event("backtick in a link" if _BACKTICK_IN_LINK.search(text)
          else "no backtick in a link")
    if padded:
        event("rewrote a padded spelling")
    else:
        event("no padded spelling")
    assert out == expected


def test_the_titles_strategy_draws_storable_titles():
    @settings(max_examples=300, deadline=None)
    @given(titles)
    def check(title_text):
        assert title_syntax_reason(title_text) is None
        assert target_canonical_title(title_text) == title_text
        assert title_text.strip() == title_text and title_text

    check()
