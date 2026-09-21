# Local Document Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Local copy::` values clickable by serving files from a configured on-disk root through an authenticated route, with an inline PDF viewer, a clear "not downloaded" state, and a link-health check.

**Architecture:** A new Functional Core module `local_docs.py` decides path safety, disposition and link shapes; a new Imperative Shell router `routes_local.py` stats files under `Config.local_docs_root` and serves them. The web app widens its existing "this link is a PDF" rule to the new URL prefix so the current viewer does the rest. A `pkm local check` CLI verb reports links whose file is missing or iCloud-evicted.

**Tech Stack:** FastAPI + `FileResponse`, pydantic contracts, argparse CLI, React + react-pdf, vitest, pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-local-docs-links-design.md`

## Global Constraints

- Every runtime file declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top (CLAUDE.md FCIS rule). `pnpm check:fcis` enforces it on the web side.
- Server coverage gate: `--cov-fail-under=95` (`server/pyproject.toml`). Web coverage gate: statements 95, branches 91, functions 89, lines 95 (`web/vite.config.ts`).
- Any route or response-model change requires regenerating `web/src/api/openapi.json` (`cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`) and `cd web && pnpm gen-types`, and committing both. `server/tests/test_openapi_sync.py` fails otherwise.
- Every GET route must declare a `response_model` from `pkm.contracts.responses`, or be listed in `EXEMPT_READ_ROUTES` in `test_openapi_sync.py` (only for binary/non-JSON responses).
- Block text format for a local link, verbatim from the spec: `Local copy:: [<basename>](/api/local/<percent-encoded rel>)`, encoded with `urllib.parse.quote(rel, safe="/")`.
- URL prefix: `/api/local/`. Reserved operator path: `/api/local/check`, registered before the catch-all.
- 404 for every path-safety failure (never 403). 503 with `Retry-After: 5` only when a `.<name>.icloud` stub exists beside the missing file.
- Inline extensions: `.pdf .png .jpg .jpeg .gif .webp`. Everything else is `attachment`. Always `X-Content-Type-Options: nosniff`. `Cache-Control: private, max-age=0, must-revalidate`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and never carry a `Claude-Session:` trailer (`.githooks/commit-msg` enforces it; commit with `git -c core.hooksPath=.githooks commit`).
- Work happens in the worktree `/Users/arthur/code/llm/pkm/.claude/worktrees/local-docs` on branch `worktree-local-docs`. Run `git status -sb` before every commit and confirm the branch.
- Bean: `pkm-g1ep`. Tick its checklist items as tasks complete and include `.beans/` in commits.

---

## File structure

| Path | Role | Responsibility |
|---|---|---|
| `server/src/pkm/server/config.py` | Shell (modify) | `local_docs_root: Path \| None` |
| `server/src/pkm/local_docs.py` | Core (create) | Path resolution and containment decision, disposition by extension, link builder, href extractor |
| `server/src/pkm/server/routes_local.py` | Shell (create) | `GET /api/local/check`, `GET /api/local/{path:path}` |
| `server/src/pkm/server/app.py` | Shell (modify) | include the router |
| `server/src/pkm/contracts/responses.py` | Core (modify) | `LocalCheckPayload`, `LocalCheckProblem` |
| `server/src/pkm/client/api.py` | Shell (modify) | `PkmClient.local_check()` |
| `server/src/pkm/render.py` | Core (modify) | `render_local_check()` |
| `server/src/pkm/cli/main.py` | Shell (modify) | `pkm local check` |
| `server/tests/test_local_docs.py` | test (create) | core tests |
| `server/tests/test_routes_local.py` | test (create) | route tests |
| `server/tests/test_config.py`, `test_cli_main_read.py`, `test_openapi_sync.py` | test (modify) | |
| `server/tests/e2e_serve.py` | Shell (modify) | temp `local_docs_root` with `sample.pdf` |
| `web/src/components/InlineSegments.tsx` | Shell (modify) | `isPdfHref` covers `/api/local/` |
| `web/src/components/pdfViewerCore.ts` | Core (modify) | `failureNote(err)` |
| `web/src/components/PdfViewer.tsx` | Shell (modify) | use `failureNote` |
| `web/e2e/local-docs.spec.ts` | test (create) | click-through |
| `web/src/api/openapi.json`, `web/src/api/types.d.ts` | generated | regen |
| `docs/architecture/{backend,frontend,sync-and-offline,cli-and-mcp}.md`, `.claude/skills/pkm/SKILL.md` | docs (modify) | |

---

### Task 1: `local_docs_root` config key

**Files:**
- Modify: `server/src/pkm/server/config.py`
- Test: `server/tests/test_config.py`

**Interfaces:**
- Produces: `Config.local_docs_root: Path | None` (default `None`). Relative values resolve against `config.json`'s directory; absolute values pass through unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_config.py`:

```python
def test_local_docs_root_default_is_none(tmp_path):
    cfg = load_config(write_config(tmp_path, {}))
    assert cfg.local_docs_root is None


def test_local_docs_root_relative_resolves_against_config_dir(tmp_path):
    cfg = load_config(write_config(tmp_path, {"local_docs_root": "docs"}))
    assert cfg.local_docs_root == tmp_path / "docs"


def test_local_docs_root_absolute_passes_through(tmp_path):
    cfg = load_config(write_config(
        tmp_path, {"local_docs_root": "/Volumes/Papers/pkm"}))
    assert cfg.local_docs_root == Path("/Volumes/Papers/pkm")
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_config.py -q -p no:cacheprovider --no-cov`
Expected: 3 failures, `AttributeError: 'Config' object has no attribute 'local_docs_root'`.

- [ ] **Step 3: Implement**

In `server/src/pkm/server/config.py`, add to the dataclass after `zai_api_key_file`:

```python
    # Root of the on-disk document tree served read-only by
    # GET /api/local/{path} (see routes_local.py). None disables the
    # feature. Relative values resolve against config.json's directory
    # like every other path key; `Path / absolute` yields the absolute
    # path unchanged, so an absolute value passes through.
    local_docs_root: Path | None = None
```

In `load_config`, add before the closing paren:

```python
        local_docs_root=(base / raw["local_docs_root"]
                         if raw.get("local_docs_root") else None),
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && uv run pytest tests/test_config.py -q --no-cov`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git status -sb
git add server/src/pkm/server/config.py server/tests/test_config.py
git -c core.hooksPath=.githooks commit -m "feat(pkm-g1ep): local_docs_root config key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `local_docs.py` Functional Core

