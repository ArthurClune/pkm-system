# pattern: Functional Core
"""The text the ops planner writes onto today's daily note: `[[conflict]]`
headers, and the notes that say why an op was skipped. A header never
holds a `[[link]]` to a page that does not exist, or the ref indexer would
create it; notes name uids as plain text, since a `((ref))` to a block that
does not exist renders broken."""
from __future__ import annotations

from pkm.contracts.ops import BlockUid, MoveOp, SetHeadingOp, SetViewTypeOp
from pkm.contracts.titles import CanonicalTitle, RawTitle
from pkm.refs import extract, normalize_title, title_syntax_reason


def _links_back(title: RawTitle) -> bool:
    """Does `[[title]]` read back as a ref to exactly `title`? Not for
    every title: a trailing `]` or a pair of backticks shifts what the
    extractor sees, and the ref indexer would create THAT page."""
    refs = extract(f"[[{title}]]").refs
    return ([normalize_title(r.title) for r in refs]
            == [normalize_title(title)])


def existing_page_label(title: RawTitle) -> str:
    """A page that exists, as a header names it: a `[[link]]` when that
    reads back as the page, else inline code (which the ref extractor
    never scans), else -- a title holding a backtick can't be fenced that
    simply -- the generic label."""
    if _links_back(title):
        return f"[[{title}]]"
    if "`" in title:
        return "(page unknown)"
    return f"`{title}`"


def conflict_label(page_title: RawTitle | None,
                   hint_page: CanonicalTitle | None) -> str:
    """Label for check 1's client page-title hint (offline-editing-design.md
    §2). It never fails the op, and it must not produce a `[[link]]` to a
    page that does not exist, or the ref indexer creates one:

    - unusable (missing, blank, or syntactically invalid): the generic label
    - names a page (`hint_page`, its stored title): `existing_page_label`
      of that title, so any spelling of the hint writes the same header
    - no such page: the title as inline code
    """
    if (page_title is None or not page_title.strip()
            or title_syntax_reason(page_title) is not None):
        return "(page unknown)"
    if hint_page is not None:
        return existing_page_label(hint_page)
    span = missing_page_code_span(page_title)
    return "(page unknown)" if span is None else f"{span} (page not found)"


def missing_page_code_span(page_title: RawTitle | None) -> str | None:
    """A page that does not exist, as inline code (which the ref extractor
    never scans); None for an unusable title. A backtick is one, so the
    code span can never be cut short."""
    if (page_title is None or not page_title.strip()
            or title_syntax_reason(page_title) is not None):
        return None
    return f"`{page_title}`"


def overwritten_header_text(page_title: CanonicalTitle, uid: BlockUid) -> str:
    """Header for check 5: the live block's own page, read straight from
    its row -- always a real title, never a client-supplied hint."""
    return (f"[[conflict]] {existing_page_label(page_title)}"
            f" — overwritten by (({uid}))")


def deleted_header_text(page_title: CanonicalTitle) -> str:
    """Header for a subtree whose delete diverged (offline-editing-design.md
    §3): names the block's own page, read from its row before the delete. It
    cannot embed `((uid))` like `live_block_header_text` -- by the time this
    lands the block is gone, so there is nothing left for the ref to point
    at."""
    return (f"[[conflict]] {existing_page_label(page_title)}"
            " — deleted while edited elsewhere")


def orphan_header_text(page_title: RawTitle | None,
                       hint_page: CanonicalTitle | None) -> str:
    """Header for check 1: page_title is the client's op.page_title hint,
    which may be missing, unusable, or stale (naming a page the store no
    longer has); hint_page, the page it names, is resolved by the shell.
    Also heads every other entry grouped under a missing block's uid (see
    `ops_core.classify_skip`), so whichever lands first, they share it."""
    return (f"[[conflict]] {conflict_label(page_title, hint_page)}"
           " — edit to a block the server no longer has")


def live_block_header_text(page_title: CanonicalTitle, uid: BlockUid) -> str:
    """Header for a change to a live block that could not be applied (a
    move whose target parent is gone): names the block's own page, read
    from its row like check 5's, and embeds the block itself."""
    return f"[[conflict]] {existing_page_label(page_title)} — (({uid}))"


# What a move / set_heading / set_view_type of a missing block was, for its
# note.
_BLOCK_MISSING_WHAT: dict[type, str] = {
    MoveOp: "move",
    SetHeadingOp: "heading change",
    SetViewTypeOp: "view type change",
}


def block_missing_note(op: MoveOp | SetHeadingOp | SetViewTypeOp) -> str:
    return f"{_BLOCK_MISSING_WHAT[type(op)]} skipped: block {op.uid} not found"


def move_parent_missing_note(parent_uid: BlockUid) -> str:
    return f"move skipped: target parent {parent_uid} not found"


MOVE_CYCLE_NOTE = "move skipped: would create a cycle"


def stale_page_move_note(page_title: RawTitle) -> str:
    """Note for a move whose destination page was deleted before the
    device that sent it saw the delete: the block stays put."""
    span = missing_page_code_span(page_title) or "(page unknown)"
    return f"move skipped: page {span} was deleted"
