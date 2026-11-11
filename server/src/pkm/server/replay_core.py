# pattern: Functional Core
"""The rewrite-replay engine: a stale edit's base hash, walked forward
through the recorded rewrites of its block (renames, merges, the title
migration, page deletes) to the text a client would have sent had it seen
them, under the work budget a batch may spend doing so. Pure: the shell
(`ops_apply`) reads the rows and passes them in."""
from __future__ import annotations

from collections.abc import (Callable, Collection, Iterator, Mapping,
                             Sequence)
from collections.abc import Set as AbstractSet
from dataclasses import dataclass, field
from typing import Final, Literal, NamedTuple

from pkm.contracts.ops import (MAX_BLOCK_TEXT_CHARS, BlockOp, BlockUid,
                               CreateOp, RewriteKind, Sha256Hex,
                               UpdateTextOp, text_hash)
from pkm.contracts.titles import RawTitle, as_raw_title
from pkm.refs import CanonicalTitle, normalize_title, parse_block_uid
from pkm.rename import spelled_or_canonical, title_ref_spans
from pkm.spans import splice, spliced_length
from pkm.text_limits import (MAX_UNLINK_WORK, text_limit_violation,
                             unlink_refused)
from pkm.unlink import (PASSES_PAST_DEPTH, TitleMatch, block_ref_spans,
                        linked_titles, unlink_reads, unlink_stale_refs)

# Most renames a stale edit can be behind. Each step is one recorded
# rewrite of the same block, so the bound only matters for a block renamed
# through a long chain while one device stayed offline; past it the edit
# falls back to the ordinary conflict path.
MAX_REPLAYED_REWRITES = 10

# Most characters one batch's replays may spend, summed over every stale
# edit in it: the rows they read (`ops_apply.BatchReplay`), what the unlink
# reads (`unlink.unlink_reads`), what a rename scans and splices
# (`_replay_step`), and the rows a step that changes the text leaves
# (`_charged`). The rows, copies and titles come from the server's
# history, not the request, so a batch of tiny edits could ask for a
# megabyte's unlink or rename per step, ten steps an edit, for each of
# its ops, or for a block's millions of rows. Past this the batch's
# remaining stale edits land as sent (`over_limit`). One step is at most
# about 5,000,000 reads (a megabyte nested two deep, at
# `MAX_UNLINK_WORK`), so this is about three such steps. Spent in full,
# the unlinks take about 4 s for text nested to the cap, the slowest to
# read; a batch of 500 such edits, one block each, holds the write lock
# about 5.5 s. Spent on reading rows it takes under 1 s, and a step of
# 90,000 titles is about three quarters of it. A step on prod's largest
# copy reads about 140,000, so ordinary batches stay far below it.
MAX_BATCH_REPLAY_WORK: Final = 8 * MAX_UNLINK_WORK

# What a `block_rewrites` row stores beside its titles: two sha256 hashes
# in hex. Reading or writing a row is charged this and its titles.
ROW_CHARS: Final = 2 * 64

# A step already replayed, keyed by the title canonicalisation, what the
# step does and the text it started from: what `_cached_step` returns
# instead of replaying it again.
StepKey = tuple[Callable[[str], str], tuple[object, ...], str]


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
    """One pass over a block: what `replay` consumes. A step
    is not changed once built, so what a replay derives from it is kept on
    it (`key_parts`, `records`, `derived`): a batch keeps a block's steps
    for all its ops (`RewriteHistory`), so it derives each once."""
    base_hash: Sha256Hex
    after_hash: Sha256Hex
    retitles: dict[str, RawTitle]
    unlinked: set[str]
    inlines: dict[str, str]
    key_parts: tuple[frozenset[object], ...] | None = field(
        default=None, init=False, repr=False, compare=False)
    records: StepRecords | None = field(
        default=None, init=False, repr=False, compare=False)
    derived: tuple[Callable[[str], str], StepTitles] | None = field(
        default=None, init=False, repr=False, compare=False)


@dataclass(frozen=True)
class StepRecords:
    """The records an op that replays a step writes for it (`rewrite_chain`),
    every title, rename and copy the step holds, and what writing them is
    charged (`_charged`): each row's titles and `ROW_CHARS`."""
    records: tuple[tuple[RewriteKind, str, str], ...]
    chars: int


