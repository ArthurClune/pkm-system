# Titles and refs

How block text names pages: the ref grammar shared by the server and the web,
how a title is canonicalised and looked up, and which titles are refused.
The rest of the server is in [backend.md](backend.md).

## Ref grammar

`refs.py` owns the grammar (`[[links]]`, `#tags`, `attr::`, `((refs))`,
`{{embeds}}`), and `web/src/grammar/scan.ts` mirrors it.

| Rule | Python | TS | Pinned by |
|---|---|---|---|
| Code hides refs; in one left-to-right pass, whichever of a closed fence or an inline span starts first wins | `strip_code` | `scanCode` | `ref_grammar.json` |
| Three backticks followed by an ASCII word character (`[A-Za-z0-9_]`) open a fence rather than close one | `_WORD_CHAR` | `WORD_CHAR_RE` | `ref_grammar.json` |
| A link, `#[[tag]]` or attribute whose title as written holds a backtick is no ref; an enclosing run goes with it | `holds_backtick` | `holdsBacktick` | `ref_grammar.json` |
| A title blank once normalised is no ref | `is_blank_title` | `isBlankRefTitle` | `refs_parity.json`, `title_parity.json` |
| A title with a `.`, `..` or empty `/` segment is no ref, so `#work/` typed on the way to `#work/notes` is never refused | `has_unreachable_segment` | `hasUnreachableSegment` | `title_parity.json` |
| An indented `Title::` is an attribute, its span anchored on the title | `attribute_title_span` | `scanGrammar` | `scan.test.ts` (`"  Key:: v"` at offset 2) |
| The `((uid))` shape, which `UID_RE` and the `BlockUid` brand shape are built from | `BLOCK_REF_TOKEN` | `UID_TOKEN` | `scan.test.ts`, `test_rows_vocabulary.py` |
| How deep `[[` runs nest: the height of the run tree over the code-stripped text | `link_nesting_depth` | `linkNestingDepth` | `text_limits_parity.json` |
| A `#tag` name is a run of `_`, `/`, `.`, `-` and the word characters in `TAG_WORD_RANGES` | `_TAG_NAME` | `TAG_CHARS_RE` | `ref_grammar.json`, `test_tag_chars_artifact.py` |

Each rule's reason sits beside its Python symbol. Both scanners stay
linear: a failed fence-closer search retires the fence rule for the rest of
the text. No word test uses a runtime's own Unicode table, because Python's
lags a browser's and the two sides would disagree on a block's refs. The
fence closer's test is ASCII. A tag name must admit non-ASCII letters, or
`#café` would stop being a tag. Its class is the frozen table in
`contracts/tag_chars.py` (`TAG_CHARS_UNICODE_VERSION`), so a Python or
browser upgrade changes no tag. Only `tag_chars_dump --table` moves the
table to a newer Unicode.

`rename.py` and `unlink.py` keep no copy of the grammar. They locate refs
through `strip_code`, `bracket_spans`, `tag_spans` and `attribute_title_span`,
so they cannot find a ref the index missed or splice over code. A replaced
span hides every ref inside it: an outer `[[run]]` its nested runs, and a
leading attribute the `#tags` in its name (`#a b::` is the attribute `#a b`
and the tag `a`). Rename, merge and their replay match a spelling through
`rename.spelled_or_canonical`, so `[[ Old ]]` is rewritten under plain-space
canonicalisation too.

