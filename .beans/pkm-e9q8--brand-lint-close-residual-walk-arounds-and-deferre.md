---
# pkm-e9q8
title: 'Brand lint: close residual walk-arounds and deferred minors'
status: todo
type: task
created_at: 2026-10-17T21:12:42Z
updated_at: 2026-10-17T21:12:42Z
---

Follow-up to pkm-zv2s (brand check). Found by the final reviews and parked under the one-fix-wave rule.

## Plugin gaps in web/tooling/eslint-plugin-brands (Important first)
- [ ] Predicate exemption launders: `function isUid(x: BlockUid | string): x is BlockUid` lints clean (index.mjs predicate exemption). Exempt only when no member of the declared type is a strict supertype of the narrowed type.
- [ ] Overload signatures mint: `function p(s: string): BlockUid; function p(s: string): string {...}` passes tsc and lint. For a non-declare overload, report brands in its return type that the implementation's return type lacks (also class method overloads).
- [ ] Launder variants pass: `<T extends string>(x): T { return x as T }`, `<T extends {}>`, `as T & {}`, `as T[]`, `as { v: T }`, `as Promise<T>`. Treat a type parameter whose constraint carries no brand but admits a brand's base as laundering, inside composites too.
- [ ] Regression: `{} as Record<BlockUid, number>` / `Partial<Record<BlockUid, 1>>` no longer reported; walk index-info keyType too (also catches `{ [k: BlockUid]: 1 }`).
- [ ] Ambient declarations nested in `declare global`/`declare namespace`, `declare` class fields; rule 1 on TSCallSignatureDeclaration/TSConstructSignatureDeclaration; function-type assertion targets.
- [ ] Opt-out covers every site on its line; stale opt-outs unreported (server brandlint too).

## Server brandlint
- [ ] Aliased brand imports (`BlockUid as U`), `map(BlockUid, xs)` not caught; NewType scan is column-0 bare-name only (misses typing.NewType, annotated, indented); staged mode reads working-tree registry.
- [ ] Non-union generic mentioning the brand passes loosely (`uid: dict[str, BlockUid]`).
- [ ] self.x attributes, class fields under if, functional TypedDict/NamedTuple unchecked.
- [ ] No check that MINT_SITES / CAST_SITES / TEST_SUPPORT / OPT_OUT_FILES paths still exist or still mint.

## Vocabulary and data
- [ ] rows.py `latest_seq` Row key orphaned (dead vocabulary).
- [ ] CLIENT_KEYS has no literal domains: replay_kind ('block'|'page'), has_pre/present/text_changed (0|1).
- [ ] columns.test.ts reads any non-INTEGER column type as text.
- [ ] refs.canonical_daily_title(day: str) mints CanonicalTitle from any string; take a date.
- [ ] Tombstone validation asymmetric (wire trusted vs deferred_block_tombstones parsed and silently dropped); blockRefStore.resolve drops non-uid keys silently; add warn + tests.
- [ ] registry header 'declaring file always allowed' holds only on the server; ids.ts imports TicketId from sync/opQueue.

## Tests and tidy
- [ ] test_backlinks_left_join_missing_page misnamed (no LEFT JOIN exists); test_either_brand_of_a_two_brand_name_satisfies_it misnamed.
- [ ] rawread.read used for vocabulary-key reads in server tests; docstring overstates; test_database sets private _check_rows; stray blank lines in three tests.
- [ ] uidOf has ~5 call sites vs ~300 hand-written tuid- literals; decide helper vs literal norm.
- [ ] response_model= declared inconsistently on three handlers; remedy text MODULES_SHOWN truncation; remedy fallback invites registry growth.