**Files:**
- Create: `server/src/pkm/local_docs.py`
- Test: `server/tests/test_local_docs.py`

**Interfaces:**
- Produces:
  - `LOCAL_PREFIX = "/api/local/"`
  - `resolve_relative(url_path: str) -> str | None` — percent-decodes, rejects empty / NUL / `.` / `..` segments / leading slash / backslash, collapses duplicate slashes, strips a trailing slash. Returns the cleaned relative path or `None`.
  - `disposition_for(name: str) -> Literal["inline", "attachment"]`
  - `media_type_for(name: str) -> str` — `mimetypes.guess_type` with `application/octet-stream` fallback.
  - `local_href(rel: str) -> str` — `LOCAL_PREFIX + quote(rel, safe="/")`
  - `extract_local_hrefs(text: str) -> list[str]` — every `(/api/local/...)` link target in markdown link syntax, plus bare `/api/local/...` tokens, in order, deduplicated.
  - `is_within(root: Path, candidate: Path) -> bool` — pure comparison of two already-resolved paths.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_local_docs.py`:

```python
from pathlib import Path

import pytest

from pkm.local_docs import (LOCAL_PREFIX, disposition_for, extract_local_hrefs,
                            is_within, local_href, media_type_for,
                            resolve_relative)


@pytest.mark.parametrize("raw, expected", [
    ("Papers/ML/Title.pdf", "Papers/ML/Title.pdf"),
    ("Papers/Machine%20Learning/It%27s.pdf", "Papers/Machine Learning/It's.pdf"),
    ("Papers//ML/x.pdf", "Papers/ML/x.pdf"),
    ("Papers/ML/", "Papers/ML"),
    ("caf%C3%A9/na%C3%AFve.pdf", "café/naïve.pdf"),
])
def test_resolve_relative_accepts_clean_paths(raw, expected):
    assert resolve_relative(raw) == expected


@pytest.mark.parametrize("raw", [
    "", "/", "../x.pdf", "Papers/../../etc/passwd", "Papers/%2e%2e/x.pdf",
    "Papers/./x.pdf", "/Papers/x.pdf", "Papers\\x.pdf", "Papers/x%00.pdf",
    "..", ".",
])
def test_resolve_relative_rejects_escapes(raw):
    assert resolve_relative(raw) is None


@pytest.mark.parametrize("name, kind", [
    ("a.pdf", "inline"), ("A.PDF", "inline"), ("a.png", "inline"),
    ("a.jpg", "inline"), ("a.jpeg", "inline"), ("a.gif", "inline"),
    ("a.webp", "inline"),
    ("a.zip", "attachment"), ("a.html", "attachment"), ("a.svg", "attachment"),
    ("a.epub", "attachment"), ("a.webarchive", "attachment"), ("noext", "attachment"),
])
def test_disposition_by_extension_only(name, kind):
    assert disposition_for(name) == kind


def test_media_type_falls_back_to_octet_stream():
    assert media_type_for("x.pdf") == "application/pdf"
    assert media_type_for("x.webarchive") == "application/octet-stream"
    assert media_type_for("x.svg") == "image/svg+xml"  # still an attachment


def test_local_href_percent_encodes_everything_but_slashes():
    assert local_href("Papers/Machine Learning/It's (v2).pdf") == \
        LOCAL_PREFIX + "Papers/Machine%20Learning/It%27s%20%28v2%29.pdf"


def test_extract_local_hrefs_from_markdown_links_and_bare_urls():
    text = ("Local copy:: [a.pdf](/api/local/Papers/a.pdf) and "
            "[b](/api/local/Books/b%20c.pdf) bare /api/local/x/y.zip "
            "[a again](/api/local/Papers/a.pdf) [ext](https://x.org/a.pdf)")
    assert extract_local_hrefs(text) == [
        "/api/local/Papers/a.pdf", "/api/local/Books/b%20c.pdf",
        "/api/local/x/y.zip"]


def test_extract_local_hrefs_none():
    assert extract_local_hrefs("plain text [[Page]] /assets/ab/x.pdf") == []


def test_is_within_is_a_pure_prefix_check_on_resolved_paths():
    root = Path("/r/pkm")
    assert is_within(root, Path("/r/pkm/Papers/x.pdf"))
    assert is_within(root, Path("/r/pkm"))
    assert not is_within(root, Path("/r/pkm2/x.pdf"))
    assert not is_within(root, Path("/r/other/x.pdf"))
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_local_docs.py -q --no-cov`
Expected: `ModuleNotFoundError: No module named 'pkm.local_docs'`.

- [ ] **Step 3: Implement**

Create `server/src/pkm/local_docs.py`:

```python
# pattern: Functional Core
"""Pure decisions behind GET /api/local/{path}: is a URL path a safe
relative path under the configured root, how should a file be served,
and what does the link form of a `Local copy::` value look like. No I/O
here; routes_local.py stats the filesystem and calls in.

The containment rule (`resolve_relative` + `is_within`) is the only
thing standing between an authenticated client and the rest of the
disk. Never loosen it for convenience: a path that fails here is a 404,
not a warning."""
from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from typing import Literal
from urllib.parse import quote, unquote

LOCAL_PREFIX = "/api/local/"

_INLINE_EXT = frozenset({".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"})

# `[text](/api/local/...)` targets and bare `/api/local/...` tokens. The
# link target stops at the closing paren; a bare token at whitespace or
# a closing bracket/paren.
_HREF_RE = re.compile(r"\]\((/api/local/[^)\s]+)\)|(?<![\w(])(/api/local/[^\s)\]]+)")


def resolve_relative(url_path: str) -> str | None:
    """Percent-decode `url_path` and return it as a clean relative path,
    or None if it is empty, absolute, uses backslashes, contains a NUL,
    or has any `.`/`..` segment. Duplicate slashes collapse; a trailing
    slash is dropped."""
    decoded = unquote(url_path)
    if not decoded or "\x00" in decoded or "\\" in decoded:
        return None
    if decoded.startswith("/"):
        return None
    segments = [s for s in decoded.split("/") if s != ""]
    if not segments or any(s in (".", "..") for s in segments):
        return None
    return "/".join(segments)


def disposition_for(name: str) -> Literal["inline", "attachment"]:
    return "inline" if Path(name).suffix.lower() in _INLINE_EXT else "attachment"


def media_type_for(name: str) -> str:
    guessed, _ = mimetypes.guess_type(name)
    return guessed or "application/octet-stream"


