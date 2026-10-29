# Security small fixes: GoodLinks link, importer report title, batch warning

Three low-priority beans from the security epic (pkm-mfd0), one branch
(`security/small-fixes`). Each bean's checklist is its spec; this plan adds
the rulings and the exact places to change.

## Global Constraints

- TDD: write the red test first, watch it fail for the stated reason, then
  fix.
- FCIS: every file with runtime behaviour keeps its `# pattern:` header.
- Comments: no bean ids, line numbers or plan pointers in code, test or
  `docs/architecture/` comments; comment lines at most 80 columns, code
  lines at most 120. Only write a comment the next reader would need several
  tool calls to work out.
- Docs: one row per fix in `docs/troubleshooting.md` (symptom, cause,
  owning section, bean id), matching the existing rows' shape. Edit
  `docs/architecture/` only where the rule changed (Task 3). Never write
  "load-bearing".
- `docs/SECURITY.md` is public: describe mechanisms only, never the state
  of a deployment's credentials.
- Gates for a task that touches the server: `cd server && uv run pytest -q`,
  `uv run pyrefly check`, `uv run ruff check`, and from the root
  `PYTHONPATH=server/tooling python3 -m commentlint.run --all`. For a task
  that touches the web: `cd web && set -o pipefail && E2E_PORT=<your port>
  pnpm verify`. Run gates as `cmd > log 2>&1; echo EXIT=$?`.
- If a server route, response model or route docstring changes, regenerate
  `web/src/api/openapi.json` per `docs/architecture/backend.md`
  § Generated artifacts and parity fixtures.

## Task 1: GoodLinks reader's original link checks its scheme (pkm-6rto)

Model: sonnet. Files: `web/src/components/GoodlinksReader.tsx`,
`web/src/components/InlineSegments.tsx` (export the helper), a vitest test
beside the reader, `docs/SECURITY.md`, `docs/troubleshooting.md`.

`GoodlinksReader.tsx` renders `<a href={article.url} …>original</a>`
straight from GoodLinks' answer. React 18 renders a `javascript:` href.
Markdown links already go through `isSafeHref` in `InlineSegments.tsx`,
which is module-private today.

1. Red test: render the reader with an article whose `url` is
   `javascript:alert(1)`; assert no element in the output has an `href`
   starting with `javascript:` (case-insensitive; also try
   ` JavaScript:` with leading whitespace if `isSafeHref` handles that).
   Add a passing case that an `https://` url still renders as a link.
2. Fix: export `isSafeHref` (keep one implementation; do not copy it) and
   use it in the reader. Ruling: when unsafe, render the URL as plain text
   in place of the link, as `InlineSegments` does for a bare unsafe href,
   so the reader still shows where the article came from.
3. `docs/SECURITY.md` (around "In the browser, links rendered from
   markdown reject `javascript:`"): widen the sentence back to every link
   the browser renders, and drop any wording that names this reader's
   link as an exception. Read the paragraph and its Known-limitations
   rows (search "GoodLinks" and "original") and remove the exception there
   too.
4. Troubleshooting row.

## Task 2: importer report clips an over-long refused title (pkm-5sot)

Model: sonnet. Files: `server/src/pkm/importer/report.py`, its test under
`server/tests/`, `docs/troubleshooting.md`.

`importer/report.py` lists a page skipped because its title is past
`MAX_PAGE_TITLE_CHARS` with the whole title, so a 2M-character title
prints 2M characters to the terminal.

1. Red test: build a report whose `skipped_pages` holds a page with a
   2,000,000-character title; assert the rendered report is short (its
   length is bounded independent of the title length — assert it is under
   a few thousand characters) and still says which page it was.
2. Fix. Ruling: clip rather than replace with `LONG_TITLE_LABEL` — in a
   CLI report the start of the title is what identifies the page. A title
   longer than `MAX_PAGE_TITLE_CHARS` prints as its first 80 characters,
   then `…`, then ` (<N> characters)`, inside the same `json.dumps`
   quoting the report uses today. Apply the same clip to every title the
   report prints (`title_changes`' original and sanitized titles,
   `recovery_page_title`) through one helper, since any of them could come
   from the import file. Titles at or under the cap print unchanged.
3. Troubleshooting row.

## Task 3: assistant panel marks a batch that skipped ops (pkm-9ljt)

Model: sonnet. Files: `server/src/pkm/assistant/events.py`,
`server/src/pkm/assistant/claude_engine.py` (`_finished`), the web event
type and the panel's tool line component (find them from
`tool_finished` in `web/src`), tests on both sides,
`docs/architecture/assistant.md` § A write's result,
`docs/troubleshooting.md`.

`render_ops_ack` (`server/src/pkm/render.py`) returns
`warning: skipped N of M ops; …` as a successful tool result, so
`ToolFinished` carries neither `declined` nor `error`, and the panel shows
`✓` for a batch that skipped some ops.

1. Red tests: server — the mapper turns a successful `ToolResultBlock`
   whose text starts `warning:` from a write tool into a `ToolFinished`
   with a new `warning` field holding the warning; a successful result not
   starting `warning:` leaves it unset; a read tool's result never sets
   it. Web — the panel renders a `ToolFinished` with `warning` as a
   distinct mark (not `✓`, not `✗`; use `⚠`) followed by the warning's
   first line as text, never as HTML.
2. Fix. Rulings: the field is `warning: str | None`, set only for a
   successful (non-error, non-declined) write-tool result whose text
   starts `warning:`; carry only the first line, clipped server-side with
   the same clip `tool_error_reason`'s reason gets; the web renders it as
   text. Keep the wire event's existing fields unchanged.
3. `docs/architecture/assistant.md` § A write's result: change the
   skipped-ops row of the table to the new field and panel line (`⚠` and
   the warning). Troubleshooting row.
