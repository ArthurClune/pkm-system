---
# pkm-e95y
title: Update SECURITY.md after the review fixes land
status: in-progress
type: task
priority: normal
created_at: 2026-10-23T10:56:27Z
updated_at: 2026-10-27T10:56:52Z
parent: pkm-mfd0
blocked_by:
    - pkm-tk9i
    - pkm-u1jk
    - pkm-1zdg
    - pkm-i9pg
    - pkm-d8vp
    - pkm-ak4e
    - pkm-0ve4
    - pkm-6fqw
    - pkm-h1em
    - pkm-oirq
    - pkm-t74a
    - pkm-3k4m
    - pkm-0d4e
    - pkm-0ln3
    - pkm-ank8
    - pkm-ec46
    - pkm-lbj1
    - pkm-xrvv
    - pkm-bppf
    - pkm-zav2
---

SECURITY.md is the high-level model; update it once the fixes we take on have shipped (scrap or finish the blockers first), describing the system as it then is. Facts from the review that it currently gets wrong or omits, whatever the fixes:

- [x] Last-reviewed date and a link to docs/security-review-2026-10-23.md
- [x] Cookie site is the whole tailnet (ts.net is a public suffix); what Origin checking now covers
- [x] Login throttle keying (request.client.host via proxy headers) replaces 'every tailnet client shares the proxy's bucket'
- [x] Local files: only allowlisted raster images and PDFs inline; HTML/SVG download with nosniff
- [x] Image descriptions send the complete original image, metadata included
- [x] upload_asset reach: pkm-d8vp withholds it from the assistant (pkm-mcp keeps it; it runs as the user). The prompt-injection bullet should say the assistant gets only the READ_TOOLS/WRITE_TOOLS subset, with --strict-mcp-config
- [x] Write gating: what the card guarantees to show (pkm-g2w9; read docs/architecture/assistant.md's approval-card section as shipped). Guaranteed: card built server-side from the arguments the tool receives; every target and content value whole (content refused past CONTENT_LIMIT_CHARS); for each update/move/delete target its current page and text excerpt with full length, read just before the card, plus a delete's descendant count; a batch delete of a subtree an earlier move fills is refused; reused/premature aliases refused; Allow arms after a delay with both ends in view; the browser renders only allow-listed keys per action, values quoted, LTR-isolated, controls escaped; a card stamped writes_in_flight shows a staleness marker. Not guaranteed: the card is a snapshot (text can change before Allow; Allow doesn't guard an edit made while the card is open, pkm-6fcv; a stopped turn's in-flight write, pkm-qotb)
- [x] On-device replica/outbox/cached uploads outlive session-secret rotation
- [x] Diagnostics body bound
- [x] Origin guard (pkm-u1jk): § Authentication 'There is no CORS…' paragraph — CSRF protection is SameSite=Lax plus the origin guard (/api/ws and every non-GET/HEAD/OPTIONS request carrying an Origin must name one of PKM's own origins: serve_origins, the bind_hosts listeners, loopback on the served port; Origin: null refused); requests with no Origin are non-browser clients and still need the cookie. Known limitations: drop 'No Origin checks on writes or WebSocket upgrades'. Hardening priorities: item 4 done; item 5 must exclude Referrer-Policy: no-referrer (it makes no-cors POSTs — the Files export form, and the assistant close beacon in WebKit — send Origin: null, which the guard refuses). Safe methods stay unchecked: GET /api/journal creates today's page, GET /api/local/... can trigger an iCloud download
- [x] Known limitations / hardening priority 2: the anonymous route-walk test now exists (pkm-t74a)

- [ ] Delete docs/superpowers/handoffs/security-review-2026-10-23-probes once the last fix bean has turned its probe into a red test (pkm-t74a handed this on)

- [x] Write-time limits (pkm-gc3n, pkm-bppf): block text ≤ 1,000,000 code points and [[ nesting ≤ 32, refused on every write path (ops, replica/op-queue backstops, server-made rewrites judged per axis, stale-edit replay lands a conflict entry, importer); the web grammar is linear and never throws at the cap. Open follow-ups: request size (pkm-0l8g), delete inline copies (pkm-49rh), conflict headers / title length (pkm-iruc).

- [x] Login backoff row (pkm-lamg, pkm-v3t1) — replace with: | Login backoff is per source (`LoginThrottle`, `throttle_core.py`: `BASE_BACKOFF_MS` doubling to `MAX_BACKOFF_MS`), one password check in flight per source, with no lockout | The source is the device's tailnet address: on the loopback listener the `X-Forwarded-For` Tailscale Serve sets (trusted from `127.0.0.1` only, `run.FORWARDED_ALLOW_IPS`), on the Tailscale-IP listener the TCP peer. Each device has its own bucket, so a guessing device does not put the others in backoff; a local process can choose its key. Concurrent guesses from one source wait their turn, so a burst costs one scrypt check per backoff window. Every refusal is the same 401. Scrypt makes each guess expensive, but a weak password is open to patient guessing; use a strong one |

- [x] Auth before body (pkm-zav2): in § Authentication replace the paragraph beginning 'Every /api and /assets route but /api/login requires a session' with: Every /api and /assets route except POST /api/login requires a session, including /api/openapi.json; FastAPI's documentation routes are disabled. AuthGateMiddleware refuses an anonymous request before the app reads its body (uvicorn still reads and discards the rest of a refused body): any /api or /assets request other than POST /api/login, any method other than GET or HEAD, and every WebSocket handshake — HTTP gets 401, /api/ws refuses the handshake. The public routes are GET /login, POST /api/login, GET /healthz (returns only {"ok": true}) and the SPA shell with its static files. A public request body larger than PUBLIC_BODY_MAX_BYTES (8 KiB) is refused with 413, with or without a session (mechanism: architecture/backend.md#auth).


- [x] Server batch (merged 53c06d4a, 2026-10-26), described as shipped — read docs/architecture/backend.md § Auth, § The write lock, § Planning, § Conflicts and § Refused titles against the code: authenticated bodies capped at PRIVATE_BODY_MAX_BYTES (64 MiB; uploads at max_upload_bytes plus a multipart envelope), counted when chunked; head deadline, public body 408 deadline and a stalled-write cut (~1 KiB/s floor) — authenticated slow bodies stay unbounded (known limitation); /api/ops judges off the lock and the event loop, apply still on both (pkm-8w77); per-batch replay work budget (MAX_BATCH_REPLAY_WORK) with over_limit landings, rewrite rows read per (uid, base_hash) and charged; page-delete copy budget; page titles ≤ 1,000 characters; server needs SQLite ≥ 3.43. Known limitation: subtree-sized moves/deletes are uncharged (pkm-hlom).

## Progress (2026-10-27)

SECURITY.md rewritten on `security/e95y-security-md` (5865190b), then three review rounds (f585f07e, 6dbcd9c6, e1ad7d2f): 24 findings, then 6, all fixed. Corrected against the code: the approval card's "not guaranteed" items (pkm-6fcv, pkm-qotb shipped, so they are guarantees); the write-limit follow-ups are all done; `PKM_URL` overriding the config file is today's behaviour, not the fix. Added from the review: Bluesky embeds on render in notes (Arthur accepted it as a known limitation), the iCloud mirror carrying config.json (fix filed as pkm-y8hl), GoodLinks save taking any URL, the reader's unchecked original link (pkm-6rto).

Closing pass, after the beans below ship:
- [ ] After pkm-oirq: rewrite the environment-inheritance, `PKM_URL` and dependency-advisories rows to match what shipped
- [ ] After pkm-y8hl and pkm-6rto: their SECURITY.md items (each bean carries its own)