def _step_records(step: RewriteStep) -> StepRecords:
    """`StepRecords` for `step`, built once per step."""
    if step.records is None:
        records = (*(("retitle", o, n) for o, n in step.retitles.items()),
                   *(("unlink", t, "") for t in sorted(step.unlinked)),
                   *(("inline", u, t) for u, t in step.inlines.items()))
        step.records = StepRecords(
            records, sum(ROW_CHARS + len(old) + len(new)
                         for _, old, new in records))
    return step.records


@dataclass(frozen=True)
class StepTitles:
    """What a replay reads from a step's titles under one canonicalisation.
    A step can hold a title per link of a megabyte, so this is built once
    per step (`_derive`), never per op that replays it: `unlinked`, its
    deleted titles canonical; `gone`, those and its renamed-away titles
    canonical, which an `over_limit` landing makes plain; `copies`, its
    inlined copy per uid."""
    unlinked: frozenset[str]
    gone: frozenset[str]
    copies: Mapping[BlockUid, str]


def _derive(step: RewriteStep, canonical: Callable[[str], str]) -> StepTitles:
    """`StepTitles` for `step`: work in the step's size."""
    unlinked = frozenset(canonical(title) for title in step.unlinked)
    # An inline record keeps the block-ref's uid in old_text. The copy map
    # is keyed by uid; a key that is no uid never matches a `((ref))`.
    copies = {uid: copy for key, copy in step.inlines.items()
              if (uid := parse_block_uid(key)) is not None}
    return StepTitles(
        unlinked=unlinked,
        gone=unlinked | {canonical(title) for title in step.retitles},
        copies=copies)


def _derived(step: RewriteStep,
             canonical: Callable[[str], str]) -> StepTitles:
    """`_derive`, once per step. A batch replays every step under its one
    title reader, so a step asked under another function is a shell bug,
    raised rather than asserted so `python -O` cannot hand it the first
    reader's titles."""
    if step.derived is None:
        step.derived = (canonical, _derive(step, canonical))
    held, titles = step.derived
    if held is not canonical:
        raise AssertionError("a step derives under one canonicalisation")
    return titles


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


# A stored row as the batch compares it with one it would write: its after
# hash, kind and titles, under the base hash it is filed by.
StoredRow = tuple[Sha256Hex, RewriteKind, str, str]


class WalkStep(NamedTuple):
    """Where a walk is (`RewriteHistory.walk`): the hash it reached and the
    step it takes from there, None when that hash's rows are unread."""
    base_hash: Sha256Hex
    step: RewriteStep | None


