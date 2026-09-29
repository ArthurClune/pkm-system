# pattern: Functional Core
"""The pure op planner: each op + a context snapshot in, effect values
out. The shell (ops_apply) assembles OpContext from SQLite and executes
the effects; planning itself does no I/O.

The op models themselves live in `pkm.contracts.ops` -- they are the wire
contract every client builds against, so they must not sit behind
`pkm.server` (pkm-0wr8)."""
from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Union

from pkm.contracts.ops import (UID_RE, BlockOp, CreateOp, CreatePageOp,
                               DeleteOp, MoveOp, OpBatch, SetCollapsedOp,
                               SetHeadingOp, SetViewTypeOp, UpdateTextOp,
                               ViewType,
                               text_hash)
from pkm.contracts.responses import SkipReason
from pkm.refs import (TitleSyntaxReason, extract, normalize_title,
                      title_syntax_reason)
from pkm.rename import rewrite_title_refs_map

# Most renames a stale edit can be behind. Each step is one recorded
# rewrite of the same block, so the bound only matters for a block renamed
# through a long chain while one device stayed offline; past it the edit
# falls back to the ordinary conflict path.
MAX_REPLAYED_REWRITES = 10


def batch_request_hash(batch: OpBatch) -> str:
    """Canonical content hash binding a batch_id to one payload forever
    (spec section 1): replay with a different payload is rejected, so a
    buggy client can't silently swap the ops behind an acknowledged id."""
    canon = json.dumps([_canonical_op(op) for op in batch.ops],
                       sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def _canonical_op(op: BlockOp) -> dict:
    """The op as hashed. applied_batches keeps these hashes across deploys,
    so an op that doesn't use a field added later must hash as it did
    before the field existed: any new optional op field is left out here
    while it is unset. Only those fields -- a blanket exclude_none would
    re-hash older fields' None, such as a hashless edit's base_text_hash."""
    dump = op.model_dump()
    if isinstance(op, UpdateTextOp) and op.page_title is None:
        del dump["page_title"]
    return dump


def batch_replay_hash(batch: OpBatch) -> str:
    """Like `batch_request_hash`, but tolerant of base_text_hash and
    page_title on update_text ops (pkm-95ss): the worker fills these
    into the durable copy of a batch when the client omitted them,
    but a lost enqueue reply leaves the client's in-memory fallback-lane
    copy of the SAME batch_id with the original, unfilled ops. Both
    copies eventually reach the server; they carry the same intent, so
    the same batch_id replaying with only these guard/label fields
    differing must not 409. Stored in applied_batches.request_hash for
    rows written after this change -- see routes_ops.py for how a row
    holding the (older) strict hash still replays."""
    canon = json.dumps([_canonical_replay_op(op) for op in batch.ops],
                       sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def _canonical_replay_op(op: BlockOp) -> dict:
    """`_canonical_op`, minus base_text_hash/page_title on update_text:
    guard/label metadata that never changes which op is applied (see
    `batch_replay_hash`)."""
    dump = _canonical_op(op)
    if isinstance(op, UpdateTextOp):
        dump.pop("base_text_hash", None)
        dump.pop("page_title", None)
    return dump


def _links_back(title: str) -> bool:
    """Does `[[title]]` read back as a ref to exactly `title`? Not for
    every title: a trailing `]` or a pair of backticks shifts what the
    extractor sees, and the ref indexer would create THAT page."""
    refs = extract(f"[[{title}]]").refs
    return ([normalize_title(r.title) for r in refs]
            == [normalize_title(title)])


def existing_page_label(title: str) -> str:
    """A page that exists, as a header names it: a `[[link]]` when that
    reads back as the page, else inline code (which the ref extractor
    never scans), else -- a title holding a backtick can't be fenced that
    simply -- the generic label."""
    if _links_back(title):
        return f"[[{title}]]"
    if "`" in title:
        return "(page unknown)"
    return f"`{title}`"


def conflict_label(page_title: str | None, hint_page_exists: bool) -> str:
    """Label for check 1's client page-title hint (spec section 2). It
    never fails the op, and it must not produce a `[[link]]` to a page that
    does not exist, or the ref indexer creates one:

    - unusable (missing, blank, or syntactically invalid): the generic label
    - page exists: `existing_page_label`
    - no such page: the title as inline code, or the generic label for a
      title holding a backtick
    """
    if (page_title is None or not page_title.strip()
            or title_syntax_reason(page_title) is not None):
        return "(page unknown)"
    if hint_page_exists:
        return existing_page_label(page_title)
    if "`" in page_title:
        return "(page unknown)"
    return f"`{page_title}` (page not found)"


def overwritten_header_text(page_title: str, uid: str) -> str:
    """Header for check 5: the live block's own page, read straight from
    its row -- always a real title, never a client-supplied hint."""
    return (f"[[conflict]] {existing_page_label(page_title)}"
            f" — overwritten by (({uid}))")


def orphan_header_text(page_title: str | None, hint_page_exists: bool) -> str:
    """Header for check 1: page_title is the client's op.page_title hint,
    which may be missing, unusable, or stale (naming a page the store no
    longer has); hint_page_exists is resolved by the shell (see OpContext).
    Also heads every other entry grouped under a missing block's uid (see
    `classify_missing_target`), so whichever lands first, they share it."""
    return (f"[[conflict]] {conflict_label(page_title, hint_page_exists)}"
           " — edit to a block the server no longer has")


def live_block_header_text(page_title: str, uid: str) -> str:
    """Header for a change to a live block that could not be applied (a
    move whose target parent is gone): names the block's own page, read
    from its row like check 5's, and embeds the block itself."""
    return f"[[conflict]] {existing_page_label(page_title)} — (({uid}))"


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

    Both `plan_op` and `ops_apply._context_for` classify through
    `classify_text_edit`, so the shell's decision to pay for conflict-landing
    context and the planner's decision to use it can never drift apart."""
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


MissingTargetKind = Literal["noop", "skipped", "orphan_edit",
                            "diverted_create", "move_parent_missing",
                            "move_cycle"]


@dataclass(frozen=True)
class MissingTarget:
    """What an op whose target block, or create/move parent, the server
    doesn't have does instead of failing its batch. A batch is atomic and
    offline clients replay it as-is, so a 400 here would discard every
    other op in it and block the queue behind it.

    - noop: set_collapsed / delete of a missing block
    - skipped: move / set_heading / set_view_type of a missing block; a
      note says what was skipped
    - orphan_edit: update_text of a missing block, hashed or not (check 1);
      its text lands unless blank
    - diverted_create: create under a missing parent; the block is not
      created and its text lands instead
    - move_parent_missing: the block exists but its move target doesn't;
      it stays put and a note says why
    - move_cycle: block and target both exist, but the target is the block
      or one of its descendants (two devices moved blocks under each other
      concurrently, pkm-fe9b); it stays put and a note says why. Not a
      missing target strictly, but it is skipped the same way and for the
      same reason

    `landing_uid` is the uid today's daily-note entry groups under (its
    conflict_headers key), or None when nothing lands. Both `plan_op` and
    `ops_apply._context_for` classify through `classify_missing_target`,
    so the shell pays for the daily page only when the planner lands an
    entry on it."""
    kind: MissingTargetKind
    landing_uid: str | None


def classify_missing_target(
    op: BlockOp, block_exists: bool, parent_exists: bool,
    parent_chain: tuple[str, ...] = (),
) -> MissingTarget | None:
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
        return MissingTarget("diverted_create", landing)
    if block_exists:
        if isinstance(op, MoveOp) and op.parent_uid is not None:
            if not parent_exists:
                return MissingTarget("move_parent_missing", op.uid)
            if op.uid in parent_chain:
                return MissingTarget("move_cycle", op.uid)
        return None
    if isinstance(op, (SetCollapsedOp, DeleteOp)):
        return MissingTarget("noop", None)
    if isinstance(op, UpdateTextOp):
        return MissingTarget("orphan_edit",
                             op.uid if op.text.strip() else None)
    return MissingTarget("skipped", op.uid)


def skip_report(index: int, op: BlockOp, miss: MissingTarget,
                ctx: OpContext) -> dict:
    """The ack's `skipped` entry for an op `classify_missing_target`
    flagged: which op, which uid, why, and the daily page its entry landed
    on (None when nothing landed). It is the only signal a caller that
    sends uids unchecked (`pkm batch`) gets for a mistyped one."""
    assert not isinstance(op, CreatePageOp)  # never classified missing
    reason: SkipReason = (
        "cycle" if miss.kind == "move_cycle" else
        "parent_not_found" if miss.kind in ("diverted_create",
                                            "move_parent_missing")
        else "block_not_found")
    return {"index": index, "op": op.op, "uid": op.uid, "reason": reason,
            "note_page": (ctx.daily_title if miss.landing_uid is not None
                          else None)}


@dataclass(frozen=True)
class BlockInfo:
    uid: str
    page_id: int
    parent_uid: str | None


@dataclass(frozen=True)
class OpContext:
    block: BlockInfo | None = None        # row for op.uid, if it exists
    page_id: int | None = None            # create: resolved target page
    parent: BlockInfo | None = None       # create/move: target parent row
    parent_chain: tuple[str, ...] = ()    # move: target parent + its ancestors (move_cycle's test)
    subtree: tuple[str, ...] = ()         # delete/move: op.uid subtree (delete: deepest first)
    # update_text conflict handling (spec section 2); populated by the
    # shell only when the op carries base_text_hash
    current_text: str | None = None      # target's text right now
    order_idx: int | None = None         # target's order_idx
    page_title: str | None = None        # live block's page title (check 5, move_parent_missing, move_cycle)
    # orphan_edit / diverted_create only: does a page with op.page_title
    # (the client's hint) currently exist? Resolved by the shell
    # (ops_apply._context_for) since it's a store lookup; decides
    # conflict_label's link-vs-code-span choice.
    hint_page_exists: bool = False
    conflict_uid: str | None = None      # fresh uid for a conflict header (becomes the header uid when one is created)
    conflict_child_uid: str | None = None  # fresh uid for the conflict entry (lost text) block
    daily_page_id: int | None = None     # today's daily page
    daily_append_idx: int | None = None  # next top-level idx there (new header)
    daily_title: str | None = None       # today's daily page title (for RecordConflictHeader)
    conflict_header_uid: str | None = None       # today's live header for op.uid, if any
    conflict_header_next_idx: int | None = None  # next child order_idx under it
    # rename/merge rewrites of op.uid, newest first (replay_title_rewrites)
    block_rewrites: tuple[BlockRewrite, ...] = ()


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

# What a skipped op on a missing block (MissingTarget "skipped") was, for
# its note. Notes name uids as plain text: a ((ref)) to a block that does
# not exist renders broken.
_SKIPPED_WHAT: dict[type, str] = {
    MoveOp: "move",
    SetHeadingOp: "heading change",
    SetViewTypeOp: "view type change",
}


def skipped_note(what: str, uid: str) -> str:
    return f"{what} skipped: block {uid} not found"


def move_parent_missing_note(parent_uid: str) -> str:
    return f"move skipped: target parent {parent_uid} not found"


MOVE_CYCLE_NOTE = "move skipped: would create a cycle"


def _conflict_landing_ready(ctx: OpContext) -> bool:
    """True once ctx carries everything `conflict_entry_effects` needs: the
    daily page, its append slot and the conflict-entry uid, plus -- only
    when no header already exists for target_uid today -- a fresh header
    uid. `_with_conflict_landing` mints `conflict_uid` only in that second
    case."""
    return (ctx.conflict_child_uid is not None
            and ctx.daily_page_id is not None
            and ctx.daily_append_idx is not None
            and ctx.daily_title is not None
            and (ctx.conflict_header_uid is not None
                 or ctx.conflict_uid is not None))


def conflict_entry_effects(
    target_uid: str, lost_text: str, header_text: str, ctx: OpContext,
) -> tuple[Effect, ...]:
    """Lost text landing in today's daily note (spec section 2): appended
    under today's existing header for this target if there is one,
    otherwise a fresh header is created and recorded so later conflicts on
    the same block land under it too."""
    assert ctx.conflict_child_uid is not None and ctx.daily_page_id is not None
    if ctx.conflict_header_uid is not None:
        assert ctx.conflict_header_next_idx is not None
        return (
            InsertBlock(ctx.conflict_child_uid, ctx.daily_page_id,
                        ctx.conflict_header_uid, ctx.conflict_header_next_idx,
                        lost_text, None),
            ReindexRefs(ctx.conflict_child_uid, lost_text),
            TouchPage(ctx.daily_page_id),
        )
    assert ctx.conflict_uid is not None and ctx.daily_append_idx is not None
    assert ctx.daily_title is not None
    return (
        InsertBlock(ctx.conflict_uid, ctx.daily_page_id, None,
                    ctx.daily_append_idx, header_text, None),
        ReindexRefs(ctx.conflict_uid, header_text),
        InsertBlock(ctx.conflict_child_uid, ctx.daily_page_id, ctx.conflict_uid,
                    0, lost_text, None),
        ReindexRefs(ctx.conflict_child_uid, lost_text),
        RecordConflictHeader(target_uid, ctx.daily_title, ctx.conflict_uid),
        TouchPage(ctx.daily_page_id),
    )


def _plan_missing_target(index: int, op: BlockOp, miss: MissingTarget,
                         ctx: OpContext) -> tuple[Effect, ...]:
    """Effects for an op `classify_missing_target` flagged: a daily-note
    entry when it has a landing_uid, plus JournalBlock for every uid a
    replica may hold a ghost of, so the feed corrects it.

    Tombstones (uids with no row) always lead, live rows always trail: a
    ghost's tombstone cascades its whole local subtree away on a replica,
    and a window boundary between the two must never put it after the live
    rows that bring the survivors back."""
    assert not isinstance(op, CreatePageOp)  # never classified missing
    live: tuple[Effect, ...] = ()
    if miss.kind == "noop":
        # a replica that just collapsed a block the server lacks holds a
        # ghost of it; one that deleted it already dropped its copy
        return ((JournalBlock(op.uid, True),)
                if isinstance(op, SetCollapsedOp) else ())
    if isinstance(op, CreateOp):                     # diverted_create
        assert op.parent_uid is not None
        tombstones = (JournalBlock(op.uid, True),
                      JournalBlock(op.parent_uid, True))
        lost_text = op.text
        header_text = orphan_header_text(op.page_title, ctx.hint_page_exists)
    elif isinstance(op, UpdateTextOp):               # orphan_edit (check 1)
        # edit-vs-delete race: uid+text is all we have, the deleted row's
        # page/parent are gone -> conflict entry appended under today's
        # daily-note header naming the hint, rather than dropping the edit
        # (spec section 2, check 1)
        tombstones = (JournalBlock(op.uid, True),)
        lost_text = op.text
        header_text = orphan_header_text(op.page_title, ctx.hint_page_exists)
    elif miss.kind in ("move_parent_missing", "move_cycle"):
        assert isinstance(op, MoveOp) and op.parent_uid is not None
        if ctx.page_title is None or not ctx.subtree:
            raise OpError(index, "conflict context missing")
        # the whole moved subtree, root first. move_parent_missing: a
        # replica that applied the move loses all of it to the parent's
        # tombstone cascade. move_cycle: nothing is gone, and the block's
        # own row already reaches the replica with the other device's move
        # (the block is that move's ancestor, so the feed's parent closure
        # ships it). What the optimistic move also touched still needs
        # re-shipping: descendants a cross-page move re-paged, and the
        # target's children it shifted. Both lie inside this subtree.
        live = tuple(JournalBlock(u, False)
                     for u in reversed(ctx.subtree))
        if miss.kind == "move_parent_missing":
            tombstones = (JournalBlock(op.parent_uid, True),)
            lost_text = move_parent_missing_note(op.parent_uid)
        else:
            tombstones = ()
            lost_text = MOVE_CYCLE_NOTE
        header_text = live_block_header_text(ctx.page_title, op.uid)
    else:                                            # skipped
        # a structural op carries no page hint worth naming: a move's
        # page_title is where it was going, not where the block was
        tombstones = (JournalBlock(op.uid, True),)
        lost_text = skipped_note(_SKIPPED_WHAT[type(op)], op.uid)
        header_text = orphan_header_text(None, False)
    if miss.landing_uid is None:                     # blank text: nothing lost
        return (*tombstones, *live)
    if not _conflict_landing_ready(ctx):
        raise OpError(index, "conflict context missing")
    return (*tombstones,
            *conflict_entry_effects(miss.landing_uid, lost_text, header_text,
                                    ctx),
            *live)


def impossible_uid_reason(op: BlockOp, miss: MissingTarget) -> str | None:
    """The 400 an op on a missing target still gets when the uid it would
    journal or land under could never have been minted (fails UID_RE).
    Clients only mint valid uids, so this never wedges a real queue; it
    keeps arbitrary strings out of the journal and conflict_headers."""
    assert not isinstance(op, CreatePageOp)  # never classified missing
    if not isinstance(op, CreateOp) and not UID_RE.match(op.uid):
        return f"block not found: {op.uid}"
    if (miss.kind in ("diverted_create", "move_parent_missing")
            and isinstance(op, (CreateOp, MoveOp))
            and op.parent_uid is not None and not UID_RE.match(op.parent_uid)):
        return f"parent not found: {op.parent_uid}"
    return None


def plan_op(index: int, op: BlockOp, ctx: OpContext) -> tuple[Effect, ...]:
    if isinstance(op, CreatePageOp):
        if ctx.page_id is None:
            raise OpError(index, "page could not be resolved")
        # creation happened in context assembly (get_or_create, same as
        # CreateOp); the journal trigger recorded it. Nothing to execute.
        return ()
    if isinstance(op, CreateOp):
        if not UID_RE.match(op.uid):
            raise OpError(index, f"invalid uid: {op.uid!r}")
        if ctx.block is not None:
            raise OpError(index, f"uid already exists: {op.uid}")
    miss = classify_missing_target(op, ctx.block is not None,
                                   ctx.parent is not None, ctx.parent_chain)
    if miss is not None:
        reason = impossible_uid_reason(op, miss)
        if reason is not None:
            raise OpError(index, reason)
        return _plan_missing_target(index, op, miss, ctx)
    if isinstance(op, CreateOp):
        # A create under a live parent lands on the parent's page, whatever
        # its page_title says: another device may have moved the parent
        # since the create was queued (pkm-fe9b). page_title only places a
        # top-level create.
        page_id = (ctx.parent.page_id if ctx.parent is not None
                   else ctx.page_id)
        if page_id is None:
            raise OpError(index, "page could not be resolved")
        return (ShiftSiblings(page_id, op.parent_uid, op.order_idx),
                InsertBlock(op.uid, page_id, op.parent_uid, op.order_idx,
                            op.text, op.heading, op.view_type),
                ReindexRefs(op.uid, op.text),
                TouchPage(page_id))
    assert ctx.block is not None  # classify_missing_target covered its absence
    if isinstance(op, UpdateTextOp):
        if op.base_text_hash is None:                # check 3: legacy
            return (UpdateText(op.uid, op.text),
                    ReindexRefs(op.uid, op.text),
                    TouchPage(ctx.block.page_id))
        if ctx.current_text is None or ctx.order_idx is None:
            raise OpError(index, "conflict context missing")
        # Renames this edit predates are replayed over it first, so the
        # checks below compare like with like and no old title can ride a
        # stale edit back in (see replay_title_rewrites); classify_text_edit
        # is the one place that decides identical/clean/conflict, shared
        # with ops_apply._context_for so the two can't disagree.
        outcome = classify_text_edit(op.text, op.base_text_hash,
                                     ctx.current_text, ctx.block_rewrites)
        if outcome.kind == "identical":
            return ()                                # check 2: identical
        base_effects = (UpdateText(op.uid, outcome.text),
                        ReindexRefs(op.uid, outcome.text),
                        TouchPage(ctx.block.page_id))
        if outcome.kind == "clean":
            return base_effects                      # check 4: clean apply
        # check 5: concurrent edit -- incoming wins, loser preserved under
        # today's daily-note conflict header naming the block's page
        if ctx.page_title is None or not _conflict_landing_ready(ctx):
            raise OpError(index, "conflict context missing")
        header_text = overwritten_header_text(ctx.page_title, op.uid)
        return (*conflict_entry_effects(op.uid, ctx.current_text,
                                        header_text, ctx),
                *base_effects)
    if isinstance(op, MoveOp):
        if op.parent_uid is not None:
            # else move_parent_missing; a cycle is move_cycle
            assert ctx.parent is not None
            # under a parent the block follows it, whatever page_title
            # says: another device may have moved the parent (pkm-fe9b)
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
    if isinstance(op, DeleteOp):
        return (DeleteBlocks(ctx.subtree), TouchPage(ctx.block.page_id))
    if isinstance(op, SetCollapsedOp):
        # pkm-r7k8: collapse/expand is UI state, not a real change -- no
        # TouchPage, so it doesn't bump the page's updated_at and pollute
        # "last changed" (unlike every other op planned here).
        return (SetCollapsed(op.uid, op.collapsed),)
    if isinstance(op, SetHeadingOp):
        return (SetHeading(op.uid, op.heading), TouchPage(ctx.block.page_id))
    # SetViewTypeOp (the discriminated union admits nothing else)
    return (SetViewType(op.uid, op.view_type), TouchPage(ctx.block.page_id))
