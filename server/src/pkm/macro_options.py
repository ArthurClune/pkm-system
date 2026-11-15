# pattern: Functional Core
"""The ` | name: value` options after a {{query: ...}} or {{table ...}}
macro's head. web/src/grammar/macroOptions.ts mirrors this module; both are
held to shared/fixtures/macro_options_parity.json.

An option adds no refs: `refs.extract` scans the whole macro, so ref syntax
in an option value would become a ref. `options_refusal` keeps it out at
Save instead of teaching both extractors about options."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

View = Literal["table", "cards", "blocks"]
SortDir = Literal["asc", "desc"]

_SEPARATOR = " | "
_REFUSED = ("[[", "]]", "#", "|", "{", "}")


@dataclass(frozen=True)
class MacroOptions:
    view: View | None = None
    filter: str | None = None
    sort: tuple[str, SortDir] | None = None
    columns: tuple[str, ...] | None = None


def _segments(body: str) -> list[str]:
    """`body` cut at every ` | ` outside braces and outside [[ ]], so a page
    title holding ` | ` in a ref never splits."""
    out: list[str] = []
    brace = link = start = 0
    i = 0
    while i < len(body):
        two = body[i:i + 2]
        if two == "[[":
            link += 1
            i += 2
            continue
        if two == "]]":
            link = max(link - 1, 0)
            i += 2
            continue
        ch = body[i]
        if ch == "{":
            brace += 1
        elif ch == "}":
            brace = max(brace - 1, 0)
        elif brace == 0 and link == 0 and body.startswith(_SEPARATOR, i):
            out.append(body[start:i])
            i += len(_SEPARATOR)
            start = i
            continue
        i += 1
    out.append(body[start:])
    return out


def split_macro_options(body: str) -> tuple[str, MacroOptions]:
    head, *rest = _segments(body)
    view: View | None = None
    filt: str | None = None
    sort: tuple[str, SortDir] | None = None
    columns: tuple[str, ...] | None = None
    for segment in rest:
        name, colon, raw = segment.partition(":")
        value = raw.strip()
        if not colon or not value:
            continue
        match name.strip().lower():
            case "view":
                match value:
                    case "table" | "cards" | "blocks":
                        view = value
            case "filter":
                filt = value
            case "sort":
                column, _, direction = value.rpartition(" ")
                if column.strip():
                    match direction:
                        case "asc" | "desc":
                            sort = (column.strip(), direction)
            case "columns":
                names = tuple(c.strip() for c in value.split(",") if c.strip())
                if names:
                    columns = names
    return head.strip(), MacroOptions(view, filt, sort, columns)


def normalise_macro_options(opts: MacroOptions) -> MacroOptions:
    """What `opts` reads back as after a save: every value trimmed, empty
    column names dropped, and a filter, sort or column list left with
    nothing omitted."""
    filt = opts.filter.strip() if opts.filter is not None else ""
    sort = None
    if opts.sort is not None and opts.sort[0].strip():
        sort = (opts.sort[0].strip(), opts.sort[1])
    names = tuple(c.strip() for c in opts.columns or () if c.strip())
    return MacroOptions(opts.view, filt or None, sort, names or None)


def format_macro_options(opts: MacroOptions) -> str:
    opts = normalise_macro_options(opts)
    parts: list[str] = []
    if opts.view is not None:
        parts.append(f"view: {opts.view}")
    if opts.filter is not None:
        parts.append(f"filter: {opts.filter}")
    if opts.sort is not None:
        parts.append(f"sort: {opts.sort[0]} {opts.sort[1]}")
    if opts.columns is not None:
        parts.append("columns: " + ", ".join(opts.columns))
    return "".join(_SEPARATOR + p for p in parts)


def options_refusal(opts: MacroOptions) -> str | None:
    """Why `opts` cannot be saved into a macro, or None. Names the first
    offending character so the message can say what to remove. Padding and
    empty values are not refused: `normalise_macro_options` absorbs them."""
    values: list[str] = []
    if opts.filter is not None:
        values.append(opts.filter)
    if opts.sort is not None:
        values.append(opts.sort[0])
    if opts.columns is not None:
        values.extend(opts.columns)
        for column in opts.columns:
            if "," in column:
                return f"A column name cannot contain ',': {column!r}"
    for value in values:
        for char in _REFUSED:
            if char in value:
                return f"A saved view cannot contain {char!r}: {value!r}"
    return None
