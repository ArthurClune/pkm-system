# pattern: Functional Core
"""Minimal EDN parser — the subset used by Roam/DataScript EDN exports.

Maps -> dict (keywords kept as ':kw' strings), vectors/lists/sets -> list,
tagged literals -> Tagged. Not a general EDN library.
"""
from __future__ import annotations

from dataclasses import dataclass

_WS = set(" \t\n\r,")
_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t", "r": "\r",
            "b": "\b", "f": "\f"}
_NAMED_CHARS = {"newline": "\n", "space": " ", "tab": "\t", "return": "\r"}


class EdnError(ValueError):
    """A strict EDN parse failure at a zero-based character offset."""

    detail: str
    offset: int

    def __init__(self, detail: str, offset: int) -> None:
        self.detail = detail
        self.offset = offset
        super().__init__(f"{detail} at offset {offset}")


_DISCARD = object()  # sentinel: a `#_` form produced no value


@dataclass(frozen=True)
class Tagged:
    tag: str
    value: object


def parse_edn(text: str) -> object:
    value, pos = _parse_form(text, 0)
    pos = _skip_ws(text, pos)
    if pos != len(text):
        raise EdnError("trailing data", pos)
    return value


def _parse_form(text: str, pos: int) -> tuple[object, int]:
    """Parse the next real form, transparently resolving `#_` discards
    (including chains of them) so callers never see the discard sentinel."""
    while True:
        pos = _skip_ws(text, pos)
        value, pos = _parse(text, pos)
        if value is not _DISCARD:
            return value, pos


def _skip_ws(text: str, pos: int) -> int:
    n = len(text)
    while pos < n:
        c = text[pos]
        if c in _WS:
            pos += 1
        elif c == ";":
            while pos < n and text[pos] != "\n":
                pos += 1
        else:
            break
    return pos


def _parse(text: str, pos: int) -> tuple[object, int]:
    if pos >= len(text):
        raise EdnError("unexpected end of input", pos)
    c = text[pos]
    if c == "{":
        return _parse_map(text, pos + 1)
    if c == "[":
        return _parse_seq(text, pos + 1, "]")
    if c == "(":
        return _parse_seq(text, pos + 1, ")")
    if c == '"':
        return _parse_string(text, pos + 1)
    if c == "#":
        return _parse_dispatch(text, pos + 1)
    if c == "\\":
        return _parse_char(text, pos + 1)
    return _parse_atom(text, pos)


def _parse_map(text: str, pos: int) -> tuple[dict, int]:
    items = []
    item_starts: list[int] = []
    while True:
        pos = _skip_ws(text, pos)
        if pos >= len(text):
            raise EdnError("unterminated map", pos)
        if text[pos] == "}":
            break
        item_start = pos
        value, pos = _parse(text, pos)
        if value is _DISCARD:
            continue
        items.append(value)
        item_starts.append(item_start)
    if len(items) % 2:
        raise EdnError("map has odd number of forms", pos)
    for item_index, key in enumerate(items[::2]):
        try:
            hash(key)
        except TypeError as exc:
            raise EdnError(
                "unhashable map key", item_starts[item_index * 2]
            ) from exc
    return dict(zip(items[::2], items[1::2], strict=True)), pos + 1


def _parse_seq(text: str, pos: int, closer: str) -> tuple[list, int]:
    items: list = []
    while True:
        pos = _skip_ws(text, pos)
        if pos >= len(text):
            raise EdnError("unterminated sequence", pos)
        if text[pos] == closer:
            return items, pos + 1
        value, pos = _parse(text, pos)
        if value is _DISCARD:
            continue
        items.append(value)


def _parse_string(text: str, pos: int) -> tuple[str, int]:
    out: list[str] = []
    n = len(text)
    while pos < n:
        c = text[pos]
        if c == '"':
            return "".join(out), pos + 1
        if c == "\\":
            if pos + 1 >= n:
                break
            e = text[pos + 1]
            if e == "u":
                char, pos = _parse_unicode_escape(text, pos)
                out.append(char)
            elif e in _ESCAPES:
                out.append(_ESCAPES[e])
                pos += 2
            else:
                raise EdnError(f"unsupported escape '\\{e}'", pos)
        else:
            out.append(c)
            pos += 1
    raise EdnError("unterminated string", pos)


_HEX_DIGITS = set("0123456789abcdefABCDEF")


def _parse_hex4(text: str, pos: int) -> int:
    """Parse exactly 4 hex digits starting at pos (pos is the first hex digit,
    i.e. just past a `\\u`). Checked digit-by-digit rather than handed to
    int(chunk, 16): that builtin also accepts signs, surrounding whitespace,
    and underscore separators, which would smuggle malformed escapes through
    (or overflow chr() below into a raw, uncaught ValueError)."""
    chunk = text[pos : pos + 4]
    if len(chunk) != 4 or any(c not in _HEX_DIGITS for c in chunk):
        raise EdnError("invalid unicode escape", pos)
    return int(chunk, 16)


def _parse_unicode_escape(text: str, pos: int) -> tuple[str, int]:
    """pos points at the backslash of a \\uXXXX escape; returns (char, new_pos)."""
    escape_start = pos
    cp = _parse_hex4(text, pos + 2)
    pos += 6
    if 0xD800 <= cp <= 0xDBFF:  # high surrogate: must be paired with a low surrogate
        if text[pos : pos + 2] != "\\u":
            raise EdnError("lone surrogate escape", escape_start)
        low = _parse_hex4(text, pos + 2)
        if not (0xDC00 <= low <= 0xDFFF):
            raise EdnError("lone surrogate escape", escape_start)
        combined = 0x10000 + (cp - 0xD800) * 0x400 + (low - 0xDC00)
        return chr(combined), pos + 6
    if 0xDC00 <= cp <= 0xDFFF:  # low surrogate with no preceding high surrogate
        raise EdnError("lone surrogate escape", escape_start)
    return chr(cp), pos


def _parse_dispatch(text: str, pos: int) -> tuple[object, int]:
    if pos >= len(text):
        raise EdnError("unexpected end of input", pos)
    if text[pos] == "{":  # set literal #{...}
        return _parse_seq(text, pos + 1, "}")
    if text[pos] == "_":  # discard form #_: consume exactly one form, produce nothing
        _, pos = _parse_form(text, pos + 1)
        return _DISCARD, pos
    start = pos
    while pos < len(text) and text[pos] not in _WS and text[pos] not in '{[("':
        pos += 1
    tag = text[start:pos]
    value, pos = _parse_form(text, pos)
    return Tagged(tag, value), pos


def _parse_char(text: str, pos: int) -> tuple[str, int]:
    start = pos
    while pos < len(text) and text[pos] not in _WS and text[pos] not in '()[]{}"':
        pos += 1
    token = text[start:pos]
    if len(token) == 1:
        return token, pos
    if token in _NAMED_CHARS:
        return _NAMED_CHARS[token], pos
    raise EdnError(f"unsupported character literal '\\{token}'", start)


def _parse_atom(text: str, pos: int) -> tuple[object, int]:
    start = pos
    n = len(text)
    while pos < n and text[pos] not in _WS and text[pos] not in '()[]{}";':
        pos += 1
    token = text[start:pos]
    if not token:
        raise EdnError("unexpected character", pos)
    if token == "nil":
        return None, pos
    if token == "true":
        return True, pos
    if token == "false":
        return False, pos
    if token[0] == ":":
        return token, pos
    try:
        return int(token), pos
    except ValueError:
        pass
    try:
        return float(token), pos
    except ValueError:
        pass
    return token, pos  # bare symbol, kept as its string
