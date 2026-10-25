"""The bracket walks of rename and unlink against the recursive versions
they replaced.

`rename._rewrite_range` and `unlink._unlink_range` used to recurse once per
`[[` nesting level, so text nested past the recursion limit (which no write
path bounds) made rename and delete fail. They now keep their own stack.
Both rewrite user text, so the iterative walk must collect exactly the spans
the recursive one did, in the same order (`unlink._unlink_bracket` reads the
spans collected so far). The recursive walks are kept here verbatim as the
oracle, and are fed texts shallow enough for them to finish."""
from __future__ import annotations

from typing import Callable, Iterable, Sequence
from unittest.mock import patch

import pytest

from hostile import count, event, with_floors
from hypothesis import given, settings
from hypothesis import strategies as st

from pkm import rename, unlink
from pkm.contracts.titles import RawTitle, as_raw_title
from pkm.refs import (BracketSpan, bracket_spans, iter_bracket_spans,
                      normalize_title, strip_code, tag_spans)
from pkm.test_data.ids import raw_title_of


def _reference_unlink_range(
    text: str, clean: str, is_target: Callable[[str], bool], start: int,
    stop: int, brackets: Sequence[BracketSpan],
    spans: list[tuple[int, int, str]],
) -> None:
    """`unlink._unlink_range` as it was before the walk kept its own
    stack."""
    index = start
    for bracket in brackets:
        unlink._unlink_tags(text, clean, is_target, index, bracket.start, spans)
        if is_target(clean[bracket.inner_start:bracket.inner_end]):
            unlink._unlink_bracket(text, clean, is_target, bracket, spans)
        else:
            _reference_unlink_range(
                text, clean, is_target, bracket.inner_start,
                bracket.inner_end, bracket.children, spans,
            )
        index = bracket.end
    unlink._unlink_tags(text, clean, is_target, index, stop, spans)


def _reference_rewrite_range(
    clean: str,
    lookup: Callable[[RawTitle], RawTitle | None],
    form: Callable[..., str],
    start: int,
    stop: int,
    brackets: Iterable[BracketSpan],
    spans: list[tuple[int, int, str]],
) -> None:
    """`rename._rewrite_range` as it was before the walk kept its own
    stack."""
    index = start
    for bracket in brackets:
        rename._rewrite_tags(clean, lookup, form, index, bracket.start, spans)
        new_title = lookup(
            as_raw_title(clean[bracket.inner_start:bracket.inner_end]))
        if new_title is not None:
            spans.append((bracket.start, bracket.end, f"[[{new_title}]]"))
        else:
            _reference_rewrite_range(
                clean,
                lookup,
                form,
                bracket.inner_start,
                bracket.inner_end,
                bracket.children,
                spans,
            )
        index = bracket.end
    rename._rewrite_tags(clean, lookup, form, index, stop, spans)


# --- texts ----------------------------------------------------------------

# Titles a target or a replacement key may name. Some hold brackets, so a
# run that holds runs can itself be the match (outer match wins), and some
# end in `]`, which the pairing reads as part of the closer.
_KEYS = ["AI", "ai", "Old", "a]", "x y", "é", "[[AI]]", "x [[AI]] y",
         "[[Old]] [[AI]]", "[[]]", "", " AI ", "#AI", "[x]([[AI]])"]
_NEW_TITLES = ["New", "B]", "x y", "Z", "AI", "😀"]

_PIECES = [
    "AI", "ai", "Old", "a]", "x y", "\u00e9", "\U0001f600", "AI\u200b",
    " ", "\n", "x", "#AI", "#Old", "#ai", "#[[", "#", "::", "AI:: ", "[",
    "]", "[[", "]]", "]]]", "[[[", "[[]]", "[[ ]]", "(", ")", "[x](",
    "[#AI](", "[x #AI](", "](", "`", "``", "```", "\\[[", "((uid_b1))",
    "{{embed: ((uid_b1))}}",
]
_OPENERS = ["[[", "#[[", "[x]([[", "[#AI]([[", "[[ ", "`[[", "[[[", "[["]
_CLOSERS = ["]]", "]])", "]", "]]]", " ]]", "", "]]`", "]]"]
# How a key is written into a text: as a link, a tag, an aliased link, or
# bare so an enclosing run can make it a title.
_SPELLINGS = ["[[{}]]", "#[[{}]]", "[x]([[{}]])", "[#AI]([[{}]])", "{}",
              "[[ {} ]]", "`[[{}]]`", " #{}", "(#{}", "[[x #{}]]",
              "[[#{0} [[{0}]]]]", "[x #{}](", "[x #{0}]([[{0}]])",
              "[#{0} y #{0}]([[{0}]])"]
