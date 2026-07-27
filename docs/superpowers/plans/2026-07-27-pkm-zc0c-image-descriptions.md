# Image Descriptions Pipeline (pkm-zc0c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uploaded images get an LLM-generated searchable description, stored on the `assets` row, exposed via a search endpoint, CLI, and MCP, with a retro-scan endpoint and a read-only status section on `/settings`.

**Architecture:** New `server/src/pkm/describe/` package (FCIS split like `pkm/assistant/`): pure logic in `core.py`, an OpenAI httpx2 client in `openai_client.py`, and a sequential asyncio queue worker in `service.py` held on `app.state.describe`. Upload enqueues eligible images fire-and-forget; `POST /api/assets/scan` re-enqueues undescribed ones. Feature is enabled iff `OPENAI_API_KEY` is set and `config.json` doesn't disable it; when disabled everything degrades to no-ops and uploads are unaffected.

**Tech Stack:** Python 3.12, FastAPI, sqlite3, httpx2 (has `AsyncClient` + `MockTransport` — verified), pytest (`--cov-fail-under=95` with branch coverage), React/TypeScript + vitest for the settings section.

**Spec:** `docs/superpowers/specs/2026-07-27-pkm-zx19-image-descriptions-design.md`

## Global Constraints

- Every new runtime file declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top (CLAUDE.md FCIS rule).
- Server verification: `cd server && uv run pytest -q` (coverage ≥95 enforced), `uv run pyrefly check`, `uv run ruff check`.
- Web verification: `cd web && pnpm verify`.
- Any route change ⇒ regenerate `web/src/api/openapi.json` (`cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`) and `cd web && pnpm gen-types`, commit both (`tests/test_openapi_sync.py` enforces; every new GET route must declare a `response_model`).
- Any `BASE_DDL` change ⇒ regenerate `web/src/replica/baseSchema.gen.ts` (`cd server && uv run python -m pkm.schema_dump > ../web/src/replica/baseSchema.gen.ts`), commit (`tests/test_schema_artifact.py` enforces). This changes the replica `SCHEMA_VERSION` hash → browser replicas rebootstrap once after deploy; that is expected and already exercised (view_type precedent).
- No new Python dependencies. No OpenAI SDK — plain httpx2.
- Work on a branch in a worktree (`superpowers:using-git-worktrees`); run everything from the worktree root. Check `git status -sb` before every commit.
- Commit the bean file `.beans/pkm-zc0c--image-descriptions-for-uploaded-assets.md` alongside code changes when updating its checklist.
- Do NOT touch `blocks_fts`/`pages_fts`, `/api/search`, or anything under `web/src/replica/localApi/` — main search and offline parity are explicitly out of scope.

---

### Task 1: Config keys

**Files:**
- Modify: `server/src/pkm/server/config.py`
- Test: `server/tests/test_config.py`

**Interfaces:**
- Produces: `Config.image_descriptions: bool` (default `True`), `Config.image_description_model: str` (default `"gpt-4o-mini"`), both parsed by `load_config()` from optional `config.json` keys of the same names.

- [ ] **Step 1: Write the failing tests**

Read `server/tests/test_config.py` first and follow its existing style for building a config JSON file. Add:

```python
def test_image_description_defaults(tmp_path):
    cfg = _load(tmp_path, {})  # reuse/extend the file's existing helper for minimal config JSON
    assert cfg.image_descriptions is True
    assert cfg.image_description_model == "gpt-4o-mini"


def test_image_description_overrides(tmp_path):
    cfg = _load(tmp_path, {"image_descriptions": False,
                           "image_description_model": "gpt-5-mini"})
    assert cfg.image_descriptions is False
    assert cfg.image_description_model == "gpt-5-mini"
```

