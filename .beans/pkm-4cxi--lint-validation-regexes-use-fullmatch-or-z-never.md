---
# pkm-4cxi
title: 'Lint: validation regexes use fullmatch or \Z, never $'
status: todo
type: task
created_at: 2026-10-21T14:01:04Z
updated_at: 2026-10-21T14:01:04Z
parent: pkm-a1xk
---

Not a property test: the same bug has happened twice. `$` matches just before a trailing newline, so a validation regex anchored with `$` accepts a value with a trailing newline: `UID_RE` with `.match()` (a uid ending in a newline could never be read back), and Starlette's `path` convertor (`/api/local/a%0A` served file `a`, `pkm-e7z9`).

## Checklist

- [ ] Add a rule to the existing Python lint tooling (`server/tooling/`, alongside commentlint/brandlint; see `docs/architecture/enforced-checks.md`): a regex used for validation uses `fullmatch` or ends in `\Z`, never `$` with `match`/`search`. Decide with Arthur how a legitimate `$` (multiline search) is declared, as a named, enforced route rather than an allow-list.
- [ ] Fix every existing hit, per the repo rule that a new gate fixes the whole set.
- [ ] Web side: JS `$` without the `m` flag does not match before a trailing newline, so check whether an equivalent rule is needed there at all, and say so in the doc.
- [ ] Document the rule in `enforced-checks.md` and add a teeth test that a planted `$` validation regex fails the lint.
