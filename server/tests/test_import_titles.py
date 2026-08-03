from typing import Literal

import pytest

from pkm.importer.parse_export import Block, Export, Page
from pkm.importer.titles import (
    ImportTitleChange,
    ImportTitleError,
    sanitize_export_titles,
    sanitize_import_title,
)


@pytest.mark.parametrize(
    ("original", "expected"),
    [
        ("Project [[Acme]]", "Project Acme"),
        ("Wrapper [[Outer [[Inner]]]]", "Wrapper Outer Inner"),
        ("Project #Acme", "Project Acme"),
        ("Project #[[Acme]]", "Project Acme"),
        ("C#", "C"),
    ],
)
def test_sanitize_import_title_removes_all_title_markers(
    original: str, expected: str
) -> None:
    assert sanitize_import_title(original, location="page[0]") == expected


@pytest.mark.parametrize(
    "original",
    [
        "Project [[Acme",
        "Project Acme]]",
        "[[Outer [[Inner]]",
        "[[Outer]] Inner]]",
        "]]premature[[",
    ],
)
def test_sanitize_import_title_refuses_malformed_bracket_syntax(
    original: str,
) -> None:
    with pytest.raises(ImportTitleError) as caught:
        sanitize_import_title(original, location="page[0]")

    assert caught.value.reason == "malformed_syntax"
    assert caught.value.original_title == original
    assert caught.value.location == "page[0]"


@pytest.mark.parametrize("original", ["#", "[[#]]", "\t\n\r\f\v"])
def test_sanitize_import_title_refuses_blank_result(original: str) -> None:
    with pytest.raises(ImportTitleError) as caught:
        sanitize_import_title(original, location="block uid-blank")

    assert caught.value.reason == "blank"
    assert caught.value.original_title == original
    assert caught.value.location == "block uid-blank"


def _block(
    uid: str,
    text: str,
    *,
    children: tuple[Block, ...] = (),
    heading: int | None = None,
    view_type: Literal["numbered", "document"] | None = None,
    open_: bool = True,
    created_at: int | None = None,
    edited_at: int | None = None,
) -> Block:
    return Block(
        uid=uid,
        text=text,
        heading=heading,
        view_type=view_type,
        open=open_,
        created_at=created_at,
        edited_at=edited_at,
        children=children,
    )


def test_sanitize_export_titles_rewrites_page_and_orphan_refs_once() -> None:
    nested = _block(
        "uid-child",
        "child [[Topic #One]]",
        heading=2,
        view_type="numbered",
        open_=False,
        created_at=30,
        edited_at=31,
    )
    root = _block(
        "uid-root",
        "see [[Project [[Acme]]]] and [[Topic #One]]; unmatched [[ prose",
        children=(nested,),
        created_at=20,
        edited_at=21,
    )
    orphan = _block(
        "uid-orphan",
        "orphan [[Project [[Acme]]]] and #Tag and #[[Tag]]; lone [[ prose",
        children=(_block("uid-orphan-child", "keep ((uid-root))"),),
        heading=1,
        view_type="document",
        open_=False,
        created_at=40,
        edited_at=41,
    )
    export = Export(
        pages=(Page("Project [[Acme]]", 10, 11, (root,)),),
        orphan_block_count=2,
        skipped_entities=3,
        attr_counts={":node/title": 1},
        orphan_blocks=(orphan,),
    )

    result = sanitize_export_titles(export)

    assert result.export.pages[0].title == "Project Acme"
    rebuilt_root = result.export.pages[0].children[0]
    assert rebuilt_root.text == (
        "see [[Project Acme]] and [[Topic One]]; unmatched [[ prose"
    )
    rebuilt_child = rebuilt_root.children[0]
    assert rebuilt_child.text == "child [[Topic One]]"
    assert rebuilt_child.uid == "uid-child"
    assert rebuilt_child.heading == 2
    assert rebuilt_child.view_type == "numbered"
    assert rebuilt_child.open is False
    assert (rebuilt_child.created_at, rebuilt_child.edited_at) == (30, 31)
    assert rebuilt_root.created_at == 20
    assert rebuilt_root.edited_at == 21
    rebuilt_orphan = result.export.orphan_blocks[0]
    assert rebuilt_orphan.text == (
        "orphan [[Project Acme]] and #Tag and #[[Tag]]; lone [[ prose"
    )
    assert rebuilt_orphan.children[0].uid == "uid-orphan-child"
    assert rebuilt_orphan.children[0].text == "keep ((uid-root))"
    assert rebuilt_orphan.heading == 1
    assert rebuilt_orphan.view_type == "document"
    assert rebuilt_orphan.open is False
    assert (rebuilt_orphan.created_at, rebuilt_orphan.edited_at) == (40, 41)
    assert result.export.orphan_block_count == 2
    assert result.export.skipped_entities == 3
    assert result.export.attr_counts == {":node/title": 1}
    assert result.title_changes == (
        ImportTitleChange(
            original_title="Project [[Acme]]",
            sanitized_title="Project Acme",
            locations=("page[0]", "block uid-root", "block uid-orphan"),
            merged=False,
        ),
        ImportTitleChange(
            original_title="Topic #One",
            sanitized_title="Topic One",
            locations=("block uid-root", "block uid-child"),
            merged=False,
        ),
    )


def test_sanitize_export_titles_prefers_exact_clean_collision_survivor() -> None:
    export = Export(
        pages=(
            Page(
                "Project [[Acme]]",
                1,
                2,
                (_block("uid-dirty", "dirty root"),),
            ),
            Page(
                "Project Acme",
                10,
                11,
                (_block("uid-clean", "clean root"),),
            ),
            Page(
                "Watcher",
                20,
                21,
                (_block("uid-watcher", "[[Project [[Acme]]]]"),),
            ),
        ),
        orphan_block_count=0,
        skipped_entities=0,
        attr_counts={},
    )

    result = sanitize_export_titles(export)

    assert [page.title for page in result.export.pages] == ["Project Acme", "Watcher"]
    survivor = result.export.pages[0]
    assert (survivor.created_at, survivor.edited_at) == (10, 11)
    assert [block.uid for block in survivor.children] == ["uid-clean", "uid-dirty"]
    assert result.export.pages[1].children[0].text == "[[Project Acme]]"
    assert result.title_changes == (
        ImportTitleChange(
            original_title="Project [[Acme]]",
            sanitized_title="Project Acme",
            locations=("page[0]", "block uid-watcher"),
            merged=True,
        ),
    )


def test_sanitize_export_titles_uses_first_source_when_no_exact_page_exists() -> None:
    export = Export(
        pages=(
            Page("#Acme", 1, 2, (_block("uid-first", "first"),)),
            Page("[[Acme]]", 10, 11, (_block("uid-second", "second"),)),
        ),
        orphan_block_count=0,
        skipped_entities=0,
        attr_counts={},
    )

    result = sanitize_export_titles(export)

    assert len(result.export.pages) == 1
    survivor = result.export.pages[0]
    assert survivor.title == "Acme"
    assert (survivor.created_at, survivor.edited_at) == (1, 2)
    assert [block.uid for block in survivor.children] == ["uid-first", "uid-second"]
    assert result.title_changes == (
        ImportTitleChange("#Acme", "Acme", ("page[0]",), True),
        ImportTitleChange("[[Acme]]", "Acme", ("page[1]",), True),
    )
