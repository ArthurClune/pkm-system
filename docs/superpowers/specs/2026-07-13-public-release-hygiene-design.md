# Public Release Hygiene Design

## Goal

Prepare the repository for public release by preventing accidental commits of
local environment files and by declaring the project under the MIT License.

## Changes

1. Add `.env` and `.env.*` to the root `.gitignore`. Because these patterns do
   not contain a slash, they protect environment files anywhere in the
   repository, including under `server/` and `web/`.
2. Add `!.env.example` so sanitized environment-variable documentation can be
   committed in the future.
3. Add the standard, unmodified MIT License in `LICENSE`, with
   `Copyright (c) 2026 Arthur Clune`.

## Validation

- Use `git check-ignore` to confirm root and nested environment files are
  ignored while `.env.example` remains trackable.
- Compare `LICENSE` with the canonical MIT License text and confirm the
  copyright line.
- Inspect `git diff --check`, the repository diff, and working-tree status.

## Scope

No runtime configuration, secret handling, application code, or deployment
behavior changes are included.
