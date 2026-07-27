# Image Descriptions for Uploaded Assets — Design (pkm-zx19 child)

**Date:** 2026-07-27
**Status:** Approved
**Epic:** pkm-zx19 (file browser and attachment improvements)

## Context

pkm-zx19 covers two nearly-independent pieces: a file browser for asset
management, and LLM-generated searchable descriptions for images. The epic is
split into two child beans; this spec covers the **image descriptions
pipeline**, which ships first because it decides where searchable asset text
lives — the file browser then builds on its column and endpoints.

Most images in this PKM are graphs and technical diagrams, so v1 is
text-extraction-plus-brief-description via a cheap vision model.

Current state (verified 2026-07-27):

- Assets are content-addressed files at `<assets_dir>/<sha256[:2]>/<sha256>`
  with a DB row `assets(sha256, filename, mime, size, created_at)`
  (`server/src/pkm/schema.py`, in `BASE_DDL` — replicated to browser
  replicas). References are plain markdown inside `blocks.text`; there is no
  join table, no list endpoint, no deletion.
- Upload is `POST /api/assets` (`server/src/pkm/server/routes_assets.py`),
  synchronous, online-only.
- The assistant (pkm-wn2s) is the only LLM integration; it uses the Claude
  Agent SDK on the machine's subscription with **no API key**. Image
  descriptions are the server's first direct model-API call.
- There is no server-side settings storage; the web `/settings` page is a
  static section list.

## Decisions (settled during brainstorming)

| Axis | Decision |
| --- | --- |
| Storage | New columns on `assets`; **not** markdown alt text (per-reference, pollutes editing/undo, retro-scan would rewrite user content) |
| Searchability | File-browser filter + CLI/MCP surface. Main search bar / FTS / offline shim parity **untouched** in v1 |
| Provider | OpenAI vision model via plain httpx, key from `OPENAI_API_KEY` env. Describer sits behind a protocol seam so ollama/other providers can be added later |
| Timing | Async after upload (upload latency unchanged) + retro-scan endpoint reusing the same queue |
| PDF scope | Images only in v1; PDFs are a follow-up bean |
| Enable/disable | On iff `OPENAI_API_KEY` set and `config.json` doesn't set `"image_descriptions": false`; `/settings` shows read-only status |

## Architecture

New package `server/src/pkm/describe/`, mirroring the assistant's
engine-seam layout:

- **`core.py`** — `# pattern: Functional Core`. Pure logic:
  - Eligibility: raster image mimes only (the image subset of
    `ALLOWED_UPLOAD_MIME`, excluding SVG), size ≤ ~15 MB. Oversized or
    ineligible assets are skipped with a recorded reason — no Pillow
    downscaling dependency in v1.
  - Prompt construction: instruct the model to extract all visible text and
    add a one-or-two-sentence description, optimised for search.
  - Response parsing and truncation (cap stored description at 1000 chars).
  - Status derivation: `described` (description NOT NULL) / `failed`
    (describe_error NOT NULL) / `pending` (neither).
- **`openai_client.py`** — `# pattern: Imperative Shell`. One httpx POST to
  the OpenAI chat completions API with the image as a base64 data URL.
  Model defaults to `gpt-4o-mini`, overridable via `config.json`
  `image_description_model`. Explicit timeout; errors mapped to a short
  stored error string. No OpenAI SDK dependency.
- **`service.py`** — `# pattern: Imperative Shell`. Defines the
  `ImageDescriber` protocol (async `describe(image_bytes, mime) -> str`) —
  the injection seam, like `AgentEngine`. Real implementation wraps
  `openai_client`; tests inject a fake. Owns a single asyncio worker task
  draining an in-memory queue of sha256s, processing **sequentially**
  (rate-limit friendly). Held on `app.state`, started in the app lifespan,
  cancelled on shutdown. Queue contents do not survive restart — the
  retro-scan recovers anything missed.

### Data flow

1. `POST /api/assets` stores the asset exactly as today. If the feature is
   enabled and the asset is an eligible image, the sha256 is enqueued
   fire-and-forget; the upload response is unchanged and never waits.
2. The worker loads the file bytes, calls the describer, and writes
   `description` + `described_at` (or `describe_error`) to the row.
3. `POST /api/assets/scan` enqueues every eligible asset with
   `description IS NULL AND describe_error IS NULL`; `force=true` also
   re-enqueues failed ones. Returns `{queued: n}`. (The file-browser bean
   adds the button; until then the CLI can trigger it.)

## Schema

`assets` gains three nullable columns:

