"""Properties of the pure local-link encoding: a path that survives
`clean_relative` round-trips through `local_href` and `resolve_relative`,
and `extract_local_hrefs` finds exactly the href in a `Local copy::` value
whatever label the picker wrote."""
import unicodedata

from hypothesis import event, given, settings
from hypothesis import strategies as st

from pkm.local_docs import (LOCAL_PREFIX, clean_relative, extract_local_hrefs,
                            local_href, resolve_relative)

_HOSTILE = [
    "a", "b", "Z", "é", unicodedata.normalize("NFD", "é"), "ñ", "%", "#", "?", "&", "+",
    "[", "]", "(", ")", "'", '"', " ", "  ", "\t", "\n", ".", "..", "%41", "%2F", "%25",
    "👍", "👨‍👩‍👧", "🇬🇧", "\\", "::", "](", "[[", "))", "<", ">", "=", ";", "@", "~", "*",
]

_free_text = st.text(
    alphabet=st.characters(blacklist_categories=("Cs",), blacklist_characters="/\x00"),
    max_size=12)

# One path segment: hostile tokens glued together, or arbitrary text. Never
# empty, never a bare dot segment, never a slash or NUL.
name_strategy = st.one_of(
    st.lists(st.sampled_from(_HOSTILE), min_size=1, max_size=8).map("".join),
    _free_text,
).map(lambda n: n + "x" if n in ("", ".", "..") else n)

rel_strategy = st.lists(name_strategy, min_size=1, max_size=4).map("/".join)


def _label(name: str) -> None:
    if "[" in name or "]" in name:
        event("name has brackets")
    if unicodedata.normalize("NFD", name) != name:
        event("name has NFD form")
    if any(ord(c) > 0xFFFF for c in name):
        event("name has astral char")
    if any(c in name for c in "%#?&+"):
        event("name has url metachar")
    if any(c in name for c in "()"):
        event("name has parens")
    if "\n" in name or "\t" in name:
        event("name has control char")


@settings(max_examples=400, deadline=None)
@given(rel_strategy)
def test_href_round_trips_to_the_same_relative_path(rel):
    # Backslash is rejected by clean_relative by design; those never get
    # this far, and are not part of this property's domain.
    cleaned = clean_relative(rel)
    if cleaned != rel:
        event("rejected or unclean")
        return
    for segment in rel.split("/"):
        _label(segment)
    href = local_href(rel)
    assert href.startswith(LOCAL_PREFIX)
    assert resolve_relative(href[len(LOCAL_PREFIX):]) == rel


def _labels_for(name: str) -> list[str]:
    # What the web's localCopyAttribute can write: the file name itself
    # when the link scans back cleanly, else the name with [ ] swapped for
    # ( ). The superset is checked: the extractor must not care which.
    return [name, name.replace("[", "(").replace("]", ")")]


@settings(max_examples=400, deadline=None)
@given(rel_strategy)
def test_extract_finds_exactly_the_href_whatever_the_label(rel):
    if clean_relative(rel) != rel:
        event("rejected or unclean")
        return
    href = local_href(rel)
    name = rel.rsplit("/", 1)[-1]
    _label(name)
    for label in _labels_for(name):
        if label != name:
            event("brackets replaced")
        assert extract_local_hrefs(f"Local copy:: [{label}]({href})") == [href]
        assert extract_local_hrefs(f"Local copy:: [{label}]({href}) tail") == [href]
