---
# pkm-v93i
title: Edit fenced code blocks in a monospace font
status: todo
type: feature
created_at: 2026-10-26T14:19:32Z
updated_at: 2026-10-26T14:19:32Z
---

When a block holding a fenced code block (``` ... ```) is opened for editing, the
textarea shows its source in the body font. The rendered `.code-block` uses a
monospace font, so column alignment typed in the editor (ASCII tables, aligned
comments, diagrams) does not match what renders once the block is blurred.

## Desired behaviour

While editing, the whole textarea (fence lines included) uses the same
monospace font and size as the rendered `.code-block`, so a character column
in the editor is the same column in the output. This applies when the block's
text is entirely one of:

- a fenced code block (``` ... ```, with or without a language tag), except
  ```mermaid, which keeps the body font;
- a display-math block (`$$ ... $$`, the whole-block case `tokenizeBlock`
  renders as display math).

A block that mixes ordinary text with a fence stays in the body font.

## Notes from a first look

- Rendered style: `.code-block` / `.code-block code` in `web/src/styles.css`
  (ui-monospace stack, 13px, `white-space: pre-wrap`).
- Editor: `BlockInput.tsx` renders `<textarea className={`block-input${headingClass}`}>`;
  headings already add a class from the block text, so a code-fence class can
  follow the same route.
- The fence detection should reuse the grammar's own idea of a fenced block
  (`web/src/grammar/`) rather than a second regex, so editor and renderer agree.
- The monospace stack is repeated in several rules; a design token for it may be
  worth adding (styling.md would then need the token).

## Checklist

- [ ] Unit tests: a whole-block code fence and a whole-block `$$` math block get
  the code class; a mermaid fence, a mixed prose-and-fence block and a plain
  block do not
- [ ] Textarea uses the code-block font family and size while editing a fence
- [ ] E2E or real-keypress check that typed alignment matches the rendered output
- [ ] styling.md updated if a token or editor class is added