def local_href(rel: str) -> str:
    return LOCAL_PREFIX + quote(rel, safe="/")


def extract_local_hrefs(text: str) -> list[str]:
    seen: list[str] = []
    for m in _HREF_RE.finditer(text):
        href = m.group(1) or m.group(2)
        if href not in seen:
            seen.append(href)
    return seen


def is_within(root: Path, candidate: Path) -> bool:
    """True when `candidate` is `root` or below it. Both must already be
    resolved (symlinks followed) by the caller."""
    return candidate == root or root in candidate.parents
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && uv run pytest tests/test_local_docs.py -q --no-cov`
Expected: all pass. If the `%2e%2e` case fails, note that `unquote` decodes it to `..` and the segment check catches it; if `.svg` media type differs on the host, relax that one assertion to `.startswith("image/svg")`.

- [ ] **Step 5: Lint and type check**

Run: `cd server && uv run ruff check src/pkm/local_docs.py && uv run pyrefly check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git status -sb
git add server/src/pkm/local_docs.py server/tests/test_local_docs.py
git -c core.hooksPath=.githooks commit -m "feat(pkm-g1ep): local_docs core: path containment, disposition, link shapes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `GET /api/local/{path}` file route

**Files:**
- Create: `server/src/pkm/server/routes_local.py`
- Modify: `server/src/pkm/server/app.py` (include router)
- Modify: `server/tests/test_openapi_sync.py` (`EXEMPT_READ_ROUTES`)
- Test: `server/tests/test_routes_local.py`
- Modify: `server/tests/conftest.py` (a `local_root` fixture)

**Interfaces:**
- Consumes: `Config.local_docs_root` (Task 1); `resolve_relative`, `is_within`, `disposition_for`, `media_type_for` (Task 2); `require_auth`, `get_config` (existing).
- Produces: `router` in `routes_local.py`; module-level `_request_download(path: Path) -> None` that tests monkeypatch.

- [ ] **Step 1: Add a fixture**

Append to `server/tests/conftest.py`:

```python
@pytest.fixture()
def local_root(tmp_path) -> Path:
    """A throwaway local_docs_root with one PDF, one zip, one nested
    folder, and one evicted-file stub."""
    root = tmp_path / "localdocs"
    (root / "Papers" / "ML").mkdir(parents=True)
    (root / "Papers" / "ML" / "Title one.pdf").write_bytes(b"%PDF-1.4\n%fake\n")
    (root / "Papers" / "ML" / "bundle.zip").write_bytes(b"PK\x03\x04zip")
    (root / "Papers" / ".Gone.pdf.icloud").write_bytes(b"stub")
    return root


@pytest.fixture()
def local_client(seeded_config, local_root) -> TestClient:
    from dataclasses import replace
    cfg = replace(seeded_config, local_docs_root=local_root)
    c = TestClient(create_app(cfg))
    r = c.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    return c
```

Add `from pathlib import Path` to the conftest imports.

- [ ] **Step 2: Write the failing route tests**

Create `server/tests/test_routes_local.py`:

```python
import os
from dataclasses import replace

from fastapi.testclient import TestClient

from pkm.server import routes_local
from pkm.server.app import create_app


def test_serves_pdf_inline_with_headers(local_client):
    r = local_client.get("/api/local/Papers/ML/Title%20one.pdf")
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF")
    assert r.headers["content-type"].startswith("application/pdf")
    assert r.headers["content-disposition"].startswith("inline")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "private, max-age=0, must-revalidate"


def test_serves_zip_as_attachment(local_client):
    r = local_client.get("/api/local/Papers/ML/bundle.zip")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("attachment")


def test_missing_file_is_404(local_client):
    assert local_client.get("/api/local/Papers/ML/nope.pdf").status_code == 404


def test_directory_is_404(local_client):
    assert local_client.get("/api/local/Papers/ML").status_code == 404
    assert local_client.get("/api/local/Papers/ML/").status_code == 404


def test_traversal_is_404_raw_and_encoded(local_client, local_root):
    outside = local_root.parent / "secret.txt"
    outside.write_text("no")
    assert local_client.get("/api/local/../secret.txt").status_code == 404
    assert local_client.get("/api/local/Papers/%2e%2e/%2e%2e/secret.txt").status_code == 404
    assert local_client.get("/api/local/Papers/..%2f..%2fsecret.txt").status_code == 404


def test_symlink_out_of_root_is_404(local_client, local_root):
    outside = local_root.parent / "secret.pdf"
    outside.write_bytes(b"%PDF")
    os.symlink(outside, local_root / "Papers" / "link.pdf")
    assert local_client.get("/api/local/Papers/link.pdf").status_code == 404


def test_evicted_file_is_503_and_requests_download(local_client, local_root, monkeypatch):
    asked = []
    monkeypatch.setattr(routes_local, "_request_download", lambda p: asked.append(p))
    r = local_client.get("/api/local/Papers/Gone.pdf")
    assert r.status_code == 503
    assert r.headers["retry-after"] == "5"
    assert r.json() == {"detail": "not downloaded on the host", "path": "Papers/Gone.pdf"}
    assert asked == [local_root / "Papers" / "Gone.pdf"]


def test_request_download_swallows_missing_brctl(monkeypatch, tmp_path):
    monkeypatch.setattr(routes_local.subprocess, "run",
                        lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()))
    routes_local._request_download(tmp_path / "x.pdf")  # must not raise


def test_disabled_when_root_unset(client):
    assert client.get("/api/local/Papers/ML/Title%20one.pdf").status_code == 404


def test_requires_auth(seeded_config, local_root):
    anon = TestClient(create_app(replace(seeded_config, local_docs_root=local_root)))
    assert anon.get("/api/local/Papers/ML/Title%20one.pdf").status_code == 401
```

Fixtures come from `conftest.py` automatically.

- [ ] **Step 3: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_routes_local.py -q --no-cov`
Expected: `ImportError: cannot import name 'routes_local'`.

- [ ] **Step 4: Implement the router**

Create `server/src/pkm/server/routes_local.py`:

```python
# pattern: Imperative Shell
"""Serve files from Config.local_docs_root read-only (pkm-g1ep). This is
the one route that reads outside the data dir, so the containment
check in local_docs.py is load-bearing: anything it rejects is a 404,
and a resolved path that is not under the resolved root (a symlink out,
say) is a 404 too. Never a 403: the response must not confirm what
exists.

iCloud can evict a file, leaving only a `.Name.ext.icloud` stub. That
case is a 503 with Retry-After, after a best-effort `brctl download` so
the next click usually succeeds."""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from pkm.local_docs import (disposition_for, is_within, media_type_for,
                            resolve_relative)
