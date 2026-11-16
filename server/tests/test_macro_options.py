import pytest
from hypothesis import assume, given, strategies as st
from pkm import refs
from pkm.macro_options import (
    MacroOptions, format_macro_options, normalise_macro_options,
    options_refusal, split_macro_options)


def test_split_query_body():
    body = ("{and: [[Book]]} | view: table | filter: -status:read"
            " | sort: Published desc | columns: Author, Reading Status")
    assert split_macro_options(body) == (
        "{and: [[Book]]}",
        MacroOptions(view="table", filter="-status:read",
                     sort=("Published", "desc"),
                     columns=("Author", "Reading Status")))


def test_split_bare_table():
    assert split_macro_options("table | sort: Cache hit asc") == (
        "table", MacroOptions(sort=("Cache hit", "asc")))


def test_no_options():
    assert split_macro_options("{and: [[A]]}") == (
        "{and: [[A]]}", MacroOptions())


def test_unknown_option_ignored():
    assert split_macro_options("{and: [[A]]} | colour: red") == (
        "{and: [[A]]}", MacroOptions())


def test_bad_sort_and_view_ignored():
    assert split_macro_options("t | sort: A sideways | view: grid")[1] \
        == MacroOptions()


def test_repeated_option_last_wins():
    assert split_macro_options("t | view: cards | view: blocks")[1].view \
        == "blocks"


def test_columns_trimmed_and_empties_dropped():
    assert split_macro_options("t | columns: , A ,, B ,")[1].columns \
        == ("A", "B")


def test_filter_kept_verbatim():
    assert split_macro_options("t | filter:   a: b  ")[1].filter == "a: b"


def test_title_with_separator_inside_ref_never_splits():
    body = "{and: [[A | B]]} | view: cards"
    assert split_macro_options(body) == (
        "{and: [[A | B]]}", MacroOptions(view="cards"))


def test_separator_inside_braces_never_splits():
    assert split_macro_options("{or: x | y}")[0] == "{or: x | y}"


CASES = [
    ("{and: [[A]]}", MacroOptions()),
    ("table", MacroOptions(view="cards", sort=("Cache hit", "desc"))),
    ("{and: [[A | B]]}", MacroOptions(
        view="blocks", filter="-a:b", sort=("T", "asc"),
        columns=("X", "Y Z"))),
]


@pytest.mark.parametrize("head,opts", CASES)
def test_round_trip(head, opts):
    assert split_macro_options(head + format_macro_options(opts)) == (
        head, opts)


def test_format_order_is_fixed_and_skips_none():
    opts = MacroOptions(columns=("A",), view="table", sort=("S", "asc"))
    assert format_macro_options(opts) == (
        " | view: table | sort: S asc | columns: A")
    assert format_macro_options(MacroOptions()) == ""


@pytest.mark.parametrize("bad,char", [
    ("[[x]]", "[["), ("#x", "#"), ("a|b", "|"), ("a}", "}"), ("a{", "{"),
    ("((abcDEF123))", "(("), ("a))", "))")])
def test_refusal_names_the_character(bad, char):
    msg = options_refusal(MacroOptions(filter=bad))
    assert msg is not None and repr(char) in msg


def test_refusal_covers_sort_and_columns():
    assert "'#'" in (options_refusal(
        MacroOptions(sort=("#x", "asc"))) or "")
    assert "'[['" in (options_refusal(
        MacroOptions(columns=("ok", "[[x"))) or "")
    assert "','" in (options_refusal(
        MacroOptions(columns=("a,b",))) or "")


def test_clean_options_have_no_refusal():
    assert options_refusal(MacroOptions(
        view="table", filter="-status:read", sort=("A B", "desc"),
        columns=("A", "B"))) is None


def test_link_at_depth_zero_never_splits():
    assert split_macro_options("[[A | B]] | view: cards") == (
        "[[A | B]]", MacroOptions(view="cards"))


def test_stray_close_brackets_do_not_unbalance_the_split():
    assert split_macro_options("]] | view: cards") == (
        "]]", MacroOptions(view="cards"))
    assert split_macro_options("a ]] b | view: cards")[1].view == "cards"


def test_unclosed_link_swallows_the_options():
    assert split_macro_options("{and: [[A | B}} | view: cards") == (
        "{and: [[A | B}} | view: cards", MacroOptions())


def test_normalise_trims_and_drops_empties():
    opts = MacroOptions(filter="  ", sort=(" ", "asc"), columns=(" ", ""))
    assert normalise_macro_options(opts) == MacroOptions()
    assert normalise_macro_options(MacroOptions(
        filter=" f ", sort=(" S ", "desc"), columns=(" a", "", "b ")
    )) == MacroOptions(filter="f", sort=("S", "desc"), columns=("a", "b"))


_TEXT = st.text(alphabet=st.sampled_from(list("ab -:,\t#{}|[]()")),
                max_size=8)
_OPTIONS = st.builds(
    MacroOptions,
    view=st.none() | st.sampled_from(["table", "cards", "blocks"]),
    filter=st.none() | _TEXT,
    sort=st.none() | st.tuples(_TEXT, st.sampled_from(["asc", "desc"])),
    columns=st.none() | st.lists(_TEXT, max_size=4).map(tuple))


@given(_OPTIONS)
def test_accepted_options_round_trip_to_their_normal_form(opts):
    assume(options_refusal(opts) is None)
    head = "{and: [[A]]}"
    assert split_macro_options(head + format_macro_options(opts)) == (
        head, normalise_macro_options(opts))


_REF_PARTS = st.lists(st.sampled_from(
    ["((abcDEF))", "[[A]]", "#A", "(", ")", "[", "]", "((", "))", "A",
     "x", " ", ":", "-"]), max_size=5).map("".join)


@given(st.builds(
    MacroOptions, filter=st.none() | _REF_PARTS,
    sort=st.none() | st.tuples(_REF_PARTS, st.just("asc")),
    columns=st.none() | st.lists(_REF_PARTS, max_size=3).map(tuple)))
def test_accepted_options_add_no_refs(opts):
    # A refused option never reaches a macro, so only accepted ones must be
    # inert. No assume: discarding refused cases tripped the filter health
    # check, and a refusal is a valid outcome here, not a discard.
    if options_refusal(opts) is not None:
        return
    head = "{{query: {and: [[A]]}"
    assert refs.extract(head + format_macro_options(opts) + "}}") == (
        refs.extract(head + "}}"))