# A tag needs whitespace or `(` before it, so pieces are sometimes joined
# by one.
_JOINERS = ["", " ", "\n", "("]


def _joined(children: st.SearchStrategy[str], size: int
            ) -> st.SearchStrategy[str]:
    return st.builds(str.join, st.sampled_from(_JOINERS),
                     st.lists(children, max_size=size))


def _nest(children: st.SearchStrategy[str]) -> st.SearchStrategy[str]:
    return st.builds(
        lambda o, body, c: o + body + c,
        st.sampled_from(_OPENERS), _joined(children, 4),
        st.sampled_from(_CLOSERS))


def _tree_text(keys: Sequence[str]) -> st.SearchStrategy[str]:
    """Pieces nested in runs that may not close, with the keys written in
    among them so that walks reach runs that match."""
    spelled = st.builds(str.format, st.sampled_from(_SPELLINGS),
                        st.sampled_from(keys))
    return st.recursive(
        st.one_of(st.sampled_from(_PIECES), spelled),
        lambda children: st.one_of(_nest(children), _joined(children, 5)),
        max_leaves=30,
    )


@st.composite
def _deep_text(draw, keys: Sequence[str]) -> str:
    """A long chain of `[[` around a title, closed by a few more or fewer
    `]]` than it opened, with text either side."""
    depth = draw(st.integers(1, 150))
    closers = max(0, depth + draw(st.integers(-2, 2)))
    tree = _tree_text(keys)
    title = draw(st.one_of(st.sampled_from(keys), tree))
    return draw(tree) + "[[" * depth + title + "]]" * closers + draw(tree)


def _texts(keys: Sequence[str]) -> st.SearchStrategy[str]:
    return st.one_of(_tree_text(keys), _deep_text(keys))


_keys = st.lists(st.sampled_from(_KEYS), min_size=1, max_size=3, unique=True)


def _depth(spans: Sequence[BracketSpan]) -> int:
    deepest = 0
    stack = [(span, 1) for span in spans]
    while stack:
        span, level = stack.pop()
        deepest = max(deepest, level)
        stack.extend((child, level + 1) for child in span.children)
    return deepest


def _tally(text: str, matches: Callable[[str], bool]) -> list[BracketSpan]:
    """Label which branches of the walk a text takes; the runs that match."""
    clean = strip_code(text)
    runs = bracket_spans(clean, text)
    matched = [s for s in iter_bracket_spans(runs)
               if matches(clean[s.inner_start:s.inner_end])]
    count("case")
    # The runs the walk opens: unmatched ones not inside a match.
    opened: list[BracketSpan] = []
    stack = list(runs)
    while stack:
        span = stack.pop()
        if not matches(clean[span.inner_start:span.inner_end]):
            opened.append(span)
            stack.extend(span.children)
    if any(matches(tag.raw_title) for s in opened
           for tag in tag_spans(clean, s.inner_start, s.inner_end)):
        event("matched a tag in an opened run")
    if any(s.children for s in matched):
        event("matched a run holding runs")
    top = {id(span) for span in runs}
    if any(id(s) not in top for s in matched):
        event("matched a nested run")
    if _depth(runs) >= 20:
        event("nested 20 or deeper")
    return matched


# --- unlink ---------------------------------------------------------------

_UNLINK_BRACKET = unlink._unlink_bracket
# Set by `_noting_drops` when an alias dropped spans in the current case.
_DROPPED: list[bool] = []


def _noting_drops(text: str, clean: str, is_target: Callable[[str], bool],
                  bracket: BracketSpan,
                  spans: list[tuple[int, int, str]]) -> None:
    """`unlink._unlink_bracket`, reporting when an alias drops spans already
    collected: the path on which the walk's span order shows in the output."""
    before = len(spans)
    _UNLINK_BRACKET(text, clean, is_target, bracket, spans)
    if len(spans) <= before:
        _DROPPED.append(True)


