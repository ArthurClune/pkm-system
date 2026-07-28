---
# pkm-04a2
title: 'describe key file: move default out of data/, file wins over env'
status: completed
type: task
priority: normal
created_at: 2026-07-28T07:01:56Z
updated_at: 2026-07-28T07:12:26Z
---

Follow-up to pkm-wwy3 per user: (1) default openai_api_key_file becomes '../openai_key' (PKM_HOME root, sibling of data/) so the secret never sits in the data dir that holds servable/exportable content — defense in depth, nothing serves it today; (2) precedence flips: key file wins over OPENAI_API_KEY env var (user may run a general env key but want a pkm-specific key for cost attribution). Update reason message, tests, backend.md, deploy/README.md.

Done: Config.openai_api_key_file default changed to Path("../openai_key"); load_config raw.get default updated to match. _default_describe_service in app.py now resolves _read_key_file(...) or os.environ.get("OPENAI_API_KEY") or None (file wins). enabled_reason in describe/core.py now reads "no openai_key file and OPENAI_API_KEY is not set". Updated all pinned-string tests (test_describe_core.py, test_describe_routes.py, conftest.py) and added test_default_service_key_file_wins_over_env_var (env set + file present -> file's key used) plus updated test_config.py default-path assertion. Docs: backend.md config bullet and deploy/README.md image-descriptions note updated to PKM_HOME/openai_key + file-wins-over-env wording. 821 server tests pass, 95.88% coverage, pyrefly 0 errors, ruff clean.

## Summary of Changes

Merged to main at 56d68b1 (2026-07-28). Default openai_api_key_file is now '../openai_key' (PKM_HOME root, outside the data dir that holds servable/exportable content — nothing serves it today, this is defense in depth). Precedence flipped: key file beats OPENAI_API_KEY env var, so a pkm-specific cost-attribution key isn't shadowed by an ambient general key. Reason string, tests (incl. new precedence test), backend.md and deploy/README.md updated. 821 server tests, 95.88% cov, pyrefly/ruff clean. Prod key moved back to ~/.config/pkm/openai_key (mode 600).
