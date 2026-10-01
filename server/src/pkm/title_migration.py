# pattern: Functional Core
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal, Mapping

from pkm.contracts.ops import Sha256Hex
from pkm.refs import (CanonicalTitle, RefKind, is_blank_title,
                      target_canonical_title, title_syntax_reason)


@dataclass(frozen=True)
class InventoryPage:
    page_id: int
    title: CanonicalTitle


@dataclass(frozen=True)
class InventoryBlock:
    uid: str
    page_id: int
    parent_uid: str | None
    order_idx: int
    text: str


@dataclass(frozen=True)
class InventoryRef:
    src_block_uid: str
    target_page_id: int
    kind: RefKind


@dataclass(frozen=True)
class InventorySidebar:
    sidebar_id: int
    title: CanonicalTitle
    order_idx: int


@dataclass(frozen=True)
class TitleMigrationInventory:
    active: bool
    pages: tuple[InventoryPage, ...]
    blocks: tuple[InventoryBlock, ...]
    refs: tuple[InventoryRef, ...]
    sidebars: tuple[InventorySidebar, ...]


TitleMigrationBlockerReason = Literal["all_space", "forbidden_syntax"]


@dataclass(frozen=True)
class TitleMigrationBlocker:
    page_id: int
    title: CanonicalTitle
    reason: TitleMigrationBlockerReason


@dataclass(frozen=True)
class TitleMigrationGroup:
    canonical_title: CanonicalTitle
    survivor: InventoryPage
    sources: tuple[InventoryPage, ...]
    has_clean_twin: bool
    block_count: int
    inbound_ref_count: int
    sidebar_count: int


@dataclass(frozen=True)
class TitleMigrationPlan:
    active: bool
    pages: tuple[InventoryPage, ...]
    blocks: tuple[InventoryBlock, ...]
    refs: tuple[InventoryRef, ...]
    sidebars: tuple[InventorySidebar, ...]
    groups: tuple[TitleMigrationGroup, ...]
    blockers: tuple[TitleMigrationBlocker, ...]
    replacements: Mapping[CanonicalTitle, CanonicalTitle]
    page_count: int
    block_count: int
    ref_count: int
    sidebar_count: int
    digest: Sha256Hex


def _plan_payload(
    *, active: bool, pages: tuple[InventoryPage, ...],
    blocks: tuple[InventoryBlock, ...], refs: tuple[InventoryRef, ...],
    sidebars: tuple[InventorySidebar, ...],
    groups: tuple[TitleMigrationGroup, ...],
    blockers: tuple[TitleMigrationBlocker, ...],
    replacements: Mapping[CanonicalTitle, CanonicalTitle],
    page_count: int, block_count: int, ref_count: int, sidebar_count: int,
) -> dict[str, Any]:
    """The pre-digest fields a `TitleMigrationPlan` is built from, taken as
    plain arguments rather than the finished dataclass: the digest this
    feeds is itself one of that dataclass's fields, so a caller computing
    it can't yet have a complete instance to read from."""
    return {
        "active": active,
        "blockers": [
            {
                "page_id": blocker.page_id,
                "reason": blocker.reason,
                "title": blocker.title,
            }
            for blocker in blockers
        ],
        "blocks": [
            {
                "order_idx": block.order_idx,
                "page_id": block.page_id,
                "parent_uid": block.parent_uid,
                "text": block.text,
                "uid": block.uid,
            }
            for block in blocks
        ],
        "counts": {
            "blockers": len(blockers),
            "blocks": block_count,
            "groups": len(groups),
            "pages": page_count,
            "refs": ref_count,
            "replacements": len(replacements),
            "sidebars": sidebar_count,
        },
        "groups": [
            {
                "block_count": group.block_count,
                "canonical_title": group.canonical_title,
                "has_clean_twin": group.has_clean_twin,
                "inbound_ref_count": group.inbound_ref_count,
                "sidebar_count": group.sidebar_count,
                "sources": [
                    {"page_id": page.page_id, "title": page.title}
                    for page in group.sources
                ],
                "survivor": {
                    "page_id": group.survivor.page_id,
                    "title": group.survivor.title,
                },
            }
            for group in groups
        ],
        "pages": [
            {"page_id": page.page_id, "title": page.title}
            for page in pages
        ],
        "refs": [
            {
                "kind": ref.kind,
                "src_block_uid": ref.src_block_uid,
                "target_page_id": ref.target_page_id,
            }
            for ref in refs
        ],
        "replacements": [
            {"source": source, "target": target}
            for source, target in replacements.items()
        ],
        "sidebars": [
            {
                "order_idx": sidebar.order_idx,
                "sidebar_id": sidebar.sidebar_id,
                "title": sidebar.title,
            }
            for sidebar in sidebars
        ],
        "version": 2,
    }


