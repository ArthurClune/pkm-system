# Security model

Last reviewed: 2026-07-14

PKM is a single-user, self-hosted application that runs behind Tailscale.
Tailscale is the primary network security boundary. The application's own
authentication is modest: it protects against casual attackers on a local
network or other reachable devices. It does not make the server safe to
expose directly to the public Internet.

## Deployment assumptions

A production deployment should listen only on:

- `127.0.0.1`, the upstream for Tailscale Serve; and
- the machine's literal Tailscale IP, when direct tailnet API access is
  needed.

The default bind host is loopback (`bind_hosts` in `config.json`). Do not
configure `0.0.0.0`, an ordinary LAN address, or public port forwarding.
Tailscale Serve provides HTTPS for browser access; keep `cookie_secure`
enabled in production.

Anyone who can read the server's data directory can read the database and
assets directly. Filesystem access by other local operating-system users is
outside the network threat model. `pkm.server.setup` writes `config.json` with
mode `0600`; keep the data directory, database, assets and backups private to
the service account.

## Authentication

A successful `POST /api/login` exchanges the single configured password for
an HMAC-SHA256-signed session cookie (`pkm_session`). The password is stored
as a scrypt hash with a random salt. Session signatures and password hashes
are compared in constant time.

The session cookie is:

- `HttpOnly`;
- `Secure` by default;
- `SameSite=Lax`;
- scoped to `/`; and
- valid for up to 365 days.

Every data-bearing HTTP route requires a valid session, including:

- page, block, journal, search, query and current-work reads;
- operation, page, journal and sidebar writes;
- snapshot and incremental sync;
- asset upload and download; and
- `/api/openapi.json`.

