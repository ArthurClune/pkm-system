---
# pkm-pcm5
title: 'Retire docs/troubleshooting.md: symptom history lives in the beans'
status: completed
type: task
priority: normal
created_at: 2026-11-11T12:40:15Z
updated_at: 2026-11-11T12:44:10Z
---

docs/troubleshooting.md re-indexes the beans by symptom. Every bug-fix branch appends a row, so it conflicts in merges (74 of 325 commits touching it are merges), its Cause column names identifiers that go stale, and the doc skills audit it. A grep of .beans finds the same symptom strings.

- [x] Bean-less rows: the iPad replicas, `init_db` and `no-cache` were already stated in the architecture docs; the operator ones moved to deploy/README.md
- [x] Move operator-actionable deployment rows into deploy/README.md § Troubleshooting
- [x] Remove pointers from docs/architecture/*, README.md, deploy/README.md
- [x] AGENTS.md: bug fix records the owning rule section in the bean, not a row
- [x] commentlint: drop the file from its message, docstring and tests
- [x] Skills: architecture-docs, check-arch-docs, recheck-docs, update-changelog
- [x] Delete docs/troubleshooting.md

## Summary of Changes

Deleted `docs/troubleshooting.md`. A failure's story now lives only in the bean that fixed it. That bean's summary names the symptom as someone would observe it, the cause, and the doc section that states the rule, so `beans list -S '<error text>'` finds it. overview.md's reading table points there.

- deploy/README.md § Troubleshooting gained a symptom → fix table for the operator-facing rows (venv interpreter gone, `OSError 49` after a Tailscale reinstall, `Bootstrap failed: 5`, a TLS handshake hang, a 403 from `serve_origins`, stale tabs after a deploy).
- The bean-less architecture rows were already stated in their docs: the iPad replicas in sync-and-offline.md, `init_db` in backend.md, `no-cache` in frontend.md. So were the perf and property gate rows in checks.md.
- The intro pointers came out of each architecture doc, as did the pointer in README.md.
- AGENTS.md now has the bug-fix trigger write the symptom, cause and owning section into the bean.
- The architecture-docs, check-arch-docs and recheck-docs skills, and the update-changelog command, no longer name the file. recheck-docs lost its troubleshooting reviewer and its "lost incidents" hunt.
- commentlint's message and docstring dropped the file, and its tests use `docs/cli.md` as the unscanned path.