def _plan_digest(payload: dict[str, Any]) -> Sha256Hex:
    encoded = json.dumps(
        payload,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return Sha256Hex(hashlib.sha256(encoded).hexdigest())


def build_title_migration_plan(inventory: TitleMigrationInventory) -> TitleMigrationPlan:
    pages = tuple(sorted(inventory.pages, key=lambda page: page.page_id))
    blocks = tuple(sorted(inventory.blocks, key=lambda block: block.uid))
    refs = tuple(sorted(
        inventory.refs,
        key=lambda ref: (ref.src_block_uid, ref.target_page_id, ref.kind),
    ))
    sidebars = tuple(sorted(inventory.sidebars, key=lambda sidebar: sidebar.sidebar_id))

    pages_by_stored_title = {page.title: page for page in pages}
    padded_groups: dict[CanonicalTitle, list[InventoryPage]] = {}
    blockers: list[TitleMigrationBlocker] = []
    for page in pages:
        canonical = target_canonical_title(page.title)
        if is_blank_title(canonical):
            blockers.append(TitleMigrationBlocker(
                page.page_id, page.title, "all_space"
            ))
        elif title_syntax_reason(canonical) is not None:
            blockers.append(TitleMigrationBlocker(
                page.page_id, page.title, "forbidden_syntax"
            ))
        elif page.title != canonical:
            padded_groups.setdefault(canonical, []).append(page)

    groups: list[TitleMigrationGroup] = []
    replacements: dict[CanonicalTitle, CanonicalTitle] = {}
    for canonical_title, group_pages in padded_groups.items():
        clean_twin = pages_by_stored_title.get(canonical_title)
        survivor = clean_twin or min(group_pages, key=lambda page: page.page_id)
        pages_in_group = list(group_pages)
        if clean_twin is not None:
            pages_in_group.append(clean_twin)
        sources = tuple(sorted(
            (page for page in pages_in_group if page != survivor),
            key=lambda page: page.page_id,
        ))
        page_ids = {page.page_id for page in pages_in_group}
        page_titles = {page.title for page in pages_in_group}
        groups.append(TitleMigrationGroup(
            canonical_title=canonical_title,
            survivor=survivor,
            sources=sources,
            has_clean_twin=clean_twin is not None,
            block_count=sum(block.page_id in page_ids for block in blocks),
            inbound_ref_count=sum(ref.target_page_id in page_ids for ref in refs),
            sidebar_count=sum(sidebar.title in page_titles for sidebar in sidebars),
        ))
        for page in pages_in_group:
            if page.title != canonical_title:
                replacements[page.title] = canonical_title

    groups.sort(key=lambda group: (group.canonical_title, group.survivor.page_id))
    blockers.sort(key=lambda blocker: (
        blocker.title, blocker.page_id, blocker.reason
    ))
    frozen_groups = tuple(groups)
    frozen_blockers = tuple(blockers)
    frozen_replacements: Mapping[CanonicalTitle, CanonicalTitle] = (
        MappingProxyType(dict(sorted(replacements.items()))))
    payload = _plan_payload(
        active=inventory.active,
        pages=pages,
        blocks=blocks,
        refs=refs,
        sidebars=sidebars,
        groups=frozen_groups,
        blockers=frozen_blockers,
        replacements=frozen_replacements,
        page_count=len(pages),
        block_count=len(blocks),
        ref_count=len(refs),
        sidebar_count=len(sidebars),
    )
    return TitleMigrationPlan(
        active=inventory.active,
        pages=pages,
        blocks=blocks,
        refs=refs,
        sidebars=sidebars,
        groups=frozen_groups,
        blockers=frozen_blockers,
        replacements=frozen_replacements,
        page_count=len(pages),
        block_count=len(blocks),
        ref_count=len(refs),
        sidebar_count=len(sidebars),
        digest=_plan_digest(payload),
    )
