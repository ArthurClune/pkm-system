---
# pkm-xo6w
title: Normalize titles on client read paths (get/refs 404 on spellings save handles)
status: todo
type: bug
priority: normal
created_at: 2026-08-01T14:23:28Z
updated_at: 2026-08-01T14:23:28Z
parent: pkm-ulae
---

Follow-up from the pkm-ulae medium sweep (climcp-track final review, Minor 1).

## Context

pkm-5k8p fixed the write path: `PkmClient.get_page_blocks` normalizes control-whitespace titles via `pkm.refs.normalize_title` before lookup, so a second `pkm save` to such a page no longer duplicates heading parents. The read paths were left verbatim: `get_page` and `get_backlinks` (`server/src/pkm/client/api.py`) look up the caller's raw spelling, and the server's read side does not normalize for you (`routes_pages.py` `get_page` calls `fetch_page(db, title)` directly).

Result: after `pkm save -p "Ctrl\tTitle" ...` succeeds (stored under the normalized spelling per pkm-hjhy), `pkm get "Ctrl\tTitle"` and `pkm refs "Ctrl\tTitle"` 404 — "in search but 404s" for CLI/MCP callers reusing their own original spelling. Same asymmetry applies to the MCP get_page/backlinks tools.

Direction: normalize titles at the client read-path lookups the same way the write path does (`normalize_title` is the shared function — same object the server uses, zero drift risk). Consider whether the server's GET routes should also normalize at their choke point, consistent with the pkm-hjhy write-side invariant; if so, that's a route-behavior change (regen checklist applies).

Related follow-up noted by the same review (fold in if touching get_backlinks anyway): `pkm refs --json` synthesizes `limit=len(groups)` so `limit` no longer means request page size — harmless but slightly misleading; and `cmd_get --json` still embeds the single-page backlinks sub-object of get_page (explicit pagination, not silent truncation — cosmetic).

## Tasks

- [ ] Normalize titles in client read lookups (get_page, get_backlinks), with control-whitespace round-trip tests at client/CLI/MCP layers
- [ ] Decide and document whether server GET routes normalize at the choke point (regen checklist if they do)
- [ ] Tidy the synthesized limit field semantics if in the area
