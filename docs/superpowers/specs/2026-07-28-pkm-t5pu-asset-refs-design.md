# pkm-t5pu: search_assets returns page/block context — design

**Date:** 2026-07-28
**Bean:** pkm-t5pu
**Status:** approved

## Problem

`GET /api/assets/search` (and therefore the assistant's `search_assets` MCP
tool and the CLI's asset search) returns only asset metadata — sha256,
filename, mime, size, url, description, status. There is no indication of
*where* an asset is used. The assistant can cite the bare `/assets/` URL but
must make a follow-up `get_page`/`search` round-trip to discover the
containing page or emit a `((uid))` block ref.

After pkm-hjcc this is an **efficiency** gap, not a capability gap: the model
finds refs on its own via extra tool calls. This bean removes those
round-trips by returning referencing-block context directly.

## Design

### Server lookup

New helper in `server/src/pkm/server/routes_assets.py`:

```python
def referencing_blocks(db, sha256: str) -> list[dict]:
    """All blocks whose text contains the asset's sha, via FTS5.
    unicode61 keeps a 64-hex sha as one token, so phrase_query(sha)
    is an exact-match lookup (same trick pkm-gdi5 uses client-side)."""
```

Implementation: `blocks_fts MATCH phrase_query(sha256)` joined
`blocks_fts f → blocks b ON b.rowid = f.rowid → pages p ON p.id = b.page_id`
(same join shape as `routes_pages.py` `get_unlinked`), selecting
`b.uid, p.title AS page_title`, ordered by `p.title, b.uid` for determinism.

**Uncapped.** If the user asks where an image is used, they get all refs;
silent truncation is worse than a long list, and in practice assets are
referenced from a handful of blocks. One FTS query per returned asset
(≤200 per request) is trivially cheap at personal scale.

The helper is deliberately standalone: pkm-jdu3's file browser needs the
same asset→block link check for its delete-warning and orphan detection,
and will import this function.

### Schema

In `server/src/pkm/server/response_models.py`:

```python
class AssetRef(BaseModel):
    uid: str
    page_title: str

class AssetSearchItem(BaseModel):
    ...existing fields...
    refs: list[AssetRef]
```

`search_assets` route attaches `refs` per asset. **Mandatory:** regenerate
`openapi.json` and `web/src/api/types.d.ts` and commit them with the change.
No web UI change (that's pkm-jdu3).

### Rendering

`render_assets` in `server/src/pkm/cli/render.py` gains one line per ref
after the description:

```
photo.jpg  (image/jpeg, 12345 bytes, described)
  /assets/<sha>/photo.jpg
  A cat on a windowsill.
  in [[Holiday 2026]] ((abc123))
  in [[July 26th, 2026]] ((def456))
```

Unreferenced assets render exactly as today (no ref lines).

### MCP docstring

Update the `search_assets` docstring in `server/src/pkm/mcp/server.py` to
say results include referencing blocks (`((uid))` + page title), so the
model cites directly from one call instead of round-tripping via
`get_page`. The `SYSTEM_PROMPT` in `assistant/policy.py` needs no change —
its citing rules already cover `((uid))` and asset URLs.

### Out of scope / already done

- The bean's drive-by ("SYSTEM_PROMPT says 'ten PKM verbs' but lists eleven
  tools") is already fixed — pkm-hjcc reworded it to "the PKM verbs exposed
  over MCP". Nothing to do.
- No pagination of refs, no ref counts, no web UI (pkm-jdu3).

## Testing (TDD)

Server route tests (`server/tests`):
- Asset referenced by a block → hit carries `refs` with correct `uid` and
  `page_title`.
- Unreferenced asset → `refs == []`.
- Asset referenced from blocks on multiple pages → all refs present,
  ordered by (page_title, uid).
- Sha embedded in a normal `![](/assets/<sha>/<file>)` URL inside block
  text is found (tokenizer behaviour, the load-bearing assumption).

Render tests:
- `render_assets` emits `in [[title]] ((uid))` lines; none for empty refs.

Verification before completion: `cd server && uv run pytest -q`,
`uv run pyrefly check`, `uv run ruff check`; `cd web && pnpm typecheck`
after types regen (full `pnpm verify` if anything web-side changes beyond
generated types).

## Implementation notes

- Worktree + branch per CLAUDE.md; delegate coding to subagents, main loop
  reviews.
- FCIS: `routes_assets.py` is Imperative Shell (query lives there);
  `render.py` change is Functional Core.
- Commit bean file with the change; complete bean with Summary of Changes.
