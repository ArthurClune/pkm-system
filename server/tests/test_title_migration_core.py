import hashlib
import json
from dataclasses import replace

from typing import Callable

from pkm.refs import CanonicalTitle, canonicalize_title
from pkm.title_migration import (
    InventoryBlock,
    InventoryPage,
    InventoryRef,
    InventorySidebar,
    TitleMigrationInventory,
    build_title_migration_plan,
    noncanonical_titles,
)
from pkm.test_data.ids import (canonical_title_of, order_idx_of,
                               page_id_of, sidebar_entry_id_of,
                               sidebar_order_idx_of, uid_of)


def _ct(title_text: str) -> CanonicalTitle:
    """InventoryPage/InventorySidebar.title is a row read from pages.title/
    sidebar_entries.title, so it's CanonicalTitle -- these fixtures mint it
    directly rather than running every title through the real
    canonicalizer."""
    return canonical_title_of(title_text)


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
        InventoryPage(page_id=page_id_of(2), title=_ct(" Acme")),
        InventoryPage(page_id=page_id_of(9), title=_ct("Inbound")),
        InventoryPage(page_id=page_id_of(1), title=_ct("Acme")),
        InventoryPage(page_id=page_id_of(3), title=_ct("Acme ")),
        blocks=(
            InventoryBlock(
                uid=uid_of("source-root"),
                page_id=page_id_of(2),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="source",
            ),
            InventoryBlock(
                uid=uid_of("target-root"),
                page_id=page_id_of(1),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="target",
            ),
            InventoryBlock(
                uid=uid_of("inbound"),
                page_id=page_id_of(9),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="[[ Acme]] and [[Acme ]]",
            ),
        ),
        refs=(
            InventoryRef(src_block_uid=uid_of("inbound"), target_page_id=page_id_of(3), kind="link"),
            InventoryRef(src_block_uid=uid_of("inbound"), target_page_id=page_id_of(2), kind="link"),
        ),
        sidebars=(InventorySidebar(
            sidebar_id=sidebar_entry_id_of(4), title=_ct("Acme "),
            order_idx=sidebar_order_idx_of(7)),),
    )


def _control_whitespace_inventory() -> TitleMigrationInventory:
    return _inventory(
        InventoryPage(page_id=page_id_of(6), title=_ct(" \nacme\t ")),
        InventoryPage(page_id=page_id_of(3), title=_ct(" \n\t ")),
        InventoryPage(page_id=page_id_of(4), title=_ct("\u00a0Acme\u00a0")),
        InventoryPage(page_id=page_id_of(1), title=_ct("Acme")),
        InventoryPage(page_id=page_id_of(5), title=_ct("acme")),
        InventoryPage(page_id=page_id_of(2), title=_ct(" \nAcme\t ")),
    )


