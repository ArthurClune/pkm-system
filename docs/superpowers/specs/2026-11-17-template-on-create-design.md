# Page templates on create and link-follow

Bean: pkm-xmb1. Extends the page-templates design
(`docs/superpowers/specs/2026-11-15-page-templates-design.md`).

## Intent

A Paper/ page made from search's "Create page" stayed empty until "Click to
start writing…" was clicked. Arthur created one, left it empty, dragged his
notes onto it, and got no attributes. The template should already be in
place when a new Paper/ or Book/ page is first opened, so no workflow lands
content on it without the template first.

## Goals

- Creating a page from search's "Create page" adds the template on arrival.
- Following a `[[link]]` or `#tag` (click, or Ctrl-O in the editor) to an
  empty page that has a template adds the template on arrival. Shift-click
  and Ctrl-Shift-O, which open the page in the sidebar, do the same.
- On arrival the caret sits at the end of the first block (`Tags:: #Paper `),
  as after the click, and one undo removes the template.
- "Click to start writing…" stays as the fallback.

## Non-goals

- A rule for drops or pastes onto an empty page: once every way of
  creating a templated page seeds it, no such page is empty when a drop
  arrives. A paste has no target on an empty page anyway.
- Seeding a page retitled into `Paper/` or `Book/`.
- CLI and MCP writes (unchanged from the first design).

## Anti-goals

- Opening a page by any other route (sidebar list, history, back/forward,
  a bookmark, a reload) never writes. Only the explicit create or
  link-follow action does, once.
- Never adding a template to a page that already has blocks.

## Approaches

| Approach | Verdict |
|---|---|
| The create or link-follow navigation carries a one-time marker; the page, on loading empty, seeds through the same `createFirstBlock` the click uses, then consumes the marker | **Chosen.** One seeding path, so caret placement and one-step undo come for free; an already-filled page is a no-op there. |
| Search's create row writes the template's create ops itself after `POST /api/pages` | Rejected: a second seeding path outside the editor, no caret, not undoable. |
| Seed when blocks are dropped onto an empty templated page | Dropped by Arthur: unneeded once creation seeds. |

## Decided

- The triggers: search create, a rendered page link or tag clicked or
  shift-clicked, Ctrl-O and Ctrl-Shift-O.
- The marker is consumed when used, so a reload of the same history entry
  does not seed again. A page whose title has no template ignores it.
- Two devices following the same link at the same moment can both seed;
  accepted, since one undo fixes it.

## Left to the builder

- How the marker travels: router navigation state for the main view, an
  option on `openInSidebar` for the sidebar, or one mechanism for both.
- Where the "on load, empty, marked → `createFirstBlock`" step lives
  (`EditablePage` serves both hosts).
- Tests: unit tests for marker consumption and the no-op on a filled page,
  and one Playwright spec each for search create and link-follow.
- `docs/architecture/frontend-editor.md` § Page templates: replace "a
  template is seeded only on that click" with the new rule and its reason.