@st.composite
def _unlink_cases(draw) -> tuple[str, Callable[[str], bool]]:
    targets = frozenset(keys := draw(_keys))
    normalized = draw(st.booleans())

    def is_target(raw: str) -> bool:
        return (normalize_title(raw) if normalized else raw) in targets

    return draw(_texts(keys)), is_target


@with_floors({"matched a run holding runs": 0.09,
              "matched a nested run": 0.15,
              "matched a tag in an opened run": 0.017,
              "matched an aliased run": 0.08,
              "alias dropped a span": 0.016,
              "nested 20 or deeper": 0.09}, per="case")
@settings(max_examples=500, deadline=None)
@given(_unlink_cases())
def test_unlink_walk_matches_the_recursive_walk(case):
    text, is_target = case
    matched = _tally(text, is_target)
    clean = strip_code(text)
    if any(clean[s.end:s.end + 1] == ")"
           and unlink._ALIAS_LABEL.search(clean, 0, s.start)
           for s in matched):
        event("matched an aliased run")
    runs = bracket_spans(clean, text)
    expected: list[tuple[int, int, str]] = []
    actual: list[tuple[int, int, str]] = []
    _reference_unlink_range(text, clean, is_target, 0, len(clean), runs,
                            expected)
    _DROPPED.clear()
    with patch.object(unlink, "_unlink_bracket", _noting_drops):
        unlink._unlink_range(text, clean, is_target, 0, len(clean), runs,
                             actual)
    assert actual == expected, text
    if _DROPPED:
        event("alias dropped a span")

    with patch.object(unlink, "_unlink_range", _reference_unlink_range):
        before = unlink.unlink_title_refs(text, is_target)
    after = unlink.unlink_title_refs(text, is_target)
    assert after == before, text
    event("changed" if after != text else "unchanged")


@pytest.mark.parametrize("text,expected", [
    ("[x #AI]([[AI]])", "x AI"),
    ("p #AI [x #AI]([[AI]]) #AI", "p AI x AI AI"),
])
def test_an_alias_drops_the_tag_spans_in_its_label(text, expected):
    """The label's `#AI` is collected as a tag span before the alias is
    reached, then dropped and unlinked inside the label; the tags either
    side survive the drop."""
    def is_target(raw: str) -> bool:
        return raw == "AI"

    assert unlink.unlink_title_refs(text, is_target) == expected
    with patch.object(unlink, "_unlink_range", _reference_unlink_range):
        assert unlink.unlink_title_refs(text, is_target) == expected


# --- rename ---------------------------------------------------------------


@st.composite
def _rename_cases(draw: st.DrawFn
                  ) -> tuple[str, dict[str, RawTitle], Callable[[str], str]]:
    keys = draw(_keys)
    replacements = {key: raw_title_of(draw(st.sampled_from(_NEW_TITLES)))
                    for key in keys}
    normalize = draw(st.sampled_from([rename._verbatim, normalize_title]))
    return draw(_texts(keys)), replacements, normalize


@with_floors({"matched a run holding runs": 0.09,
              "matched a nested run": 0.14,
              "matched a tag in an opened run": 0.02,
              "nested 20 or deeper": 0.08}, per="case")
@settings(max_examples=500, deadline=None)
@given(_rename_cases())
def test_rename_walk_matches_the_recursive_walk(case):
    text, replacements, normalize = case
    def lookup(raw_title: RawTitle) -> RawTitle | None:
        return replacements.get(normalize(raw_title))

    _tally(text, lambda raw: lookup(as_raw_title(raw)) is not None)
    clean = strip_code(text)
    runs = bracket_spans(clean, text)
    expected: list[tuple[int, int, str]] = []
    actual: list[tuple[int, int, str]] = []
    form = rename._form_of
    _reference_rewrite_range(clean, lookup, form, 0, len(clean), runs,
                             expected)
    rename._rewrite_range(clean, lookup, form, 0, len(clean), runs, actual)
    assert actual == expected, text

    with patch.object(rename, "_rewrite_range", _reference_rewrite_range):
        before = rename.rewrite_title_refs_map(
            text, replacements, normalize=normalize)
    after = rename.rewrite_title_refs_map(
        text, replacements, normalize=normalize)
    assert after == before, text
    event("changed" if after != text else "unchanged")
