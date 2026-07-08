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
    pass


@dataclass(frozen=True)
class Tagged:
    tag: str
    value: object


def parse_edn(text: str) -> object:
    value, pos = _parse(text, _skip_ws(text, 0))
    if _skip_ws(text, pos) != len(text):
        raise EdnError(f"trailing data at offset {pos}")
    return value


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
        raise EdnError("unexpected end of input")
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
    while True:
        pos = _skip_ws(text, pos)
        if pos >= len(text):
            raise EdnError("unterminated map")
        if text[pos] == "}":
            break
        value, pos = _parse(text, pos)
        items.append(value)
    if len(items) % 2:
        raise EdnError("map has odd number of forms")
    try:
        return dict(zip(items[::2], items[1::2], strict=True)), pos + 1
    except TypeError as e:
        raise EdnError("unhashable map key") from e


def _parse_seq(text: str, pos: int, closer: str) -> tuple[list, int]:
    items: list = []
    while True:
        pos = _skip_ws(text, pos)
        if pos >= len(text):
            raise EdnError("unterminated sequence")
        if text[pos] == closer:
            return items, pos + 1
        value, pos = _parse(text, pos)
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
                out.append(chr(int(text[pos + 2 : pos + 6], 16)))
                pos += 6
            else:
                out.append(_ESCAPES.get(e, e))
                pos += 2
        else:
            out.append(c)
            pos += 1
    raise EdnError("unterminated string")


def _parse_dispatch(text: str, pos: int) -> tuple[object, int]:
    if pos >= len(text):
        raise EdnError("unexpected end of input")
    if text[pos] == "{":  # set literal #{...}
        return _parse_seq(text, pos + 1, "}")
    if text[pos] == "_":  # discard form #_
        _, pos = _parse(text, _skip_ws(text, pos + 1))
        return _parse(text, _skip_ws(text, pos))
    start = pos
    while pos < len(text) and text[pos] not in _WS and text[pos] not in '{[("':
        pos += 1
    tag = text[start:pos]
    value, pos = _parse(text, _skip_ws(text, pos))
    return Tagged(tag, value), pos


def _parse_char(text: str, pos: int) -> tuple[str, int]:
    start = pos
    while pos < len(text) and text[pos] not in _WS and text[pos] not in '()[]{}"':
        pos += 1
    token = text[start:pos]
    return _NAMED_CHARS.get(token, token[:1]), pos


def _parse_atom(text: str, pos: int) -> tuple[object, int]:
    start = pos
    n = len(text)
    while pos < n and text[pos] not in _WS and text[pos] not in '()[]{}";':
        pos += 1
    token = text[start:pos]
    if not token:
        raise EdnError(f"unexpected character at offset {pos}")
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
