import hashlib
import json
from dataclasses import replace

from pkm.title_migration import (
    InventoryBlock,
    InventoryPage,
    InventoryRef,
    InventorySidebar,
    TitleMigrationInventory,
    build_title_migration_plan,
)


def _inventory(
    *pages: InventoryPage,
    active: bool = False,
    blocks: tuple[InventoryBlock, ...] = (),
    refs: tuple[InventoryRef, ...] = (),
    sidebars: tuple[InventorySidebar, ...] = (),
) -> TitleMigrationInventory:
    return TitleMigrationInventory(
        active=active,
        pages=pages,
        blocks=blocks,
        refs=refs,
        sidebars=sidebars,
    )


def _digest_inventory() -> TitleMigrationInventory:
    return _inventory(
        InventoryPage(page_id=2, title=" Acme"),
        InventoryPage(page_id=9, title="Inbound"),
        InventoryPage(page_id=1, title="Acme"),
        InventoryPage(page_id=3, title="Acme "),
        blocks=(
            InventoryBlock(uid="source-root", page_id=2, parent_uid=None, order_idx=0, text="source"),
            InventoryBlock(uid="target-root", page_id=1, parent_uid=None, order_idx=0, text="target"),
            InventoryBlock(
                uid="inbound",
                page_id=9,
                parent_uid=None,
                order_idx=0,
                text="[[ Acme]] and [[Acme ]]",
            ),
        ),
        refs=(
            InventoryRef(src_block_uid="inbound", target_page_id=3, kind="link"),
            InventoryRef(src_block_uid="inbound", target_page_id=2, kind="link"),
        ),
        sidebars=(InventorySidebar(sidebar_id=4, title="Acme ", order_idx=7),),
    )


def _expected_digest(inventory: TitleMigrationInventory) -> str:
    pages = sorted(inventory.pages, key=lambda page: page.page_id)
    blocks = sorted(inventory.blocks, key=lambda block: block.uid)
    refs = sorted(inventory.refs, key=lambda ref: (ref.src_block_uid, ref.target_page_id, ref.kind))
    sidebars = sorted(inventory.sidebars, key=lambda sidebar: sidebar.sidebar_id)
    clean_pages = {page.title: page for page in pages}

    blockers: list[dict[str, int | str]] = []
    groups: list[dict[str, object]] = []
    replacements: list[dict[str, str]] = []
    seen_canonicals: list[str] = []
    for page in pages:
        canonical = page.title.strip(" ")
        if page.title == canonical:
            continue
        if canonical == "":
            blockers.append({"page_id": page.page_id, "title": page.title})
            continue
        if canonical not in seen_canonicals:
            seen_canonicals.append(canonical)

    for canonical in sorted(seen_canonicals):
        padded_pages = [page for page in pages if page.title != page.title.strip(" ") and page.title.strip(" ") == canonical]
        clean_twin = clean_pages.get(canonical)
        survivor = clean_twin or min(padded_pages, key=lambda page: page.page_id)
        group_pages = list(padded_pages)
        if clean_twin is not None:
            group_pages.append(clean_twin)
        group_ids = {page.page_id for page in group_pages}
        group_titles = {page.title for page in group_pages}
        sources = sorted(
            (page for page in group_pages if page != survivor),
            key=lambda page: page.page_id,
        )
        groups.append(
            {
                "block_count": sum(block.page_id in group_ids for block in blocks),
                "canonical_title": canonical,
                "has_clean_twin": clean_twin is not None,
                "inbound_ref_count": sum(ref.target_page_id in group_ids for ref in refs),
                "sidebar_count": sum(sidebar.title in group_titles for sidebar in sidebars),
                "sources": [
                    {"page_id": source.page_id, "title": source.title}
                    for source in sources
                ],
                "survivor": {"page_id": survivor.page_id, "title": survivor.title},
            }
        )
        for group_page in group_pages:
            if group_page.title != canonical:
                replacements.append({"source": group_page.title, "target": canonical})

    payload = {
        "active": inventory.active,
        "blockers": sorted(blockers, key=lambda blocker: (blocker["title"], blocker["page_id"])),
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
            "blocks": len(blocks),
            "groups": len(groups),
            "pages": len(pages),
            "refs": len(refs),
            "replacements": len(replacements),
            "sidebars": len(sidebars),
        },
        "groups": sorted(groups, key=lambda group: (group["canonical_title"], group["survivor"]["page_id"])),
        "pages": [{"page_id": page.page_id, "title": page.title} for page in pages],
        "refs": [
            {
                "kind": ref.kind,
                "src_block_uid": ref.src_block_uid,
                "target_page_id": ref.target_page_id,
            }
            for ref in refs
        ],
        "replacements": sorted(replacements, key=lambda replacement: replacement["source"]),
        "sidebars": [
            {
                "order_idx": sidebar.order_idx,
                "sidebar_id": sidebar.sidebar_id,
                "title": sidebar.title,
            }
            for sidebar in sidebars
        ],
        "version": 1,
    }
    encoded = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def test_build_title_migration_plan_groups_padded_titles_deterministically():
    plan = build_title_migration_plan(
        _inventory(
            InventoryPage(page_id=7, title="\u00a0Gamma\u00a0"),
            InventoryPage(page_id=2, title=" Acme"),
            InventoryPage(page_id=5, title=" Beta"),
            InventoryPage(page_id=1, title="Acme"),
            InventoryPage(page_id=4, title="Beta "),
            InventoryPage(page_id=8, title=" acme"),
            InventoryPage(page_id=6, title=" "),
            InventoryPage(page_id=3, title="Acme "),
        )
    )

    assert [group.canonical_title for group in plan.groups] == ["Acme", "Beta", "acme"]

    acme, beta, lower = plan.groups

    assert acme.has_clean_twin is True
    assert acme.survivor == InventoryPage(page_id=1, title="Acme")
    assert acme.sources == (
        InventoryPage(page_id=2, title=" Acme"),
        InventoryPage(page_id=3, title="Acme "),
    )

    assert beta.has_clean_twin is False
    assert beta.survivor == InventoryPage(page_id=4, title="Beta ")
    assert beta.sources == (InventoryPage(page_id=5, title=" Beta"),)

    assert lower.has_clean_twin is False
    assert lower.survivor == InventoryPage(page_id=8, title=" acme")
    assert lower.sources == ()

    assert plan.blockers == (InventoryPage(page_id=6, title=" "),)
    assert plan.replacements == {
        " Acme": "Acme",
        "Acme ": "Acme",
        "Beta ": "Beta",
        " Beta": "Beta",
        " acme": "acme",
    }
    assert "\u00a0Gamma\u00a0" not in plan.replacements
    assert plan.active is False


