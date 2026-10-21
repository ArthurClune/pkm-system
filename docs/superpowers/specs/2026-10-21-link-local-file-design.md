# /link-local-file — design

## Why

Arthur's documents (papers, books, white papers) live in an iCloud folder
that the server already serves read-only at `/api/local/<path>`
(`Config.local_docs_root`, `routes_local.py`). Linking one from a note
means writing

    Local copy:: [<filename>](/api/local/<percent-encoded path>)

and today that is all manual:

- the app has no way to see what is in that folder, so finding the file
  means leaving for iCloud Files and poking around;
- on iPhone/iPad there is no practical way to get a percent-encoded path,
  so a raw path gets pasted and the assistant is asked to reformat it;
- the assistant has no access to the server's disk (and must not get
  any), so it cannot check that the link it wrote points at a real file.

Success: from any device, type `/link-local-file`, find the file by
browsing or by typing part of its name, pick it, and the block gets a
link that works because it was built from a file the server just listed.
No hand encoding, no assistant round trip.

## Goals

- A slash command `/link-local-file` that opens a picker over the
  local-docs folder and inserts a `Local copy::` link at the cursor.
- The picker does both browsing folders and fuzzy searching the whole
  tree, in one box (layout A below — Arthur chose it from three mockups).
- Works the same on desktop (keyboard) and iPhone/iPad (touch).
- The link it inserts is in exactly the form the rest of the app already
  understands (`InlineSegments` renders it, `PdfEmbed` embeds PDFs,
  `/api/local/check` and `pkm local` validate it).

## Non-goals

- Uploading, moving, renaming or deleting files. Read-only.
- Browsing anything outside `local_docs_root`.
- Giving the assistant, MCP or CLI a way to list the folder. The
  assistant stays off the server's disk.
- Previewing file contents in the picker.
- Linking a folder (files only).

## Anti-goals (would make it a failure even if it "works")

- A picker that can be steered outside `local_docs_root` (symlink,
  `..`, encoded tricks). The containment rule in `local_docs.py` is the
  only guard for this whole feature area and must not be loosened.
- An inserted href that differs from what `local_docs.local_href` would
  generate for the same path (double-encoding, unencoded parentheses —
  `_HREF_RE` relies on `(`/`)` being encoded).
- Unusable on a phone (two-pane layouts, hover-only affordances).

## Behaviour (agreed with Arthur)

**Opening.** Typing `/link-local-file` in a block and picking it from the
slash menu strips the trigger text and opens the picker over the editor,
recording the cursor offset where the `/` was — the same shape as
`/upload`, `/date` and `/goodlinks` in `BlockInput.pick`. The search box
is focused on open.