class RewriteHistory:
    """A block's rewrite steps, found by the hash they start from: what a
    replay walks. Built from rows, it holds every hash those rows start
    from. `lazy()` holds none: the shell reads one base hash's rows when a
    walk reaches it (`next_unread`, `add_read`), and marks one too costly
    to read (`add_unread`), where a walk stops blind. The batch keeps it as
    it records more (`record`), so no op reads a hash's rows twice, nor
    rows its walk never reaches: an op costs what its own steps do,
    however many rows the block holds."""

    def __init__(self, rows: Sequence[BlockRewrite] = ()) -> None:
        # Each base hash's steps by hash pair, oldest first, so a newer
        # step, or one a newer row joins, goes at the end.
        self._by_base: dict[
            Sha256Hex, dict[tuple[Sha256Hex, Sha256Hex], RewriteStep]] = {}
        # the hashes whose rows are read; None for every hash
        self._read: set[Sha256Hex] | None = None
        self._unread: set[Sha256Hex] = set()
        self._stored: dict[Sha256Hex, set[StoredRow]] = {}
        self._add(rows)

    @classmethod
    def lazy(cls) -> RewriteHistory:
        history = cls()
        history._read = set()
        return history

    def is_read(self, base_hash: Sha256Hex) -> bool:
        return self._read is None or base_hash in self._read

    def is_unread(self, base_hash: Sha256Hex) -> bool:
        """Whether the hash's rows were too costly to read."""
        return base_hash in self._unread

    def walk(self, base_hash: Sha256Hex) -> Iterator[WalkStep]:
        """The steps a replay from `base_hash` takes, in order: from each
        hash the newest step not taken yet, at most `MAX_REPLAYED_REWRITES`
        of them. Each step is taken once, so a record can never be replayed
        twice however the hashes line up. The walk ends at a hash with no
        step left, or at the bound, which reads no further; it ends with
        `WalkStep(h, None)` exactly when it reaches a hash `h` whose rows
        are not read, or were too costly to read."""
        taken: set[int] = set()
        for _ in range(MAX_REPLAYED_REWRITES):
            if self.is_unread(base_hash) or not self.is_read(base_hash):
                yield WalkStep(base_hash, None)
                return
            step = self.newest(base_hash, taken)
            if step is None:
                return
            taken.add(id(step))
            yield WalkStep(base_hash, step)
            base_hash = step.after_hash

    def next_unread(self, base_hash: Sha256Hex) -> Sha256Hex | None:
        """The first hash a walk from `base_hash` reaches whose rows are
        not read yet, or None when the walk needs no more."""
        for at in self.walk(base_hash):
            if at.step is None and not self.is_unread(at.base_hash):
                return at.base_hash
        return None

    def add_read(self, base_hash: Sha256Hex,
                 rows: Sequence[BlockRewrite]) -> None:
        """The rows stored from `base_hash`, newest first."""
        assert self._read is not None
        self._read.add(base_hash)
        self._add(rows)

    def add_unread(self, base_hash: Sha256Hex) -> None:
        self._unread.add(base_hash)

    def stored(self, base_hash: Sha256Hex) -> AbstractSet[StoredRow]:
        """The rows stored from a read hash, as `StoredRow`s."""
        return self._stored.get(base_hash, set())

    def newest(self, base_hash: Sha256Hex,
               taken: AbstractSet[int]) -> RewriteStep | None:
        """The newest step from `base_hash` whose id is not in `taken`."""
        for step in reversed(self._by_base.get(base_hash, {}).values()):
            if id(step) not in taken:
                return step
        return None

    def record(self, rows: Sequence[BlockRewrite]) -> None:
        """Keep rows just written, as a read of every row would find them.
        They are newer than every row read, and are read back newest first,
        in reverse of the order written. A row sharing its hash pair with
        an older step joins it, after the newer rows' titles, and the older
        row's copy of a key wins (`_rewrite_steps`)."""
        self._add(tuple(reversed(rows)))

    def _add(self, rows: Sequence[BlockRewrite]) -> None:
        for row in rows:
            self._stored.setdefault(row.base_hash, set()).add(
                (row.after_hash, row.kind, row.old_text, row.new_text))
        for step in reversed(_rewrite_steps(rows)):
            group = self._by_base.setdefault(step.base_hash, {})
            pair = (step.base_hash, step.after_hash)
            older = group.pop(pair, None)
            if older is not None:
                step = RewriteStep(step.base_hash, step.after_hash,
                                   {**step.retitles, **older.retitles},
                                   step.unlinked | older.unlinked,
                                   {**step.inlines, **older.inlines})
            group[pair] = step


