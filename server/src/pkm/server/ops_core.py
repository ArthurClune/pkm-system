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

from collections.abc import (Callable, Collection, Iterator, Mapping,
                             Sequence)
from dataclasses import dataclass, field
from typing import Final, Literal, Union

from pkm.contracts.ops import (MAX_BLOCK_TEXT_CHARS, MAX_OUTLINE_DEPTH,
                               BlockOp, BlockUid,
                               CreateOp, CreatePageOp, DeleteOp, MoveOp,
                               OpBatch, OrderIdx, PageId,
                               RewriteKind, SetCollapsedOp, SetHeadingOp,
                               SetViewTypeOp, Sha256Hex, UID_RE, UpdateTextOp,
                               ViewType, subtree_hash, text_hash)
from pkm.contracts.responses import SkipReason, SkippedOp
from pkm.contracts.titles import RawTitle, as_raw_title
from pkm.refs import (CanonicalTitle, TitleRefusal, describe_title_length,
                      extract, normalize_title, parse_block_uid,
                      title_length_over, title_refusal)
from pkm.rename import spelled_or_canonical, title_ref_spans
from pkm.server.conflict_notes import (MOVE_CYCLE_NOTE, block_missing_note,
                                       deleted_header_text,
                                       live_block_header_text,
                                       move_parent_missing_note,
                                       orphan_header_text,
                                       overwritten_header_text,
                                       stale_page_move_note)
from pkm.spans import splice, spliced_length
from pkm.text_limits import (MAX_UNLINK_WORK, TextLimitViolation,
                              describe_text_limit, text_limit_violation,
                              unlink_refused)
from pkm.unlink import (PASSES_PAST_DEPTH, TitleMatch, block_ref_spans,
                        unlink_reads, unlink_stale_refs)

# Most renames a stale edit can be behind. Each step is one recorded
# rewrite of the same block, so the bound only matters for a block renamed
# through a long chain while one device stayed offline; past it the edit
# falls back to the ordinary conflict path.
MAX_REPLAYED_REWRITES = 10

# Most characters one batch's replays may have the unlink read, summed over
# the steps of every stale edit in it (`unlink.unlink_reads`). The copies a
# replay splices come from the server's history, not the request, so a
# batch of tiny edits could ask for a megabyte's unlink per step, ten steps
# an edit, for each of its ops. Past this the batch's remaining edits that
# would unlink land as sent (`over_limit`). One step is at most about
# 5,000,000 reads (a megabyte nested two deep, at `MAX_UNLINK_WORK`), so
# this is about three such steps. Spent in full it holds the write lock
# about 4 s for text nested to the cap, the slowest to read, and 2 s for
# a megabyte dense with links; a step on prod's largest copy reads about
# 140,000, so ordinary batches stay far below it.
MAX_BATCH_REPLAY_WORK: Final = 8 * MAX_UNLINK_WORK

# A step already replayed, keyed by the title canonicalisation, what the
# step does and the text it started from: what `_cached_step` returns
# instead of replaying it again.
StepKey = tuple[Callable[[str], str], tuple[object, ...], str]


class OpError(ValueError):
    def __init__(self, index: int, reason: str) -> None:
        super().__init__(f"op {index}: {reason}")
        self.index = index
        self.reason = reason


@dataclass(frozen=True)
class OpTitleViolation:
    op_index: int
    source: Literal["page_title", "reference"]
    title: RawTitle
    reason: TitleRefusal


def find_op_title_violation(
    ops: Sequence[BlockOp],
) -> OpTitleViolation | None:
    """The first title an op names that may not be a page title: each op's
    `page_title` (create, create_page, move), then every ref its text
    holds. `update_text`'s `page_title` is only a conflict-header hint,
    never judged: refusing it would refuse an edit to a block on a page
    stored before a rule, and discard an offline client's batch."""
    for op_index, op in enumerate(ops):
        page_title: RawTitle | None = None
        if isinstance(op, (CreateOp, CreatePageOp)):
            page_title = op.page_title
        elif isinstance(op, MoveOp):
            page_title = op.page_title
        if page_title is not None:
            reason = title_refusal(page_title)
            if reason is not None:
                return OpTitleViolation(
                    op_index, "page_title", page_title, reason
                )
        if isinstance(op, (CreateOp, UpdateTextOp)):
            for ref in extract(op.text).refs:
                reason = title_refusal(ref.title)
                if reason is not None:
                    return OpTitleViolation(
                        op_index, "reference", ref.title, reason
                    )
    return None


def describe_op_title_violation(violation: OpTitleViolation) -> str:
    """The reason a batch is refused for `violation`. A title over the cap
    is named by its length, never echoed."""
    if violation.reason == "too_long":
        measured = title_length_over(violation.title)
        assert measured is not None  # title_refusal measured it so
        return f"{violation.source} {describe_title_length(measured)}"
    return (f"unsupported {violation.source} title syntax:"
            f" {violation.title!r}")


@dataclass(frozen=True)
class OpTextLimitViolation:
    op_index: int
    uid: BlockUid
    violation: TextLimitViolation


def find_op_text_limit_violation(
    ops: Sequence[BlockOp],
) -> OpTextLimitViolation | None:
    """The first create or text edit whose text a write may not store.

    Only the text an op sends is judged: a move, heading change or delete
    of a row already over a limit goes through, and so does an edit that
    brings one back under it."""
    for op_index, op in enumerate(ops):
        if isinstance(op, (CreateOp, UpdateTextOp)):
            violation = text_limit_violation(op.text)
            if violation is not None:
                return OpTextLimitViolation(op_index, op.uid, violation)
    return None


@dataclass(frozen=True)
class JudgedBatch:
    """A batch whose every op passed the text-limit and title judges, so
    it may be applied. `apply_batch` takes only this, so no caller can
    apply a batch the judges have not seen."""
    batch: OpBatch


def judge_batch(batch: OpBatch) -> JudgedBatch:
    """Judge every op's text and titles, a skipped one included, or raise
    `OpError` naming the first refused op. Pure, so the route runs it off
    the write lock and the event loop. Limits first, over the whole batch:
    the title pass runs `extract` over every text, which must never read
    one past the caps."""
    limit = find_op_text_limit_violation(batch.ops)
    if limit is not None:
        raise OpError(
            limit.op_index,
            f"block {limit.uid}: {describe_text_limit(limit.violation)}",
        )
    violation = find_op_title_violation(batch.ops)
    if violation is not None:
        raise OpError(violation.op_index,
                      describe_op_title_violation(violation))
    return JudgedBatch(batch)


