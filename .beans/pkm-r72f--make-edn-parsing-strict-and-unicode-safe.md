---
# pkm-r72f
title: Make EDN parsing strict and Unicode-safe
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:00:56Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 19).

## Context

**References:** `server/src/pkm/edn.py:97-113,120-141`

Unsupported string/character escapes can be silently changed, surrogate-pair escapes produce invalid Python strings, truncated Unicode escapes leak raw ValueError, and discard forms at collection ends are rejected. Silent text corruption is worse than a clear import failure.

**Direction:** Validate escape names and hex length, combine/reject surrogates correctly, normalize parser errors to EdnError, and model discard forms at collection-parser level.

## Tasks

- [x] Add unknown/truncated/lone-surrogate/supplementary-codepoint tests
- [x] Add collection-end discard tests
- [x] Reject unsupported forms without altering text

## Summary of Changes

`server/src/pkm/edn.py`:

- **String escapes**: unknown escape names (e.g. `\z`, `\/`) now raise `EdnError` instead of silently passing the letter through unchanged.
- **Unicode escapes**: `\uXXXX` is validated to have exactly 4 hex digits available (previously a truncated escape at end-of-string could parse a shorter hex chunk silently, e.g. `"\u00` at EOF returning codepoint 0 instead of erroring); invalid hex digits now raise `EdnError` instead of leaking a raw `ValueError` from `int(..., 16)`.
- **Surrogate pairs**: a high surrogate (`0xD800`-`0xDBFF`) must be immediately followed by a `\uXXXX` low surrogate (`0xDC00`-`0xDFFF`); the pair is combined into the correct supplementary codepoint via `chr()`. A lone high or low surrogate now raises `EdnError` instead of producing an unpaired-surrogate Python string.
- **Discard forms (`#_`)**: moved from "parse discard, then parse-and-return the next form inline" (which broke when `#_` was the last form before a collection's closing bracket, e.g. `[1 2 #_3]`) to a sentinel-based design: `_parse` returns a private `_DISCARD` marker for `#_` forms, and the map/sequence collection loops (`_parse_map`/`_parse_seq`) simply skip appending when they see it and continue the loop, so a trailing discard now correctly falls through to the closing-bracket check. A new `_parse_form` helper transparently resolves (possibly chained/nested) discards for every other calling context (top-level `parse_edn`, and a tagged literal's value) so the sentinel never leaks out as data.
- **Character literals** (`_parse_char`): a char-literal token that is neither a single character nor one of the four named chars (`newline`/`space`/`tab`/`return`) now raises `EdnError` instead of silently truncating to its first character (e.g. `\notachar` previously became `"n"`).

Tests added in `server/tests/test_edn.py` (TDD: written first, confirmed failing against the old implementation, then made to pass): unknown string escape, truncated/invalid `\u` escapes, lone high/low surrogate escapes, valid surrogate-pair combination to a supplementary codepoint (emoji), discard immediately before the close of a vector/list/set/map, chained nested discards, and an unsupported character-literal name.

Verification: `uv run pytest -q` (1038 passed, coverage 96.36%), `uv run pyrefly check` (0 errors), `uv run ruff check` (all checks passed) — all run from the worktree's `server/`.
