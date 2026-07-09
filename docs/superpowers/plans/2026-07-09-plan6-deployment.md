# Plan 6: Deployment, Backup & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the PKM app as a launchd service on the Mac mini (dual-exposed via Tailscale Serve HTTPS and a direct tailnet-IP bind), with a nightly SQLite backup + markdown/assets export into one sync-friendly directory, plus the four hardening/bugfix carry-forwards.

**Architecture:** Server gains multi-host binding and upload/serving hardening. A new `pkm.export` package renders the graph to portable markdown (functional core) and writes it plus an incremental asset mirror (imperative shell); a new `pkm.backup` CLI orchestrates the nightly job (online backup → rotation → export from the fresh snapshot → local git commit). A repo `deploy/` directory holds templated launchd plists and install/update/smoke scripts. Three small frontend fixes close known gaps.

**Tech Stack:** Python 3.12 + FastAPI + uvicorn + sqlite3 (server), React + TS + vitest (web), bash + launchd + Tailscale (deploy).

**Spec:** `docs/superpowers/specs/2026-07-09-plan6-deployment-design.md`

## Global Constraints

- Every new runtime file declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top (see CLAUDE.md FCIS section). Pure logic in core files; filesystem/DB/subprocess/clock in shell files.
- Server commands run from `server/`: `uv run pytest -q`. Web commands from `web/`: `pnpm typecheck && pnpm test -- --run`.
- Default upload cap is exactly `150 * 1024 * 1024` bytes (spec: 150 MB; live graph's largest asset is 96.7 MB).
- Default bind hosts are exactly `("127.0.0.1",)`; production adds the machine's Tailscale IP via config.
- SVG is NEVER served with `Content-Disposition: inline` (scriptable content).
- **NEVER touch live data:** do not read or write `/Users/arthur/code/llm/pkm/data/` or `~/.config/pkm/` in Tasks 1–12. All tests use `tmp_path`. Task 13 (controller-only) is the sole exception and never opens the live DB for writing.
- Subagents: do NOT claim, create, or update tasks in the session task list.
- Commit after each task with a conventional message; do not push from the worktree (the controller pushes after merge).

## File Structure

```
server/src/pkm/
  server/config.py          # MODIFY: bind_hosts, max_upload_bytes
  server/run.py             # MODIFY: multi-socket serving, repeatable --host
  server/routes_assets.py   # MODIFY: upload cap/allowlist, serving headers
  export/__init__.py        # NEW (empty)
  export/markdown.py        # NEW: FC — render page tree to markdown
  export/writer.py          # NEW: IS — write export dir + asset mirror
  backup/__init__.py        # NEW (empty)
  backup/rotation.py        # NEW: FC — retention policy
  backup/__main__.py        # NEW: IS — nightly CLI
server/tests/
  test_config.py, test_run.py, test_export_markdown.py,
  test_export_writer.py, test_rotation.py, test_backup_cli.py  # NEW
  test_asset_upload.py      # MODIFY: cap/allowlist/header tests
web/src/
  outline/useOutline.ts     # MODIFY: visibilitychange flush, doomed-op guard
  sync/SyncProvider.tsx     # MODIFY: loud default enqueue
  views/EditablePage.test.tsx  # MODIFY: two new tests
  sync/SyncProvider.test.tsx   # MODIFY: one new test
deploy/
  com.PLACEHOLDER.pkm.server.plist.template   # NEW
  com.PLACEHOLDER.pkm.backup.plist.template   # NEW
  install.sh, update.sh, smoke.sh, README.md  # NEW
```

---

### Task 1: Config — `bind_hosts` and `max_upload_bytes`

**Files:**
- Modify: `server/src/pkm/server/config.py`
- Test: `server/tests/test_config.py` (new)

**Interfaces:**
- Consumes: existing `Config` dataclass / `load_config(path: Path) -> Config`.
- Produces: `Config.bind_hosts: tuple[str, ...]` (default `("127.0.0.1",)`) and `Config.max_upload_bytes: int` (default `150 * 1024 * 1024`). Tasks 2 and 3 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_config.py
import json
from pathlib import Path

from pkm.server.config import load_config


def write_config(tmp_path: Path, extra: dict) -> Path:
    raw = {"db_file": "pkm.sqlite3", "assets_dir": "assets",
           "password_salt": "ab", "password_hash": "cd",
           "session_secret": "ef", **extra}
    p = tmp_path / "config.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    return p


def test_bind_and_upload_defaults(tmp_path):
    c = load_config(write_config(tmp_path, {}))
    assert c.bind_hosts == ("127.0.0.1",)
    assert c.max_upload_bytes == 150 * 1024 * 1024


def test_bind_and_upload_explicit(tmp_path):
    c = load_config(write_config(tmp_path, {
        "bind_hosts": ["127.0.0.1", "100.104.1.2"],
        "max_upload_bytes": 1024,
    }))
    assert c.bind_hosts == ("127.0.0.1", "100.104.1.2")
    assert c.max_upload_bytes == 1024
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_config.py -v`
Expected: FAIL — `Config` has no attribute `bind_hosts`.

- [ ] **Step 3: Implement**

In `server/src/pkm/server/config.py`, add two fields to the dataclass (after `web_dist`):

```python
    bind_hosts: tuple[str, ...] = ("127.0.0.1",)
    max_upload_bytes: int = 150 * 1024 * 1024
```

and in `load_config`, add to the `Config(...)` call:

```python
        bind_hosts=tuple(raw.get("bind_hosts", ["127.0.0.1"])),
        max_upload_bytes=int(raw.get("max_upload_bytes", 150 * 1024 * 1024)),
```

- [ ] **Step 4: Run the full server suite**

Run: `cd server && uv run pytest -q`
Expected: all pass (existing `Config(...)` call sites use keywords; new fields have defaults).

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/config.py server/tests/test_config.py
git commit -m "feat(server): bind_hosts and max_upload_bytes config"
```

---

### Task 2: Multi-host serving

**Files:**
- Modify: `server/src/pkm/server/run.py`
- Test: `server/tests/test_run.py` (new)

**Interfaces:**
- Consumes: `Config.bind_hosts` (Task 1).
- Produces: `bind_sockets(hosts: list[str], port: int) -> list[socket.socket]` in `pkm.server.run`; CLI flag `--host` (repeatable, overrides config). Task 12's plists just run `python -m pkm.server.run` with no `--host` (config drives binding).

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_run.py
import socket

import pytest

from pkm.server.run import bind_sockets


def test_bind_sockets_binds_each_host():
    socks = bind_sockets(["127.0.0.1"], 0)
    try:
        assert len(socks) == 1
        host, port = socks[0].getsockname()
        assert host == "127.0.0.1" and port > 0
    finally:
        for s in socks:
            s.close()


def test_bind_failure_releases_partial_binds():
    tmp = socket.socket()
    tmp.bind(("127.0.0.1", 0))
    port = tmp.getsockname()[1]
    tmp.close()
    # second bind to the same host:port collides; the first must be released
    with pytest.raises(OSError):
        bind_sockets(["127.0.0.1", "127.0.0.1"], port)
    s = socket.socket()
    s.bind(("127.0.0.1", port))  # would EADDRINUSE if the first bind leaked
    s.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_run.py -v`
Expected: FAIL — `bind_sockets` not defined.

- [ ] **Step 3: Implement**

Replace `server/src/pkm/server/run.py` with:

```python
# pattern: Imperative Shell
"""Run the PKM server: python -m pkm.server.run --data-dir ../data

Binds every host in config `bind_hosts` (or repeated --host flags) on one
port — deployment listens on 127.0.0.1 (Tailscale Serve's proxy target)
plus the machine's Tailscale IP for direct tailnet clients."""
from __future__ import annotations

import argparse
import socket
from pathlib import Path

import uvicorn

from pkm.server.app import create_app
from pkm.server.config import load_config


def bind_sockets(hosts: list[str], port: int) -> list[socket.socket]:
    """One bound (not yet listening) socket per host, all on `port`.
    On any failure, close everything already bound and re-raise — launchd
    KeepAlive retries until e.g. the Tailscale IP becomes bindable."""
    socks: list[socket.socket] = []
    try:
        for host in hosts:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
            socks.append(s)
    except OSError:
        for s in socks:
            s.close()
        raise
    return socks


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the PKM server.")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--port", type=int, default=8974)
    ap.add_argument("--host", action="append", dest="hosts", default=None,
                    help="repeatable; overrides config bind_hosts")
    args = ap.parse_args(argv)
    config = load_config(Path(args.data_dir) / "config.json")
    hosts = args.hosts if args.hosts else list(config.bind_hosts)
    sockets = bind_sockets(hosts, args.port)
    server = uvicorn.Server(uvicorn.Config(create_app(config), port=args.port))
    server.run(sockets=sockets)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_run.py -v`
Expected: PASS.

- [ ] **Step 5: Live check that uvicorn accepts pre-bound sockets**

`uvicorn.Server.run(sockets=...)` is the documented multiprocess path, but prove it in this repo:

```bash
cd server
uv run python - <<'PY'
import threading, time, urllib.request
from pkm.server.run import bind_sockets, main
import pkm.server.run as run
# fabricate a minimal data dir
import json, sqlite3, tempfile, pathlib
from pkm.schema import DDL
from pkm.server.auth_core import hash_password
d = pathlib.Path(tempfile.mkdtemp())
con = sqlite3.connect(d / "pkm.sqlite3"); con.executescript(DDL); con.close()
(d / "assets").mkdir()
(d / "config.json").write_text(json.dumps({
    "db_file": "pkm.sqlite3", "assets_dir": "assets",
    "password_salt": "11" * 16,
    "password_hash": hash_password("x", bytes.fromhex("11" * 16)),
    "session_secret": "ee" * 32, "cookie_secure": False}))
