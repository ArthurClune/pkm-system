"""Hypothesis strategies for hostile input, shared by the no-500
properties: text built from the pieces that have broken a route before,
JSON values holding that text and the numbers Python's json accepts, and
a strategy for any value a pydantic annotation names.

Strategies here never filter, so none can reject every draw."""
import functools
import math
import types
import typing
from collections import Counter

from annotated_types import MinLen
from hypothesis import currently_in_test_context
from hypothesis import event as _event
from hypothesis import strategies as st
from pydantic import BaseModel

LONE_HIGH = "\ud800"
LONE_LOW = "\udc00"

# Values the seeded test database holds (conftest.SEED_PAGES and
# SEED_BLOCKS), so a hostile request also reaches the paths a real title
# or uid opens.
REAL_TITLES = ["Machine Learning", "AI", "July 7th, 2026", "Paper",
               "Attention Is All You Need"]
REAL_UIDS = ["uid_b1", "uid_b2", "uid_b3", "uid_b4", "uid_b5", "uid_b6"]

_PIECES = [
    LONE_HIGH, LONE_LOW, "\x00", "\x01", "\x1f", "\x7f", "\x85", " ",
    "﻿", "​", "é", "é", "�", "\U0001f600",
    "\U0001f468‍\U0001f469", " ", "  ", "\t", "\n", "\r\n", " ",
    "　", "[[", "]]", "[[]]", "[[   ]]", "((", "))", "#", "#[[", "::",
    "{{", "}}", "`", "```", '"', "'", "\\", "/", "%", "%00", "%ED%A0%80",
    "..", "?", "&", "=", "+", "*", "-", "^", "NEAR(", " OR ", "x", "2026-07-07",
    "X] ", " X ]", " /x ", ".", "..",
    *REAL_TITLES, *REAL_UIDS,
]
_BLANKS = [" ", "\t", "\n", " ", "　", " "]


# What a property reached, counted beside Hypothesis's `event` so a test can
# assert it: `with_floors` clears it before a property runs and checks it
# after.
TALLY: Counter[str] = Counter()


def event(label: str) -> None:
    if currently_in_test_context():
        TALLY[label] += 1
        _event(label)


def count(label: str) -> None:
    """Count `label` in the tally without a Hypothesis event: the
    denominator a floor's share is taken of."""
    if currently_in_test_context():
        TALLY[label] += 1


def with_floors(floors: dict[str, float], per: str):
    """Wrap a property so it fails when a label was reached by less than
    `floors[label]` of the `per` count. A property that stopped drawing a
    case would otherwise stay green on the cases it still draws.

    A floor is about half the lowest share the label reached over 24 seeds
    (`--hypothesis-seed=1..24`): near the typical share it fails on an
    unlucky seed with nothing wrong. A label whose lowest count was under
    about ten events has no floor, since half of so few is noise; the
    generator is changed to draw it more often, or it stays an `event`."""
    def decorate(test):
        @functools.wraps(test)
        def run(*args, **kwargs):
            TALLY.clear()
            test(*args, **kwargs)
            total = TALLY[per]
            assert total, per
            for label, share in floors.items():
                assert TALLY[label] > total * share, (
                    label, TALLY[label], total)
        return run
    return decorate


blank_text = st.lists(st.sampled_from(_BLANKS), min_size=1,
                      max_size=4).map("".join)

_pieces = st.lists(st.sampled_from(_PIECES), max_size=6).map("".join)
_spliced = st.tuples(st.text(max_size=4),
                     st.sampled_from([LONE_HIGH, LONE_LOW, "\x00"]),
                     st.text(max_size=4)).map("".join)
# Drawn by index, since one_of collapses repeated strategies: pieces in
# four of ten draws, a lone surrogate or NUL spliced into text in two.
_TEXT_KINDS: list[st.SearchStrategy[str]] = [
    _pieces, _pieces, _spliced, st.text(max_size=8),
    st.sampled_from(REAL_TITLES + REAL_UIDS), blank_text, _pieces, _spliced,
    st.integers(300, 3000).map(lambda n: "x" * n), _pieces,
]
hostile_text = st.integers(0, len(_TEXT_KINDS) - 1).flatmap(
    lambda i: _TEXT_KINDS[i])

