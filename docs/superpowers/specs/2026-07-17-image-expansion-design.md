# Uploaded Image Expansion — Design (pkm-aze9)

Date: 2026-07-17
Bean: pkm-aze9

## Problem

Uploaded images render inline at the available block width, but there is no way to inspect them at viewport scale. PDF assets already provide a fullscreen reading mode. Uploaded images need an equally direct, accessible expansion interaction without changing external-image behavior or adding a heavyweight gallery viewer.

## Decisions

- Clicking an uploaded image opens a fullscreen modal overlay.
- An uploaded image is identified by a `src` beginning with `/assets/`.
- External images remain non-expandable.
- The expanded image is centered and fit within the available viewport using `object-fit: contain`; it preserves its aspect ratio and is never cropped.
- The modal closes through a visible Close button, Escape, or a click on the backdrop outside the image and header.
- Zoom, pan, captions, downloads, and navigation between images are out of scope.

## Alternatives considered

### 1. Dedicated image overlay matching the PDF behavior — selected

Extend `AssetImage` with a focused overlay implementation that follows the PDF viewer's established modal conventions. This keeps the change local and avoids risking regressions in the already-hardened PDF viewer. The small amount of duplicated modal wiring is preferable to broadening the feature into a media-viewer refactor.

### 2. Shared fullscreen-media modal

Extract the PDF viewer's modal behavior and place both PDF and image expansion on shared infrastructure. This would reduce duplication, but it substantially increases scope and puts existing PDF focus, scrolling, and rendering behavior at risk for no user-visible benefit in this feature.

### 3. Native `<dialog>`

A native dialog would reduce custom focus-management code, but would differ from the existing PDF overlay and introduce browser and jsdom behavior differences. Consistency with the existing iPad-focused application is more valuable here.

## Architecture

`AssetImage` remains an Imperative Shell component because it owns React state and coordinates DOM effects. It gains an `expanded` state alongside its existing `failed` state.

For `/assets/` sources, the inline image is rendered inside a reset-style button. This gives click, Enter, and Space activation without custom keyboard handling. The trigger has an accessible label derived from the image alt text, falling back to "Expand image" when the alt text is empty. The image retains its original `alt` attribute.

Activating the trigger stops the click from reaching the editable block and sets `expanded`. The modal is rendered with `createPortal(..., document.body)` so block layout and overflow cannot constrain it. Because React portal events still bubble through the React tree, the overlay also stops click propagation to prevent entering block-edit mode.

External images use the current plain `<img>` rendering and cannot open the modal.

## Modal behavior

The overlay is a fixed, viewport-filling element with a dimmed backdrop and `role="dialog"`, `aria-modal="true"`, and an accessible label based on the image alt text. It contains:

- a compact header with a Close button;
- a centered image stage consuming the remaining viewport and serving as the clickable backdrop;
- a second rendering of the same image, constrained by the stage with `max-width: 100%`, `max-height: 100%`, and `object-fit: contain`.

On open, focus moves to Close and document body scrolling is locked. Tab and Shift+Tab remain inside the dialog; with the initial single control, both cycle to Close. Closing restores the body's prior overflow value and returns focus to the inline image trigger. Escape closes from anywhere while the modal is open.

A click on empty space in the image stage closes only when the stage itself is the event target. Clicking the header or expanded image does not close the viewer.

## State and error handling

The existing failed-image state remains the single error state for both inline and expanded copies. If either image emits an error, expansion closes and the existing labelled "image unavailable offline" placeholder replaces the inline image.

When `src` changes, the component clears the failed state and closes any active overlay. This prevents an overlay for the old source surviving a reconnect or rerender and gives the new source a fresh load attempt.

Unmounting while expanded runs the modal effect cleanup, restoring body scrolling. The focus restoration is conditional so removing the trigger during unmount is harmless.

## Styling

New styles are limited to image expansion:

- a button reset that preserves the image's current block layout, margins, radius, and responsive inline sizing;
- a fixed overlay above application content with a translucent dark backdrop;
- a header aligned to the top edge;
- a flex-centered stage filling the remaining viewport;
- expanded-image constraints that preserve aspect ratio without cropping.

The existing `.asset-image` styling remains the source of inline image appearance. External and uploaded images therefore remain visually identical until an uploaded image is focused or activated. The uploaded-image trigger receives a visible keyboard focus treatment using existing design tokens.

## FCIS

No new Functional Core is required. The asset-source predicate is a deterministic one-line rendering decision, while all expansion behavior is React state, event, focus, and document coordination and therefore belongs in the existing Imperative Shell component. If modal behavior later gains a third consumer, extracting reusable modal infrastructure can be considered separately.

## Testing

### Unit tests (Vitest and Testing Library)

- `/assets/` images render as an accessible expansion trigger.
- Clicking and keyboard-activating the trigger opens the dialog.
- External images remain plain, non-expandable images.
- Trigger and overlay clicks do not propagate to an ancestor block click handler.
- Close, Escape, and backdrop click close the dialog; clicks on dialog content do not.
- The dialog has modal semantics and an accessible label.
- Focus moves to Close, is contained in the dialog, and returns to the trigger.
- Body scrolling is locked while open and its prior value is restored on close and unmount.
- Expanded-image load failure closes the overlay and shows the existing placeholder.
- A source change clears failure and closes expansion.

### End-to-end test (Playwright)

Upload a real image, embed it in a block, click the rendered image, and verify that the fullscreen dialog and contained image are visible. Verify Escape and backdrop closing and confirm the viewport-fit image does not exceed its stage bounds.

### Verification

Run the repository-required web verification command from the worktree:

```bash
cd web && pnpm verify
```
