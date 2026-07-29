---
# pkm-mrru
title: Style /files buttons and inputs to match main app
status: todo
type: feature
created_at: 2026-07-29T16:13:01Z
updated_at: 2026-07-29T16:13:01Z
---

The file explorer (/files, web/src/views/Files.tsx) uses mostly unstyled native buttons and input boxes. Give them basic CSS so they match the overall look of the main app.

- Buttons (e.g. 'Scan for undescribed files', delete/export actions) should use the app's existing button styling — reuse the design tokens from the design-polish epic (--radius-*, .btn-secondary) rather than inventing new styles
- Search/filter input boxes need matching treatment
- Keep it consistent in light and dark themes
