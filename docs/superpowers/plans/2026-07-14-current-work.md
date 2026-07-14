# Current Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/current-work` page linked under Daily Notes that shows exclusive buckets for pages changed in the last 24 hours, 24–48 hours, and 48 hours–7 days.

**Architecture:** Add a read-only server endpoint and matching offline replica handler that compute grouped page metadata from `pages.updated_at`. Add a React view and app route that render the grouped payload with page links.

**Tech Stack:** FastAPI, Pydantic, SQLite, React, TypeScript, Vitest, pytest.

## Global Constraints

- Use exclusive buckets: 0–24h, 24–48h, 48h–7d.
- Sort pages within each bucket by `updated_at DESC`, then title.
- Omit pages with `updated_at IS NULL` or older than 7 days.
- Files with runtime behavior must declare FCIS pattern comments.
- Follow TDD: write failing tests before production code.

---

### Task 1: Server endpoint

**Files:**
- Modify: `server/src/pkm/server/response_models.py`
- Modify: `server/src/pkm/server/routes_pages.py`
- Test: `server/tests/test_current_work.py`

**Interfaces:**
- Produces: `GET /api/current-work` returning `{ sections: [{ id, title, pages: [{ id, title, updated_at }] }] }`.

- [ ] Write pytest tests for exclusive buckets, sorting, omissions, and auth.
- [ ] Run `cd server && uv run pytest -q tests/test_current_work.py` and confirm failures because endpoint is missing.
- [ ] Add Pydantic response models.
- [ ] Add `/api/current-work` route to `routes_pages.py`.
- [ ] Re-run `cd server && uv run pytest -q tests/test_current_work.py` and confirm pass.

### Task 2: Offline local API

**Files:**
- Modify: `web/src/replica/localApi/pages.ts`
- Modify: `web/src/replica/localApi/router.ts`
- Test: `web/src/replica/localApi/router.test.ts`

**Interfaces:**
- Consumes: current work payload shape from Task 1.
- Produces: local handler support for `GET /api/current-work`.

- [ ] Add a Vitest case for local current-work grouping.
- [ ] Run `cd web && pnpm vitest run src/replica/localApi/router.test.ts` and confirm failure because route is unhandled.
- [ ] Implement `currentWorkPayload(db, nowMs)` in `pages.ts`.
- [ ] Route `GET /api/current-work` in `router.ts`.
- [ ] Re-run the test and confirm pass.

### Task 3: React view and app navigation

**Files:**
- Create: `web/src/views/CurrentWork.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api/payloads.ts`
- Test: `web/src/views/CurrentWork.test.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `CurrentWorkPayload` from `/api/current-work`.
- Produces: `/current-work` route and left-nav link labelled `Current Work`.

- [ ] Add view tests for grouped links and empty sections.
- [ ] Add app test for the nav link and route.
- [ ] Run targeted web tests and confirm failure because the view/route do not exist.
- [ ] Implement `CurrentWork.tsx` with loading, error, and section rendering.
- [ ] Add payload type exports and app route/nav link.
- [ ] Re-run targeted web tests and confirm pass.

### Task 4: Verification and bean completion

**Files:**
- Modify: `.beans/pkm-h49t--current-work-page.md`

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: verified feature and completed bean.

- [ ] Run server tests, type check, and lint.
- [ ] Run web verification or targeted fallback if full verify is blocked.
- [ ] Update bean checklist and summary.
- [ ] Commit code, docs, tests, and bean file.