from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config

router = APIRouter(dependencies=[Depends(require_auth)])
logger = logging.getLogger("pkm.local")

_NOT_FOUND = HTTPException(status_code=404, detail="not found")


def _request_download(path: Path) -> None:
    """Ask iCloud to materialise an evicted file. Best effort: a missing
    brctl, a non-zero exit, or a timeout are all logged and ignored."""
    try:
        subprocess.run(["brctl", "download", str(path)], check=False,
                       timeout=2, capture_output=True)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        logger.info("brctl download skipped for %s: %s", path, e)


def _locate(config: Config, url_path: str) -> tuple[Path, Path, str]:
    """(root, unresolved candidate, rel) or raise 404. Does no stat."""
    if config.local_docs_root is None:
        raise _NOT_FOUND
    rel = resolve_relative(url_path)
    if rel is None:
        raise _NOT_FOUND
    root = config.local_docs_root.resolve()
    return root, root / rel, rel


@router.get("/api/local/{path:path}")
def get_local_file(path: str,
                   config: Config = Depends(get_config)) -> FileResponse:
    root, candidate, rel = _locate(config, path)
    stub = candidate.parent / f".{candidate.name}.icloud"
    if not candidate.exists() and stub.is_file() and is_within(root, stub.resolve()):
        _request_download(candidate)
        return JSONResponse(  # type: ignore[return-value]
            status_code=503, headers={"Retry-After": "5"},
            content={"detail": "not downloaded on the host", "path": rel})
    resolved = candidate.resolve()
    if not is_within(root, resolved) or not resolved.is_file():
        raise _NOT_FOUND
    return FileResponse(
        resolved, media_type=media_type_for(resolved.name),
        filename=resolved.name,
        content_disposition_type=disposition_for(resolved.name),
        headers={"Cache-Control": "private, max-age=0, must-revalidate",
                 "X-Content-Type-Options": "nosniff"})
```

If pyrefly objects to the `JSONResponse` return, change the annotation to `-> Response` (import `Response` from `fastapi`) and drop the ignore.

In `server/src/pkm/server/app.py`, add the import alongside the others:

```python
from pkm.server.routes_local import router as local_router
```

and after `app.include_router(assets_router)`:

```python
    app.include_router(local_router)
```

In `server/tests/test_openapi_sync.py`, add `"/api/local/{path}"` to `EXEMPT_READ_ROUTES` with a comment `# local document bytes (pkm-g1ep)`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd server && uv run pytest tests/test_routes_local.py tests/test_openapi_sync.py -q --no-cov`
Expected: route tests pass; `test_openapi_sync` fails only on the committed `openapi.json` being stale (fixed in Task 4 when the check route also lands). If it fails for any other reason, fix it now.

- [ ] **Step 6: Lint and type check**

Run: `cd server && uv run ruff check && uv run pyrefly check`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git status -sb
git add server/src/pkm/server/routes_local.py server/src/pkm/server/app.py server/tests/test_routes_local.py server/tests/conftest.py server/tests/test_openapi_sync.py
git -c core.hooksPath=.githooks commit -m "feat(pkm-g1ep): GET /api/local/{path} serves files under local_docs_root

Contained to the configured root, inline for PDF/images, 503 with
Retry-After for iCloud-evicted files after a best-effort brctl download.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `GET /api/local/check` and its contract

**Files:**
- Modify: `server/src/pkm/contracts/responses.py`
- Modify: `server/src/pkm/server/routes_local.py`
- Test: `server/tests/test_routes_local.py`
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`

**Interfaces:**
- Produces:

```python
class LocalCheckProblem(BaseModel):
    uid: str
    page: str
    href: str
    status: Literal["missing", "evicted", "invalid"]

class LocalCheckPayload(BaseModel):
    enabled: bool
    total: int
    ok: int
    problems: list[LocalCheckProblem]
```

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_routes_local.py`:

```python
import sqlite3


def _seed_local_links(db_path):
    con = sqlite3.connect(db_path)
    rows = [
        ("uid_l1", 1, None, 10, "Local copy:: [Title one.pdf](/api/local/Papers/ML/Title%20one.pdf)"),
        ("uid_l2", 1, None, 11, "Local copy:: [x.pdf](/api/local/Papers/ML/nope.pdf)"),
        ("uid_l3", 2, None, 10, "see /api/local/Papers/Gone.pdf and [bad](/api/local/../etc)"),
        ("uid_l4", 2, None, 11, "no local links here"),
    ]
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,NULL,0,NULL,NULL)", rows)
    con.commit()
    con.close()


def test_check_classifies_every_href(local_client, seeded_config, local_root):
    _seed_local_links(seeded_config.db_path)
    r = local_client.get("/api/local/check")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert body["total"] == 4          # four distinct hrefs across blocks
    assert body["ok"] == 1
    assert sorted((p["uid"], p["status"]) for p in body["problems"]) == [
        ("uid_l2", "missing"), ("uid_l3", "evicted"), ("uid_l3", "invalid")]
    by_uid = {(p["uid"], p["status"]): p for p in body["problems"]}
    assert by_uid[("uid_l2", "missing")]["page"] == "Machine Learning"
    assert by_uid[("uid_l3", "evicted")]["href"] == "/api/local/Papers/Gone.pdf"


def test_check_disabled_when_root_unset(client):
    r = client.get("/api/local/check")
    assert r.status_code == 200
    assert r.json() == {"enabled": False, "total": 0, "ok": 0, "problems": []}


def test_check_wins_over_a_file_named_check(local_client, local_root):
    (local_root / "check").write_bytes(b"x")
    assert local_client.get("/api/local/check").json()["enabled"] is True
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_routes_local.py -q --no-cov -k check`
Expected: `test_check_classifies_every_href` fails (404 from the catch-all), the disabled test fails, the named-file test fails.

- [ ] **Step 3: Add the contract models**

In `server/src/pkm/contracts/responses.py`, after `ScanPayload`:

```python
class LocalCheckProblem(BaseModel):
    uid: str
    page: str
    href: str
    status: Literal["missing", "evicted", "invalid"]


class LocalCheckPayload(BaseModel):
    """GET /api/local/check: every /api/local/ href found in block text,
    classified against the disk. `enabled` is False when no
    local_docs_root is configured."""
    enabled: bool
    total: int
    ok: int
    problems: list[LocalCheckProblem]
```

