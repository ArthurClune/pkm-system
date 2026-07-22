# Unlinked Reference Link Button Design

**Bean:** pkm-965i  
**Date:** 2026-07-22  
**Status:** Approved

## Goal

Add a **Link** action to every result in a page's Unlinked References section. For safely transformable results, the action converts one unlinked mention into a canonical page reference without opening the source page for editing, then removes the result from Unlinked References and refreshes Linked References. A result that cannot be transformed safely remains unchanged and reports why.

For a page titled `ACME`:

- `Acme created the jumbotron` becomes `[[ACME]] created the jumbotron`.
- `[A study](https://acme.com/study.md) shows great things` becomes `[A study](https://acme.com/study.md) shows great things #[[ACME]]`.

Page-title matching is case-insensitive because unlinked-reference discovery can return case variants. The inserted reference always uses the canonical, case-sensitive page title.

## Scope

This feature changes the web client only. It uses the existing `update_text` sync operation and existing page and unlinked-reference read APIs. It does not add a dedicated mutation endpoint, a new operation type, or a new server response shape.

## Text Transformation Core

Add a Functional Core module that accepts block text and the canonical page title and returns either transformed text or a no-safe-match result.

The core scans syntax-aware spans so it does not corrupt existing references or markup. Matching is a case-insensitive literal title match. For titles beginning or ending in an alphanumeric character, the corresponding edge must not be embedded inside a larger alphanumeric word.

The transformation precedence is:

1. Find the first matching plain-text occurrence outside existing page references, tags, block references, inline code, fenced code, and Markdown links.
2. Replace only that occurrence with `[[Canonical Page Title]]`.
3. If no eligible plain occurrence exists, but the title occurs in a Markdown link's visible label or destination URL, preserve the entire Markdown link and append ` #[[Canonical Page Title]]` to the end of the block.
4. If both a plain occurrence and a Markdown-link match exist, transform the plain occurrence.
5. If no safe occurrence exists, return a no-safe-match result and do not enqueue a write.

Only one reference is added per click. Existing page-reference and tag spans are never rewritten. The scanner should reuse or extract existing grammar helpers where practical rather than implementing an unrelated parser.

## Write and Concurrency Flow

`UnlinkedSection` remains an Imperative Shell and uses `useSync()`:

1. On click, transform the result's displayed text with the pure core.
2. If no safe transformation is available, retain the result and show `No linkable occurrence found.`
3. Enqueue one `update_text` operation containing the block UID, transformed text, and the SHA-256 hash of the displayed source text as `base_text_hash`.
4. Disable only that result's button and label it `Linking…` while the action is pending.
5. After durable local persistence succeeds, optimistically remove the result, remove an empty source-page group, and decrement the displayed unlinked total. The consumed pagination offset does not move backward.
6. After server delivery succeeds, request a Linked References refresh.

The replica queue currently derives `base_text_hash` from its latest local copy for every `update_text`. Change it to derive a hash only when the operation does not already provide one. Normal editor writes therefore keep their existing behavior, while this action preserves the hash of the unlinked snapshot. If another edit changed the block after that snapshot, the server rejects the stale write instead of accepting replacement text derived from old content.

Offline-capable editing remains supported. Durable local acceptance may hide the unlinked result while delivery is pending; the Linked References refresh waits for server acknowledgement. On a terminal delivery failure, restore the result, display a retryable error, and allow the existing sync repair flow to restore authoritative replica state.

## Reference-Section Refresh

`PageView` coordinates the two otherwise independent reference sections with a refresh generation counter:

- `UnlinkedSection` calls `onLinked` only after successful server delivery.
- `PageView` increments the Linked References refresh generation.
- `BacklinksSection` reacts by fetching fresh backlink data and replacing, rather than merging into, its stale snapshot.
- With the filter panel closed, refresh the first source-page batch. The just-edited source page has a new update time and should be included in that batch.
- With the filter panel open, reload all source-page batches so filter candidates and counts remain truthful.
- Preserve the current filter selections and panel state.
- If refresh fails, keep the previously displayed backlinks and expose the failure with a refresh-specific Retry action using the section's existing error/button conventions. The successful block edit is not undone.

## User Interface

Each unlinked-reference card displays a compact secondary **Link** button beside its text. Existing backlink card layout and secondary-button styles should be reused where possible.

- Disable the button when `sync.canEdit` is false.
- Expose `sync.readOnlyReason` as the disabled button's tooltip when available.
- Track pending and error state per block UID so one action does not disable unrelated results.
- Prevent duplicate clicks while a write is pending.
- Keep errors close to the affected result and keep the action retryable.

## FCIS Boundaries

- The syntax-aware transformation and match classification are Functional Core behavior.
- React state, API reads, sync enqueueing, write-ticket handling, and cross-section refresh coordination remain in Imperative Shell components.
- The queue's decision to preserve an explicit hash is deterministic core behavior within the existing queue boundary; persistence and optimistic application remain imperative.

## Testing

### Transformation unit tests

Cover:

- canonical output casing from differently cased source text;
- first plain occurrence only;
- multi-word titles and word boundaries;
- Markdown label and destination URL matches;
- plain-over-Markdown precedence;
- preservation of Markdown links;
- existing references and tags;
- inline and fenced code;
- no-safe-match results.

### Component tests

Extend the reference-section tests to cover:

- Link button rendering and read-only state;
- per-item `Linking…` state;
- the emitted `update_text` operation and snapshot hash;
- optimistic result removal and empty-group cleanup;
- local persistence and delivery failures;
- successful refresh notification;
- no-safe-match errors;
- backlink refresh replacement, pagination behavior, and filter preservation.

### Queue regression tests

Verify that an explicit `base_text_hash` survives queue augmentation and that an ordinary update without a supplied hash still captures the current replica text hash.

### End-to-end tests

Through the running UI:

1. Link a differently cased plain mention and verify the canonical text is persisted, the result leaves Unlinked References, and it appears in Linked References.
2. Link a Markdown-label or URL match and verify the Markdown is preserved with a canonical tag appended, followed by the same section transition.

Run `cd web && pnpm verify`. Server runtime behavior is unchanged, but final repository verification also runs the required server tests, type check, and lint commands.

## Non-goals

- Linking every occurrence in one click.
- Editing Markdown link labels or destinations.
- Adding server-provided match offsets or classifications.
- Adding a semantic `link_reference` operation or dedicated mutation endpoint.
- Refactoring unrelated backlink or editor behavior.
