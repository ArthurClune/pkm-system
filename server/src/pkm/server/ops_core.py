# pattern: Functional Core
"""The pure op planner: each op + a context snapshot in, effect values
out. The shell (ops_apply) reads SQLite, sorts each op once with the
classifiers here (`classify_skip`, `classify_text_edit`), and hands the
planner the per-kind context that sorting calls for; planning itself does
no I/O and never re-classifies.

The op models themselves live in `pkm.contracts.ops` -- they are the wire
contract every client builds against, so they must not sit behind
`pkm.server`."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Union

from pkm.contracts.ops import (UID_RE, BlockOp, CreateOp, CreatePageOp,
                               DeleteOp, MoveOp, SetCollapsedOp,
                               SetHeadingOp, SetViewTypeOp, UpdateTextOp,
                               ViewType,
                               text_hash)
from pkm.contracts.responses import SkipReason
from pkm.refs import TitleSyntaxReason, extract, title_syntax_reason
from pkm.rename import rewrite_title_refs_map
from pkm.server.conflict_notes import (MOVE_CYCLE_NOTE, block_missing_note,
                                       live_block_header_text,
                                       move_parent_missing_note,
                                       orphan_header_text,
                                       overwritten_header_text)

# Most renames a stale edit can be behind. Each step is one recorded
# rewrite of the same block, so the bound only matters for a block renamed
# through a long chain while one device stayed offline; past it the edit
# falls back to the ordinary conflict path.
MAX_REPLAYED_REWRITES = 10


class OpError(ValueError):
    def __init__(self, index: int, reason: str):
        super().__init__(f"op {index}: {reason}")
        self.index = index
        self.reason = reason


@dataclass(frozen=True)
class OpTitleViolation:
    op_index: int
    source: Literal["page_title", "reference"]
    title: str
    reason: TitleSyntaxReason


def find_op_title_violation(
    ops: Sequence[BlockOp],
) -> OpTitleViolation | None:
    for op_index, op in enumerate(ops):
        page_title: str | None = None
        if isinstance(op, (CreateOp, CreatePageOp)):
            page_title = op.page_title
        elif isinstance(op, MoveOp):
            page_title = op.page_title
        if page_title is not None:
            reason = title_syntax_reason(page_title)
            if reason is not None:
                return OpTitleViolation(
                    op_index, "page_title", page_title, reason
                )
        if isinstance(op, (CreateOp, UpdateTextOp)):
            for ref in extract(op.text).refs:
                reason = title_syntax_reason(ref.title)
                if reason is not None:
                    return OpTitleViolation(
                        op_index, "reference", ref.title, reason
                    )
    return None


@dataclass(frozen=True)
class BlockRewrite:
    """One title a rename, merge or the title migration rewrote in one
    block, with the sha256 of that block's text either side of the whole
    rewrite. Rows of the server-only `block_rewrites` table, handed to the
    planner as data (pkm-x5w0)."""
    base_hash: str
    after_hash: str
    old_title: str
    new_title: str


def _rewrite_steps(
    rewrites: Sequence[BlockRewrite],
) -> list[tuple[str, str, dict[str, str]]]:
    """Regroup records into the rewrites they came from: records sharing a
    before/after hash pair were one pass over the block, so their titles
    replay as one map."""
    steps: list[tuple[str, str, dict[str, str]]] = []
    by_hashes: dict[tuple[str, str], dict[str, str]] = {}
    for record in rewrites:
        key = (record.base_hash, record.after_hash)
        titles = by_hashes.get(key)
        if titles is None:
            titles = {}
            by_hashes[key] = titles
            steps.append((record.base_hash, record.after_hash, titles))
        titles[record.old_title] = record.new_title
    return steps


def replay_title_rewrites(
    text: str,
    base_hash: str,
    rewrites: Sequence[BlockRewrite],
) -> tuple[str, str]:
    """Re-apply the renames this block already went through to an edit made
    before them, returning the edit's text and base hash as they would read
    had the device seen those renames first.

    A rename or merge rewrites `[[Old]]` in every referencing block. An
    offline device that had edited one of those blocks pushes its own text
    with the pre-rename hash, and plain last-write-wins would let that text
    win verbatim -- re-creating the page the rename had emptied. Following
    the recorded chain instead makes the edit an edit of the rewritten text,
    which then meets the ordinary conflict rules unchanged: it applies
    cleanly if nothing else touched the block, and conflicts under the *new*
    title if something did.

    Each step is consumed, so a record can never be replayed twice however
    the hashes line up; `MAX_REPLAYED_REWRITES` bounds the walk regardless.
    `rewrites` is newest-record-first, which decides the winner in the
    unlikely case that two rewrites share a base hash (a block edited back
    to a previous text, then renamed again).
    """
    steps = _rewrite_steps(rewrites)
    for _ in range(MAX_REPLAYED_REWRITES):
        match = next((s for s in steps if s[0] == base_hash), None)
        if match is None:
            break
        steps = [s for s in steps if s is not match]
        text = rewrite_title_refs_map(text, match[2])
        base_hash = match[1]
    return text, base_hash


@dataclass(frozen=True)
class TextEditOutcome:
    """Where a hashed update_text op on a live block lands, once any rename/
    merge rewrites it predates have been replayed onto it
    (replay_title_rewrites): identical to the block's current text (check 2,
    a no-op), a clean apply (check 4), or a concurrent edit that must land as
    a conflict (check 5). `text` is the replayed edit -- what actually gets
    applied or diffed, not the caller's original op.text.

    `ops_apply._context_for` classifies once, and the outcome rides to the
    planner in a TextEditContext or, for a conflict, a TextConflictContext
    carrying the landing only a conflict pays for."""
    kind: Literal["identical", "clean", "conflict"]
    text: str


def classify_text_edit(
    text: str, base_hash: str, current_text: str,
    rewrites: Sequence[BlockRewrite],
) -> TextEditOutcome:
    replayed_text, replayed_hash = replay_title_rewrites(
        text, base_hash, rewrites)
    if replayed_text == current_text:
        return TextEditOutcome("identical", replayed_text)
    if text_hash(current_text) == replayed_hash:
        return TextEditOutcome("clean", replayed_text)
    return TextEditOutcome("conflict", replayed_text)


SkipKind = Literal["noop", "orphan_structural", "orphan_edit",
                   "diverted_create", "move_parent_missing", "move_cycle"]


@dataclass(frozen=True)
class Skip:
    """An op the server does not apply as sent, and what it does instead of
    failing its batch: the ops the ack lists under `skipped`. A batch is
    atomic and offline clients replay it as-is, so a 400 here would discard
    every other op in it and block the queue behind it.

    - noop: set_collapsed / delete of a missing block
    - orphan_structural: move / set_heading / set_view_type of a missing
      block; a note says what was skipped
    - orphan_edit: update_text of a missing block, hashed or not (check 1);
      its text lands unless blank
    - diverted_create: create under a missing parent; the block is not
      created and its text lands instead
    - move_parent_missing: the block exists but its move target doesn't;
      it stays put and a note says why
    - move_cycle: block and target both exist, but the target is the block
      or one of its descendants (two devices moved blocks under each other
      concurrently); it stays put and a note says why

    `landing_uid` is the uid today's daily-note entry groups under (its
    conflict_headers key), or None when nothing lands.
    `ops_apply._context_for` classifies once and the Skip rides to the
    planner in one of the SkippedContext types, so the shell pays for the
    daily page only when an entry lands on it."""
    kind: SkipKind
    landing_uid: str | None


def classify_skip(
    op: BlockOp, block_exists: bool, parent_exists: bool,
    parent_chain: tuple[str, ...] = (),
) -> Skip | None:
    """None when the op's targets exist and it plans normally.
    `block_exists` is whether op.uid names a block; `parent_exists` whether
    a create/move's parent_uid does (ignored when parent_uid is None);
    `parent_chain` a move's target parent and its ancestors (read only for
    a move whose block and parent both exist)."""
    if isinstance(op, CreatePageOp):
        return None
    if isinstance(op, CreateOp):
        if block_exists or op.parent_uid is None or parent_exists:
            return None
        # a blank create has lost nothing worth landing
        landing = op.parent_uid if op.text.strip() else None
        return Skip("diverted_create", landing)
    if block_exists:
        if isinstance(op, MoveOp) and op.parent_uid is not None:
            if not parent_exists:
                return Skip("move_parent_missing", op.uid)
            if op.uid in parent_chain:
                return Skip("move_cycle", op.uid)
        return None
    if isinstance(op, (SetCollapsedOp, DeleteOp)):
        return Skip("noop", None)
    if isinstance(op, UpdateTextOp):
        return Skip("orphan_edit", op.uid if op.text.strip() else None)
    return Skip("orphan_structural", op.uid)


@dataclass(frozen=True)
class BlockInfo:
    uid: str
    page_id: int
    parent_uid: str | None


# --- where lost text lands -------------------------------------------------


@dataclass(frozen=True)
class ExistingHeader:
    """Today's live conflict header for the target block, and the next
    child order_idx under it."""
    uid: str
    next_idx: int


@dataclass(frozen=True)
class FreshHeader:
    """A header to create at the next top-level slot of today's daily
    page, minted only when there is no ExistingHeader to append under."""
    uid: str
    append_idx: int


@dataclass(frozen=True)
class ConflictLanding:
    """Where text an op could not apply lands (spec section 2): the entry
    `entry_uid` under today's header for the target block, or under a fresh
    one. `daily_title` is the day key conflict_headers records."""
    daily_page_id: int
    daily_title: str
    entry_uid: str
    header: ExistingHeader | FreshHeader


# --- per-kind contexts -----------------------------------------------------
#
# One context type per way an op can plan, each holding exactly what that
# planning reads. The shell picks the type from its one classification, so
# the planner re-derives nothing and has no optional field to find missing.


@dataclass(frozen=True)
class PageContext:
    """create_page: the page context assembly resolved (and created)."""
    page_id: int


@dataclass(frozen=True)
class CreateContext:
    """A create whose parent, if it names one, exists. `page_id` is where
    the block lands: its live parent's page, or op.page_title's for a
    top-level create."""
    uid_taken: bool
    page_id: int


@dataclass(frozen=True)
class MoveContext:
    """A move of a live block to a live parent, or to top level, that makes
    no cycle. `page_id` is op.page_title resolved, set only for a top-level
    move that names one; `subtree` is the block and its descendants,
    deepest first."""
    block: BlockInfo
    parent: BlockInfo | None
    page_id: int | None
    subtree: tuple[str, ...]


@dataclass(frozen=True)
class DeleteContext:
    """A delete of a live block; `subtree` deepest first."""
    block: BlockInfo
    subtree: tuple[str, ...]


@dataclass(frozen=True)
class BlockContext:
    """set_collapsed, set_heading, set_view_type, or a hashless update_text
    (check 3) of a live block."""
    block: BlockInfo


@dataclass(frozen=True)
class TextEditContext:
    """A hashed update_text on a live block that `classify_text_edit` found
    identical (check 2) or clean (check 4)."""
    block: BlockInfo
    outcome: TextEditOutcome


@dataclass(frozen=True)
class TextConflictContext:
    """A hashed update_text on a live block that `classify_text_edit` found
    concurrent (check 5): `text`, the edit with rewrites replayed, wins, and
    `current_text` lands under a header naming `page_title`, the block's
    own page."""
    block: BlockInfo
    text: str
    current_text: str
    page_title: str
    landing: ConflictLanding


@dataclass(frozen=True)
class SkipContext:
    """A skipped op that lands nothing (`skip.landing_uid` is None): a
    noop, or a blank orphan_edit / diverted_create."""
    skip: Skip


@dataclass(frozen=True)
class LandedSkipContext:
    """An orphan_edit, diverted_create or orphan_structural with an entry
    to land. `hint_page_exists` says whether op.page_title, the client's
    hint, names a page now; it picks the header's link-vs-code-span label
    (`conflict_notes.conflict_label`)."""
    skip: Skip
    landing: ConflictLanding
    hint_page_exists: bool


@dataclass(frozen=True)
class StuckMoveContext:
    """A move_parent_missing or move_cycle: the live block stays put, its
    note lands under a header naming `page_title` (the block's own page),
    and `subtree` (deepest first) is re-journalled."""
    skip: Skip
    landing: ConflictLanding
    page_title: str
    subtree: tuple[str, ...]


SkippedContext = Union[SkipContext, LandedSkipContext, StuckMoveContext]
# SkippedContext's members as a tuple, for isinstance: spelled out so type
# checkers narrow on it (a get_args() tuple narrows to Unknown); a test pins
# it to the Union
SKIPPED_CONTEXTS = (SkipContext, LandedSkipContext, StuckMoveContext)
OpContext = Union[PageContext, CreateContext, MoveContext, DeleteContext,
                  BlockContext, TextEditContext, TextConflictContext,
                  SkipContext, LandedSkipContext, StuckMoveContext]


def skip_report(index: int, op: BlockOp, ctx: SkippedContext) -> dict:
    """The ack's `skipped` entry for an op `classify_skip` flagged: which
    op, which uid, why, and the daily page its entry landed on (None when
    nothing landed). It is the only signal a caller that sends uids
    unchecked (`pkm batch`) gets for a mistyped one."""
    assert not isinstance(op, CreatePageOp)  # never classified skipped
    kind = ctx.skip.kind
    reason: SkipReason = (
        "cycle" if kind == "move_cycle" else
        "parent_not_found" if kind in ("diverted_create",
                                       "move_parent_missing")
        else "block_not_found")
    return {"index": index, "op": op.op, "uid": op.uid, "reason": reason,
            "note_page": (None if isinstance(ctx, SkipContext)
                          else ctx.landing.daily_title)}


@dataclass(frozen=True)
class ShiftSiblings:
    page_id: int
    parent_uid: str | None
    from_idx: int


@dataclass(frozen=True)
class InsertBlock:
    uid: str
    page_id: int
    parent_uid: str | None
    order_idx: int
    text: str
    heading: int | None
    view_type: ViewType | None = None


@dataclass(frozen=True)
class UpdateText:
    uid: str
    text: str


@dataclass(frozen=True)
class SetParent:
    uid: str
    parent_uid: str | None
    order_idx: int


@dataclass(frozen=True)
class DeleteBlocks:
    uids: tuple[str, ...]  # deepest first: children always before parents


@dataclass(frozen=True)
class SetCollapsed:
    uid: str
    collapsed: bool


@dataclass(frozen=True)
class SetHeading:
    uid: str
    heading: int | None


@dataclass(frozen=True)
class SetViewType:
    uid: str
    view_type: ViewType


@dataclass(frozen=True)
class ReindexRefs:
    uid: str
    text: str


@dataclass(frozen=True)
class TouchPage:
    page_id: int


@dataclass(frozen=True)
class SetPageId:
    uids: tuple[str, ...]
    page_id: int


@dataclass(frozen=True)
class RecordConflictHeader:
    """A fresh conflict header was created for target_uid on day: later
    conflicts on the same block that land the same day append under it
    instead of creating another header (spec section 2)."""
    target_uid: str
    day: str
    header_uid: str


@dataclass(frozen=True)
class JournalBlock:
    """A changes-journal row for uid without writing the block. The feed
    hydrates each journalled uid from current state, so a uid with no block
    row ships as a tombstone and a live one as its real row: this is how a
    replica drops the ghost of an op the server skipped (a block it never
    created, or a move it never made) without an authoritative repair.
    `deleted` fills the journal's informational column."""
    uid: str
    deleted: bool


Effect = Union[ShiftSiblings, InsertBlock, UpdateText, SetParent,
               DeleteBlocks, SetCollapsed, SetHeading, SetViewType,
               ReindexRefs, TouchPage, SetPageId, RecordConflictHeader,
               JournalBlock]

def conflict_entry_effects(
    target_uid: str, lost_text: str, header_text: str,
    landing: ConflictLanding,
) -> tuple[Effect, ...]:
    """Lost text landing in today's daily note (spec section 2): appended
    under today's existing header for this target if there is one,
    otherwise a fresh header is created and recorded so later conflicts on
    the same block land under it too."""
    header = landing.header
    if isinstance(header, ExistingHeader):
        return (
            InsertBlock(landing.entry_uid, landing.daily_page_id, header.uid,
                        header.next_idx, lost_text, None),
            ReindexRefs(landing.entry_uid, lost_text),
            TouchPage(landing.daily_page_id),
        )
    return (
        InsertBlock(header.uid, landing.daily_page_id, None,
                    header.append_idx, header_text, None),
        ReindexRefs(header.uid, header_text),
        InsertBlock(landing.entry_uid, landing.daily_page_id, header.uid,
                    0, lost_text, None),
        ReindexRefs(landing.entry_uid, lost_text),
        RecordConflictHeader(target_uid, landing.daily_title, header.uid),
        TouchPage(landing.daily_page_id),
    )


def _plan_skip(op: BlockOp, ctx: SkippedContext) -> tuple[Effect, ...]:
    """Effects for an op `classify_skip` flagged: a daily-note entry when it
    has a landing, plus JournalBlock for every uid a replica may hold a
    ghost of, so the feed corrects it.

    Tombstones (uids with no row) always lead, live rows always trail: a
    ghost's tombstone cascades its whole local subtree away on a replica,
    and a window boundary between the two must never put it after the live
    rows that bring the survivors back."""
    assert not isinstance(op, CreatePageOp)  # never classified skipped
    skip = ctx.skip
    # the context type must fit the skip kind, not just the op: planned
    # anyway, a mismatch drops a note or tombstones a live block
    assert isinstance(ctx, SkipContext) == (skip.landing_uid is None)
    assert isinstance(ctx, StuckMoveContext) == (
        skip.kind in ("move_parent_missing", "move_cycle"))
    if isinstance(ctx, StuckMoveContext):       # move_parent_missing / move_cycle
        assert isinstance(op, MoveOp) and op.parent_uid is not None
        # the whole moved subtree, root first. move_parent_missing: a
        # replica that applied the move loses all of it to the parent's
        # tombstone cascade. move_cycle: nothing is gone, and the block's
        # own row already reaches the replica with the other device's move
        # (the block is that move's ancestor, so the feed's parent closure
        # ships it). What the optimistic move also touched still needs
        # re-shipping: descendants a cross-page move re-paged, and the
        # target's children it shifted. Both lie inside this subtree.
        live = tuple(JournalBlock(u, False) for u in reversed(ctx.subtree))
        if skip.kind == "move_parent_missing":
            tombstones: tuple[Effect, ...] = (JournalBlock(op.parent_uid,
                                                           True),)
            lost_text = move_parent_missing_note(op.parent_uid)
        else:
            tombstones = ()
            lost_text = MOVE_CYCLE_NOTE
        header_text = live_block_header_text(ctx.page_title, op.uid)
        return (*tombstones,
                *conflict_entry_effects(op.uid, lost_text, header_text,
                                        ctx.landing),
                *live)
    if skip.kind == "noop":
        # a replica that just collapsed a block the server lacks holds a
        # ghost of it; one that deleted it already dropped its copy
        return ((JournalBlock(op.uid, True),)
                if isinstance(op, SetCollapsedOp) else ())
    if isinstance(op, CreateOp):                     # diverted_create
        assert op.parent_uid is not None
        tombstones = (JournalBlock(op.uid, True),
                      JournalBlock(op.parent_uid, True))
    else:
        # orphan_edit (check 1): edit-vs-delete race, uid+text is all we
        # have, the deleted row's page/parent are gone -> conflict entry
        # appended under today's daily-note header naming the hint, rather
        # than dropping the edit (spec section 2, check 1).
        # orphan_structural: the op's note lands the same way.
        tombstones = (JournalBlock(op.uid, True),)
    if isinstance(ctx, SkipContext):                 # blank text: nothing lost
        return tombstones
    if isinstance(op, (CreateOp, UpdateTextOp)):
        lost_text = op.text
        header_text = orphan_header_text(op.page_title, ctx.hint_page_exists)
    else:
        # a structural op carries no page hint worth naming: a move's
        # page_title is where it was going, not where the block was
        assert isinstance(op, (MoveOp, SetHeadingOp, SetViewTypeOp))
        lost_text = block_missing_note(op)
        header_text = orphan_header_text(None, False)
    assert skip.landing_uid is not None
    return (*tombstones,
            *conflict_entry_effects(skip.landing_uid, lost_text, header_text,
                                    ctx.landing))


def impossible_uid_reason(op: BlockOp, skip: Skip) -> str | None:
    """The 400 a skipped op still gets when the uid it would journal or
    land under could never have been minted (fails UID_RE). Clients only
    mint valid uids, so this never wedges a real queue; it keeps arbitrary
    strings out of the journal and conflict_headers."""
    assert not isinstance(op, CreatePageOp)  # never classified skipped
    if not isinstance(op, CreateOp) and not UID_RE.match(op.uid):
        return f"block not found: {op.uid}"
    if (skip.kind in ("diverted_create", "move_parent_missing")
            and isinstance(op, (CreateOp, MoveOp))
            and op.parent_uid is not None and not UID_RE.match(op.parent_uid)):
        return f"parent not found: {op.parent_uid}"
    return None


def plan_op(index: int, op: BlockOp, ctx: OpContext) -> tuple[Effect, ...]:
    """The effects of one op, from the context the shell's classification
    chose. A context that does not fit the op is a shell bug and fails as
    an AssertionError, never as an OpError: a 400 would poison the client's
    queue over something the client did not do."""
    if isinstance(op, CreateOp) and not UID_RE.match(op.uid):
        raise OpError(index, f"invalid uid: {op.uid!r}")
    if isinstance(ctx, SKIPPED_CONTEXTS):
        reason = impossible_uid_reason(op, ctx.skip)
        if reason is not None:
            raise OpError(index, reason)
        return _plan_skip(op, ctx)
    if isinstance(ctx, PageContext):
        assert isinstance(op, CreatePageOp)
        # creation happened in context assembly (get_or_create, same as
        # CreateOp); the journal trigger recorded it. Nothing to execute.
        return ()
    if isinstance(ctx, CreateContext):
        assert isinstance(op, CreateOp)
        if ctx.uid_taken:
            raise OpError(index, f"uid already exists: {op.uid}")
        return (ShiftSiblings(ctx.page_id, op.parent_uid, op.order_idx),
                InsertBlock(op.uid, ctx.page_id, op.parent_uid, op.order_idx,
                            op.text, op.heading, op.view_type),
                ReindexRefs(op.uid, op.text),
                TouchPage(ctx.page_id))
    if isinstance(ctx, TextEditContext):
        assert isinstance(op, UpdateTextOp) and op.base_text_hash is not None
        assert ctx.outcome.kind != "conflict"  # that is a TextConflictContext
        if ctx.outcome.kind == "identical":
            return ()                                # check 2: identical
        return (UpdateText(op.uid, ctx.outcome.text),  # check 4: clean apply
                ReindexRefs(op.uid, ctx.outcome.text),
                TouchPage(ctx.block.page_id))
    if isinstance(ctx, TextConflictContext):
        # check 5: concurrent edit -- incoming wins, loser preserved under
        # today's daily-note conflict header naming the block's page
        assert isinstance(op, UpdateTextOp) and op.base_text_hash is not None
        header_text = overwritten_header_text(ctx.page_title, op.uid)
        return (*conflict_entry_effects(op.uid, ctx.current_text,
                                        header_text, ctx.landing),
                UpdateText(op.uid, ctx.text),
                ReindexRefs(op.uid, ctx.text),
                TouchPage(ctx.block.page_id))
    if isinstance(ctx, MoveContext):
        assert isinstance(op, MoveOp)
        if op.parent_uid is not None:
            assert ctx.parent is not None
            # under a parent the block follows it, whatever page_title
            # says: another device may have moved the parent
            target_page = ctx.parent.page_id
        else:
            target_page = (ctx.page_id if ctx.page_id is not None
                           else ctx.block.page_id)
        effects: list[Effect] = [
            ShiftSiblings(target_page, op.parent_uid, op.order_idx),
            SetParent(op.uid, op.parent_uid, op.order_idx)]
        if target_page != ctx.block.page_id:
            effects.append(SetPageId(ctx.subtree, target_page))
            effects.append(TouchPage(ctx.block.page_id))
        effects.append(TouchPage(target_page))
        return tuple(effects)
    if isinstance(ctx, DeleteContext):
        assert isinstance(op, DeleteOp)
        return (DeleteBlocks(ctx.subtree), TouchPage(ctx.block.page_id))
    # BlockContext
    if isinstance(op, UpdateTextOp):                 # check 3: hashless
        assert op.base_text_hash is None
        return (UpdateText(op.uid, op.text),
                ReindexRefs(op.uid, op.text),
                TouchPage(ctx.block.page_id))
    if isinstance(op, SetCollapsedOp):
        # collapse/expand is UI state, not a real change -- no TouchPage,
        # so it doesn't bump the page's updated_at and pollute "last
        # changed" (unlike every other op planned here).
        return (SetCollapsed(op.uid, op.collapsed),)
    if isinstance(op, SetHeadingOp):
        return (SetHeading(op.uid, op.heading), TouchPage(ctx.block.page_id))
    assert isinstance(op, SetViewTypeOp)
    return (SetViewType(op.uid, op.view_type), TouchPage(ctx.block.page_id))