@dataclass(frozen=True)
class BlockRewrite:
    """One thing a rename, merge, the title migration or a page delete did
    to one block, with the sha256 of that block's text either side of the
    whole rewrite. Rows of the server-only `block_rewrites` table, handed to
    the planner as data. `kind` says what the titles mean: `retitle` is
    old_text -> new_text; `unlink` is a deleted page's title (new_text
    empty); `inline` is a target block uid and the text copied in its place."""
    base_hash: Sha256Hex
    after_hash: Sha256Hex
    old_text: str
    new_text: str
    kind: RewriteKind = "retitle"


@dataclass
class RewriteStep:
    """One pass over a block: what `replay_title_rewrites` consumes."""
    base_hash: Sha256Hex
    after_hash: Sha256Hex
    retitles: dict[str, RawTitle]
    unlinked: set[str]
    inlines: dict[str, str]


def _rewrite_steps(rewrites: Sequence[BlockRewrite]) -> list[RewriteStep]:
    """Regroup records into the rewrites they came from: records sharing a
    before/after hash pair were one pass over the block, so their titles
    replay together."""
    steps: list[RewriteStep] = []
    by_hashes: dict[tuple[str, str], RewriteStep] = {}
    for record in rewrites:
        key = (record.base_hash, record.after_hash)
        step = by_hashes.get(key)
        if step is None:
            step = RewriteStep(record.base_hash, record.after_hash,
                                {}, set(), {})
            by_hashes[key] = step
            steps.append(step)
        if record.kind == "unlink":
            step.unlinked.add(normalize_title(record.old_text))
        elif record.kind == "inline":
            step.inlines[record.old_text] = record.new_text
        elif record.kind == "retitle":
            step.retitles[record.old_text] = as_raw_title(record.new_text)
    return steps