def _expected_digest(inventory: TitleMigrationInventory) -> str:
    pages = sorted(inventory.pages, key=lambda page: page.page_id)
    blocks = sorted(inventory.blocks, key=lambda block: block.uid)
    refs = sorted(inventory.refs, key=lambda ref: (ref.src_block_uid, ref.target_page_id, ref.kind))
    sidebars = sorted(inventory.sidebars, key=lambda sidebar: sidebar.sidebar_id)
    clean_pages: dict[str, InventoryPage] = {page.title: page for page in pages}

    blockers: list[dict[str, int | str]] = []
    groups: list[dict[str, object]] = []
    replacements: list[dict[str, str]] = []
    seen_canonicals: list[str] = []
    for page in pages:
        canonical = page.title.strip(" ")
        if canonical == "":
            blockers.append({
                "page_id": page.page_id,
                "reason": "all_space",
                "title": page.title,
            })
            continue
        if "#" in canonical or "[[" in canonical or "]]" in canonical:
            blockers.append({
                "page_id": page.page_id,
                "reason": "forbidden_syntax",
                "title": page.title,
            })
            continue
        if page.title != canonical and canonical not in seen_canonicals:
            seen_canonicals.append(canonical)

    for canonical in sorted(seen_canonicals):
        padded_pages = [page for page in pages
                        if page.title != page.title.strip(" ") and page.title.strip(" ") == canonical]
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

    group_titles_all = {item["source"] for item in replacements} | set(
        seen_canonicals)
    sidebar_retitles = []
    for sidebar in sidebars:
        canonical = " ".join(sidebar.title.split())
        if (canonical != sidebar.title and canonical != ""
                and sidebar.title not in group_titles_all
                and not any(mark in canonical for mark in ("#", "[[", "]]"))
                and not canonical.endswith(("]", "["))):
            sidebar_retitles.append({
                "canonical_title": canonical,
                "sidebar_id": sidebar.sidebar_id,
                "title": sidebar.title,
            })
    sidebar_retitles.sort(key=lambda retitle: (
        retitle["title"], retitle["sidebar_id"]))

    payload = {
        "active": inventory.active,
        "blockers": sorted(
            blockers,
            key=lambda blocker: (
                blocker["title"],
                blocker["page_id"],
                blocker["reason"],
            ),
        ),
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
            "sidebar_retitles": len(sidebar_retitles),
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
        "sidebar_retitles": sidebar_retitles,
        "version": 3,
    }
    encoded = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def test_build_title_migration_plan_groups_padded_titles_deterministically():
    plan = build_title_migration_plan(
        _inventory(
            InventoryPage(page_id=page_id_of(7), title=_ct("\u00a0Gamma\u00a0")),
            InventoryPage(page_id=page_id_of(2), title=_ct(" Acme")),
            InventoryPage(page_id=page_id_of(5), title=_ct(" Beta")),
            InventoryPage(page_id=page_id_of(1), title=_ct("Acme")),
            InventoryPage(page_id=page_id_of(4), title=_ct("Beta ")),
            InventoryPage(page_id=page_id_of(8), title=_ct(" acme")),
            InventoryPage(page_id=page_id_of(6), title=_ct(" ")),
            InventoryPage(page_id=page_id_of(3), title=_ct("Acme ")),
        )
    )

    assert [group.canonical_title for group in plan.groups] == [
        "Acme", "Beta", "Gamma", "acme"]

    acme, beta, gamma, lower = plan.groups

    assert acme.has_clean_twin is True
    assert acme.survivor == InventoryPage(page_id=page_id_of(1), title=_ct("Acme"))
    assert acme.sources == (
        InventoryPage(page_id=page_id_of(2), title=_ct(" Acme")),
        InventoryPage(page_id=page_id_of(3), title=_ct("Acme ")),
    )

    assert beta.has_clean_twin is False
    assert beta.survivor == InventoryPage(page_id=page_id_of(4), title=_ct("Beta "))
    assert beta.sources == (InventoryPage(page_id=page_id_of(5), title=_ct(" Beta")),)

    # NBSP is title whitespace: an NBSP-edged title is retitled to its words.
    assert gamma.has_clean_twin is False
    assert gamma.survivor == InventoryPage(
        page_id=page_id_of(7), title=_ct("\u00a0Gamma\u00a0"))
    assert gamma.sources == ()

    assert lower.has_clean_twin is False
    assert lower.survivor == InventoryPage(page_id=page_id_of(8), title=_ct(" acme"))
    assert lower.sources == ()

    assert [
        (blocker.page_id, blocker.title, blocker.reason)
        for blocker in plan.blockers
    ] == [(6, " ", "all_space")]
    assert plan.replacements == {
        " Acme": "Acme",
        "Acme ": "Acme",
        "Beta ": "Beta",
        " Beta": "Beta",
        " acme": "acme",
        "\u00a0Gamma\u00a0": "Gamma",
    }
    assert plan.active is False


def test_plan_groups_pages_that_fold_to_one_spelling():
    """Pages whose titles differ only in a whitespace run share one
    spelling under the fold, so they merge like padded twins; a lone
    page with a wide space is retitled."""
    plan = build_title_migration_plan(
        _inventory(
            InventoryPage(page_id=page_id_of(1), title=_ct("A B")),
            InventoryPage(page_id=page_id_of(2), title=_ct("A  B")),
            InventoryPage(page_id=page_id_of(3), title=_ct("A\u00a0B")),
            InventoryPage(page_id=page_id_of(4), title=_ct("Lone\u3000Page")),
        )
    )

    assert [group.canonical_title for group in plan.groups] == [
        "A B", "Lone Page"]
    pair, lone = plan.groups
    assert pair.survivor == InventoryPage(
        page_id=page_id_of(1), title=_ct("A B"))
    assert pair.has_clean_twin is True
    assert [page.page_id for page in pair.sources] == [2, 3]
    assert lone.survivor == InventoryPage(
        page_id=page_id_of(4), title=_ct("Lone\u3000Page"))
    assert lone.has_clean_twin is False
    assert lone.sources == ()
    assert plan.blockers == ()
    assert plan.replacements == {
        "A  B": "A B",
        "A\u00a0B": "A B",
        "Lone\u3000Page": "Lone Page",
    }


