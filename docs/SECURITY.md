# Security model

PKM is a single-user, self-hosted application behind Tailscale, which is the
network security boundary. The application's own authentication protects
against casual attackers on a local network or other reachable devices. It
does not make the server safe to expose to the public Internet.

The last scoped security review was on 2026-10-23; its findings and
verification limits are in the [separate report](security-review-2026-10-23.md).

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

`ts.net` is a public suffix, so the cookie's site is the whole tailnet
(`<tailnet>.ts.net`), not this host. Any other host in the tailnet, including a
service published with Tailscale Funnel, is same-site: its pages send the cookie
on subresource requests and WebSocket handshakes. JSON routes refuse the
"simple" requests such a page can send, but `/api/ws` does not check `Origin`
and streams the text of every applied op
([review report](security-review-2026-10-23.md)).

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
  [review report](security-review-2026-10-23.md). An approved `upload_asset` can read any
  service-account-readable file whose extension maps to an allowed type, not
  just files under `local_docs_root`. A relative path resolves against the
  server's working directory, so in production `../../data/config.json` is the
  server's own config.
- **Write gating.** Every call to a tool in `WRITE_TOOLS` (`policy.py`) waits
  for confirmation in the UI, and a denial reaches the model as a declined
  action. Generic previews clip each argument at `_MAX_PREVIEW_VALUE_CHARS`;
  batch previews instead clip each entire serialized `params` object, which
  can hide a target argument (see the [review report](security-review-2026-10-23.md)).
  The card also collapses to `PREVIEW_COLLAPSE_THRESHOLD` characters
  (`AssistantPanel.tsx`) with Allow still active, and arguments appear in the
  order the model emitted them, so a target after a long value is hidden
  until expanded.
  The preview must never render empty, because an approval card that
  understates a write is worse than a verbose one. Any
  payload `ops_preview` does not recognise falls through to a dump of every
  argument. After renaming a tool's parameters, check `ops_preview` against a
  live payload: a unit test that asserts an invented shape still passes.
- **Subprocess auth.** Each conversation mints an ordinary session token into
  a `0600` config file passed as `PKM_CLI_CONFIG`. Deleting the file on close
  does not revoke the token.
- **Abandoned turns.** The conversation cap, idle reaping, cancellation order
  and keepalives that stop an abandoned turn spending tokens are in
  [assistant.md](architecture/assistant.md#keepalives-and-the-stall-watchdog).

## Known limitations

These are accepted for the current threat model. Revisit them before
broadening exposure.

| Limitation | Consequence |
|---|---|
| Login backoff is per source (`LoginThrottle`, `throttle_core.py`: `BASE_BACKOFF_MS` doubling to `MAX_BACKOFF_MS`), with no lockout. The source is `request.client.host`, which for loopback connections (Tailscale Serve) uvicorn's defaults take from `X-Forwarded-For`; the throttle is checked before the password and a failure recorded after it | concurrent guesses from one source all pass the check until the first failure lands, so a burst gets about as many guesses as there are worker threads. Scrypt makes each guess expensive, but a weak password is open to patient guessing; use a strong one |
| No logout and no per-session revocation | a copied cookie works until it expires or `session_secret` is rotated, which ends every session |
| Each device keeps the full replica (OPFS), the unsent outbox and viewed uploads (Cache Storage, served without an auth check), and nothing clears them on a `401` | rotating `session_secret` ends sessions but not on-device copies; offline reads work whatever the cookie state. Clearing a device takes the in-app reset or clearing site data |
| Each router adds `Depends(require_auth)` itself, and the WebSocket checks by hand | a new router could omit it. No test enumerates the route table anonymously; `test_auth.py` checks routes one by one |
| No `Origin` checks on writes or WebSocket upgrades; no CSP, `frame-ancestors` or other anti-framing headers | `SameSite=Lax`, same-origin requests, React escaping and the narrow boundary limit the risk against other sites, but not against another host in the tailnet, which is same-site and can read the WebSocket's op stream; these would limit a future browser-side mistake |
| The direct Tailscale-IP listener is plain HTTP | Tailscale encrypts the hop, but login sends the password over it. Browsers should use the Serve HTTPS URL; never expose the listener on an untrusted network |

## Hardening priorities

If the threat model expands, make changes in this order:

1. Add a temporary lockout on top of the per-source backoff.
2. Mount every private route under one authenticated parent router, and add a
   test that walks the route table anonymously and expects `401` everywhere
   but the public routes.
3. Add logout, shorten the default session lifetime, and write down a
   session-secret rotation procedure.
4. Validate origins for state-changing requests and WebSocket upgrades. Do
   this first if the tailnet hosts anything that serves third-party content.
5. Add CSP, anti-framing, referrer-policy and related response headers.
6. Review password-hashing parameters and dependency vulnerabilities against
   current guidance.

Application hardening is not a substitute for Tailscale or another
authenticated, encrypted network boundary.
