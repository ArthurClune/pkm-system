---
# pkm-m4an
title: Linked reference view filters
status: todo
type: feature
priority: normal
created_at: 2026-07-14T19:43:08Z
updated_at: 2026-07-14T19:51:57Z
---


In the "Linked References" section at the end of a page, we should be able to filter on attributes (e.g. filter out '#Paper'). Targets should be to filter on any page reference/tag. No need to filter at a lower level. So if we're on the 'Claude' page, one backlink that will show is

[Constitutional Classifiers++: Efficient Production-Grade Defenses against Universal Jailbreaks](https://arxiv.org/abs/2601.04603) #Paper #Claude #[[Constitutional AI]]

and we should be able to filter for/filter out this on '#Paper', '#[[Constitutional AI]]' etc

## Design

Spec: `docs/superpowers/specs/2026-07-18-linked-refs-filter-design.md` —
Roam-style chip panel, ephemeral, fully client-side (load-all backlinks on
panel open, filter via `extractRefs` over item text + breadcrumb ancestors).