t = threading.Thread(target=main, args=(["--data-dir", str(d), "--port", "8199"],), daemon=True)
t.start(); time.sleep(2)
print(urllib.request.urlopen("http://127.0.0.1:8199/healthz").read())
PY
```

Expected: prints `b'{"ok":true}'`. If uvicorn rejects the sockets kwarg, stop and re-plan (do not work around silently).

- [ ] **Step 6: Full suite + commit**

```bash
cd server && uv run pytest -q
git add server/src/pkm/server/run.py server/tests/test_run.py
git commit -m "feat(server): multi-host socket binding for deployment"
```

---

### Task 3: Upload hardening — size cap + mime allowlist

**Files:**
- Modify: `server/src/pkm/server/routes_assets.py`
- Test: `server/tests/test_asset_upload.py`

**Interfaces:**
- Consumes: `Config.max_upload_bytes` (Task 1).
- Produces: `ALLOWED_UPLOAD_MIME: frozenset[str]` module constant in `routes_assets.py`; upload returns 413 (too large) / 415 (bad type). The web client already surfaces failed uploads by leaving text unspliced — no web change needed.

- [ ] **Step 1: Write the failing tests** (append to `server/tests/test_asset_upload.py`)

```python
from dataclasses import replace

from fastapi.testclient import TestClient

from pkm.server.app import create_app

TEST_PASSWORD = "test-pw"  # must match conftest.py


def _small_cap_client(seeded_config, cap=10):
    c = TestClient(create_app(replace(seeded_config, max_upload_bytes=cap)))
    assert c.post("/api/login", json={"password": TEST_PASSWORD}).status_code == 200
    return c


def test_upload_over_cap_413(seeded_config):
    c = _small_cap_client(seeded_config)
    assert _upload(c, content=b"x" * 11).status_code == 413


def test_upload_exactly_at_cap_ok(seeded_config):
    c = _small_cap_client(seeded_config)
    assert _upload(c, content=b"x" * 10).status_code == 200


def test_upload_disallowed_mime_415(client):
    r = _upload(client, name="evil.html", mime="text/html")
    assert r.status_code == 415


def test_upload_pdf_allowed(client):
    assert _upload(client, name="doc.pdf", mime="application/pdf").status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_asset_upload.py -v`
Expected: the four new tests FAIL (uploads currently accept anything); existing four still pass.

- [ ] **Step 3: Implement**

In `server/src/pkm/server/routes_assets.py`, add below `_SHA_RE`:

```python
# Upload allowlist (spec: images, PDF, plain text, office docs). SVG upload
# is allowed; serving forces it to download (see INLINE_MIME in Task 4).
ALLOWED_UPLOAD_MIME = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic",
    "image/svg+xml",
    "application/pdf",
    "text/plain", "text/markdown", "text/csv", "application/json",
    "application/msword", "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
})
```

In `upload_asset`, replace the body up to and including the `data = await file.read()` / empty check with:

```python
    mime = file.content_type or "application/octet-stream"
    if mime not in ALLOWED_UPLOAD_MIME:
        raise HTTPException(status_code=415,
                            detail=f"unsupported upload type {mime}")
    # read one byte past the cap: a short read proves the whole file fit
    data = await file.read(config.max_upload_bytes + 1)
    if len(data) > config.max_upload_bytes:
        raise HTTPException(status_code=413, detail="upload too large")
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
```

The `mime` local replaces the later `mime = file.content_type or ...` line — delete that one.

- [ ] **Step 4: Run tests, full suite, commit**

```bash
cd server && uv run pytest tests/test_asset_upload.py -v && uv run pytest -q
git add server/src/pkm/server/routes_assets.py server/tests/test_asset_upload.py
git commit -m "feat(server): upload size cap and mime allowlist"
```

---

### Task 4: Asset serving headers — nosniff + Content-Disposition

**Files:**
- Modify: `server/src/pkm/server/routes_assets.py` (`get_asset`)
- Test: `server/tests/test_asset_upload.py`

**Interfaces:**
- Consumes: existing `get_asset` route; starlette `FileResponse(filename=..., content_disposition_type=...)` builds the header with correct quoting/encoding.
- Produces: `INLINE_MIME: frozenset[str]` constant. Every asset response carries `X-Content-Type-Options: nosniff` and a `Content-Disposition`.

- [ ] **Step 1: Write the failing tests** (append to `server/tests/test_asset_upload.py`)

```python
def test_asset_serving_headers_inline_for_png(client):
    url = _upload(client).json()["url"]
    r = client.get(url)
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-disposition"].startswith("inline")


