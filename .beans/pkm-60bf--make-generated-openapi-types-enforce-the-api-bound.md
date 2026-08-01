---
# pkm-60bf
title: Make generated OpenAPI types enforce the API boundary
status: completed
type: task
created_at: 2026-08-01T13:21:07Z
updated_at: 2026-08-01T14:45:00Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 11.

**References:** web/src/api/client.ts:69-108; web/src/replica/localApi/router.ts:24-27; web/src/replica/localApi/tree.ts:24-35; web/src/replica/localApi/pages.ts:91-116; web/src/replica/localApi/search.ts:9-24; web/src/components/PageTitle.tsx:14-17; web/src/api/types.d.ts:1590-1605

Callers choose apiFetch<T> independently of the URL and method, while offline gateway bodies are unknown cast to T. TypeScript cannot detect online/offline response drift, an obsolete caller type, or an incorrect request body/method. Several local and component models duplicate generated server shapes.

**Direction:** Build a path/method-aware client from generated OpenAPI paths. Give local response builders explicit generated return types, add a concrete rename response model server-side, regenerate the schema, and remove handwritten duplicates.

- [x] Design a path/method-aware API client without weakening local gateway support
- [x] Type local API response builders with generated models
- [x] Replace handwritten duplicate response types

## Summary of Changes

**Server.** `RenamePageResponse` (`result: Literal["renamed","merged"]`,
`title`) in `response_models.py`, declared on `POST /api/page/{title}/rename`,
which had been returning a bare `dict` and so described its 200 body as
`{[key: string]: unknown}`. `openapi.json` + `types.d.ts` regenerated.

**Typed client.** `web/src/api/typedClient.ts` exports
`apiGet`/`apiPost`/`apiPut`/`apiDelete`. They take the **OpenAPI path
template**, not a built URL, and the generated `paths` table then decides the
path parameters, the query parameters, the JSON request body and the response
type:

    apiPost("/api/page/{title}/rename",
            { path: { title }, body: { new_title, allow_merge } })

It is a typing layer, not a transport: it builds the same concrete URL the
call sites hand-wrote and calls `apiFetch`, so the offline-gateway dispatch,
the 401 redirect and `ApiError`/`OfflineError` are unchanged. Path parameters
are encoded per segment (`{title:path}` namespace titles keep their slashes)
via the *function* form of `String.replace`, so a title containing `$&` is
pasted literally. Query values go through `URLSearchParams`, which writes a
space as `+` rather than `%20`; the server and the shim decode both the same
way.

**Offline shim.** Every builder in `replica/localApi/` now declares its
generated payload type instead of `unknown` (three of them declared
`unknown | null`, which collapses to plain `unknown`). `titles`, `sidebar` and
`block-refs` were built inline in the router and are extracted as
`titlesPayload`/`sidebarPayload`/`blockRefsPayload` so they can carry one too.
`tree.ts`'s handwritten `BlockNodeOut` and `BlockRefTexts` are gone in favour
of the generated `BlockNode` and `PagePayload["block_ref_texts"]`.

A declared return type is only worth anything if the payload is *built* in
checked code. `ReplicaDb.select<T>` asserts its type argument
(`selectObjects(...) as T[]`), so five builders that passed a generated model
straight to it looked annotated while checking nothing: `PageMeta`,
`CurrentWorkPage`, `SidebarNavEntry`, `SearchPageHit`, `SearchBlockHit`. Each
now names a local row type and maps into a checked object literal
(`rows.map((row): PageMeta => ({ … }))`). Verified by renaming a field in each
of the five generated models and confirming all five map sites fail to
compile — before the change, the `PageMeta` rename produced no shim error at
all. Still unchecked, by nature: the row type against the real SQL, which is
what `shim_parity.json` covers.

**Duplicates removed.** `PageTitle.tsx`'s `RenameResult` and
`assistant/client.ts`'s `{id: string; model: string}`; both converted to the
typed client, along with the assistant's delete/confirm calls.

**Drift probes** (compile-time, run by `pnpm typecheck`):
`api/typedClient.test.ts` (wrong response type, wrong verb for a path,
unknown route, missing/unknown/mistyped parameters, wrong body field) and
`replica/localApi/payloadTypes.test.ts` (each builder's return type is
*exactly* its generated payload). An expected-error directive that stops
erroring is itself an error, so the probes cannot rot.

**Deliberately left as follow-up:** 32 remaining `apiFetch` call sites in
`components/`, `views/`, `outline/` and `sync/`, plus one place that passes
`apiFetch` itself as a value (`sync/SyncProvider.tsx:238` → `replicaSync`'s
`fetchJson` injection seam). The full list is in the task report; regenerate
it with

    grep -rnE "apiFetch[<(]" web/src | grep -v "\.test\." | grep -v "web/src/api/"

They are mechanical, and converting them all here would have collided with
the other lanes editing those same files. `sync/assets.ts:14` must NOT be
converted: the typed client is JSON-only, and that upload is
multipart/form-data. The schema's other non-JSON write,
`POST /api/assets/export.zip` (x-www-form-urlencoded), is not in the list at
all — `views/Files.tsx:16` submits it as a real hidden `<form>` so the
browser handles the download, and it never touched `apiFetch`.

One ordering note for whoever does the sweep: `buildUrl` originally dropped
only `undefined` query values, so a nullable cursor would have serialized as
the literal `?before=null`. Five params are generated `| null` (`before` on
`/api/journal`, `now_ms` on `/api/current-work`, `page` on `/api/todos`,
`from_ms`/`to_ms` on `/api/assets/search`) and FastAPI declares them
`X | None = None`, so `"null"` arrives as a *value*, not as absent — a 400 on
the journal date parse, a 422 on the int ones. No caller passes `null` today
(`Journal.tsx`'s cursor is `string | undefined`, and `filesCore.searchParams`
omits its date params), so this was latent rather than live; but the
generated types invite it, the shim already models the same cursor as
`string | null` (`journalPayload`), and the conversions are exactly where a
nullable value would first reach `buildUrl`. Fixed before the sweep rather
than after the first 400.
