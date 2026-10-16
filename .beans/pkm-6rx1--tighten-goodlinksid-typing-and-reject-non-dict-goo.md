---
# pkm-6rx1
title: Tighten GoodlinksId typing and reject non-dict GoodLinks bodies
status: completed
type: bug
priority: normal
created_at: 2026-10-16T17:45:49Z
updated_at: 2026-10-16T17:50:04Z
---

GoodlinksGateway.link/content and goodlinks_href take str, so the 32-hex check before an id is interpolated into a request path is not type-checked. Gateway returns bare dict/Any, hiding two 500s: search() on a non-dict 2xx JSON body (AttributeError) and _link_payload on a link without url or a non-dict lookup body (KeyError/TypeError); both should be 503 GoodlinksUnavailable.

- [x] Gateway link/content and goodlinks_href take GoodlinksId
- [x] _json returns object; gateway rejects non-dict bodies with GoodlinksUnavailable
- [x] dict[str, object] downstream; missing url is GoodlinksUnavailable
- [x] Drop is_link_id
- [x] Tests, pyrefly, ruff

## Summary of Changes

- `GoodlinksGateway.link`/`.content` and `goodlinks_href` take `GoodlinksId`, so pyrefly rejects a raw str reaching a request path (checked with a mutant).
- `_json` returns `dict[str, object]` and raises `GoodlinksUnavailable` for a 2xx body that is not a JSON object; `search` drops non-object results.
- Routes read `id`/`url` through `_required_str`, so a link missing either is a 503, not a 500. `search_match` takes `Sequence[Mapping[str, object]]`.
- Removed test-only `is_link_id`; goodlinks.md and troubleshooting.md updated.
