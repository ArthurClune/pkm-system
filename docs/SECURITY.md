# Security model

Last reviewed: 2026-07-14

PKM is a single-user, self-hosted application designed to run behind
Tailscale. Tailscale is the primary network security boundary. The
application's authentication layer is deliberately modest and is intended to
protect against casual attackers on a local network or other reachable
devices; it is not intended to make the server safe for direct exposure to the
public Internet.

## Deployment assumptions

A production deployment should listen only on:

- `127.0.0.1`, used as the upstream for Tailscale Serve; and
- the machine's literal Tailscale IP, when direct tailnet API access is
  required.

The default bind host is loopback. Do not configure `0.0.0.0`, an ordinary LAN
address, or public port forwarding. Tailscale Serve provides HTTPS for browser
access; `cookie_secure` should remain enabled in production.

Anyone who can read the server's data directory can read the database and
assets directly. Filesystem access by other local operating-system users is
outside the network threat model. `pkm.server.setup` writes `config.json` with
mode `0600`, and the data directory, database, assets, and backups should be
kept private to the service account.

## Authentication

The API is authenticated. A successful `POST /api/login` exchanges the single
configured password for an HMAC-SHA256-signed session cookie. Passwords are
stored as scrypt hashes with a random salt. Session signatures and password
hashes are compared in constant time.

The session cookie is:

- `HttpOnly`;
- `Secure` by default;
- `SameSite=Lax`;
- scoped to `/`; and
- valid for up to 365 days.

All current data-bearing HTTP routes require a valid session, including:

- page, block, journal, search, query, and current-work reads;
- operation, page, journal, and sidebar writes;
- snapshot and incremental sync;
- asset upload and download; and
- `/api/openapi.json`.

`/api/ws` performs the same signed-cookie validation before accepting a
WebSocket connection. Unauthenticated clients are closed with code `4401`.

The following routes are intentionally public:

- `GET /login`;
- `POST /api/login`;
- `GET /healthz`, which returns only `{"ok": true}`; and
- the SPA shell and its static JavaScript, CSS, manifest, icons, and service
  worker.

The application does not enable permissive CORS. Browser API requests are
same-origin, and `SameSite=Lax` supplies the current CSRF protection for the
session cookie. CORS is not an authentication mechanism: non-browser clients
can always make requests, but still receive `401` without a valid cookie.

## Additional protections

- API documentation routes supplied by FastAPI are disabled.
- Uploaded files are size-limited and stored by SHA-256 digest.
- Asset paths validate the digest and do not use the requested filename for
  filesystem lookup.
- Assets are served with `X-Content-Type-Options: nosniff`.
- SVG and other potentially active uploads are forced to download rather than
  rendered inline in the application's origin.
- Client-rendered links reject `javascript:` and protocol-relative URLs.
- Mermaid uses its strict security mode, while normal text rendering relies on
  React escaping.
- Configuration secrets are generated with the operating system CSPRNG and
  are excluded from the repository.

## Known limitations

These limitations are accepted for the current threat model, but should be
revisited before broadening exposure.

### Unlimited login attempts

The login endpoint has no throttling, exponential backoff, or temporary
lockout. Scrypt makes each guess more expensive, but a weak password remains
vulnerable to online guessing by any device that can reach the server. Use a
strong, unique password.

Adding lightweight login rate limiting is the highest-priority hardening
improvement. Any per-client implementation must account for Tailscale Serve
proxying requests rather than blindly trusting arbitrary forwarded headers.

### Long-lived, non-revocable sessions

Sessions remain valid for up to one year. There is no logout endpoint or
individual session revocation list. A copied cookie remains usable until it
expires or `session_secret` is rotated. Rotating that secret invalidates every
existing session.

### Decentralized route enforcement

HTTP feature routers currently add `Depends(require_auth)` independently, and
the WebSocket performs a manual check. All existing data routes are protected,
but a newly added router could accidentally omit the dependency.

Prefer mounting future private routes through a single authenticated parent
router, leaving only the explicitly public routes outside it. Maintain a
contract test that enumerates the route table and verifies that anonymous
requests cannot reach any `/api` or `/assets` endpoint except `/api/login`.

### Browser defence in depth

The application does not currently validate the `Origin` header for mutating
HTTP requests or WebSocket upgrades. It also does not set a Content Security
Policy, `frame-ancestors`, or equivalent clickjacking headers. `SameSite=Lax`,
same-origin browser requests, React escaping, and the narrow deployment
boundary reduce the immediate risk, but explicit origin checks and security
headers would limit the impact of future browser-side mistakes.

### Direct HTTP access

The direct Tailscale-IP listener uses HTTP. Tailscale encrypts traffic between
tailnet devices, but browser users should use the Tailscale Serve HTTPS URL.
Never expose the direct HTTP listener on an untrusted LAN or the public
Internet, especially because login submits the password to that listener.

