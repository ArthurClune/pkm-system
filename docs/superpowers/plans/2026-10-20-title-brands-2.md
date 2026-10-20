# Title brands, branch 2: bare `title`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register bare `title` with the brand check, so every parameter and
field named `title` carries `RawTitle`, `NormalizedTitle` or
`CanonicalTitle`, converting every site on both sides.

**Architecture:** Things named `title` that are not page titles get another
name: two wire fields and a handful of in-app ones. Route path and query
`title` params become `RawTitle`, and each `title = read_title(db, title)`
rebind splits into a raw `title` and a `canonical_title`. Functions whose
input is not yet a title name it `text`. NAMES gains `title` last, with
teeth tests, after the sites are converted, as in branch 1.

**Tech Stack:** Python 3 / pydantic / FastAPI / pyrefly / the AST brandlint
(`server/tooling/brandlint`); TypeScript / the ESLint brands plugin
(`web/tooling/eslint-plugin-brands`).

**Spec:** `docs/superpowers/specs/2026-10-19-title-brands-design.md`.
Branch 1's plan (`2026-10-19-title-brands-1.md`) shows the method.

**Bean:** pkm-hc95. Branch `feat/title-brands-2`, worktree
`.claude/worktrees/title-brands-2`.

## Decisions

- **Wire renames (Arthur, 2026-10-20).** `CurrentWorkSection.title` becomes
  `heading`. The GoodLinks `title` on `GoodlinksLink` and `GoodlinksArticle`
  becomes `article_title`. No opt-out is added. The PWA is `autoUpdate` with
  `skipWaiting`, so a stale bundle meets the new server only until it
  reloads. Until then, CurrentWork headings render blank and the reader
  shows its "Saved article" fallback.
- **The outline session API stays `RawTitle`.** The handoff suggested
  narrowing it, but `useOutlinePageLoad` keys the session by the
  *requested* title until a read resolves a different one. The key is
  genuinely raw before then, and narrowing it would change behaviour. The
  same holds for `outlineState`'s title, `tree.ts`'s `pageTitle` and
  `attachOutlineReplay`.
- **`BacklinksSection`'s `title` is already `CanonicalTitle`**, and both
  callers pass a canonical title. Nothing to do.
- **Wire and MCP names do not change** except the three fields above. A
  route's `{title}` path param, the MCP tools' `title` argument and every
  request field keep their names, so the name stays `title` and the type
  says the kind.
- **Parsers take `text`.** A function whose input is text that is not yet a
  title (a normalizer, a validator, a date parser, the title readers) names
  the parameter `text: str` / `text: string`.
- **Test helpers that mint a literal** name the parameter `title_text: str` /
  `titleText: string`. Use that one spelling. Every other test parameter
  takes the brand its callers pass, built with `raw_title_of` /
  `canonical_title_of` / `rawTitleOf` / `canonicalTitleOf`.
- **Mixed callers.** Where one parameter's callers hold different kinds,
  it takes the widest kind any of them passes (usually `RawTitle`). Where
  "trace" appears in a site table, this is the rule that settles it.
- **Collections** (`titles`, `title_map`, `desired_titles`) stay
  unregistered.

## Global Constraints

- No runtime behaviour change beyond the three renamed response fields: no
  other value, response body, SQL result or op changes. A brand is a type
  only.
- No allow-list, no baseline, no new opt-out: every violation is converted.
- No cast or `as` to a title brand outside its mint sites. A site that seems
  to need one is a provenance question: trace the value to its origin and
  type that.
- `as_raw_title` / `asRawTitle` are called only on a plain `str`/`string` at
  the place raw text enters (a CLI argument, a regex capture, a JSON body
  read untyped, an input box). Never call them on a value already typed as
  a title.
- **Find the sites by local registration.** Add `"title": ("RawTitle",
  "NormalizedTitle", "CanonicalTitle")` to `NAMES` in
  `server/src/pkm/brand_registry.py`. Regenerate (`cd server && uv run
  python -m pkm.rows_dump`), then list the sites:
  `PYTHONPATH=server/tooling python3 -m commentlint.run --all` on the server
  and `cd web && pnpm lint` on the web. Revert both files before every
  commit until Task 5. On 2026-10-20 this found about 44 product and 40 test
  sites on the server, and 44 and 43 on the web.
