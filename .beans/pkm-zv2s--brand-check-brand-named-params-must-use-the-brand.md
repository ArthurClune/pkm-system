---
# pkm-zv2s
title: 'Brand check: brand-named params must use the brand; brands minted only at declared sites'
status: todo
type: feature
created_at: 2026-10-16T18:03:46Z
updated_at: 2026-10-16T18:03:46Z
---

A type checker cannot catch a GoodlinksId passed through a str parameter (pkm-6rx1). Add a brand registry naming, per brand, its mint sites and the parameter/field names that must carry it. Two rules: (1) a parameter or field with a registered name must use the brand (line-level opt-out for untrusted route params that are parsed); (2) the brand constructor / `as Brand` cast appears only in its mint files and tests. Server: Python AST rule in the commit-time check being added alongside the comment check (bean ids / line numbers in comments). Web: eslint no-restricted-syntax selectors generated from the same registry, with lintConfig fixtures. Must also run from pytest and pnpm verify, not only the commit hook. Wait for the comment-check work to land, then build into its framework.