def replay_title_rewrites(
    text: str,
    base_hash: Sha256Hex,
    rewrites: Sequence[BlockRewrite],
    canonical: Callable[[str], str] = normalize_title,
) -> tuple[str | None, Sha256Hex]:
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

    `canonical` is the title canonicalisation the delete matched with (the
    shell passes the database's `title_reader`): an unlink step must treat
    the same spellings as the deleted page as the delete did, or a padded
    `[[ AI ]]` the delete unlinked under plain-space canonicalisation would
    survive the replay and recreate the page. A retitle step matches a spelling
    that is itself a key, else its canonical form, as the rename it replays
    did.

    The unlink step also defuses a leading attribute naming the deleted page
    (`X:: v` becomes `` `X`:: v ``), so the replayed text never re-creates it.

    The text is None when a step would grow it past the length cap, or
    nest its copies past the nesting cap or make their unlink too much
    work (`_replay_step`); `classify_text_edit` then lands the edit as
    sent.
    """
    replayed = _replay(text, base_hash, rewrites, canonical)
    return replayed.text, replayed.base_hash


def _replay_step(text: str, step: RewriteStep,
                 canonical: Callable[[str], str],
                 allowance: int | None = None) -> tuple[str | None, int]:
    """`text` with one recorded rewrite replayed onto it, and the reads its
    unlink was allowed (`unlink.unlink_reads`, 0 for a step that unlinks
    nothing). The text is None when a splice that can grow the text (a
    longer title, an inlined copy) would carry it past
    `MAX_BLOCK_TEXT_CHARS`. That is judged from the spans
    before splicing: each link grows by the title's growth, and titles have
    no length cap, so the text itself could be far too long to build. The
    unlink that follows an inline only shortens, bar the backticks
    `defuse_attribute` and a fence add (`unlink.unlink_stale_refs`); the
    caller judges what comes out.

    Also None when the spliced text nests past `MAX_LINK_NESTING`, deeper
    than the step found it, or its depth times its length passes
    `text_limits.MAX_UNLINK_WORK`, judged before the unlink
    (`text_limits.unlink_refused`): copies that each nest within the cap
    can join into one deep link, and the unlink's passes grow with the
    depth (`unlink.unlink_title_refs`). A link the passes leave is fenced
    (`unlink.unlink_stale_refs`).

    And None when the unlink would read past `allowance`, what is left of
    the batch's `MAX_BATCH_REPLAY_WORK`, judged first from the splice's
    projected length, which the unlink reads at least three times. That
    step spends all that is left, so once one edit has run the budget out,
    the batch's later steps that would unlink stop before splicing: what
    each costs is then its own sent text, not the copies from history."""
    entering = text
    if step.retitles:
        spans = title_ref_spans(
            text, step.retitles,
            normalize=spelled_or_canonical(canonical, step.retitles))
        if spliced_length(text, spans) > MAX_BLOCK_TEXT_CHARS:
            return None, 0
        text = splice(text, spans)
    if step.unlinked or step.inlines:
        unlinked = {canonical(title) for title in step.unlinked}

        def is_deleted(raw: str) -> bool:
            return canonical(normalize_title(raw)) in unlinked

        # An inline record keeps the block-ref's uid in old_text. The copy
        # map is keyed by uid; a key that is no uid never matches a `((ref))`.
        copies = {uid: copy for key, copy in step.inlines.items()
                  if (uid := parse_block_uid(key)) is not None}
        spans = block_ref_spans(text, copies)
        projected = spliced_length(text, spans)
        if projected > MAX_BLOCK_TEXT_CHARS:
            return None, 0
        # Past the budget the step takes what is left of it, so every later
        # step in the batch stops here before splicing anything.
        if allowance is not None and \
                PASSES_PAST_DEPTH * projected > allowance:
            return None, allowance
        spliced = splice(text, spans)
        reads = unlink_reads(spliced)
        if allowance is not None and reads > allowance:
            return None, allowance
        if unlink_refused(entering, spliced):
            return None, 0
        return unlink_stale_refs(spliced, is_deleted), reads
    return text, 0


def _step_key(text: str, step: RewriteStep,
              canonical: Callable[[str], str]) -> StepKey:
    """Everything `_replay_step`'s result depends on, bar the allowance,
    which only decides whether it runs. A step rebuilt from the rows that
    recorded it (`_rewrite_chain`) has the same key: the rows carry its
    retitles, unlinked titles and copies verbatim."""
    return (canonical,
            (tuple(sorted(step.retitles.items())), tuple(sorted(step.unlinked)),
             tuple(sorted(step.inlines.items()))),
            text)


def _cached_step(
    text: str, step: RewriteStep, canonical: Callable[[str], str],
    known: dict[StepKey, str], allowance: int | None,
) -> tuple[str | None, int]:
    """`_replay_step`, or the text an equal step from the same text already
    made, which costs no reads: `_replay_step` is a pure function of the
    key. A step that stopped (None) is not kept, since an allowance may
    have stopped it."""
    key = _step_key(text, step, canonical)
    if key in known:
        return known[key], 0
    replayed, reads = _replay_step(text, step, canonical, allowance)
    if replayed is not None:
        known[key] = replayed
    return replayed, reads


@dataclass(frozen=True)
class _Replayed:
    """What `_replay` made: the text (None when a step stopped it), the
    hash it ends at (that step's base when it stopped), the steps it
    consumed in the order it walked them, every step it replayed by key,
    and the unlink reads it spent."""
    text: str | None
    base_hash: Sha256Hex
    steps: tuple[RewriteStep, ...]
    known: dict[StepKey, str]
    reads: int


def _replay(
    text: str, base_hash: Sha256Hex, rewrites: Sequence[BlockRewrite],
    canonical: Callable[[str], str],
    known: Mapping[StepKey, str] | None = None,
    allowance: int | None = None,
) -> _Replayed:
    """`replay_title_rewrites`, with what else a caller needs (`_Replayed`).
    The text is None when a step would carry it past a text limit, or its
    unlink past `allowance` (`_replay_step`), and the hash is then the base
    of that step. The walk still follows the chain past it, so the steps
    name every title the chain deleted or renamed away
    (`over_limit_landing_text`). A step in `known` is not replayed again."""
    steps = _rewrite_steps(rewrites)
    consumed: list[RewriteStep] = []
    memo = dict(known or {})
    spent = 0
    replayed: str | None = text
    stopped_at: Sha256Hex | None = None
    for _ in range(MAX_REPLAYED_REWRITES):
        match = next((s for s in steps if s.base_hash == base_hash), None)
        if match is None:
            break
        steps = [s for s in steps if s is not match]
        consumed.append(match)
        if replayed is not None:
            left = None if allowance is None else allowance - spent
            replayed, reads = _cached_step(replayed, match, canonical, memo,
                                           left)
            spent += reads
            if replayed is None:
                stopped_at = base_hash
        base_hash = match.after_hash
    if stopped_at is not None:
        return _Replayed(None, stopped_at, tuple(consumed), memo, spent)
    return _Replayed(replayed, base_hash, tuple(consumed), memo, spent)


def over_limit_landing_text(text: str, replayed: Sequence[RewriteStep],
                            canonical: Callable[[str], str]) -> str:
    """An `over_limit` edit as it lands: as sent, with every title a step of
    its replay deleted (`unlinked`) or renamed away (`retitles`' keys) made
    plain, as a stale unlink does. Landed with those links, the entry would
    re-create the pages. Nothing is renamed, since a longer title is what
    can carry a replay past the cap, and `((uid))` refs stay: one to a
    deleted block is legal and only renders broken. The text can grow only
    by `defuse_attribute`'s two backticks, and two more per link the
    unlink's passes leave (`unlink.unlink_stale_refs`), which only a title
    stored before it was refused can re-form."""
    gone = {canonical(title) for step in replayed
            for title in (*step.unlinked, *step.retitles)}
    if not gone:
        return text
    return unlink_stale_refs(
        text, lambda raw: canonical(normalize_title(raw)) in gone)


@dataclass(frozen=True)
class TextEditOutcome:
    """Where a hashed update_text op on a live block lands, once any rename/
    merge rewrites it predates have been replayed onto it
    (replay_title_rewrites): identical to the block's current text (check 2,
    a no-op), a clean apply (check 4), or a concurrent edit that must land as
    a conflict (check 5). `text` is the replayed edit -- what actually gets
    applied or diffed, not the caller's original op.text.

    `over_limit`: the replay would make text a write may not store
    (`text_limits.text_limit_violation`), so nothing is replayed and `text`
    is the edit as sent, which lands as a conflict entry while the block
    keeps its text. The edit was judged on arrival; only what the replay
    made of it is refused, and never with a 400, which would poison the
    client's queue over text it did not write.

    `ops_apply._context_for` classifies once, and the outcome rides to the
    planner in a TextEditContext or, for a conflict, a TextConflictContext
    carrying the landing only a conflict pays for (ReplayOverLimitContext
    for `over_limit`). `known` is every step the replay made, which the
    rewrite rows reuse (`rewrite_effects`) rather than replay again;
    `reads` is the unlink reads it spent from the batch's
    `MAX_BATCH_REPLAY_WORK`, which an `over_limit` may also have run out."""
    kind: Literal["identical", "clean", "conflict", "over_limit"]
    text: str
    replayed: tuple[RewriteStep, ...] = field(default=(), compare=False)
    canonical: Callable[[str], str] = field(default=normalize_title,
                                            compare=False)
    known: Mapping[StepKey, str] = field(default_factory=dict, compare=False)
    reads: int = field(default=0, compare=False)


def classify_text_edit(
    text: str, base_hash: Sha256Hex, current_text: str,
    rewrites: Sequence[BlockRewrite],
    canonical: Callable[[str], str] = normalize_title,
    allowance: int | None = None,
) -> TextEditOutcome:
    """Where the edit lands (`TextEditOutcome`). `allowance` is what is
    left of the batch's replay budget; None for no budget."""
    replay = _replay(text, base_hash, rewrites, canonical,
                     allowance=allowance)
    steps, known, reads = replay.steps, replay.known, replay.reads

    def outcome(kind: Literal["identical", "clean", "conflict",
                              "over_limit"], landed: str) -> TextEditOutcome:
        return TextEditOutcome(kind, landed, steps, canonical, known, reads)

    if replay.text is None:
        return outcome("over_limit", text)
    if replay.text == current_text:
        return outcome("identical", replay.text)
    if steps and text_limit_violation(replay.text) is not None:
        return outcome("over_limit", text)
    if text_hash(current_text) == replay.base_hash:
        return outcome("clean", replay.text)
    return outcome("conflict", replay.text)


SkipKind = Literal["noop", "orphan_structural", "orphan_edit",
                   "diverted_create", "move_parent_missing", "move_cycle",
                   "stale_page"]


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
    - stale_page: a top-level create / move whose page was deleted before
      the sending device saw the delete (`page_stale`); a create is not
      applied and its text lands, a move leaves the block put with a note

    `landing_uid` is the uid today's daily-note entry groups under (its
    conflict_headers key), or None when nothing lands.
    `ops_apply._context_for` classifies once and the Skip rides to the
    planner in one of the SkippedContext types, so the shell pays for the
    daily page only when an entry lands on it."""
    kind: SkipKind
    landing_uid: BlockUid | None


def classify_skip(
    op: BlockOp, block_exists: bool, parent_exists: bool,
    parent_chain: tuple[str, ...] = (), page_stale: bool = False,
) -> Skip | None:
    """None when the op's targets exist and it plans normally.
    `block_exists` is whether op.uid names a block; `parent_exists` whether
    a create/move's parent_uid does (ignored when parent_uid is None);
    `parent_chain` a move's target parent and its ancestors (read only for
    a move whose block and parent both exist); `page_stale` whether the
    page_title of a top-level create / move (parent_uid None) is a page
    deleted since the batch's `seen_seq`."""
    if isinstance(op, CreatePageOp):
        return None
    if isinstance(op, CreateOp):
        if block_exists:
            return None
        if op.parent_uid is None:
            if not page_stale:
                return None
            return Skip("stale_page", op.uid if op.text.strip() else None)
        if parent_exists:
            return None
        # a blank create has lost nothing worth landing
        landing = op.parent_uid if op.text.strip() else None
        return Skip("diverted_create", landing)
    if block_exists:
        if isinstance(op, MoveOp) and op.parent_uid is None and page_stale:
            return Skip("stale_page", op.uid)
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
    uid: BlockUid
    page_id: PageId
    parent_uid: BlockUid | None


