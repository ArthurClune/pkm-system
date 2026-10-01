# pattern: Functional Core
"""Pure structural validation for parsed importer exports."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pkm.contracts.ops import UID_RE
from pkm.importer.parse_export import Block, Export
from pkm.importer.rows import RECOVERY_PAGE_TITLE

StructureReason = Literal["duplicate_uid", "multi_parent"]

_REASON_LABELS: dict[StructureReason, str] = {
    "duplicate_uid": "duplicate block UID",
    "multi_parent": "block with multiple parents",
}


class ImportStructureError(ValueError):
    """A deterministic refusal for a parsed export that is not a block tree."""

    reason: StructureReason
    uid: str
    locations: tuple[str, ...]

    def __init__(
        self,
        reason: StructureReason,
        uid: str,
        locations: tuple[str, ...],
    ) -> None:
        self.reason = reason
        self.uid = uid
        self.locations = locations
        location_text = "; ".join(locations)
        super().__init__(f"{_REASON_LABELS[reason]} {uid!r}: {location_text}")


def validate_export_structure(export: Export) -> None:
    """Reject duplicate UIDs and block instances reached by multiple paths."""
    occurrences_by_uid: dict[str, list[tuple[str, int]]] = {}

    def visit(block: Block, location: str) -> None:
        occurrences_by_uid.setdefault(block.uid, []).append((location, id(block)))
        for child_index, child in enumerate(block.children):
            visit(child, f"{location}.children[{child_index}]")

    for page_index, page in enumerate(export.pages):
        page_location = f"pages[{page_index}] {page.title!r}"
        for child_index, child in enumerate(page.children):
            visit(child, f"{page_location}.children[{child_index}]")
    for orphan_index, orphan in enumerate(export.orphan_blocks):
        visit(orphan, f"orphan_blocks[{orphan_index}]")

    for uid in sorted(occurrences_by_uid):
        occurrences = occurrences_by_uid[uid]
        object_ids = {object_id for _, object_id in occurrences}
        reason: StructureReason | None = None
        if len(object_ids) > 1:
            reason = "duplicate_uid"
        elif len(occurrences) > 1:
            reason = "multi_parent"
        if reason is not None:
            locations = tuple(sorted(location for location, _ in occurrences))
            raise ImportStructureError(reason, uid, locations)


@dataclass(frozen=True)
class InvalidUid:
    """One imported uid that fails UID_RE, and the page it was found on
    (RECOVERY_PAGE_TITLE for a block unreachable from any page -- the
    title it would land under if the import proceeded)."""

    uid: str
    page_title: str


class ImportUidError(ValueError):
    """Refuses the whole import: at least one block uid does not match
    UID_RE. No uid is ever re-minted here -- a uid an export's own
    ((block refs)) point at must survive import unchanged, and a uid
    short/odd enough to fail UID_RE would otherwise resolve in render and
    export (whose ((token)) pattern is wider, BLOCK_REF_TOKEN's {6,32})
    while the app and backlinks silently ignore it."""

    invalid: tuple[InvalidUid, ...]

    def __init__(self, invalid: tuple[InvalidUid, ...]) -> None:
        self.invalid = invalid
        listing = "; ".join(
            f"{bad.uid!r} on {bad.page_title!r}" for bad in invalid
        )
        super().__init__(f"invalid block uid(s): {listing}")


def validate_export_uids(export: Export) -> None:
    """Reject the whole import if any block uid fails UID_RE, naming every
    offender and its page. Runs over every block including orphan
    subtrees, which are otherwise invisible until to_rows assigns them to
    RECOVERY_PAGE_TITLE."""
    invalid: list[InvalidUid] = []

    def visit(block: Block, page_title: str) -> None:
        if not UID_RE.fullmatch(block.uid):
            invalid.append(InvalidUid(block.uid, page_title))
        for child in block.children:
            visit(child, page_title)

    for page in export.pages:
        for child in page.children:
            visit(child, page.title)
    for orphan in export.orphan_blocks:
        visit(orphan, RECOVERY_PAGE_TITLE)

    if invalid:
        raise ImportUidError(tuple(invalid))