def test_asset_serving_svg_forced_to_attachment(client):
    url = _upload(client, content=b"<svg onload=alert(1)/>", name="a.svg",
                  mime="image/svg+xml").json()["url"]
    r = client.get(url)
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["x-content-type-options"] == "nosniff"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_asset_upload.py -v`
Expected: both new tests FAIL (no such headers today).

- [ ] **Step 3: Implement**

Add near `ALLOWED_UPLOAD_MIME`:

```python
# Safe to render in the app's origin: raster images + PDF. SVG is
# deliberately absent — it can script, so it downloads instead.
INLINE_MIME = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic",
    "application/pdf",
})
```

In `get_asset`, select the stored filename too and return with the new headers:

```python
    row = db.execute("SELECT mime, filename FROM assets WHERE sha256 = ?",
                     (sha256,)).fetchone()
    path = config.assets_dir / sha256[:2] / sha256
    if row is None or not path.is_file():
        raise HTTPException(status_code=404, detail="asset not found")
    kind = "inline" if row["mime"] in INLINE_MIME else "attachment"
    return FileResponse(
        path, media_type=row["mime"], filename=row["filename"],
        content_disposition_type=kind,
        headers={"Cache-Control": "private, max-age=31536000, immutable",
                 "X-Content-Type-Options": "nosniff"})
```

- [ ] **Step 4: Run tests, full suite, commit**

```bash
cd server && uv run pytest -q
git add server/src/pkm/server/routes_assets.py server/tests/test_asset_upload.py
git commit -m "feat(server): nosniff + content-disposition on asset serving"
```

---

### Task 5: Exporter core — markdown rendering (Functional Core)

**Files:**
- Create: `server/src/pkm/export/__init__.py` (empty), `server/src/pkm/export/markdown.py`
- Test: `server/tests/test_export_markdown.py`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (Task 6 relies on these exact signatures):
  - `render_page(title: str, tree: list[dict], uid_to_text: Mapping[str, str]) -> str` — `tree` is `pkm.server.tree.build_tree` output (dicts with `text`, `children`).
  - `page_filename(title: str, taken: set[str]) -> str` — returns a unique `*.md` name, adds its lowercase key to `taken`.
  - `safe_filename(name: str) -> str`
  - `rewrite_asset_links(text: str) -> str`, `resolve_block_refs(text: str, uid_to_text) -> str`

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_export_markdown.py
from pkm.export.markdown import (page_filename, render_page,
                                 resolve_block_refs, rewrite_asset_links,
                                 safe_filename)


def node(text, children=()):
    return {"text": text, "children": list(children)}


def test_render_nested_outline():
    tree = [node("parent", [node("child", [node("grandchild")])]),
            node("sibling")]
    assert render_page("My Page", tree, {}) == (
        "# My Page\n"
        "\n"
        "- parent\n"
        "  - child\n"
        "    - grandchild\n"
        "- sibling\n")


def test_render_multiline_block_continuation():
    assert render_page("P", [node("line one\nline two")], {}) == (
        "# P\n\n- line one\n  line two\n")


def test_block_refs_resolve_and_unknown_stay():
    text = "see ((uid_a)) and ((uid_gone))"
    out = resolve_block_refs(text, {"uid_a": "the target"})
    assert out == "see ((the target)) and ((uid_gone))"


def test_asset_links_become_relative():
    text = "![p](/assets/aa11/pic.png) and [d](/assets/bb22/doc.pdf)"
    assert rewrite_asset_links(text) == (
        "![p](../assets/aa11/pic.png) and [d](../assets/bb22/doc.pdf)")


def test_page_filename_sanitizes_and_dedupes():
    taken: set[str] = set()
    assert page_filename("Notes/Ideas: 2026", taken) == "Notes-Ideas- 2026.md"
    assert page_filename("plain", taken) == "plain.md"
    assert page_filename("Plain", taken) == "Plain (2).md"  # APFS case-insensitive
    assert page_filename("...", taken) == "untitled.md"


def test_safe_filename():
    assert safe_filename("a/b:c.png") == "a-b-c.png"
    assert safe_filename("") == "file"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_export_markdown.py -v`
Expected: FAIL — module `pkm.export` does not exist.

- [ ] **Step 3: Implement**

```python
# server/src/pkm/export/markdown.py
# pattern: Functional Core
"""Render one page's block tree as portable, self-contained markdown.

The export layout the paths assume (writer.py owns it):
  export/pages/<title>.md, export/journal/YYYY-MM-DD.md  <- one level deep
  export/assets/<sha256>/<filename>                      <- hence ../assets/
"""
from __future__ import annotations

import re
from collections.abc import Mapping

_ASSET_LINK_RE = re.compile(r"\]\(/assets/")
_BLOCK_REF_RE = re.compile(r"\(\(([A-Za-z0-9_-]+)\)\)")
_UNSAFE_RE = re.compile(r"[/\\:\x00-\x1f]")


def rewrite_asset_links(text: str) -> str:
    return _ASSET_LINK_RE.sub("](../assets/", text)


def resolve_block_refs(text: str, uid_to_text: Mapping[str, str]) -> str:
    return _BLOCK_REF_RE.sub(
        lambda m: f"(({uid_to_text[m.group(1)]}))"
        if m.group(1) in uid_to_text else m.group(0), text)


def safe_filename(name: str) -> str:
    return _UNSAFE_RE.sub("-", name) or "file"


def page_filename(title: str, taken: set[str]) -> str:
    """Unique '<sanitized title>.md'; case-insensitive against `taken`
    (APFS default). Adds the chosen lowercase key to `taken`."""
    base = _UNSAFE_RE.sub("-", title).strip(" .") or "untitled"
    name, n = f"{base}.md", 2
    while name.lower() in taken:
        name = f"{base} ({n}).md"
        n += 1
    taken.add(name.lower())
    return name


def render_page(title: str, tree: list[dict],
                uid_to_text: Mapping[str, str]) -> str:
    lines = [f"# {title}", ""]

    def walk(nodes: list[dict], depth: int) -> None:
        pad = "  " * depth
        for node in nodes:
            text = rewrite_asset_links(
                resolve_block_refs(node["text"], uid_to_text))
            first, *rest = text.split("\n")
            lines.append(f"{pad}- {first}")
            lines.extend(f"{pad}  {line}" for line in rest)
            walk(node["children"], depth + 1)

    walk(tree, 0)
    return "\n".join(lines) + "\n"
```

- [ ] **Step 4: Run tests to verify they pass, commit**

```bash
cd server && uv run pytest tests/test_export_markdown.py -v
git add server/src/pkm/export server/tests/test_export_markdown.py
git commit -m "feat(export): markdown rendering core"
```

---

### Task 6: Exporter writer — files + asset mirror (Imperative Shell)

**Files:**
- Create: `server/src/pkm/export/writer.py`
- Test: `server/tests/test_export_writer.py`

**Interfaces:**
- Consumes: Task 5 functions; `pkm.server.tree.build_tree(rows)` and `collect_block_ref_uids(texts)`; `pkm.server.daily.date_for_title(title) -> date | None`; connections with `row_factory = sqlite3.Row` (what `pkm.server.db.open_db` returns).
- Produces: `export_graph(db: sqlite3.Connection, live_assets_dir: Path, export_dir: Path) -> dict` returning `{"pages": int, "journal": int, "assets_copied": int, "assets_pruned": int}`. Task 8 calls this.

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_export_writer.py
import sqlite3
from pathlib import Path

