# Assistant cites assets as clickable links in the first pass

**Date:** 2026-07-28
**Status:** Approved

## Problem

Ask the assistant "tell me about graphs related to environmental impact" and it
answers with entries like:

> 5. Llama 3 training cost chart — under "Training costs for Llama 3", showing
> energy/carbon figures for training the model. (IMG_0709.png)

The filename is inert text. Only when the user follows up with "can you link
the llama 3 chart?" does the model paste the full
`/assets/<sha256>/<filename>` URL, which the assistant panel (pkm-gdi5)
renders as a clickable `AssetLink` — click opens the referencing block,
shift-click opens it in the sidebar.

The data is already there: `render_assets`
(`server/src/pkm/cli/render.py:114`) includes the full URL for every
`search_assets` hit. The model drops it when summarizing because nothing
tells it the URL is load-bearing. This is a prompt problem, not a rendering
or data problem.

## Change

`server/src/pkm/assistant/policy.py`, `SYSTEM_PROMPT` only:

1. Add a citing rule to the Style guidance:
   - When mentioning an asset (image, PDF, etc.), always include its full
     `/assets/<sha256>/<filename>` URL exactly as returned by
     `search_assets` — the UI renders it as a clickable link; never cite by
     filename alone.
   - When pointing at a specific block, cite its uid as `((uid))` — also
     rendered clickable.
2. Fix the "ten PKM verbs" drift (the prompt lists eleven tools) by removing
   the count entirely: "Your only tools are the PKM verbs exposed over MCP".
   A count-free sentence can't drift again.

No server API, renderer, or web changes.

## Testing

- Extend the prompt test in `server/tests/test_assistant_policy.py` to assert
  the citing guidance survives: prompt mentions `/assets/` and `((`. This
  keeps the guidance from being silently dropped in a future prompt edit.
- Standard gates: `cd server && uv run pytest -q`, `uv run pyrefly check`,
  `uv run ruff check`.

## Verification

Prompt changes can't be meaningfully verified by unit tests alone. Live smoke
against the running assistant: ask an "asset listing" style question (e.g.
graphs about environmental impact) and confirm the first-pass answer carries
clickable asset links in the panel.

## Risk

None new. Worst case the model ignores the instruction, which is today's
behavior.

## Out of scope

- pkm-t5pu (search_assets returns page/block context) stays open and
  untouched; it is complementary server-side work and does not overlap.
