import pytest

from pkm.edn import parse_edn
from pkm.importer.parse_export import Block, Export, Page, parse_export
from pkm.importer.preflight import (ImportDepthError, ImportStructureError,
                                    ImportUidError, validate_export_depth,
                                    validate_export_structure,
                                    validate_export_uids)
from pkm.importer.rows import RECOVERY_PAGE_TITLE
from pkm.test_data.ids import malformed_uid, raw_title_of, uid_of
from pkm.contracts.ops import MAX_OUTLINE_DEPTH, BlockUid


def _block(uid: BlockUid, children: tuple[Block, ...] = ()) -> Block:
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


def _page(title_text: str, children: tuple[Block, ...]) -> Page:
    return Page(title=raw_title_of(title_text), created_at=None, edited_at=None, children=children)


def test_distinct_objects_with_same_uid_report_lexicographically_first_duplicate():
    export = _export(
        pages=(
            _page(
                "A",
                (
                    _block(uid_of("z-duplicate")),
                    _block(uid_of("z-duplicate")),
                    _block(uid_of("a-duplicate")),
                ),
            ),
        ),
        orphans=(_block(uid_of("a-duplicate")),),
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
    shared = _block(uid_of("shared"))
    export = _export(
        pages=(
            _page(
                "A",
                (
                    _block(uid_of("tuid-left"), (shared,)),
                    _block(uid_of("tuid-right"), (shared,)),
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
            pages=(_page("A", (_block(uid_of("tuid-root"), (_block(uid_of("tuid-child")),)),)),),
            orphans=(_block(uid_of("orphan")),),
        )
    )


def test_validate_export_uids_accepts_every_well_formed_uid():
    validate_export_uids(
        _export(
            pages=(
                _page("A", (_block(uid_of("uid-root"), (_block(uid_of("uid-child")),)),)),
            ),
            orphans=(_block(uid_of("uid-orphan")),),
        )
    )


def test_validate_export_uids_rejects_a_short_uid_with_its_page_title():
    export = _export(pages=(_page("A", (_block(malformed_uid("short")),)),))
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    (bad,) = exc_info.value.invalid
    assert bad.uid == "short"
    assert bad.page_title == "A"


def test_validate_export_uids_rejects_a_disallowed_character():
    export = _export(pages=(_page("A", (_block(malformed_uid("has a space")),)),))
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    (bad,) = exc_info.value.invalid
    assert bad.uid == "has a space"


def test_validate_export_uids_rejects_an_overlong_uid():
    export = _export(pages=(_page("A", (_block(malformed_uid("x" * 33)),)),))
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    (bad,) = exc_info.value.invalid
    assert bad.uid == "x" * 33


def test_validate_export_uids_reports_every_offending_uid_and_page():
    export = _export(
        pages=(
            _page("A", (_block(uid_of("uid-good")), _block(malformed_uid("bad1")))),
            _page("B", (_block(malformed_uid("bad 2")),)),
        ),
    )
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    reported = {(bad.uid, bad.page_title) for bad in exc_info.value.invalid}
    assert reported == {("bad1", "A"), ("bad 2", "B")}


def test_validate_export_uids_checks_nested_and_orphan_blocks():
    export = _export(
        pages=(_page("A", (_block(uid_of("uid-root"), (_block(malformed_uid("bad")),)),)),),
        orphans=(_block(malformed_uid("also-bad!")),),
    )
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    reported = {(bad.uid, bad.page_title) for bad in exc_info.value.invalid}
    assert reported == {("bad", "A"), ("also-bad!", RECOVERY_PAGE_TITLE)}


def test_import_uid_error_message_lists_every_offending_uid():
    export = _export(pages=(_page("A", (_block(malformed_uid("bad1")),)),
                            _page("B", (_block(malformed_uid("bad2")),))))
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    message = str(exc_info.value)
    assert "'bad1'" in message and "'A'" in message
    assert "'bad2'" in message and "'B'" in message


_NON_STRING_UID_EXPORT = """#datascript/DB {:schema {:block/children {:db/cardinality :db.cardinality/many}}
 :datoms [
  [1 :node/title "Tree" 1]
  [1 :block/children 2 1]
  [2 :block/uid 123456 1]
  [2 :block/string "a bare EDN integer, not a string" 1]
  [2 :block/order 0 1]
 ]}"""


def test_validate_export_uids_refuses_a_non_string_uid_instead_of_crashing():
    # :block/uid is free-form EDN; a malformed export could hand parse_export
    # an int (or any other EDN value) where every real Roam export writes a
    # string. UID_RE.fullmatch() raises TypeError on a non-str argument, so
    # the check must look before it leaps rather than let that escape as an
    # unhandled crash instead of the normal whole-import refusal.
    export = parse_export(parse_edn(_NON_STRING_UID_EXPORT))
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    (bad,) = exc_info.value.invalid
    assert bad.uid == 123456  # the raw EDN value, not coerced to a string
    assert bad.page_title == "Tree"


def _chain(levels: int) -> Block:
    """A single-child chain `levels` deep, built bottom-up (no recursion)."""
    block = _block(uid_of(f"level-{levels}"))
    for level in range(levels - 1, 0, -1):
        block = _block(uid_of(f"level-{level}"), (block,))
    return block


def test_an_export_at_the_depth_cap_passes():
    export = _export(pages=(_page("A", (_chain(MAX_OUTLINE_DEPTH),)),))

    validate_export_depth(export)


def test_an_export_past_the_cap_is_refused_naming_the_block():
    export = _export(pages=(_page("A", (_chain(MAX_OUTLINE_DEPTH + 1),)),))

    with pytest.raises(ImportDepthError) as raised:
        validate_export_depth(export)

    error = raised.value
    assert error.uid == uid_of(f"level-{MAX_OUTLINE_DEPTH + 1}")
    assert error.page_title == raw_title_of("A")
    assert error.depth == MAX_OUTLINE_DEPTH + 1
    assert str(error) == (
        f"block {error.uid} on 'A' sits {MAX_OUTLINE_DEPTH + 1} levels deep; "
        f"the limit is {MAX_OUTLINE_DEPTH}"
    )


def test_an_orphan_subtree_counts_from_the_recovery_page_top_level():
    export = _export(orphans=(_chain(MAX_OUTLINE_DEPTH + 1),))

    with pytest.raises(ImportDepthError) as raised:
        validate_export_depth(export)

    assert raised.value.page_title == RECOVERY_PAGE_TITLE
    assert raised.value.depth == MAX_OUTLINE_DEPTH + 1


def test_depth_check_is_iterative():
    export = _export(pages=(_page("A", (_chain(5000),)),))

    with pytest.raises(ImportDepthError) as raised:
        validate_export_depth(export)

    assert raised.value.depth == MAX_OUTLINE_DEPTH + 1
