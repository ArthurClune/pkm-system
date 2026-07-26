---
# pkm-roph
title: pkm CLI surface improvements from agent-driving test
status: completed
type: feature
priority: normal
created_at: 2026-07-24T16:35:31Z
updated_at: 2026-07-26T15:17:02Z
---

Testing the pkm skill/CLI as an agent (2026-07-24 session: AGI notes review + database-vendor meeting lookup) surfaced friction points. These matter because the same verbs will eventually back an in-app assistant.

Findings from real usage:

- [x] **Exact/phrase search mode.** `pkm search "AGI"` stems too aggressively — matches Agile, agility, Anti-Aging. Agent has to filter noise. Add `--exact` (or quote-phrase semantics) to restrict matching.
- [x] **Ref expansion for `query`.** `pkm query "{and: [[Meeting]] [[Databases]]}"` returns 0 because meeting blocks link [[RedGate]], not [[Databases]]. There is no transitivity through tags/links. Add an opt-in expansion (e.g. `--expand`: X also matches pages tagged/linked to X, one hop) so "meetings about X" works in one call instead of N refs round-trips.
- [x] **Resolve block refs in `get`.** Output prints `((uid))` opaquely; heavily block-ref'd pages (e.g. AGI) are full of dead ends requiring extra fetches. Add `--resolve-refs` to inline the referenced text (marked as an embed, cycle-safe).
- [x] **Fully revise `--help` for every verb.** `pkm batch --help` prints only `usage: pkm batch [-h]` — no command list, no params, no JSON example; the format is only documented in the README. Agents reach for `--help` first, so audit all verbs (get, search, refs, query, todos, save, update, upload, batch, login) and make each self-sufficient: argument semantics, accepted formats (page titles vs uids vs "## Heading"/((uid))/{{alias}} parents), and a short example. For `batch`, embed the full op reference (create/todo/update/move/delete/outline) in the help epilog.
- [x] **Position control for batch `create`.** Creating a section heading via batch appends it mid/end-of-page; getting it into place needed a re-`get` to learn its uid plus a second `move` with a hand-computed top-level index. Support `index` on `create` (and document whether `{{alias}}` works as `move.uid`, not just as `parent`).
- [x] **Token-lean output modes.** Tool output is resent with the whole conversation every turn in an agent loop, so verbosity compounds. Add: `get --section "## H"` / `--depth N` (fetch a subtree instead of a 5k-token page); a lower default `search` limit plus `--compact` (title + uid, no snippets); minified `--json` (pretty-printed 2-space indent costs ~25% extra for machine consumers). Matters most for [[pkm-wn2s]].
- [x] **Empty-result hints.** `query` returning `{"groups": [], "total": 0}` gives the agent nothing to steer by. Consider a hint field (e.g. per-ref match counts: "[[Meeting]] matches 312 blocks, [[Databases]] matches 51, intersection 0") so the caller can tell "bad query shape" from "genuinely nothing".

What already works well (keep/lean into): `refs` breadcrumbs answered "who did I meet and when" almost by themselves; natural-language date titles in `get`; `--uids` output pairing cleanly with `update`/`batch`.

The search→get→refs→get-daily loop is the shape an in-app "ask my PKM" feature would take; these four items remove most of the round-trips.

## Summary of Changes

- `pkm search`: `--exact` (whole-word, no prefix wildcard), `--compact` (titles + `[page] ^uid`, no snippets), CLI default `--limit` now 10.
- `pkm query`: `--expand` (one-hop transitivity through refs); response includes `ref_counts` per operand, rendered as "per-ref block counts: ..." when total is 0.
- `pkm get`: `--resolve-refs` (inlines `((uid))` as `"text" ((uid))`, cycle-safe), `--section "## H"` (subtree only, pages only), `--depth N` (clip nesting; works on uid targets too).
- `pkm batch`: `create`/`todo`/`move` accept `"index"` (insert position); `{{alias}}` now works as `uid` in `update`/`move`/`delete`, not just as `parent`.
- `--json` output is minified (single-line) for all verbs.
- Every verb's `--help` has a self-sufficient epilog with examples; `pkm batch --help` embeds the full op reference.
- MCP tools updated to match: `search` (exact), `query` (expand), `get_page`/`get_block` (resolve_refs).
- Server: `/api/search?exact=`, `/api/query?expand=` + `ref_counts` in `QueryPayload`; `openapi.json` and `web/src/api/types.d.ts` regenerated.
- Docs: README "CLI and MCP access" and `.claude/skills/pkm/SKILL.md` updated for all of the above; fixed a stale/incorrect claim in SKILL.md about `update` conflicts erroring (it never errors — LWW plus a `[[conflict]]`-tagged sibling); fixed a typo in `pkm batch --help`.
