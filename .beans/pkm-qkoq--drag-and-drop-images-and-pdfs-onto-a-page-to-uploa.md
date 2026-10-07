---
# pkm-qkoq
title: Drag and drop images and PDFs onto a page to upload them
status: completed
type: feature
priority: normal
created_at: 2026-10-07T19:20:00Z
updated_at: 2026-10-07T19:51:35Z
---

Dragging an image or PDF from outside the app (Finder, a browser) over an editable page shows the same drop indicator line as a block drag; releasing it uploads the file(s) like /upload and creates one new block per file at the indicator position.

Approved design (brainstorm 2026-10-07, bounded path, no spec):

- `DragSource` in `outline/dnd.ts` becomes a discriminated union: block drag | `{ kind: "files" }`. `dropRows` skips nothing for files; `resolveDrop` never returns the same-position null for files.
- Pure filter over `dataTransfer.items` `{kind,type}` (readable during dragover): uploadable = `image/*` or `application/pdf`.
- Zone `dragenter`/`dragover` with no block drag and an uploadable file -> `startDrag({kind:"files"})`; same throttled geometry draws `.drop-indicator`. External drags never fire `dragend`: clear on drop, window leave, Escape.
- Window-level guard in `DndProvider`: file drops outside a zone / on read-only pages are preventDefault'd so the browser never navigates to the file.
- Zone ignores file drags over the focused block's textarea (no indicator); that drop keeps today's splice-at-caret behaviour.
- `useOutline.onDropFiles(files, target)`: sequential `uploadAsset`, then one `run()` creating one block per successful upload at consecutive order_idx (single undo step). Failures and unsuitable files in a mixed drop are named in the existing upload-error banner (no silent skipping). Focus unchanged.
- If the target parent vanished during the upload: blocks go at the end of the page AND the first new block is scrolled into view (centred) without focusing it (focusing shows raw markdown instead of the rendered asset).

## Checklist

- [x] Core: DragSource union, dropRows/resolveDrop, uploadable filter, create-ops builder (vitest)
- [x] Shell: useDropZone file drags, Escape/window-leave cleanup, textarea exclusion (vitest)
- [x] DndProvider window guard against browser navigation
- [x] useOutline.onDropFiles incl. failure banner, parent-vanished fallback + scroll into view (vitest)
- [x] Playwright spec with synthetic DataTransfer (PNG + PDF)
- [x] docs/architecture/frontend-editor.md Drag and drop section
- [x] pnpm verify, perf/check.sh frontend, proptest/check.sh web
- [x] Manual check: real drag from Finder

## Summary of Changes

Files dragged in from outside the app (images and PDFs) draw the block-drag drop line and, on release, upload and become one new block each at that line, in one undo step. `DragSource` is now a union (`blocks` | `files`); `outline/fileDrop.ts` holds the pure filter, banner wording and create-ops plan; `DndProvider` ends a files drag by a document enter/leave depth count (WebKit nulls `relatedTarget`) and guards the window so a missed drop never navigates to the file. The focused textarea keeps splice-at-caret. A drop whose parent vanished during upload appends at the page end and scrolls the first block into view without focusing it.

Verified: pnpm verify (3671 unit, 75 Playwright incl. e2e/file-drop.spec.ts), proptest web 68/68, perf frontend unchanged, manual Finder drag in Safari and Chrome. Follow-up: undo of an upload leaves the asset orphaned (all upload paths) — separate bean.