import pytest

from pkm.export.writer import export_graph
from pkm.schema import DDL


@pytest.fixture()
def graph(tmp_path):
    db = sqlite3.connect(tmp_path / "g.sqlite3")
    db.row_factory = sqlite3.Row
    db.executescript(DDL)
    db.executemany("INSERT INTO pages VALUES (?,?,?,?)", [
        (1, "Alpha", None, None),
        (2, "July 7th, 2026", None, None),
    ])
    sha = "ab" * 32
    db.executemany("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)", [
        ("u1", 1, None, 0, "root block", None, 0, None, None),
        ("u2", 1, "u1", 0, f"![pic](/assets/{sha}/pic.png)", None, 0, None, None),
        ("u3", 2, None, 0, "journal refs ((u1))", None, 0, None, None),
    ])
    db.execute("INSERT INTO assets VALUES (?,?,?,?,?)",
               (sha, "pic.png", "image/png", 3, None))
    db.commit()
    live_assets = tmp_path / "live-assets"
    (live_assets / sha[:2]).mkdir(parents=True)
    (live_assets / sha[:2] / sha).write_bytes(b"png")
    return db, live_assets, tmp_path / "export", sha


def test_export_writes_pages_journal_assets(graph):
    db, live_assets, export, sha = graph
    counts = export_graph(db, live_assets, export)
    assert counts == {"pages": 1, "journal": 1,
                      "assets_copied": 1, "assets_pruned": 0}
    page = (export / "pages" / "Alpha.md").read_text()
    assert f"  - ![pic](../assets/{sha}/pic.png)" in page
    journal = (export / "journal" / "2026-07-07.md").read_text()
    assert "- journal refs ((root block))" in journal
    assert (export / "assets" / sha / "pic.png").read_bytes() == b"png"
    assert (export / ".gitignore").read_text() == "assets/\n"


def test_export_is_incremental_and_prunes(graph):
    db, live_assets, export, sha = graph
    export_graph(db, live_assets, export)
    counts = export_graph(db, live_assets, export)
    assert counts["assets_copied"] == 0  # second run copies nothing
    db.execute("DELETE FROM assets WHERE sha256 = ?", (sha,))
    db.commit()
    counts = export_graph(db, live_assets, export)
    assert counts["assets_pruned"] == 1
    assert not (export / "assets" / sha).exists()


def test_deleted_page_disappears_from_export(graph):
    db, live_assets, export, _ = graph
    export_graph(db, live_assets, export)
    db.execute("DELETE FROM pages WHERE id = 1")
    db.commit()
    counts = export_graph(db, live_assets, export)
    assert counts["pages"] == 0
    assert not (export / "pages" / "Alpha.md").exists()
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_export_writer.py -v`
Expected: FAIL — `pkm.export.writer` does not exist.

- [ ] **Step 3: Implement**

```python
# server/src/pkm/export/writer.py
# pattern: Imperative Shell
"""Write the full markdown + assets export for a graph database.

*.md files are wiped and rewritten every run (renames/deletes stay honest;
git still diffs minimally because unchanged content is byte-identical).
The asset mirror is incremental: content-hashed files never change, so
only new hashes are copied and vanished hashes pruned."""
from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

from pkm.export.markdown import page_filename, render_page, safe_filename
from pkm.server.daily import date_for_title
from pkm.server.tree import build_tree, collect_block_ref_uids

GITIGNORE = "assets/\n"


def export_graph(db: sqlite3.Connection, live_assets_dir: Path,
                 export_dir: Path) -> dict:
    pages_dir = export_dir / "pages"
    journal_dir = export_dir / "journal"
    assets_dir = export_dir / "assets"
    for d in (pages_dir, journal_dir, assets_dir):
        d.mkdir(parents=True, exist_ok=True)
    (export_dir / ".gitignore").write_text(GITIGNORE, encoding="utf-8")

    texts = [r["text"] for r in db.execute("SELECT text FROM blocks")]
    uid_to_text: dict[str, str] = {}
    for uid in collect_block_ref_uids(texts):
        row = db.execute("SELECT text FROM blocks WHERE uid = ?",
                         (uid,)).fetchone()
        if row is not None:
            uid_to_text[uid] = row["text"]

    for d in (pages_dir, journal_dir):
        for old in d.glob("*.md"):
            old.unlink()

    counts = {"pages": 0, "journal": 0, "assets_copied": 0, "assets_pruned": 0}
    taken: set[str] = set()
    for page in db.execute("SELECT id, title FROM pages ORDER BY title"):
        rows = db.execute(
            "SELECT uid, parent_uid, order_idx, text, heading, collapsed,"
            " created_at, updated_at FROM blocks WHERE page_id = ?",
            (page["id"],)).fetchall()
        body = render_page(page["title"], build_tree(rows), uid_to_text)
        day = date_for_title(page["title"])
        if day is not None:
            (journal_dir / f"{day.isoformat()}.md").write_text(
                body, encoding="utf-8")
            counts["journal"] += 1
        else:
            (pages_dir / page_filename(page["title"], taken)).write_text(
                body, encoding="utf-8")
            counts["pages"] += 1

    wanted: dict[str, str] = {
        row["sha256"]: safe_filename(row["filename"])
        for row in db.execute("SELECT sha256, filename FROM assets")}
    for sha, fname in wanted.items():
        src = live_assets_dir / sha[:2] / sha
        out = assets_dir / sha / fname
        if not src.is_file():
            continue  # row without a stored file: known import residue
        if not out.is_file():
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, out)
            counts["assets_copied"] += 1
    for d in assets_dir.iterdir():
        if d.is_dir() and d.name not in wanted:
            shutil.rmtree(d)
            counts["assets_pruned"] += 1
    return counts
