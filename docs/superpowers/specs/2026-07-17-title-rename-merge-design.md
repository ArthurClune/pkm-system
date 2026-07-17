# Page Title Editing / Page Merging (pkm-g0t5)

**Date:** 2026-07-17
**Bean:** pkm-g0t5 — Title Editing/Page merging
**Status:** Approved design

## Summary

Users can edit a page's title in place. If no page with the new title exists
(case-sensitive), the page is renamed and every reference in block text is
rewritten. If a page with the new title exists, the user confirms and the two
pages are merged by concatenation. Either way the user lands on the resulting
page.

## Decisions made during brainstorming

- **Entry point:** click-to-edit title (inline), not a dialog.
- **Merge safety:** merging requires an explicit confirmation; plain renames are one step.
- **Daily notes:** a date-titled page (daily note) cannot be renamed. Renaming
  a normal page *to* a date-shaped title is allowed (it becomes, or merges
  into, that day's note).
- **Approach:** a single atomic server-side REST endpoint (approach A), not a
  sync op type and not client orchestration. Online-only, matching page delete.
- **Merge shape:** plain append — no marker block, no deduplication.
- **Case:** all title comparisons are case-sensitive, matching the schema
  (`pages.title` UNIQUE, binary collation). Renaming `cLaude` → `Claude`
  merges when `Claude` exists and is a plain rename when it doesn't. The
  no-op check ("new title equals old") is also case-sensitive, so a pure
  case-fix rename works.

## Server

### Endpoint

`POST /api/page/{title}/rename` in `server/src/pkm/server/routes_pages.py`,
body `{ "new_title": str, "allow_merge": bool }`.

Responses:

- `200 { "result": "renamed" | "merged", "title": <new_title> }`
- `400` — new title empty after trimming; new title equals old title
  (case-sensitive); source page title is date-shaped (daily notes cannot be
  renamed).
- `404` — source page does not exist.
- `409` — a page titled `new_title` exists (case-sensitive exact match) and
  `allow_merge` is false. Nothing is changed. This is the confirm-flow signal:
  the client asks the user, then retries with `allow_merge: true`. The
  check-and-act stays race-safe because the server re-checks inside the
  transaction on the retry.

### Rename path (no collision)

In one transaction:

1. `UPDATE pages SET title = new_title` (id unchanged, so `refs` and
   `blocks.page_id` stay valid; `pages_fts` maintained by trigger).
2. Rewrite referencing block text (see "Text rewrite" below) for every block
   with a ref targeting this page id.
3. `UPDATE sidebar_entries SET title = new_title` where it references the old
   title (the table is keyed by title, not id).
4. Reindex refs for the rewritten blocks.

### Merge path (collision + `allow_merge`)

In one transaction:

1. Move the source page's top-level blocks to the target page id, appended
   after the target's existing top-level blocks, preserving their relative
   order. Subtrees move with them; block UIDs are untouched, so `((uid))`
   block refs keep resolving.
2. Rewrite referencing block text everywhere (source title → target title).
3. Repoint/reindex refs from the source page id to the target page id.
4. Delete the source page row (reusing `delete_page_rows` semantics where
   applicable).
5. Sidebar entries: if only the source had one, retitle it; if both had one,
   drop the source's (avoids the `UNIQUE(title)` conflict).

### Text rewrite (correctness-critical)

Rewriting uses the existing ref grammar in `server/src/pkm/refs.py` to locate
spans — never naive string replacement. Code spans (fenced and inline) are
skipped and nested `[[ ]]` respected, exactly as extraction does. Only spans
that resolve to the renamed page's id are touched; e.g. an existing
`[[Claude]]` link is a different ref from `[[cLaude]]` and stays as-is.

Form-preserving rules with downgrades:

| Old form | New form |
|---|---|
| `[[Old]]` | `[[New]]` |
| `#[[Old]]` | `#[[New]]` |
| `#Old` | `#New` if the new title is a valid bare hashtag; else `#[[New]]` |
| `Old::` | `New::` if the new title still parses as an attribute; else `[[New]]` |

The rewrite planning is pure (Functional Core module); the route/store shell
gathers rows, calls the core, and persists results (FCIS).

### Propagation

All touched rows land in the `changes` journal via the existing triggers. The
route sends one WS nudge (`nudge_threadpool`, as `delete_page` does); every
client — including the initiator — pulls the changes feed and applies it with
existing `applyChanges` logic. No new sync op type, no new client apply code.
The operation is online-only, consistent with page delete.

## Client (web)

### Inline title editing

- The static `<h1 className="page-title">` in `web/src/views/PageView.tsx`
  becomes click-to-edit: clicking swaps in a text input styled identically to
  the h1 (no layout jump).
- **Enter** commits, **Esc** reverts, blur commits.
- On daily-note pages (title parses as a date, mirroring the server helper)
  the title is not editable: no affordance, clicks do nothing.

### Commit flow

1. Trim; if unchanged (case-sensitive) or empty, revert silently.
2. `POST /api/page/{old}/rename` with `allow_merge: false`.
3. On `200 renamed` → `navigate(pagePath(newTitle))`.
4. On `409` → `window.confirm("Page 'X' already exists — merge this page
   into it?")` (same pattern as Delete page); on OK retry with
   `allow_merge: true`, then navigate to the merged page. On cancel, revert.
5. On any error (including offline) → revert the displayed title and surface
   the failure. The server is atomic, so no partial state exists.

Everything else on screen (backlink text, sidebar, search) refreshes through
the normal nudge → pull cycle.

### Contract

Regenerate and commit `openapi.json` and `types.d.ts` with the new route
(`test_openapi_sync.py` enforces this).

## Testing

- **Server** (`server/tests/`): rename happy path; merge happy path (block
  order preserved, refs repointed, source page deleted); 409 without
  `allow_merge`; case-sensitivity (merge `cLaude`→existing `Claude`,
  case-fix plain rename, case-sensitive no-op rejection); text-rewrite forms
  (`[[ ]]`, `#tag`, `#[[ ]]`, `attr::`, hashtag/attribute downgrade rules,
  code spans untouched, nested brackets, multiple refs in one block, a block
  containing both `[[cLaude]]` and `[[Claude]]`); sidebar retitle and
  both-pinned merge conflict; daily-note source rejected; rename to
  date-shaped title allowed.
- **Web unit**: title editor commit/revert/Esc behavior; daily-note guard;
  409→confirm→retry flow.
- **Playwright E2E**: rename via the UI, assert a referencing block's text
  updated and navigation landed on the new title; merge flow through the
  confirm dialog. Run against `pnpm build` output as usual.

Verification: `cd server && uv run pytest -q && uv run pyrefly check &&
uv run ruff check`; `cd web && pnpm verify`.

## Out of scope

- Offline rename/merge (would need a sync op type; revisit only if demand).
- Undo of a merge (the confirmation dialog is the guard; merge is
  irreversible).
- Deduplication or marker blocks during merge.
- Renaming daily notes.
