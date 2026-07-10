---
# pkm-22ay
title: 'EditableBlockTree remote-adoption polish: IME guard, dirty-clear identity, caret'
status: todo
type: task
priority: low
created_at: 2026-07-10T12:21:55Z
updated_at: 2026-07-10T12:21:55Z
---

Follow-ups from pkm-tmtf final-review triage (2026-07-10 batch). Remote text adoption in EditableBlockTree (adopt-when-clean effect + dirtyRef) has three polish gaps: (1) no compositionstart/end handling — a remote update arriving mid-IME-composition (CJK/accented input) calls setDraft under the composition and can disturb it; (2) dirtyRef is cleared by value-equality with node.text, so a remote commit coincidentally equal to the local unflushed draft clears dirty while the local op is still pending (theoretical, LWW-convergent); (3) adoption does not preserve/reposition the caret in a focused-but-clean textarea.

## Checklist
- [ ] Suppress remote adoption during IME composition (compositionstart/end guard), with a test
- [ ] Consider writer-identity (or pending-op-aware) dirty clearing instead of pure value equality
- [ ] Preserve caret position on adoption when focused and clean
- [ ] pnpm test + typecheck clean
