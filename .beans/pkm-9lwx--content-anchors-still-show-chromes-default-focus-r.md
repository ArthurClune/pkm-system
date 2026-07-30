---
# pkm-9lwx
title: Content anchors still show Chrome's default focus ring
status: todo
type: bug
priority: normal
created_at: 2026-07-30T14:07:37Z
updated_at: 2026-07-30T14:07:37Z
---

Found while verifying pkm-cq32 live. That bean themed the app's *controls* — the top-bar ghost buttons, the left nav, the block/page menus, the panel closes. Ordinary content anchors were deliberately left out of its scope, and they still get Chrome's `1px auto rgb(0, 95, 204)`:

- `a.page-link` — `[[page links]]` inside blocks
- the classless `.page-title > a` in journal day headers (measured: tab stop 12 on the journal view)
- `a` with `--color-link-ext` (external links)

Same clash pkm-0wg9 fixed for buttons: blue against an orange/`#c25a28` palette. Keeping it out of pkm-cq32 was a scope call, not a judgement that it is fine.

Worth deciding deliberately rather than reflexively adding `outline: 2px solid var(--color-link)` everywhere: links sit *inside* text, so a 2px ring with 1px offset will overlap adjacent lines at the block line-height, and a wrapped link gets a ring per line box. An underline-based or `outline-offset: 0` treatment may read better in prose than the control ring does.

Related: pkm-04hh (a broader page-title a11y bean) was scrapped 2026-07-30 in favour of a full review tracked separately, so this may belong under that review rather than as a standalone fix.

- [ ] Decide the treatment for in-prose links (control ring vs something quieter)
- [ ] Check the wrapped-link and adjacent-line cases at the real block line-height
- [ ] Cover internal, external and page-title anchors
- [ ] Guard in `web/src/styles.test.ts`
- [ ] Verify by tabbing a page with links in both themes
