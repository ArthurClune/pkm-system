# Security model

PKM is a single-user, self-hosted application behind Tailscale, which is the
network security boundary. The application's own authentication protects
against casual attackers on a local network or other reachable devices. It
does not make the server safe to expose to the public Internet.

The last security review was on 2026-10-23
([findings](security-review-2026-10-23.md)). This document describes the
system after the fixes that review led to.

## Deployment assumptions

A production server listens only on `127.0.0.1`, the upstream for Tailscale
Serve, and, when direct tailnet API access is needed, the machine's literal
Tailscale IP. `bind_hosts` in `config.json` defaults to loopback. Never
configure `0.0.0.0`, an ordinary LAN address or public port forwarding.
Tailscale Serve provides HTTPS; keep `cookie_secure` enabled in production.
`serve_origins` must name the Serve hostname's origin, or browsers on it can
read but cannot write or open the WebSocket (see
[Authentication](#authentication)).

Start the server through `python -m pkm.server.run`, as the launchd job
does. Only that entry point installs the slow-client deadlines and pins
the proxy-header trust the login throttle keys on
([mechanism](architecture/backend.md#auth)). The server refuses to
start on SQLite older than `MIN_SQLITE_VERSION` (`db_core.py`).

Anyone who can read the data directory can read the database and assets.
Other local operating-system users are outside the network threat model.
`pkm.server.setup` writes `config.json` with mode `0600`; keep the data
directory, backups and `local_docs_root` private to the service account.
The nightly iCloud mirror copies the data directory off the host, minus the
`session_secret`; the password hash still goes (see
[Known limitations](#known-limitations)).
Keep API keys in their key files (`openai_api_key_file`, `zai_api_key_file`,
`goodlinks_api_key_file`) rather than the service environment, which the
assistant's subprocesses inherit (see [Known limitations](#known-limitations)).

## Authentication

`POST /api/login` exchanges the single configured password for an
HMAC-SHA256-signed `pkm_session` cookie. The password is stored as a salted
scrypt hash, and signatures and hashes are compared in constant time
([mechanism](architecture/backend.md#auth)).

The cookie is `HttpOnly`, `Secure` by default, `SameSite=Lax` and scoped to
`/`. The server accepts a token for `auth_core.YEAR_MS` from its issue
(`verify_session`); the cookie's `Max-Age` is `COOKIE_MAX_AGE` (`auth.py`),
which bounds only how long a browser keeps it. `ts.net` is a public
suffix, so the cookie's site is the whole tailnet: a page on any tailnet
host is same-site with the app, and its requests to PKM carry the cookie.

Every `/api` and `/assets` route except `POST /api/login` requires a session,
including `/api/openapi.json`; FastAPI's documentation routes are disabled.
`AuthGateMiddleware` refuses an anonymous request before the app reads its
body: any `/api` or `/assets` request other than `POST /api/login`, any
method other than `GET` or `HEAD`, and every WebSocket handshake. HTTP gets
`401`; `/api/ws` refuses the handshake. The public routes are `GET /login`,
`POST /api/login`, `GET /healthz` (which returns only `{"ok": true}`) and the
SPA shell with its static files. A public body larger than
`PUBLIC_BODY_MAX_BYTES` is refused with `413`.
`test_the_gate_admits_exactly_the_public_routes` walks the route table and
fails when the gate admits any other route.

CSRF protection is `SameSite=Lax` plus `OriginGuardMiddleware`. Every
`/api/ws` handshake and every request whose method is not `GET`, `HEAD` or
`OPTIONS` must, if it carries an `Origin`, name one of PKM's own origins:
`serve_origins`, each `bind_hosts` listener on the served port, and loopback
on that port. `Origin: null` is refused. A request with no `Origin` comes from
a non-browser client (the CLI, `pkm-mcp`, Shortcuts), and still needs the
cookie. There is no CORS, so a sibling page cannot read a response. Safe
methods are not checked, and some have side effects a sibling page could
trigger blind: `GET /api/journal` and a `GET /api/page/` of today's title
create today's daily page, `GET /api/local/...` can start an iCloud download
of an evicted file, and `GET /api/goodlinks/{link_id}` can make GoodLinks
fetch an uncached page. Never set `Referrer-Policy: no-referrer`: it makes the
app's own no-cors form posts send `Origin: null`, which the guard refuses
([why](architecture/backend.md#auth)).

## What a session can reach beyond the graph

| Surface | What it reaches | Confinement | Owner |
|---|---|---|---|
| `/api/local/{path}`, `/api/local-check`, `/api/local-index` | files under `local_docs_root` on the host, read-only | `clean_relative` rejects `..` and absolute paths, and `is_within` refuses a symlink out. A path that escapes the root gets the same 404 as a missing file, so a response never confirms what exists outside it. Inside the root a session may read any file a clean relative path names, dotfiles included, and the index lists all but dotfiles. Only PDFs and raster images (`_INLINE_EXT`, `local_docs.py`) serve inline; everything else, HTML and SVG included, downloads with `nosniff` | [files-and-assets.md § Local documents](architecture/files-and-assets.md#local-documents) |
| `GET /api/goodlinks/{link_id}` | HTML GoodLinks extracted from a web page: the only third-party HTML the app supplies as a document's source (`srcdoc`) | an `nh3` allowlist (`sanitize_article`), then a sandboxed `srcdoc` iframe with no script or origin access. Neither barrier may be loosened. Article images load from their original hosts, which see the reader's IP. `GoodlinksGateway.content` asks for the article's HTML without turning off GoodLinks' download of an uncached page, so opening the reader on such a link makes GoodLinks, on the PKM host, fetch the page from its site. | [files-and-assets.md § GoodLinks copies](architecture/files-and-assets.md#goodlinks-copies) |
| `POST /api/goodlinks/resolve` with `save: true` | any URL, fetched by GoodLinks on the PKM host, a loopback or LAN address included | nothing in PKM restricts the URL; the reader route then returns what GoodLinks extracted from it | [files-and-assets.md § The reader](architecture/files-and-assets.md#the-reader-and-the-goodlinks-command) |
| uploaded assets | images, PDFs and documents under `assets_dir` | `max_upload_bytes`; a type allowlist (`ALLOWED_UPLOAD_MIME`, else `415`); lookup by digest, never by the requested filename; only `INLINE_MIME` types render inline, and SVG and other active types download with `nosniff` | [files-and-assets.md § Assets](architecture/files-and-assets.md#assets-and-the-file-browser) |
| image descriptions | sends each eligible stored image to OpenAI: each upload, and every undescribed one on `POST /api/assets/scan` | the complete stored image goes, EXIF, GPS and any other embedded metadata included, but no note text or filename. On whenever an OpenAI key is present; `image_descriptions=false` in `config.json` turns it off, and `GET /api/assets/describe-status` says why it is off | [files-and-assets.md § Image descriptions](architecture/files-and-assets.md#image-descriptions) |
| `/api/assistant/*` | an LLM harness over the `pkm-mcp` tools; notes go to Anthropic or z.ai | see [Embedded assistant](#embedded-assistant) | [assistant.md](architecture/assistant.md) |
| `POST /api/client/diagnostics` | the server log | writes the posted body to the log and nothing else, cut at `_MAX_DIAGNOSTICS_LOG_CHARS` (`routes_sync.py`); control characters in it are escaped, so it cannot forge a log line | [backend.md § Logging](architecture/backend.md#logging-and-observability) |

In the browser, links rendered from markdown reject `javascript:` and
protocol-relative URLs (`isSafeHref`). The GoodLinks reader's "original"
link is rendered from GoodLinks' answer with no such check.

A URL the browser fetches unprompted is an outbound channel for whoever wrote
the markdown, the assistant's approved writes included. In an assistant reply
only uploaded assets load on render: any other image, a Bluesky embed and a
stock-mermaid diagram wait for a click (`ClickToLoad`). In a note other images
wait for a click too, but a Bluesky post URL embeds on render (see [Known
limitations](#known-limitations)). Diagrams make no fetch: beautiful-mermaid
escapes label text, and the stock-mermaid fallback runs hardened beyond
`securityLevel: "strict"`
([mechanism](architecture/frontend-rendering.md#link-safety-and-external-media)).
Every response the app builds carries `X-DNS-Prefetch-Control: off`, so a
link's host is not resolved before a click; an unhandled `500` carries none.
Other text relies on React escaping.

## Bounds on a session

A session is trusted with the notes, not with the server's availability.
These bounds hold for every authenticated client; the gaps are under
[Known limitations](#known-limitations).

| Bound | Holds | Owner |
|---|---|---|
| Request bodies: `PRIVATE_BODY_MAX_BYTES`, an upload `max_upload_bytes` plus `UPLOAD_ENVELOPE_BYTES` | at the gate: a declared length past the cap is refused before the app reads a byte; a chunked body is counted as the app reads it, and refused once it passes the cap | [backend.md § Auth](architecture/backend.md#auth) |
| Slow clients: a deadline for the request head, a deadline for a public body, a minimum rate for taking a response | in `DeadlineH11Protocol` and the gate | [backend.md § Auth](architecture/backend.md#auth) |
| Block text: at most `MAX_BLOCK_TEXT_CHARS` code points and `MAX_LINK_NESTING` levels of `[[` | on every write path: ops, server-made rewrites and the importer. A stale edit whose replay would pass a limit lands as a conflict entry instead | [backend.md § Planning](architecture/backend.md#planning) |
| Page titles: at most `MAX_PAGE_TITLE_CHARS`, measured on the title's fold | for a new title, at creation, rename, move, sidebar pin and import; a page stored before the cap keeps its title | [backend.md § Refused titles](architecture/backend.md#refused-titles) |
| Server history one batch replays: `MAX_BATCH_REPLAY_WORK`; a page delete's inlined copies: `MAX_DELETE_COPY_CHARS` | under the write lock; an edit past the budget lands as a conflict entry (the block keeps its text), a delete past it is refused | [backend.md § Planning](architecture/backend.md#planning) |
| No malformed or hostile input makes a route answer `500` | every route; a write racing a long batch can still get a `500` from a route without a busy branch ([backend.md § The write lock](architecture/backend.md#the-write-lock)) | [backend.md § Hostile input](architecture/backend.md#hostile-input) |

## Embedded assistant

The browser talks only to `/api/assistant/*`, behind the same session cookie.
Provider credentials never reach the browser: Claude models use the service
user's Claude login, and `glm` reads its key from `zai_api_key_file` or
`ZAI_API_KEY`.

- **Prompt injection.** Note content is untrusted input to the model. A fully
  injected model can reach only the
  [`pkm-mcp` tools](architecture/cli-and-mcp.md#the-mcp-tool-surface) named
  in `READ_TOOLS` and `WRITE_TOOLS` (`policy.py`). The harness starts
  `pkm-mcp` with only those, so `upload_asset`, which reads a host path as
  the service account, is not registered (`MCP_ONLY_TOOLS`); the
  standalone `pkm-mcp` keeps it, running as whoever starts it. Every
  built-in tool is disabled (no shell, filesystem or web),
  `setting_sources=[]` ignores filesystem settings and `CLAUDE.md`, and
  `--strict-mcp-config` keeps the account's claude.ai connectors out. A
  reply can send note text out only through a link or media the user
  clicks (see the rendering rules above). A write the user approves can do
  more: a Bluesky post URL it puts in a note fetches whenever the page is
  viewed (see [Known limitations](#known-limitations)).
- **Write gating.** Every call to a tool in `WRITE_TOOLS` waits for the user
  to allow or deny a card, and a denial reaches the model as a declined
  action. The card is the only barrier between an injected model and the
  notes ([assistant.md](architecture/assistant.md#the-write-approval-card)):
  - the server builds it from the arguments the tool will receive, as the
    tool's own argument model coerces them; input it cannot show is
    refused without a card;
  - every target and content value is shown whole: content past
    `CONTENT_LIMIT_CHARS`, or a target past `TARGET_LIMIT_CHARS`, is
    refused, never clipped;
  - each block an update, move or delete names shows its current page and
    a text excerpt with the full length, read just before the card; a
    delete adds how many blocks go with it. A batch that deletes a subtree
    an earlier write moves a block into, or reuses an `as` alias, is
    refused;
  - Allow arms after a delay, once both ends of the list have been in view;
  - the browser renders only the keys each action may carry, with values
    quoted, isolated left-to-right and their control characters escaped.

  Allow applies only while every block the card shows keeps the text it showed:
  for a delete, the same blocks under it with the same texts. The card's
  hashes go server to server, out of reach of the browser and the model.
  `/api/ops` refuses the write with `412` if a block was edited, a subtree to
  delete changed, or a block appeared under a uid the card showed as missing.
  Where a block sits is not checked, so one moved elsewhere since the card
  still takes the write. A card built while another of the assistant's writes
  could still land is marked stale. A new note, a create and a page rename
  have no stored block to check, so they apply under the server's ordinary
  rules.
- **Subprocess auth.** Each conversation mints an ordinary session token into
  a `0600` config file passed as `PKM_CLI_CONFIG`. Deleting the file on close
  does not revoke the token: it stays valid for `auth_core.YEAR_MS`, like
  any session.
- **Abandoned turns.** The conversation cap, idle reaping and teardown order
  ([registry](architecture/assistant.md#conversation-registry)) and the
  keepalives and stall watchdog
  ([watchdog](architecture/assistant.md#keepalives-and-the-stall-watchdog))
  stop an abandoned turn spending tokens.

## Known limitations

These are accepted for the current threat model. Revisit them before
broadening exposure.

| Limitation | Consequence |
|---|---|
| Login backoff is per source (`LoginThrottle`, `throttle_core.py`: `BASE_BACKOFF_MS` doubling to `MAX_BACKOFF_MS`), one password check in flight per source, with no lockout | The source is the device's tailnet address: on the loopback listener the `X-Forwarded-For` Tailscale Serve sets (trusted from `127.0.0.1` only, `run.FORWARDED_ALLOW_IPS`), on the Tailscale-IP listener the TCP peer. Each device has its own bucket, so a guessing device does not put the others in backoff; a local process can choose its key. Concurrent guesses from one source wait their turn, so a burst costs one scrypt check per backoff window. Every refusal is the same `401`. Scrypt makes each guess expensive, but a weak password is open to patient guessing; use a strong one |
| No logout and no per-session revocation | a copied cookie works until it expires or `session_secret` is rotated, which ends every session |
| Each device keeps the full replica, its unsent outbox and recently viewed uploads (the service worker's `pkm-assets` cache, served without an auth check); nothing clears them on a `401` or a `session_secret` rotation | rotation ends sessions, not the copies on devices: a lost device still holds the notes it synced. Clear the site's data on the device |
| The nightly iCloud mirror (`deploy/icloud_backup.py`) copies the database snapshots and the data directory to iCloud Drive ([deploy/README.md](../deploy/README.md#off-machine-copy-icloud-drive)). It removes `session_secret` from the mirrored `config.json` and never writes it to a temp file under the destination; a `config.json` that does not parse is left out and the run exits 1 | Whoever can read that iCloud folder can still read the notes, and `config.json` keeps the password's scrypt hash, so offline guessing of the password remains possible from the mirror. Copies made before this change still hold the old `session_secret`, so it can still mint a session until the secret is rotated and those copies are removed. `restore` writes a new secret into the restored config, so every device logs in again |
| A Bluesky post URL in a note embeds on render, with no click (`BlueskyEmbed` gates it only inside an assistant reply) | any view that renders the block (its page, a backlink, an unlinked reference, a query result, a transclusion) sends a handle lookup to Bluesky, whose servers resolve the handle's domain, and loads the embed from Bluesky. Whoever wrote the URL chose that domain, so any write that reaches the notes (an assistant write the user approved, an external `pkm-mcp` client's, an import) can carry note text, encoded into the handle's labels, to a domain an attacker controls |
| No CSP, `frame-ancestors` or other anti-framing headers | `SameSite=Lax`, the origin guard, React escaping and the narrow boundary limit the risk; these would limit a future browser-side mistake |
| The direct Tailscale-IP listener is plain HTTP | Tailscale encrypts the hop, but login sends the password over it. Browsers should use the Serve HTTPS URL; never expose the listener on an untrusted network |
| An authenticated request body has no read deadline | a client with a session can hold a connection open by sending its body slowly. An upload over a slow link needs the time |
| `apply_batch` runs on the event loop and holds the write lock until it commits | a large authenticated batch stalls every request, login and WebSockets included, while it applies; one near `PRIVATE_BODY_MAX_BYTES` takes tens of seconds. `post_ops` also takes the write lock on the event loop, so while a threadpool route (a rename, a page delete) holds it, the loop waits up to `BUSY_TIMEOUT_MS` before answering `503` |
| A move or delete of a large subtree rewrites or hashes every descendant, and no batch budget charges it | a small batch of such moves or deletes holds the write lock, and with it the server, for as long as that takes, and can repeat it with each batch. The stale-title load (`stale_titles`) is uncharged too: it is linear in the pages deleted since the batch's `seen_seq`, which the client sends |
| The assistant's harness and its `pkm-mcp` inherit the server's whole environment | any credential the service gets as an environment variable (`OPENAI_API_KEY`, `GOODLINKS_API_KEY`, `ZAI_API_KEY`) reaches them. No tool reads those, but both read routing variables. The harness honours `ANTHROPIC_BASE_URL` and proxy settings, which would send the conversation and the Claude login's credentials elsewhere. `pkm-mcp` reads `PKM_URL` over its config file's URL, which would send the conversation's session token elsewhere. The launchd job sets neither today |
| GoodLinks' local API listens on every interface (`*:9428`), not loopback only; this is GoodLinks' behaviour, outside PKM's control | anything that reaches the host on that port can call the API over plain HTTP, guarded only by its bearer token. PKM reaches it at `goodlinks_api_url`, loopback by default. Keep the host off untrusted networks or block the port at the host firewall |
| The dependency advisories the 2026-10-23 review listed are not yet upgraded | the Python and dompurify advisories were judged unreachable. mermaid's own (prototype pollution, CSS injection, diagram DoS) apply to diagram text in notes, which the stock-mermaid fallback renders on view; the upgrade closes them ([review](security-review-2026-10-23.md#dependency-advisories)) |

## Hardening priorities

If the threat model expands, make changes in this order:

1. Add a temporary lockout on top of the per-source backoff.
2. Add logout, shorten the session lifetime (`YEAR_MS` as well as
   `COOKIE_MAX_AGE`), write down a session-secret rotation procedure, and
   clear on-device data on logout.
3. Give the assistant's harness an explicit minimal environment, and
   upgrade the dependencies with open advisories.
4. Add CSP, anti-framing and related response headers. The referrer policy
   must not be `no-referrer` (see [Authentication](#authentication)).
5. Review password-hashing parameters against current guidance.

Application hardening is not a substitute for Tailscale or another
authenticated, encrypted network boundary.
