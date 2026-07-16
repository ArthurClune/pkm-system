# SDD progress: web architecture and FCIS hardening (pkm-c1cg)

Branch: feat/pkm-c1cg-web-architecture
Base: bc88a9f
Design: docs/superpowers/specs/2026-07-15-web-architecture-fcis-hardening-design.md (fdd7261)
Plan: docs/superpowers/plans/2026-07-15-web-architecture-fcis-hardening.md (ef5e55d)
Scope: all ten child beans plus final epic audit; fresh implementer and reviewer per task
Baseline: pnpm verify PASS (654 unit tests, coverage thresholds, build, 6 Playwright)
Task 1: complete (pkm-dcmm; commits ef5e55d..7eadae5, review clean)
Minor review finding: canonical output includes pre-existing unmatched-route,
SQLite constraint, Node experimental, and Vite chunk-size diagnostics; final
whole-branch review should triage suppression where practical.
Task 2: complete (pkm-qvqz; commits 9cc2a2b..79bd85f, review clean)
Minor review finding: Task 2 canonical evidence carries the same pre-existing
verification-output diagnostics; include them in the final hygiene triage.
Task 3: complete (pkm-huv4; commits 2abd159..17716b2, review clean)
Minor review finding: Task 3 focused SQLite evidence still prints the expected
foreign-key diagnostic; include it in the final verification-output triage.
Task 4: complete (pkm-viah; commits fde798b..3b42b2b, review clean)
Task 5: complete (pkm-z77x; commits 0afc421..405a5e3, review clean)
Task 6: complete (pkm-stn6; commits b5c6351..7a2c1ff, review clean)
Minor review findings deferred to final whole-branch triage: SidebarNav can
show the generic failure banner and the specific 409 addError simultaneously;
SidebarNav reorder test name over-claims index-staleness coverage; QueryBlock
pagination-recovery test's between-click findByRole is a soft sync point
(robustness rests on the vi.waitFor).
Task 7: complete (pkm-wudz; commits f22ab39..261f1fc, review clean)
Scope note: plan listed web/src/sync/replicaSync.ts as Modify, but it was left
a shell; implementer flagged it and the reviewer independently adjudicated the
deviation as justified — the Step 2 sync-transition behaviors are covered by
syncState/queueState and dispatched from SyncProvider, and the residual
replicaSync logic is I/O control flow whose extraction would require the
speculative union the plan forbids. Revisit only if the final audit disagrees.
Task 8: complete (pkm-1cq3; commit 9691df0, review clean)
Scope notes adjudicated by reviewer: (1) shared/fixtures/refs_parity.json left
untouched — it is byte-pinned to server refs_parity_dump.py, so new
Unicode/nested/malformed cases went into ref_grammar.json, replayed by all
three extractors (server test_refs.py, web grammar/refs.test.ts,
web replica/refs.test.ts), which meets the cross-extractor-agreement goal.
(2) Five intentional edge-behavior changes (replica Unicode hashtags,
code-opaque refAtCaret, backtick-adjacent hashtag, attribute leading
whitespace, autolink chunk-seam) judged contract-mandated or harmless
unpinned edges; no previously-pinned assertion changed. Documented in the
pkm-1cq3 bean for the final audit.
Task 9: complete (pkm-1jw6; commit 503d99f, review clean)
Minor review findings deferred to final whole-branch triage: fcis.mjs AST
edge-extraction/type-only helpers (lines ~55-115) lack direct unit tests
(exercised only via the live check:fcis run); fcis-core.mjs header detection
is a whole-file scan so a stray "// pattern:" comment elsewhere in a file
would register as a duplicate-header diagnostic.
Task 10: complete (pkm-f1rn; commit 3b9ff69, review clean after human ratification)
Plan-mandated deviation RATIFIED BY USER 2026-07-16: initialEntryBytes budget
is 462016 (actual eager entry 440910 + ~4.8% headroom), not the plan's
unattainable 423707; no follow-up shrink work owed. Minor review findings
deferred to final whole-branch triage: precacheEntries guard undercounts
(manifestTransforms sees ~74 vs Workbox-final 78, blind spot ~= remaining
headroom under the 82 cap; byte guard exact); task-10-report lists wrong deps
for useOutline run (cosmetic); useOutline run re-creates on sync identity
change (benign, arguably a latent-bug fix); collectMermaidOwned graph
traversal lives in the plugin shell. Verification note: one non-reproducible
offline-shell cold-start flake in a full-suite run (element-not-stable churn
signature, matches pre-existing resyncSeq remount issue; 4/4 isolated and
subsequent full verify clean; reviewer ruled out the suppression conversions
as the cause).
Task 11: complete (docs 16b4368; audit zero blocking evidence gaps)
Final whole-branch review (bc88a9f..fccd51b): READY TO MERGE, zero
Critical/Important. Deferred-Minor triage: items 1-8 and 10 ACCEPT (with
sync-shell Minors 1-3 folded into follow-up bean pkm-wggr), item 9 split —
three practical fixes to follow-up bean pkm-23dd, SQLite FK diagnostic and
Node localStorage warning accepted as intrinsic. Epic bean pkm-c1cg marked
completed with full Summary of Changes.