json_leaf = st.one_of(
    st.none(), st.booleans(), st.integers(-3, 10),
    st.integers(-(2 ** 70), 2 ** 70),
    st.floats(allow_nan=True, allow_infinity=True),
    st.sampled_from([math.nan, math.inf, -math.inf]), hostile_text,
)

json_value = st.recursive(
    json_leaf,
    lambda kids: st.one_of(st.lists(kids, max_size=3),
                           st.dictionaries(hostile_text, kids, max_size=3)),
    max_leaves=8,
)


# A blank title is the one every title-taking route must refuse or
# replace, so it is drawn as often as a hostile one.
# Spellings the title rules judge once their boundary spaces are stripped:
# a trailing `]` or a path segment that only shows after the strip.
SPACED_TITLES = ["X] ", " X ]", "a] ", " /x", "/x ", " /x ", "x/", ".", "..",
                 " . ", " .. ", " [[x]] "]
_padded_real = st.tuples(st.sampled_from(REAL_TITLES), st.integers(1, 2),
                         st.integers(0, 2)).map(
    lambda t: " " * t[1] + t[0] + " " * t[2])
_TITLE_KINDS: list[st.SearchStrategy[str]] = [
    st.sampled_from(REAL_TITLES), hostile_text, blank_text,
    st.sampled_from(REAL_TITLES), st.sampled_from(SPACED_TITLES),
    _padded_real]

# Small ints, the edges of SQLite's 64-bit range on both sides, and any.
_wide_int = st.sampled_from(
    [2 ** 63 - 1, 2 ** 63, -(2 ** 63), -(2 ** 63) - 1, 2 ** 64])
_INT_KINDS: list[st.SearchStrategy[int]] = [
    st.integers(-3, 10), st.integers(-3, 10), _wide_int,
    st.integers(-(2 ** 70), 2 ** 70)]

# Plausible values for a branded str, so a typed request often passes its
# shape checks and reaches the code behind them.
_hex = st.text(alphabet="0123456789abcdef", min_size=8, max_size=8)
_PLAUSIBLE: dict[str, st.SearchStrategy[object]] = {
    "BlockUid": st.one_of(
        st.sampled_from(REAL_UIDS),
        st.from_regex(r"[a-zA-Z0-9_-]{6,12}", fullmatch=True)),
    "RawTitle": st.integers(0, len(_TITLE_KINDS) - 1).flatmap(
        lambda i: _TITLE_KINDS[i]),
    "ClientId": st.just("client-1"),
    "BatchId": _hex.map(lambda h: "batch-" + h),
    # An order key at the edge of SQLite's range in one draw in four.
    "SyncSeq": st.integers(0, 3).flatmap(
        lambda i: _wide_int if i == 2 else st.integers(0, 50)),
    "OrderIdx": st.integers(0, 3).flatmap(
        lambda i: _wide_int if i == 2 else st.integers(0, 5)),
    "Sha256Hex": st.text(alphabet="0123456789abcdef", min_size=64,
                         max_size=64),
}


# Fields whose type alone says too little: a create needs a new uid and a
# rename a new title (a seeded one is refused), and the CLI batch's uid
# and parent fields are plain str that should often name a seeded block.
_seeded_uid = st.integers(0, 3).flatmap(
    lambda i: hostile_text if i == 2 else st.sampled_from(REAL_UIDS))
_FIELD_VALUES: dict[tuple[str, str], st.SearchStrategy[object]] = {
    ("CreateOp", "uid"): st.from_regex(r"new[a-z0-9]{6}", fullmatch=True),
    ("RenamePageRequest", "new_title"): hostile_text,
    ("UpdateParams", "uid_spec"): _seeded_uid,
    ("MoveParams", "uid_spec"): _seeded_uid,
    ("DeleteParams", "uid_spec"): _seeded_uid,
    ("CreateParams", "parent"): _seeded_uid,
}


def text_labels(text: str) -> list[str]:
    """What a hostile str holds, for `event` reach labels."""
    labels = []
    if any(0xD800 <= ord(c) <= 0xDFFF for c in text):
        labels.append("lone surrogate")
    if "\x00" in text:
        labels.append("NUL")
    if text and not text.strip():
        labels.append("blank")
    if "[[" in text:
        labels.append("[[")
    if len(text) >= 300:
        labels.append("very long")
    return labels


