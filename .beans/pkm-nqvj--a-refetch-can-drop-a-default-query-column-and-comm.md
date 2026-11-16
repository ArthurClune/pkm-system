---
# pkm-nqvj
title: A refetch can drop a default query column and commit its open cell
status: todo
type: bug
created_at: 2026-11-16T11:19:19Z
updated_at: 2026-11-16T11:19:19Z
---

In a query view nobody has touched, the columns come from the records (queryDefaults' defaultColumns). A resync refetch that no longer returns any record holding a key removes that column, so an open cell in it unmounts and DataTable commits its draft, the same jump the frozen-row hold prevents for rows. Found while fixing the vanishing held row; predates it. Likely fix: while a cell edit freezes the view, keep the columns it had.