- [ ] **Step 4: Add the route, above the catch-all**

In `routes_local.py`, add imports:

```python
import sqlite3
from pkm.contracts.responses import LocalCheckPayload, LocalCheckProblem
from pkm.local_docs import LOCAL_PREFIX, extract_local_hrefs
from pkm.server.db import get_db
```

Insert this **before** `get_local_file` (FastAPI matches in registration order):

```python
def _classify(root: Path, href: str) -> str:
    rel = resolve_relative(href[len(LOCAL_PREFIX):])
    if rel is None:
        return "invalid"
    candidate = root / rel
    resolved = candidate.resolve()
    if is_within(root, resolved) and resolved.is_file():
        return "ok"
    stub = candidate.parent / f".{candidate.name}.icloud"
    if stub.is_file():
        return "evicted"
    return "missing"


@router.get("/api/local/check", response_model=LocalCheckPayload)
def check_local_links(db: sqlite3.Connection = Depends(get_db),
                      config: Config = Depends(get_config)) -> LocalCheckPayload:
    if config.local_docs_root is None:
        return LocalCheckPayload(enabled=False, total=0, ok=0, problems=[])
    root = config.local_docs_root.resolve()
    rows = db.execute(
        "SELECT b.uid, p.title, b.text FROM blocks b JOIN pages p ON p.id = b.page_id"
        " WHERE instr(b.text, ?) > 0 ORDER BY p.title, b.uid", (LOCAL_PREFIX,)).fetchall()
    total = ok = 0
    problems: list[LocalCheckProblem] = []
    for uid, title, text in rows:
        for href in extract_local_hrefs(text):
            total += 1
            status = _classify(root, href)
            if status == "ok":
                ok += 1
            else:
                problems.append(LocalCheckProblem(
                    uid=uid, page=title, href=href, status=status))  # type: ignore[arg-type]
    return LocalCheckPayload(enabled=True, total=total, ok=ok, problems=problems)
```

If pyrefly rejects the `status` literal, type `_classify` as returning `Literal["ok", "missing", "evicted", "invalid"]` and drop the ignore.

- [ ] **Step 5: Run to verify they pass**

Run: `cd server && uv run pytest tests/test_routes_local.py -q --no-cov`
Expected: all pass.

- [ ] **Step 6: Regenerate the OpenAPI artifacts**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
cd ../server && uv run pytest tests/test_openapi_sync.py -q --no-cov
```

Expected: pass. `git diff --stat web/src/api` shows both generated files changed.

- [ ] **Step 7: Full server verification**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: all green, coverage ≥ 95.

- [ ] **Step 8: Commit**

```bash
git status -sb
git add server/src/pkm/contracts/responses.py server/src/pkm/server/routes_local.py server/tests/test_routes_local.py web/src/api/openapi.json web/src/api/types.d.ts
git -c core.hooksPath=.githooks commit -m "feat(pkm-g1ep): GET /api/local/check classifies every local link against disk

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `pkm local check` CLI verb

**Files:**
- Modify: `server/src/pkm/client/api.py`
- Modify: `server/src/pkm/render.py`
- Modify: `server/src/pkm/cli/main.py`
- Test: `server/tests/test_cli_main_read.py`

**Interfaces:**
- Consumes: `LocalCheckPayload` (Task 4).
- Produces: `PkmClient.local_check() -> LocalCheckPayload`; `render_local_check(payload) -> str`; CLI exits 1 when `problems` is non-empty, 2 when `enabled` is False (message on stderr).

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_cli_main_read.py`. The shared `run`/`pkm_client` fixtures drive an app with no local root, so the first two tests build their own client against an app that has one:

```python
def test_local_check_reports_problems_and_exits_1(seeded_config, local_root, capsys):
    from dataclasses import replace
    from fastapi.testclient import TestClient
    from pkm.cli.main import main
    from pkm.client.api import PkmClient
    from pkm.client.core import CliConfig
    from pkm.server.app import create_app
    from test_routes_local import _seed_local_links

    _seed_local_links(seeded_config.db_path)
    c = TestClient(create_app(replace(seeded_config, local_docs_root=local_root)))
    assert c.post("/api/login", json={"password": "test-pw"}).status_code == 200
    token = c.cookies["pkm_session"]
    c.cookies.clear()
    client = PkmClient(CliConfig(url="http://testserver", token=token), http=c)

    code = main(["local", "check"], make_client=lambda: client)
    out, err = capsys.readouterr()
    assert code == 1
    assert out.startswith("4 local link(s), 1 ok, 3 problem(s)\n")
    assert "Machine Learning | missing | /api/local/Papers/ML/nope.pdf\n" in out
    assert "AI | evicted | /api/local/Papers/Gone.pdf\n" in out
    assert "AI | invalid | /api/local/../etc\n" in out
    assert err == ""


def test_local_check_clean_exits_0(seeded_config, local_root, capsys):
    from dataclasses import replace
    from fastapi.testclient import TestClient
    from pkm.cli.main import main
    from pkm.client.api import PkmClient
    from pkm.client.core import CliConfig
    from pkm.server.app import create_app

    c = TestClient(create_app(replace(seeded_config, local_docs_root=local_root)))
    assert c.post("/api/login", json={"password": "test-pw"}).status_code == 200
    token = c.cookies["pkm_session"]
    c.cookies.clear()
    client = PkmClient(CliConfig(url="http://testserver", token=token), http=c)

    code = main(["local", "check"], make_client=lambda: client)
    out, _ = capsys.readouterr()
    assert code == 0
    assert out == "0 local link(s), 0 ok, 0 problem(s)\n"


def test_local_check_disabled_exits_2(run):
    code, out, err = run("local", "check")
    assert code == 2
    assert out == ""
    assert "local_docs_root" in err


def test_local_check_json(run):
    code, out, _ = run("local", "check", "--json")
    assert code == 2
    assert json.loads(out) == {"enabled": False, "total": 0, "ok": 0, "problems": []}
```

`test_routes_local` is importable because `server/tests` is on the pytest path (the conftest's `from fake_engine import FakeEngine` relies on the same).

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_cli_main_read.py -q --no-cov -k local_check`
Expected: argparse error `invalid choice: 'local'` → SystemExit 2 in all four; the assertions on output fail.

- [ ] **Step 3: Client method**