- Every generated artifact (`openapi.json`, `types.d.ts`, `columns.gen.ts`,
  `brandRegistry.gen.json`) is regenerated in the commit that stales it.
- `pnpm typecheck` covers `web/src` only. When a task changes a type
  `web/tooling` imports, also run `cd web && pnpm exec tsc -p
  tooling/tsconfig.json --noEmit` and check its error count is no higher
  than main's (it has older errors; see pkm-mqma).
- FCIS headers and the comment rules in AGENTS.md apply. Comments carry no
  bean ids.

## Review Focus

1. **A rebind split that leaves a raw use.** After `title = read_title(db,
   title)` becomes `canonical_title = read_title(db, title)`, a later line
   that still reads `title` now gets the raw spelling. Everything would
   still type-check, because `RawTitle` is accepted wherever any title is.
   Task 2 pins each route with a control-whitespace request. Its reviewer
   mutates one `canonical_title` use back to `title` and confirms a test
   fails.
2. **Laundering.** A canonical value is typed or re-minted as `RawTitle`
   because that type-checks. Reviewers grep every new `as_raw_title(` /
   `asRawTitle(` and check the argument is a plain string at an entry point.
3. **MCP argument names.** An agent calls `get_page(title=...)`, so
   renaming a tool parameter breaks it silently. Task 2 pins the names.
4. **`{title:path}` decoding.** The retyped path param must still accept
   `/` and percent-escapes. Task 2 pins a slash title through GET.
5. **The renamed response fields have a reader on every surface:** the
   CurrentWork view, the GoodLinks reader, the CLI and the client. A
   missed one reads `undefined` or `None` with no type error, wherever a
   payload is read untyped. Task 1 greps `\.title\b` and `["title"]` near
   each payload and names every reader in its report.

---

### Task 1: Non-page titles leave the name

**Files:**
- Modify: `server/src/pkm/contracts/responses.py`:
  `CurrentWorkSection.title` → `heading: str`;
  `GoodlinksLink.title`, `GoodlinksArticle.title` → `article_title: str`.
- Modify: `server/src/pkm/server/routes_goodlinks.py` (both
  constructions), the `CurrentWorkSection` builder behind
  `routes_pages.get_current_work`, and every server reader of those fields
  (`client/api.py`, `cli/main.py`, `render.py`: grep).
- Modify (web): `views/CurrentWork.tsx`, `components/GoodlinksReader.tsx`,
  and their tests' stubs. In-app renames:
  - `ConfirmDialog`'s `title?` → `heading?`;
  - `RouteMeta.title` → `documentTitle` (`routeMeta.ts`,
    `useRouteTitle.ts`);
  - `Settings.tsx`'s section `title` → `heading`;
  - `tooling/buildBudgets.ts` `formatReport(title, …)` → `heading`;
  - `props/sync/commands.ts`'s `readonly title: number` → `titleIndex`.

  Update every caller.
- Regenerate `openapi.json` (`cd server && uv run python -m
  pkm.server.openapi_dump`) and `types.d.ts` (`cd web && pnpm gen-types`).
- Docs (invoke `architecture-docs`): the spec's "Non-page titles (branch
  2)" section records the decision in two sentences. In `backend.md`'s API
  reference, the `/api/current-work` and GoodLinks rows name the new fields
  if they name fields at all.
- Test: `server/tests/test_title_brands.py`; the existing CurrentWork,
  GoodLinks, ConfirmDialog, route-title and Settings tests.

**Interfaces:**
- Produces: `CurrentWorkSection.heading`, `GoodlinksLink.article_title`,
  `GoodlinksArticle.article_title`; `ConfirmOptions.heading`;
  `RouteMeta.documentTitle`.

