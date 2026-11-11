# One-time title canonicalization

`pkm migrate-titles` runs the title migration against a running server
([why it exists](architecture/titles-and-refs.md#title-integrity-and-one-time-activation)).
The migration merges pages whose titles now name one page, retitles
sidebar entries the title rules no longer produce, and activates the rule
that strips a title's leading and trailing spaces. It is audit-first and
manual. Server startup never audits or applies it, and a deploy or restart
does not activate it.

Startup only checks: it logs one ERROR on `pkm.titles` naming each stored
page title or sidebar entry the live rules would change, then serves on. Such
rows appear when the rules change on a database already migrated. Run the audit
when that line appears.

Set both the config and the URL explicitly so the command cannot fall back to
the CLI defaults:

```bash
PKM_CLI_CONFIG=/explicit/target-config.json PKM_URL=https://explicit-target \
  uv run --project server pkm migrate-titles
PKM_CLI_CONFIG=/explicit/target-config.json PKM_URL=https://explicit-target \
  uv run --project server pkm migrate-titles --apply <audit-digest>
```

The audit has no side effects. It prints the migration state, a 64-hex
digest, each canonical group with its survivor, sources, counts and merge
order, each sidebar entry it would retitle, and every blocker with an
`all_space` or `forbidden_syntax` reason. Review it before applying.

`--apply` requires that exact digest. The first condition that holds
decides:

| Condition | Result |
|---|---|
| database changes since the audit have altered the plan | refused |
| the audit lists blockers | refused |
| the migration is already active and the audit lists no group and no sidebar entry | refused |
| none of the above | applied; a migration not yet active is activated, even when run only to merge the pages the startup check named |

A successful apply runs in one transaction. It retitles and merges pages,
rewrites inbound references and sidebar entries, activates the new title
rule, and rotates the sync generation. Its output counts each kind of change,
`sidebar entries retitled` (`sidebars_retitled` in `--json`) among them. Take
the normal backup first. Run it against production only when production was
explicitly requested and both variables point there.

## Rows the migration cannot fix

A blank or refused canonical title, on a page or a sidebar entry, is reported
at startup but cannot be migrated.

A page whose title the fold turns into a blank or refused one, such as
`Notes/` followed by a non-breaking space, is a blocker. It refuses the whole
apply, and no route reaches it, because every lookup key folds. Retitle it by
hand:

1. Back up the database ([deploy/README.md § Backups](../deploy/README.md#backups)).
2. From Python's `sqlite3`, list the blocks that link the page, so you can
   find them after the rename:
   `SELECT b.uid, b.text FROM refs r JOIN blocks b ON b.uid = r.src_block_uid
   WHERE r.target_page_id = ?` with the blocker's id.
3. Still in `sqlite3`, run
   `UPDATE pages SET title = ?, updated_at = ? WHERE id = ? AND title = ?`
   in one `BEGIN IMMEDIATE`. Pass a canonical title no page holds, the time
   in ms, and the blocker's id and exact title from the audit's `--json`.
   Roll back unless one row changed. The `pages_chg_au` trigger records the
   change for replicas.
4. Rename the page as usual, then audit again. The rename re-indexes the
   linking blocks, and their old spelling folds to a refused title, so those
   links stop being backlinks, and the web refuses to edit a block that still
   holds one. Edit each block from step 2 to link the new title.
5. The page's own pin keeps the old spelling. Call
   `DELETE /api/sidebar/{entry_id}` with its id from `GET /api/sidebar` (or
   remove it in the sidebar's edit mode), then pin the new title.

A sidebar entry whose canonical form is blank or refused is skipped, because
no pin can hold that title. With nothing else to do, apply answers "already
active". Remove the entry in the sidebar's edit mode, or call
`DELETE /api/sidebar/{entry_id}` with the id from `GET /api/sidebar`.

## What the title rules are

Runs of whitespace in a title fold to one space (`TITLE_WHITESPACE` in
`server/src/pkm/contracts/titles.py` lists what counts), so `A  B`, `A`+NBSP+`B`
and `A B` all name the page `A B`.
A title with `#`, `[[`, `]]` or a backtick, a trailing `]` or `[`, or a `.`,
`..` or empty `/`-separated segment is refused, online and offline.
Once the migration is active, leading and trailing ordinary spaces are removed
from every title.
[titles-and-refs.md § Refused titles](architecture/titles-and-refs.md#refused-titles)
has the complete list and the reasons.