# --- where lost text lands -------------------------------------------------


@dataclass(frozen=True)
class ExistingHeader:
    """Today's live conflict header for the target block, the next child
    order_idx under it, and the level it sits at. The shell reuses one only
    while it sits shallower than MAX_OUTLINE_DEPTH, so its entry lands at
    the cap at most."""
    uid: BlockUid
    next_idx: OrderIdx
    level: int


@dataclass(frozen=True)
class FreshHeader:
    """A header to create at the next top-level slot of today's daily
    page, minted only when there is no ExistingHeader to append under."""
    uid: BlockUid
    append_idx: OrderIdx


@dataclass(frozen=True)
class ConflictLanding:
    """Where text an op could not apply lands (offline-editing-design.md §2):
    the entry `entry_uid` under today's header for the target block, or under
    a fresh one. `daily_title` is the day key conflict_headers records."""
    daily_page_id: PageId
    daily_title: CanonicalTitle
    entry_uid: BlockUid
    header: ExistingHeader | FreshHeader

    @property
    def entry_level(self) -> int:
        """The level the entry lands at: under a fresh top-level header, 2."""
        if isinstance(self.header, ExistingHeader):
            return self.header.level + 1
        return 2


# --- per-kind contexts -----------------------------------------------------
#
# One context type per way an op can plan, each holding exactly what that
# planning reads. The shell picks the type from its one classification, so
# the planner re-derives nothing and has no optional field to find missing.


@dataclass(frozen=True)
class PageContext:
    """create_page: the page context assembly resolved (and created)."""
    page_id: PageId


@dataclass(frozen=True)
class CreateContext:
    """A create whose parent, if it names one, exists. `page_id` is where
    the block lands: its live parent's page, or op.page_title's for a
    top-level create; `depth` is the level it lands at, 1 at top level."""
    uid_taken: bool
    page_id: PageId
    depth: int


@dataclass(frozen=True)
class MoveContext:
    """A move of a live block to a live parent, or to top level, that makes
    no cycle. `page_id` is op.page_title resolved, set only for a top-level
    move that names one; `subtree` is the block and its descendants,
    deepest first; `deepest` is the level the subtree's deepest block
    lands at."""
    block: BlockInfo
    parent: BlockInfo | None
    page_id: PageId | None
    subtree: tuple[BlockUid, ...]
    deepest: int


@dataclass(frozen=True)
class DeleteContext:
    """A delete of a live block; `subtree` deepest first."""
    block: BlockInfo
    subtree: tuple[BlockUid, ...]


@dataclass(frozen=True)
class SubtreeRow:
    uid: BlockUid
    parent_uid: BlockUid | None
    order_idx: OrderIdx
    text: str


@dataclass(frozen=True)
class DeleteConflictContext:
    """A hashed delete whose subtree diverged: the delete still wins, and
    `rows` (deepest first) land as copies under a header naming
    `page_title`, the block's own page. `landing.entry_uid` is the root's
    copy; `copy_uids` maps every other row's uid to its copy's uid."""
    block: BlockInfo
    rows: tuple[SubtreeRow, ...]
    page_title: CanonicalTitle
    landing: ConflictLanding
    copy_uids: Mapping[BlockUid, BlockUid]


def delete_diverged(base_subtree_hash: Sha256Hex, rows: Sequence[SubtreeRow]) -> bool:
    """Whether the subtree's current (uid, text) pairs no longer hash to what
    the deleting device last saw -- offline-editing-design.md §1's canonical
    hash, order-independent so a reorder or re-parenting inside the subtree
    never diverges it."""
    return subtree_hash((row.uid, row.text) for row in rows) != base_subtree_hash


