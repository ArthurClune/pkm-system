# pattern: Imperative Shell
"""Dump the macro-options parity fixture for the web's macro grammar:
uv run python -m pkm.macro_options_parity_dump \
    > ../shared/fixtures/macro_options_parity.json
web/src/grammar/macroOptions.ts must split, and format, exactly as
pkm.macro_options does. Guarded by
tests/test_macro_options_parity_fixture.py."""
from __future__ import annotations

import json
from typing import Any

from pkm.macro_options import (
    MacroOptions, format_macro_options, split_macro_options)

BODIES = (
    "{and: [[Book]]}",
    "{and: [[Book]]} | view: table | filter: -status:read"
    " | sort: Published desc | columns: Author, Reading Status",
    "table",
    "table | sort: Cache hit asc",
    "table | view: cards",
    "{and: [[Book]]} | view: blocks",
    "{and: [[Book]]}   |   view:   cards   |  sort:  Title   asc  ",
    "{and: [[Book]]} | colour: red",
    "{and: [[Book]]} | VIEW: Table | View: cards",
    "{and: [[Book]]} | view: cards | view: blocks",
    "{and: [[Book]]} | sort: Published sideways | view: table",
    "{and: [[Book]]} | sort: desc",
    "{and: [[Book]]} | columns: , A ,, B ,",
    "{and: [[Book]]} | columns: ,",
    "{and: [[Book]]} | filter: a: b",
    "{or: [[A | B]] [[C]]} | view: table",
    "{and: [[A | B]]} | sort: Title asc",
    "{and: [[Book]]}|view: table",
    "{and: [[Book]]} | view: table |",
    "[[A | B]] | view: cards",
    "[[A | B]] | view: cards | sort: T asc",
    "]] | view: cards",
    "a ]] b | view: cards",
    "{and: [[A | B}} | view: cards",
    "",
)


FORMAT_OPTIONS = (
    MacroOptions(),
    MacroOptions(view="table", filter="-status:read",
                 sort=("Published", "desc"), columns=("Author", "Status")),
    MacroOptions(filter=""),
    MacroOptions(filter="   "),
    MacroOptions(filter="  padded  "),
    MacroOptions(sort=("", "asc")),
    MacroOptions(sort=("  A  ", "desc")),
    MacroOptions(columns=()),
    MacroOptions(columns=("", "  ")),
    MacroOptions(columns=(" a", "", "b ")),
    MacroOptions(view="blocks", columns=("Reading Status",)),
)


def _options_json(opts: MacroOptions) -> dict[str, Any]:
    return {
        "view": opts.view,
        "filter": opts.filter,
        "sort": list(opts.sort) if opts.sort else None,
        "columns": list(opts.columns) if opts.columns is not None else None,
    }


def _case(body: str) -> dict[str, Any]:
    head, opts = split_macro_options(body)
    return {
        "body": body,
        "head": head,
        "options": _options_json(opts),
        "formatted": format_macro_options(opts),
    }


def fixture() -> dict[str, list[dict[str, Any]]]:
    assert MacroOptions() == split_macro_options("x")[1]
    return {
        "cases": [_case(b) for b in BODIES],
        "format_cases": [
            {"options": _options_json(o), "formatted": format_macro_options(o)}
            for o in FORMAT_OPTIONS],
    }


def main() -> int:
    print(json.dumps(fixture(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
