from typing import Literal

import pytest

from pkm.importer.parse_export import Block, Export, Page
from pkm.importer.titles import (
    ImportTitleChange,
    ImportTitleError,
    sanitize_export_titles,
    sanitize_import_title,
)
from pkm.refs import extract
from pkm.test_data.ids import raw_title_of, uid_of
from pkm.contracts.ops import BlockUid


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


def test_sanitize_import_title_refuses_syntax_created_by_hash_removal() -> None:
    original = "[#["
    with pytest.raises(ImportTitleError) as caught:
        sanitize_import_title(original, location="page[3]")

    assert caught.value.reason == "malformed_syntax"
    assert caught.value.original_title == original
    assert caught.value.location == "page[3]"


@pytest.mark.parametrize("original", ["#", "[[#]]", "\t\n\r\f\v"])
def test_sanitize_import_title_refuses_blank_result(original: str) -> None:
    with pytest.raises(ImportTitleError) as caught:
        sanitize_import_title(original, location="block uid-blank")

    assert caught.value.reason == "blank"
    assert caught.value.original_title == original
    assert caught.value.location == "block uid-blank"


def _block(
    uid: BlockUid,
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
        uid_of("uid-child"),
        "child [[Topic #One]]",
        heading=2,
        view_type="numbered",
        open_=False,
        created_at=30,
        edited_at=31,
    )
    root = _block(
        uid_of("uid-root"),
        "see [[Project [[Acme]]]] and [[Topic #One]]; unmatched [[ prose",
        children=(nested,),
        created_at=20,
        edited_at=21,
    )
    orphan = _block(
        uid_of("uid-orphan"),
        "orphan [[Project [[Acme]]]] and #Tag and #[[Tag]]; lone [[ prose",
        children=(_block(uid_of("uid-orphan-child"), "keep ((uid-root))"),),
        heading=1,
        view_type="document",
        open_=False,
        created_at=40,
        edited_at=41,
    )
    export = Export(
        pages=(Page(raw_title_of("Project [[Acme]]"), 10, 11, (root,)),),
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


def test_sanitize_export_titles_rewrites_extractor_normalized_targets() -> None:
    child = _block(uid_of("uid-child"), "unchanged child")
    export = Export(
        pages=(
            Page(
                raw_title_of("Source"),
                1,
                2,
                (
                    _block(
                        uid_of("uid-source"),
                        "  Bad#Title:: value and [[Bad\n#Title]] tail",
                        children=(child,),
                    ),
                ),
            ),
        ),
        orphan_block_count=0,
        skipped_entities=0,
        attr_counts={},
    )

    result = sanitize_export_titles(export)

    rebuilt = result.export.pages[0].children[0]
    assert rebuilt.text == "  BadTitle:: value and [[Bad Title]] tail"
    assert rebuilt.uid == "uid-source"
    assert rebuilt.children == (child,)
    assert tuple((ref.title, ref.kind) for ref in extract(rebuilt.text).refs) == (
        ("BadTitle", "attribute"),
        ("Bad Title", "link"),
    )
    assert result.title_changes == (
        ImportTitleChange("Bad #Title", "Bad Title", ("block uid-source",), False),
        ImportTitleChange("Bad#Title", "BadTitle", ("block uid-source",), False),
    )


def test_sanitize_export_titles_prefers_exact_clean_collision_survivor() -> None:
    export = Export(
        pages=(
            Page(
                raw_title_of("Project [[Acme]]"),
                1,
                2,
                (_block(uid_of("uid-dirty"), "dirty root"),),
            ),
            Page(
                raw_title_of("Project Acme"),
                10,
                11,
                (_block(uid_of("uid-clean"), "clean root"),),
            ),
            Page(
                raw_title_of("Watcher"),
                20,
                21,
                (_block(uid_of("uid-watcher"), "[[Project [[Acme]]]]"),),
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


def test_sanitize_export_titles_leaves_titles_inside_code_alone() -> None:
    export = Export(
        pages=(
            Page(
                raw_title_of("Project [[Acme]]"),
                1,
                2,
                (
                    _block(
                        uid_of("uid-code"),
                        "`[[Project [[Acme]]]]` then "
                        "```\n[[Project [[Acme]]]]\n``` then "
                        "[[Project [[Acme]]]]",
                    ),
                ),
            ),
        ),
        orphan_block_count=0,
        skipped_entities=0,
        attr_counts={},
    )

    result = sanitize_export_titles(export)

    assert result.export.pages[0].children[0].text == (
        "`[[Project [[Acme]]]]` then "
        "```\n[[Project [[Acme]]]]\n``` then "
        "[[Project Acme]]"
    )
    # The coded copies are not locations either -- extract() never saw them.
    assert result.title_changes == (
        ImportTitleChange(
            original_title="Project [[Acme]]",
            sanitized_title="Project Acme",
            locations=("page[0]", "block uid-code"),
            merged=False,
        ),
    )


def test_sanitize_export_titles_keeps_merge_sources_in_export_order() -> None:
    export = Export(
        pages=(
            Page(raw_title_of("[[Acme]]"), 1, 2, (_block(uid_of("uid-first"), "first"),)),
            Page(raw_title_of("Acme"), 10, 11, (_block(uid_of("uid-clean"), "clean"),)),
            Page(raw_title_of("#Acme"), 20, 21, (_block(uid_of("uid-third"), "third"),)),
        ),
        orphan_block_count=0,
        skipped_entities=0,
        attr_counts={},
    )

    result = sanitize_export_titles(export)

    survivor = result.export.pages[0]
    assert [page.title for page in result.export.pages] == ["Acme"]
    assert (survivor.created_at, survivor.edited_at) == (10, 11)
    # Survivor's blocks lead; the rest follow in export order.
    assert [block.uid for block in survivor.children] == [
        "uid-clean",
        "uid-first",
        "uid-third",
    ]
    assert result.title_changes == (
        ImportTitleChange("#Acme", "Acme", ("page[2]",), True),
        ImportTitleChange("[[Acme]]", "Acme", ("page[0]",), True),
    )


def test_sanitize_export_titles_marks_merged_spellings_without_a_page_collision() -> None:
    export = Export(
        pages=(
            Page(
                raw_title_of("Home"),
                1,
                2,
                (_block(uid_of("uid-root"), "see [[Acme]] and [[Ac#me]]"),),
            ),
        ),
        orphan_block_count=0,
        skipped_entities=0,
        attr_counts={},
    )

    result = sanitize_export_titles(export)

    # Two ref spellings collapse onto one page even though no page merged.
    assert result.export.pages[0].children[0].text == "see [[Acme]] and [[Acme]]"
    assert result.title_changes == (
        ImportTitleChange("Ac#me", "Acme", ("block uid-root",), True),
    )


def test_sanitize_export_titles_uses_first_source_when_no_exact_page_exists() -> None:
    export = Export(
        pages=(
            Page(raw_title_of("#Acme"), 1, 2, (_block(uid_of("uid-first"), "first"),)),
            Page(raw_title_of("[[Acme]]"), 10, 11, (_block(uid_of("uid-second"), "second"),)),
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


def _export_of(*pages: Page, orphans: tuple[Block, ...] = ()) -> Export:
    return Export(
        pages=pages,
        orphan_block_count=len(orphans),
        skipped_entities=0,
        attr_counts={},
        orphan_blocks=orphans,
    )


def _all_texts(export: Export) -> list[str]:
    texts: list[str] = []

    def visit(block: Block) -> None:
        texts.append(block.text)
        for child in block.children:
            visit(child)

    for page in export.pages:
        for child in page.children:
            visit(child)
    for orphan in export.orphan_blocks:
        visit(orphan)
    return texts


@pytest.mark.parametrize("spelling", ["", ".", "a]", "a`b"])
def test_a_page_with_a_refused_title_is_skipped_and_reported(
    spelling: str,
) -> None:
    result = sanitize_export_titles(
        _export_of(Page(raw_title_of(spelling), None, None, ()))
    )

    assert result.export.pages == ()
    assert result.export.orphan_blocks == ()
    (skipped,) = result.skipped_pages
    assert skipped.original_title == spelling
    assert skipped.location == "page[0]"
    assert skipped.block_count == 0
    assert skipped.reason == ("blank" if spelling == "" else "malformed_syntax")


def test_a_skipped_page_moves_its_blocks_after_the_genuine_orphans() -> None:
    kept = Page(raw_title_of("Kept"), None, None, ())
    tick = Page(
        raw_title_of("a`b"),
        None,
        None,
        (
            _block(
                uid_of("uid-one"),
                "one",
                children=(_block(uid_of("uid-nested"), "nested"),),
            ),
            _block(uid_of("uid-two"), "two"),
        ),
    )
    dot = Page(raw_title_of("."), None, None,
               (_block(uid_of("uid-dot"), "dot"),))
    orphan = _block(uid_of("uid-orphan"), "orphan")

    result = sanitize_export_titles(
        _export_of(tick, kept, dot, orphans=(orphan,))
    )

    assert [p.title for p in result.export.pages] == ["Kept"]
    assert [b.uid for b in result.export.orphan_blocks] == [
        "uid-orphan", "uid-one", "uid-two", "uid-dot"]
    assert result.export.orphan_blocks[1].children[0].uid == "uid-nested"
    assert [(s.original_title, s.block_count) for s in result.skipped_pages] == [
        ("a`b", 3), (".", 1)]
    assert result.export.orphan_block_count == 1


def test_a_ref_to_a_refused_title_becomes_plain_text() -> None:
    blocks = (
        _block(uid_of("uid-link"), "see [[#]] and [[Fine]]"),
        _block(uid_of("uid-tag"), "#[[#]] tagged"),
    )
    result = sanitize_export_titles(
        _export_of(Page(raw_title_of("Home"), None, None, blocks))
    )

    assert [b.text for b in result.export.pages[0].children] == [
        "see # and [[Fine]]", "# tagged"]
    assert result.unlinked_block_uids == ("uid-link", "uid-tag")
    assert result.title_changes == ()


def test_a_leading_attribute_naming_a_refused_title_is_defused() -> None:
    result = sanitize_export_titles(
        _export_of(
            Page(
                raw_title_of("Home"),
                None,
                None,
                (_block(uid_of("uid-attr"), "#:: value"),),
            )
        )
    )

    assert extract(result.export.pages[0].children[0].text).refs == ()
    assert result.unlinked_block_uids == ("uid-attr",)


def test_refs_in_orphans_and_skipped_page_blocks_are_unlinked_too() -> None:
    orphan = _block(uid_of("uid-orphan"), "orphan [[#]]")
    skipped = Page(
        raw_title_of("."),
        None,
        None,
        (_block(uid_of("uid-moved"), "moved #[[#]] [[Fine]]"),),
    )
    result = sanitize_export_titles(_export_of(skipped, orphans=(orphan,)))

    assert [b.text for b in result.export.orphan_blocks] == [
        "orphan #", "moved # [[Fine]]"]
    assert result.unlinked_block_uids == ("uid-orphan", "uid-moved")
    for text in _all_texts(result.export):
        for ref in extract(text).refs:
            sanitize_import_title(ref.title, location="check")


def test_text_extract_never_reports_as_a_ref_stays_byte_identical() -> None:
    text = "[[Real]][[]] [[.]] [[..]] [[a/./b]]"
    skipped = Page(raw_title_of("."), None, None, ())
    home = Page(
        raw_title_of("Home"),
        None,
        None,
        (_block(uid_of("uid-home"), text),),
    )
    result = sanitize_export_titles(_export_of(skipped, home))

    (page,) = result.export.pages
    assert page.children[0].text == text
    assert result.unlinked_block_uids == ()


@pytest.mark.parametrize(
    ("text", "plain"),
    [("see [[#]] here", "see # here"), ("#[[#]] here", "# here")],
)
def test_a_ref_that_sanitizes_to_blank_becomes_plain_text(
    text: str, plain: str
) -> None:
    skipped = Page(raw_title_of("#"), None, None, ())
    home = Page(
        raw_title_of("Home"),
        None,
        None,
        (_block(uid_of("uid-home"), text),),
    )
    result = sanitize_export_titles(_export_of(skipped, home))

    (page,) = result.export.pages
    assert page.children[0].text == plain
    assert extract(page.children[0].text).refs == ()
    assert result.unlinked_block_uids == ("uid-home",)


def test_titles_that_sanitize_fine_still_merge() -> None:
    result = sanitize_export_titles(
        _export_of(
            Page(raw_title_of("Acme"), None, None,
                 (_block(uid_of("uid-one"), "one"),)),
            Page(raw_title_of("#Acme"), None, None,
                 (_block(uid_of("uid-two"), "two"),)),
        )
    )

    (page,) = result.export.pages
    assert [b.uid for b in page.children] == ["uid-one", "uid-two"]
    assert result.skipped_pages == ()


def test_a_backtick_ref_is_no_ref_and_is_left_as_written() -> None:
    texts = ("see [[a`b]] and #[[x`]]", "a`b:: v", "[[the `foo` function]]")
    blocks = tuple(
        _block(uid_of(f"uid-tick-{i}"), text) for i, text in enumerate(texts)
    )
    result = sanitize_export_titles(
        _export_of(Page(raw_title_of("Home"), None, None, blocks))
    )

    assert [b.text for b in result.export.pages[0].children] == list(texts)
    assert result.unlinked_block_uids == ()
    assert result.title_changes == ()


@pytest.mark.parametrize(
    ("text", "sanitized"),
    [
        # The `#` left by an unlinked [[#]] joins what follows into a ref.
        ("[[#]]a b:: v", "`#a b`:: v"),
        ("[[#]][[#]]a:: v", "`##a`:: v"),
        ("[#a b]([[#]]):: v", "`#a b`:: v"),
        ("[[#]]x y", "x y"),
        ("([[#]]x", "(x"),
        ("#Fine [[#]]x", "#Fine x"),
        # The brackets kept what was before them out of an attribute name.
        ("a [[#]]:: v", "`a #`:: v"),
        # The inner text ends in a space, so a `#b` after it is a tag.
        ("[[#  ]]#b", "#  b"),
    ],
)
def test_unlinking_a_refused_ref_forms_no_ref_from_what_was_around_it(
    text: str, sanitized: str
) -> None:
    skipped = Page(raw_title_of("."), None, None, ())
    home = Page(raw_title_of("Home"), None, None,
                (_block(uid_of("uid-home"), text),))
    result = sanitize_export_titles(_export_of(skipped, home))

    (page,) = result.export.pages
    assert page.children[0].text == sanitized
    images = {sanitize_import_title(ref.title, location="check")
              for ref in extract(text).refs if ref.title != "#"}
    assert {ref.title for ref in extract(sanitized).refs} <= images
    assert result.unlinked_block_uids == ("uid-home",)


@pytest.mark.parametrize(
    ("text", "sanitized"),
    [("[[a [[#]] b]]", "[[a b]]"), ("[[[[#]]x]]", "[[x]]")],
)
def test_a_refused_run_inside_a_kept_one_goes_with_the_outer_rename(
    text: str, sanitized: str
) -> None:
    # Unlinking the inner run first left the outer title `a # b`, which no
    # rename covers and the title migration refuses.
    skipped = Page(raw_title_of("."), None, None, ())
    home = Page(raw_title_of("Home"), None, None,
                (_block(uid_of("uid-home"), text),))
    result = sanitize_export_titles(_export_of(skipped, home))

    (page,) = result.export.pages
    assert page.children[0].text == sanitized
    assert result.unlinked_block_uids == ()