In `server/src/pkm/client/api.py`, add `LocalCheckPayload` to the `pkm.contracts.responses` import, and after `scan_assets`:

```python
    def local_check(self) -> LocalCheckPayload:
        return self._request("GET", "/api/local/check", LocalCheckPayload)
```

- [ ] **Step 4: Renderer**

In `server/src/pkm/render.py`, import `LocalCheckPayload` and add after `render_assets`:

```python
def render_local_check(payload: LocalCheckPayload) -> str:
    """One summary line, then `page | status | href` per problem."""
    lines = [f"{payload.total} local link(s), {payload.ok} ok,"
             f" {len(payload.problems)} problem(s)"]
    lines += [f"{p.page} | {p.status} | {p.href}" for p in payload.problems]
    return "\n".join(lines)
```

- [ ] **Step 5: CLI verb**

In `server/src/pkm/cli/main.py`:

Import `render_local_check` in the `from pkm.render import (...)` list.

Add an epilog near the other epilogs:

```python
_LOCAL_EPILOG = """\
examples:
  # list Local copy:: links whose file is missing or not downloaded
  pkm local check
  pkm local check --json

exit status: 0 clean, 1 problems found, 2 local files not configured
"""
```

Add the handler after `cmd_assets`:

```python
def cmd_local(args: argparse.Namespace, client: PkmClient) -> int:
    payload = client.local_check()
    if args.json:
        print(payload.model_dump_json())
    if not payload.enabled:
        print("local files are not configured on the server"
              " (set local_docs_root in config.json)", file=sys.stderr)
        return 2
    if not args.json:
        print(render_local_check(payload))
    return 1 if payload.problems else 0
```

In `build_parser`, after the `assets` verb:

```python
    p = _add("local", "check Local copy:: links against the server's disk",
             _LOCAL_EPILOG)
    sub_local = p.add_subparsers(dest="local_action", required=True)
    sp = sub_local.add_parser("check", help="report missing/evicted local files")
    _common(sp)
```

Add `"local": cmd_local` to `_HANDLERS`.

- [ ] **Step 6: Run to verify they pass**

Run: `cd server && uv run pytest tests/test_cli_main_read.py tests/test_cli_help.py -q --no-cov`
Expected: pass. If `test_cli_help.py` enumerates verbs and fails, add `local` where it lists them.

- [ ] **Step 7: Full server verification and commit**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`

```bash
git status -sb
git add server/src/pkm/client/api.py server/src/pkm/render.py server/src/pkm/cli/main.py server/tests/test_cli_main_read.py server/tests/test_cli_help.py
git -c core.hooksPath=.githooks commit -m "feat(pkm-g1ep): pkm local check lists missing or evicted local links

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Frontend: inline viewer for `/api/local/*.pdf` and the 503 note

**Files:**
- Modify: `web/src/components/InlineSegments.tsx`
- Modify: `web/src/components/pdfViewerCore.ts`
- Modify: `web/src/components/PdfViewer.tsx`
- Test: `web/src/components/InlineSegments.test.tsx`, `web/src/components/pdfViewerCore.test.ts`

**Interfaces:**
- Produces: `isPdfHref(href: string): boolean` (renamed from `isPdfAssetHref`, still module-private); `failureNote(err: unknown): string` in `pdfViewerCore.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/components/InlineSegments.test.tsx`:

```tsx
it("renders pdf embeds for /api/local/*.pdf links and plain anchors for other local files", async () => {
  renderText(
    "Local copy:: [Title.pdf](/api/local/Papers/Machine%20Learning/Title.pdf) " +
    "[bundle.zip](/api/local/Papers/bundle.zip)");
  expect(screen.getByRole("link", { name: "Title.pdf" }))
    .toHaveAttribute("href", "/api/local/Papers/Machine%20Learning/Title.pdf");
  await waitFor(() =>
    expect(screen.getByTestId("pdf-viewer"))
      .toHaveAttribute("data-href", "/api/local/Papers/Machine%20Learning/Title.pdf"));
  const zip = screen.getByRole("link", { name: "bundle.zip" });
  expect(zip).toHaveAttribute("href", "/api/local/Papers/bundle.zip");
  expect(zip).toHaveAttribute("target", "_blank");
  expect(screen.getByText("Local copy")).toHaveClass("attribute");
});

it("does not treat a query-string pdf as an embed", () => {
  renderText("[x](/api/local/Papers/a.pdf?dl=1)");
  expect(screen.queryByTestId("pdf-viewer")).toBeNull();
});
```

Check `screen.getByText("Local copy")` against how the attribute span renders (line ~68 of `InlineSegments.tsx`); if the span text includes `::`, assert with a regex `/Local copy/`.

Append to `web/src/components/pdfViewerCore.test.ts` (create it if it does not exist, importing from `./pdfViewerCore`):

```ts
import { describe, expect, it } from "vitest";
import { failureNote } from "./pdfViewerCore";

describe("failureNote", () => {
  it("names the iCloud-evicted case on a 503", () => {
    expect(failureNote({ status: 503 })).toBe("Not downloaded on the host.");
  });
  it("falls back to the generic note otherwise", () => {
    expect(failureNote({ status: 404 })).toBe("Couldn't render this PDF.");
    expect(failureNote(new Error("boom"))).toBe("Couldn't render this PDF.");
    expect(failureNote(undefined)).toBe("Couldn't render this PDF.");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && pnpm vitest run src/components/InlineSegments.test.tsx src/components/pdfViewerCore.test.ts`
Expected: the local-pdf test fails (no `pdf-viewer` test id appears); `failureNote` is not exported.

- [ ] **Step 3: Implement**

In `web/src/components/InlineSegments.tsx`, replace `isPdfAssetHref`:

```ts
/** PDFs the in-app viewer can fetch same-origin: content-addressed assets
 * and files served from the configured local document root (pkm-g1ep).
 * Path only: a query string means a download intent, not an embed. */
function isPdfHref(href: string): boolean {
  if (!href.startsWith("/assets/") && !href.startsWith("/api/local/")) return false;
  return href.toLowerCase().endsWith(".pdf");
}
```

Rename both call sites (`case "bare-url"` and `case "link"`) and the header comment from `isPdfAssetHref` to `isPdfHref`.

In `web/src/components/pdfViewerCore.ts`, add:

