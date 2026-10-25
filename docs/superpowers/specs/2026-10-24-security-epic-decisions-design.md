# Security epic (pkm-mfd0): Arthur's decisions for the remaining fixes

Decided 2026-10-24 in conversation, so the remaining children of pkm-mfd0
can run without stopping. Each bean's own spec or plan builds on the line
here; where a line says "my call", it was the orchestrator's default and
Arthur did not object.

## Intent

Close the 2026-10-23 review's remaining findings
(`docs/security-review-2026-10-23.md`) without changing how Arthur uses
PKM. A limit that a person would never reach is preferred to a rewrite
that keeps an unbounded input working.

## Decisions

| Bean | Decision |
|---|---|
| pkm-u1jk allowed origins | `/api/ws` and the cookie-carrying simple-request routes accept only PKM's own origins: the Tailscale Serve hostname (a new config key), each `bind_hosts` listener with its port, and localhost for e2e and scratch servers. A request with no `Origin` header still works (CLI, `pkm-mcp`, Shortcuts, curl). No cross-origin browser caller exists (no bookmarklet, extension, clipper or other tailnet app). After deploy, verify with a real browser on the Serve hostname, WebSocket included; on any failure revert the merge on main, redeploy, then report |
| pkm-ak4e title fold | A title's whitespace runs fold to one plain space at page creation and at lookup: U+0020, control whitespace and NBSP (U+00A0) alike. Other Unicode space characters fold too (my call). The whitespace set is one explicit character list shared by server and web, not either language's `\s`. Prod has no title or link with a double space or control whitespace; its three NBSP titles are renamed through the API before the new rule deploys (Arthur approved those three renames). The title migration groups pages that now share a spelling (imports); a database already migrated under the old rule gets a startup check for titles that are no longer canonical. Title proptest gate required |
| pkm-gc3n block text cap | 1,000,000 Unicode code points per block (Python `len`; web `[...text].length`). Refused on every write path: ops, importer, CLI, MCP, assistant. A paste in the editor past the cap shows a notice and does not paste; nothing is truncated. An import holding a longer block is refused, naming the page. No prod row is over the cap (largest 258,277 on 2026-10-24) |
| pkm-bppf `[[` nesting | A write-time limit of 32 levels of nested `[[`, refused like the block cap, imports included (refused, naming the page). This replaces rewriting the web tokenizer. Prod's deepest nesting is 2 |
| pkm-g2w9 approval card | The card shows the current text (clipped) and page of each block a write updates, moves or deletes, read when the card opens. A batch that reuses an `as` alias is refused (my call). The other residuals (bounded refusal messages and card size, `dir="ltr"` on values, client-side key allow-list) are engineering |
| pkm-stny export gather | Priority raised from low to normal. Stop gathering once the gathered items exceed the export budget and refuse with the same `ExportTooLarge` 422 |
| pkm-iw03 stale-unlink at the cap | (Arthur, 2026-10-25) Allow the defuse's two backticks to land a block 2 characters over the 1,000,000 cap, and document it. Reachable only by an at-cap offline edit plus a page deleted meanwhile; the block can only shrink afterwards |
| pkm-0l8g request size | (Arthur, 2026-10-25) Cap every authenticated request body except uploads at 64 MiB, refused before parsing. The web refuses a single command over 500 ops or the cap with the notice "This change is too large to save in one step." A paste of more than 500 lines no longer gets lost |
| Page title length | (Arthur, 2026-10-25) Page titles are limited to 1,000 characters, refused on create, rename and import like the other title rules; check prod first |

## Running unattended (Arthur, 2026-10-24)

Each bean runs on its own branch and worktree, through subagents, with an
adversarial review and every gate that applies (server gates,
`pnpm verify`, proptest for titles, ops, sync or outline commands,
`perf/check.sh` before merge). Then merge to main with `--no-ff`, deploy,
verify the deploy, and push, without asking per bean. Order: pkm-u1jk
first, then the handoff's order, pkm-e95y (SECURITY.md) last.

Stop and ask Arthur only for:

1. A change to prod data other than the three approved NBSP renames.
2. A perf regression or property failure that cannot be explained, or
   that needs a product call.
3. A new product question a bean turns up.

## Left to the builders

Everything not in the table: pkm-zav2, pkm-v3t1, pkm-85jq, pkm-lamg (a
temporary Serve on 8443 is an established pattern), pkm-oirq, pkm-u48q,
pkm-dhsp and the low-priority clean-ups are engineering decisions,
recorded as rulings in each plan's ledger.
