---
# pkm-y5yv
title: Generate CLI-safe UIDs and preserve access to legacy leading-dash UIDs
status: completed
type: bug
priority: high
created_at: 2026-07-31T15:54:51Z
updated_at: 2026-07-31T15:54:51Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 6.

**References:** server/src/pkm/client/api.py:55-56; server/src/pkm/server/ops_core.py:15; server/src/pkm/cli/main.py:475-476,521-525

secrets.token_urlsafe() can generate a UID beginning with -. The server accepts it, but argparse interprets it as an option, so the CLI can create blocks it cannot subsequently address normally. This also makes write tests probabilistically flaky.

**Direction:** Generate UIDs with an alphanumeric first character. Preserve access to existing leading-dash UIDs through documented -- handling or an explicit --uid option and plan any regex tightening compatibly.

- [x] Add deterministic leading-dash parser and end-to-end tests
- [x] Make new UID generation CLI-safe
- [x] Document or implement access to legacy UIDs

## Summary of Changes

- `server/src/pkm/client/api.py::new_uid` and
  `server/src/pkm/server/ops_apply.py::_new_uid` (the conflict-sibling uid
  minter — same flaw, same fix, not called out in the brief but sharing the
  identical `secrets.token_urlsafe(9)` root cause) now retry until the first
  character is alphanumeric. `UID_RE` is untouched, as directed.
- Verified `pkm get`/`pkm update`'s bare-uid positional arguments already
  support the standard argparse `--` end-of-options marker with no parser
  changes needed (confirmed empirically before writing any code) — so a
  leading-dash uid predating pkm-y5yv (Roam-imported, or created by any
  pre-pkm-y5yv minter, including the web app before fix round 1 below)
  stays addressable via e.g. `pkm get -- -abc123wxyz9` / `pkm update -D
  -- -abc123wxyz9` (flags must precede `--`, since everything after it is
  positional). Documented this in both subcommands' epilogs, in
  `.claude/skills/pkm/SKILL.md`, and in `docs/architecture/backend.md`
  under "The write path" and "CLI and MCP server".
- Tests (TDD, RED before GREEN — see report):
  - `test_client_api.py::test_new_uid_retries_until_first_char_is_alphanumeric`
  - `test_ops_apply.py::test_conflict_sibling_uid_retries_until_alphanumeric_first_char`
  - `test_cli_main_read.py::test_get_addresses_a_legacy_leading_dash_uid_via_double_dash`
  - `test_cli_main_read.py::test_get_a_leading_dash_uid_without_double_dash_is_rejected_by_argparse`
    (documents the failure mode `--` fixes)
  - `test_cli_main_write.py::test_update_addresses_a_legacy_leading_dash_uid_via_double_dash`
  - `test_cli_main_write.py::test_update_done_flag_on_a_legacy_leading_dash_uid_puts_flags_before_the_guard`
- Full suite: `uv run pytest -q` → 968 passed, 96.13% coverage (>= 95%
  required). `uv run pyrefly check` → 0 errors. `uv run ruff check` → all
  checks passed.
- Not done, per explicit scope resolution: no `UID_RE` tightening.
  **Proposed for a follow-up bean (needs its own migration-aware design,
  not a same-bean change):** `UID_RE` could eventually be tightened to
  reject a leading `-`/`_` for *newly minted* uids only. Any such change
  must not touch how an existing uid is *read*/*addressed* — blocks
  already in the database with a leading-dash uid (from imports, or from
  any minter's pre-fix behavior) must remain updatable/movable by that
  uid, since a rejected op wedges the offline queue in this codebase. A
  same-bean tightening was explicitly out of scope here; left undone.

## Fix round 1 (task review)

Review found the web app's independent uid minter was never fixed, so the
docs above overstated the invariant (framing leading-dash uids as
import/legacy-only when the SPA could still mint one in ~1/32 of new
blocks). Fixed:

- `web/src/uidCore.ts` — added `isAlphanumericByte(byte)`, a pure predicate
  (index < 62 in the 64-symbol alphabet, i.e. not `_`/`-`).
- `web/src/uid.ts::newUid` — resamples only the first byte via
  `crypto.getRandomValues` until it passes `isAlphanumericByte`, mirroring
  the Python client/server rejection-sampling fix. TDD: RED first
  (`uidCore.test.ts` two new tests calling the not-yet-existing predicate;
  `uid.test.ts` a `crypto.getRandomValues` mock driving two rejects then
  an accept, asserting `uid[0] === "a"` deterministically — failed against
  the unfixed minter with `'-'`), then GREEN after the fix.
- Also added a first-char assertion to the existing 200-sample property
  test in `uid.test.ts`, and `all(u[0].isalnum() ...)` to
  `test_new_uid_matches_server_uid_re` in `server/tests/test_client_api.py`
  (cheap reviewer minor).
- Corrected the three doc passages that framed leading-dash uids as
  legacy/import-only: `.claude/skills/pkm/SKILL.md`,
  `docs/architecture/backend.md` (both the "write path" and "CLI and MCP
  server" passages), and the CLI's own `get`/`update` epilogs in
  `server/src/pkm/cli/main.py` — all now say a leading-dash uid can come
  from an import *or* a pre-pkm-y5yv build of any minter (CLI, server, or
  web app), not just imports.
- Verification: `cd web && pnpm typecheck` clean;
  `cd web && pnpm test:unit` — all unit tests pass including coverage
  gate; `cd server && uv run pytest -q tests/test_client_api.py` — all
  pass. Full `pnpm verify` (adds Playwright E2E) run separately — see
  report for command/output/any fallback notes.
