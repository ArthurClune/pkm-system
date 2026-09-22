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
  the row, then unlinks the file after the commit. A crash then leaves at worst
  an unreferenced file on disk, never a row pointing at a missing file. A block
  left empty *and* childless is deleted outright, but an emptied parent is kept:
  asset deletion must never cascade away real content. Asset URLs never produce
  `refs` rows — only `[[link]]`, `#tag` and `attr::` do — so no refs reindex is
  needed.
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