def value_labels(value: object) -> set[str]:
    """`text_labels` of every str in a JSON value, plus non-finite numbers."""
    found: set[str] = set()
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            found.update(text_labels(item))
        elif isinstance(item, float) and item != item:
            found.add("NaN")
        elif isinstance(item, float) and item in (float("inf"), float("-inf")):
            found.add("Infinity")
        elif isinstance(item, int) and not -(2 ** 63) <= item < 2 ** 63:
            found.add("int past 64 bits")
        elif isinstance(item, dict):
            stack.extend(item.keys())
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return found


def for_annotation(annotation: object, *, loose: bool, depth: int = 0,
                   min_size: int = 0) -> st.SearchStrategy[object]:
    """Values of the type `annotation` names, built of hostile text. With
    `loose`, any value may instead be arbitrary JSON (the wrong type,
    which a route refuses with a 422 that echoes it). Raises on a type it
    does not know, so a request model gaining one is noticed here."""
    typed = _typed(annotation, loose=loose, depth=depth, min_size=min_size)
    if loose:
        return st.integers(0, 2).flatmap(
            lambda i: json_value if i == 1 else typed)
    return typed


def _typed(annotation: object, *, loose: bool, depth: int,
           min_size: int) -> st.SearchStrategy[object]:
    if depth > 4 or annotation is typing.Any or annotation is object:
        return json_value
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)
    if isinstance(annotation, typing.TypeAliasType):
        return for_annotation(annotation.__value__, loose=loose, depth=depth + 1)
    if origin is typing.Annotated:
        return for_annotation(args[0], loose=loose, depth=depth)
    if isinstance(annotation, typing.NewType):
        base = for_annotation(annotation.__supertype__, loose=loose,
                              depth=depth)
        plausible = _PLAUSIBLE.get(annotation.__name__)
        if plausible is None:
            return base
        return st.integers(0, 3).flatmap(
            lambda i: base if i == 2 else plausible)
    if origin is typing.Union or origin is types.UnionType:
        return st.one_of(*[for_annotation(a, loose=loose, depth=depth)
                           for a in args])
    if origin is typing.Literal:
        return st.sampled_from(args)
    if annotation is type(None):
        return st.none()
    if annotation is str:
        return hostile_text
    if annotation is bool:
        return st.booleans()
    if annotation is int:
        return st.integers(0, 3).flatmap(lambda i: _INT_KINDS[i])
    if origin is list:
        return st.lists(for_annotation(args[0], loose=loose, depth=depth + 1),
                        min_size=min_size, max_size=max(4, min_size))
    if origin is dict:
        return st.dictionaries(hostile_text,
                               for_annotation(args[1], loose=loose,
                                              depth=depth + 1), max_size=3)
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return model_body(annotation, loose=loose, depth=depth + 1)
    raise AssertionError(f"no hostile strategy for {annotation!r}")


@st.composite
def _model_dict(draw, model: type[BaseModel], loose: bool,
                depth: int) -> dict[str, object]:
    body: dict[str, object] = {}
    for name, field in model.model_fields.items():
        key = field.alias or name
        present = field.is_required() or draw(st.booleans())
        if loose and draw(st.integers(0, 9)) == 5:
            present = not present
        if present:
            min_size = 0 if loose else next(
                (m.min_length for m in field.metadata
                 if isinstance(m, MinLen)), 0)
            fixed = _FIELD_VALUES.get((model.__name__, name))
            if fixed is not None and not loose:
                body[key] = draw(fixed)
            else:
                body[key] = draw(for_annotation(
                    field.annotation, loose=loose, depth=depth,
                    min_size=min_size))
    if loose and draw(st.integers(0, 9)) == 5:
        body[draw(hostile_text)] = draw(json_value)
    return body


def model_body(model: type[BaseModel], *, loose: bool,
               depth: int = 0) -> st.SearchStrategy[dict[str, object]]:
    """A JSON object shaped like `model`: its required fields and some of
    its optional ones. With `loose`, a field may be missing, extra or of
    the wrong type."""
    return _model_dict(model, loose, depth)