def test_build_title_migration_plan_digest_is_canonical_and_order_independent():
    inventory = _digest_inventory()
    reordered = _inventory(
        InventoryPage(page_id=3, title="Acme "),
        InventoryPage(page_id=1, title="Acme"),
        InventoryPage(page_id=9, title="Inbound"),
        InventoryPage(page_id=2, title=" Acme"),
        blocks=(
            InventoryBlock(
                uid="inbound",
                page_id=9,
                parent_uid=None,
                order_idx=0,
                text="[[ Acme]] and [[Acme ]]",
            ),
            InventoryBlock(uid="target-root", page_id=1, parent_uid=None, order_idx=0, text="target"),
            InventoryBlock(uid="source-root", page_id=2, parent_uid=None, order_idx=0, text="source"),
        ),
        refs=(
            InventoryRef(src_block_uid="inbound", target_page_id=2, kind="link"),
            InventoryRef(src_block_uid="inbound", target_page_id=3, kind="link"),
        ),
        sidebars=(InventorySidebar(sidebar_id=4, title="Acme ", order_idx=7),),
    )

    plan = build_title_migration_plan(inventory)
    reordered_plan = build_title_migration_plan(reordered)

    assert plan.digest == _expected_digest(inventory)
    assert reordered_plan.digest == _expected_digest(reordered)
    assert plan.digest == reordered_plan.digest
    assert len(plan.digest) == 64


def test_build_title_migration_plan_digest_changes_when_relevant_data_changes():
    inventory = _digest_inventory()
    baseline = build_title_migration_plan(inventory).digest

    assert build_title_migration_plan(replace(inventory, active=True)).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        pages=(
            InventoryPage(page_id=2, title=" Acme"),
            InventoryPage(page_id=9, title="Inbound"),
            InventoryPage(page_id=1, title="Acme"),
            InventoryPage(page_id=3, title="Acne "),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        blocks=(
            InventoryBlock(uid="source-root", page_id=2, parent_uid=None, order_idx=0, text="source"),
            InventoryBlock(uid="target-root", page_id=1, parent_uid=None, order_idx=0, text="retitled"),
            InventoryBlock(
                uid="inbound",
                page_id=9,
                parent_uid=None,
                order_idx=0,
                text="[[ Acme]] and [[Acme ]]",
            ),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        blocks=(
            InventoryBlock(uid="source-root", page_id=2, parent_uid=None, order_idx=0, text="source"),
            InventoryBlock(uid="target-root", page_id=1, parent_uid=None, order_idx=1, text="target"),
            InventoryBlock(
                uid="inbound",
                page_id=9,
                parent_uid=None,
                order_idx=0,
                text="[[ Acme]] and [[Acme ]]",
            ),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        blocks=(
            InventoryBlock(uid="source-root", page_id=2, parent_uid=None, order_idx=0, text="source"),
            InventoryBlock(uid="target-root", page_id=1, parent_uid="source-root", order_idx=0, text="target"),
            InventoryBlock(
                uid="inbound",
                page_id=9,
                parent_uid=None,
                order_idx=0,
                text="[[ Acme]] and [[Acme ]]",
            ),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        refs=(
            InventoryRef(src_block_uid="inbound", target_page_id=3, kind="tag"),
            InventoryRef(src_block_uid="inbound", target_page_id=2, kind="link"),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        sidebars=(InventorySidebar(sidebar_id=4, title="Acme ", order_idx=8),),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        refs=(InventoryRef(src_block_uid="inbound", target_page_id=2, kind="link"),),
    )).digest != baseline