If `test_config.py` has no helper, write the config dict inline the way its existing test does (it must include the required keys `db_file`, `assets_dir`, `password_salt`, `password_hash`, `session_secret`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_config.py -q --no-cov`
Expected: FAIL — `Config` has no attribute `image_descriptions`.

- [ ] **Step 3: Implement**

In `server/src/pkm/server/config.py`, add two fields to the frozen dataclass (after `max_upload_bytes`):

```python
    image_descriptions: bool = True
    image_description_model: str = "gpt-4o-mini"
```

and in `load_config()`:

```python
        image_descriptions=bool(raw.get("image_descriptions", True)),
        image_description_model=str(raw.get("image_description_model",
                                            "gpt-4o-mini")),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_config.py -q --no-cov`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/config.py server/tests/test_config.py
git commit -m "feat(server): config keys for image descriptions (pkm-zc0c)"
```

---

### Task 2: Schema — description columns on assets

**Files:**
- Modify: `server/src/pkm/schema.py` (assets table in `BASE_DDL`, lines ~51-57)
- Modify: `server/src/pkm/server/db.py` (`_ensure_schema_migrations`)
- Modify: `server/src/pkm/server/routes_assets.py:134`, `server/src/pkm/importer/run.py:94`, `server/src/pkm/test_data/generate.py:185`, `server/tests/test_export_writer.py:27,79,101`, `server/tests/test_journal_assets.py:139` (positional INSERTs)
- Regenerate: `web/src/replica/baseSchema.gen.ts`
- Test: `server/tests/test_schema_migrations.py` (new)

**Interfaces:**
- Produces: nullable columns `assets.description TEXT`, `assets.described_at INTEGER` (epoch ms), `assets.describe_error TEXT`. All later tasks read/write these.

**CRITICAL:** seven call sites use positional `INSERT INTO assets VALUES (?,?,?,?,?)` (or `(?,?,?,?,NULL)`). Adding columns breaks every one with "table assets has 8 columns but 5 values were supplied". All must switch to explicit column lists in this task, atomically with the DDL change.

- [ ] **Step 1: Write the failing migration test**

Create `server/tests/test_schema_migrations.py`:

```python
"""Guarded ALTERs in db._ensure_schema_migrations must upgrade a
pre-pkm-zc0c database (assets without description columns) in place."""
import sqlite3

from pkm.server.db import init_db, open_db

OLD_ASSETS_DDL = """
CREATE TABLE assets(
  sha256      TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER
);
"""


def test_existing_assets_table_gains_description_columns(tmp_path):
    db_path = tmp_path / "pkm.sqlite3"
    con = sqlite3.connect(db_path)
    con.executescript(OLD_ASSETS_DDL)
    con.execute("INSERT INTO assets VALUES ('ab'*32, 'a.png', 'image/png', 3, NULL)")
    con.commit()
    con.close()

    init_db(db_path)  # IF-NOT-EXISTS DDL skips the table; migration must ALTER it

    con = open_db(db_path)
    cols = {r[1] for r in con.execute("PRAGMA table_info(assets)")}
    assert {"description", "described_at", "describe_error"} <= cols
    row = con.execute("SELECT description, described_at, describe_error"
                      " FROM assets").fetchone()
    assert tuple(row) == (None, None, None)
    con.close()


def test_fresh_db_has_description_columns(tmp_path):
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    cols = {r[1] for r in con.execute("PRAGMA table_info(assets)")}
    assert {"description", "described_at", "describe_error"} <= cols
    con.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_schema_migrations.py -q --no-cov`
Expected: FAIL — columns missing.

- [ ] **Step 3: Update DDL and migration**

In `server/src/pkm/schema.py`, extend the assets table in `BASE_DDL`:

```sql
CREATE TABLE IF NOT EXISTS assets(
  sha256      TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER,
  -- pkm-zc0c: LLM-generated searchable description; all nullable.
  -- status is derived: described (description set) / failed
  -- (describe_error set) / pending (neither).
  description    TEXT,
  described_at   INTEGER,
  describe_error TEXT
);
```

In `server/src/pkm/server/db.py`, extend `_ensure_schema_migrations`:

```python
def _ensure_schema_migrations(con: sqlite3.Connection) -> None:
    """Apply additive migrations that cannot be expressed with IF NOT EXISTS."""
    columns = {row[1] for row in con.execute("PRAGMA table_info(blocks)")}
    if "view_type" not in columns:
        con.execute(
            "ALTER TABLE blocks ADD COLUMN view_type TEXT "
            "CHECK(view_type IN ('numbered','document'))")
    asset_columns = {row[1] for row in con.execute("PRAGMA table_info(assets)")}
    for col, decl in (("description", "TEXT"), ("described_at", "INTEGER"),
                      ("describe_error", "TEXT")):
        if col not in asset_columns:
            con.execute(f"ALTER TABLE assets ADD COLUMN {col} {decl}")
```

- [ ] **Step 4: Fix every positional INSERT into assets**

Run `grep -rn "INTO assets" server web/src` to confirm the full list, then convert each to an explicit column list. The three runtime sites:

`server/src/pkm/server/routes_assets.py:134`:
```python
    db.execute("INSERT OR IGNORE INTO assets(sha256, filename, mime, size,"
               " created_at) VALUES (?,?,?,?,?)",
               (sha, filename, mime, size, int(time.time() * 1000)))
```

`server/src/pkm/importer/run.py:94` and `server/src/pkm/test_data/generate.py:185` (both currently `INSERT INTO assets VALUES (?,?,?,?,NULL)`):
```python
    "INSERT INTO assets(sha256, filename, mime, size, created_at)"
    " VALUES (?,?,?,?,NULL)",
```

Test sites `server/tests/test_export_writer.py` (3×, currently `VALUES (?,?,?,?,?)`) and `server/tests/test_journal_assets.py:139` (`VALUES (?,?,?,?,NULL)`): same treatment — insert column list `(sha256, filename, mime, size, created_at)`, keep the value tuples unchanged.

- [ ] **Step 5: Regenerate the replica schema artifact**

```bash
cd server && uv run python -m pkm.schema_dump > ../web/src/replica/baseSchema.gen.ts
```

- [ ] **Step 6: Run the full server suite**

Run: `cd server && uv run pytest -q`
Expected: PASS, including `test_schema_migrations.py`, `test_schema_artifact.py`, `test_asset_upload.py`, `test_export_writer.py`, `test_journal_assets.py`, `test_importer_e2e.py`.

- [ ] **Step 7: Web typecheck (replica artifact changed)**

Run: `cd web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/pkm/schema.py server/src/pkm/server/db.py \
  server/src/pkm/server/routes_assets.py server/src/pkm/importer/run.py \
  server/src/pkm/test_data/generate.py server/tests/test_export_writer.py \
  server/tests/test_journal_assets.py server/tests/test_schema_migrations.py \
  web/src/replica/baseSchema.gen.ts
git commit -m "feat(server): assets description columns + guarded migration (pkm-zc0c)"
```

---

### Task 3: `describe/core.py` — pure logic

**Files:**
- Create: `server/src/pkm/describe/__init__.py` (empty)
- Create: `server/src/pkm/describe/core.py`
- Test: `server/tests/test_describe_core.py` (new)

**Interfaces:**
- Produces (all pure, consumed by Tasks 4-6):
  - `ELIGIBLE_MIME: frozenset[str]`, `MAX_DESCRIBE_BYTES = 15 * 1024 * 1024`, `MAX_DESCRIPTION_CHARS = 1000`, `PROMPT: str`
  - `describe_action(mime: str, size: int) -> Literal["describe", "skip", "too_large"]`
  - `enabled_reason(api_key: str | None, config_enabled: bool) -> str | None` (None = enabled)
  - `request_payload(model: str, mime: str, image_b64: str) -> dict`
  - `parse_description(body: Any) -> str` (raises `ValueError`)
  - `derive_status(description: str | None, describe_error: str | None) -> Literal["described", "failed", "pending"]`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_describe_core.py`:

```python
import pytest

from pkm.describe.core import (MAX_DESCRIPTION_CHARS, derive_status,
                               describe_action, enabled_reason,
                               parse_description, request_payload)


@pytest.mark.parametrize("mime,size,expected", [
    ("image/png", 100, "describe"),
    ("image/jpeg", 100, "describe"),
    ("image/webp", 100, "describe"),
    ("image/gif", 100, "describe"),
    ("image/svg+xml", 100, "skip"),        # can script; also not vision-supported
    ("image/heic", 100, "skip"),           # uploadable but OpenAI vision rejects it
    ("application/pdf", 100, "skip"),
    ("text/csv", 100, "skip"),
    ("image/png", 15 * 1024 * 1024 + 1, "too_large"),
    ("image/png", 15 * 1024 * 1024, "describe"),
])
def test_describe_action(mime, size, expected):
    assert describe_action(mime, size) == expected


def test_enabled_reason():
    assert enabled_reason("sk-x", True) is None
    assert enabled_reason(None, True) == "OPENAI_API_KEY is not set"
    assert enabled_reason("", True) == "OPENAI_API_KEY is not set"
    assert (enabled_reason("sk-x", False)
            == "disabled in config.json (image_descriptions=false)")
    # config off wins over missing key: the deliberate switch is the reason
    assert "config" in enabled_reason(None, False)


def test_request_payload_shape():
    p = request_payload("gpt-4o-mini", "image/png", "QUJD")
    assert p["model"] == "gpt-4o-mini"
    content = p["messages"][0]["content"]
    assert content[0]["type"] == "text"
    assert content[1]["image_url"]["url"] == "data:image/png;base64,QUJD"


def test_parse_description_happy_path():
    body = {"choices": [{"message": {"content": "  a graph of CPU load  "}}]}
    assert parse_description(body) == "a graph of CPU load"


def test_parse_description_truncates():
    body = {"choices": [{"message": {"content": "x" * 5000}}]}
    assert len(parse_description(body)) == MAX_DESCRIPTION_CHARS


@pytest.mark.parametrize("body", [
    {}, {"choices": []}, {"choices": [{"message": {}}]},
    {"choices": [{"message": {"content": ""}}]},
    {"choices": [{"message": {"content": "   "}}]},
    {"choices": [{"message": {"content": 42}}]},
    "not a dict", None,
])
def test_parse_description_rejects_malformed(body):
    with pytest.raises(ValueError):
        parse_description(body)


def test_derive_status():
    assert derive_status("text", None) == "described"
    assert derive_status(None, "http 429") == "failed"
    assert derive_status(None, None) == "pending"
    # description wins if both are somehow set (a retry that succeeded)
    assert derive_status("text", "old error") == "described"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_describe_core.py -q --no-cov`
Expected: FAIL — `ModuleNotFoundError: pkm.describe`.

- [ ] **Step 3: Implement**

Create empty `server/src/pkm/describe/__init__.py`, then `server/src/pkm/describe/core.py`:

```python
# pattern: Functional Core
"""Pure logic for LLM image descriptions (pkm-zc0c): eligibility, the
OpenAI request payload, response parsing, and status derivation. All I/O
(files, HTTP, env, DB) lives in describe/openai_client.py and
describe/service.py."""
from __future__ import annotations

from typing import Any, Literal

# The image subset of ALLOWED_UPLOAD_MIME that OpenAI vision accepts
# (png/jpeg/webp/non-animated gif). HEIC and SVG are uploadable but not
# describable, so they are skipped silently — "no description" is the
# normal state for them, not a failure.
ELIGIBLE_MIME = frozenset({
    "image/png", "image/jpeg", "image/webp", "image/gif",
})

# Above this we skip rather than downscale (no Pillow dependency in v1).
# 15 MB of raw bytes base64-encodes to ~20 MB, the OpenAI request ceiling;
# anything the API still rejects surfaces as describe_error.
MAX_DESCRIBE_BYTES = 15 * 1024 * 1024
MAX_DESCRIPTION_CHARS = 1000

PROMPT = (
    "Extract all text visible in this image (titles, labels, axis text, "
    "legends, captions, code), then add one or two sentences describing "
    "what the image shows. Plain text only, no markdown. The output is "
    "indexed for search, so favour concrete words over prose.")

Action = Literal["describe", "skip", "too_large"]
Status = Literal["described", "failed", "pending"]


def describe_action(mime: str, size: int) -> Action:
    if mime not in ELIGIBLE_MIME:
        return "skip"
    if size > MAX_DESCRIBE_BYTES:
        return "too_large"
    return "describe"


def enabled_reason(api_key: str | None, config_enabled: bool) -> str | None:
    """None = feature enabled; otherwise why it is off (shown in /settings)."""
    if not config_enabled:
        return "disabled in config.json (image_descriptions=false)"
    if not api_key:
        return "OPENAI_API_KEY is not set"
    return None


def request_payload(model: str, mime: str, image_b64: str) -> dict:
    return {
        "model": model,
        "max_tokens": 500,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url",
                 "image_url": {"url": f"data:{mime};base64,{image_b64}"}},
            ],
        }],
    }