**Browsing (empty search box).**
- Shows one folder: subfolders first, then files, each sorted by name,
  case-insensitively. *(builder's call, stated to Arthur)*
- A breadcrumb (`pkm › Papers › Machine Learning`) at the top; each
  segment navigates up.
- Opens at the root every time. *(my call; remembering the last folder
  is a possible later tweak)*
- Hidden entries (names starting with `.`, e.g. `.DS_Store`) are never
  shown — except iCloud placeholders, below.

**Searching (anything typed).**
- Results come from the whole tree, as a flat list: file name, with its
  folder path underneath (`Papers › Machine Learning › LLMs`).
- Case-insensitive, always (Arthur).
- Genuinely fuzzy, fzf-style (Arthur: "fuzzy search for preference"):
  each whitespace-separated query word matches if its characters appear
  in order in the file's relative path, not necessarily next to each
  other, so `shrgeo` and `llm geom` both find
  `Papers/Machine Learning/LLMs/SHARED GEOMETRY AS A ROSETTA STONE.pdf`.
  Every word must match. Matched characters are highlighted.
- Matching and ranking come from the `fzf` npm package (fzf-for-js, a
  port of fzf's own algorithm), so the picker behaves like the fzf Arthur
  uses in the terminal (Arthur's choice). It uses `extendedMatch`, which
  gives the terminal's search syntax: space-separated terms all must
  match, `'exact`, `^prefix`, `suffix$`, `!exclude`. Casing is
  `case-insensitive` rather than fzf's default smart-case (Arthur). fzf's
  scores are not adjusted. Ties (common: two contiguous matches score
  the same) go first to the item whose matched characters all fall in
  the file name, then to the shorter path. *(my call)* The package
  must fit the bundle budgets (`pnpm verify` enforces them).
- Clearing the box returns to the folder that was being browsed.

**Picking.** Click/tap a file, or ↑/↓ then Enter. The block gets, at the
recorded offset:

    Local copy:: [SHARED GEOMETRY AS A ROSETTA STONE.pdf](/api/local/Papers/Machine%20Learning/LLMs/SHARED%20GEOMETRY%20AS%20A%20ROSETTA%20STONE.pdf)

Link text is the file name (with extension), exactly, whenever the
app's own link reader (`scanMarkdownLinkAt`) reads the inserted link
back with that label and that href. Only when it would not (unbalanced
`[`/`]`, or a name starting with `[`, which reads as a `[[page]]` link)
are the label's `[`/`]` replaced with `(`/`)`. The href always encodes
the real name, so the link opens the right file either way. No file in
the folder has a bracket today. The picker always shows and matches the
real name (Arthur: every file must be pickable). The splice is exactly
`/goodlinks`'s: at the recorded offset, whatever precedes it. Arthur
types the command in a fresh block, so text before the cursor turning
the attribute into a mis-named one is accepted, deliberately, as it is
for `/goodlinks` today — no special handling. Esc, or a click/tap outside,
closes the picker and leaves the block as it is (trigger already
stripped).

**Not-yet-downloaded files.** The folder is set to always download, but
if iCloud has left a placeholder (`.Name.ext.icloud`), the picker lists it
as `Name.ext` and links to the real path. The existing file route already
handles that case (503 + `brctl download`). Arthur confirmed: offer it.

**Failures.** The picker shows a short message in place of the list:
- `local_docs_root` not configured on this server → "Local files aren't
  set up on this server". *(My call, changing what I told Arthur: I had
  said the command would be hidden from the slash menu, but `/goodlinks`
  is always listed and reports unavailability as a notice, and the SPA
  has no per-server feature flags. Always list it; say why it can't work.)*
- offline / server unreachable → "Couldn't reach the server".
- root configured but unreadable (missing folder, a permission error, or
  a scan that blocks on macOS's iCloud privacy prompt — see
  `docs/troubleshooting.md`) → "Couldn't read the local files folder on
  the server". *(my call)* The listing scan runs under a time limit, the
  same idea as the `local_open` probe, so a blocked scan never ties up a
  worker thread for good. Timeout, permission error or missing root is a
  503 with `Retry-After`, like the file route's iCloud case.

## Constraints from the codebase

- **One encoder.** `local_docs.local_href` (`quote(rel, safe="/")`) is
  the single definition of the href. The listing should return each
  file's href computed by it, so the web side never percent-encodes
  paths itself. *(my call — removes a client/server parity risk)*
- **Containment.** Listing must apply the same rule as the file route:
  resolve the root, and skip any entry whose resolved path is not
  `is_within` it (symlinks out). An unconfigured root is a 404 like the
  file route, not a 403.
- **Route ordering.** `/api/local/{path:path}` is a catch-all; the
  existing `/api/local/check` is declared before it. A new listing route
  under `/api/local/` shadows a real top-level file of the same name, as
  `check` already does — pick a name that can't plausibly collide, or put
  it outside the prefix. Builder's call.
- **iCloud blocking.** `open()` on an iCloud path can hang
  (`local_open`). Listing uses only directory scans/`stat`, never
  `open`, and the whole scan sits under the time limit described in
  Failures above.
- **FCIS.** Name filtering, stub-name mapping, sorting and the fuzzy
  match/rank are Functional Core (server in `local_docs.py` or a sibling;
  web match/rank in an `outline/` or `components/` core file). The route
  and the React picker are shell.
- **Auth.** Behind `require_auth` like every other `/api/local` route.
- **OpenAPI.** New route ⇒ regenerate `web/src/api/openapi.json` per the
  generated-artifacts table in `docs/architecture/backend.md`.
- **Offline-first app.** The picker is online-only; it must not go
  through the replica/offline shim as if it were cached data.
- **Popover chrome.** Reuse the shared popover/overlay pieces
  (`useOverlayDismiss`, the shared popover chrome) and existing control
  classes rather than new styling. On a phone it should fill the width.
- **Size.** About 770 files in about 100 folders today. Returning the
  whole tree in one response and searching it on the client is fine at
  this size; the builder decides (whole-tree index vs. per-folder +
  server search) and records why.

## Left to the builder

- Route name and response shape (whole-tree index or per-folder).
- Whether the picker is a new component or generalises an existing one
  (the `/files` view, `DatePicker`'s inline popover).
- Exact keyboard handling beyond ↑/↓/Enter/Esc (e.g. → / Enter on a
  folder to open it, Backspace on an empty box to go up).
- How the splice is wired (`/goodlinks`'s `spliceUploadedMarkdown` path
  in `useOutline`, or the `/date` in-textarea path), as long as the
  result matches `/goodlinks`.

## Docs to update in the same branch

- `backend.md` API reference table (new route).
- `frontend.md` module map (picker component, any new core file).
- `docs/keyboard.md` if the slash command list is enumerated there.
- Grep for enumerations of slash commands that the new one makes stale.
