# Title brands: a title's name and type say which kind it holds

Bean: pkm-hc95. Builds on the brand check (`2026-10-17-brand-check-design.md`),
which left titles out.

## Why

A title is one of three kinds, and the code mostly does not say which:

| Kind | What it is | Brand today |
|---|---|---|
| raw | text naming a page as someone typed it: an input box, a URL segment, a CLI or MCP argument, a request body, import source | none (`str`) |
| normalized | through `normalize_title` / `normalizeRefTitle` / `canonicalizeTitle`: control whitespace collapsed | `NormalizedTitle` |
| canonical | the spelling stored in `pages.title`, under the live plain-space flag | `CanonicalTitle` (subtype of normalized) |

A survey (2026-10-19) found about 160 title-named parameters and fields on
the server and 150 on the web outside tests. `title` carries all three
kinds plus things that are not page titles (a dialog heading, a GoodLinks
article title). About 29 server and 30 web sites hold a canonical title
typed as a plain string, so a raw string could be passed in their place
without a type error. Two real bugs came from mixing kinds on the web
(pkm-ebkf, pkm-9hn0).

## Decisions (Arthur, 2026-10-19)

1. **Bare `title` is registered too**, not only the specific names.
2. **A new `RawTitle` brand** marks raw text, minted at the wire contracts
   and at the places raw text enters (URL parsing, input boxes, CLI/MCP,
   the importer). No runtime change: a brand is a type only.
3. **Two branches**: the brand and the kind-specific names first, then bare
   `title`.

## Design

### The hierarchy

`CanonicalTitle` ⊂ `NormalizedTitle` ⊂ `RawTitle` ⊂ string.

Any title can stand where a raw one is expected: a canonical title is
text someone could have typed. The reverse is a type error. This extends the
existing `NormalizedTitle` ⊃ `CanonicalTitle` relation one level up, so a
function that accepts any title (a link, a lookup, `pagePath`) takes
`RawTitle` and needs no union.

- Server: `RawTitle = NewType("RawTitle", str)`;
  `NormalizedTitle = NewType("NormalizedTitle", RawTitle)`; each `brand()`ed.
- Web: `RawTitle = string & { __brand: "RawTitle" }`;
  `NormalizedTitle = RawTitle & { __normalized: true }`;
  `CanonicalTitle = NormalizedTitle & { __canonical: true }`. The web lint's
  single hard-coded subtype (`__canonical`) becomes a chain of subtype keys,
  where the most-derived key names the brand.

### Minting raw titles

One function per side: `refs.as_raw_title(text: str) -> RawTitle` and
`asRawTitle(text: string): RawTitle` in `web/src/replica/titles.ts`. It does
not change the text: it declares "this text names a page as typed". Callers
call it where raw text enters; only those two files and the wire contracts
construct `RawTitle` directly. A parser or normalizer whose input is text
that is not yet a title (block text, a regex capture) names that parameter
`text` and takes a plain string.

### Names

| Name (camelCase derived) | Must be | Branch |
|---|---|---|
| `raw_title` | `RawTitle` | 1 |
| `ref_title`, `normalized_title` | `NormalizedTitle` | 1 |
| `canonical_title`, `daily_title`, `src_page_title` | `CanonicalTitle` | 1 |
| `page_title`, `new_title`, `old_title` | any of the three | 1 |
| `title` | any of the three | 2 |

The names in the last two rows are the wire's: requests and ops carry raw
titles under them and responses carry canonical ones, and the names cannot
change. Each accepts any title brand, so the *type* states the kind there.
The kind-specific names are what internal code uses when a reader needs the
kind from the name alone.

"Any of the three" is a NAMES entry listing all three brands, not a
supertype match: the lint stays a per-brand comparison.

### The wire

- Request fields that carry a title are typed `RawTitle`: `CreatePageRequest.title`,
  `AddSidebarEntryRequest.title`, `RenamePageRequest.new_title`, and the
  `page_title` of `CreateOp`, `UpdateTextOp`, `MoveOp` and `CreatePageOp`.
  The web sends whatever kind it holds; all are assignable.
- `DeleteBlockerModel.page_title` becomes `CanonicalTitle` (it already holds
  one).
- Route path and query `title` parameters are branch 2.

### Non-page titles (branch 2)

Fields named `title` that are not page titles are renamed:
`ConfirmOptions.title`, `SettingsSection.title` and the like become
`heading`, and `RouteMeta.title` becomes `documentTitle`. Three are on the
wire and are renamed with no opt-out: `CurrentWorkSection.title` becomes
`heading`, and the GoodLinks `title` on `GoodlinksLink` and
`GoodlinksArticle` becomes `article_title`. The SPA is `autoUpdate` with
`skipWaiting`, so a stale bundle meets the new server only until it reloads.

### The `block_rewrites` table

Its `old_title`/`new_title` columns hold block text for `inline` rewrites,
and an empty string for `unlink`. They read under `COLUMN_KEYS` aliases
(`rewrite_old_text`, `rewrite_new_text`), and `BlockRewrite`'s fields are
renamed to match, so the registered names never meet them.

## Non-goals

- Runtime checks or validation of any title. Nothing changes on the wire or
  in the database.
- Fixing pkm-ebkf or pkm-9hn0: they are separate bug fixes, though branch 2
  makes the kinds they mix visible.
- Collection names (`titles`, `title_map`): they stay unregistered unless a
  branch's sweep finds them single-kind.

## Anti-goals

- An allow-list or baseline of existing violations: every site is converted.
- A cast or `as` to a title brand outside its mint sites.
