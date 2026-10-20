---
# pkm-9hn0
title: Backlink chips mix canonical and padded ref titles under the plain-space flag
status: completed
type: bug
priority: normal
created_at: 2026-10-19T15:59:04Z
updated_at: 2026-10-20T10:15:14Z
---

## Symptom

Under the plain-space title flag (active in production), on page `AI`:

- a backlink written `[[ AI ]]` shows the page itself as a chip (" AI (1)")
- `[[ML]]` and `[[ML ]]` show as two identical-looking `ML (1)` chips
  instead of one `ML (2)`
- including `ML` hides the `[[ML ]]` item; excluding `ML` leaves it shown

## Cause

`BacklinksSection` calls `chipCounts(visible, [title, ...filter.include,
...filter.exclude])` with the canonical page title, but `itemRefTitles`
(`extractRefs` -> `normalizeRefTitle`) yields normalized titles straight
from block text, which keep boundary U+0020. One `Set<string>` mixes the
two kinds; `applyFilter` and `toggleChip` compare the same way. The server
indexes `[[ AI ]]` as a ref to `AI`, so such a block is a backlink of `AI`.
With the flag off, padded titles are distinct pages and this is correct.

## Repro

A `backlinkFilter` vitest: chips for items `[[ AI ]]`, `[[ML]]`,
`[[ML ]]` on page `AI` come out `[' AI ', 'ML', 'ML ']`; expected
`['ML' (2)]`. Written during the pkm-hc95 survey (2026-10-19); the test
file is kept, uncommitted, in docs/superpowers/handoffs/title-bug-repros/.

## Fix direction

Canonicalize ref titles before counting or comparing (as
`canonicalizeTitle` does, which needs the live flag on the SPA side: replica
meta `titleReader`), so every chip and filter entry is a CanonicalTitle.
pkm-hc95's title naming will make `Chip.title`/`FilterState` say which kind
they hold.

- [x] failing test
- [x] canonicalize chip titles
- [x] troubleshooting.md row

## Summary of Changes

The main thread now keeps a copy of the plain-space title flag (sync/titleCanonicalization.ts). It is seeded from ReplicaInit and updated from every snapshot and changes payload replicaSync receives. It defaults to off, and an online-only tab, where the replica is unusable, stays off. backlinkFilter canonicalizes the ref titles it extracts, and re-reads filter entries, with that reader, so chips, filters and the page's own title compare as CanonicalTitle. One pure TitleReader constructor (replica/titles.ts titleReaderFor) now serves both the worker and the main thread. Docs: a troubleshooting.md row and a note in sync-and-offline.md. Checks: the web verify gate, perf (frontend: no change) and the web sync property suite pass.