def descendant_copy_effects(
    rows: Sequence[SubtreeRow], root_uid: BlockUid,
    copy_uids: Mapping[BlockUid, BlockUid], landing: ConflictLanding,
) -> tuple[Effect, ...]:
    """InsertBlock + ReindexRefs for every row but the root (the root's copy
    is `landing.entry_uid`, through `conflict_entry_effects`), walked from
    `root_uid` in pre-order so a parent's copy always lands before its
    children's, and renumbered 0..n per parent by `(order_idx, uid)` --
    fresh uids nested as the subtree was, text only
    (offline-editing-design.md §3). The root is left out of the child map:
    a corrupted tree whose root's parent lies inside the subtree must not
    lead the walk back into its start.

    No copy lands past MAX_OUTLINE_DEPTH: a copy at the level above the cap
    takes its whole copied subtree as children at the cap, in pre-order,
    so only nesting below the cap is lost. Each diverged delete copies one
    level deeper than it deletes, so without the bound deleting each new
    header in turn would stack the copies a level per batch. When the root's
    copy itself sits at the cap (under a reused header just above it), its
    descendants follow it under the header."""
    children: dict[BlockUid | None, list[SubtreeRow]] = {}
    for row in rows:
        if row.uid != root_uid:
            children.setdefault(row.parent_uid, []).append(row)
    for siblings in children.values():
        siblings.sort(key=lambda row: (row.order_idx, row.uid))

    effects: list[Effect] = []

    def place(row: SubtreeRow, copy_parent_uid: BlockUid, idx: int) -> None:
        copy_uid = copy_uids[row.uid]
        effects.append(InsertBlock(
            uid=copy_uid, page_id=landing.daily_page_id,
            parent_uid=copy_parent_uid, order_idx=OrderIdx(idx),
            text=row.text, heading=None))
        effects.append(ReindexRefs(copy_uid, row.text))

    def preorder(orig_uid: BlockUid) -> Iterator[SubtreeRow]:
        for row in children.get(orig_uid, ()):
            yield row
            yield from preorder(row.uid)

    def walk(orig_parent_uid: BlockUid, copy_parent_uid: BlockUid,
             level: int) -> None:
        if level + 1 >= MAX_OUTLINE_DEPTH:
            # the children land at the cap: everything below them does too
            for idx, row in enumerate(preorder(orig_parent_uid)):
                place(row, copy_parent_uid, idx)
            return
        for idx, row in enumerate(children.get(orig_parent_uid, ())):
            # The deliberate dense->order-key renumber: idx is the copy's
            # position among its new siblings, 0..n, which IS its order_idx
            # since the copy starts the parent's child list from scratch.
            place(row, copy_parent_uid, idx)
            walk(row.uid, copy_uids[row.uid], level + 1)

    header = landing.header
    if (isinstance(header, ExistingHeader)
            and landing.entry_level >= MAX_OUTLINE_DEPTH):
        # the entry took header.next_idx; its descendants follow it
        for idx, row in enumerate(preorder(root_uid),
                                  start=header.next_idx + 1):
            place(row, header.uid, idx)
    else:
        walk(root_uid, landing.entry_uid, landing.entry_level)
    return tuple(effects)


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
    own page. `replayed`, `canonical`, `known` and `reads` are as on the
    outcome."""
    block: BlockInfo
    text: str
    current_text: str
    page_title: CanonicalTitle
    landing: ConflictLanding
    replayed: tuple[RewriteStep, ...] = ()
    canonical: Callable[[str], str] = normalize_title
    known: Mapping[StepKey, str] = field(default_factory=dict, compare=False)
    reads: int = 0


@dataclass(frozen=True)
class ReplayOverLimitContext:
    """A hashed update_text on a live block that `classify_text_edit` found
    `over_limit`: the block keeps its text, and the edit lands under a
    header naming `page_title`, the block's own page, as
    `over_limit_landing_text` makes it. `replayed`, `canonical` and
    `reads` are as on the outcome."""
    block: BlockInfo
    page_title: CanonicalTitle
    landing: ConflictLanding
    replayed: tuple[RewriteStep, ...] = ()
    canonical: Callable[[str], str] = normalize_title
    reads: int = 0


@dataclass(frozen=True)
class SkipContext:
    """A skipped op that lands nothing (`skip.landing_uid` is None): a
    noop, or a blank orphan_edit / diverted_create. `ghost_page`: see
    LandedSkipContext."""
    skip: Skip
    ghost_page: PageId | None = None


@dataclass(frozen=True)
class LandedSkipContext:
    """An orphan_edit, diverted_create or orphan_structural with an entry
    to land. `hint_page` is the stored title of the page op.page_title, the
    client's hint, names now, or None; it picks the header's
    link-vs-code-span label (`conflict_notes.conflict_label`).

    `siblings`: the live blocks of an orphan move's destination sibling
    group, which the client's optimistic apply shifted and the server did
    not (`ops_apply._destination_siblings`); empty for every other op.

    `ghost_page` (here and on SkipContext): for a diverted_create, the page
    the client placed the block on, if the server can tell. Its tombstone
    records it, so a later skip of the same uid can name the page as it
    would a deleted block's."""
    skip: Skip
    landing: ConflictLanding
    hint_page: CanonicalTitle | None
    siblings: tuple[BlockUid, ...] = ()
    ghost_page: PageId | None = None


@dataclass(frozen=True)
class StuckMoveContext:
    """A move_parent_missing or move_cycle: the live block stays put, its
    note lands under a header naming `page_title` (the block's own page),
    and `subtree` (deepest first) is re-journalled."""
    skip: Skip
    landing: ConflictLanding
    page_title: CanonicalTitle
    subtree: tuple[BlockUid, ...]


SkippedContext = Union[SkipContext, LandedSkipContext, StuckMoveContext]
# SkippedContext's members as a tuple, for isinstance: spelled out so type
# checkers narrow on it (a get_args() tuple narrows to Unknown); a test pins
# it to the Union
SKIPPED_CONTEXTS = (SkipContext, LandedSkipContext, StuckMoveContext)
OpContext = Union[PageContext, CreateContext, MoveContext, DeleteContext,
                  DeleteConflictContext, BlockContext, TextEditContext,
                  TextConflictContext, ReplayOverLimitContext, SkipContext,
                  LandedSkipContext, StuckMoveContext]


def skip_report(index: int, op: BlockOp,
                ctx: SkippedContext | ReplayOverLimitContext) -> SkippedOp:
    """The ack's `skipped` entry for an op `classify_skip` flagged, or an
    edit whose replay was over a limit: which op, which uid, why, and the
    daily page its entry landed on (None when nothing landed). It is the
    only signal a caller that sends uids unchecked (`pkm batch`) gets for a
    mistyped one."""
    assert not isinstance(op, CreatePageOp)  # never classified skipped
    if isinstance(ctx, ReplayOverLimitContext):
        return SkippedOp(index=index, op=op.op, uid=op.uid,
                         reason="text_limit",
                         note_page=ctx.landing.daily_title)
    kind = ctx.skip.kind
    reason: SkipReason = (
        "cycle" if kind == "move_cycle" else
        "page_deleted" if kind == "stale_page" else
        "parent_not_found" if kind in ("diverted_create",
                                       "move_parent_missing")
        else "block_not_found")
    return SkippedOp(
        index=index, op=op.op, uid=op.uid, reason=reason,
        note_page=(None if isinstance(ctx, SkipContext)
                   else ctx.landing.daily_title))


