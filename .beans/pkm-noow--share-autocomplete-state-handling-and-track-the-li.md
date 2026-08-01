---
# pkm-noow
title: Share autocomplete state handling and track the live caret
status: todo
type: bug
created_at: 2026-08-01T13:21:07Z
updated_at: 2026-08-01T13:21:07Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 9.

**References:** web/src/components/Composer.tsx:15-54; web/src/components/EditableBlockTree.tsx:397-399,558-618,786-792

Both editors update caret and autocomplete context only from onChange. Mouse clicks and selection-only caret movement can leave an old completion active, allowing Enter/Tab to edit the wrong location or consume an intended newline.

**Direction:** Recompute on selection changes or derive completion context from the textarea's live selection when executing a pick. Prefer a shared autocomplete-controller hook.

- [ ] Add selection-only caret movement tests in both editors
- [ ] Implement shared/live autocomplete context handling