- [ ] **Step 1: Write the failing test.** In `test_title_brands.py`,
  `test_non_page_titles_are_not_named_title`: for `CurrentWorkSection`,
  `GoodlinksLink` and `GoodlinksArticle`, `"title" not in
  model_fields`; `"heading"` / `"article_title"` are.
- [ ] **Step 2: Run it; it fails.** `cd server && uv run pytest
  tests/test_title_brands.py -q`.
- [ ] **Step 3: Rename, regenerate, update readers** as under Files. Grep
  each payload's readers (Review Focus 5) and list them in the report.
- [ ] **Step 4: Run the gates.** `cd server && uv run pytest -q && uv run
  pyrefly check && uv run ruff check`; `cd web && pnpm typecheck && pnpm
  lint && pnpm test:unit`, plus the tooling tsc count. All pass.
- [ ] **Step 5: Commit** (`refactor: non-page titles are not named title`).

---

### Task 2: Route title params are raw, and the canonical rebinds split

**Files:**
- Modify: `server/src/pkm/server/routes_pages.py` (`get_page`,
  `delete_preview`, `delete_page`, `rename_page`, `get_unlinked`) and
  `routes_export.py` (`export_page_markdown`): `title: RawTitle`. Each
  `title = read_title(db, title)` (and `rename_page`'s `title =
  canonical(title)`) becomes `canonical_title = read_title(db, title)`.
  Every later use is renamed to match.
- Modify: `routes_sidebar.py`: `title = read_title(db, body.title)` →
  `canonical_title`. `server/store.py` `get_or_create_page(db, title:
  RawTitle, …)`: split the same way.
- Modify: `server/src/pkm/server/sync_meta.py` `read_title(db, text: str)
  -> CanonicalTitle`.
- Modify: `server/src/pkm/client/api.py`: `get_page`, `get_backlinks`,
  `_fetch_backlinks_once`, `get_page_blocks` and `rename_page` take
  `title: RawTitle`. Each `title = normalize_title(title)` becomes
  `ref_title = normalize_title(title)`.
- Modify: `server/src/pkm/mcp/server.py` `get_page`, `backlinks`,
  `rename_page`: `title: RawTitle`, the name unchanged. Mint with
  `as_raw_title` where `cli/main.py` reads a title argument, and pass it
  through.
- Regenerate `openapi.json` and `types.d.ts`. The path params gain
  `x-brand: RawTitle`.
- Modify (web fallout): every `path: { title }` caller now needs a title
  brand (`loadOutlineBlocks.ts`, `TopBar.tsx`, `PageTitle.tsx`,
  `BacklinksSection.tsx`, `useOutlinePageLoad.ts`). Type the value at its
  origin. `loadOutlineBlocks`/`MissingPagePolicy`'s `Title extends string`
  becomes `Title extends RawTitle`; the lint accepts a generic constrained
  to a brand.
- Test: `server/tests/test_title_brands.py`,
  `server/tests/test_page_endpoint.py`, `server/tests/test_mcp_server.py`.

**Interfaces:**
- Consumes: Task 1's regenerated `types.d.ts`.
- Produces: `read_title(db: Db, text: str) -> CanonicalTitle`; the route
  and client signatures above; `MissingPagePolicy<Title extends RawTitle =
  RawTitle>`.

- [ ] **Step 1: Write the failing tests**
  - `test_route_title_params_are_raw` (`test_title_brands.py`): in
    `app.openapi()`, the `title` parameter of GET/DELETE
    `/api/page/{title}`, `/delete-preview`, `/rename`, `/unlinked` and
    `/api/export/page/{title}` has `schema["x-brand"] == "RawTitle"`.
  - `test_mcp_title_arguments_keep_their_names` (`test_mcp_server.py`):
    from `mcp._tool_manager.list_tools()`, `get_page` and `backlinks` have
    a `title` property and `rename_page` has `title` and `new_title`. Each
    carries `x-brand: RawTitle`.
  - `test_every_page_route_resolves_a_control_whitespace_title`
    (`test_page_endpoint.py`, parametrized over GET page, delete-preview,
    unlinked, export, rename source and DELETE): seed `"Ctrl Title"` and
    request `quote("Ctrl\tTitle")`. The route acts on `"Ctrl Title"`:
    200, with the page or its effect present. Fold in the two existing
    `Ctrl\tTitle` tests rather than duplicating them.
  - `test_slash_title_reads_through_the_path_param`: GET
    `/api/page/a/b` returns page `"a/b"` (skip if an existing test pins
    this; name it in the report).
- [ ] **Step 2: Run them.** The schema tests fail; the behaviour tests pass
  already, since they pin the current behaviour.
- [ ] **Step 3: Retype and split** as under Files; regenerate; fix the web
  fallout.
- [ ] **Step 4: Mutation check.** Replace one `canonical_title` use in
  `delete_page` with `title` and run the parametrized test: it must fail.
  Revert, and record the result in the report.
- [ ] **Step 5: Run the gates** (as Task 1 Step 4, plus `cd web && pnpm
  verify`: request-building code has e2e coverage).
- [ ] **Step 6: Commit** (`refactor: route title params are raw, canonical
  titles are named`).

---

### Task 3: The server's remaining `title` sites

**Files:** every file under `server/src`, `server/tooling` and
`server/tests` that brandlint reports with `title` registered locally. As of
2026-10-20, with the kind to start from (a lead, not a verdict; trace each
value's origin):

| Site | Kind |
|---|---|
| `refs.py`: `normalize_title`, `canonicalize_title`, `target_canonical_title`, `title_syntax_reason`, `is_blank_title`, `is_bare_tag_title` | `text: str` |
| `contracts/daily.py` `date_for_title`; `importer/titles.py` `sanitize_import_title`, `_strip_brackets` | `text: str` |
| `importer/parse_export.py` `Page.title` | `RawTitle`, minted where the export is parsed |
| `importer/rows.py` `page_id(title)`; `importer/titles.py` location helper | trace |
| `export/markdown.py` `page_filename`, `render_page`; `export/resolve.py` `render_page_resolved`; `render.py` `render_backlinks` | `CanonicalTitle` if every caller holds one |
| `server/ops_apply.py` `_resolve_page`, `_existing_page_id`; `batch.py` `blocks` | trace (an op hint is `RawTitle`) |
| `server/ops_core.py` `OpTitleViolation.title` | `RawTitle` (an op's `page_title` or a ref's text) |
| `server/query.py` `QueryNode.title` | `RawTitle \| None`, minted from `_parse_title`'s capture |
| `server/conflict_notes.py` `_links_back`, `existing_page_label` | trace |
| `server/store.py` `ForbiddenTitleError.__init__` | `RawTitle` |
| `rename.py` `_verbatim` | `RawTitle` (rename takes `RawTitle`) |
| `test_data/core.py` model field | `RawTitle` (keep `Field(min_length=1)`) |
| `tooling/perfcheck/fixture.py` `page` | trace |
| `server/tests/**` (about 40) | the brand its callers pass; a literal-minting helper takes `title_text: str` |

- [ ] **Step 1: Register locally; save the violation list** to the report.
- [ ] **Step 2: Convert the sites**, running `uv run pyrefly check` after
  each file.
- [ ] **Step 3: With the local name, brandlint reports 0 server sites.
  Revert the NAMES edit; run** `uv run pytest -q && uv run pyrefly check &&
  uv run ruff check`. All pass.
- [ ] **Step 4: Commit** (`refactor: server title parameters carry their
  kind`), without the NAMES edit.

---

### Task 4: The web's remaining `title` sites

The same, on `web/src` and `web/tooling`, including tests and test support.
The sites as of 2026-10-20, with the kind to start from:

| Site | Kind |
|---|---|
| `grammar/scan.ts` `normalizeRefTitle`; `replica/titles.ts` `titleSyntaxReason`, `canonicalizeTitle`, `TitleReader`'s argument (and `titleReaderFor`'s lambda); `replica/meta.ts` `canonicalTitle`; `replica/daily.ts` `dateForTitle`, `dailyTitle` | `text: string` |
| `replica/titles.ts` violation `title`; `replica/localOps.ts` `title?` | `RawTitle` (mirrors `OpTitleViolation`) |
| `replica/pageLookup.ts` (three) | `RawTitle` |
| `replica/localApi/router.ts` body `title` | `asRawTitle(String(...))` at the read: this is where raw text enters |
| `paths.ts` `encodeTitle`, `pagePath` | `RawTitle` (the spec: a function that accepts any title takes `RawTitle`) |
| `outline/outlineSessions.ts` (four), `parentReadElection.ts`, `outlineState.ts` `scopeContainsTitle`, `sync/SyncProvider.tsx` `attachOutlineReplay` | `RawTitle` (the session key; see Decisions) |
| `outline/missingPage.ts` `substituteMissingDaily` | follows `MissingPagePolicy` (Task 2) |
| `components/PageTitle.tsx`, `deletePageCopy.ts` (three), `DeleteBlockedDialog.tsx`, `pageNamespace.ts` | `CanonicalTitle` if every caller holds one |
| `components/SearchBar.tsx` `hasExactPageMatch`, `Composer.tsx` `pick`, `AutocompletePopup.tsx` row, `outline/autocomplete.ts` | trace (a search hit is canonical, typed query text is raw) |
| `replica/placement.ts` `{ title }` | trace |
| tests, `props/`, `replayArbs.ts`, `tooling/perf/rebaseTargets.test.ts` (about 43) | the brand its callers pass; a literal-minting helper takes `titleText: string` |

`pagePath` taking `RawTitle` will surface callers holding a plain `string`.
Each is a provenance question: type the origin, and don't mint at the call.

- [ ] **Step 1: Register locally, regenerate, save the violation list** to
  the report.
- [ ] **Step 2: Convert the sites**, running `pnpm typecheck` as you go,
  and the tooling tsc after any change to a type `web/tooling` imports.
- [ ] **Step 3: With the local name, `pnpm lint` reports 0. Revert the
  local registry edits; run** `pnpm verify`. It passes.
- [ ] **Step 4: Commit** (`refactor: web title parameters carry their
  kind`).

---

### Task 5: Register `title`

**Files:**
- Modify: `server/src/pkm/brand_registry.py` `NAMES`: `"title":
  ("RawTitle", "NormalizedTitle", "CanonicalTitle")` beside `page_title`.
  Extend the `# Titles` comment: bare `title` is wire-shared like
  `page_title`.
- Regenerate `brandRegistry.gen.json`.
- Test: `server/tests/test_brandlint_names.py` and the web title-name
  fixture branch 1 added (`web/tooling/lintConfig.test.ts` or
  `eslint-fixtures/`).
- Docs (invoke `architecture-docs`): `docs/architecture/enforced-checks.md`.
  If it enumerates the title names or counts NAMES, add `title`; grep for
  counts.

- [ ] **Step 1: Write the teeth tests; they fail.** Server: `def f(title:
  str)` is reported; `title: CanonicalTitle` and `title: RawTitle | None`
  are accepted; an untyped `def f(title)` is reported. Web: `title: string`
  and an untyped arrow parameter `(title) =>` over a `string[]` are
  reported; `title: CanonicalTitle` and `<T extends RawTitle>(title: T)`
  are accepted.
- [ ] **Step 2: Register; regenerate.**
- [ ] **Step 3: Run everything:** `cd server && uv run pytest -q && uv run
  pyrefly check && uv run ruff check`; `cd web && pnpm verify`. They pass
  with no violations.
- [ ] **Step 4: Commit** (`feat: brand check registers bare title`).

---

### Task 6: Branch-end checks

- [ ] `perf/check.sh` (route handlers and ops code changed); handle the
  result per AGENTS.md.
- [ ] `proptest/check.sh` (ops, sync props and outline session types
  changed).
- [ ] Update pkm-hc95: branch 2 done, and check off its todo; commit the
  bean.
- [ ] Whole-branch review on the strongest model, with the perf table and
  the Review Focus list.
- [ ] After merge and deploy, check the live `/api/current-work` returns
  `heading`, and that the served bundle contains `article_title`.
