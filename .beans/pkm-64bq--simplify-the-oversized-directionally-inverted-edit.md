---
# pkm-64bq
title: Simplify the oversized, directionally inverted editor boundary
status: todo
type: task
created_at: 2026-08-01T13:21:21Z
updated_at: 2026-08-01T13:21:21Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 12.

**References:** web/src/outline/useOutline.ts:10,38-52; web/src/components/EditableBlockTree.tsx:36-91,147-201,390-801

The outline engine imports its roughly 30-callback command interface from a UI component. EditableBlockTree defines the engine's port while BlockInput combines draft adoption, IME state, autocomplete, uploads, date picking, navigation, paste arming, and keyboard execution. Selection keyboard policy also remains ad hoc in the component despite the separate keyboard-policy core.

**Direction:** Move the editor command/port type into outline/, consider a discriminated command dispatcher plus a small set of imperative capabilities, extract the input shell/controller, and move selection decisions into the shared keyboard policy.

- [ ] Define the intended editor dependency direction and command boundary
- [ ] Extract cohesive input/session responsibilities without creating speculative abstractions
- [ ] Move remaining keyboard decisions into the functional core
