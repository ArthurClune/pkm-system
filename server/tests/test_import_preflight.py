from pkm.importer.parse_export import Block, Export, Page
from pkm.importer.preflight import ImportStructureError, validate_export_structure


def _block(uid: str, children: tuple[Block, ...] = ()) -> Block:
    return Block(
        uid=uid,
        text=uid,
        heading=None,
        view_type=None,
        open=True,
        created_at=None,
        edited_at=None,
        children=children,
    )


def _export(*, pages: tuple[Page, ...] = (), orphans: tuple[Block, ...] = ()) -> Export:
    return Export(
        pages=pages,
        orphan_block_count=0,
        skipped_entities=0,
        attr_counts={},
        orphan_blocks=orphans,
    )


def _page(title: str, children: tuple[Block, ...]) -> Page:
    return Page(title=title, created_at=None, edited_at=None, children=children)


def test_distinct_objects_with_same_uid_report_lexicographically_first_duplicate():
    export = _export(
        pages=(
            _page(
                "A",
                (
                    _block("z-duplicate"),
                    _block("z-duplicate"),
                    _block("a-duplicate"),
                ),
            ),
        ),
        orphans=(_block("a-duplicate"),),
    )

    try:
        validate_export_structure(export)
    except ImportStructureError as error:
        assert error.reason == "duplicate_uid"
        assert error.uid == "a-duplicate"
        assert error.locations == (
            "orphan_blocks[0]",
            "pages[0] 'A'.children[2]",
        )
        assert str(error) == (
            "duplicate block UID 'a-duplicate': orphan_blocks[0]; "
            "pages[0] 'A'.children[2]"
        )
    else:
        raise AssertionError("duplicate UID was accepted")


def test_same_block_instance_under_two_parents_reports_multi_parent():
    shared = _block("shared")
    export = _export(
        pages=(
            _page(
                "A",
                (
                    _block("left", (shared,)),
                    _block("right", (shared,)),
                ),
            ),
        ),
    )

    try:
        validate_export_structure(export)
    except ImportStructureError as error:
        assert error.reason == "multi_parent"
        assert error.uid == "shared"
        assert error.locations == (
            "pages[0] 'A'.children[0].children[0]",
            "pages[0] 'A'.children[1].children[0]",
        )
        assert str(error) == (
            "block with multiple parents 'shared': "
            "pages[0] 'A'.children[0].children[0]; "
            "pages[0] 'A'.children[1].children[0]"
        )
    else:
        raise AssertionError("multi-parent block was accepted")


def test_valid_tree_passes_preflight():
    validate_export_structure(
        _export(
            pages=(_page("A", (_block("root", (_block("child"),)),)),),
            orphans=(_block("orphan"),),
        )
    )