@dataclass(frozen=True)
class ShiftSiblings:
    page_id: PageId
    parent_uid: BlockUid | None
    from_order_idx: OrderIdx


@dataclass(frozen=True, kw_only=True)
class InsertBlock:
    """kw_only: two BlockUid fields (uid, parent_uid) and three ints
    (page_id, order_idx, heading) make a positional call silently
    transposable, with nothing in the types to catch it."""
    uid: BlockUid
    page_id: PageId
    parent_uid: BlockUid | None
    order_idx: OrderIdx
    text: str
    heading: int | None
    view_type: ViewType | None = None


@dataclass(frozen=True)
class UpdateText:
    uid: BlockUid
    text: str


@dataclass(frozen=True)
class SetParent:
    uid: BlockUid
    parent_uid: BlockUid | None
    order_idx: OrderIdx


@dataclass(frozen=True)
class DeleteBlocks:
    uids: tuple[BlockUid, ...]  # deepest first: children always before parents


@dataclass(frozen=True)
class SetCollapsed:
    uid: BlockUid
    collapsed: bool


@dataclass(frozen=True)
class SetHeading:
    uid: BlockUid
    heading: int | None


@dataclass(frozen=True)
class SetViewType:
    uid: BlockUid
    view_type: ViewType


@dataclass(frozen=True)
class ReindexRefs:
    uid: BlockUid
    text: str


@dataclass(frozen=True)
class TouchPage:
    page_id: PageId


@dataclass(frozen=True)
class SetPageId:
    uids: tuple[BlockUid, ...]
    page_id: PageId


@dataclass(frozen=True)
class RecordConflictHeader:
    """A fresh conflict header was created for target_uid on day: later
    conflicts on the same block that land the same day append under it
    instead of creating another header (offline-editing-design.md §2)."""
    target_uid: BlockUid
    day: str
    header_uid: BlockUid


@dataclass(frozen=True)
class RecordRewrite:
    """`block_rewrites` rows for a rewrite of uid's text the client has not
    seen -- a stale unlink, a replayed rename or delete, or both: `rewrites`
    all share the hashes of the whole rewrite (`base_hash` of the text as the
    client sent it, `after_hash` of the text written), so the client's next
    hashed edit replays onto the written text instead of conflicting."""
    uid: BlockUid
    rewrites: tuple[BlockRewrite, ...]


@dataclass(frozen=True)
class JournalBlock:
    """A changes-journal row for uid without writing the block. The feed
    hydrates each journalled uid from current state, so a live uid ships as
    its real row, and a uid with no block row journalled `deleted` ships as
    a tombstone: this is how a replica drops the ghost of an op the server
    skipped (a block it never created, or a move it never made) without an
    authoritative repair. `deleted` must be true exactly when the uid has no
    block row: the feed ships a block tombstone only from a delete row
    (sync_core.tombstone_entities). `page_id`, on a tombstone, is the page
    the uid's block was on, as the delete trigger records it
    (schema.BLOCKS_CHG_AD_TRIGGER); for a diverted create it is the page the
    client placed the block on (the create's `page_title` page, else its
    parent's last page). The feed never ships it."""
    uid: BlockUid
    deleted: bool
    page_id: PageId | None = None


Effect = Union[ShiftSiblings, InsertBlock, UpdateText, SetParent,
               DeleteBlocks, SetCollapsed, SetHeading, SetViewType,
               ReindexRefs, TouchPage, SetPageId, RecordConflictHeader,
               RecordRewrite, JournalBlock]

def conflict_entry_effects(
    target_uid: BlockUid, lost_text: str, header_text: str,
    landing: ConflictLanding,
) -> tuple[Effect, ...]:
    """Lost text landing in today's daily note (offline-editing-design.md §2):
    appended under today's existing header for this target if there is one,
    otherwise a fresh header is created and recorded so later conflicts on
    the same block land under it too."""
    header = landing.header
    if isinstance(header, ExistingHeader):
        return (
            InsertBlock(uid=landing.entry_uid, page_id=landing.daily_page_id,
                        parent_uid=header.uid, order_idx=header.next_idx,
                        text=lost_text, heading=None),
            ReindexRefs(landing.entry_uid, lost_text),
            TouchPage(landing.daily_page_id),
        )
    return (
        InsertBlock(uid=header.uid, page_id=landing.daily_page_id,
                    parent_uid=None, order_idx=header.append_idx,
                    text=header_text, heading=None),
        ReindexRefs(header.uid, header_text),
        InsertBlock(uid=landing.entry_uid, page_id=landing.daily_page_id,
                    parent_uid=header.uid, order_idx=OrderIdx(0),
                    text=lost_text, heading=None),
        ReindexRefs(landing.entry_uid, lost_text),
        RecordConflictHeader(target_uid, landing.daily_title, header.uid),
        TouchPage(landing.daily_page_id),
    )


def _plan_skip(op: BlockOp, ctx: SkippedContext) -> tuple[Effect, ...]:
    """Effects for an op `classify_skip` flagged: a daily-note entry when it
    has a landing, plus JournalBlock for every uid a replica may hold a
    ghost of, so the feed corrects it, and for every destination sibling
    (`LandedSkipContext.siblings`) the replica's optimistic apply shifted.
    Journalling a sibling writes no column: the feed re-ships its row as it
    stands.

    Tombstones (uids with no row) always lead, live rows always trail: a
    ghost's tombstone cascades its whole local subtree away on a replica,
    and a window boundary between the two must never put it after the live
    rows that bring the survivors back."""
    effects = _plan_skip_own(op, ctx)
    journalled = {e.uid for e in effects if isinstance(e, JournalBlock)}
    siblings = ctx.siblings if isinstance(ctx, LandedSkipContext) else ()
    return (*effects, *(JournalBlock(u, False) for u in siblings
                        if u not in journalled))