```

- [ ] **Step 4: Run tests, full suite, commit**

```bash
cd server && uv run pytest tests/test_export_writer.py -v && uv run pytest -q
git add server/src/pkm/export/writer.py server/tests/test_export_writer.py
git commit -m "feat(export): full markdown + asset-mirror writer"
```

---

### Task 7: Backup rotation policy (Functional Core)

**Files:**
- Create: `server/src/pkm/backup/__init__.py` (empty), `server/src/pkm/backup/rotation.py`
- Test: `server/tests/test_rotation.py`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (Task 8 relies on these):
  - `backup_name(day: date) -> str` — `"pkm-YYYY-MM-DD.sqlite3"`.
  - `prune_list(names: list[str], keep_daily: int = 14) -> list[str]` — filenames to delete; keeps the `keep_daily` newest dates plus the latest backup of every month (forever); never returns unparseable names.

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_rotation.py
from datetime import date, timedelta

from pkm.backup.rotation import backup_name, prune_list


def names(start: date, days: int) -> list[str]:
    return [backup_name(start + timedelta(d)) for d in range(days)]


def test_backup_name():
    assert backup_name(date(2026, 7, 9)) == "pkm-2026-07-09.sqlite3"


def test_under_keep_daily_deletes_nothing():
    assert prune_list(names(date(2026, 7, 1), 14)) == []


def test_keeps_newest_14_and_month_ends():
    # 2026-06-20 .. 2026-07-20: 31 files. Keep 07-07..07-20 (newest 14)
    # plus 06-30 (last of June). Everything else goes.
    got = prune_list(names(date(2026, 6, 20), 31))
    assert backup_name(date(2026, 6, 30)) not in got
    assert backup_name(date(2026, 6, 29)) in got
    assert backup_name(date(2026, 7, 6)) in got
    assert backup_name(date(2026, 7, 7)) not in got
    assert len(got) == 31 - 14 - 1


def test_last_of_month_means_latest_existing_backup_that_month():
    # only two June files exist; the 15th is June's latest -> kept forever
    files = [backup_name(date(2026, 6, 1)), backup_name(date(2026, 6, 15)),
             *names(date(2026, 7, 1), 14)]
    got = prune_list(files)
    assert got == [backup_name(date(2026, 6, 1))]


def test_unparseable_names_are_never_deleted():
    files = ["pkm-2026-07-09.sqlite3.tmp", "notes.txt",
             *names(date(2026, 7, 1), 20)]
    got = prune_list(files)
    assert "notes.txt" not in got and "pkm-2026-07-09.sqlite3.tmp" not in got
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_rotation.py -v`
Expected: FAIL — `pkm.backup` does not exist.

- [ ] **Step 3: Implement**

```python
# server/src/pkm/backup/rotation.py
# pattern: Functional Core
"""Which dated sqlite backups to delete: keep the newest N days plus the
latest backup of every month (kept forever)."""
from __future__ import annotations

import re
from datetime import date

_NAME_RE = re.compile(r"^pkm-(\d{4})-(\d{2})-(\d{2})\.sqlite3$")


def backup_name(day: date) -> str:
    return f"pkm-{day.isoformat()}.sqlite3"


def prune_list(names: list[str], keep_daily: int = 14) -> list[str]:
    dated: dict[date, str] = {}
    for name in names:
        m = _NAME_RE.match(name)
        if m:  # anything unparseable is left alone
            dated[date(int(m[1]), int(m[2]), int(m[3]))] = name
    days = sorted(dated)
    keep = set(days[-keep_daily:]) if keep_daily > 0 else set()
    month_latest: dict[tuple[int, int], date] = {}
    for d in days:
        month_latest[(d.year, d.month)] = d
    keep.update(month_latest.values())
    return [dated[d] for d in days if d not in keep]
```

- [ ] **Step 4: Run tests, commit**

```bash
cd server && uv run pytest tests/test_rotation.py -v
git add server/src/pkm/backup server/tests/test_rotation.py
git commit -m "feat(backup): rotation policy core"
```

---

### Task 8: Nightly backup CLI — `python -m pkm.backup`

**Files:**
- Create: `server/src/pkm/backup/__main__.py`
- Test: `server/tests/test_backup_cli.py`

**Interfaces:**
- Consumes: `load_config` (Task 1), `export_graph` (Task 6), `backup_name`/`prune_list` (Task 7).
- Produces: CLI `python -m pkm.backup --data-dir D --backups-dir B [--keep-daily 14]`, exit 0 on success / 1 on any failure. `main(argv) -> int` importable for tests. Task 12's backup plist runs exactly this command.

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_backup_cli.py
import json
import sqlite3
import subprocess
from datetime import date
from pathlib import Path

import pytest

from pkm.backup.__main__ import main
from pkm.backup.rotation import backup_name
from pkm.schema import DDL


@pytest.fixture()
def data_dir(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    con = sqlite3.connect(d / "pkm.sqlite3")
    con.executescript(DDL)
    con.execute("INSERT INTO pages VALUES (1, 'Alpha', NULL, NULL)")
    con.execute("INSERT INTO blocks VALUES "
                "('u1', 1, NULL, 0, 'hello', NULL, 0, NULL, NULL)")
    con.commit()
    con.close()
    (d / "assets").mkdir()
    (d / "config.json").write_text(json.dumps({
        "db_file": "pkm.sqlite3", "assets_dir": "assets",
        "password_salt": "ab", "password_hash": "cd",
        "session_secret": "ef"}))
    return d


def git_commits(export: Path) -> int:
    out = subprocess.run(["git", "-C", str(export), "rev-list", "--count",
                          "HEAD"], capture_output=True, text=True, check=True)
    return int(out.stdout)


def test_backup_creates_snapshot_export_and_commit(data_dir, tmp_path):
    backups = tmp_path / "backups"
    assert main(["--data-dir", str(data_dir),
                 "--backups-dir", str(backups)]) == 0
    dated = backups / "sqlite" / backup_name(date.today())
    con = sqlite3.connect(f"file:{dated}?mode=ro", uri=True)
    assert con.execute("SELECT COUNT(*) FROM blocks").fetchone()[0] == 1
    con.close()
    assert (backups / "export" / "pages" / "Alpha.md").is_file()
    assert git_commits(backups / "export") == 1


def test_second_run_with_no_changes_commits_nothing(data_dir, tmp_path):
    backups = tmp_path / "backups"
    main(["--data-dir", str(data_dir), "--backups-dir", str(backups)])
    assert main(["--data-dir", str(data_dir),
                 "--backups-dir", str(backups)]) == 0
    assert git_commits(backups / "export") == 1


def test_rotation_prunes_old_dailies(data_dir, tmp_path):
    backups = tmp_path / "backups"
    (backups / "sqlite").mkdir(parents=True)
    old = backups / "sqlite" / "pkm-2020-05-05.sqlite3"
    mid = backups / "sqlite" / "pkm-2020-05-06.sqlite3"  # May 2020's latest
    old.write_bytes(b"x")
    mid.write_bytes(b"x")
    main(["--data-dir", str(data_dir), "--backups-dir", str(backups),
          "--keep-daily", "1"])
    assert not old.exists()
    assert mid.exists()  # latest of its month: kept forever
    assert (backups / "sqlite" / backup_name(date.today())).exists()


def test_live_db_is_untouched(data_dir, tmp_path):
    live = data_dir / "pkm.sqlite3"
    before = live.stat().st_mtime_ns
    main(["--data-dir", str(data_dir), "--backups-dir", str(tmp_path / "b")])
    assert live.stat().st_mtime_ns == before
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest tests/test_backup_cli.py -v`
Expected: FAIL — `pkm.backup.__main__` does not exist.

- [ ] **Step 3: Implement**

```python
# server/src/pkm/backup/__main__.py
# pattern: Imperative Shell
"""Nightly job: python -m pkm.backup --data-dir DATA --backups-dir BACKUPS

1. SQLite online backup from a read-only connection -> backups/sqlite/,
   written to a temp name and renamed in, then rotation pruning.
2. Markdown + assets export FROM THE FRESH SNAPSHOT (sqlite copy and
   export always describe the same instant) -> backups/export/, with a
   local git auto-commit of everything except assets/.
Never opens the live database for writing. Any failure exits nonzero
(launchd surfaces it via last-exit-status and the error log)."""
from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
from datetime import date
from pathlib import Path

from pkm.backup.rotation import backup_name, prune_list
from pkm.export.writer import export_graph
from pkm.server.config import load_config

# self-contained identity: the job must not depend on global git config
GIT_ID = ["-c", "user.name=pkm-backup", "-c", "user.email=pkm-backup@localhost"]


def open_ro(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def sqlite_backup(live_db: Path, dest: Path) -> None:
    tmp = dest.with_name(dest.name + ".tmp")
    src = open_ro(live_db)
    try:
        dst = sqlite3.connect(tmp)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    os.replace(tmp, dest)


def git_commit_export(export_dir: Path, day: date) -> str:
    def git(*a: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *GIT_ID, "-C", str(export_dir), *a],
                              capture_output=True, text=True, check=True)
    if not (export_dir / ".git").is_dir():
        git("init", "-q")
    git("add", "-A")
    if git("status", "--porcelain").stdout == "":
        return "clean"
    git("commit", "-q", "-m", f"nightly export {day.isoformat()}")
    return "committed"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Nightly PKM backup + export.")
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--backups-dir", required=True)
    ap.add_argument("--keep-daily", type=int, default=14)
    args = ap.parse_args(argv)
    config = load_config(Path(args.data_dir) / "config.json")
    backups = Path(args.backups_dir)
    sqlite_dir = backups / "sqlite"
    sqlite_dir.mkdir(parents=True, exist_ok=True)

    today = date.today()
    dated = sqlite_dir / backup_name(today)
    sqlite_backup(config.db_path, dated)
    for name in prune_list(sorted(p.name for p in sqlite_dir.iterdir()),
                           args.keep_daily):
        (sqlite_dir / name).unlink()

    snapshot = open_ro(dated)
    try:
        counts = export_graph(snapshot, config.assets_dir, backups / "export")
    finally:
        snapshot.close()
    outcome = git_commit_export(backups / "export", today)
    print(f"backup ok: {dated.name} export={counts} git={outcome}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 — launchd job: fail loud, exit nonzero
        import traceback
        traceback.print_exc()
        raise SystemExit(1)
```

- [ ] **Step 4: Run tests, full suite, commit**

```bash
cd server && uv run pytest tests/test_backup_cli.py -v && uv run pytest -q
git add server/src/pkm/backup/__main__.py server/tests/test_backup_cli.py
git commit -m "feat(backup): nightly backup + export CLI"
```

---

### Task 9: Frontend — `visibilitychange` draft flush

**Files:**
- Modify: `web/src/outline/useOutline.ts`
- Test: `web/src/views/EditablePage.test.tsx`

**Interfaces:**
- Consumes: existing `flushNow` callback inside `useOutline`; test harness `mount`/`focusBlock` already in `EditablePage.test.tsx`.
- Produces: pending debounced text ops flush when the tab becomes hidden.

- [ ] **Step 1: Write the failing test** (append to `web/src/views/EditablePage.test.tsx`)

```tsx
test("hiding the tab flushes the pending draft immediately", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "first draft" } });
  expect(sync.sent).toEqual([]);
  Object.defineProperty(document, "visibilityState",
                        { value: "hidden", configurable: true });
  fireEvent(document, new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState",
                        { value: "visible", configurable: true });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "first draft" }],
  ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm test -- --run src/views/EditablePage.test.tsx`
Expected: new test FAILS (`sync.sent` stays empty).

- [ ] **Step 3: Implement**

In `web/src/outline/useOutline.ts`, after the `flushNow` definition, add:

```ts
  // A hidden tab can be killed without blur ever firing (the one real
  // data-loss window): flush the draft as soon as the tab hides.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [flushNow]);
