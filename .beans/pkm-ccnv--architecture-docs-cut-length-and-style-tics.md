---
# pkm-ccnv
title: 'Architecture docs: cut length and style tics'
status: completed
type: task
created_at: 2026-11-11T15:46:51Z
updated_at: 2026-11-11T15:46:51Z
---

Audit of docs/architecture/ for length and style (not drift). Cut proofs that tests and docstrings already hold, cross-doc duplicates, lists the code holds, and the tics: negation-first reveals, significance designation, abstraction agency, deferred nouns, thesis-shaped headers, straw-man knockdowns, aphoristic closers, fragment cadence, dressed metaphors. Split backend.md along its request-boundary and titles/refs seams.

- [x] In-place cuts and tic fixes: backend, overview, checks
- [x] In-place cuts and tic fixes: write-path, sync-and-offline, sync-recovery
- [x] In-place cuts and tic fixes: frontend, frontend-editor, frontend-rendering, styling
- [x] In-place cuts and tic fixes: assistant, files-and-assets, cli-and-mcp, import-export-and-backup
- [x] Split backend.md; retarget inbound citations
- [x] check-docs clean; whole-branch review

## Summary of Changes

`docs/architecture/` went from 45,541 to 41,891 words. Excluding the two new
docs, the existing files lost about 7,000 words.

- **Split:** `backend.md` (7,774 → 3,772) is now three docs: `backend.md`, `request-boundary.md` (Auth, Login throttle, Hostile input) and `titles-and-refs.md` (Ref grammar, the title sections). Citations were retargeted in `docs/SECURITY.md`, `docs/cli.md`, `deploy/README.md`, the architecture docs and the `server/src/pkm/server/` comments. Frozen plans keep the old anchors.
- **Cut from every doc:**
  - proofs that tests and docstrings already hold, such as the replay-budget and page-delete walks in write-path, the race rows in assistant, and the case walks in sync-recovery
  - duplicates of rules owned by another doc
  - lists the code holds: the fixture rows, the `Config` keys, the suite boilerplate, the `isPathUnder` encodings, the module-map rows
  - the tics: negation-first reveals, aphoristic closers, fragment cadence, coy headers, deferred nouns
- **Headings:**
  - renamed: "Two control families", "Which way the editor's dependencies point", "Why a proxy", "Two barriers for third-party HTML", "Errors a person sees", "The model in one paragraph", "One grammar, two languages, pinned by fixtures"
  - dissolved: "Ancillary details", "Recovery never erases intent", "Lazy loading", "Shared write workflows"
- **Corrected:**
  - the web `Sha256Hex` mint site (`MINT_SITES`, not `tokenize.ts`)
  - the importer stage order (now code order)
  - which banner offers Reload (`replica-unusable`)
- **Moved into code comments:**
  - the `DEFAULT_MAX_CHARS` token-cap note in `mcp/tools.py`
  - the throttle-key headers in `auth.py`
  - the login wait bound in `throttle.py`

Cuts ran below the audit's estimates. Many rule tables are the spec that the property models (`server/tests/props`, `web/src/props`) are written from, so those rules stay.