def _plan_skip_own(op: BlockOp, ctx: SkippedContext) -> tuple[Effect, ...]:
    """`_plan_skip` less the destination siblings."""
    assert not isinstance(op, CreatePageOp)  # never classified skipped
    skip = ctx.skip
    # the context type must fit the skip kind, not just the op: planned
    # anyway, a mismatch drops a note or tombstones a live block
    assert isinstance(ctx, SkipContext) == (skip.landing_uid is None)
    stale_move = skip.kind == "stale_page" and isinstance(op, MoveOp)
    assert isinstance(ctx, StuckMoveContext) == (
        skip.kind in ("move_parent_missing", "move_cycle") or stale_move)
    if isinstance(ctx, StuckMoveContext):  # move_parent_missing / move_cycle /
        assert isinstance(op, MoveOp)      # stale_page
        assert (op.parent_uid is None) == (skip.kind == "stale_page")
        # the whole moved subtree, root first. move_parent_missing: a
        # replica that applied the move loses all of it to the parent's
        # tombstone cascade. move_cycle: nothing is gone, and the block's
        # own row already reaches the replica with the other device's move
        # (the block is that move's ancestor, so the feed's parent closure
        # ships it). What the optimistic move also touched still needs
        # re-shipping: descendants a cross-page move re-paged, and the
        # target's children it shifted. Both lie inside this subtree.
        live = tuple(JournalBlock(u, False) for u in reversed(ctx.subtree))
        tombstones: tuple[Effect, ...] = ()
        if skip.kind == "stale_page":
            # nothing is gone: the block stays on its page
            assert op.page_title is not None
            lost_text = stale_page_move_note(op.page_title)
        elif skip.kind == "move_parent_missing":
            assert op.parent_uid is not None
            tombstones = (JournalBlock(op.parent_uid, True),)
            lost_text = move_parent_missing_note(op.parent_uid)
        else:
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
    if isinstance(op, CreateOp) and skip.kind == "stale_page":
        # a top-level create: no parent to tombstone, no ghost page
        assert op.parent_uid is None
        tombstones = (JournalBlock(op.uid, True),)
    elif isinstance(op, CreateOp):                   # diverted_create
        assert op.parent_uid is not None
        tombstones = (JournalBlock(op.uid, True, ctx.ghost_page),
                      JournalBlock(op.parent_uid, True))
    else:
        # orphan_edit (check 1): edit-vs-delete race, uid+text is all we
        # have, the deleted row's page/parent are gone -> conflict entry
        # appended under today's daily-note header naming the hint, rather
        # than dropping the edit (offline-editing-design.md §2, check 1).
        # orphan_structural: the op's note lands the same way.
        tombstones = (JournalBlock(op.uid, True),)
    if isinstance(ctx, SkipContext):                 # blank text: nothing lost
        return tombstones
    if isinstance(op, (CreateOp, UpdateTextOp)):
        lost_text = op.text
        header_text = orphan_header_text(op.page_title, ctx.hint_page)
    else:
        # a structural op carries no page hint worth naming: a move's
        # page_title is where it was going, not where the block was
        assert isinstance(op, (MoveOp, SetHeadingOp, SetViewTypeOp))
        lost_text = block_missing_note(op)
        header_text = orphan_header_text(None, None)
    assert skip.landing_uid is not None
    return (*tombstones,
            *conflict_entry_effects(skip.landing_uid, lost_text, header_text,
                                    ctx.landing))


def unlink_stale_text(op: BlockOp, is_stale: TitleMatch) -> BlockOp:
    """A create / update_text from a batch that predates a page's delete
    carries refs to it: unlink them as the delete did for the text it saw.
    Any other op, or text with nothing to unlink, comes back unchanged."""
    if not isinstance(op, (CreateOp, UpdateTextOp)):
        return op
    text = unlink_stale_refs(op.text, is_stale)
    if text == op.text:
        return op
    if isinstance(op, CreateOp):
        return CreateOp(op=op.op, uid=op.uid, page_title=op.page_title,
                        parent_uid=op.parent_uid, order_idx=op.order_idx,
                        text=text, heading=op.heading, view_type=op.view_type)
    return UpdateTextOp(op=op.op, uid=op.uid, text=text,
                        base_text_hash=op.base_text_hash,
                        page_title=op.page_title)


def _rewrite_chain(
    sent: str, written: str, stale_titles: Collection[CanonicalTitle],
    replayed: Sequence[RewriteStep], canonical: Callable[[str], str],
    known: Mapping[StepKey, str] | None = None,
) -> tuple[BlockRewrite, ...]:
    """Rows taking `sent` to `written` one pass at a time: the stale unlink
    first, then each replayed step, every pass hashed from the text before it
    to the text after it. Chaining the passes, rather than folding them into
    one row, keeps each rendering exactly as the original rewrite made it
    (a rename to a title with spaces adds brackets a folded map would not).
    Nothing when the passes do not reproduce `written`.

    `known` is the steps the classification replayed. The chain starts
    from the text the classification did (the stale unlink is the one
    `unlink_stale_text` made), so its steps are those, from the same texts,
    and are looked up rather than replayed; the check that the rows replay
    to `written` looks them up too, and the stale unlink by the key its
    rows rebuild. Given `known`, a step that is not found is replayed only
    when it unlinks nothing; one that would unlink leaves no rows, since
    that work was never counted against the batch's budget. Without it,
    every step is replayed."""
    memo = dict(known or {})
    allowance = None if known is None else 0
    rows: list[BlockRewrite] = []
    text = sent
    base = text_hash(sent)

    def record(after_text: str, records: Sequence[tuple[RewriteKind, str, str]]) -> None:
        nonlocal text, base
        after = text_hash(after_text)
        if after_text != text:
            rows.extend(BlockRewrite(base, after, old, new, kind)
                        for kind, old, new in records)
            base = after
        text = after_text

    if stale_titles:
        titles = set(stale_titles)
        unlinked = unlink_stale_refs(
            sent, lambda raw: canonical(normalize_title(raw)) in titles)
        # the step these rows rebuild replays the same unlink
        # (`_replay_step` on titles already canonical)
        stale_step = RewriteStep(base, text_hash(unlinked), {},
                                 {normalize_title(t) for t in titles}, {})
        memo[_step_key(sent, stale_step, canonical)] = unlinked
        record(unlinked, [("unlink", t, "") for t in sorted(titles)])
    for step in replayed:
        after_text, _ = _cached_step(text, step, canonical, memo, allowance)
        if after_text is None:
            return ()
        record(after_text,
               [*(("retitle", o, n) for o, n in step.retitles.items()),
                *(("unlink", t, "") for t in sorted(step.unlinked)),
                *(("inline", u, t) for u, t in step.inlines.items())])
    if text != written or not rows:
        return ()
    # what a later edit will actually do: replay the recorded rows
    if _replay(sent, text_hash(sent), rows, canonical, memo,
               allowance).text != written:
        return ()
    return tuple(rows)