```ts
/** Fallback note for a document that failed to load. pdf.js surfaces an
 * HTTP failure as an error carrying `status`; 503 is the server's
 * "iCloud has not downloaded this file on the host" signal (pkm-g1ep). */
export function failureNote(err: unknown): string {
  const status = typeof err === "object" && err !== null && "status" in err
    ? (err as { status?: unknown }).status
    : undefined;
  return status === 503 ? "Not downloaded on the host." : "Couldn't render this PDF.";
}
```

In `web/src/components/PdfViewer.tsx`:
- import `failureNote` from `./pdfViewerCore`;
- change `const [failed, setFailed] = useState(false)` (find the actual declaration) to `const [failure, setFailure] = useState<string | null>(null)`;
- `onLoadError = (err: unknown) => { if (gen !== genRef.current) return; setFailure(failureNote(err)); }`;
- wherever `failed` is read, use `failure !== null`, and pass `note={failure}` to both `PdfFallbackLink` renders instead of the literal string;
- wherever `setFailed(false)` resets on href change, use `setFailure(null)`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && pnpm vitest run src/components && pnpm typecheck && pnpm lint && pnpm check:fcis`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git status -sb
git add web/src/components/InlineSegments.tsx web/src/components/InlineSegments.test.tsx web/src/components/pdfViewerCore.ts web/src/components/pdfViewerCore.test.ts web/src/components/PdfViewer.tsx
git -c core.hooksPath=.githooks commit -m "feat(pkm-g1ep): inline viewer for /api/local/*.pdf, evicted-file note on 503

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: E2E: click a local PDF

**Files:**
- Modify: `server/tests/e2e_serve.py`
- Create: `web/e2e/local-docs.spec.ts`

**Interfaces:**
- Consumes: the e2e server on port 8975 with password `e2e-pw`; `test-data/assets/sample.pdf` (3 pages).
- Produces: e2e `local_docs_root` = `<tempdir>/local` containing `Papers/sample.pdf` and `Papers/notes.zip`.

- [ ] **Step 1: Give the e2e server a local root**

In `server/tests/e2e_serve.py`, after `(data / "assets").mkdir()`:

```python
    # A tiny local document root so web/e2e/local-docs.spec.ts can click a
    # Local copy:: link end to end (pkm-g1ep).
    local_root = data / "local" / "Papers"
    local_root.mkdir(parents=True)
    shutil.copy(root / "test-data" / "assets" / "sample.pdf", local_root / "sample.pdf")
    (local_root / "notes.zip").write_bytes(b"PK\x03\x04e2e")
```

and add `local_docs_root=data / "local",` to the `Config(...)` call.

- [ ] **Step 2: Write the spec**

Create `web/e2e/local-docs.spec.ts`:

```ts
// A Local copy:: value written as a link to /api/local/... renders the
// in-app PDF viewer, and a non-PDF local link stays a plain new-tab
// anchor (pkm-g1ep). Uses its own page so it never touches the journal.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
}

const input = (page: Page) => page.locator("textarea.block-input");

test("local pdf link embeds the viewer; local zip link is a plain anchor", async ({ page }) => {
  await login(page);
  await page.goto("/page/Local%20Docs%20E2E");

  await page.getByText("Click to start writing…").click();
  await input(page).fill("Local copy:: [sample.pdf](/api/local/Papers/sample.pdf)");
  await input(page).press("Enter");
  await input(page).fill("Local copy:: [notes.zip](/api/local/Papers/notes.zip)");
  await input(page).press("Escape");

  await expect(page.locator(".pdf-frame")).toBeVisible();
  await expect(page.locator(".pdf-page-indicator")).toHaveText("Page 1 of 3");

  const zip = page.getByRole("link", { name: "notes.zip" });
  await expect(zip).toHaveAttribute("href", "/api/local/Papers/notes.zip");
  await expect(zip).toHaveAttribute("target", "_blank");

  // the file itself is served with the expected headers
  const res = await page.request.get("/api/local/Papers/notes.zip");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("attachment");
});

test("a missing local file is a 404, not a 500", async ({ page }) => {
  await login(page);
  const res = await page.request.get("/api/local/Papers/nope.pdf");
  expect(res.status()).toBe(404);
});
```

If the empty-page placeholder text differs from `Click to start writing…`, copy the exact string from `web/e2e/pdf.spec.ts` (it uses the same one for the journal) or from the page view component.

- [ ] **Step 3: Run the spec**

Run: `cd web && pnpm build && node tooling/runPlaywright.mjs e2e/local-docs.spec.ts`
Expected: both tests pass. A 5xx anywhere fails the run via `fixtures.ts`.

- [ ] **Step 4: Full web verification**

Run: `cd web && pnpm verify`
Expected: green, including coverage thresholds and the whole e2e suite.

- [ ] **Step 5: Commit**

```bash
git status -sb
git add server/tests/e2e_serve.py web/e2e/local-docs.spec.ts
git -c core.hooksPath=.githooks commit -m "test(pkm-g1ep): e2e click-through for local document links

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Architecture docs and the pkm skill

**Files:**
- Modify: `docs/architecture/backend.md`, `docs/architecture/frontend.md`, `docs/architecture/sync-and-offline.md`, `docs/architecture/cli-and-mcp.md`, `.claude/skills/pkm/SKILL.md`
- Modify: `.beans/pkm-g1ep-*.md`

Invoke the `architecture-docs` skill before editing (CLAUDE.md requires it). Verify every claim against the code as it now is, not this plan.

- [ ] **Step 1: `backend.md`**

  - Module tree (around line 40): add `├── local_docs.py        Core   path containment, disposition and link shapes for /api/local` next to `assets_core.py`; in the `server/` module table add `routes_local.py` to the routes row.
  - HTTP API reference, after the Assets block:

    ```
    | **Local documents** (`routes_local.py`) | | |
    | GET | `/api/local/check` | Every `/api/local/` href in block text, classified `ok` / `missing` / `evicted` / `invalid` against disk; `enabled: false` when unconfigured |
    | GET | `/api/local/{path}` | Serve one regular file under `local_docs_root` (inline for PDF/images, attachment otherwise, `nosniff`); 404 for anything outside the root, 503 + `Retry-After` for an iCloud-evicted file |
    ```
  - Config table: `| `local_docs_root` | no | Read-only document tree behind `/api/local/`; unset disables it |`.
  - Under Assets (or a new short "Local documents" subsection right after it), one paragraph: this is the only route that reads outside the data dir; `resolve_relative` + `is_within` on resolved paths is the containment line and every failure is 404; the `.icloud` stub is how eviction shows up and why the 503 exists; `check` is registered before the catch-all.

