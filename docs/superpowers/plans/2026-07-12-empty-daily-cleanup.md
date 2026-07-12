# Empty Daily-Note Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Journal (daily notes) load, the web client fires `POST /api/journal/cleanup`; the server deletes any completely-empty daily pages from the past 7 days (today excluded).

**Architecture:** Two tiny Functional Core helpers in `server/src/pkm/server/daily.py` (date window, emptiness predicate); the existing delete statements factored into a shared store helper; a new Imperative Shell route in `routes_pages.py`; one fire-and-forget `apiFetch` on Journal mount. Spec: `docs/superpowers/specs/2026-07-12-empty-daily-cleanup-design.md` (bean pkm-c3kz).

**Tech Stack:** FastAPI + SQLite (server, `uv run pytest`), React + Vitest (web, `pnpm test -- --run`).

## Global Constraints

- FCIS: every runtime file keeps its `# pattern:` header; new logic in `daily.py` stays pure (no I/O, no clock — `today` is a parameter).
- "Completely empty" = zero blocks OR every block's text is empty/whitespace-only.
- A blank block `((referenced))` from a block on another page spares its page.
- Today's page is never deleted; only the 7 days before today are checked.
- Stateless: every call re-checks the whole window.
- Store helpers never commit — the route owns the transaction (existing convention, see `store.py` docstring).
- Blocks must be deleted explicitly (not via FK cascade) so the `blocks_fts_ad` trigger fires (existing convention, see the delete route docstring).
- Work on branch `feat/empty-daily-cleanup`. Run `git status -sb` before EVERY commit — parallel sessions may switch the shared checkout's branch. Do not commit `docs/superpowers/specs/2026-07-12-offline-editing-design.md` (owned by another session).

---

### Task 1: Functional Core helpers — `past_week_dates`, `is_page_empty`

**Files:**
- Modify: `server/src/pkm/server/daily.py`
- Test: `server/tests/test_daily.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `past_week_dates(today: date) -> list[date]` (the 7 dates before `today`, newest first) and `is_page_empty(texts: Sequence[str]) -> bool` (true when every text is blank; true for an empty sequence). Task 3 imports both from `pkm.server.daily`.

- [ ] **Step 1: Write the failing tests**

In `server/tests/test_daily.py`, change the existing import (line 5) to:

```python
from pkm.server.daily import (
    date_for_title, is_page_empty, past_week_dates, title_for_date)
```

(Do NOT add a second import lower in the file — ruff's E402 flags module-level
imports that aren't at the top.) Then append:

```python
def test_past_week_dates_is_the_seven_days_before_today():
    assert past_week_dates(date(2026, 7, 12)) == [
        date(2026, 7, 11), date(2026, 7, 10), date(2026, 7, 9),
        date(2026, 7, 8), date(2026, 7, 7), date(2026, 7, 6),
        date(2026, 7, 5),
    ]


def test_past_week_dates_crosses_month_boundary():
    assert past_week_dates(date(2026, 7, 3))[-1] == date(2026, 6, 26)


@pytest.mark.parametrize("texts,empty", [
    ([], True),
    (["", "   ", "\t\n"], True),
    (["hello"], False),
    (["", "x", "  "], False),
])
def test_is_page_empty(texts, empty):
    assert is_page_empty(texts) is empty
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_daily.py -q`
Expected: FAIL / collection error with `ImportError: cannot import name 'is_page_empty'`

- [ ] **Step 3: Implement the helpers**

In `server/src/pkm/server/daily.py`: extend the imports and append the two
functions. Update the module docstring to mention the journal-window helpers.

```python
# pattern: Functional Core
"""Roam's ordinal daily-page titles (date <-> 'July 8th, 2026') and the
pure pieces of the empty-daily cleanup: date window + emptiness test."""
from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date, timedelta
```

Append at the end of the file:

```python
def past_week_dates(today: date) -> list[date]:
    """The 7 dates before `today`, newest first. `today` itself is excluded:
    the journal auto-creates today's page for composing."""
    return [today - timedelta(days=i) for i in range(1, 8)]


def is_page_empty(texts: Sequence[str]) -> bool:
    """True when every block text is empty/whitespace (or there are none)."""
    return all(not t.strip() for t in texts)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_daily.py -q`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git status -sb   # confirm branch feat/empty-daily-cleanup, nothing unexpected staged
git add server/src/pkm/server/daily.py server/tests/test_daily.py
git commit -m "feat(server): core helpers for empty-daily cleanup (pkm-c3kz)"
```

---

### Task 2: Shared `delete_page_rows` store helper

