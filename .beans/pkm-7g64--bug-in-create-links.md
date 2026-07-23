---
# pkm-7g64
title: bug in create links
status: completed
type: bug
priority: normal
created_at: 2026-07-23T19:45:42Z
updated_at: 2026-07-23T20:13:42Z
---


Bean pkm-965i created the link button, but one case is missed

Correct

testpage is here -> [[Testpage]] is here
and link [to a webpage] about stuff -> and link to a webpage about stuff #[[Testpage]]

Incorrect

a link test https://testpage.com/url more text -> a link test https://[[Testpage]].com/url more text

## Summary of Changes

Root cause: `linkUnlinkedReference` (web/src/grammar/linkReference.ts, the
Functional Core behind pkm-965i's link button) only protected page-refs,
hashtags, block-refs, code, and Markdown `[label](dest)` links from being
wrapped. A bare `https://...` URL is none of those, so a plain-text
occurrence of the title inside a URL's host/path/query (e.g. "testpage" in
"https://testpage.com/url") passed the alnum-boundary check and got wrapped,
corrupting the URL.

Chosen behaviour: treat bare URLs as atomic — never wrap a candidate whose
span overlaps a bare URL. If that was the only occurrence, the result is
`no-safe-match` (do nothing) rather than a corrupted edit; an eligible
occurrence elsewhere in the same text (before/after an unrelated URL, or a
repeat of the word outside any URL) is still linked normally. This mirrors
the existing "protect, don't guess" design pkm-965i already used for
page-refs/hashtags/code/Markdown links, and matches the exact bare-URL
boundary + trailing-punctuation-trim rule `tokenize.ts` already uses for
autolinking, so "inside a URL" here means the same thing it means when the
app renders an autolinked URL.

Files changed:
- `web/src/grammar/linkReference.ts` — added `scanBareUrls` (mirrors
  tokenize.ts's bare-URL boundary/trim rule) and included its spans in the
  protected-span set used for the "plain" wrap path.
- `web/src/grammar/linkReference.test.ts` — added failing-first tests for
  title inside a URL host, http vs https, path segment, query string, an
  eligible plain occurrence adjacent to an unrelated URL, the same word
  appearing both inside and outside a URL, and an unrelated word elsewhere
  in text containing a URL.

Test evidence:
- `pnpm vitest run src/grammar/linkReference.test.ts` — 4 new tests red
  before the fix (reproducing the exact bean corruption), 17/17 green after.
- `pnpm typecheck` — clean.
- `E2E_PORT=8982 pnpm verify` (run twice, plus a third targeted rerun) —
  typecheck, lint, fcis boundary check, and unit coverage (1419 tests) all
  green; e2e 26/27 passed both full runs. The one intermittent e2e failure,
  `e2e/backlink-filter.spec.ts` (pkm-m4an, unrelated feature), was verified
  as a pre-existing flake unrelated to this change: it passed in isolation
  both on this branch and after `git stash` back to the pre-fix commit.
  `tooling/lintConfig.test.ts` also flaked once under full-suite load (known
  flake per CLAUDE.md) and passed cleanly when rerun alone.
