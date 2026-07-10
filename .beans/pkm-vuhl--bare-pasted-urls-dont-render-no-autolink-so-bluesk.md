---
# pkm-vuhl
title: 'Bare pasted URLs don''t render: no autolink, so Bluesky embeds never fire'
status: completed
type: bug
priority: normal
created_at: 2026-07-10T15:39:07Z
updated_at: 2026-07-10T15:44:18Z
---

pkm-5g4v wired Bluesky embeds to markdown link segments, but a pasted Bluesky URL is bare text — the tokenizer has no autolinking, so bare URLs render as dead plain text and the embed never triggers (seen on the Robots page). Fix: tokenize bare http(s) URLs as link segments (autolink), which routes them through the existing link rendering (Bluesky embed, PDF embed, safe anchor).

## Summary of Changes

Root cause: the tokenizer had no autolinking at all — a bare pasted URL stayed a plain text segment, so it rendered as dead text and never reached the link-segment path where Bluesky/PDF embeds are wired (pkm-5g4v only fired on markdown `[text](url)` links; the Robots page block is a bare URL).

Fix: `tokenizeInline` now recognizes bare `http(s)://` URLs at word boundaries as `link` segments (text = href), with trailing prose punctuation excluded, scheme-only strings rejected, and inline code / markdown links unaffected. Bare URLs everywhere become clickable, and Bluesky post URLs render as embeds via the existing link path.

Also set Playwright `workers: 1`: all e2e specs share one e2e_serve.py server/DB and edit the same journal, so the new second spec file surfaced cross-worker interference.

Verified: 289 web unit tests, typecheck, and 4 e2e tests (incl. new embeds.spec.ts driving paste-bare-URL -> iframe through the built app) all pass; e2e run twice for stability.