## Hardening priorities

If the threat model expands, make changes in this order:

1. Add login rate limiting or exponential backoff.
2. Centralize the authenticated router boundary and add an anonymous route
   contract test.
3. Add logout, shorten the default session lifetime, and provide an explicit
   session-secret rotation procedure.
4. Validate origins for state-changing requests and WebSocket upgrades.
5. Add CSP, anti-framing, referrer-policy, and related response headers.
6. Review password-hashing parameters and dependency vulnerabilities against
   then-current guidance.

Do not treat additional application hardening as a substitute for Tailscale or
another authenticated, encrypted network boundary.

## Embedded assistant (pkm-wn2s)

The assistant runs entirely server-side: the browser talks only to
`/api/assistant/*`, which sits behind the same `pkm_session` cookie auth as
every other API route. Provider credentials never reach the browser; the
Claude Agent SDK harness uses the service user's Claude Code login.

Threat model:

- **Prompt injection.** Note content is untrusted input to the model. The
  blast radius of a fully injected model is the eleven PKM MCP tools — the
  harness runs with all built-in tools disabled (no shell, filesystem, or
  web access) and `setting_sources=[]`, so filesystem settings/CLAUDE.md
  are ignored.
- **Write gating.** The four write verbs (`save_note`, `update_block`,
  `batch`, `upload_asset`) each require explicit per-call confirmation in
  the UI before executing; denial is reported to the model as a declined
  action. The confirmation card shows the operation preview in full up to
  4000 characters per value (raised from an earlier 120-character clip that
  made users approve writes they couldn't fully see); pathologically long
  single values (e.g. a very large pasted note) are still clipped at that
  bound, and the panel collapses long previews behind a "Show full preview"
  toggle that reveals everything the server sent (it cannot reveal more
  than the 4000-character bound itself).

  The preview must never be able to render as *empty* — an approval card
  that understates a write is worse than a verbose one. `batch` is the only
  verb with a bespoke rendering (one line per `{"command", "params"}` item);
  every other verb, and any `batch` payload that does not parse as a list of
  commands, falls through to a generic dump of every argument. pkm-y3rr is
  the cautionary tale: that branch read an `ops` key the tool never emitted
  (its signature is `batch(commands)`), so every real batch approval showed
  `batch: 0 operation(s)` and users approved blind. If you touch a tool's
  parameter names, check `ops_preview` against the live payload, not against
  its unit test — the test asserted the invented shape and passed.
- **Subprocess auth.** Each conversation mints a fresh `pkm_session` token,
  written to a 0600 config file passed via `PKM_CLI_CONFIG` and pointing at
  the loopback listener; the file is deleted when the conversation closes.
  The token is a standard session token (1-year validity) — deleting it
  from disk does not revoke it, same as any logged-in session.
- **Resource caps.** At most 3 concurrent conversations. Reaching the cap
  evicts the least-recently-used *idle* conversation instead of rejecting
  the new one (only genuinely busy — actively streaming — conversations can
  still produce a 409); conversations idle for ~15 minutes are also reaped
  when the next conversation is created (no background timer). The web
  client additionally sends a `navigator.sendBeacon` close request on
  `pagehide` for the conversation it holds, so a normal tab close/navigate
  cleans up immediately rather than waiting on the cap or idle timeout.
  Conversations do not survive a server restart.
- **Turn cancellation.** Dropping the SSE connection mid-turn (browser
  navigation, or the panel's Stop button aborting the fetch) calls the
  harness's `interrupt()` rather than only detaching the server's local
  reader, so an abandoned turn stops running instead of continuing to spend
  turns/tokens unobserved up to `max_turns`. Any confirmation still awaiting
  a decision is resolved as declined on the same path, so a `can_use_tool`
  hook cannot outlive the stream that would have answered it.

  This cleanup is only as prompt as the disconnect *detection*, which is not
  bounded: a turn parked on a pending confirmation writes nothing to the SSE
  stream, so a client that dies without a clean close (a sleeping device, a
  dropped network) can leave the conversation `busy` — and therefore immune
  to idle reaping, which skips busy entries — until the dead socket surfaces
  on its own. Measured at over ten minutes on 2026-07-30. Tracked as
  pkm-mbcc.

## Review evidence

The 2026-07-14 review inspected application routing, authentication and
session primitives, WebSocket handling, asset handling, server binding,
configuration generation, frontend rendering boundaries, and deployment
scripts. An anonymous route-table probe returned `401` for every documented
data route and `200` only for `/healthz`. The targeted authentication, API,
asset, sync, sidebar, operations, and WebSocket tests passed: 96 tests in
total.

This was a focused review of the repository's security model, not a formal
penetration test or an audit of every third-party dependency.
