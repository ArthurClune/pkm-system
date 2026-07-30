---
# pkm-y3rr
title: Assistant batch write confirmation shows 0 operations
status: completed
type: bug
priority: high
created_at: 2026-07-30T20:02:30Z
updated_at: 2026-07-30T20:07:12Z
---

The embedded assistant's write-approval card renders `batch: 0 operation(s)` and
nothing else for every `batch` call, so the user is asked to approve a
destructive multi-op write with no visible detail.

## Cause

`ops_preview` in `server/src/pkm/assistant/policy.py` reads
`tool_input.get("ops")`, but the MCP tool signature is
`def batch(commands: list[dict])` (`server/src/pkm/mcp/server.py:126`) and each
item is `{"command": ..., "params": {...}}`, not `{"op": ...}`. The key never
matches, so the list is always empty.

`test_assistant_policy.py::test_ops_preview_batch_lists_ops` passes
`{"ops": [...]}` -- a shape the tool cannot emit -- so the suite passed against
the bug.

## Evidence

Verified live 2026-07-30 against a scratch server on 8975 with the real harness:
the whole chain (can_use_tool -> confirm_request over SSE -> POST /confirm ->
batch applied -> tool_finished -> turn_done) works and the write lands
correctly. Only the preview text is wrong. Replaying a real captured payload
through `ops_preview` reproduces `batch: 0 operation(s)`.

Not a rare path: across the eleven assistant transcripts in
`~/.claude/projects/-Users-arthur--config-pkm-app-server/`, `batch` is the verb
the assistant picks for almost every write (four conversations used it, one of
them three times; only one used `update_block`). Confirms have already been
approved against a blank preview.

`save_note`/`update_block`/`upload_asset` are unaffected -- they fall through to
the generic `f"{short}({args})"` branch, which dumps every argument.

## Plan

- [x] Failing test: `ops_preview("batch", ...)` with the real
      `{"commands": [{"command": ..., "params": {...}}]}` shape must list each op
- [x] Failing test: an unrecognised batch input shape must still show its
      contents, never an empty list
- [x] Fix `ops_preview` to read `commands` and render command + params per line
- [x] Fall back to the generic dump-everything rendering when no recognisable
      list is found, so a future signature change degrades to verbose, not silent
- [x] Correct `test_ops_preview_batch_lists_ops` to the real payload shape
- [x] Full server verification (pytest, pyrefly, ruff)
- [x] Check whether docs/SECURITY.md's "Embedded assistant" section needs a note

## Summary of Changes

`ops_preview` now reads `commands` (the real `mcp.server.batch` parameter) and
renders one line per operation as `<command>: <params>`, via a new
`_batch_lines` helper. Any `batch` payload that is not a non-empty list under
that key falls through to the generic dump-every-argument branch, so a future
signature change degrades to verbose rather than to a blank card.

`test_ops_preview_batch_lists_ops` now uses the real
`{"commands": [{"command", "params"}]}` shape, and a new
`test_ops_preview_batch_never_silently_empty` pins the fallback: an
unrecognised shape must not render "0 operation(s)".

No web change was needed -- `AssistantPanel`'s `ConfirmCard` already renders the
preview in a `<pre>` (`white-space: pre-wrap`) and collapses past 300 chars
behind "Show full preview".

docs/SECURITY.md: added the never-silently-empty invariant to the write-gating
bullet (with this bug as the cautionary tale, and the instruction to check
`ops_preview` against a live payload rather than its unit test), and corrected
the turn-cancellation bullet, which claimed a cleanup promptness the 2026-07-30
incident disproved -- disconnect *detection* is unbounded while a confirm is
parked. Cross-referenced pkm-mbcc.

## Verification

- `uv run pytest -q`: 916 passed, coverage 95.86% (gate 95%)
- `uv run pyrefly check`: 0 errors; `uv run ruff check`: clean
- Live, real harness, scratch server on 8975 (prod DB untouched, mtime
  unchanged): the assistant issued a 4-op batch and the confirm card showed
  `batch: 4 operation(s)` with the delete and all three creates in full;
  approving applied it and the page ended in the expected state. The same script
  against the pre-fix code showed `batch: 0 operation(s)`.
- Replaying the real captured payload from the 2026-07-30 stuck conversation now
  renders `batch: 2 operation(s)` with the delete and the outline (4077 chars,
  bounded by the existing 4000-per-value clip).
