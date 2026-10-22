# Files and assets

The content-addressed asset store behind the `/files` browser
(`pkm/assets_core.py`, `pkm/server/routes_assets.py`) and the LLM captions that
make image content findable (`pkm/describe/`). The routes are in the API
reference table in [backend.md](backend.md#http-api-reference); the SPA side is
in [frontend.md](frontend.md). Failures and their fixes are indexed by symptom in
[troubleshooting.md](../troubleshooting.md).

## Assets and the file browser

Uploads stream in 1 MiB chunks with a running size cap (413 over
`max_upload_bytes`, default 150 MB), MIME-sniffed from the first chunk
(`mime_sniff.py`). Files are stored content-addressed at
`<assets_dir>/<sha256[:2]>/<sha256>` and deduplicated by digest; the `assets`
row keeps the display filename, MIME and size. Raster images and PDFs serve
inline (`INLINE_MIME`). Everything else, including SVG, which can script, is
forced to download with `nosniff`.

An asset's sha256 is `Sha256Hex` (`contracts/ops.py`, shared with the op hash
fields in [sync-and-offline.md](sync-and-offline.md#offline-editing-and-reconnect)),
not a plain string, so a text can never reach an asset route or wire field
where a digest belongs. `routes_assets.py` validates every sha256 path
param against the shared `SHA256_HEX_RE` before minting it; `assets_core.py`'s
hashing functions mint it directly from `hashlib`. On the web, the only mint
point is `grammar/tokenize.ts`'s `/assets/<sha>/<name>` autolink rule, whose
regex capture group already guarantees the shape. A sha failing that match —
too short, uppercase, or merely a substring of some other URL, e.g. an
external link containing `/assets/` — renders as plain text or a generic
link, never as an asset reference.

The upload response's `existing` bool records whether the `assets` row was
already there before this call (a dedup hit) or is brand new. The CLI/MCP upload
workflow keys its failure compensation on it — see
[cli-and-mcp.md](cli-and-mcp.md#shared-write-workflows).

The three management endpoints behind the `/files` browser share
`assets_core.py` for their pure parts:

- **Search** is `LIKE` over `description` and `filename` rather than FTS: a
  personal-scale table, and no offline-parity burden. `linked`/`orphan`
  filtering needs refs for every candidate, so that path scans the whole
  filtered set; `linked=all` computes refs only for the returned page.
- **Delete** strips every asset reference token out of block text and removes
  the row, then unlinks the file after the commit. `strip_asset_tokens` finds
  markdown links with the web's rule (`grammar/markdown.ts`), and removes both
  URL spellings: the percent-encoded name `asset_url` returns now, and the raw
  name older uploads wrote. Each removed token takes one adjacent space with
  it and every other character stays byte for byte; a text left holding only
  whitespace becomes empty. A crash then leaves at worst
  an unreferenced file on disk, never a row pointing at a missing file. A block
  left empty *and* childless is deleted outright, but an emptied parent is kept:
  asset deletion must never cascade away real content. Asset URLs never produce
  `refs` rows — only `[[link]]`, `#tag` and `attr::` do — so no refs reindex is
  needed. With `?if_unreferenced=true` nothing is stripped: the delete is
  refused with 409 while any block references the asset, and undoing an upload
  (`sync/assetRelease.ts`) is its only caller. Another device uploading the
  same bytes just before the delete runs is not protected, the same exposure
  as a `/files` delete.
- **Selected-asset zip** is form-encoded, so the web app can drive it with a
  plain `<form method="post">` and let the browser own the download. Unknown,
  malformed, duplicate and missing-on-disk digests are skipped rather than
  erroring, so the zip contains what could be exported, and filename collisions
  get a short sha prefix (`zip_arcnames`).

  The selection's count and total bytes are checked against fixed limits
  (500 assets / 1 GiB, `MAX_EXPORT_ASSET_COUNT` and `MAX_EXPORT_TOTAL_BYTES` in
  `routes_assets.py`) before any archive is built. The byte total is summed from
  the `assets` table's `size` column, never by opening a file. Over either limit
  the request is refused with 413, rather than producing a truncated zip.

  Both this route and the whole-graph `/api/export.zip` stream their archive
  from a temp directory via `CleanupFileResponse`
  ([backend.md](backend.md#module-map)), whose cleanup runs even when the file
  is missing at send time.

## Image descriptions

Uploaded raster images are captioned by an LLM so their content becomes
findable. A caption is a plain-text transcription of any visible text plus one
or two descriptive sentences, stored in three `assets` columns: `description`,
`described_at` and `describe_error`.

Eligibility is MIME-only: `image/png`, `image/jpeg`, `image/webp` and
`image/gif`. HEIC and SVG are uploadable but not describable. Eligibility
ignores content, so every `image/gif` upload is enqueued regardless of
animation.

### Modules (`pkm/describe/`)

| File | Pattern | Role |
|---|---|---|
| `core.py` | Core | Eligibility (`describe_action`), the OpenAI request payload, response parsing, and status derivation (`described` / `failed` / `pending`) |
| `service.py` | Shell | `DescribeService`: the queue, the worker, and shutdown |
| `openai_client.py` | Shell | The `ImageDescriber` implementation — one `httpx2` POST per image against the OpenAI chat-completions endpoint, with no OpenAI SDK |
| `routes.py` | Shell | The status and scan endpoints (asset search lives in `routes_assets.py`, alongside the other asset routes) |

### The queue

`DescribeService` holds an in-memory `asyncio.Queue`, drained by one sequential
background worker per process, for rate-limit friendliness. An `_active` set of
queued and in-flight shas makes `maybe_enqueue` and `scan` idempotent; the
worker discards the sha in a `finally`. `_process` re-reads the row and returns
early if a description has appeared since.

`OpenAIDescriber.describe` turns every answer into a description or a
`DescribeError`, which `_process` records as `describe_error`. Any other
exception is only logged, so the asset stays pending until the next scan. A
body `json.loads` cannot read (nesting past its recursion limit) is a
`DescribeError` too, and `parse_description` makes the text well-formed,
since SQLite refuses to store a lone surrogate.

The queue is memory-only. A restart drops whatever was pending, and there is no
persistence or replay on startup. `POST /api/assets/scan` re-enqueues every
asset with `description IS NULL` — add `force=true` to retry rows that
previously failed — and is the recovery path after a restart or an outage.

Passing an `ImageDescriber` to the service transfers ownership of it. Shutdown
uses one retained, cancellation-shielded task that cancels the worker first and
then closes the provider transport exactly once. If describer shutdown raises,
`app.py` still attempts assistant conversation cleanup in a `finally`.

### Configuration

| `config.json` key | Default | Effect |
|---|---|---|
| `openai_api_key_file` | `PKM_HOME/openai_key` | The on/off switch. The file's contents win over the `OPENAI_API_KEY` env var, so a pkm-specific key is not shadowed by a general-purpose one in the shell environment |
| `image_descriptions` | true | Master switch |
| `image_description_model` | `gpt-4o-mini` | The vision model |

The default key path is the `PKM_HOME` root, a sibling of `data/` rather than
inside it, so the secret never sits alongside servable or exportable content. It
is resolved relative to `config.json` like the other paths. The key file is
never committed and should be mode 600.

A missing key — env and file both absent or empty — or
`image_descriptions: false` degrades every entry point to a no-op
(`DescribeService.enabled = False`) rather than failing uploads.
`GET /api/assets/describe-status` and the `/settings` page surface *why* it is
off, through `enabled_reason`.

### Descriptions in search

Descriptions are queryable only through `GET /api/assets/search`, the `LIKE`
search above. They are not indexed into `blocks_fts` or `pages_fts`, and are not
reachable from `GET /api/search`.

## Local documents

`local_docs_root` names an on-disk document tree, usually in iCloud Drive,
that `Local copy::` links point into. The `/api/local*` routes
(`routes_local.py`, pure parts in `local_docs.py`) are the only ones that read
outside the data directory, and `/api/local/{path}` is the only one that
returns file contents. The routes are in
[backend.md § HTTP API reference](backend.md#http-api-reference).

**Every rejection is a 404, never a 403, so a response never confirms what
exists.** `local_docs.clean_relative` rejects an absolute path, a `.` or `..`
segment, a control character or a backslash. `is_within` then re-checks the
resolved candidate against the resolved root, so a symlink out is a 404 too.
The file route's parameter arrives decoded once and uses the
[`wholepath` convertor](backend.md#title-integrity-and-one-time-activation);
`/api/local/check` starts from a raw href in block text, so it goes through
`resolve_relative`, which unquotes once. `check` is registered ahead of the
catch-all.

| File state | `/api/local/{path}` | `/api/local/check` |
|---|---|---|
| href fails `resolve_relative` | — | `invalid` |
| outside the root, not a regular file, or absent with no stub | 404 | `missing` |
| an `.icloud` stub beside a missing file (`_is_evicted`) | 503 + `Retry-After`, after a best-effort `brctl download` | `evicted` |
| `SF_DATALESS` set in `st_flags` (`_is_dataless`) | the same; never opened, since opening blocks while it downloads | `evicted` |
| open probe fails or times out | 503 `the host can't open this file` | `unreadable` |
| probe cap full | 503 `too many file opens are in flight on the host; see the server log` | `unchecked` |
| probe succeeds | `FileResponse`, inline for PDF and image extensions, else attachment, `nosniff` | `ok` |

The two eviction helpers are shared by both routes so they cannot disagree.

### The open probe

`open()` on an iCloud path can block in the kernel for good while macOS waits
for a consent prompt. `FileResponse` would run that `open()` on anyio's shared
threadpool, leaking a thread per attempt until every sync route hung. So a
resolved file is never handed to `FileResponse` unprobed.
`local_open.OpenProber` runs `os.open` on its own daemon thread with a
timeout, shares one thread among callers asking about the same path, and caps
distinct in-flight probes (`DEFAULT_CAP`). A blocked `open()` cannot be
cancelled, so the cap is the bound on stuck threads; daemon threads keep a
stuck one from holding up shutdown. A caller joining a probe in flight waits
only for what is left of its timeout. `busy` gets its own detail because it
says nothing about the file.

The probe and `FileResponse` each open the file, so a file that becomes
unopenable between the two still hangs after the 200 headers. That window is
accepted.

### The index

`/api/local-index` lists the folder for the link-to-local-file picker. It
never opens a file, so listing does not download an evicted one. A directory
listing can block like an `open()`, so `local_index.TreeScanner` walks on a
daemon thread and abandons the walk after its timeout. Only one scan is in
flight: a later caller joins it and gets 503 at once if the walk has overrun.
The 503's detail is `the host can't read the local documents folder`.
An unreadable directory at any depth fails the whole scan rather than
returning a partial list.

The index lists only names `clean_relative` accepts (`visible_name`), so the
picker never offers a link the file route 404s; a skipped directory is not
entered. An evicted `.Name.ext.icloud` stub is listed as `Name.ext`. Hrefs come
from `local_href`, and the route's path sits outside `/api/local/` so the
catch-all cannot shadow it.

### Errors a person sees

A failure on the file route is JSON for `fetch()` and pdf.js, which read only
the status. A browser navigation gets a short HTML page with the same status
and `Retry-After`, plus `no-store`; otherwise Safari saves the JSON as
`<name>.pdf.json`. `local_docs.wants_html_error` decides:
`Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`, or, from a browser
that sends neither, an `Accept` naming `text/html`.