- [ ] **Step 2: `frontend.md`**

  Find the PDF-embed mention in the InlineSegments description and state that the embed rule covers two same-origin prefixes, `/assets/` and `/api/local/`, path-only; and that a 503 shows "Not downloaded on the host." via `pdfViewerCore.failureNote`.

- [ ] **Step 3: `sync-and-offline.md`**

  One line in the offline behaviour section: `/api/local/` files are online-only; the shim does not serve them, so offline the link renders as the plain download anchor.

- [ ] **Step 4: `cli-and-mcp.md`**

  Add `pkm local check` to the verb list with its exit codes (0 clean, 1 problems, 2 unconfigured). Grep the file for any verb count and update it.

- [ ] **Step 5: `.claude/skills/pkm/SKILL.md`**

  Under Read verbs add `pkm local check                 # Local copy:: links whose file is missing on the host`. Add a short "Local files" note: a `Local copy::` block is written as `Local copy:: [Name.pdf](/api/local/<folder>/<Name>.pdf)` with the path percent-encoded and relative to the server's document root; never a bare filesystem path.

- [ ] **Step 6: Bean**

  Tick the checklist in `.beans/pkm-g1ep-*.md` for every task done and add a `## Summary of Changes` section listing routes, verb, frontend rule, docs. Leave the status `in-progress` until the prod migration (Task 9) has run.

- [ ] **Step 7: Check and commit**

Run: `grep -rn "local" docs/architecture/*.md | grep -i "api/local\|local_docs\|pkm local"` and read each hit once against the code.

```bash
git status -sb
git add docs/architecture .claude/skills/pkm/SKILL.md .beans
git -c core.hooksPath=.githooks commit -m "docs(pkm-g1ep): local document route, config key, CLI verb, skill note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Merge, deploy, migrate (operator steps, no new code committed)

**Files:**
- Scratchpad only: `migrate_local_copy.py` (never committed)
- Prod: `~/.config/pkm/data/config.json`

- [ ] **Step 1: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`. Merge with `git merge --no-ff worktree-local-docs` into `main` from the main checkout, after a final `cd server && uv run pytest -q` and `cd web && pnpm verify` on the branch.

- [ ] **Step 2: Configure prod**

Add to `~/.config/pkm/data/config.json`:

```json
"local_docs_root": "/Users/arthur/Library/Mobile Documents/3L68KQB4HG~com~readdle~CommonDocuments/Documents/pkm"
```

Deploy with `~/.config/pkm/app/deploy/update.sh` only (memory: deploy-update-sh-footgun). Confirm with:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8974/api/local/check   # 401 = route live, auth on
cd /Users/arthur/code/llm/pkm && uv run --project server pkm local check           # exit 0, "0 local link(s)"
```

- [ ] **Step 3: Write the migration script in the scratchpad**

```python
# migrate_local_copy.py  (session scratchpad; not committed)
import json, os, re, sqlite3, subprocess, sys
from urllib.parse import quote
ROOT = "/Users/arthur/Library/Mobile Documents/3L68KQB4HG~com~readdle~CommonDocuments/Documents/pkm"
DB = "/Users/arthur/.config/pkm/data/pkm.sqlite3"
REPO = "/Users/arthur/code/llm/pkm"
LEGACY = re.compile(r"^Local copy:: iCloud/Documents/(?:pkm/)?(.+\.\w+)$")
apply = "--apply" in sys.argv
db = sqlite3.connect(DB)
plan, skipped = [], []
for uid, text in db.execute("SELECT uid, text FROM blocks WHERE text LIKE 'Local copy:: iCloud/Documents/%'"):
    m = LEGACY.match(text)
    if not m:
        skipped.append((uid, text, "no match")); continue
    rel = m.group(1)
    if not os.path.isfile(os.path.join(ROOT, rel)):
        skipped.append((uid, text, "missing on disk")); continue
    new = f"Local copy:: [{os.path.basename(rel)}](/api/local/{quote(rel, safe='/')})"
    plan.append({"uid": uid, "old": text, "new": new})
print(f"planned {len(plan)}, skipped {len(skipped)}")
for s in skipped: print("SKIP", *s)
for p in plan[:3]: print("EXAMPLE", p["new"])
if not apply: sys.exit(0)
for i in range(0, len(plan), 200):
    cmds = [{"command": "update", "params": {"uid": p["uid"], "text": p["new"]}} for p in plan[i:i+200]]
    r = subprocess.run(["uv", "run", "--project", "server", "pkm", "batch"], input=json.dumps(cmds),
                       text=True, capture_output=True, cwd=REPO)
    print("chunk", i // 200, r.returncode, r.stdout.strip(), r.stderr.strip()[-200:])
    if r.returncode: sys.exit(1)
```

- [ ] **Step 4: Plan, eyeball, apply, check**

```bash
python3 migrate_local_copy.py            # expect planned 563, skipped 0; read the 3 examples
python3 migrate_local_copy.py --apply    # 3 chunks, rc 0
uv run --project server pkm local check  # exit 0, "563 local link(s), 563 ok, 0 problem(s)"
```

Open one `Paper/` page on the Mac and on the iPad and click the link. The PDF should render inline; the filename is the link text; hovering shows the folder in the URL.

- [ ] **Step 5: Close the bean**

`beans update pkm-g1ep -s completed` with the summary already written in Task 8, plus a line recording the migration date and counts. Commit the bean file on `main`.

---

## Self-review

**Spec coverage.** Config key: Task 1. Path route, containment, 404/503, headers, disposition, brctl: Tasks 2 and 3. `check` route and ordering: Task 4. `pkm local check`: Task 5. Frontend rule and 503 note: Task 6. Offline fallback: unchanged code, documented in Task 8. E2E and e2e server root: Task 7. Docs and skill: Task 8. Migration as scratchpad script, prod config, deploy: Task 9. "Never 403": the shared `_NOT_FOUND` in Task 3.

**Placeholders.** None remain.

**Type consistency.** `resolve_relative`, `is_within`, `disposition_for`, `media_type_for`, `local_href`, `extract_local_hrefs`, `LOCAL_PREFIX` are named identically in Tasks 2, 3 and 4. `LocalCheckPayload`/`LocalCheckProblem` match between Tasks 4 and 5. `failureNote` and `isPdfHref` match between Task 6 tests and implementation. `_request_download` is the monkeypatch target in Task 3 tests and the function in the router.
