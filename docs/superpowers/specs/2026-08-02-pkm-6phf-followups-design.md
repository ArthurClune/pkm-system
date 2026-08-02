# pkm-6phf Follow-up Completion Design

**Date:** 2026-08-02  
**Scope:** Complete the four remaining open child beans under `pkm-6phf`: `pkm-ow62`, `pkm-6dg0`, `pkm-mlbh`, and `pkm-9jma`.

## Context

The original frontend-hardening epic is complete, but four low-priority follow-ups remain. Two are behavior fixes (single-flight Files pagination and trailing-slash route metadata), one completes adoption of the generated OpenAPI client, and one restores test ownership after `BlockInput` was extracted from `EditableBlockTree`.

The work will proceed in one isolated worktree with one focused commit per child bean. A single worktree avoids conflicts: `Files.tsx` belongs to both the pagination fix and API migration, while `BlockInput` API migration can affect request expectations in tests that are also being moved.

## Route metadata (`pkm-9jma`)

`paths.ts` will import `PAGE_ROUTE_PREFIX` from `routeMeta.ts` and use it when constructing page URLs. This makes route matching and page-link construction consume the same prefix rather than merely testing two hardcoded values for equality.

`routeMetaFor(pathname)` will normalize trailing slashes before looking up static metadata. Root (`/`) remains unchanged. One or more trailing slashes on a non-root pathname are removed, so `/files/` and `/settings/` receive the same labels and browser titles as their canonical forms. Dynamic page paths and unmatched paths remain absent from `ROUTE_META` and return `undefined`.

Tests will cover canonical routes, trailing-slash variants, root, and unmatched/dynamic routes. `useRouteTitle` coverage will prove the normalized metadata reaches the browser title effect.

## Files pagination (`pkm-ow62`)

`Files.loadMore` will gain a synchronous in-flight ref guard. The ref is required in addition to React state because two invocations can occur before a state-driven rerender disables the button. A mirrored state value will disable the visible Load more control while the request is active.

The lock will be acquired before reading the pagination offset or starting the request and released in `finally`. Existing generation checks remain authoritative for stale filter responses, and existing failure notices remain unchanged. The lock is specific to pagination; broad coordination of all Files toolbar operations is outside this follow-up.

A deferred-response regression test will invoke Load more twice rapidly, assert only one offset request starts, resolve it, and assert the returned page is appended exactly once. The test will also verify that the control is disabled while pending and available again afterward.

## Typed API boundary (`pkm-6dg0`)

Every remaining JSON API request will move from generic `apiFetch<T>(builtUrl, init)` calls to `apiGet`, `apiPost`, `apiPut`, or `apiDelete`. Calls will pass OpenAPI path templates and generated `path`, `query`, and `body` options. Response types will therefore come from generated `paths` rather than caller-selected generic arguments.

Raw `apiFetch` remains intentional only at transport boundaries:

- `api/typedClient.ts`, which implements the typed wrapper;
- `sync/assets.ts`, whose multipart `FormData` upload is outside the JSON-only typed client;
- transport dependency-injection seams that accept a fetch function rather than issue a concrete request.

An ESLint `no-restricted-imports` rule will reject importing `apiFetch` from `api/client` elsewhere. Narrow config overrides will permit the intentional modules. The lint configuration's own fixture tests and explanatory comments will be extended so the rule is mechanically verified rather than conventional.

Migration tests may update mocked transport expectations where typed construction intentionally adds an explicit method, uses a path template, or serializes query spaces as `+`. Runtime error behavior does not change because the typed client delegates to the existing transport and preserves offline dispatch, authentication handling, and `ApiError`/`OfflineError` behavior.

`sync/assets.ts` will not be converted. The hidden HTML form used for zip export also remains unchanged.

## BlockInput test ownership (`pkm-mlbh`)

A new `components/BlockInput.test.tsx` will directly render `BlockInput` through a narrow router/context harness. Tests owned by the focused input will move there: draft adoption, IME behavior, input keyboard policy, autocomplete and slash commands, reference navigation, key edits, paste/drop behavior, and date-picker behavior.

`EditableBlockTree.test.tsx` will retain tree-owned behavior: unfocused rendering, tree focus transitions, block selection, bullets and block menus, collapse/todo controls, fallback rendering, upload-input ownership across focus changes, tree/table integration, and other read-side behavior.

Test names and assertions will remain unchanged. Only imports and setup will change where direct `BlockInput` rendering requires a different harness. This is a test-organization change, not a production behavior change.

## Architecture and invariants

`docs/architecture/frontend.md` will record:

- static route metadata accepts canonical and trailing-slash pathnames;
- application JSON requests use `typedClient`, with explicit multipart/transport exceptions;
- Files pagination permits at most one in-flight Load more request.

No server API, schema, SPA route, component contract, or CSS token changes are introduced.

## Error handling

- Route normalization never throws and does not turn unknown routes into known routes.
- Pagination retains the existing stale-generation discard and notice on request failure; `finally` always releases the single-flight lock.
- Typed-client migration preserves transport exceptions and error propagation.
- Test extraction does not alter runtime error behavior.

## Verification

Behavior changes will follow TDD: first add failing trailing-slash and rapid-pagination tests, then implement the fixes. API conversion will be checked incrementally with focused unit tests, TypeScript, lint, FCIS, and a final grep proving no unauthorized production `apiFetch` imports remain. Test extraction will be verified by comparing test names/counts and running both component suites.

Final verification is:

```sh
cd web && pnpm verify
```

The branch will also be checked against `docs/architecture/` and each child bean will receive completed checklists plus a `## Summary of Changes` before being marked completed.
