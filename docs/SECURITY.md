# Security model

PKM is a single-user, self-hosted application behind Tailscale, which is the
network security boundary. The application's own authentication protects
against casual attackers on a local network or other reachable devices. It
does not make the server safe to expose to the public Internet.

The last security review is recorded in
[security-review-2026-10-23.md](security-review-2026-10-23.md).

## Deployment assumptions

A production server listens only on `127.0.0.1`, the upstream for Tailscale
Serve, and, when direct tailnet API access is needed, the machine's literal
Tailscale IP. `bind_hosts` in `config.json` defaults to loopback. Never
configure `0.0.0.0`, an ordinary LAN address or public port forwarding.
Tailscale Serve provides HTTPS; keep `cookie_secure` enabled in production.
`serve_origins` must name the Serve hostname's origin, or browsers on it can
read but cannot write or open the WebSocket
([allowed origins](architecture/backend.md#auth)).

Start the server through `python -m pkm.server.run`, as the launchd job
does. Only that entry point installs the slow-client deadlines and pins
the proxy-header trust the login throttle keys on
([mechanism](architecture/backend.md#auth)).

Anyone who can read the data directory can read the database and assets.
Other local operating-system users are outside the network threat model.
`pkm.server.setup` writes `config.json` with mode `0600`; keep the data
directory, backups and `local_docs_root` private to the service account.
The nightly iCloud mirror copies the notes and assets off the host and leaves
out the session-signing secret, so protect the backup location like the notes
([deploy/README.md](../deploy/README.md#off-machine-copy-icloud-drive)).
Keep API keys in their key files (`openai_api_key_file`, `zai_api_key_file`,
`goodlinks_api_key_file`) rather than the service environment, which any
process of the service account can read (`ps -E`). The assistant's harness
and `pkm-mcp` start with an allow-listed environment instead of the
service's (see [Embedded assistant](#embedded-assistant)).

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
including `/api/openapi.json`, and every WebSocket handshake does too.
FastAPI's documentation routes are disabled. The public routes are the
login form and its `POST`, a liveness check, and the SPA shell with its
static files. An anonymous request to any other route is refused before the
app reads its body ([gate](architecture/backend.md#auth)).

CSRF protection is `SameSite=Lax` plus `OriginGuardMiddleware`, which
refuses a write or a WebSocket handshake whose `Origin` is not one of PKM's
own ([allowed origins](architecture/backend.md#auth)). A request with no
`Origin` comes from a non-browser client (the CLI, `pkm-mcp`, Shortcuts),
and still needs the cookie. There is no CORS, so a sibling page cannot read
a response. Safe methods are not checked, and some have side effects a
sibling page could trigger blind: `GET /api/journal` and a `GET /api/page/`
of today's title create today's daily page, `GET /api/local/...` can start
an iCloud download of an evicted file, and `GET /api/goodlinks/{link_id}`
can make GoodLinks fetch an uncached page.

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

In the browser, every link the app renders, from markdown or from GoodLinks'
answer (the reader's "original" link), rejects `javascript:` and
protocol-relative URLs (`isSafeHref`); an unsafe URL shows as plain text.

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
| Block text: at most `MAX_BLOCK_TEXT_CHARS` code points and `MAX_LINK_NESTING` levels of `[[` | on every write path: ops, server-made rewrites and the importer. A stale edit whose replay would pass a limit lands as a conflict entry instead. Server-made text passes a limit only by an unlink's fence backticks, or by copying a row stored past it before the limits existed | [write-path.md § Work bounds under the write lock](architecture/write-path.md#work-bounds-under-the-write-lock) |
| Page titles: at most `MAX_PAGE_TITLE_CHARS`, measured on the title's fold | for a new title, at creation, rename, move, sidebar pin and import; a page stored before the cap keeps its title | [backend.md § Refused titles](architecture/backend.md#refused-titles) |
| Server history one batch replays: `MAX_BATCH_REPLAY_WORK`; a page delete's inlined copies: `MAX_DELETE_COPY_CHARS` | under the write lock; an edit past the budget lands as a conflict entry (the block keeps its text), a delete past it is refused | [write-path.md § Work bounds under the write lock](architecture/write-path.md#work-bounds-under-the-write-lock) |
| No malformed or hostile input makes a route answer `500` | every route; a lock-taking route answers `503` when the lock stays busy. An asset upload commits outside `write_txn` and has no busy branch, so it answers `500` when a threadpool route's write (a rename, a page delete, the title migration) holds the lock past `BUSY_TIMEOUT_MS`. A batch cannot be that holder, because `post_ops` holds the lock without yielding the event loop the upload runs on ([write-path.md § The write lock](architecture/write-path.md#the-write-lock)) | [backend.md § Hostile input](architecture/backend.md#hostile-input) |

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
- **Subprocess environment.** Neither subprocess inherits the service's
  environment, so a proxy setting, `ANTHROPIC_BASE_URL` or another
  service's API key in it reaches neither. The harness CLI starts through a
  per-conversation launcher that `execve`s it with only the names
  `harness_env_names` lists (`harness_env.py`: the host names the Claude
  login needs, the variables the SDK sets, and the model's own, such as the
  z.ai route for `glm`). No secret appears in any process's arguments.
  `pkm-mcp` runs under `env -i` with only `PKM_CLI_CONFIG`, and ignores
  `PKM_URL` while that is set (`load_mcp_config`), so the session token
  goes only to the URL in its config file.
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
| Login backoff is per source, one password check in flight per source, with no lockout ([mechanism](architecture/backend.md#login-throttle)) | The source is the device's tailnet address, so each device has its own bucket and a guessing device does not put the others in backoff. A local process can choose its key; the throttle does not defend against a process that can read `config.json`. Scrypt makes each guess expensive, but a weak password is open to patient guessing; use a strong one |
| No logout and no per-session revocation | a copied cookie works until it expires or `session_secret` is rotated, which ends every session |
| Each device keeps the full replica, its unsent outbox and recently viewed uploads (the service worker's `pkm-assets` cache, served without an auth check); nothing clears them on a `401` or a `session_secret` rotation | rotation ends sessions, not the copies on devices: a lost device still holds the notes it synced. Clear the site's data on the device |
| A Bluesky post URL in a note embeds on render, with no click (`BlueskyEmbed` gates it only inside an assistant reply) | any view that renders the block (its page, a backlink, an unlinked reference, a query result, a transclusion) sends a handle lookup to Bluesky, whose servers resolve the handle's domain, and loads the embed from Bluesky. Whoever wrote the URL chose that domain, so any write that reaches the notes (an assistant write the user approved, an external `pkm-mcp` client's, an import) can carry note text, encoded into the handle's labels, to a domain an attacker controls |
| The sync snapshot and changes bodies are gzipped when the client accepts it (`http_encoding.py`), and a compressed length shows how well a body's parts compress together | Neither body carries a credential, so the secret at risk is note text. The only request text echoed is a `pending` id that equals a stored batch id (`_applied_batches`), and storing one takes a session, so an attacker's guesses must be written into the notes (an assistant write the user approved, an external `pkm-mcp` client's, an import) to share a response with it. The attacker must also make the device fetch that response, which a sibling tailnet page can do blind, choosing the changes window with `since` and `limit`. And they must learn its compressed size, from the device's encrypted traffic to the host or from that fetch's timing. No setting turns the compression off |
| No CSP, `frame-ancestors` or other anti-framing headers | `SameSite=Lax`, the origin guard, React escaping and the narrow boundary limit the risk; these would limit a future browser-side mistake |
| The direct Tailscale-IP listener is plain HTTP | Tailscale encrypts the hop, but login sends the password over it. Browsers should use the Serve HTTPS URL; never expose the listener on an untrusted network |
| An authenticated request body has no read deadline | a client with a session can hold a connection open by sending its body slowly. An upload over a slow link needs the time |
| `apply_batch` holds the write lock on the event loop until it commits ([bounds](architecture/write-path.md#work-bounds-under-the-write-lock)) | a large authenticated batch stalls every request, login and WebSockets included, while it applies; one near `PRIVATE_BODY_MAX_BYTES` takes tens of seconds. `post_ops` also takes the write lock on the event loop, so while a threadpool route (a rename, a page delete) holds it, the loop waits up to `BUSY_TIMEOUT_MS` before answering `503` |
| A move or delete of a large subtree, and the stale-title load, are charged to no batch budget ([charges](architecture/write-path.md#work-bounds-under-the-write-lock)) | a small batch of such moves or deletes holds the write lock, and with it the server, for as long as that takes, and can repeat it with each batch. A batch that sends an old `seen_seq` makes the stale-title load read every page deleted since |
| GoodLinks' local API listens on every interface (`*:9428`), not loopback only; this is GoodLinks' behaviour, outside PKM's control | anything that reaches the host on that port can call the API over plain HTTP, guarded only by its bearer token. PKM reaches it at `goodlinks_api_url`, loopback by default. Keep the host off untrusted networks or block the port at the host firewall |
| The dev and build tools carry advisories: vitest 3's tinypool and mocker, and glob, minimatch and deepmerge inside the test-coverage and PWA build chains; their fixes need vitest 4 or a major of a pinned parent, and deepmerge has none | they touch building and testing, not the shipped bundle; `pnpm audit --prod` reports none. The [review](security-review-2026-10-23.md#dependency-advisories) covers the rest of the advisories |
| `mermaidSafety.ts` restates mermaid internals (its secure keys, entity handling, CSS paths) | a mermaid upgrade can change what those rules must cover. mermaid is pinned to a patch range (`~`) in `web/package.json` so a minor release arrives only through a deliberate upgrade that re-checks them |

## Hardening priorities

If the threat model expands, make changes in this order:

1. Add a temporary lockout on top of the per-source backoff.
2. Add logout, shorten the session lifetime (`YEAR_MS` as well as
   `COOKIE_MAX_AGE`), write down a session-secret rotation procedure, and
   clear on-device data on logout.
3. Add CSP, anti-framing and related response headers. The referrer policy
   must not be `no-referrer`
   ([why](architecture/backend.md#auth)).
4. Review password-hashing parameters against current guidance.

Application hardening is not a substitute for Tailscale or another
authenticated, encrypted network boundary.