def rewrite_effects(
    original: BlockOp, planned: tuple[Effect, ...],
    stale: Collection[CanonicalTitle],
    canonical: Callable[[str], str],
    replayed: Sequence[RewriteStep] = (),
    settled: str | None = None,
    known: Mapping[StepKey, str] | None = None,
) -> tuple[Effect, ...]:
    """The rewrite rows for a create / update_text whose written text differs
    from the text the client sent, because of a stale unlink and / or a
    replayed rename or delete: `original` is the op as the client sent it,
    `planned` the effects of the op as applied, `stale` the canonical deleted
    titles, `replayed` the steps a hashed update_text's replay consumed, and
    `settled` the text a clean or identical edit leaves in the block (an
    identical one plans no write), and `known` the steps the replay made
    (`_rewrite_chain`). Text that was parked rather than written to the
    op's uid leaves no rows."""
    if not isinstance(original, (CreateOp, UpdateTextOp)):
        return ()
    written = next((e.text for e in reversed(planned)
                    if isinstance(e, (InsertBlock, UpdateText))
                    and e.uid == original.uid), settled)
    if written is None:
        return ()
    titles = tuple(sorted(
        title for title in stale
        if unlink_stale_refs(
            original.text,
            lambda raw, t=title: canonical(normalize_title(raw)) == t)
        != original.text))
    if not (titles or replayed) or written == original.text:
        return ()
    rows = _rewrite_chain(original.text, written, titles, replayed,
                          canonical, known)
    return (RecordRewrite(original.uid, rows),) if rows else ()


def impossible_uid_reason(op: BlockOp, skip: Skip) -> str | None:
    """The 400 a skipped op still gets when the uid it would journal or
    land under could never have been minted (fails UID_RE). Clients only
    mint valid uids, so this never wedges a real queue; it keeps arbitrary
    strings out of the journal and conflict_headers."""
    assert not isinstance(op, CreatePageOp)  # never classified skipped
    if not isinstance(op, CreateOp) and not UID_RE.fullmatch(op.uid):
        return f"block not found: {op.uid}"
    if (skip.kind in ("diverted_create", "move_parent_missing")
            and isinstance(op, (CreateOp, MoveOp))
            and op.parent_uid is not None
            and not UID_RE.fullmatch(op.parent_uid)):
        return f"parent not found: {op.parent_uid}"
    return None


def _check_depth(index: int, uid: BlockUid, depth: int) -> None:
    """Refuse the batch when the client's create or move would put a block
    past MAX_OUTLINE_DEPTH (`depth` is the deepest level it places any
    block at). A 400 rather than a skip: a skip would need its own note
    and replica mirror, and only an outline near the cap can reach it.
    Server-made landings (conflict entries, a diverged delete's copies)
    are never judged: the client did not place them. They are bounded
    where they are placed instead, in ops_apply's _conflict_landing and
    in descendant_copy_effects."""
    if depth > MAX_OUTLINE_DEPTH:
        raise OpError(index, f"block {uid} would sit {depth} levels deep;"
                             f" the limit is {MAX_OUTLINE_DEPTH}")


def plan_op(index: int, op: BlockOp, ctx: OpContext) -> tuple[Effect, ...]:
    """The effects of one op, from the context the shell's classification
    chose. A context that does not fit the op is a shell bug and fails as
    an AssertionError, never as an OpError: a 400 would poison the client's
    queue over something the client did not do."""
    if isinstance(op, CreateOp) and not UID_RE.fullmatch(op.uid):
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
        _check_depth(index, op.uid, ctx.depth)
        return (ShiftSiblings(ctx.page_id, op.parent_uid, op.order_idx),
                InsertBlock(uid=op.uid, page_id=ctx.page_id,
                            parent_uid=op.parent_uid, order_idx=op.order_idx,
                            text=op.text, heading=op.heading,
                            view_type=op.view_type),
                ReindexRefs(op.uid, op.text),
                TouchPage(ctx.page_id))
    if isinstance(ctx, TextEditContext):
        assert isinstance(op, UpdateTextOp) and op.base_text_hash is not None
        # a conflict is a TextConflictContext, over_limit a
        # ReplayOverLimitContext
        assert ctx.outcome.kind in ("identical", "clean")
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
    if isinstance(ctx, ReplayOverLimitContext):
        # the block keeps its text, and is journalled so a replica that
        # applied the edit gets its row back
        assert isinstance(op, UpdateTextOp) and op.base_text_hash is not None
        header_text = live_block_header_text(ctx.page_title, op.uid)
        landed = over_limit_landing_text(op.text, ctx.replayed, ctx.canonical)
        return (*conflict_entry_effects(op.uid, landed, header_text,
                                        ctx.landing),
                JournalBlock(op.uid, False))
    if isinstance(ctx, MoveContext):
        assert isinstance(op, MoveOp)
        _check_depth(index, op.uid, ctx.deepest)
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
    if isinstance(ctx, DeleteConflictContext):
        assert isinstance(op, DeleteOp)
        # the subtree diverged since the deleting device last saw it: the
        # delete still wins, but the server's texts land first, nested
        # under today's conflict header, so a stale stamp only ever costs
        # an extra copy, never lost text
        root = next(row for row in ctx.rows if row.uid == op.uid)
        return (
            *conflict_entry_effects(
                op.uid, root.text, deleted_header_text(ctx.page_title),
                ctx.landing),
            *descendant_copy_effects(
                ctx.rows, op.uid, ctx.copy_uids, ctx.landing),
            DeleteBlocks(tuple(row.uid for row in ctx.rows)),
            TouchPage(ctx.block.page_id),
        )
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
