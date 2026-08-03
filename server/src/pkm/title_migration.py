# pattern: Functional Core
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal, Mapping

from pkm.refs import canonicalize_title, is_blank_title, title_syntax_reason


@dataclass(frozen=True)
class InventoryPage:
    page_id: int
    title: str


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
    kind: str


@dataclass(frozen=True)
class InventorySidebar:
    sidebar_id: int
    title: str
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
    title: str
    reason: TitleMigrationBlockerReason


@dataclass(frozen=True)
class TitleMigrationGroup:
    canonical_title: str
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
    replacements: Mapping[str, str]
    page_count: int
    block_count: int
    ref_count: int
    sidebar_count: int
    digest: str


def _plan_payload(plan: TitleMigrationPlan) -> dict[str, Any]:
    return {
        "active": plan.active,
        "blockers": [
            {
                "page_id": blocker.page_id,
                "reason": blocker.reason,
                "title": blocker.title,
            }
            for blocker in plan.blockers
        ],
        "blocks": [
            {
                "order_idx": block.order_idx,
                "page_id": block.page_id,
                "parent_uid": block.parent_uid,
                "text": block.text,
                "uid": block.uid,
            }
            for block in plan.blocks
        ],
        "counts": {
            "blockers": len(plan.blockers),
            "blocks": plan.block_count,
            "groups": len(plan.groups),
            "pages": plan.page_count,
            "refs": plan.ref_count,
            "replacements": len(plan.replacements),
            "sidebars": plan.sidebar_count,
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
            for group in plan.groups
        ],
        "pages": [
            {"page_id": page.page_id, "title": page.title}
            for page in plan.pages
        ],
        "refs": [
            {
                "kind": ref.kind,
                "src_block_uid": ref.src_block_uid,
                "target_page_id": ref.target_page_id,
            }
            for ref in plan.refs
        ],
        "replacements": [
            {"source": source, "target": target}
            for source, target in plan.replacements.items()
        ],
        "sidebars": [
            {
                "order_idx": sidebar.order_idx,
                "sidebar_id": sidebar.sidebar_id,
                "title": sidebar.title,
            }
            for sidebar in plan.sidebars
        ],
        "version": 2,
    }


def _plan_digest(plan: TitleMigrationPlan) -> str:
    encoded = json.dumps(
        _plan_payload(plan),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def build_title_migration_plan(inventory: TitleMigrationInventory) -> TitleMigrationPlan:
    pages = tuple(sorted(inventory.pages, key=lambda page: page.page_id))
    blocks = tuple(sorted(inventory.blocks, key=lambda block: block.uid))
    refs = tuple(sorted(
        inventory.refs,
        key=lambda ref: (ref.src_block_uid, ref.target_page_id, ref.kind),
    ))
    sidebars = tuple(sorted(inventory.sidebars, key=lambda sidebar: sidebar.sidebar_id))

    clean_pages = {page.title: page for page in pages}
    padded_groups: dict[str, list[InventoryPage]] = {}
    blockers: list[TitleMigrationBlocker] = []
    for page in pages:
        canonical = canonicalize_title(page.title, plain_space=True)
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
    replacements: dict[str, str] = {}
    for canonical_title, group_pages in padded_groups.items():
        clean_twin = clean_pages.get(canonical_title)
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
    plan = TitleMigrationPlan(
        active=inventory.active,
        pages=pages,
        blocks=blocks,
        refs=refs,
        sidebars=sidebars,
        groups=tuple(groups),
        blockers=tuple(blockers),
        replacements=MappingProxyType(dict(sorted(replacements.items()))),
        page_count=len(pages),
        block_count=len(blocks),
        ref_count=len(refs),
        sidebar_count=len(sidebars),
        digest="",
    )
    return TitleMigrationPlan(
        active=plan.active,
        pages=plan.pages,
        blocks=plan.blocks,
        refs=plan.refs,
        sidebars=plan.sidebars,
        groups=plan.groups,
        blockers=plan.blockers,
        replacements=plan.replacements,
        page_count=plan.page_count,
        block_count=plan.block_count,
        ref_count=plan.ref_count,
        sidebar_count=plan.sidebar_count,
        digest=_plan_digest(plan),
    )