def _replay_step(text: str, step: RewriteStep,
                 canonical: Callable[[str], str],
                 allowance: int | None = None) -> tuple[str | None, int]:
    """`text` with one recorded rewrite replayed onto it, and the reads it
    was charged: its rename's scan and splice, and its unlink's
    `unlink.unlink_reads`. The text is None when a splice that can grow
    the text (a longer title, an inlined copy) would carry it past
    `MAX_BLOCK_TEXT_CHARS`. That is judged from the spans
    before splicing: each link grows by up to the title's growth, and a
    title stored before `MAX_PAGE_TITLE_CHARS` may be longer still, so the
    text itself could be far too long to build. The
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

    And None when the step would read past `allowance`, what is left of
    the batch's `MAX_BATCH_REPLAY_WORK`. A rename is charged the text it
    scans and the text it splices, since a longer title grows each link
    and ten renames of a small edit can each build a megabyte; the unlink
    is charged from the splice's projected length, which it reads at least
    three times, before splicing, then its reads. A step the budget stops
    spends all that is left, so once one edit has run the budget out, the
    batch's later steps stop before splicing: what each costs is then its
    own sent text, not the copies or titles from history. A step a cap
    stops pays for what it scanned or built (`_spent`), since a stopped
    step is not kept and the next op would do it all again. A step that
    changes the text is charged the rows an op records for it too
    (`_charged`), and stops past the budget the same way."""
    entering = text
    # what the rename charged, which the unlink's budget leaves out
    renamed = 0
    if step.retitles:
        spans = title_ref_spans(
            text, step.retitles,
            normalize=spelled_or_canonical(canonical, step.retitles))
        projected = spliced_length(text, spans)
        if projected > MAX_BLOCK_TEXT_CHARS:
            return None, _spent(len(text), allowance)
        renamed = len(text) + projected
        if allowance is not None and renamed > allowance:
            return None, allowance
        text = splice(text, spans)
    if step.unlinked or step.inlines:
        titles = _derived(step, canonical)

        def is_deleted(raw: str) -> bool:
            return canonical(normalize_title(raw)) in titles.unlinked

        spans = block_ref_spans(text, titles.copies)
        projected = spliced_length(text, spans)
        if projected > MAX_BLOCK_TEXT_CHARS:
            return None, _spent(renamed + len(text), allowance)
        # Past the budget the step takes what is left of it, so every later
        # step in the batch stops here before splicing anything.
        if allowance is not None and \
                PASSES_PAST_DEPTH * projected > allowance - renamed:
            return None, allowance
        spliced = splice(text, spans)
        reads = unlink_reads(spliced)
        if allowance is not None and reads > allowance - renamed:
            return None, allowance
        if unlink_refused(entering, spliced):
            return None, renamed + reads
        return _charged(step, entering, unlink_stale_refs(spliced, is_deleted),
                        renamed + reads, allowance)
    return _charged(step, entering, text, renamed, allowance)


def _charged(step: RewriteStep, entering: str, text: str, work: int,
             allowance: int | None) -> tuple[str | None, int]:
    """`text` and its charge: the `work` its replay did, plus, when it
    changed `entering`, the rows an op records for the step, every one
    it holds (`_step_records`). A step can hold a title per link of a
    megabyte, which every later edit made before it replays, and writing
    a row costs more than reading the link. Past `allowance` the step
    stops and spends the rest, as when its splice would read past it."""
    cost = work
    if text != entering:
        cost += _step_records(step).chars
    if allowance is not None and cost > allowance:
        return None, allowance
    return text, cost


def _spent(work: int, allowance: int | None) -> int:
    """What a step that stops pays: the `work` it scanned or built, or all
    that is left of `allowance` when that is less. A stopped step is not
    kept (`_cached_step`), so a step that paid nothing would be done again
    by every op of the batch."""
    return work if allowance is None else min(work, allowance)


def _step_key(text: str, step: RewriteStep,
              canonical: Callable[[str], str]) -> StepKey:
    """Everything `_replay_step`'s result depends on, bar the allowance,
    which only decides whether it runs. A step rebuilt from the rows that
    recorded it has the same key: the rows carry what it holds verbatim.
    The step's part is frozensets kept on it, whose hashes are kept too,
    so a lookup costs nothing in the step's size."""
    if step.key_parts is None:
        step.key_parts = (frozenset(step.retitles.items()),
                          frozenset(step.unlinked),
                          frozenset(step.inlines.items()))
    return (canonical, step.key_parts, text)


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
class Replayed:
    """What `replay` made: the text (None when a step stopped it), the
    hash it ends at (that step's base when it stopped), the steps it
    consumed in the order it walked them, every step it replayed by key,
    the reads it spent (`_replay_step`), and whether the walk stopped
    blind, at a hash whose rows were too costly to read."""
    text: str | None
    base_hash: Sha256Hex
    steps: tuple[RewriteStep, ...]
    known: dict[StepKey, str]
    reads: int
    blind: bool