```

- [ ] **Step 4: Run web suite, commit**

```bash
cd web && pnpm typecheck && pnpm test -- --run
git add web/src/outline/useOutline.ts web/src/views/EditablePage.test.tsx
git commit -m "fix(web): flush pending draft on visibilitychange"
```

---

### Task 10: Frontend — drop doomed `update_text` for deleted blocks

**Files:**
- Modify: `web/src/outline/useOutline.ts` (`takePendingTextOps`)
- Test: `web/src/views/EditablePage.test.tsx`

**Interfaces:**
- Consumes: `findNode` from `web/src/outline/tree.ts` (already imported); `DeleteOp` shape is `{ op: "delete", uid }` (see `web/src/api/ops.ts` / generated types — verify before writing the test).
- Produces: a pending draft whose block no longer exists yields `[]` instead of an `update_text` op that would reject a whole batch and force a desync refetch.

- [ ] **Step 1: Write the failing test** (append to `web/src/views/EditablePage.test.tsx`)

```tsx
test("draft for a remotely-deleted block is dropped, not flushed", () => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "doomed draft" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [
    { op: "delete", uid: "u1" },
  ] }));
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm test -- --run src/views/EditablePage.test.tsx`
Expected: new test FAILS — a `[{ op: "update_text", uid: "u1", ... }]` batch is sent.

- [ ] **Step 3: Implement**

In `takePendingTextOps` in `web/src/outline/useOutline.ts`, replace

```ts
    if (findNode(blocksRef.current, pending.uid)?.text === pending.text) {
      return []; // draft never actually changed the text
    }
```

with

```ts
    const node = findNode(blocksRef.current, pending.uid);
    if (!node || node.text === pending.text) {
      // no node: a remote batch deleted it — flushing would doom the whole
      // batch. same text: the draft never actually changed anything.
      return [];
    }
```

- [ ] **Step 4: Run web suite, commit**

```bash
cd web && pnpm typecheck && pnpm test -- --run
git add web/src/outline/useOutline.ts web/src/views/EditablePage.test.tsx
git commit -m "fix(web): drop pending draft for remotely-deleted block"
```

---

### Task 11: Frontend — `SyncContext` loud default

**Files:**
- Modify: `web/src/sync/SyncProvider.tsx`
- Test: `web/src/sync/SyncProvider.test.tsx`

**Interfaces:**
- Consumes: existing default context value in `SyncProvider.tsx`.
- Produces: calling `enqueue` outside a `<SyncProvider>` throws (`/SyncProvider/` in the message) instead of silently dropping the write. `status`/`resyncSeq`/`subscribe` defaults stay inert (components may render before the provider in tests).

- [ ] **Step 1: Write the failing test** (append to `web/src/sync/SyncProvider.test.tsx`, adapting to that file's existing imports)

```tsx
test("enqueue outside a provider throws instead of dropping writes", () => {
  let sync: Sync | undefined;
  function Probe() {
    sync = useSync();
    return null;
  }
  render(<Probe />);
  expect(() => sync!.enqueue([])).toThrow(/SyncProvider/);
});
```

Add the needed imports if absent: `render` from `@testing-library/react`, `useSync` and `type Sync` from `./SyncProvider`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm test -- --run src/sync/SyncProvider.test.tsx`
Expected: new test FAILS (default `enqueue` is a silent no-op).

- [ ] **Step 3: Implement**

In `web/src/sync/SyncProvider.tsx`, replace the default context value's `enqueue`:

```ts
export const SyncContext = createContext<Sync>({
  status: "connecting",
  resyncSeq: 0,
  enqueue: () => {
    // a silent default would drop writes without a trace
    throw new Error("enqueue called outside <SyncProvider>");
  },
  subscribe: () => () => undefined,
});
```

