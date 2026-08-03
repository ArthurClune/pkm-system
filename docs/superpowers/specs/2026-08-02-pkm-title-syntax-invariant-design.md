# PKM Page-Title Syntax Invariant Design

**Date:** 2026-08-02

**Status:** Approved in session

**Coordinator:** `pkm-mk87`

**Existing title bean:** `pkm-2ilw`

## Goal

Make page-title syntax explicit and consistent across the server, Python client,
CLI/MCP, importer, and offline replica. Page titles containing reference syntax
are invalid during normal operation. Imports remove reference markup while
preserving its visible text before rows are created.

This replaces the attempted closure-complete migration of nested page-title
references. Production was checked by the operator: there were no titles
containing `#`; one title contained `[[`/`]]` and was removed. The implementation
must not inspect or migrate production again.

## Title invariant

After existing control-whitespace normalization, a normal page title is invalid
if it contains any of:

- `#`
- `[[`
- `]]`

Boundary U+0020 handling remains independently gated by the plain-space title
migration. Blank-title behavior remains unchanged.

The invariant applies to:

- explicit page creation and rename;
- operation batches and page targets;
- page creation derived from references in block text;
- local/offline API and optimistic replica operations;
- imported titles after import-only sanitization;
- title-migration preflight for any legacy database.

Reads remain exact/activation-aware as already implemented. They do not need a
new rejection path for a legacy row; migration audit is responsible for making
such rows visible as blockers.

## Import-only sanitization

Imports preserve visible title text while removing reference markers:

```text
Project [[Acme]]                 -> Project Acme
Wrapper [[Outer [[Inner]]]]      -> Wrapper Outer Inner
Project #Acme                    -> Project Acme
Project #[[Acme]]                -> Project Acme
```

Sanitization is recursive for nested bracket references. It then applies the
existing control-whitespace normalization and import title handling. A malformed
unbalanced bracket form is refused rather than guessed. A result that is blank
is refused under the existing blank-title policy.

Sanitization occurs in a pure importer core before page rows are created.
Titles that sanitize to the same value use the importer’s deterministic
collision/merge path so blocks and references are preserved. The import report
records original and sanitized spellings and any resulting merge.

No interactive/API/offline write silently sanitizes forbidden syntax. Those
boundaries reject it.

## Migration behavior

The plain-space migration returns to its simpler boundary-space contract:

- replacement values are opaque;
- no recursive expansion of mapped rename targets;
- no nested enclosing-title closure or intermediate/final nested identity
  planning;
- survivor choice remains exact clean twin, otherwise lowest page ID;
- deterministic merge, snapshot, rewrite, digest, rollback, activation, and
  generation behavior remain.

Audit inventories all legacy titles with forbidden syntax as blockers. Blockers
carry a reason, at minimum:

- `all_space`
- `forbidden_syntax`

Apply refuses while any blocker exists. The audit response and human/JSON CLI
rendering identify the page and reason. This keeps invalid legacy data explicit
without inventing a migration rule for unsupported title syntax.

The migration rewriter restores simultaneous one-pass behavior with opaque
replacement values. Therefore an otherwise valid mapping target is never
recursively interpreted by the generic rename helper.

## Shared validation boundaries

Python and TypeScript use equivalent pure predicates and shared fixtures.
Imperative shells normalize, validate, and then persist or enqueue.

Expected error behavior:

- HTTP and local API writes return the existing validation-class response with a
  clear invalid-title detail;
- CLI/MCP inherit the server response;
- operation batches fail atomically;
- reference-derived invalid page creation rejects the containing write instead
  of creating a hidden identity;
- importer errors identify the original title and structural location;
- migration audit reports blockers without side effects.

The exact exception/model names are implementation-plan decisions, but there
must be one Python source of truth and one TypeScript parity implementation.

## Existing title work retained

The revised invariant does not change:

- audit-first authenticated migration API and digest-required CLI apply;
- atomic merge/reference/sidebar/FTS/journal behavior;
- activation metadata and generation rotation;
- server/offline activation-aware canonicalization;
- accepted metadata ordering and optimistic replay reconciliation;
- normalized read paths and truthful backlink limit metadata;
- importer migration reuse before publication;
- forced equal-cursor generation notification for metadata-only activation;
- fail-closed authoritative stored-title broadcasts;
- production-safety rule: no production migration and no port `8974` in tests.

## FCIS

Pure functional cores own:

- forbidden-title detection and reason classification;
- import title sanitization;
- blocker payload construction;
- Python/TypeScript fixture parity.

Imperative shells own:

- HTTP/CLI/local-operation error adaptation;
- database inventory and refusal;
- importer file/database/report orchestration;
- sync and optimistic operation persistence.

Every changed runtime file retains its FCIS declaration.

## Test strategy

Every behavior change follows RED/GREEN TDD.

Required coverage includes:

- Python and TypeScript fixture parity for valid and forbidden titles;
- create, rename, create-page, move, batch, CLI/MCP, and local/offline refusal;
- reference-derived page creation refusal with atomic rollback;
- import sanitization for bracket refs, nested refs, tags, tag-links,
  collisions, refs, blocks, report output, malformed syntax, and blank result;
- migration audit blocker reasons, digest sensitivity, side-effect-free audit,
  and apply refusal;
- ordinary opaque rename mapping regression;
- retained zero-group forced sync notification and fail-closed broadcast tests;
- generated OpenAPI/type synchronization and architecture documentation.

## Out of scope

- Supporting reference syntax inside stored page titles.
- Automatically repairing legacy invalid production titles.
- Running production title audit/apply.
- Broad ref-parser or title-system refactors unrelated to enforcing this
  invariant.