def replay(
    text: str, base_hash: Sha256Hex,
    rewrites: Sequence[BlockRewrite] | RewriteHistory,
    canonical: Callable[[str], str],
    known: Mapping[StepKey, str] | None = None,
    allowance: int | None = None,
) -> Replayed:
    """Re-apply the renames this block already went through to an edit made
    before them, returning the edit's text and base hash as they would read
    had the device seen those renames first, with what else a caller needs
    (`Replayed`).

    A rename or merge rewrites `[[Old]]` in every referencing block. An
    offline device that had edited one of those blocks pushes its own text
    with the pre-rename hash, and plain last-write-wins would let that text
    win verbatim -- re-creating the page the rename had emptied. Following
    the recorded chain instead makes the edit an edit of the rewritten text,
    which then meets the ordinary conflict rules unchanged: it applies
    cleanly if nothing else touched the block, and conflicts under the *new*
    title if something did.

    The steps are the ones `RewriteHistory.walk` takes. `rewrites` is
    newest-record-first, which decides the winner in the unlikely case
    that two rewrites share a base hash (a block edited back to a previous
    text, then renamed again).

    `canonical` is the title canonicalisation the delete matched with (the
    shell passes the database's `title_reader`): an unlink step must treat
    the same spellings as the deleted page as the delete did, or a padded
    `[[ AI ]]` the delete unlinked under plain-space canonicalisation would
    survive the replay and recreate the page. A retitle step matches a spelling
    that is itself a key, else its canonical form, as the rename it replays
    did.

    The unlink step also defuses a leading attribute naming the deleted page
    (`X:: v` becomes `` `X`:: v ``), so the replayed text never re-creates it.

    The text is None when a step would carry it past a text limit, or its
    unlink past `allowance` (`_replay_step`), and the hash is then the base
    of that step. The walk still follows the chain past it, so the steps
    name every title the chain deleted or renamed away
    (`over_limit_landing_text`). A step in `known` is not replayed again.
    A walk that reaches a hash whose rows `history` has not read stops
    there, blind: the text is None and the landing knows no titles."""
    history = (rewrites if isinstance(rewrites, RewriteHistory)
               else RewriteHistory(rewrites))
    consumed: list[RewriteStep] = []
    memo = dict(known or {})
    spent = 0
    replayed: str | None = text
    stopped_at: Sha256Hex | None = None
    for at in history.walk(base_hash):
        if at.step is None:
            return Replayed(None, stopped_at or at.base_hash,
                            tuple(consumed), memo, spent, True)
        consumed.append(at.step)
        if replayed is not None:
            left = None if allowance is None else allowance - spent
            replayed, reads = _cached_step(replayed, at.step, canonical, memo,
                                           left)
            spent += reads
            if replayed is None:
                stopped_at = at.base_hash
        base_hash = at.step.after_hash
    if stopped_at is not None:
        return Replayed(None, stopped_at, tuple(consumed), memo, spent, False)
    return Replayed(replayed, base_hash, tuple(consumed), memo, spent, False)


def over_limit_landing_text(text: str, replayed: Sequence[RewriteStep],
                            canonical: Callable[[str], str],
                            blind: bool = False) -> str:
    """An `over_limit` edit as it lands: as sent, with every title a step of
    its replay deleted (`unlinked`) or renamed away (`retitles`' keys) made
    plain, as a stale unlink does. Landed with those links, the entry would
    re-create the pages. Nothing is renamed, since a longer title is what
    can carry a replay past the cap, and `((uid))` refs stay: one to a
    deleted block is legal and only renders broken. The text can grow only
    by `defuse_attribute`'s two backticks, and two more per link the
    unlink's passes leave (`unlink.unlink_stale_refs`), which only a title
    stored before it was refused can re-form. Each step's titles are
    looked up in the set kept on it (`StepTitles.gone`), not gathered
    again per op. A `blind` replay, whose walk met rows too costly to
    read, knows none of the titles its chain deleted, so every link is
    made plain: any of them could name a deleted page."""
    if blind:
        return unlink_stale_refs(text, lambda _raw: True)
    gone = [titles.gone for step in replayed
            if (titles := _derived(step, canonical)).gone]
    if not gone:
        return text

    def is_gone(raw: str) -> bool:
        title = canonical(normalize_title(raw))
        return any(title in titles for titles in gone)

    return unlink_stale_refs(text, is_gone)


TextEditKind = Literal["identical", "clean", "conflict", "over_limit"]