def test_plan_retitles_every_noncanonical_sidebar_entry_no_group_covers():
    """A pinned spelling the rule changes is retitled whether its page is
    absent, canonical already, or not a page at all; an entry a group
    already moves, and one whose canonical form is no title, are not."""
    plan = build_title_migration_plan(
        _inventory(
            InventoryPage(page_id=page_id_of(1), title=_ct("Q R")),
            InventoryPage(page_id=page_id_of(2), title=_ct(" Acme")),
            active=True,
            sidebars=(
                InventorySidebar(sidebar_id=sidebar_entry_id_of(1),
                                 title=_ct("X  Y"),
                                 order_idx=sidebar_order_idx_of(0)),
                InventorySidebar(sidebar_id=sidebar_entry_id_of(2),
                                 title=_ct("Q\u00a0R"),
                                 order_idx=sidebar_order_idx_of(1)),
                InventorySidebar(sidebar_id=sidebar_entry_id_of(3),
                                 title=_ct("Q R"),
                                 order_idx=sidebar_order_idx_of(2)),
                InventorySidebar(sidebar_id=sidebar_entry_id_of(4),
                                 title=_ct(" Acme"),
                                 order_idx=sidebar_order_idx_of(3)),
                InventorySidebar(sidebar_id=sidebar_entry_id_of(5),
                                 title=_ct("\u3000"),
                                 order_idx=sidebar_order_idx_of(4)),
                InventorySidebar(sidebar_id=sidebar_entry_id_of(6),
                                 title=_ct("a]\u3000"),
                                 order_idx=sidebar_order_idx_of(5)),
            ),
        )
    )

    assert [group.canonical_title for group in plan.groups] == ["Acme"]
    assert [
        (retitle.sidebar_id, retitle.title, retitle.canonical_title)
        for retitle in plan.sidebar_retitles
    ] == [(2, "Q\u00a0R", "Q R"), (1, "X  Y", "X Y")]


def test_plan_digest_covers_sidebar_retitles():
    inventory = _inventory(
        InventoryPage(page_id=page_id_of(1), title=_ct("Q R")),
        active=True,
        sidebars=(InventorySidebar(sidebar_id=sidebar_entry_id_of(1),
                                   title=_ct("X  Y"),
                                   order_idx=sidebar_order_idx_of(0)),),
    )
    plan = build_title_migration_plan(inventory)

    assert plan.digest == _expected_digest(inventory)
    assert plan.digest != build_title_migration_plan(
        replace(inventory, sidebars=())).digest


def _reader(*, active: bool) -> Callable[[str], str]:
    return lambda text: canonicalize_title(text, plain_space=active)


def test_noncanonical_titles_lists_only_changed_titles():
    """Sorted and distinct; a title the live rule leaves alone is not
    listed, so inactive single-space padding stays quiet."""
    titles = ["A B", "A  B", " P ", "A  B"]

    assert noncanonical_titles(titles, _reader(active=True)) == (
        " P ", "A  B")
    assert noncanonical_titles(titles, _reader(active=False)) == ("A  B",)
    assert noncanonical_titles([], _reader(active=True)) == ()


def test_build_title_migration_plan_normalizes_control_whitespace_before_plain_space_grouping():
    """Mutation caught: replace canonicalize_title(..., plain_space=True) with
    title.strip(" ")."""
    plan = build_title_migration_plan(_control_whitespace_inventory())

    assert [group.canonical_title for group in plan.groups] == ["Acme", "acme"]

    acme, lower = plan.groups

    assert acme.survivor == InventoryPage(page_id=page_id_of(1), title=_ct("Acme"))
    assert acme.sources == (
        InventoryPage(page_id=page_id_of(2), title=_ct(" \nAcme\t ")),
        InventoryPage(page_id=page_id_of(4), title=_ct("\u00a0Acme\u00a0")),
    )
    assert acme.has_clean_twin is True

    assert lower.survivor == InventoryPage(page_id=page_id_of(5), title=_ct("acme"))
    assert lower.sources == (InventoryPage(page_id=page_id_of(6), title=_ct(" \nacme\t ")),)
    assert lower.has_clean_twin is True

    assert [
        (blocker.page_id, blocker.title, blocker.reason)
        for blocker in plan.blockers
    ] == [(3, " \n\t ", "all_space")]
    assert plan.replacements == {
        " \nAcme\t ": "Acme",
        " \nacme\t ": "acme",
        "\u00a0Acme\u00a0": "Acme",
    }


