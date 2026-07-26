# pkm-roph: CLI surface improvements from agent-driving test — design

Bean pkm-roph collects friction points from driving the `pkm` CLI as an
agent. The same verbs will eventually back an in-app assistant, so the CLI
surface (and the MCP tools that share its renderers) is worth polishing.
Seven items; each is small, together they form one branch of work.

## Context

- CLI: `server/src/pkm/cli/main.py` (argparse shell), `cli/build.py`
  (pure op planning), `cli/render.py` (pure markdown rendering),
  `client/api.py` (HTTP).
- MCP server (`pkm/mcp/server.py`) wraps the same client + renderers.
- Server: `/api/search` + `/api/query` in `server/routes_search.py`;
  FTS escaping in `server/fts.py`; query planning in `server/query.py`
  (pure); response contracts in `server/response_models.py`.
- The web offline shim mirrors `/api/search`
  (`web/src/replica/localApi/{fts,search}.ts`, guarded by
  `shared/fixtures/shim_parity.json`); `/api/query` is server-only.
- Server route/param/response changes require regenerating
  `web/src/api/openapi.json` (+ `pnpm gen-types`) and, for `/api/search`,
  the shim parity fixture.

## Decisions per item

### 1. Exact search — `pkm search --exact`

The "stemming" in the bean is actually the trailing `*` prefix wildcard
`escape_fts_query` appends to the last term (`AGI` → `"AGI"*`, matching
Agile/agility/aging; FTS5 unicode61 does not stem). Fix:

- `escape_fts_query(q, exact=False)`: when `exact`, skip the trailing `*`.
  Terms remain AND-of-whole-tokens (FTS5 default), so multi-word exact
  queries match blocks containing all the exact tokens.
- `/api/search` gains `exact: bool = False` query param (applies to both
  the pages and blocks queries).
- Mirror in the web shim's FTS expression builder + one new parity case
  (`/api/search?q=...&exact=1`).
- CLI: `pkm search TERM --exact`; MCP `search` gains `exact` param.

### 2. Query ref expansion — `pkm query --expand`

Opt-in one-hop transitivity: with `expand`, operand `[[X]]` matches blocks
that reference X **or** reference any page whose own blocks reference X
(covers "meeting links [[RedGate]], RedGate is tagged [[Databases]]").

- `/api/query` gains `expand: bool = False`.
- `plan_sql(node, expand)` widens the page-operand SQL to a UNION:

  ```sql
  SELECT r.src_block_uid AS uid FROM refs r
    JOIN pages p ON p.id = r.target_page_id WHERE p.title = ?
  UNION
  SELECT r.src_block_uid FROM refs r WHERE r.target_page_id IN (
    SELECT b2.page_id FROM refs r2
      JOIN blocks b2 ON b2.uid = r2.src_block_uid
      JOIN pages px ON px.id = r2.target_page_id WHERE px.title = ?)
  ```

  All ref kinds (link/tag/attribute) count, matching the base operator.
- CLI: `pkm query EXPR --expand`; MCP `query` gains `expand`.

### 3. Resolve block refs — `pkm get --resolve-refs`

Page/block payloads already carry `block_ref_texts` (uid → {text,
page_title}); this is a pure render change.

- New pure helper (cli/render.py): rewrite each `((uid))` occurrence in
  block text to `"<referenced text>" ((uid))` — the text becomes visible,
  the uid stays for follow-up fetches. Unknown uids are left untouched.
- Resolution recurses into inlined text (the map may contain nested refs)
  with a seen-set so ref cycles terminate: a uid already being expanded is
  left as a bare `((uid))`.
- CLI: `pkm get TARGET --resolve-refs` (markdown output only; `--json`
  already includes the raw map). MCP `get_page`/`get_block` gain
  `resolve_refs`.

### 4. `--help` audit for every verb

Pure argparse text. Every subparser gets argument-semantics help and a
short example in an epilog (`RawDescriptionHelpFormatter`). `pkm batch
--help` embeds the full op reference: create/todo (page, text, parent?,
index?, as?), update (uid, text), move (uid, page, parent?, index?),
delete (uid), outline (page, parent?, items), alias rules, `## Heading`
parent semantics, and a worked JSON example. Accepted formats (page title
vs uid vs `## Heading`/`((uid))`/`{{alias}}` parents) documented on the
verbs that take them.

### 5. Position control for batch create

- `create`/`todo` batch commands accept optional `index` (top-level or
  under `parent`): passed through as the op's `order_idx`. The server
  already splices (shifts siblings ≥ idx on insert), so no client-side
  index bookkeeping is needed. `outline` stays append-only.
- `{{alias}}` now resolves in `uid` params too (`update`, `move`,
  `delete`), not just `parent` — creating a block and immediately moving
  it no longer needs a re-get.

### 6. Token-lean output modes

- `--json` output becomes minified (`separators=(",", ":")`) for all
  verbs — machine consumers only; ~25% token saving.
- `pkm search` CLI default limit drops 20 → 10 (server default
  unchanged); new `--compact` renders `title`-only page lines and
  `[page_title] ^uid` block lines (no snippets).
- `pkm get` gains `--section "## Heading"` (emit only the subtree under
  the first block whose text matches; error listing available headings if
  not found) and `--depth N` (clip nesting deeper than N). Both pure
  filters over `payload["blocks"]`, applied before rendering **and**
  before `--json` emission (blocks filtered; other payload keys kept).

### 7. Empty-result hints for query

- `/api/query` response gains required `ref_counts: dict[str, int]` —
  for each distinct `[[Page]]` operand in the expression, the number of
  blocks matching that operand alone (with expansion applied when
  `expand` is set). Cheap: one indexed count per operand.
- New `QueryPayload(GroupsPayload)` response model so `/api/unlinked` and
  `/api/todos` (which share `GroupsPayload`) are untouched. `render_groups`
  keeps working for all three; the query render adds a hint line when
  `total == 0`: `no matches — per-ref counts: [[Meeting]] 312, [[Databases]] 51`.
- Web `QueryBlock` reads `groups`/`total` only; regenerated types absorb
  the extra field.

## Not doing (YAGNI)

- No server-side section/depth filtering (CLI-side filtering already
  removes the tokens from the agent loop; the wire cost is irrelevant).
- No phrase-search operator beyond `--exact` (FTS5 AND-of-exact-tokens
  covers the observed failures).
- No multi-hop or kind-filtered expansion; one hop, all kinds.
- `--compact` for verbs other than `search`.

## Testing

TDD throughout; tests live beside the existing suites:

- `server/tests/test_fts*.py`/search route tests: exact on/off for pages
  and blocks (prefix-match present without, absent with).
- query tests: expand SQL (one-hop match found, zero without), ref_counts
  values, parse errors unchanged.
- `test_cli_main_read.py`: --exact/--expand pass-through, --resolve-refs
  (incl. cycle + unknown uid), --section/--depth (incl. missing-heading
  error), --compact, minified --json, search default limit.
- `test_cli_build.py`: batch index pass-through, alias-as-uid for
  update/move/delete.
- help-text test: every verb's `--help` mentions its args and contains an
  example (guards the audit from regressing).
- Web: parity fixture regen (new exact case) + shim fts unit test;
  `pnpm verify` green.

## Docs & regen checklist

- Regenerate `web/src/api/openapi.json` + `pnpm gen-types` (query/search
  param + response changes) — commit both.
- Regenerate `shared/fixtures/shim_parity.json` (new exact search case).
- Update README "CLI and MCP access" section and
  `.claude/skills/pkm/SKILL.md` for the new flags/params.
- MCP tool docstrings updated where params were added.
