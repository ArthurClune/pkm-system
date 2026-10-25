# Breadcrumb bytes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backlinks response carries each ancestor's text once, so its size
is bounded by the stored text it shows, not `depth²/2` copies of it (pkm-0on4).

**Architecture:** Backlink items stop carrying ancestor texts. Each item
carries `ancestor_uids` (root first), and the unit that holds the items
(`Backlinks`, `BlockBacklinksPayload`) carries one `ancestor_texts` map,
`uid -> text`, the shape `block_ref_texts` already has. Server and replica
build the same shape; the web threads the map beside the groups, as it
threads `block_ref_texts`.

**Tech Stack:** FastAPI + pydantic, SQLite; React/TS; sqlite-wasm replica.

**Spec:** `.beans/pkm-0on4--backlink-breadcrumbs-amplify-output-d2-times.md`

## Why this shape, not an excerpt

- The web shows every ancestor's full text (`BacklinkGroupList`:
  `breadcrumbs.join(" › ")`, `.breadcrumbs` in `styles.css` has no clip).
- The linked-references filter reads full ancestor texts for refs
  (`backlinkFilter.itemRefTitles`: a block under "Papers #Paper" counts as
  tagged Paper). An excerpt would drop refs past the cut: a silent wrong
  filter result, which Arthur's no-silent-truncation rule forbids.
- The CLI (`render_backlinks`) and MCP show no breadcrumbs; `pkm refs
  --json` emits the model, so it gets the new shape.
- `BlockPayload.breadcrumbs` (one block's single trail, `O(depth)`) is not
  amplified and stays a text list.

## Global Constraints

- Field names: `BacklinkItem.ancestor_uids: list[BlockUid]` (root first,
  replacing `breadcrumbs`); `Backlinks.ancestor_texts` and
  `BlockBacklinksPayload.ancestor_texts`: `dict[BlockUid, str]` holding
  exactly the uids some item's `ancestor_uids` names.
- Server and replica change together; `shared/fixtures/shim_parity.json`
  regenerated with `uv run python -m pkm.server.shim_parity_dump`.
- openapi regen: `uv run python -m pkm.server.openapi_dump >
  ../web/src/api/openapi.json`, then `pnpm gen-types`.
- No visible change to breadcrumbs.

## Review Focus

- An open tab on the old build after deploy: `item.breadcrumbs` is gone, so
  its `BacklinkGroupList` throws to the root `ErrorBoundary` ("Something
  went wrong", Reload). Accepted as a deploy transient; noted in the report.
  Keeping the name `breadcrumbs` for a uid list would avoid the throw but
  render uids and leave two `breadcrumbs` fields of different meaning that
  types cannot tell apart.
- Load more / load all: the map must merge across batches, or crumbs of a
  later batch render without text.
- Filter cache: `itemRefTitles` caches per item; the cache must be keyed by
  the texts map too, since a merge may replace an ancestor's text.
- A uid missing from the map (a contract break) shows the uid, never an
  empty crumb.
- CLI `get_backlinks` merges pages: it must union the maps.
- Journal: each day's `Backlinks` carries its own map, so a response holds
  at most one copy of an ancestor per day (≤ 31 days), linear in stored text.

---

### Task 1: Server shape and red test

**Files:** `server/src/pkm/server/tree.py`, `grouping.py`, `routes_pages.py`,
`server/src/pkm/contracts/responses.py`, `server/src/pkm/client/api.py`,
tests in `server/tests/test_backlinks.py` (+ existing tests asserting
`breadcrumbs` on items: `test_block_ref_index.py`, `test_grouping.py`,
`test_hardening.py`, `test_sql_variable_limit.py`, `test_cli_main_read.py`,
`test_render.py`, `test_ancestor_walk.py`).

**Interfaces (produces):**
- `tree.ancestor_trails(starts, blocks) -> dict[BlockUid, list[BlockUid]]`
  (renamed from `ancestor_texts`, same walk, uids instead of texts).
- `routes_pages._fetch_ancestors(db, uids) -> tuple[dict[BlockUid,
  list[BlockUid]], dict[BlockUid, str]]` — trails and the texts of every uid
  on some trail.
- `grouping.group_backlinks(rows, trails) -> list[BacklinkGroup]`.

- [ ] **Step 1: Red test** `test_deep_chain_backlinks_send_each_ancestor_once`:
  seed a 100-deep chain over `/api/ops`, each block `[[Amp Target]] ` + 20,000
  `x`; GET `/api/page/Amp Target?bl_limit=100`; assert `len(r.content) <
  3 * stored` (stored = sum of block texts), and the last item's
  `ancestor_uids` has 99 uids each with its full text in `ancestor_texts`.
  Run it: fails (≈96 MiB today, and no `ancestor_uids`).
- [ ] **Step 2:** Implement the interfaces above and the model fields; client
  `_fetch_backlinks_once` unions `ancestor_texts`; `get_block` maps its
  trail through the texts.
- [ ] **Step 3:** Update the listed tests to the new shape; `cd server && uv
  run pytest -q` green except openapi/shim fixtures (Task 2).

### Task 2: Replica, web, generated artifacts

**Files:** `web/src/replica/localApi/tree.ts`, `pages.ts`, `journal.ts`;
`web/src/components/BacklinkGroupList.tsx`, `backlinkFilter.ts`,
`backlinkBatchWalk.ts`, `BacklinksSection.tsx`,
`BlockRefBacklinksPopover.tsx`, `web/src/views/filesCore.ts`,
`FileCardPopovers.tsx`, `web/src/test-helpers.ts`; generated
`openapi.json`, `types.d.ts`, `shim_parity.json`; tests beside each.

**Interfaces:**
- `tree.ts`: `ancestorTrails(starts, blocks): Map<BlockUid, BlockUid[]>`;
  `fetchAncestors(db, uids): { trails: Map<BlockUid, BlockUid[]>; texts:
  Record<string, string> }`.
- `backlinks(db, pageId, offset, limit)` returns `{ groups, total, texts,
  ancestorTexts }`.
- `BacklinkGroupList` prop `ancestorTexts: Record<string, string>`.
- `itemRefTitles(item, ancestorTexts, read)`, `applyFilter(groups,
  ancestorTexts, f, read)`, `chipCounts(visible, ancestorTexts, omit, read)`.
- `BacklinkBatchState.ancestorTexts`, merged like `refTexts`.

- [ ] **Step 1:** Regenerate openapi + types; `pnpm typecheck` lists every
  consumer to fix.
- [ ] **Step 2: Red tests:** `tree.test.ts` deep-chain case: 100-deep chain
  through `fetchAncestors` yields each ancestor's text once; a
  `BacklinkGroupList` test renders crumbs from the map and the uid when it
  is missing; a `backlinkBatchWalk` test that a second batch's crumb texts
  arrive in the merged state; a filter test that an ancestor ref still
  matches.
- [ ] **Step 3:** Implement; regenerate `shim_parity.json`; `cd web && pnpm
  verify` green, `cd server && uv run pytest -q` green.

### Task 3: Docs and gates

- [ ] backend.md § Breadcrumbs (the shape and why: one copy per response),
  the walk table name, API table rows for `/api/page` and
  `/api/block/{uid}/backlinks`; troubleshooting row (pkm-0on4).
- [ ] pyrefly, ruff, `pnpm verify` (E2E_PORT=9031), `perf/check.sh backend`
  and `frontend` (the `page/deep-backlinks` scenario's `bytes` count falls);
  commit any rewritten baseline.