- [ ] **Step 4: Run the FULL web suite** — this is the step that matters: any component test mounting an editable view without a provider will now throw. Fix such tests by wrapping with `SyncContext.Provider value={makeSync()}` (the established pattern), never by softening the default.

Run: `cd web && pnpm typecheck && pnpm test -- --run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/SyncProvider.tsx web/src/sync/SyncProvider.test.tsx
git commit -m "fix(web): SyncContext default enqueue fails loud"
```

---

### Task 12: `deploy/` — templated plists, install/update/smoke scripts, README

**Files:**
- Create: `deploy/com.PLACEHOLDER.pkm.server.plist.template`
- Create: `deploy/com.PLACEHOLDER.pkm.backup.plist.template`
- Create: `deploy/install.sh`, `deploy/update.sh`, `deploy/smoke.sh` (all `chmod +x`)
- Create: `deploy/README.md`

**Interfaces:**
- Consumes: `python -m pkm.server.run` (Task 2), `python -m pkm.backup` (Task 8), the repo's `origin` remote URL.
- Produces: everything Task 13 runs on the machine. Placeholders are exactly `{{USER}}`, `{{UV}}`, `{{PKM_HOME}}` — filled by `install.sh` with `sed`. No secrets, usernames, or machine paths in any committed file.

- [ ] **Step 1: Write the server plist template**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.{{USER}}.pkm.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{UV}}</string>
    <string>run</string>
    <string>--project</string>
    <string>{{PKM_HOME}}/app/server</string>
    <string>python</string>
    <string>-m</string>
    <string>pkm.server.run</string>
    <string>--data-dir</string>
    <string>{{PKM_HOME}}/data</string>
  </array>
  <key>WorkingDirectory</key><string>{{PKM_HOME}}/app/server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>{{PKM_HOME}}/logs/server.out.log</string>
  <key>StandardErrorPath</key><string>{{PKM_HOME}}/logs/server.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Write the backup plist template**

Same skeleton with these differences: label `com.{{USER}}.pkm.backup`; program arguments run `pkm.backup` with `--data-dir {{PKM_HOME}}/data --backups-dir {{PKM_HOME}}/backups`; no `RunAtLoad`/`KeepAlive`/`ThrottleInterval`; logs to `backup.out.log`/`backup.err.log`; and:

```xml
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
```

