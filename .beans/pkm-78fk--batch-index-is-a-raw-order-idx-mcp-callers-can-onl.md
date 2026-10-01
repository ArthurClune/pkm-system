---
# pkm-78fk
title: Batch index is a raw order_idx; MCP callers can only know positions
status: todo
type: bug
priority: low
created_at: 2026-10-01T20:49:39Z
updated_at: 2026-10-01T20:58:53Z
---

The CLI/MCP batch `index` param is used as an `order_idx`, verbatim (`server/src/pkm/batch.py`: `OrderIdx(p.index)` in `_batch_create` and `_batch_move`). But `order_idx` is sparse: deletes leave gaps, and 386 of 20,454 sibling groups in prod have them.

- The CLI help says "exact order_idx", and `--json` exposes the keys.
- The MCP `batch` tool description (`server/src/pkm/mcp/server.py`) only says `index?`. MCP reads are rendered markdown with no keys. So an MCP caller can only guess a *position*.

## Reproduction (from the pkm-la88 final review; not committed)

Seed `A@0, B@5, C@6`, then run a batch `create index=2 X`. The page reads `A, X, B, C`. A caller who meant "third child" expected `A, B, X, C`.

```python
def test_batch_index_is_an_order_key_not_a_position(run, pkm_client):
    seed = [{"command": "create", "params": {"page": "Gappy2", "text": t, "index": i}}
            for t, i in (("A", 0), ("B", 5), ("C", 6))]
    assert run("batch", stdin=json.dumps(seed)) == 0
    assert run("batch", stdin=json.dumps([{"command": "create", "params": {
        "page": "Gappy2", "text": "X", "index": 2}}])) == 0
    texts = [n.text for n in pkm_client.get_page("Gappy2").blocks]
    assert texts == ["A", "B", "X", "C"]   # FAILS: ['A', 'X', 'B', 'C']
```

(`run` is the `server/tests/test_cli_main_write.py` fixture.)

## Related: mixed indexed and appended creates in one batch

On page `[A, B]`, the single batch `{create X index 0}, {create Y}` gives `X, A, Y, B`. The append lands before the page's original last block. The help text (`cli/main.py`, the `create_at` docstring, `cli-and-mcp.md`) only says the two may "interleave". `create_at` leaves the planner's append counter untouched.

## Fix direction

- Decide what `index` means. A position (an MCP caller can only know positions) is the likely answer, but it changes the CLI contract: check the existing CLI/skill users of `index`.
- Keeping it an order key only works for MCP if the keys are exposed in MCP reads, or if MCP use is limited to `index: 0` (first) and omitted (append). A value in between is a guess that is right only when that parent's keys have no gaps. Recommendation: position.
- If it means a position: convert it in the planner with an `order_idx_at_position(siblings, k)` helper, mirroring the web's `orderIdxAfterPosition`. That's `siblings[k].order_idx`, or last + 1 past the end. Off-page parents are dense from 0.
- Either way, fix the help/MCP description, and have `create_at` advance the append counter (to `index + 1` when it is beyond the counter, and bump it when `index` is below it).

## Plan

- [x] Decide index semantics (Arthur)
- [ ] Red tests: the gap case and the mixed-batch case
- [ ] Fix planner / `create_at` counter
- [ ] Update CLI help, MCP description and `cli-and-mcp.md`

## Decision (Arthur, 2026-10-01)

`index` is a position: 0-based among the parent's current children, with past-the-end meaning append. The planner converts it to an order key.
