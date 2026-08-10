---
# pkm-3o1c
title: 'Unlinked references: Link fails when the only occurrence is inside a bare URL'
status: completed
type: bug
priority: normal
created_at: 2026-08-10T19:16:40Z
updated_at: 2026-08-10T19:21:05Z
---

On a page like 'AI Self Learning', the line 'Self-play for driving https://www.interconnects.ai/p/interviewing-eugene-vinitsky-on-self' shows in Unlinked references for page 'interconnects.ai', but the Link button errors with 'No linkable occurrence found.'

Root cause: linkUnlinkedReference (web/src/grammar/linkReference.ts) protects bare URL spans from in-place [[..]] wrapping (correct), but the append-a-tag fallback only fires for Markdown [label](dest) links. A title occurring only inside a bare URL therefore returns no-safe-match, even though a title inside a markdown link destination already gets the #[[title]] fallback.

Fix: extend the fallback so a candidate contained in a bare URL span (and not overlapping grammar-protected spans) appends #[[title]] at end of text, same as the markdown match.

## Todo

- [x] Failing unit test reproducing the interconnects.ai case
- [x] Implement bare-URL fallback in linkReference.ts
- [x] Update existing bare-URL tests pinned to no-safe-match
- [x] pnpm verify (web)
- [x] Check docs/architecture for staleness (frontend.md only lists the module; no behavior enumeration to update)

## Summary of Changes

- `web/src/grammar/linkReference.ts`: added `matchingBareUrl` and a shared `appendedTag` helper; a candidate occurrence contained in a bare URL span now appends `#[[title]]` at the end of the block (match: "url"), mirroring the existing markdown-link fallback. Candidates overlapping grammar-protected spans or any Markdown span are excluded, so inline-code URLs and Markdown image destinations still return no-safe-match.
- `web/src/grammar/linkReference.test.ts`: the four bare-URL tests pinned to no-safe-match now expect the appended tag; added the interconnects.ai reproduction, a trailing-whitespace separator case, and an inline-code guard.
- Full `pnpm verify` green (typecheck, lint, fcis, 2049 unit tests, build, 52 e2e).