def test_build_title_migration_plan_digest_tracks_control_whitespace_groups_and_blockers():
    """Mutation caught: replace canonicalize_title(..., plain_space=True) with
    title.strip(" ")."""
    inventory = _control_whitespace_inventory()
    plan = build_title_migration_plan(inventory)

    payload = {
        "active": False,
        "blockers": [
            {"page_id": 3, "reason": "all_space", "title": " \n\t "}
        ],
        "blocks": [],
        "counts": {
            "blockers": 1,
            "blocks": 0,
            "groups": 2,
            "pages": 6,
            "refs": 0,
            "replacements": 3,
            "sidebar_retitles": 0,
            "sidebars": 0,
        },
        "groups": [
            {
                "block_count": 0,
                "canonical_title": "Acme",
                "has_clean_twin": True,
                "inbound_ref_count": 0,
                "sidebar_count": 0,
                "sources": [{"page_id": 2, "title": " \nAcme\t "},
                            {"page_id": 4, "title": "\u00a0Acme\u00a0"}],
                "survivor": {"page_id": 1, "title": "Acme"},
            },
            {
                "block_count": 0,
                "canonical_title": "acme",
                "has_clean_twin": True,
                "inbound_ref_count": 0,
                "sidebar_count": 0,
                "sources": [{"page_id": 6, "title": " \nacme\t "}],
                "survivor": {"page_id": 5, "title": "acme"},
            },
        ],
        "pages": [
            {"page_id": 1, "title": "Acme"},
            {"page_id": 2, "title": " \nAcme\t "},
            {"page_id": 3, "title": " \n\t "},
            {"page_id": 4, "title": "\u00a0Acme\u00a0"},
            {"page_id": 5, "title": "acme"},
            {"page_id": 6, "title": " \nacme\t "},
        ],
        "refs": [],
        "replacements": [
            {"source": " \nAcme\t ", "target": "Acme"},
            {"source": " \nacme\t ", "target": "acme"},
            {"source": "\u00a0Acme\u00a0", "target": "Acme"},
        ],
        "sidebar_retitles": [],
        "sidebars": [],
        "version": 3,
    }

    expected_digest = hashlib.sha256(
        json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()

    assert plan.digest == expected_digest


def test_build_title_migration_plan_classifies_and_orders_invalid_title_blockers():
    """Mutation caught: ignore unpadded syntax or group a padded forbidden
    title."""
    plan = build_title_migration_plan(
        _inventory(
            InventoryPage(page_id=page_id_of(9), title=_ct("   ")),
            InventoryPage(page_id=page_id_of(6), title=_ct("Bad #Title")),
            InventoryPage(page_id=page_id_of(5), title=_ct("Bad [[Title")),
            InventoryPage(page_id=page_id_of(4), title=_ct("Bad Title]]")),
            InventoryPage(page_id=page_id_of(3), title=_ct(" Bad #Title ")),
            InventoryPage(page_id=page_id_of(2), title=_ct("Valid")),
            InventoryPage(page_id=page_id_of(1), title=_ct("Valid ")),
        )
    )

    assert [group.canonical_title for group in plan.groups] == ["Valid"]
    assert plan.replacements == {"Valid ": "Valid"}
    assert [
        (blocker.page_id, blocker.title, blocker.reason)
        for blocker in plan.blockers
    ] == [
        (9, "   ", "all_space"),
        (3, " Bad #Title ", "forbidden_syntax"),
        (6, "Bad #Title", "forbidden_syntax"),
        (4, "Bad Title]]", "forbidden_syntax"),
        (5, "Bad [[Title", "forbidden_syntax"),
    ]


def test_build_title_migration_plan_digest_changes_when_blocker_changes_or_is_added():
    baseline = build_title_migration_plan(
        _inventory(InventoryPage(page_id=page_id_of(1), title=_ct("   ")))
    ).digest

    changed = build_title_migration_plan(
        _inventory(InventoryPage(page_id=page_id_of(1), title=_ct("Bad #Title")))
    ).digest
    added = build_title_migration_plan(
        _inventory(
            InventoryPage(page_id=page_id_of(1), title=_ct("   ")),
            InventoryPage(page_id=page_id_of(2), title=_ct("Bad #Title")),
        )
    ).digest

    assert changed != baseline
    assert added != baseline


def test_build_title_migration_plan_digest_is_canonical_and_order_independent():
    inventory = _digest_inventory()
    reordered = _inventory(
        InventoryPage(page_id=page_id_of(3), title=_ct("Acme ")),
        InventoryPage(page_id=page_id_of(1), title=_ct("Acme")),
        InventoryPage(page_id=page_id_of(9), title=_ct("Inbound")),
        InventoryPage(page_id=page_id_of(2), title=_ct(" Acme")),
        blocks=(
            InventoryBlock(
                uid=uid_of("inbound"),
                page_id=page_id_of(9),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="[[ Acme]] and [[Acme ]]",
            ),
            InventoryBlock(
                uid=uid_of("target-root"),
                page_id=page_id_of(1),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="target",
            ),
            InventoryBlock(
                uid=uid_of("source-root"),
                page_id=page_id_of(2),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="source",
            ),
        ),
        refs=(
            InventoryRef(src_block_uid=uid_of("inbound"), target_page_id=page_id_of(2), kind="link"),
            InventoryRef(src_block_uid=uid_of("inbound"), target_page_id=page_id_of(3), kind="link"),
        ),
        sidebars=(InventorySidebar(
            sidebar_id=sidebar_entry_id_of(4), title=_ct("Acme "),
            order_idx=sidebar_order_idx_of(7)),),
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
            InventoryPage(page_id=page_id_of(2), title=_ct(" Acme")),
            InventoryPage(page_id=page_id_of(9), title=_ct("Inbound")),
            InventoryPage(page_id=page_id_of(1), title=_ct("Acme")),
            InventoryPage(page_id=page_id_of(3), title=_ct("Acne ")),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        blocks=(
            InventoryBlock(
                uid=uid_of("source-root"),
                page_id=page_id_of(2),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="source",
            ),
            InventoryBlock(
                uid=uid_of("target-root"),
                page_id=page_id_of(1),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="retitled",
            ),
            InventoryBlock(
                uid=uid_of("inbound"),
                page_id=page_id_of(9),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="[[ Acme]] and [[Acme ]]",
            ),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        blocks=(
            InventoryBlock(
                uid=uid_of("source-root"),
                page_id=page_id_of(2),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="source",
            ),
            InventoryBlock(
                uid=uid_of("target-root"),
                page_id=page_id_of(1),
                parent_uid=None,
                order_idx=order_idx_of(1),
                text="target",
            ),
            InventoryBlock(
                uid=uid_of("inbound"),
                page_id=page_id_of(9),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="[[ Acme]] and [[Acme ]]",
            ),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        blocks=(
            InventoryBlock(
                uid=uid_of("source-root"),
                page_id=page_id_of(2),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="source",
            ),
            InventoryBlock(
                uid=uid_of("target-root"),
                page_id=page_id_of(1),
                parent_uid=uid_of("source-root"),
                order_idx=order_idx_of(0),
                text="target",
            ),
            InventoryBlock(
                uid=uid_of("inbound"),
                page_id=page_id_of(9),
                parent_uid=None,
                order_idx=order_idx_of(0),
                text="[[ Acme]] and [[Acme ]]",
            ),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        refs=(
            InventoryRef(src_block_uid=uid_of("inbound"), target_page_id=page_id_of(3), kind="tag"),
            InventoryRef(src_block_uid=uid_of("inbound"), target_page_id=page_id_of(2), kind="link"),
        ),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        sidebars=(InventorySidebar(
            sidebar_id=sidebar_entry_id_of(4), title=_ct("Acme "),
            order_idx=sidebar_order_idx_of(8)),),
    )).digest != baseline
    assert build_title_migration_plan(replace(
        inventory,
        refs=(InventoryRef(src_block_uid=uid_of("inbound"), target_page_id=page_id_of(2), kind="link"),),
    )).digest != baseline