```sql
description    TEXT     -- model output, ≤1000 chars
described_at   INTEGER  -- epoch ms
describe_error TEXT     -- short reason: "no api key", "http 429", "too large", …
```

- DDL updated in `BASE_DDL` (`schema.py`) **and** guarded
  `ALTER TABLE assets ADD COLUMN …` migrations in
  `server/db.py:_ensure_schema_migrations` (SQLite has no
  `ADD COLUMN IF NOT EXISTS`; `view_type` is the precedent).
- Because `assets` is client-facing, the generated schema hash changes and
  every browser replica rebootstraps once after deploy. This is a known,
  already-exercised path (view_type backfill, offline epic pkm-y8p0).
  *Considered alternative:* a server-only `asset_descriptions` table in
  `SERVER_DDL` would avoid the rebootstrap, but splits asset data and buys
  nothing once the one-time rebootstrap has happened; replicated
  descriptions also keep the door open for offline asset search later.
- No FTS table for descriptions in v1. Asset search uses `LIKE` (see below),
  which is fine at personal scale (hundreds–low thousands of assets).

## API / CLI / MCP

- **`GET /api/assets/search?q=&limit=`** — case-insensitive `LIKE` over
  `description` and `filename` (escaped like `/api/titles`). Returns
  `{assets: [{sha256, filename, mime, size, created_at, url, description,
  status}]}`. With empty `q`, returns the most recent assets — the seed of
  the file-browser bean's list endpoint, which will extend it with
  date/type filters and pagination.
- **`POST /api/assets/scan`** — as above. Both routes require the normal
  session auth.
- **CLI:** `pkm assets search "term"` and `pkm assets scan [--force]`
  following the existing verb pattern (`cli/main.py` epilog + handler,
  client methods on `PkmClient`, rendering in `render.py`).
- **MCP:** `search_assets` tool (docstring = contract, registered in the
  tuple in `mcp/server.py`, short name added to `READ_TOOLS` in
  `assistant/policy.py` so the assistant may call it). This is how LLMs
  find image content.
- **OpenAPI:** `openapi.json` + generated web types must be regenerated and
  committed with the route changes (established rule from pkm-c3kz).

## Configuration & enablement

- Enabled iff `OPENAI_API_KEY` is present in the service environment **and**
  `config.json` does not set `"image_descriptions": false`.
- `config.json` optional keys: `image_descriptions` (bool, default true),
  `image_description_model` (string, default `gpt-4o-mini`).
- Feature state is exposed as `{enabled, reason}` via a dedicated
  `GET /api/assets/describe-status`; the web
  `/settings` page gains a read-only section: "Image descriptions:
  enabled (OpenAI)" / "disabled — no OPENAI_API_KEY" /
  "disabled — image_descriptions=false". New `SECTIONS` entry in
  `web/src/views/Settings.tsx`.

## Error handling

- Missing key / disabled: uploads behave exactly as today; nothing is
  enqueued; `/settings` explains why. `pkm assets scan` returns the
  disabled reason with a non-zero exit.
- Model/API failure (timeout, 4xx/5xx, unparseable response): the asset is
  untouched except `describe_error`; upload already succeeded. Retry via
  `scan --force`.
- Ineligible mime (SVG, PDF, CSV, …): never enqueued and no error recorded —
  "no description" is the normal state for non-images, not a failure.
  Eligible images over the size cap get `describe_error = "too large"` so
  the file browser can show why honestly.
- Worker crash: exceptions per item are caught and recorded; the worker task
  itself is supervised by the lifespan (log + no restart loop in v1).

## Testing

- `core.py` pure unit tests: eligibility matrix, prompt build, parse,
  truncation, status derivation.
- `openai_client.py` against `httpx.MockTransport`: success, timeout, 429,
  malformed body.
- Queue/service tests with a fake describer: upload enqueues, scan
  enqueues/force semantics, sequential processing, error recording,
  disabled feature enqueues nothing.
- Route tests for `/api/assets/search` (LIKE escaping, empty q) and
  `/api/assets/scan`.
- CLI/MCP: handler tests per existing patterns.
- Web: Settings section renders each status variant.
- **Manual live smoke before deploy** (real OPENAI_API_KEY, real image):
  fake-based CI cannot catch provider-contract drift — lesson from
  pkm-wn2s.

## Out of scope (v1)

- PDFs (follow-up bean; likely first-page render via pypdfium2).
- Main search bar / FTS / offline-parity integration.
- Ollama or other providers (protocol seam keeps the door open).
- Image downscaling for oversized files.
- The file browser UI itself, including the scan button (sibling bean).