def parse_description(body: Any) -> str:
    """Extract the completion text; ValueError on any unexpected shape."""
    try:
        text = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError("unexpected response shape")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("empty completion")
    return text.strip()[:MAX_DESCRIPTION_CHARS]


def derive_status(description: str | None,
                  describe_error: str | None) -> Status:
    if description is not None:
        return "described"
    if describe_error is not None:
        return "failed"
    return "pending"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_describe_core.py -q --no-cov`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/describe/__init__.py server/src/pkm/describe/core.py \
  server/tests/test_describe_core.py
git commit -m "feat(server): describe core — eligibility, payload, parsing (pkm-zc0c)"
```

---

### Task 4: `describe/service.py` — protocol, queue worker, DB writes

**Files:**
- Create: `server/src/pkm/describe/service.py`
- Create: `server/tests/fake_describer.py` (mirrors the `fake_engine.py` convention: shared fakes live in their own tests module, importable by conftest and test files)
- Test: `server/tests/test_describe_service.py` (new)

**Interfaces:**
- Consumes: `describe_action`, `derive_status` from `pkm.describe.core`; `Config` (Task 1); `open_db` from `pkm.server.db`; assets columns (Task 2).
- Produces (consumed by Tasks 5-6):
  - `class DescribeError(Exception)` — the storable failure reason describers raise
  - `class ImageDescriber(Protocol)` with `async def describe(self, image_bytes: bytes, mime: str) -> str`
  - `class DescribeService` with `__init__(config: Config, describer: ImageDescriber | None, reason: str | None)`, `.enabled -> bool` (property), `.reason: str | None`, `.start() -> None`, `async .close() -> None`, `.maybe_enqueue(sha256: str, mime: str, size: int) -> None`, `.scan(db: sqlite3.Connection, force: bool = False) -> int`, `async .drain() -> None` (test helper).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/fake_describer.py`:

```python
"""ImageDescriber test double (same convention as fake_engine.py)."""
from pkm.describe.service import DescribeError

PNG = b"\x89PNG\r\n\x1a\n" + b"fakepixels"


class FakeDescriber:
    def __init__(self, text: str = "a bar chart of monthly revenue",
                 error: str | None = None):
        self.text = text
        self.error = error
        self.calls: list[str] = []

    async def describe(self, image_bytes: bytes, mime: str) -> str:
        self.calls.append(mime)
        if self.error is not None:
            raise DescribeError(self.error)
        return self.text
```

Create `server/tests/test_describe_service.py`:

```python
import asyncio

from fake_describer import PNG, FakeDescriber

from pkm.describe.service import DescribeService
from pkm.server.db import open_db


def _insert_asset(config, sha, mime="image/png", size=None,
                  content=PNG, description=None, error=None):
    (config.assets_dir / sha[:2]).mkdir(parents=True, exist_ok=True)
    (config.assets_dir / sha[:2] / sha).write_bytes(content)
    con = open_db(config.db_path)
    con.execute(
        "INSERT INTO assets(sha256, filename, mime, size, created_at,"
        " description, describe_error) VALUES (?,?,?,?,?,?,?)",
        (sha, "f.png", mime, size if size is not None else len(content),
         1000, description, error))
    con.commit()
    con.close()


def _asset_row(config, sha):
    con = open_db(config.db_path)
    row = con.execute("SELECT description, described_at, describe_error"
                      " FROM assets WHERE sha256 = ?", (sha,)).fetchone()
    con.close()
    return row


SHA_A = "aa" * 32
SHA_B = "bb" * 32


async def _run(service, *shas_mimes):
    service.start()
    for sha, mime, size in shas_mimes:
        service.maybe_enqueue(sha, mime, size)
    await asyncio.wait_for(service.drain(), timeout=5)
    await service.close()


def test_worker_writes_description(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A)
    asyncio.run(_run(service, (SHA_A, "image/png", len(PNG))))
    row = _asset_row(seeded_config, SHA_A)
    assert row["description"] == "a bar chart of monthly revenue"
    assert row["described_at"] is not None
    assert row["describe_error"] is None
    assert fake.calls == ["image/png"]


def test_worker_records_error(seeded_config):
    service = DescribeService(seeded_config, FakeDescriber(error="openai http 429"), None)
    _insert_asset(seeded_config, SHA_A)
    asyncio.run(_run(service, (SHA_A, "image/png", len(PNG))))
    row = _asset_row(seeded_config, SHA_A)
    assert row["description"] is None
    assert row["describe_error"] == "openai http 429"


def test_worker_skips_already_described(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A, description="already done")
    asyncio.run(_run(service, (SHA_A, "image/png", len(PNG))))
    assert fake.calls == []
    assert _asset_row(seeded_config, SHA_A)["description"] == "already done"


def test_worker_records_too_large(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A, size=16 * 1024 * 1024)
    asyncio.run(_run(service, (SHA_A, "image/png", 16 * 1024 * 1024)))
    row = _asset_row(seeded_config, SHA_A)
    assert fake.calls == []
    assert row["describe_error"] == "too large to describe"


def test_worker_records_missing_file(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)
    con = open_db(seeded_config.db_path)  # row without a file on disk
    con.execute("INSERT INTO assets(sha256, filename, mime, size, created_at)"
                " VALUES (?,?,?,?,?)", (SHA_A, "f.png", "image/png", 10, 1000))
    con.commit()
    con.close()
    asyncio.run(_run(service, (SHA_A, "image/png", 10)))
    assert _asset_row(seeded_config, SHA_A)["describe_error"] == "file missing"


def test_maybe_enqueue_ignores_ineligible_and_disabled(seeded_config):
    service = DescribeService(seeded_config, FakeDescriber(), None)
    service.maybe_enqueue(SHA_A, "text/csv", 10)      # ineligible mime
    assert service._queue.qsize() == 0
    disabled = DescribeService(seeded_config, None, "OPENAI_API_KEY is not set")
    assert disabled.enabled is False
    disabled.maybe_enqueue(SHA_A, "image/png", 10)    # disabled: no-op
    assert disabled._queue.qsize() == 0
    disabled.start()                                   # no worker when disabled
    assert disabled._task is None


def test_scan_enqueues_undescribed_and_force_retries(seeded_config):
    service = DescribeService(seeded_config, FakeDescriber(), None)
    _insert_asset(seeded_config, SHA_A)                      # pending
    _insert_asset(seeded_config, SHA_B, error="openai http 500")  # failed
    con = open_db(seeded_config.db_path)
    assert service.scan(con) == 1            # pending only
    assert service.scan(con, force=True) == 2  # failed too
    con.close()


