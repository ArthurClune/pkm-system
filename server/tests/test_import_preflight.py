import pytest

from pkm.edn import parse_edn
from pkm.importer.parse_export import Block, Export, Page, parse_export
from pkm.importer.preflight import (ImportStructureError, ImportUidError,
                                    validate_export_structure,
                                    validate_export_uids)
from pkm.importer.rows import RECOVERY_PAGE_TITLE


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


def test_validate_export_uids_accepts_every_well_formed_uid():
    validate_export_uids(
        _export(
            pages=(
                _page("A", (_block("uid-root", (_block("uid-child"),)),)),
            ),
            orphans=(_block("uid-orphan"),),
        )
    )


def test_validate_export_uids_rejects_a_short_uid_with_its_page_title():
    export = _export(pages=(_page("A", (_block("short"),)),))
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    (bad,) = exc_info.value.invalid
    assert bad.uid == "short"
    assert bad.page_title == "A"


def test_validate_export_uids_rejects_a_disallowed_character():
    export = _export(pages=(_page("A", (_block("has a space"),)),))
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    (bad,) = exc_info.value.invalid
    assert bad.uid == "has a space"


def test_validate_export_uids_rejects_an_overlong_uid():
    export = _export(pages=(_page("A", (_block("x" * 33),)),))
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    (bad,) = exc_info.value.invalid
    assert bad.uid == "x" * 33


def test_validate_export_uids_reports_every_offending_uid_and_page():
    export = _export(
        pages=(
            _page("A", (_block("uid-good"), _block("bad1"))),
            _page("B", (_block("bad 2"),)),
        ),
    )
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    reported = {(bad.uid, bad.page_title) for bad in exc_info.value.invalid}
    assert reported == {("bad1", "A"), ("bad 2", "B")}


def test_validate_export_uids_checks_nested_and_orphan_blocks():
    export = _export(
        pages=(_page("A", (_block("uid-root", (_block("bad"),)),)),),
        orphans=(_block("also-bad!"),),
    )
    with pytest.raises(ImportUidError) as exc_info:
        validate_export_uids(export)
    reported = {(bad.uid, bad.page_title) for bad in exc_info.value.invalid}
    assert reported == {("bad", "A"), ("also-bad!", RECOVERY_PAGE_TITLE)}


def test_import_uid_error_message_lists_every_offending_uid():
    export = _export(pages=(_page("A", (_block("bad1"),)),
                            _page("B", (_block("bad2"),))))
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
