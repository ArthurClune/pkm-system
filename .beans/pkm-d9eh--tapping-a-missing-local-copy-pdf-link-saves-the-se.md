---
# pkm-d9eh
title: Tapping a missing local-copy PDF link saves the server's JSON error as .pdf.json
status: completed
type: bug
priority: normal
created_at: 2026-10-13T20:36:49Z
updated_at: 2026-10-13T20:48:44Z
---

Tapping the filename link of a Local copy:: PDF whose file the host can't serve (404 missing, 503 evicted/unreadable) makes the browser download the JSON error body as <name>.pdf.json, because PdfFallbackLink is an <a download>. Opening the URL in a tab likewise shows raw JSON. The in-app viewer reports a 404 as 'Couldn't render this PDF.'

Design (approved by Arthur 2026-10-13):
- In the app: for /api/local/ hrefs, tapping the filename link probes the file first; if missing or unservable, show an inline note instead of downloading. The viewer gets the same not-found wording.
- Server: a browser navigation to /api/local/... that can't be served gets a short HTML error page with the same status; app requests keep JSON.

## Todo
- [x] Server: HTML error page for navigations on /api/local/{path} (404 + 503s), JSON otherwise
- [x] Web: probe before download on local-copy filename link, inline note on failure
- [x] Web: viewer failureNote says not found for 404
- [x] Docs: backend.md Local documents, troubleshooting row; openapi regen if needed
- [x] Verify: pytest, pyrefly, ruff, pnpm verify

## Summary of Changes

- Web: tapping a /api/local/ PDF link (PdfEmbed deferred state) probes with a one-byte Range GET; a failure shows an inline note (pdfViewerCore.hostFailureNote: 404 missing, 503 host can't serve, network, other) instead of the browser saving the JSON body; success starts the native download via a temporary anchor. The viewer's 404 now says missing, not 'Couldn't render'.
- Server: GET /api/local/{path} failures are an HTML page (same status, Retry-After, no-store, escaped path) for browser navigations (Sec-Fetch-Mode/Dest, else Accept text/html); fetch/pdf.js callers keep the JSON bodies.
- Checked on the iPad simulator (iOS 26.5): missing-link tap shows the note; a present PDF opens in-tab exactly as main's plain download link does; direct navigation shows the HTML page with the path escaped.
- Docs: backend.md, frontend-rendering.md, troubleshooting row.
