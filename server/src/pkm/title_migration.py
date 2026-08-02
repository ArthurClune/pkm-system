# pattern: Functional Core
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Mapping

from pkm.refs import canonicalize_title
from pkm.rename import rewrite_title_refs_map


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
    blockers: tuple[InventoryPage, ...]
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
            {"page_id": page.page_id, "title": page.title}
            for page in plan.blockers
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
        "version": 1,
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
    blockers: list[InventoryPage] = []
    boundary_replacements: dict[str, str] = {}
    for page in pages:
        canonical = canonicalize_title(page.title, plain_space=True)
        if page.title == canonical:
            continue
        if canonical == "":
            blockers.append(page)
            continue
        padded_groups.setdefault(canonical, []).append(page)
        boundary_replacements[page.title] = canonical

    # Nested refs are overlapping identities: changing an inner source also
    # changes the spelling of every enclosing page title. Group by that final
    # spelling so an existing final twin wins and otherwise the same outer
    # survivor identity is retitled rather than duplicated during reindex.
    final_groups: dict[str, list[InventoryPage]] = {}
    intermediate_titles: dict[str, set[str]] = {}
    for boundary_title, group_pages in padded_groups.items():
        final_title = rewrite_title_refs_map(
            boundary_title, boundary_replacements
        )
        final_groups.setdefault(final_title, []).extend(group_pages)
        intermediate_titles.setdefault(final_title, set()).add(boundary_title)

    groups: list[TitleMigrationGroup] = []
    replacements: dict[str, str] = {}
    for canonical_title, group_pages in final_groups.items():
        exact_clean_twin = clean_pages.get(canonical_title)
        intermediate_clean = sorted(
            (
                clean_pages[title]
                for title in intermediate_titles[canonical_title]
                if title != canonical_title and title in clean_pages
            ),
            key=lambda page: page.page_id,
        )
        survivor = (
            exact_clean_twin
            or (intermediate_clean[0] if intermediate_clean else None)
            or min(group_pages, key=lambda page: page.page_id)
        )
        pages_by_id = {page.page_id: page for page in group_pages}
        for page in intermediate_clean:
            pages_by_id[page.page_id] = page
        if exact_clean_twin is not None:
            pages_by_id[exact_clean_twin.page_id] = exact_clean_twin
        pages_in_group = list(pages_by_id.values())
        sources = tuple(sorted(
            (page for page in pages_in_group if page != survivor),
            key=lambda page: page.page_id,
        ))
        page_ids = set(pages_by_id)
        page_titles = {page.title for page in pages_in_group}
        groups.append(TitleMigrationGroup(
            canonical_title=canonical_title,
            survivor=survivor,
            sources=sources,
            has_clean_twin=exact_clean_twin is not None,
            block_count=sum(block.page_id in page_ids for block in blocks),
            inbound_ref_count=sum(ref.target_page_id in page_ids for ref in refs),
            sidebar_count=sum(sidebar.title in page_titles for sidebar in sidebars),
        ))
        for page in pages_in_group:
            if page.title != canonical_title:
                replacements[page.title] = canonical_title

    groups.sort(key=lambda group: (group.canonical_title, group.survivor.page_id))
    blockers.sort(key=lambda page: (page.title, page.page_id))
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
