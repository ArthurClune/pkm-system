---
# pkm-xlah
title: Pausing mid page-ref autocomplete creates partial pages
status: in-progress
type: bug
priority: high
created_at: 2026-07-19T15:35:25Z
updated_at: 2026-07-19T15:44:24Z
---

Typing [[How LLM (auto-pair closes to [[How LLM]]), then pausing >500ms, creates page 'How LLM' even though the user was still typing toward 'How LLMs Work'.

Root cause: useOutline's 500ms TEXT_DEBOUNCE flushes the draft mid-autocomplete; the server's ReindexRefs effect (ops_apply.py) does get_or_create_page for every ref in the saved text, so transient half-typed refs materialise as pages. Same applies to #tag tokens mid-word.

Fix: defer the debounced flush while the caret sits inside an in-progress [[ ref / #tag token (the page-creating autocomplete contexts). Explicit commit points — blur, structural edits, undo, tab-hidden — still flush, so the data-loss window is unchanged in practice.

## Todo
- [x] Pure helper holdsDraftFlush(ctx) in outline/autocomplete.ts + tests
- [x] OutlineHandlers.onDraftChange carries holdFlush; BlockInput passes it from the fresh ac context
- [x] useOutline: held drafts do not arm the debounce timer (blur/structural/visibility flushes unchanged) + tests
- [x] pnpm verify green
- [x] E2E regression test (edit.spec.ts, pkm-xlah) — verified red against unfixed code

## Summary of Changes

- `web/src/outline/autocomplete.ts`: new pure helper `holdsDraftFlush(ctx)` — true while the caret is mid `[[`-ref or `#tag` token (the page-creating contexts); slash commands never hold.
- `web/src/components/EditableBlockTree.tsx`: `OutlineHandlers.onDraftChange` gains optional `holdFlush`; BlockInput passes it from the freshly derived autocomplete context (onChange + key-edit paths).
- `web/src/outline/useOutline.ts`: a held draft clears any armed debounce timer and does not re-arm it; the draft stays pending and still flushes at every explicit commit point (blur, structural edits, undo, tab-hidden).
- Tests: unit (holdsDraftFlush, component hold flag, useOutline.draftHold.test.tsx debounce behaviour) + E2E in edit.spec.ts proving the partial page 404s server-side mid-pause and only the completed title becomes a page.