`/api/ws` runs the same signed-cookie check before accepting a WebSocket
connection, and refuses an unauthenticated client's handshake with HTTP `403`
([how](architecture/backend.md#auth)).

These routes are public:

- `GET /login`;
- `POST /api/login`;
- `GET /healthz`, which returns only `{"ok": true}`; and
- the SPA shell and its static JavaScript, CSS, manifest, icons and service
  worker.

The application does not enable CORS. Browser API requests are same-origin,
and `SameSite=Lax` is the only CSRF protection for the session cookie. CORS
is not an authentication mechanism: non-browser clients can always send
requests, and get `401` without a valid cookie.

## Additional protections

- FastAPI's API documentation routes are disabled.
- Uploads are size-limited (`max_upload_bytes`) and stored by SHA-256 digest.
  The declared type must be on an allowlist (images, PDF, plain text, JSON and
  Office documents; `ALLOWED_UPLOAD_MIME`), or the upload gets a `415`.
- Asset paths validate the digest; the requested filename is not used for the
  filesystem lookup.
- Assets are served with `X-Content-Type-Options: nosniff`.
- SVG and other potentially active uploads are served as downloads, never
  rendered inline in the application's origin.
- Client-rendered links reject `javascript:` and protocol-relative URLs.
- Diagrams render through beautiful-mermaid, which escapes label text; its
  stock-mermaid fallback runs with `securityLevel: "strict"`. Other text
  relies on React escaping.
- Configuration secrets are generated with the operating system CSPRNG and
  kept out of the repository.

## Known limitations

These are accepted for the current threat model. Revisit them before
broadening exposure.

### Login throttling is per source, not per account

`LoginThrottle` (`server/src/pkm/server/auth.py`, policy in
`throttle_core.py`) applies a per-source exponential backoff to failed logins
(1 s doubling to a 30 s cap) and caps concurrent scrypt work so a flood of
connections cannot starve the worker-thread pool. The source is
`request.client.host`. Behind Tailscale Serve that is the proxy, so every
tailnet client shares one backoff bucket, and direct-IP clients get their
own. There is no temporary lockout. Scrypt makes each guess expensive, but a
weak password is still open to patient online guessing. Use a strong, unique
password.

### Long-lived, non-revocable sessions

Sessions stay valid for up to one year. There is no logout endpoint and no
per-session revocation. A copied cookie works until it expires or
`session_secret` is rotated. Rotating that secret invalidates every existing
session.

### Decentralized route enforcement

Each HTTP feature router adds `Depends(require_auth)` itself, and the
WebSocket runs a manual check. All existing data routes are protected, but a
newly added router could omit the dependency.

Mount future private routes through a single authenticated parent router,
leaving only the public routes outside it. Keep a contract test that
enumerates the route table and checks that anonymous requests cannot reach
any `/api` or `/assets` endpoint except `/api/login`.

### Browser defence in depth

The application does not validate the `Origin` header for mutating HTTP
requests or WebSocket upgrades. It sets no Content Security Policy,
`frame-ancestors`, or other clickjacking headers. `SameSite=Lax`,
same-origin browser requests, React escaping and the narrow deployment
boundary reduce the immediate risk. Explicit origin checks and security
headers would limit the impact of future browser-side mistakes.

### Third-party HTML from GoodLinks

`GET /api/goodlinks/{link_id}` is the one route that returns HTML the
application did not write: the reader-view body GoodLinks extracted from a
web page. Two independent barriers stand between that HTML and the app.
The server reduces it to an explicit allowlist of tags and attributes
(`goodlinks.py`, `sanitize_article`), dropping scripts, styles, event
handlers, forms, frames, every URL scheme but http and https, and any
relative or protocol-relative URL — article images and links must be
absolute http/https or they are dropped. The web reader then renders only
inside `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox"
srcdoc>`, the one place third-party HTML reaches the DOM, so even HTML that
slipped the allowlist runs no script and has no access to the app's origin
or cookies. Neither barrier may be loosened for convenience; a tag that is
not listed is meant to disappear. Article images still load from their
original hosts, so opening a copy reveals the reader's IP to those hosts, as
it does in GoodLinks itself.

### Direct HTTP access

The direct Tailscale-IP listener uses plain HTTP. Tailscale encrypts traffic
between tailnet devices, but browser users should use the Tailscale Serve
HTTPS URL. Never expose the direct HTTP listener on an untrusted LAN or the
public Internet: login sends the password to it.

## Hardening priorities

If the threat model expands, make changes in this order:

1. Add a temporary lockout on top of the per-source backoff.
2. Centralize the authenticated router boundary and add an anonymous route
   contract test.
3. Add logout, shorten the default session lifetime, and write down a
   session-secret rotation procedure.
4. Validate origins for state-changing requests and WebSocket upgrades.
5. Add CSP, anti-framing, referrer-policy and related response headers.
6. Review password-hashing parameters and dependency vulnerabilities against
   current guidance.

Application hardening is not a substitute for Tailscale or another
authenticated, encrypted network boundary.

## Embedded assistant

The assistant runs server-side. The browser talks only to `/api/assistant/*`,
which requires the same `pkm_session` cookie as every other API route.
Provider credentials never reach the browser. Claude models use the service
user's Claude login through the Claude Agent SDK; the `glm` model uses the
z.ai key read from `zai_api_key_file` (default `PKM_HOME/zai_key`) or
`ZAI_API_KEY`. Mechanisms are in
[architecture/assistant.md](architecture/assistant.md).

- **Prompt injection.** Note content is untrusted input to the model. A fully
  injected model can reach only the
  [`pkm-mcp` tools](architecture/cli-and-mcp.md#the-mcp-tool-surface). The
  harness runs with every built-in tool disabled (no shell, filesystem or web
  access) and `setting_sources=[]`, so filesystem settings and `CLAUDE.md`
  are ignored.
- **Write gating.** Each call to a write tool (`save_note`, `update_block`,
  `batch`, `upload_asset`, `rename_page`; `WRITE_TOOLS` in `policy.py`) waits
  for explicit confirmation in the UI. A denial reaches the model as a
  declined action. The confirmation card shows each argument value up to 4000
  characters; a longer value is clipped at that bound. Long previews collapse
  behind a "Show full preview" toggle, which reveals everything the server
  sent and nothing beyond the 4000-character bound.

  The preview must never render as empty, because an approval card that
  understates a write is worse than a verbose one. `batch` is the only tool
  with its own rendering (one line per `{"command", "params"}` item). Every
  other tool, and any `batch` payload that does not parse as a list of
  commands, falls through to a generic dump of every argument. If you change
  a tool's parameter names, check `ops_preview` against a live payload as
  well as its unit test: a test that asserts an invented shape still passes.
- **Subprocess auth.** Each conversation mints a fresh `pkm_session` token
  into a `0600` config file, passed via `PKM_CLI_CONFIG` and pointing at the
  loopback listener. The file is deleted when the conversation closes. The
  token is a standard session token with one-year validity, so deleting the
  file does not revoke it.
- **Resource caps.** At most 3 concurrent conversations. At the cap, a new
  conversation evicts the least-recently-used idle one; only when every
  conversation is busy streaming does the request get a 409. Conversations
  idle for 15 minutes are reaped when the next one is created; there is no
  background timer. The web client also sends a `navigator.sendBeacon` close
  request on `pagehide`, so a normal tab close or navigation cleans up at
  once. Conversations do not survive a server restart.
- **Turn cancellation.** When the SSE connection drops mid-turn (navigation,
  or the panel's Stop button aborting the fetch), the server first declines
  any confirmation still awaiting a decision, then calls the harness's
  `interrupt()`, so an abandoned turn stops spending turns and tokens
  unobserved up to `max_turns`.

  Do not swap that order. A harness waiting inside `can_use_tool` cannot
  acknowledge an interrupt until it gets its decision, so awaiting
  `interrupt()` first would leave the turn parked until the server restarts.
  The `interrupt()` await is also bounded (`INTERRUPT_TIMEOUT_S`), so a
  harness stuck for any other reason cannot hold up cleanup.

  Cleanup can only be as prompt as disconnect detection, and a turn can
  write nothing for minutes (long reasoning, a large tool call, a
  confirmation waiting on the user). A client that died without a clean
  close is invisible during that silence. A comment frame every
  `KEEPALIVE_INTERVAL_S` (15 s, `routes.py`) keeps the connection clear of
  NAT and proxy idle timeouts and forces a write often enough that a dead
  peer surfaces quickly
  ([details](architecture/assistant.md#keepalives-and-the-stall-watchdog)).

## Review evidence

The 2026-07-14 review covered application routing, authentication and
session primitives, WebSocket handling, asset handling, server binding,
configuration generation, frontend rendering boundaries and deployment
scripts. An anonymous route-table probe returned `401` for every documented
data route and `200` only for `/healthz`. The targeted authentication, API,
asset, sync, sidebar, operations and WebSocket tests passed (96 tests).

This was a focused review of the repository's security model. It was not a
formal penetration test or an audit of every third-party dependency.