Writes refuse a text whose runs nest past `MAX_LINK_NESTING`
([text limits](write-path.md#work-bounds-under-the-write-lock)), measured by
`link_nesting_depth` over every run, ref or not.
`ops_core.find_op_title_violation` judges only ref runs, so it does not bound
nesting: a run with an unreachable segment (`[[a//...`) is no ref. Runs
inside a `{{query: …}}` or `{{pdf: …}}` body count too, though the web does
not tokenize that body, so the count can only be too high.

Rows stored before the limit can nest deeper, so every walk over
`BracketSpan.children` keeps its own stack (`bracket_spans`,
`rename._rewrite_range`, `unlink._unlink_range`). A recursive walk fails past
the recursion limit, and the page such a block links could then not be
renamed or deleted.

## Title integrity and one-time activation

`refs.canonicalize_title` has two layers. The durable
`plain_space_title_canonicalization` flag selects the second:

| Layer | Runs | Does |
|---|---|---|
| fold (`normalize_title`) | always | every run of `TITLE_WHITESPACE` becomes one U+0020; if that changed anything, edge U+0020 goes too, else the title comes back byte for byte |
| plain-space strip | flag active | strips edge U+0020 whatever the fold did, so a canonical title is its words joined by single spaces |

The flag is inactive on any database neither imported nor migrated, since
only the title migration sets it and every import runs that migration.
There a title with nothing to fold keeps its single-space edge padding
(` A `), so legacy rows still resolve.

`contracts/titles.TITLE_WHITESPACE` is the whitespace set, written out
because Python's `\s` and JS's differ and either would split a page between
server and replica. The web gets the list
[generated](backend.md#generated-artifacts-and-parity-fixtures). Blankness keeps
Python's `strip()` (`is_blank_title`, mirrored by `stripLikePython`), and
after the fold the edge strip is `strip(" ")`, never `strip()`.

**A title that arrives as a lookup key goes through `sync_meta.read_title`
before it meets `pages.title` or `sidebar_entries.title`.** Both are exact
matches, so a raw title the rules would change misses its page. The entry
points are a `{title:wholepath}` route parameter, the `page` filter on
`/api/todos` and `/api/changed`, a `[[Page]]` operand in `{{query}}`
(`query_exec.parse_canonical_query`) and the `POST /api/sidebar` title.

The `wholepath` convertor (`server/wholepath.py`) replaces Starlette's `path`,
which stops before a final newline, on title and file-path routes and the
SPA fallback. `test_title_routes_props.py` checks every title-taking route
(its list comes from OpenAPI) and CLI verb against generated spellings.
The web's sidebar form sends input untrimmed, because `trim()`'s set is not
`TITLE_WHITESPACE` and the flag decides edge U+0020.

Every creation path funnels through `store.get_or_create_page()`. Daily pages
(`daily.py`) are auto-created on read and cannot be renamed.
`ops_apply._broadcast_op()` echoes the stored title in place of the caller's
`page_title`, so replicas receive the authoritative spelling.

Activation is an operator action, `pkm migrate-titles`;
[docs/cli.md](../cli.md#one-time-title-canonicalization) has the audit, its
survivor and blocker rules, and the digest workflow.
`pkm/title_migration_core.py` plans it. Its `sidebar_retitles` lists every
sidebar entry the target rule changes that no group already moves.
Replacement values are opaque: `rename.rewrite_title_refs_map()` never
rescans one. `audit_title_migration()` runs in a read transaction it always
rolls back, and its `digest` covers the whole relevant snapshot. Apply
takes it back as `audit_digest` and re-inventories under the
[write lock](write-path.md#the-write-lock). It answers 409 to each refusal
cli.md lists, a stale digest among them. It makes every change in one
transaction, activation and the `db_generation` rotation included. One
forced seq frame
follows, and replicas rebootstrap before replaying pending intent
([sync-and-offline.md](sync-and-offline.md#title-activation-across-online-and-offline-paths)).

Apply also runs on an active database, because a change to the fold rule
leaves rows that were canonical under the old one. A page whose stored
title the new fold changes is unreachable, since every key folds, so only
the migration can merge or retitle it.

`server/title_migration.check_titles_at_startup`, run from the app lifespan,
logs one ERROR on `pkm.titles` naming the stored page and sidebar titles the
live rule would change. It never refuses to start (its docstring says why)
and never repairs, because a merge is irreversible and stays a
digest-confirmed operator action. Some rows it reports have no migration
remedy; [docs/cli.md](../cli.md#rows-the-migration-cannot-fix) gives each
one's fix.

## Refused titles

`refs.title_syntax_reason` refuses a title as `forbidden_syntax` when it holds:

| Syntax | Why |
|---|---|
| `#`, `[[`, `]]` | ref syntax |
| a trailing `]` | `[[a]]]` reads back as `a` |
| a trailing `[` | unlinking `[[a[]]` leaves `a[`, which joins a following `[a[]]` into a fresh link, so a page delete's unlink re-forms one link per pass |
| a backtick | it pairs with another on the line into a code span that hides the ref |
| a `.`, `..` or empty `/` segment (`/x`, `a//b`, `a/../b`) | no URL: clients drop dot segments and the router collapses `//` |

Every rule judges the title edge-stripped of U+0020
(`target_canonical_title`) whatever the flag, because the pure ops check
never knows the flag and must not pass ` a] `. A title is refused at
creation, rename, move, sidebar pin, import, and in the migration audit. In
block text a ref with `#`, `[[`, `]]` or a trailing `]` or `[` fails the
batch with a 400; a backtick or no URL makes it [no ref](#ref-grammar). `...`
and `a.b` are ordinary titles. A row stored with a title ending in `[`
stays readable and deletable;
[Page mutations](write-path.md#page-mutations-and-the-sidebar) bounds its
unlink.

A title whose fold (`normalize_title`) is longer than
`MAX_PAGE_TITLE_CHARS` code points is refused too (`refs.title_length_over`,
whose docstring says why the fold is measured). That holds at creation,
rename, move, sidebar pin and import, but not in the migration audit, which
only shortens a title. In block text a link, tag or attribute to such a
title fails the batch with a 400. `refs.title_refusal` judges length before
syntax, so a refusal never echoes the title.

`get_or_create_page` refuses only creating such a page (`TitleTooLongError`).
A row stored before the cap stays readable, renamable to a shorter title and
deletable, and a reindex keeps its backlinks (`index_ref`). An
op naming it as a `page_title` or a link is refused until the page is
renamed. `update_text`'s `page_title` hint is never judged: refusing it
would refuse an edit to a block on such a page and discard the offline
batch.

## Blank titles

A blank title is unreachable, so `get_or_create_page()` raises
`BlankTitleError` and each caller picks its recovery:

| Caller | Recovery | Why |
|---|---|---|
| `POST /api/pages` | 422 | a live client can retry |
| `ops_apply._resolve_page()` | file under `UNTITLED_PAGE_TITLE`, `"Untitled"` | the ops path must never 422 |

`"Untitled"` is an ordinary title, so blank-title ops land on a user's real
"Untitled" page if one exists. A blank ref indexes nothing
([Ref grammar](#ref-grammar)), or `[[   ]]` would make a phantom backlink on
"Untitled". `store.index_ref()` also skips a ref that
raises `BlankTitleError`.
