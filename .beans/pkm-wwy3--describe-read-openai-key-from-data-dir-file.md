---
# pkm-wwy3
title: 'describe: read OpenAI key from data-dir file'
status: completed
type: task
priority: normal
created_at: 2026-07-28T06:35:33Z
updated_at: 2026-07-28T06:49:08Z
---

Follow-up to pkm-zc0c: _default_describe_service reads OPENAI_API_KEY env var only; prod launchd plist has no env block. Add optional config.json key openai_api_key_file (default 'openai_key', resolved relative to config.json like db_file); env var still takes precedence; missing both => disabled with clear reason. Update backend.md + deploy/README.md. Key file lives at PKM_HOME/data/openai_key (mode 600).

## Checklist

- [x] `Config.openai_api_key_file` field + `load_config()` parsing (resolved
      relative to config.json, default `"openai_key"`)
- [x] `_default_describe_service` precedence: `OPENAI_API_KEY` env var, else
      key file's stripped contents, else disabled; missing/unreadable/empty
      file degrades to disabled without crashing
- [x] `enabled_reason`'s "no key" message updated to mention both the env
      var and the key file; all pinned-string sites updated in lockstep
      (`test_describe_core.py`, `test_describe_routes.py`, `conftest.py`)
- [x] New factory tests: key-file-only enables the service; config.json
      `openai_api_key_file` override resolves and is used
- [x] New `load_config` tests: default + override of `openai_api_key_file`
- [x] Confirmed no ambient `openai_key` file anywhere in the repo (fixture
      hermeticity for the dataclass default `Path("openai_key")`)
- [x] `docs/architecture/backend.md` Config bullet rewritten
- [x] `deploy/README.md` gained an "Image descriptions (optional)" section
- [x] `uv run pytest -q` (818 passed, coverage 95.88%), `uv run pyrefly
      check` (0 errors), `uv run ruff check` (clean)

## Summary of Changes

Merged to main at 14a5b09 (2026-07-28). Config gains optional openai_api_key_file (default 'openai_key', resolved next to config.json like db_file). _default_describe_service: OPENAI_API_KEY env var wins, else stripped key-file contents; missing/empty/unreadable/undecodable file degrades to disabled (OSError + UnicodeDecodeError both caught — review fix). enabled_reason message now names both sources. Docs: backend.md config bullet + deploy/README.md 'Image descriptions (optional)' note (no plist changes needed). 820 server tests, 95.88% cov, pyrefly/ruff clean. Prod key moved to ~/.config/pkm/data/openai_key (mode 600).
