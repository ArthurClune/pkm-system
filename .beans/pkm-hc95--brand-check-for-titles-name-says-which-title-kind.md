---
# pkm-hc95
title: 'Brand check for titles: name says which title kind'
status: completed
type: task
priority: normal
created_at: 2026-10-17T15:30:18Z
updated_at: 2026-10-20T12:03:54Z
---

The brand check (pkm-zv2s) registers names like `uid` and `page_id` that
must carry their brand, but leaves `title` out: a `title` parameter is
variously raw user text, NormalizedTitle or CanonicalTitle, and the web
alone has about 99 `title: string` sites.

Decide how titles get the same treatment: rename parameters so the name
says which kind they hold (e.g. `raw_title` / `canonical_title`), then
register those names with the brand check. Survey server and web first;
count the sites per kind before choosing names.

## Decisions (2026-10-19)

The survey found ~160 server and ~150 web title-named sites outside tests.
`title` carries all three kinds plus non-page titles. Arthur ruled:
register bare `title` too; add a `RawTitle` brand; work in two branches.
Spec: docs/superpowers/specs/2026-10-19-title-brands-design.md.
Plan (branch 1): docs/superpowers/plans/2026-10-19-title-brands-1.md.

Bugs the survey found, filed separately: pkm-ebkf, pkm-9hn0.

- [x] survey and decide names
- [x] branch 1: RawTitle, wire fields, kind-specific names (feat/title-brands-1)
- [x] branch 2: bare `title` (feat/title-brands-2; plan docs/superpowers/plans/2026-10-20-title-brands-2.md). Ruled 2026-10-20: rename CurrentWorkSection.title to heading and the GoodLinks title to article_title.

Follow-ups found in branch 1: pkm-aa5q (pyrefly lets a plain str reach a
branded pydantic field at construction), pkm-mqma (web/tooling is not
type-checked). Branch 2 must also settle the wire `title` fields that are
not page titles (GoodLinks, CurrentWorkSection) and the route path/query
`title` params.

## Summary of Changes

Branch 1 (feat/title-brands-1): the RawTitle brand atop CanonicalTitle ⊂ NormalizedTitle ⊂ RawTitle; raw title request fields; the kind-specific names registered.

Branch 2 (feat/title-brands-2): bare `title` registered with the brand check on both sides, with teeth tests.
- Non-page titles renamed: CurrentWorkSection.heading and GoodLinks article_title on the wire (the local replica producer too); ConfirmDialog heading, RouteMeta.documentTitle, Settings heading in the app.
- Route path/query `title` params are RawTitle; each `title = read_title(db, title)` rebind split into `canonical_title`, pinned per route by a control-whitespace request.
- Inputs not yet a title are named `text` (normalizers, validators, title readers); test helpers minting a literal take `title_text`/`titleText`; fixtures read JSON through `fixtureText`/`fixtureRefs` rather than index reads.
- The outline session API stays RawTitle: it is keyed by the requested title until a read resolves the canonical one.
- Perf baselines re-recorded (the fixture hash changed with a type-only edit); no perf changes; property checks pass.