**Files:**
- Modify: `server/src/pkm/server/store.py`
- Modify: `server/src/pkm/server/routes_pages.py` (the `delete_page` route, currently lines 161–177)
- Test: existing `server/tests/test_page_endpoint.py::test_delete_page_*` (behavior unchanged — no new tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `delete_page_rows(db: sqlite3.Connection, page_id: int, title: str) -> None` in `pkm.server.store`. Does NOT commit. Task 3 calls it once per deleted page.

This is a pure refactor: the four delete statements move out of the route so the cleanup endpoint (Task 3) uses the identical deletion path. Existing delete tests are the safety net.

- [ ] **Step 1: Add the helper to `store.py`**

Append to `server/src/pkm/server/store.py`:

```python
def delete_page_rows(db: sqlite3.Connection, page_id: int,
                     title: str) -> None:
    """Deletes a page, its blocks, and any sidebar entry. Never commits --
    the caller owns the transaction. Blocks are deleted explicitly (not left
    to the pages FK cascade) so the blocks_fts_ad trigger fires for every
    row; cascade-triggered deletes are not guaranteed to fire triggers."""
    db.execute("DELETE FROM blocks WHERE page_id = ?", (page_id,))
    db.execute("DELETE FROM pages WHERE id = ?", (page_id,))
    db.execute("DELETE FROM sidebar_entries WHERE title = ?", (title,))
```

- [ ] **Step 2: Use it from the delete route**

In `server/src/pkm/server/routes_pages.py`, extend the store import (line 20):

```python
from pkm.server.store import delete_page_rows, fetch_page, get_or_create_page
```

Replace the `delete_page` route body (keep the route decorator and signature)
so it reads:

```python
@router.delete("/api/page/{title:path}")
def delete_page(title: str, db: sqlite3.Connection = Depends(get_db)) -> dict:
    """Deletes the page, its blocks, and any sidebar entry for it. Inbound
    [[links]] from other pages' block text are left as-is -- only the refs
    rows pointing at this page disappear (via target_page_id CASCADE)."""
    page = fetch_page(db, title)
    if page is None:
        raise HTTPException(status_code=404, detail="page not found")
    delete_page_rows(db, page["id"], title)
    db.commit()
    return {"ok": True}
```

(The FTS-trigger rationale paragraph moves from this docstring to
`delete_page_rows`'s docstring — don't keep it in both.)

- [ ] **Step 3: Run the delete tests to verify no regression**

Run: `cd server && uv run pytest tests/test_page_endpoint.py -q`
Expected: all PASS (including all `test_delete_page_*`)

- [ ] **Step 4: Commit**

```bash
git status -sb
git add server/src/pkm/server/store.py server/src/pkm/server/routes_pages.py
git commit -m "refactor(server): factor page deletion into store.delete_page_rows (pkm-c3kz)"
```

---

### Task 3: `POST /api/journal/cleanup` endpoint

**Files:**
- Modify: `server/src/pkm/server/routes_pages.py`
- Test: Create `server/tests/test_journal_cleanup.py`

**Interfaces:**
- Consumes: `past_week_dates`, `is_page_empty` from `pkm.server.daily` (Task 1); `delete_page_rows` from `pkm.server.store` (Task 2); existing `fetch_page`, `title_for_date`.
- Produces: `POST /api/journal/cleanup` → `{"deleted": [<page titles>]}`. Auth-gated like every route on this router. Task 4's web client calls it.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_journal_cleanup.py`. Test data is inserted directly
via sqlite (the pattern used throughout `test_page_endpoint.py`). Deletion is
verified with direct sqlite reads, NOT `GET /api/page/{title}` — that endpoint
auto-recreates missing daily pages and would mask the deletion. Page ids start
at 90 to stay clear of the seeded ids 1–5.

```python
import sqlite3
from collections.abc import Sequence
from datetime import date, timedelta

from pkm.server.daily import title_for_date


def _insert_page(db_path, page_id: int, title: str,
                 blocks: Sequence[tuple[str, str]] = ()) -> None:
    """blocks: [(uid, text), ...] as top-level blocks of the page."""
    con = sqlite3.connect(db_path)
    con.execute("INSERT INTO pages(id, title) VALUES (?, ?)", (page_id, title))
    con.executemany(
        "INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)",
        [(uid, page_id, None, i, text, None, 0, None, None)
         for i, (uid, text) in enumerate(blocks)])
    con.commit()
    con.close()


def _page_exists(db_path, title: str) -> bool:
    con = sqlite3.connect(db_path)
    row = con.execute("SELECT 1 FROM pages WHERE title = ?",
                      (title,)).fetchone()
    con.close()
    return row is not None


def _daily_title(days_ago: int) -> str:
    return title_for_date(date.today() - timedelta(days=days_ago))


def test_deletes_zero_block_past_daily(client, seeded_config):
    title = _daily_title(2)
    _insert_page(seeded_config.db_path, 90, title)

    r = client.post("/api/journal/cleanup")

    assert r.status_code == 200
    assert r.json() == {"deleted": [title]}
    assert not _page_exists(seeded_config.db_path, title)


def test_deletes_whitespace_only_daily_and_purges_fts(client, seeded_config):
    title = _daily_title(3)
    _insert_page(seeded_config.db_path, 91, title,
                 [("uid_w1", "   "), ("uid_w2", "\t")])

    r = client.post("/api/journal/cleanup")

    assert title in r.json()["deleted"]
    assert not _page_exists(seeded_config.db_path, title)
    con = sqlite3.connect(seeded_config.db_path)
    orphans = con.execute(
        "SELECT rowid FROM blocks_fts WHERE rowid NOT IN"
        " (SELECT rowid FROM blocks)").fetchall()
    con.close()
    assert orphans == []  # blocks_fts_ad fired for the deleted blocks


def test_spares_todays_empty_page(client, seeded_config):
    today_title = title_for_date(date.today())
    # the journal endpoint auto-creates today's page
    client.get("/api/journal?days=1")
    assert _page_exists(seeded_config.db_path, today_title)

    r = client.post("/api/journal/cleanup")

    assert today_title not in r.json()["deleted"]
    assert _page_exists(seeded_config.db_path, today_title)


def test_spares_daily_with_content(client, seeded_config):
    title = _daily_title(4)
    _insert_page(seeded_config.db_path, 92, title, [("uid_c1", "real note")])

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_spares_daily_whose_blank_block_is_referenced(client, seeded_config):
    title = _daily_title(5)
    _insert_page(seeded_config.db_path, 93, title, [("uid_r1", "  ")])
    # a block on another page (seeded page id 2, "AI") embeds ((uid_r1))
    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)",
        ("uid_r2", 2, None, 5, "see ((uid_r1))", None, 0, None, None))
    con.commit()
    con.close()

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_ignores_empty_daily_older_than_a_week(client, seeded_config):
    title = _daily_title(8)
    _insert_page(seeded_config.db_path, 94, title)

    r = client.post("/api/journal/cleanup")

    assert r.json() == {"deleted": []}
    assert _page_exists(seeded_config.db_path, title)


def test_second_call_is_a_noop(client, seeded_config):
    _insert_page(seeded_config.db_path, 95, _daily_title(2))

    assert client.post("/api/journal/cleanup").json()["deleted"] != []
    assert client.post("/api/journal/cleanup").json() == {"deleted": []}


def test_cleanup_requires_auth(anon_client):
    assert anon_client.post("/api/journal/cleanup").status_code == 401
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_journal_cleanup.py -q`
Expected: FAIL — every test (except auth) gets 404/405 from the missing route.
(`test_cleanup_requires_auth` may pass already since auth wraps the whole
router — that's fine.)

- [ ] **Step 3: Implement the route**

In `server/src/pkm/server/routes_pages.py`:

Extend the daily import (line 14):

```python
from pkm.server.daily import (
    date_for_title, is_page_empty, past_week_dates, title_for_date)
```

Append after `get_journal` at the end of the file:

```python
def _block_is_referenced(db: sqlite3.Connection, uid: str,
                         page_id: int) -> bool:
    """True if any block on another page embeds ((uid)). LIKE treats '_' in
    uids as a wildcard; a false positive only spares a page, so that's an
    acceptable (conservative) inaccuracy."""
    return db.execute(
        "SELECT 1 FROM blocks WHERE page_id != ? AND text LIKE ? LIMIT 1",
        (page_id, f"%(({uid}))%")).fetchone() is not None


@router.post("/api/journal/cleanup")
def cleanup_journal(db: sqlite3.Connection = Depends(get_db)) -> dict:
    """Deletes completely-empty daily pages from the 7 days before today
    (today is spared: the journal auto-creates it for composing). Stateless:
    every call re-checks the whole window, so a page emptied later by block
    moves is caught on the next load. A page whose blank block is still
    ((referenced)) from another page is spared -- deleting it would leave
    the reference dangling."""
    deleted: list[str] = []
    for d in past_week_dates(date.today()):
        title = title_for_date(d)
        page = fetch_page(db, title)
        if page is None:
            continue
        blocks = db.execute(
            "SELECT uid, text FROM blocks WHERE page_id = ?",
            (page["id"],)).fetchall()
        if not is_page_empty([r["text"] for r in blocks]):
            continue
        if any(_block_is_referenced(db, r["uid"], page["id"])
               for r in blocks):
            continue
        delete_page_rows(db, page["id"], title)
        deleted.append(title)
    db.commit()
    return {"deleted": deleted}
```

(No `response_model`: matches the delete route, which also returns a plain
dict.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_journal_cleanup.py -q`
Expected: all PASS

- [ ] **Step 5: Run the full server suite, type check, lint**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: all green

- [ ] **Step 6: Commit**

```bash
git status -sb
git add server/src/pkm/server/routes_pages.py server/tests/test_journal_cleanup.py
git commit -m "feat(server): POST /api/journal/cleanup deletes empty past-week dailies (pkm-c3kz)"
```

---

### Task 4: Journal fires cleanup on mount

**Files:**
- Modify: `web/src/views/Journal.tsx`
- Test: `web/src/views/Journal.test.tsx`

**Interfaces:**
- Consumes: `POST /api/journal/cleanup` (Task 3); existing `apiFetch` from `../api/client`.
- Produces: nothing downstream.

Background for the test changes: `stubFetch` returns 404 for unmatched URLs,
and the cleanup call swallows errors, so most existing Journal tests pass
untouched. The exception is `"discards a stale in-flight load..."`, which
stubs fetch with `vi.fn()` directly and asserts `toHaveBeenCalledTimes(2)` —
the new cleanup POST makes that 3 total. Fix by counting journal *loads* only.

- [ ] **Step 1: Write the failing test**

Append to `web/src/views/Journal.test.tsx`:

```tsx
it("fires the empty-daily cleanup once on mount", async () => {
  const fetchMock = stubFetch([
    ["/api/journal/cleanup", { deleted: [] }],
    ["/api/journal?days=5", { days: [day("2026-07-08", "July 8th, 2026")] }],
  ]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><Journal /></MemoryRouter>);
  await screen.findByRole("link", { name: "July 8th, 2026" });

  const cleanups = fetchMock.mock.calls.filter(
    ([url]) => String(url) === "/api/journal/cleanup");
  expect(cleanups).toEqual([["/api/journal/cleanup", { method: "POST" }]]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && pnpm test -- --run src/views/Journal.test.tsx`
Expected: the new test FAILS (`cleanups` is `[]`); existing tests pass.

- [ ] **Step 3: Implement the mount call**

In `web/src/views/Journal.tsx`, directly after the existing mount effects
(lines 61–62), add:

```tsx
  // Fire-and-forget: prune empty daily pages from the past week (pkm-c3kz).
  // Failures are silent; the next Journal load retries. Runs after the
  // loadMore effect above, so the journal GET is always the first fetch.
  useEffect(() => {
    void apiFetch("/api/journal/cleanup", { method: "POST" })
      .catch(() => {});
  }, []);
```

- [ ] **Step 4: Fix the stale-load test's call count**

In `web/src/views/Journal.test.tsx`, in the test
`"discards a stale in-flight load when a resync resets the journal"`,
replace:

```tsx
  // exactly two loads: the gated original and the resync reload
  expect(fetchMock).toHaveBeenCalledTimes(2);
```

with:

```tsx
  // exactly two journal loads: the gated original and the resync reload
  // (the mount also fires one /api/journal/cleanup POST, excluded here)
  const journalLoads = fetchMock.mock.calls.filter(
    ([url]) => String(url).startsWith("/api/journal?"));
  expect(journalLoads).toHaveLength(2);
```

- [ ] **Step 5: Run the web suite and type check**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: all green

- [ ] **Step 6: Commit**

```bash
git status -sb
git add web/src/views/Journal.tsx web/src/views/Journal.test.tsx
git commit -m "feat(web): Journal fires empty-daily cleanup on mount (pkm-c3kz)"
```

---

### Task 5: Final verification and integration

**Files:**
- Modify: `.beans/pkm-c3kz--auto-delete-empty-daily-note-pages-on-journal-load.md` (via `beans update`)

**Interfaces:**
- Consumes: everything above.
- Produces: merged, pushed, verified feature.

- [ ] **Step 1: Run all verification commands from the repo root**

```bash
cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check
cd ../web && pnpm test -- --run && pnpm typecheck
```

Expected: all green. Do not claim completion otherwise.

- [ ] **Step 2: Update and complete the bean**

```bash
beans update pkm-c3kz --body-append "## Summary of Changes

- POST /api/journal/cleanup deletes completely-empty daily pages from the 7 days before today (today spared; blank-but-((referenced)) blocks spare their page).
- Deletion path shared with DELETE /api/page via store.delete_page_rows.
- Journal fires the cleanup fire-and-forget on mount.
- Spec: docs/superpowers/specs/2026-07-12-empty-daily-cleanup-design.md" -s completed
```

- [ ] **Step 3: Commit the bean, merge --no-ff to main, push**

```bash
git status -sb
git add .beans/pkm-c3kz--auto-delete-empty-daily-note-pages-on-journal-load.md
git commit -m "chore(beans): complete pkm-c3kz"
git checkout main && git pull --ff-only
git merge --no-ff feat/empty-daily-cleanup -m "Merge branch 'feat/empty-daily-cleanup': auto-delete empty dailies (pkm-c3kz)"
git push
```