def test_scan_disabled_returns_zero(seeded_config):
    service = DescribeService(seeded_config, None, "OPENAI_API_KEY is not set")
    con = open_db(seeded_config.db_path)
    assert service.scan(con) == 0
    con.close()


def test_worker_survives_unexpected_exception(seeded_config):
    class ExplodingDescriber:
        async def describe(self, image_bytes: bytes, mime: str) -> str:
            raise RuntimeError("boom")

    service = DescribeService(seeded_config, ExplodingDescriber(), None)
    _insert_asset(seeded_config, SHA_A)
    _insert_asset(seeded_config, SHA_B)

    async def run():
        service.start()
        service.maybe_enqueue(SHA_A, "image/png", len(PNG))
        service.maybe_enqueue(SHA_B, "image/png", len(PNG))
        await asyncio.wait_for(service.drain(), timeout=5)
        assert not service._task.done()  # worker still alive after the crash
        await service.close()

    asyncio.run(run())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_describe_service.py -q --no-cov`
Expected: FAIL — `ModuleNotFoundError` / missing names.

- [ ] **Step 3: Implement**

Create `server/src/pkm/describe/service.py`:

```python
# pattern: Imperative Shell
"""Background queue + worker that fills assets.description (pkm-zc0c).

One sequential worker per process (rate-limit friendly); the queue is
in-memory only — a restart drops it, and POST /api/assets/scan re-enqueues
anything still undescribed. Disabled (describer=None) degrades every entry
point to a no-op so uploads are never affected."""
from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from typing import Protocol

from pkm.describe.core import describe_action
from pkm.server.config import Config
from pkm.server.db import open_db

log = logging.getLogger("pkm.describe")


class DescribeError(Exception):
    """A short, storable reason a describe attempt failed."""


class ImageDescriber(Protocol):
    async def describe(self, image_bytes: bytes, mime: str) -> str:
        """Return a search-oriented description; raise DescribeError."""
        ...