@dataclass(frozen=True)
class TextEditOutcome:
    """Where a hashed update_text op on a live block lands, once any rename/
    merge rewrites it predates have been replayed onto it
    (`replay`): `identical` to the block's current text (a no-op), `clean`
    (applies without conflict), or a `conflict`, a concurrent edit that must
    land under a header. `text` is the replayed edit -- what actually gets
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
    `reads` is what its steps spent from the batch's
    `MAX_BATCH_REPLAY_WORK`, which an `over_limit` may also have run out;
    `blind` an `over_limit` whose walk met rows too costly to read
    (`over_limit_landing_text`)."""
    kind: TextEditKind
    text: str
    replayed: tuple[RewriteStep, ...] = field(compare=False)
    canonical: Callable[[str], str] = field(compare=False)
    known: Mapping[StepKey, str] = field(compare=False)
    reads: int = field(compare=False)
    blind: bool = field(compare=False)


def classify_text_edit(
    text: str, base_hash: Sha256Hex, current_text: str,
    rewrites: Sequence[BlockRewrite] | RewriteHistory,
    canonical: Callable[[str], str],
    allowance: int | None = None,
) -> TextEditOutcome:
    """Where the edit lands (`TextEditOutcome`). `rewrites` is the block's
    rows, or the steps the batch keeps for it (`RewriteHistory`);
    `allowance` is what is left of the batch's replay budget, None for no
    budget."""
    walked = replay(text, base_hash, rewrites, canonical,
                    allowance=allowance)
    steps, known, reads = walked.steps, walked.known, walked.reads

    def outcome(kind: TextEditKind, landed: str) -> TextEditOutcome:
        return TextEditOutcome(kind, landed, steps, canonical, known, reads,
                               walked.blind)

    if walked.text is None:
        return outcome("over_limit", text)
    if walked.text == current_text:
        return outcome("identical", walked.text)
    if steps and text_limit_violation(walked.text) is not None:
        return outcome("over_limit", text)
    if text_hash(current_text) == walked.base_hash:
        return outcome("clean", walked.text)
    return outcome("conflict", walked.text)


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


def rewrite_chain(
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

    A replayed step is recorded whole (`_step_records`), every title,
    rename and copy it holds, not only what `sent` moved. The client's
    next edit is hashed on `sent` and replays these rows: a ref or link it
    adds back, which `sent` had dropped, must still get its copy or lose
    its link. Writing them is charged to the batch's budget (`_charged`).

    `known` is the steps the classification replayed. The chain starts
    from the text the classification did (the stale unlink is the one
    `unlink_stale_text` made), so its steps are those, from the same texts,
    and are looked up rather than replayed; the check that the rows replay
    to `written` looks them up too, and the stale unlink by the key its
    rows rebuild. Given `known`, a step that is not found leaves no rows,
    since its work was never counted against the batch's budget (bar a
    step over empty text, which costs nothing). Without it, every step is
    replayed."""
    memo = dict(known or {})
    allowance = None if known is None else 0
    rows: list[BlockRewrite] = []
    text = sent
    base = text_hash(sent)

    def record(after_text: str,
               records: Sequence[tuple[RewriteKind, str, str]]) -> None:
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
        record(after_text, _step_records(step).records)
    if text != written or not rows:
        return ()
    # what a later edit will actually do: replay the recorded rows
    if replay(sent, text_hash(sent), rows, canonical, memo,
               allowance).text != written:
        return ()
    return tuple(rows)


def stale_titles_linked(
    text: str, stale: AbstractSet[CanonicalTitle],
    canonical: Callable[[str], str],
) -> tuple[CanonicalTitle, ...]:
    """The titles in `stale` whose unlink alone would change `text`, in
    order: the ones the rows of a stale unlink name. Found in one pass over
    the text (`unlink.linked_titles`), however many titles were deleted
    since the batch's `seen_seq`, which the client picks."""
    if not stale:
        return ()
    linked = {canonical(normalize_title(raw)) for raw in linked_titles(text)}
    # A set intersection walks the smaller set, here the text's titles:
    # walking `stale` would cost every deleted title per op.
    return tuple(sorted(stale & linked))
