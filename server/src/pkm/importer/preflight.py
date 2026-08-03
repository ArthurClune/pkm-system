# pattern: Functional Core
"""Pure structural validation for parsed importer exports."""
from __future__ import annotations

from typing import Literal

from pkm.importer.parse_export import Block, Export

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