class DescribeService:
    def __init__(self, config: Config, describer: ImageDescriber | None,
                 reason: str | None):
        self._config = config
        self._describer = describer
        self.reason = reason
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._task: asyncio.Task | None = None

    @property
    def enabled(self) -> bool:
        return self._describer is not None

    def start(self) -> None:
        """Start the worker; call from the app lifespan (needs a loop)."""
        if self.enabled and self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._worker())

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def maybe_enqueue(self, sha256: str, mime: str, size: int) -> None:
        """Fire-and-forget enqueue on upload; no-op when disabled or the
        mime can never be described (oversized still enqueues so the
        failure is recorded honestly)."""
        if self.enabled and describe_action(mime, size) != "skip":
            self._queue.put_nowait(sha256)

    def scan(self, db: sqlite3.Connection, force: bool = False) -> int:
        """Enqueue every undescribed eligible asset; force retries failures."""
        if not self.enabled:
            return 0
        sql = "SELECT sha256, mime, size FROM assets WHERE description IS NULL"
        if not force:
            sql += " AND describe_error IS NULL"
        queued = 0
        for row in db.execute(sql).fetchall():
            if describe_action(row["mime"], row["size"]) != "skip":
                self._queue.put_nowait(row["sha256"])
                queued += 1
        return queued

    async def drain(self) -> None:
        """Test helper: resolve once every queued item has been processed."""
        await self._queue.join()

    async def _worker(self) -> None:
        while True:
            sha = await self._queue.get()
            try:
                await self._process(sha)
            except Exception:
                # One bad asset must not kill the worker for the rest.
                log.exception("describe failed for %s", sha)
            finally:
                self._queue.task_done()

    async def _process(self, sha: str) -> None:
        assert self._describer is not None
        con = open_db(self._config.db_path)
        try:
            row = con.execute(
                "SELECT mime, size, description FROM assets WHERE sha256 = ?",
                (sha,)).fetchone()
            if row is None or row["description"] is not None:
                return
            action = describe_action(row["mime"], row["size"])
            if action == "skip":
                return
            if action == "too_large":
                self._record(con, sha, error="too large to describe")
                return
            path = self._config.assets_dir / sha[:2] / sha
            try:
                image_bytes = path.read_bytes()
            except OSError:
                self._record(con, sha, error="file missing")
                return
            try:
                text = await self._describer.describe(image_bytes, row["mime"])
            except DescribeError as e:
                self._record(con, sha, error=str(e))
                return
            self._record(con, sha, description=text)
        finally:
            con.close()

    def _record(self, con: sqlite3.Connection, sha: str, *,
                description: str | None = None,
                error: str | None = None) -> None:
        con.execute(
            "UPDATE assets SET description = ?, described_at = ?,"
            " describe_error = ? WHERE sha256 = ?",
            (description,
             int(time.time() * 1000) if description is not None else None,
             error, sha))
        con.commit()
        log.info("described %s: %s", sha[:12],
                 "ok" if description is not None else f"error: {error}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_describe_service.py -q --no-cov`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/describe/service.py server/tests/fake_describer.py \
  server/tests/test_describe_service.py
git commit -m "feat(server): describe service — queue worker writing assets.description (pkm-zc0c)"
```

---

### Task 5: `describe/openai_client.py` — the real describer

**Files:**
- Create: `server/src/pkm/describe/openai_client.py`
- Test: `server/tests/test_describe_openai.py` (new)

**Interfaces:**
- Consumes: `request_payload`, `parse_description` from core; `DescribeError` from service.
- Produces: `class OpenAIDescriber` with `__init__(api_key: str, model: str, http: httpx2.AsyncClient | None = None)`, `async describe(image_bytes, mime) -> str` (raises `DescribeError`), `async close() -> None`. Consumed by Task 6's app factory.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_describe_openai.py`:

```python
import asyncio
import json

import httpx2
import pytest

from pkm.describe.openai_client import OpenAIDescriber
from pkm.describe.service import DescribeError


def _describe(handler, content=b"\x89PNGdata", mime="image/png") -> str:
    http = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    client = OpenAIDescriber("sk-test", "gpt-4o-mini", http=http)
    return asyncio.run(client.describe(content, mime))


def test_describe_success():
    seen = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        return httpx2.Response(200, json={
            "choices": [{"message": {"content": "a scatter plot of latency"}}]})

    assert _describe(handler) == "a scatter plot of latency"
    assert seen["auth"] == "Bearer sk-test"
    assert seen["body"]["model"] == "gpt-4o-mini"
    url = seen["body"]["messages"][0]["content"][1]["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")


def test_describe_http_error():
    def handler(request):
        return httpx2.Response(429, json={"error": {"message": "rate limited"}})

    with pytest.raises(DescribeError, match="openai http 429"):
        _describe(handler)


def test_describe_network_error():
    def handler(request):
        raise httpx2.ConnectTimeout("timed out")

    with pytest.raises(DescribeError, match="network error"):
        _describe(handler)


def test_describe_malformed_body():
    def handler(request):
        return httpx2.Response(200, json={"choices": []})

    with pytest.raises(DescribeError, match="bad response"):
        _describe(handler)


def test_describe_non_json_body():
    def handler(request):
        return httpx2.Response(200, text="<html>gateway error</html>")

    with pytest.raises(DescribeError, match="bad response"):
        _describe(handler)
```

(Sync tests wrapping `asyncio.run` — the dev dependencies include no async pytest plugin, and `test_describe_service.py` uses the same style.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_describe_openai.py -q --no-cov`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `server/src/pkm/describe/openai_client.py`:

```python
# pattern: Imperative Shell
"""OpenAI-backed ImageDescriber: one HTTPS POST per image (pkm-zc0c).
Plain httpx2 against the chat-completions endpoint — no OpenAI SDK."""
from __future__ import annotations

import base64

import httpx2

from pkm.describe.core import parse_description, request_payload
from pkm.describe.service import DescribeError

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
_TIMEOUT_SECONDS = 60.0


class OpenAIDescriber:
    def __init__(self, api_key: str, model: str,
                 http: httpx2.AsyncClient | None = None):
        self._model = model
        self._http = http if http is not None else httpx2.AsyncClient(
            timeout=_TIMEOUT_SECONDS)
        self._headers = {"Authorization": f"Bearer {api_key}"}

    async def describe(self, image_bytes: bytes, mime: str) -> str:
        b64 = base64.b64encode(image_bytes).decode("ascii")
        payload = request_payload(self._model, mime, b64)
        try:
            r = await self._http.post(OPENAI_URL, json=payload,
                                      headers=self._headers)
        except httpx2.TransportError as e:
            raise DescribeError(f"network error: {type(e).__name__}")
        if r.status_code >= 400:
            raise DescribeError(f"openai http {r.status_code}")
        try:
            return parse_description(r.json())
        except ValueError as e:
            raise DescribeError(f"bad response: {e}")

    async def close(self) -> None:
        await self._http.aclose()
```

`r.json()` on non-JSON raises `ValueError` (json.JSONDecodeError subclasses it), so the non-JSON test passes through the same `except ValueError`. If httpx2 raises its own decoding error type instead, catch that too — run the test to find out.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_describe_openai.py -q --no-cov`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/describe/openai_client.py server/tests/test_describe_openai.py
git commit -m "feat(server): OpenAI image describer over httpx2 (pkm-zc0c)"
```

---

### Task 6: App wiring, upload hook, and the three HTTP routes

**Files:**
- Create: `server/src/pkm/describe/routes.py`
- Modify: `server/src/pkm/server/app.py` (state, lifespan, router)
- Modify: `server/src/pkm/server/routes_assets.py` (enqueue on upload; `GET /api/assets/search`)
- Modify: `server/src/pkm/server/response_models.py`
- Modify: `server/tests/conftest.py` (fixtures)
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`
- Test: `server/tests/test_describe_routes.py` (new)

**Interfaces:**
- Consumes: `DescribeService`, `ImageDescriber`, `DescribeError` (Task 4); `OpenAIDescriber` (Task 5); `enabled_reason`, `derive_status` (Task 3).
- Produces:
  - `create_app(config, *, api_port=8974, assistant_engine=None, describe_service: DescribeService | None = None)` — tests inject a service built on a fake describer; default builds from env.
  - `GET /api/assets/describe-status` → `DescribeStatusPayload {enabled: bool, reason: str | None}`
  - `POST /api/assets/scan?force=` → `ScanPayload {queued: int, enabled: bool, reason: str | None}` (200 even when disabled; `queued=0` + reason)
  - `GET /api/assets/search?q=&limit=` → `AssetSearchPayload {assets: [{sha256, filename, mime, size, created_at, url, description, status}]}`; empty `q` lists most-recent first. Consumed by Tasks 7-9.

- [ ] **Step 1: Add response models**

In `server/src/pkm/server/response_models.py`, after `AssetUploadResponse`:

```python
class AssetSearchItem(BaseModel):
    sha256: str
    filename: str
    mime: str
    size: int
    created_at: int | None
    url: str
    description: str | None
    status: Literal["described", "failed", "pending"]


class AssetSearchPayload(BaseModel):
    assets: list[AssetSearchItem]


class DescribeStatusPayload(BaseModel):
    enabled: bool
    reason: str | None


class ScanPayload(BaseModel):
    queued: int
    enabled: bool
    reason: str | None
```

(Import `Literal` from `typing` if the file doesn't already.)

- [ ] **Step 2: Write the failing route tests**

Create `server/tests/test_describe_routes.py`. It needs an app whose lifespan runs (worker start), a fake describer, and a login — model the fixture on `assistant_client` in conftest:

Add to `server/tests/conftest.py`:

```python
@pytest.fixture()
def describe_client(seeded_config) -> Iterator[TestClient]:
    """TestClient (lifespan running, so the describe worker is live) whose
    DescribeService wraps a FakeDescriber."""
    from fake_describer import FakeDescriber
    from pkm.describe.service import DescribeService

    service = DescribeService(seeded_config, FakeDescriber(), None)
    app = create_app(seeded_config, describe_service=service)
    with TestClient(app) as c:
        r = c.post("/api/login", json={"password": TEST_PASSWORD})
        assert r.status_code == 200
        yield c


@pytest.fixture()
def describe_disabled_client(seeded_config) -> Iterator[TestClient]:
    from pkm.describe.service import DescribeService

    service = DescribeService(seeded_config, None, "OPENAI_API_KEY is not set")
    with TestClient(create_app(seeded_config, describe_service=service)) as c:
        r = c.post("/api/login", json={"password": TEST_PASSWORD})
        assert r.status_code == 200
        yield c
```

Then the tests:

```python
"""Routes: /api/assets/describe-status, /api/assets/scan, /api/assets/search,
plus the upload → enqueue hook."""
import time

from fake_describer import PNG


def _upload(client, content=PNG, name="graph.png", mime="image/png"):
    r = client.post("/api/assets", files={"file": (name, content, mime)})
    assert r.status_code == 200
    return r.json()["sha256"]


def _wait_processed(client, sha, tries=250):
    """The worker runs on the app loop in TestClient's portal thread, so it
    makes progress while this thread sleeps; poll until the row leaves
    'pending' (described or failed)."""
    for _ in range(tries):
        hits = client.get("/api/assets/search", params={"q": ""}).json()["assets"]
        row = next(h for h in hits if h["sha256"] == sha)
        if row["status"] != "pending":
            return row
        time.sleep(0.02)
    raise AssertionError(f"asset {sha[:12]} still pending after wait")


def test_describe_status_enabled(describe_client):
    r = describe_client.get("/api/assets/describe-status")
    assert r.status_code == 200
    assert r.json() == {"enabled": True, "reason": None}


def test_describe_status_disabled(describe_disabled_client):
    r = describe_disabled_client.get("/api/assets/describe-status")
    assert r.json() == {"enabled": False, "reason": "OPENAI_API_KEY is not set"}


def test_upload_triggers_description(describe_client):
    sha = _upload(describe_client)
    row = _wait_processed(describe_client, sha)
    assert row["status"] == "described"
    hits = describe_client.get("/api/assets/search",
                               params={"q": "revenue"}).json()["assets"]
    assert [h["sha256"] for h in hits] == [sha]
    assert hits[0]["description"] == "a bar chart of monthly revenue"
    assert hits[0]["url"] == f"/assets/{sha}/graph.png"


def test_upload_when_disabled_still_succeeds(describe_disabled_client):
    sha = _upload(describe_disabled_client)
    r = describe_disabled_client.get("/api/assets/search", params={"q": ""})
    hits = r.json()["assets"]
    assert hits[0]["sha256"] == sha
    assert hits[0]["status"] == "pending"


def test_scan_endpoint(describe_client):
    sha = _upload(describe_client)        # described on upload
    _wait_processed(describe_client, sha)
    r = describe_client.post("/api/assets/scan")
    assert r.json() == {"queued": 0, "enabled": True, "reason": None}
    # force re-queues nothing here either: described rows are never rescanned
    r = describe_client.post("/api/assets/scan", params={"force": "true"})
    assert r.json()["queued"] == 0


def test_scan_disabled(describe_disabled_client):
    r = describe_disabled_client.post("/api/assets/scan")
    assert r.json() == {"queued": 0, "enabled": False,
                        "reason": "OPENAI_API_KEY is not set"}


def test_search_by_filename_and_recency(describe_client):
    sha_a = _upload(describe_client, content=PNG + b"a", name="alpha.png")
    sha_b = _upload(describe_client, content=PNG + b"b", name="beta.png")
    _wait_processed(describe_client, sha_b)
    hits = describe_client.get("/api/assets/search",
                               params={"q": "beta"}).json()["assets"]
    assert [h["sha256"] for h in hits] == [sha_b]
    both = describe_client.get("/api/assets/search",
                               params={"q": ""}).json()["assets"]
    assert {h["sha256"] for h in both} == {sha_a, sha_b}


def test_search_like_escaping(describe_client):
    _upload(describe_client, name="100%.png")
    hits = describe_client.get("/api/assets/search",
                               params={"q": "0%"}).json()["assets"]
    assert len(hits) == 1              # % matched literally, not as wildcard
    none = describe_client.get("/api/assets/search",
                               params={"q": "zzz%"}).json()["assets"]
    assert none == []
```

(`safe_filename` replaces only path separators and control characters, so `100%.png` keeps its `%` — verify with a quick REPL check if the escaping test fails on the filename instead of the LIKE clause.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_describe_routes.py -q --no-cov`
Expected: FAIL — unknown `describe_service` kwarg, 404s.

- [ ] **Step 4: Implement routes**

Create `server/src/pkm/describe/routes.py`:

```python
# pattern: Imperative Shell
"""Describe-feature routes: status + retro-scan (pkm-zc0c). Asset search
lives in routes_assets.py with the other asset routes."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Request

from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.response_models import DescribeStatusPayload, ScanPayload

router = APIRouter(dependencies=[Depends(require_auth)])


@router.get("/api/assets/describe-status", response_model=DescribeStatusPayload)
def describe_status(request: Request) -> dict:
    service = request.app.state.describe
    return {"enabled": service.enabled, "reason": service.reason}


@router.post("/api/assets/scan", response_model=ScanPayload)
def scan(request: Request, force: bool = False,
         db: sqlite3.Connection = Depends(get_db)) -> dict:
    service = request.app.state.describe
    queued = service.scan(db, force=force)
    return {"queued": queued, "enabled": service.enabled,
            "reason": service.reason}
```

In `server/src/pkm/server/routes_assets.py`:

1. Add imports: `from fastapi import Request` (extend the existing fastapi import), `from pkm.describe.core import derive_status`, and extend the response-models import with `AssetSearchPayload`.
2. Add `request: Request` parameter to `upload_asset` and, right before its `return`:

```python
    request.app.state.describe.maybe_enqueue(sha, mime, size)
```

3. Add the search route (place it ABOVE `get_asset` for readability; paths don't collide):

```python
@router.get("/api/assets/search", response_model=AssetSearchPayload)
def search_assets(q: str = "", limit: int = 50,
                  db: sqlite3.Connection = Depends(get_db)) -> dict:
    """LIKE search over description + filename (pkm-zc0c). Empty q lists
    most-recent uploads — the seed of the file-browser list endpoint.
    LIKE, not FTS: personal-scale table, and no offline-parity burden."""
    limit = max(1, min(limit, 200))
    needle = q.strip()
    where, params = "", []
    if needle:
        esc = (needle.replace("\\", "\\\\")
                     .replace("%", "\\%")
                     .replace("_", "\\_"))
        where = (r"WHERE (description LIKE ? ESCAPE '\'"
                 r" OR filename LIKE ? ESCAPE '\') ")
        params = [f"%{esc}%", f"%{esc}%"]
    rows = db.execute(
        "SELECT sha256, filename, mime, size, created_at, description,"
        f" describe_error FROM assets {where}"
        "ORDER BY created_at IS NULL, created_at DESC, sha256 LIMIT ?",
        (*params, limit)).fetchall()
    return {"assets": [{
        "sha256": r["sha256"], "filename": r["filename"], "mime": r["mime"],
        "size": r["size"], "created_at": r["created_at"],
        "url": f"/assets/{r['sha256']}/{r['filename']}",
        "description": r["description"],
        "status": derive_status(r["description"], r["describe_error"]),
    } for r in rows]}
```

In `server/src/pkm/server/app.py`:

1. Imports:

```python
import os

from pkm.describe.core import enabled_reason
from pkm.describe.openai_client import OpenAIDescriber
from pkm.describe.routes import router as describe_router
from pkm.describe.service import DescribeService
```

2. Factory (module level, above `create_app`):

```python
def _default_describe_service(config: Config) -> DescribeService:
    api_key = os.environ.get("OPENAI_API_KEY")
    reason = enabled_reason(api_key, config.image_descriptions)
    if reason is not None:
        return DescribeService(config, None, reason)
    assert api_key is not None
    return DescribeService(
        config, OpenAIDescriber(api_key, config.image_description_model), None)
```

3. `create_app` signature gains `describe_service: DescribeService | None = None`; after the assistant wiring:

```python
    app.state.describe = (describe_service if describe_service is not None
                          else _default_describe_service(config))
```

4. Lifespan starts/stops the worker:

```python
@asynccontextmanager
async def _lifespan(app: FastAPI):
    app.state.describe.start()
    yield
    await app.state.describe.close()
    await app.state.assistant.close_all()
```

5. Register `app.include_router(describe_router)` next to `assets_router`.

**Ordering caveat:** FastAPI matches routes in registration order, and `GET /api/assets/describe-status` shares no path with `GET /assets/{sha256}/{filename}` — no conflict. But confirm no existing route is `GET /api/assets/{...}`; there isn't one today.

**Existing-tests caveat:** conftest's plain `client`/`anon_client` fixtures don't run the lifespan, so `_default_describe_service` runs at `create_app` time in every existing test. On a dev machine with `OPENAI_API_KEY` set that would build a real `OpenAIDescriber` (harmless — worker never starts without lifespan — but wrong-shaped). Keep tests hermetic: in `conftest.py`, add an autouse fixture:

```python
@pytest.fixture(autouse=True)
def _no_ambient_openai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
```

Also add an app-level test to `test_describe_routes.py` that the default factory respects config:

```python
def test_default_service_disabled_without_key(seeded_config):
    from pkm.server.app import _default_describe_service
    service = _default_describe_service(seeded_config)
    assert service.enabled is False
    assert service.reason == "OPENAI_API_KEY is not set"


def test_default_service_enabled_with_key(seeded_config, monkeypatch):
    from pkm.server.app import _default_describe_service
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    service = _default_describe_service(seeded_config)
    assert service.enabled is True
    assert service.reason is None
```

- [ ] **Step 5: Run the new tests, then the whole suite**

Run: `cd server && uv run pytest tests/test_describe_routes.py -q --no-cov`
Expected: PASS
Run: `cd server && uv run pytest -q`
Expected: PASS except `test_openapi_sync.py` (stale openapi.json — next step). If `test_asset_upload.py` fails on the new `request` param or enqueue call, the `client` fixture's app has a disabled service (no key, thanks to the autouse fixture), so `maybe_enqueue` is a no-op — failures there mean something else is wrong; investigate, don't paper over.

- [ ] **Step 6: Regenerate OpenAPI + TS types**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
```

Run: `cd server && uv run pytest tests/test_openapi_sync.py -q --no-cov`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/pkm/describe/routes.py server/src/pkm/server/app.py \
  server/src/pkm/server/routes_assets.py server/src/pkm/server/response_models.py \
  server/tests/conftest.py server/tests/test_describe_routes.py \
  web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "feat(server): describe wiring — upload hook, scan/status/search routes (pkm-zc0c)"
```

---

### Task 7: CLI — `pkm assets search` / `pkm assets scan`

**Files:**
- Modify: `server/src/pkm/client/api.py` (two `PkmClient` methods)
- Modify: `server/src/pkm/cli/render.py` (`render_assets`)
- Modify: `server/src/pkm/cli/main.py` (verb, epilog, handler)
- Test: `server/tests/test_client_api.py`, `server/tests/test_cli_render.py`, `server/tests/test_cli_main_read.py`

**Interfaces:**
- Consumes: Task 6's endpoints.
- Produces: `PkmClient.search_assets(q: str, limit: int = 50) -> dict`, `PkmClient.scan_assets(force: bool = False) -> dict`, `render_assets(payload: dict) -> str`. `render_assets` is reused by the MCP tool in Task 8.

- [ ] **Step 1: Write the failing tests**

Read `server/tests/test_client_api.py`, `test_cli_render.py`, and `test_cli_main_read.py` first and copy their idioms exactly (they drive the in-process app via the `pkm_client` fixture / argv-level entry points). Add:

To `test_client_api.py`:

```python
def test_search_and_scan_assets(pkm_client, client):
    content = b"\x89PNG\r\n\x1a\n" + b"cli"
    up = client.post("/api/assets",
                     files={"file": ("cli.png", content, "image/png")})
    assert up.status_code == 200
    found = pkm_client.search_assets("cli")
    assert found["assets"][0]["filename"] == "cli.png"
    scanned = pkm_client.scan_assets(force=True)
    assert set(scanned) == {"queued", "enabled", "reason"}
```

To `test_cli_render.py`:

```python
def test_render_assets():
    payload = {"assets": [
        {"sha256": "ab" * 32, "filename": "graph.png", "mime": "image/png",
         "size": 1234, "created_at": 1753500000000,
         "url": "/assets/" + "ab" * 32 + "/graph.png",
         "description": "a bar chart of revenue", "status": "described"},
        {"sha256": "cd" * 32, "filename": "raw.png", "mime": "image/png",
         "size": 99, "created_at": None,
         "url": "/assets/" + "cd" * 32 + "/raw.png",
         "description": None, "status": "pending"},
    ]}
    out = render_assets(payload)
    assert "graph.png" in out
    assert "a bar chart of revenue" in out
    assert "/assets/" + "ab" * 32 + "/graph.png" in out
    assert "pending" in out


def test_render_assets_empty():
    assert render_assets({"assets": []}) == "no assets found"
```

To `test_cli_main_read.py` — it has a `run` fixture calling `main(list(argv), make_client=lambda: pkm_client)` against the in-process app; that app is built by the plain `create_app(seeded_config)` path, whose describe service is disabled (the autouse fixture from Task 6 clears `OPENAI_API_KEY`):

```python
def test_assets_search_finds_uploaded_file(run, pkm_client, tmp_path):
    f = tmp_path / "cli.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"cli")
    pkm_client.upload(f)
    code, out, _ = run("assets", "search", "cli")
    assert code == 0
    assert "cli.png" in out
    assert "pending" in out            # no describer on the test app


def test_assets_search_no_results(run):
    code, out, _ = run("assets", "search", "nothing-matches-this")
    assert code == 0
    assert out == "no assets found\n"


def test_assets_scan_disabled_exits_nonzero(run):
    code, out, err = run("assets", "scan")
    assert code == 1
    assert out == ""
    assert "OPENAI_API_KEY" in err
```

(The enabled-path scan behaviour — queued counts, force retries — is already covered at the route and service layers; the CLI adds only exit-code/formatting logic, which these three tests pin.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_client_api.py tests/test_cli_render.py tests/test_cli_main_read.py -q --no-cov`
Expected: FAIL — missing methods/functions/verb.

- [ ] **Step 3: Implement**

`server/src/pkm/client/api.py`, after `upload()`:

```python
    def search_assets(self, q: str, limit: int = 50) -> dict:
        return self._request("GET", "/api/assets/search",
                             params={"q": q, "limit": limit})

    def scan_assets(self, force: bool = False) -> dict:
        params = {"force": "true"} if force else {}
        return self._request("POST", "/api/assets/scan", params=params)
```

`server/src/pkm/cli/render.py` — follow the file's existing formatting helpers/style:

```python
def render_assets(payload: dict) -> str:
    """One asset per block: filename, url, status, then the description."""
    assets = payload["assets"]
    if not assets:
        return "no assets found"
    parts = []
    for a in assets:
        lines = [f"{a['filename']}  ({a['mime']}, {a['size']} bytes,"
                 f" {a['status']})",
                 f"  {a['url']}"]
        if a["description"]:
            lines.append(f"  {a['description']}")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)
```

`server/src/pkm/cli/main.py` — module-level epilog next to the others:

```python
_ASSETS_EPILOG = """\
examples:
  # find images by their LLM-generated description or filename
  pkm assets search "bar chart revenue"

  # queue undescribed images for description; --force retries failures
  pkm assets scan
  pkm assets scan --force

search output: one asset per block — filename (mime, size, status), URL
path usable in a block as ![](url), then the description when present.
scan requires the server to have image descriptions enabled
(OPENAI_API_KEY set); when disabled it prints the reason and exits 1.
"""
```

In `build_parser()` (follow the `_add` pattern):

```python
    p = _add("assets", "search asset descriptions / queue a describe scan",
             _ASSETS_EPILOG)
    sub_assets = p.add_subparsers(dest="assets_action", required=True)
    sp = sub_assets.add_parser("search", help="search descriptions+filenames")
    sp.add_argument("query")
    sp.add_argument("--limit", type=int, default=50)
    sub_assets.add_parser("scan", help="queue undescribed images") \
        .add_argument("--force", action="store_true",
                      help="also retry previously failed images")
```

(If nested subparsers fight the existing `_add` helper — e.g. epilog/help formatting asserts in `test_cli_help.py` — fall back to a flat positional: `p.add_argument("action", choices=["search", "scan"])`, `p.add_argument("query", nargs="?")`, `p.add_argument("--force", ...)`, `p.add_argument("--limit", ...)`, validating in the handler that `search` got a query. Check `test_cli_help.py` to see which shape its assertions tolerate.)

Handler:

```python
def cmd_assets(args: argparse.Namespace, client: PkmClient) -> int:
    if args.assets_action == "search":
        print(render_assets(client.search_assets(args.query,
                                                 limit=args.limit)))
        return 0
    result = client.scan_assets(force=args.force)
    if not result["enabled"]:
        print(f"image descriptions are disabled: {result['reason']}",
              file=sys.stderr)
        return 1
    print(f"queued {result['queued']} asset(s) for description")
    return 0
```

Register `"assets": cmd_assets` in `_HANDLERS`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_client_api.py tests/test_cli_render.py tests/test_cli_main_read.py tests/test_cli_help.py -q --no-cov`
Expected: PASS (test_cli_help auto-covers the new verb's epilog).

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/client/api.py server/src/pkm/cli/render.py \
  server/src/pkm/cli/main.py server/tests/test_client_api.py \
  server/tests/test_cli_render.py server/tests/test_cli_main_read.py
git commit -m "feat(cli): pkm assets search/scan (pkm-zc0c)"
```

---

### Task 8: MCP tool `search_assets`

**Files:**
- Modify: `server/src/pkm/mcp/server.py`
- Modify: `server/src/pkm/assistant/policy.py` (READ_TOOLS)
- Test: `server/tests/test_mcp_server.py`, `server/tests/test_assistant_policy.py`

**Interfaces:**
- Consumes: `PkmClient.search_assets` (Task 7), `render_assets` (Task 7).
- Produces: MCP tool `search_assets(q: str, limit: int = 20) -> str`; policy classifies it as a read tool so the assistant can call it unconfirmed.

- [ ] **Step 1: Write the failing tests**

`server/tests/test_mcp_server.py` has a `tools` fixture that monkeypatches `mcp_server._client_factory` to the in-process `pkm_client`. Two changes:

1. `test_tools_are_registered` asserts the EXACT tool-name set — add `"search_assets"` to it:

```python
    assert names == {"get_page", "get_block", "search", "query", "backlinks",
                     "todos", "save_note", "update_block", "batch",
                     "upload_asset", "search_assets"}
```

2. Add (modeled on `test_upload_asset`, which writes a PNG to tmp_path):

```python
def test_search_assets(tools, tmp_path):
    f = tmp_path / "diagram.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 50)
    tools.upload_asset(str(f), page="AI")
    out = tools.search_assets("diagram")
    assert "diagram.png" in out
    assert "/assets/" in out
    assert tools.search_assets("nothing-matches-this") == "no assets found"
```

And in `server/tests/test_assistant_policy.py`, extend whatever test pins the read/write split (the file exists — read it and match its helper names; `classify_tool` and `mcp_tool_name` are the policy module's public functions):

```python
def test_search_assets_is_a_read_tool():
    from pkm.assistant.policy import classify_tool, mcp_tool_name
    assert classify_tool(mcp_tool_name("search_assets")) == "read"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_mcp_server.py tests/test_assistant_policy.py -q --no-cov`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `server/src/pkm/mcp/server.py`, import `render_assets` alongside the other render imports, add above the registration tuple:

```python
def search_assets(q: str, limit: int = 20) -> str:
    """Find uploaded images/files by LLM-generated image description or
    filename. Returns filename, status, a /assets/... URL embeddable in a
    block as ![](url), and the description. Images are described
    automatically after upload when the feature is enabled."""
    return render_assets(_client().search_assets(q, limit=limit))
```

Add `search_assets` to the `for _fn in (...)` registration tuple.

In `server/src/pkm/assistant/policy.py`:

```python
READ_TOOLS: tuple[str, ...] = ("get_page", "get_block", "search", "query",
                               "backlinks", "todos", "search_assets")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_mcp_server.py tests/test_assistant_policy.py tests/test_assistant_routes.py -q --no-cov`
Expected: PASS (assistant route tests confirm nothing depended on the exact READ_TOOLS tuple length).

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/mcp/server.py server/src/pkm/assistant/policy.py \
  server/tests/test_mcp_server.py server/tests/test_assistant_policy.py
git commit -m "feat(mcp): search_assets tool, readable by the assistant (pkm-zc0c)"
```

---

### Task 9: Web — Settings status section

**Files:**
- Modify: `web/src/views/Settings.tsx`
- Test: `web/src/views/Settings.test.tsx`

**Interfaces:**
- Consumes: `GET /api/assets/describe-status` via `apiFetch` from `web/src/api/client.ts`; generated `DescribeStatusPayload` type from `web/src/api/types.d.ts` (regenerated in Task 6 — check `web/src/api/payloads.ts` for how existing payload types are re-exported and follow that).

- [ ] **Step 1: Write the failing tests**

Read `web/src/views/Settings.test.tsx` and `Help.test.tsx` for the mocking idiom (vitest + testing-library). Add tests:

```tsx
it("shows image descriptions enabled", async () => {
  // mock apiFetch (vi.mock of ../api/client) to resolve
  // {enabled: true, reason: null}
  render(<Settings />);
  expect(await screen.findByText(/image descriptions/i)).toBeInTheDocument();
  expect(await screen.findByText(/enabled/i)).toBeInTheDocument();
});

it("shows the disabled reason", async () => {
  // apiFetch resolves {enabled: false, reason: "OPENAI_API_KEY is not set"}
  render(<Settings />);
  expect(await screen.findByText(/OPENAI_API_KEY is not set/)).toBeInTheDocument();
});

it("stays quiet when the status fetch fails", async () => {
  // apiFetch rejects; section renders a neutral "status unavailable" line
  render(<Settings />);
  expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test:unit -- Settings`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `web/src/views/Settings.tsx`, add a small component and a second `SECTIONS` entry:

```tsx
// pattern note: file already carries Imperative Shell marker
import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

type DescribeStatus = { enabled: boolean; reason: string | null };

function ImageDescriptionsStatus() {
  const [status, setStatus] = useState<DescribeStatus | null | "error">(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<DescribeStatus>("/api/assets/describe-status")
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, []);
  if (status === null) return <p className="settings-note">Checking…</p>;
  if (status === "error") {
    return <p className="settings-note">Status unavailable.</p>;
  }
  return (
    <p className="settings-note">
      {status.enabled
        ? "Image descriptions: enabled. Uploaded images are described by an LLM to make them searchable."
        : `Image descriptions: disabled — ${status.reason}`}
    </p>
  );
}
```

New `SECTIONS` entry after "export":

```tsx
  {
    id: "image-descriptions",
    title: "Image descriptions",
    body: <ImageDescriptionsStatus />,
  },
```

If the generated types (`web/src/api/types.d.ts`) expose the payload and `payloads.ts` re-exports siblings like `SearchPayload`, use the generated type instead of the local `DescribeStatus` alias — match the pattern found in Step 1's reading.

- [ ] **Step 4: Run the web verification**

Run: `cd web && pnpm verify`
Expected: PASS (typecheck, unit coverage, Playwright E2E). E2E runs against a server without `OPENAI_API_KEY`, so `/settings` will show the disabled line — no E2E spec change needed, but if an existing settings E2E asserts the page's exact section list, update it.

- [ ] **Step 5: Commit**

```bash
git add web/src/views/Settings.tsx web/src/views/Settings.test.tsx
git commit -m "feat(web): image-descriptions status section on /settings (pkm-zc0c)"
```

---

### Task 10: Docs, full verification, bean completion

**Files:**
- Modify: `docs/architecture/backend.md` (route table, ~lines 255-272; describe package)
- Modify: `.beans/pkm-zc0c--image-descriptions-for-uploaded-assets.md`

- [ ] **Step 1: Update backend docs**

Add the three routes to the route table in `docs/architecture/backend.md` and a short "Image descriptions (pkm-zc0c)" paragraph next to the assistant section covering: the `describe/` package layout, `OPENAI_API_KEY` + `image_descriptions`/`image_description_model` config keys, the in-memory queue (restart ⇒ rescan), and that descriptions are v1-searchable only via `/api/assets/search` (not main FTS).

- [ ] **Step 2: Full verification (all gates from CLAUDE.md)**

```bash
cd server && uv run pytest -q          # coverage ≥95 enforced
cd server && uv run pyrefly check
cd server && uv run ruff check
cd web && pnpm verify
```

Expected: all PASS. Fix anything that fails before proceeding.

- [ ] **Step 3: Update the bean and commit**

Check off the bean's checklist, add a `## Summary of Changes` section, then:

```bash
git add docs/architecture/backend.md .beans/pkm-zc0c--image-descriptions-for-uploaded-assets.md
git commit -m "docs: backend notes for image descriptions; complete pkm-zc0c"
```

- [ ] **Step 4: Manual live smoke (before/with deploy — needs the real key)**

Not automatable in CI (lesson from pkm-wn2s: fake-based CI can't catch provider-contract drift). From the branch, run a local server on a port ≠ 8974 (prod owns 8974) with `OPENAI_API_KEY` set, upload a real graph/diagram PNG, and verify: `pkm assets search <term from the image>` finds it, `/settings` shows enabled, and `POST /api/assets/scan` on a copy of the prod DB describes a backlog batch without tripping rate limits (sequential worker should be fine). Record the outcome in the bean before merge.

---

## Explicitly out of scope (do not implement)

- PDFs (follow-up bean under the epic when wanted).
- `assets_fts` / main `/api/search` integration / offline replica search parity.
- Ollama or a second provider (the `ImageDescriber` protocol is the seam).
- Image downscaling (no Pillow).
- File browser UI, including the scan button — pkm-jdu3.
