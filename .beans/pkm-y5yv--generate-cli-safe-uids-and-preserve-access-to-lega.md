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
  changes needed (confirmed empirically before writing any code) — so
  legacy leading-dash uids (Roam-imported or pre-pkm-y5yv) stay addressable
  via e.g. `pkm get -- -abc123wxyz9` / `pkm update -D -- -abc123wxyz9`
  (flags must precede `--`, since everything after it is positional).
  Documented this in both subcommands' epilogs, in
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
  **Proposed for a follow-up bean:** now that every newly-minted uid
  (client and server) is guaranteed alphanumeric-first, `UID_RE` could be
  tightened to `^[a-zA-Z0-9][a-zA-Z0-9_-]{5,31}$` for anything created from
  here on, while still accepting legacy leading-dash uids already in the
  DB (the regex only gates *new* writes at `routes_pages.py:131,141`, not
  reads, so this would not break existing data). Left undone here per the
  controller's explicit instruction to leave `UID_RE` alone and only note
  the idea.
