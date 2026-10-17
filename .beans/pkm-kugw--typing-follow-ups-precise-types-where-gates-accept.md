---
# pkm-kugw
title: 'Typing follow-ups: precise types where gates accept loose ones'
status: completed
type: task
priority: normal
created_at: 2026-10-16T18:38:02Z
updated_at: 2026-10-17T15:02:40Z
---

Follow-ups from the strict-typing review (pkm-kj63). The gates pass, but some code satisfies them with a looser type than an existing one.

- [x] Replace `dict[str, object]` where a model or TypedDict exists: `ops_core.skip_report` / `AppliedBatch.skipped` (contracts `SkippedOp`); `routes_pages._resolve_ref_uids` / `_block_ref_texts` (`dict[BlockUid, BlockRefText]`); `notify.seq_frame` and `ws.Hub.broadcast` (`SeqFrame`). Routes returning `dict[str, object]` beside a `response_model` could return the model.
- [x] `importer/parse_export._heading` takes `int | None` but is fed Roam export data typed `dict[str, Any]`: narrow it like `_view_type` (behaviour change for malformed input; add a test).
- [x] `describe/core.request_payload -> dict[str, Any]`: no external API forces the nested Any; use a small TypedDict.
- [x] Third-party `Any` returns slip past every gate: `client/api._detail` calls `r.json().get(...)`, which raises AttributeError on a non-object JSON body (the GoodLinks bug class). Audit `.json()` call sites in server/src and assign to `object` before use.
