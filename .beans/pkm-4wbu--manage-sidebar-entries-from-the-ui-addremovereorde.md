---
# pkm-4wbu
title: Manage sidebar entries from the UI (add/remove/reorder)
status: todo
type: feature
created_at: 2026-07-09T21:28:48Z
updated_at: 2026-07-09T21:28:48Z
---

Follow-up to pkm-as55: the left-nav sidebar entries list (GET /api/sidebar) is read-only. Add UI + API (POST/PATCH/DELETE) to add, remove, and reorder entries, backed by the sidebar_entries table (server/src/pkm/schema.py).