(launchd runs a missed calendar job on wake, so a sleeping mini doesn't skip a night.)

- [ ] **Step 3: Write `deploy/install.sh`**

```bash
#!/bin/bash
# Install/refresh the PKM launchd services on this machine. Idempotent:
# re-running updates plists and Tailscale Serve config; it never touches
# data/, backups/, or an existing config.json.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PKM_HOME="${PKM_HOME:-$HOME/.config/pkm}"
UV="$(command -v uv)"
TAILSCALE="$(command -v tailscale ||
  echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
USER_NAME="$(whoami)"
PORT=8974

mkdir -p "$PKM_HOME/data" "$PKM_HOME/backups" "$PKM_HOME/logs"
if [ ! -e "$PKM_HOME/app" ]; then
  git clone "$(git -C "$REPO" remote get-url origin)" "$PKM_HOME/app"
fi

render() { # render <template> <dest>
  sed -e "s|{{USER}}|$USER_NAME|g" \
      -e "s|{{UV}}|$UV|g" \
      -e "s|{{PKM_HOME}}|$PKM_HOME|g" "$1" > "$2"
}

for svc in server backup; do
  LABEL="com.$USER_NAME.pkm.$svc"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  render "$REPO/deploy/com.PLACEHOLDER.pkm.$svc.plist.template" "$PLIST"
  plutil -lint -s "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
done

"$TAILSCALE" serve --bg --https=443 "http://127.0.0.1:$PORT"

TS_IP="$("$TAILSCALE" ip -4 | head -1)"
echo "Installed. Ensure $PKM_HOME/data/config.json contains:"
echo "  \"bind_hosts\": [\"127.0.0.1\", \"$TS_IP\"],"
echo "  \"web_dist\": \"../app/web/dist\""
echo "(create a fresh config with pkm.server.setup — see deploy/README.md)"
```

- [ ] **Step 4: Write `deploy/update.sh`**

```bash
#!/bin/bash
# Update the prod checkout this script lives in, then restart the service.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
git -C "$APP" pull --ff-only
(cd "$APP/server" && uv sync)
(cd "$APP/web" && pnpm install --frozen-lockfile && pnpm build)
launchctl kickstart -k "gui/$(id -u)/com.$(whoami).pkm.server"
echo "updated to $(git -C "$APP" rev-parse --short HEAD)"
```

- [ ] **Step 5: Write `deploy/smoke.sh`**

```bash
#!/bin/bash
# Post-deploy smoke: run on the target machine after install.sh.
# Checks loopback + tailscale-ip binds, Serve HTTPS, login, an authed
# read, the asset auth gate, and a REAL websocket upgrade (plan-5 lesson:
# TestClient suites pass even when real WS upgrades would fail).
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8974
TAILSCALE="$(command -v tailscale ||
  echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
TS_IP="$("$TAILSCALE" ip -4 | head -1)"
HOST_DNS="$("$TAILSCALE" status --json |
  uv run --project "$APP/server" python -c \
  'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
BASE="https://$HOST_DNS"

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || fail "loopback healthz"
curl -fsS "http://$TS_IP:$PORT/healthz" >/dev/null || fail "tailscale-ip healthz"
curl -fsS "$BASE/healthz" >/dev/null || fail "serve https healthz"

read -rs -p "app password: " PW; echo
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
curl -fsS -c "$JAR" -H 'Content-Type: application/json' \
  -d "{\"password\": \"$PW\"}" "$BASE/api/login" >/dev/null || fail "login"
curl -fsS -b "$JAR" "$BASE/api/titles" >/dev/null || fail "authed read"

BOGUS="$BASE/assets/$(printf 'a%.0s' {1..64})/x" # auth runs before lookup
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BOGUS")"
[ "$CODE" = "401" ] || fail "asset without cookie returned $CODE (want 401)"

# HttpOnly cookies are stored as "#HttpOnly_<domain> ..." — match both forms
COOKIE="$(awk 'NF==7 && ($0 ~ /^#HttpOnly_/ || $0 !~ /^#/) {print $6"="$7}' \
  "$JAR" | head -1)"
uv run --project "$APP/server" python - "$HOST_DNS" "$COOKIE" <<'PY' \
  || fail "websocket upgrade"
import asyncio, sys
import websockets


async def main() -> None:
    host, cookie = sys.argv[1], sys.argv[2]
    async with websockets.connect(f"wss://{host}/api/ws",
                                  additional_headers={"Cookie": cookie}):
        pass

asyncio.run(main())
PY
echo "SMOKE OK: loopback, tailscale ip, serve https, login, asset gate, websocket"
```

Note: `additional_headers` is the websockets>=14 kwarg; if the installed
version is 13.x it's spelled `extra_headers`. Check with
`uv run --project "$APP/server" python -c "import websockets; print(websockets.__version__)"`
while writing the script and use the right one.

- [ ] **Step 6: Write `deploy/README.md`** covering, in short sections: the `~/.config/pkm/{app,data,backups,logs}` layout; first-install procedure (clone happens via install.sh; create `data/config.json` with `cd "$PKM_HOME/app/server" && uv run python -m pkm.server.setup --data-dir "$PKM_HOME/data"` — check `server/src/pkm/server/setup.py` for the real invocation and document THAT, plus the `bind_hosts`/`web_dist` lines install.sh prints); updating (`deploy/update.sh`); backups (what lands in `backups/`, that `backups/` is the one dir to sync off-machine, and that `sqlite/` keeps 14 dailies + month-ends forever); restore procedure (stop service, copy a dated sqlite file over `data/pkm.sqlite3`, start, verify); and troubleshooting (`launchctl print gui/$UID/com.$USER.pkm.server`, the two log files, `tailscale serve status`).

- [ ] **Step 7: Verify the scripts without installing anything**

```bash
bash -n deploy/install.sh deploy/update.sh deploy/smoke.sh
# render both templates the way install.sh does and lint them:
mkdir -p /tmp/plist-check
for svc in server backup; do
  sed -e "s|{{USER}}|checkuser|g" -e "s|{{UV}}|/opt/uv|g" \
      -e "s|{{PKM_HOME}}|/tmp/pkm|g" \
      "deploy/com.PLACEHOLDER.pkm.$svc.plist.template" \
      > "/tmp/plist-check/$svc.plist"
  plutil -lint "/tmp/plist-check/$svc.plist"
done
grep -rn "arthur\|/Users/" deploy/ && echo "LEAK — fix before commit" || true
```

Expected: `bash -n` silent, both plists lint `OK`, and the grep finds nothing (no committed username/path).

- [ ] **Step 8: Commit**

```bash
chmod +x deploy/install.sh deploy/update.sh deploy/smoke.sh
git add deploy/
git commit -m "feat(deploy): templated launchd services + install/update/smoke scripts"
```

---

### Task 13: On-machine deployment & verification — CONTROLLER ONLY

**⚠️ This task is NOT for subagents.** It runs in the main session, on the real machine, AFTER Tasks 1–12 are reviewed, merged to main (`--no-ff`), and pushed. It touches the live graph — follow each step exactly.

**Files:** none in the repo (machine state + a spec findings section).

- [ ] **Step 1: Preconditions.** Branch merged to main and pushed; `cd server && uv run pytest -q` and `cd web && pnpm typecheck && pnpm test -- --run` green on main; no dev server running against `data/` (`lsof -nP -iTCP:8974 | grep LISTEN` is empty).

- [ ] **Step 2: Record pre-migration truth** (read-only):

```bash
sqlite3 "file:$PWD/data/pkm.sqlite3?mode=ro" \
  "SELECT (SELECT COUNT(*) FROM pages), (SELECT COUNT(*) FROM blocks), (SELECT COUNT(*) FROM assets);"
```

Write the three numbers down; they gate Steps 4 and 8.

- [ ] **Step 3: Install services + prod clone:** `deploy/install.sh` (from the dev checkout; it clones `~/.config/pkm/app` from origin, renders plists, bootstraps both agents, configures Serve). The server agent will crash-loop until Step 4 provides config — that's the designed KeepAlive behavior, ignore it for now. Then build the SPA in the prod clone: `cd ~/.config/pkm/app/web && pnpm install --frozen-lockfile && pnpm build`.

- [ ] **Step 4: Migrate live data** (server still stopped for the dev copy; use `cp -c` APFS clones — instant, no extra disk):

```bash
cp -c ~/code/llm/pkm/data/pkm.sqlite3 ~/.config/pkm/data/pkm.sqlite3
cp -Rc ~/code/llm/pkm/data/assets ~/.config/pkm/data/assets
cp ~/code/llm/pkm/data/config.json ~/.config/pkm/data/config.json
```

Edit `~/.config/pkm/data/config.json`: set `"web_dist": "../app/web/dist"`, add `"bind_hosts": ["127.0.0.1", "<TS_IP from install.sh output>"]` (paths resolve relative to the config file). Verify the copy: same three counts as Step 2 via the same read-only query against the new path. Restart: `launchctl kickstart -k gui/$(id -u)/com.$(whoami).pkm.server`.

- [ ] **Step 5: Smoke:** `~/.config/pkm/app/deploy/smoke.sh` → must print `SMOKE OK` with all six checks. Also open `https://biber.<tailnet>.ts.net` in Safari on another tailnet device: login, edit a block, paste an image.

- [ ] **Step 6: Manual backup run:**

```bash
cd ~/.config/pkm/app/server && uv run python -m pkm.backup \
  --data-dir ~/.config/pkm/data --backups-dir ~/.config/pkm/backups
```

Expected: `backup ok: pkm-<today>.sqlite3 export={'pages': ~4300, 'journal': ..., ...} git=committed`.

- [ ] **Step 7: Verify the backup:** counts in the dated sqlite copy match Step 2 (read-only query); `git -C ~/.config/pkm/backups/export log --oneline` shows one commit; spot-open one exported page and one journal file; re-run the Step 6 command → `git=clean`, `assets_copied: 0`; live DB mtime unchanged across both runs (`stat -f %m ~/.config/pkm/data/pkm.sqlite3` before/after).

- [ ] **Step 8: Verify launchd wiring:** `launchctl print "gui/$(id -u)/com.$(whoami).pkm.server" | grep -E "state|last exit"` shows `running`; backup agent loaded with the 03:30 calendar trigger (`launchctl print ... pkm.backup`); `tailscale serve status` shows 443 → 127.0.0.1:8974. Optionally reboot and re-run smoke.

- [ ] **Step 9: Decommission the dev data copy** — only after Steps 5–8 all pass: `mv ~/code/llm/pkm/data ~/code/llm/pkm/data.pre-deploy` (delete manually weeks later; do NOT rm now). Dev servers/e2e keep using scratch dirs as before.

- [ ] **Step 10: Record results.** Append a "Deployment findings (plan 6)" section to the spec (real counts, smoke results, anything learned), commit, push. Update the `plan6-deployment-next` memory: deployment done, note the next frontier.

---

## Self-Review (performed while writing)

- **Spec coverage:** layout/templating/install → Tasks 1, 12, 13; bind changes → Tasks 1–2; launchd + Serve → Tasks 12–13; nightly backup/export → Tasks 5–8, 13; hardening + 3 frontend fixes → Tasks 3–4, 9–11; testing/verification → per-task tests + Task 12 Step 7 + Task 13. Out-of-scope list untouched. ✓
- **Type consistency:** `bind_hosts: tuple[str, ...]`/`max_upload_bytes: int` (T1) used by T2/T3; `export_graph(db, live_assets_dir, export_dir) -> dict` (T6) called by T8; `backup_name`/`prune_list` (T7) used by T8; placeholder names `{{USER}}/{{UV}}/{{PKM_HOME}}` identical in templates and install.sh. ✓
- **Known judgment calls (documented, not placeholders):** upload allowlist includes `text/csv`, `application/json`, and legacy Office mimes beyond the spec's "images, PDF, plain text, office docs" phrase — superset in the same spirit; heading/collapsed block attributes are intentionally not rendered in the export (raw text keeps it lossless enough; spec only requires structure/TODO/refs preserved).
