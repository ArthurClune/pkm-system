# pattern: Functional Core
"""A reference model of what `POST /api/ops` does to the blocks a property
test generates, written from the architecture docs rather than from the
server: an independent second implementation the state machine checks the
real server against. It must never import `pkm.server.*` or
`pkm.planning` (a test pins that), or it would agree with the server by
construction.

The rules come from backend.md § Planning (Ordering), § Conflicts,
§ Missing targets, § Stale batches, § Concurrent structure edits and § Page
mutations and the sidebar. Each rule below names the row it encodes. Where
the docs are silent the rule follows the code, and says so.

Ops are plain dicts in the wire shape of `pkm.contracts.ops`. The model
tracks only the blocks the ops address; the conflict headers and copies
the server writes on today's daily page are represented by
`Outcome.kept_texts`, not as blocks.

Text rewriting (a page delete's unlink and inline, a stale batch's unlink
and fenced attribute, and their replay onto a later edit) is modelled over
the strategies' vocabulary only: words, `[[Title]]`, `#Title`, `((uid))`
and a leading `Title::` or `[[Title]]::`, never aliases, nesting, embeds
or a link inside code. The attribute grammar itself comes from `pkm.refs`,
which the derived-refs invariant already trusts."""
from __future__ import annotations

from collections.abc import (Callable, Collection, Iterable, Iterator, Mapping,
                             Sequence)
import re
from dataclasses import dataclass, field, replace
from typing import Any

from pkm.contracts.ops import (UID_RE, BlockUid, OrderIdx, Sha256Hex, SyncSeq,
                               subtree_hash, text_hash)
from pkm.contracts.titles import RawTitle
from pkm.refs import (attribute_title_span, extract, is_blank_title,
                      strip_code, title_syntax_reason)
from pkm.test_data.ids import order_idx_of, raw_title_of, uid_of
from props.limit_texts import (LIMIT_TEXTS, NESTING_CAP, PAST_LIMIT_TEXTS,
                               TEXT_CAP)

# What a whitespace-only page_title resolves to: the ops path never rejects
# a batch over a blank title (code: ops_apply.UNTITLED_PAGE_TITLE).
UNTITLED = "Untitled"

Op = Mapping[str, Any]
SkipEntry = tuple[int, str, str, str]
# Records the current op as skipped, with the given reason.
SkipFn = Callable[[str], None]


# `(uid, base_hash, after_hash, kind, old_title, new_title)`.
RewriteRow = tuple[BlockUid, Sha256Hex, Sha256Hex, str, str, str]


@dataclass(frozen=True)
class MBlock:
    uid: BlockUid
    page: str
    parent: BlockUid | None
    order_idx: OrderIdx
    text: str
    heading: int | None
    collapsed: bool
    view_type: str | None


@dataclass(frozen=True)
class Outcome:
    """What a batch does, as the client sees it. `skipped` mirrors the ack's
    `skipped` entries as `(index, op, uid, reason)`. `kept_texts` are texts
    the conflict rules say must now exist under a `[[conflict]]` header on
    today's daily page: a losing text, an orphaned edit, a diverted create's
    text, a diverged delete's subtree. The notes a skipped structural op
    lands (`move skipped: ...`) are not listed: they are messages, not text
    a user wrote."""
    status: int
    skipped: tuple[SkipEntry, ...] = ()
    kept_texts: tuple[str, ...] = ()
    # which rewrite-recording paths the batch's edits took, for the state
    # machine's event tally; not part of what the client sees
    paths: tuple[str, ...] = field(default=(), compare=False)


class _Rejected(Exception):
    """The batch is a 400: nothing in it applies."""


def _valid_uid(uid: BlockUid) -> bool:
    return UID_RE.fullmatch(uid) is not None


def _title_violation(ops: Sequence[Op]) -> bool:
    """backend.md § Missing targets: "title syntax" is still a 400. Checked
    over the whole batch before any op applies: a create's, create_page's or
    move's page_title (even one a live parent makes the server ignore), and
    every `[[ref]]`/`#tag` title in a create's or edit's text. An edit's
    page_title is only a header label and is never checked (§ Conflicts)."""
    for op in ops:
        kind = op["op"]
        title = op.get("page_title") if kind in ("create", "create_page",
                                                  "move") else None
        if title is not None and title_syntax_reason(title) is not None:
            return True
        if kind in ("create", "update_text"):
            if any(title_syntax_reason(ref.title) is not None
                   for ref in extract(op["text"]).refs):
                return True
    return False


def _limit_violation(ops: Sequence[Op]) -> bool:
    """backend.md § Planning (text limits): a create's or edit's text
    longer than 1,000,000 code points, or with `[[` runs nested deeper
    than 32 outside code, is a 400 for the whole batch. Judged over the
    whole batch before titles, an op the server would skip included; no
    other op's text is judged. Of the texts the strategies draw, exactly
    `PAST_LIMIT_TEXTS` are past a limit (props/limit_texts.py).

    That holds only while every other drawn text stays well inside both
    limits, so a text outside `LIMIT_TEXTS` is checked against a bound no
    judge is needed for: at most the cap's characters and at most the
    nesting cap's `[[` (a run nests only inside its own `[[`). A strategy
    that starts drawing such texts fails here, not as a wrong verdict."""
    texts = [op["text"] for op in ops if op["op"] in ("create", "update_text")]
    for text in texts:
        assert text in LIMIT_TEXTS or (
            len(text) <= TEXT_CAP and text.count("[[") <= NESTING_CAP), (
            "a drawn text outside props/limit_texts.py reaches a limit, so"
            " membership no longer decides the verdict:"
            f" {len(text)} characters, {text.count('[[')} `[[`")
    return any(text in PAST_LIMIT_TEXTS for text in texts)


def _page_name(title: RawTitle) -> str:
    return UNTITLED if is_blank_title(title) else title


# --- text rewriting ----------------------------------------------------------

_LINK = re.compile(r"\[\[([^\[\]]+)\]\]")
_TAG = re.compile(r"(?:^|(?<=[\s(]))#([\w/.\-]+)")
_BLOCK_REF = re.compile(r"\(\(([^()\s]+)\)\)")


def unlink_titles(text: str, titles: Collection[str]) -> str:
    """backend.md § Page mutations: every `[[Title]]` and `#Title` naming
    one of `titles` becomes plain `Title`. A leading `Title::` is not a
    link and is left alone."""
    def plain(m: re.Match[str]) -> str:
        return m.group(1) if m.group(1) in titles else m.group(0)
    return _TAG.sub(plain, _LINK.sub(plain, text))


def attribute_name(text: str) -> str | None:
    """The leading attribute's name as written, or None."""
    span = attribute_title_span(strip_code(text), text)
    return None if span is None else span.raw_title


def fence_attribute(text: str, titles: Collection[str]) -> str:
    """backend.md § Stale batches: a leading attribute naming one of
    `titles` gets its name code-fenced in place (`` `X`:: v ``). A name
    holding a backtick is no attribute, so it is left alone."""
    span = attribute_title_span(strip_code(text), text)
    if span is None or span.raw_title not in titles:
        return text
    name_end = span.start + len(span.raw_title)
    return (text[:span.start] + "`" + span.raw_title + "`"
            + text[name_end:])


def unlink_stale(text: str, titles: Collection[str]) -> str:
    """What a stale batch writes for a text: links unlinked, then a leading
    attribute naming a deleted title fenced."""
    return fence_attribute(unlink_titles(text, titles), titles)


def inline_refs(text: str, copies: Mapping[BlockUid, str]) -> str:
    """Each `((uid))` with a copy becomes that copy, in one pass: a copy's
    own refs are not rescanned."""
    def copy_of(m: re.Match[str]) -> str:
        # `_BLOCK_REF` is wider than a uid: only a uid-shaped ref has a copy.
        ref = m.group(1)
        return copies[uid_of(ref)] if UID_RE.fullmatch(ref) and uid_of(ref) in copies else m.group(0)

    return _BLOCK_REF.sub(copy_of, text)


_NEWLINES = re.compile(r"\s*\n\s*")


def _plain_copy(text: str) -> str:
    """backend.md § Page mutations and the sidebar: a block's copy drops
    its leading attribute, and its newlines are folded to one space each
    run (generated texts carry no task marker)."""
    span = attribute_title_span(strip_code(text), text)
    text = text if span is None else text[span.end:].lstrip()
    return _NEWLINES.sub(" ", text)


def page_copies(title: RawTitle, page_texts: Mapping[BlockUid, str]) -> dict[BlockUid, str]:
    """The text a page delete copies in place of a `((ref))` to each of the
    page's blocks: the block's plain copy, with refs to the page's other
    blocks resolved one level deep (deeper ones and cycles dropped, code:
    unlink._Copies) and links to the page unlinked."""
    plain = {u: _plain_copy(t) for u, t in page_texts.items()}
    blanks = {u: "" for u in page_texts}
    return {u: unlink_titles(inline_refs(inline_refs(t, plain), blanks),
                             {title})
            for u, t in plain.items()}


@dataclass(frozen=True)
class Rewrite:
    """One recorded rewrite of a block's text: the `block_rewrites` rows
    sharing a before/after hash pair (backend.md § Database). `unlinked`
    are deleted titles, `inlines` the `(uid, copied text)` pairs a page
    delete put in place of `((uid))`. A hashed edit whose base hash is
    `base_hash` has this replayed onto its text first. `before` is the
    text `base_hash` hashes: what a device that missed the rewrite still
    holds, which strategies re-send. It is not part of the rows."""
    base_hash: Sha256Hex
    after_hash: Sha256Hex
    unlinked: frozenset[str] = frozenset()
    inlines: tuple[tuple[BlockUid, str], ...] = ()
    before: str = field(default="", compare=False)

    def replay(self, text: str) -> str:
        text = unlink_titles(inline_refs(text, dict(self.inlines)),
                             self.unlinked)
        return fence_attribute(text, self.unlinked)

    def rows(self, uid: BlockUid) -> set[RewriteRow]:
        """As `(uid, base_hash, after_hash, kind, old_title, new_title)`."""
        return ({(uid, self.base_hash, self.after_hash, "unlink", t, "")
                 for t in self.unlinked}
                | {(uid, self.base_hash, self.after_hash, "inline", u, c)
                   for u, c in self.inlines})


@dataclass(frozen=True)
class PageDelete:
    """What `DELETE /api/page/{title}` does. `blockers` maps each refused
    block's uid to its reason; `copies` is what a 200 inlined in place of
    a `((ref))` to each of the page's blocks."""
    status: int
    title: RawTitle = raw_title_of("")
    blockers: Mapping[BlockUid, str] = field(default_factory=dict)
    copies: Mapping[BlockUid, str] = field(default_factory=dict)

    def rewrite(self, text: str) -> tuple[str, bool, dict[BlockUid, str]]:
        """A referencing text as the delete leaves it, whether unlinking
        changed it, and the copies it inlined."""
        applied: dict[BlockUid, str] = {u: self.copies[u]
                                   for u in extract(text).block_refs
                                   if u in self.copies}
        inlined = inline_refs(text, applied)
        new = unlink_titles(inlined, {self.title})
        return new, new != inlined, applied

    def blocker(self, text: str) -> str | None:
        """Why the delete refuses a referencing text, or None."""
        if any(r.kind == "attribute" and r.title == self.title
               for r in extract(text).refs):
            return "used_as_attribute"
        new, _, applied = self.rewrite(text)
        # backend.md § Page mutations: the copies inlined may not carry a
        # text past the length cap, nor further past it, judged on the
        # inlined text before unlinking and ahead of the rewrite's own
        # blockers. Unlinking only shortens, so the unlinked text needs no
        # second length judgement. The code judges the nesting there too,
        # since copies that open runs and copies that close them join into
        # one deep link, and the depth times the length; every drawn text
        # closes the runs it opens, so inlining never deepens a drawn
        # text's nesting, and no drawn text with a ref is long.
        inlined = inline_refs(text, applied)
        if len(inlined) > TEXT_CAP and len(inlined) > len(text):
            return "limit"
        if attribute_name(text) != attribute_name(new):
            return "attribute"
        parsed = extract(new)
        if (any(r.title == self.title for r in parsed.refs)
                or any(u in self.copies for u in parsed.block_refs)):
            return "residual"
        return None


def replay_peak(steps: Sequence[Rewrite], text: str, base: str) -> int:
    """The longest text `replay_chain` makes on its way: each step's
    inlined copies, before its unlink shortens them, and each step's
    result. 0 when no step replays: the sent text is judged on arrival."""
    peak = 0
    for step in replay_chain(steps, text, base)[2]:
        peak = max(peak, len(inline_refs(text, dict(step.inlines))))
        text = step.replay(text)
        peak = max(peak, len(text))
    return peak


def replay_chain(steps: Sequence[Rewrite], text: str,
                 base: str) -> tuple[str, str, list[Rewrite]]:
    """Replay `steps` (newest first) onto an edit's `text`, following the
    chain from its `base` hash: at most ten steps, each used once (code:
    ops_core.MAX_REPLAYED_REWRITES). Returns the text, the hash the edit
    now counts as based on, and the steps used, in order."""
    left = list(steps)
    used: list[Rewrite] = []
    for _ in range(10):
        match = next((s for s in left if s.base_hash == base), None)
        if match is None:
            break
        left.remove(match)
        used.append(match)
        text, base = match.replay(text), match.after_hash
    return text, base, used


class Model:
    """The pool blocks as the server should hold them. `deleted` is every
    uid an op or a page delete removed and nothing has re-created since;
    strategies draw "deleted" targets from it. `pages` is every page that
    exists, `rewrites` each uid's recorded rewrites, newest first, and
    `deletions` each page delete as `(title, journal head after it)`."""

    def __init__(self) -> None:
        self.blocks: dict[BlockUid, MBlock] = {}
        self.pages: set[str] = set()
        self.deleted: set[BlockUid] = set()
        self.rewrites: dict[BlockUid, list[Rewrite]] = {}
        self.deletions: list[tuple[str, int]] = []
        # filled per batch for Outcome.paths
        self._paths: list[str] = []

    @classmethod
    def from_rows(cls, pages: Iterable[str], rows: Iterable[MBlock]) -> Model:
        m = cls()
        m.pages = set(pages)
        for row in rows:
            m.blocks[row.uid] = row
            m.pages.add(row.page)
            m._touch(row.text)
        return m

    def snapshot(self) -> dict[BlockUid, MBlock]:
        return dict(self.blocks)

    def stale_titles(self, seen_seq: SyncSeq | None) -> frozenset[str]:
        """backend.md § Stale batches: the titles deleted after `seen_seq`;
        none without one. A `seen_seq` past the journal head is not
        modelled: the state machine never draws one."""
        if seen_seq is None:
            return frozenset()
        return frozenset(t for t, seq in self.deletions if seq > seen_seq)

    def rewrite_rows(self) -> set[RewriteRow]:
        """Every `block_rewrites` row the model expects for its uids."""
        return {row for uid, steps in self.rewrites.items()
                for step in steps for row in step.rows(uid)}

    def apply(self, ops: Sequence[Op], seen_seq: SyncSeq | None = None) -> Outcome:
        """Apply one batch atomically: a 400 leaves the model unchanged
        (backend.md § The write path: one transaction per batch)."""
        saved = (dict(self.blocks), set(self.pages), set(self.deleted),
                 {u: list(s) for u, s in self.rewrites.items()})
        stale = self.stale_titles(seen_seq)
        skipped: list[SkipEntry] = []
        kept: list[str] = []
        self._paths = []
        try:
            if _limit_violation(ops) or _title_violation(ops):
                raise _Rejected
            for index, op in enumerate(ops):
                self._apply_op(index, op, skipped, kept, stale)
        except _Rejected:
            self.blocks, self.pages, self.deleted, self.rewrites = saved
            return Outcome(400)
        for text in kept:
            self._touch(text)
        return Outcome(200, tuple(skipped), tuple(kept), tuple(self._paths))

    def delete_page(self, title: RawTitle, others: Mapping[BlockUid, str],
                    seq: SyncSeq) -> PageDelete:
        """`DELETE /api/page/{title}` (backend.md § Page mutations and the
        sidebar). `others` is the text of every block the model does not
        track that is off the page (conflict entries, seed rows), since
        they can refuse the delete too. A 200 removes the page and its
        blocks, rewrites each referencing pool block and records its
        rewrite, and records the deletion at journal head `seq`."""
        if title not in self.pages:
            return PageDelete(404)
        on_page = {u: b.text for u, b in self.blocks.items()
                   if b.page == title}
        plan = PageDelete(200, title, {}, page_copies(title, on_page))
        sources = {**{u: b.text for u, b in self.blocks.items()
                      if b.page != title}, **others}
        blockers = {u: reason for u, text in sources.items()
                    if (reason := plan.blocker(text)) is not None}
        if blockers:
            return replace(plan, status=409, blockers=blockers)
        for uid in on_page:
            del self.blocks[uid]
            self.deleted.add(uid)
        for uid, block in list(self.blocks.items()):
            new, unlinked, applied = plan.rewrite(block.text)
            if new != block.text:
                self.blocks[uid] = replace(block, text=new)
                self._record(uid, Rewrite(
                    text_hash(block.text), text_hash(new),
                    frozenset({title} if unlinked else ()),
                    tuple(sorted(applied.items())), block.text))
        self.pages.discard(title)
        self.deletions.append((title, seq))
        return plan

    # --- rewrites -----------------------------------------------------------

    def _touch(self, text: str) -> None:
        """A written text's refs create the pages they name (code:
        store.reindex_refs_for_text)."""
        self.pages.update(r.title for r in extract(text).refs
                          if not is_blank_title(r.title))

    def _record(self, uid: BlockUid, step: Rewrite) -> None:
        """Record a rewrite as the newest. Rows sharing its hash pair with
        an older rewrite of the block replay as one step with it (code:
        ops_core._rewrite_steps), where the older row's copy of a uid wins."""
        steps = self.rewrites.setdefault(uid, [])
        old = next((s for s in steps if (s.base_hash, s.after_hash)
                    == (step.base_hash, step.after_hash)), None)
        if old is not None:
            steps.remove(old)
            step = replace(step, unlinked=step.unlinked | old.unlinked,
                           inlines=tuple(sorted(
                               {**dict(step.inlines),
                                **dict(old.inlines)}.items())))
        steps.insert(0, step)

    def _replay(self, uid: BlockUid, text: str,
                base: str) -> tuple[str, str, list[Rewrite]]:
        """backend.md § Database, `block_rewrites`: a hashed edit made
        before recorded rewrites of its block has them replayed onto its
        text first."""
        return replay_chain(self.rewrites.get(uid, ()), text, base)

    def _record_written(self, uid: BlockUid, sent: str, written: str,
                        stale: Collection[str],
                        replayed: Sequence[Rewrite]) -> None:
        """backend.md § Conflicts: text written to `uid` that differs
        from the text the client sent, because of a stale unlink or a
        replay, records how the one became the other, so the client's next
        hashed edit replays onto the written text. One rewrite per pass
        that changed the text, chained by hash: the unlink of the stale
        titles that changed it, then each replayed step. A chain that does
        not reproduce the written text is not recorded (code:
        ops_core._rewrite_chain)."""
        titles = frozenset(t for t in stale if unlink_stale(sent, {t}) != sent)
        if written == sent or not (titles or replayed):
            return
        chain: list[Rewrite] = []
        text = sent
        placeholder = text_hash("")   # both hashes are replaced below
        passes = [(lambda t: unlink_stale(t, titles),
                   Rewrite(placeholder, placeholder, titles))
                  ] if titles else []
        passes += [(step.replay, step) for step in replayed]
        for rewrite, step in passes:
            after = rewrite(text)
            if after != text:
                base = chain[-1].after_hash if chain else text_hash(sent)
                chain.append(replace(step, base_hash=base,
                                     after_hash=text_hash(after),
                                     before=text))
            text = after
        if (not chain or text != written
                or replay_chain(chain, sent, text_hash(sent))[0] != written):
            return
        for step in chain:
            self._record(uid, step)

    # --- tree helpers -------------------------------------------------------

    def _children(self, uid: BlockUid) -> list[MBlock]:
        return sorted((b for b in self.blocks.values() if b.parent == uid),
                      key=lambda b: (b.order_idx, b.uid))

    def subtree(self, uid: BlockUid) -> list[BlockUid]:
        """uid and its descendants, pre-order, siblings by (order_idx, uid):
        the order the server copies a diverged delete's rows in."""
        out = [uid]
        for child in self._children(uid):
            out.extend(self.subtree(child.uid))
        return out

    def _chain(self, uid: BlockUid) -> list[BlockUid]:
        """uid and every ancestor above it."""
        out: list[BlockUid] = []
        cur: BlockUid | None = uid
        while cur is not None and cur not in out:
            out.append(cur)
            cur = self.blocks[cur].parent
        return out

    def _shift(self, page: str, parent: BlockUid | None, key: int,
               moving: BlockUid | None = None) -> None:
        """backend.md § Planning, Ordering: landing at `key` first
        bumps every sibling (same page, same parent) whose key is >= `key`
        by one. A moving block is left out of its own shift: its key is
        overwritten when it lands, so only its siblings move."""
        for b in list(self.blocks.values()):
            if (b.page == page and b.parent == parent and b.order_idx >= key
                    and b.uid != moving):
                self.blocks[b.uid] = replace(b, order_idx=order_idx_of(b.order_idx + 1))

    # --- ops ----------------------------------------------------------------

    def _apply_op(self, index: int, op: Op, skipped: list[SkipEntry],
                  kept: list[str], stale: frozenset[str]) -> None:
        kind = op["op"]
        if kind == "create_page":
            title = _page_name(op["page_title"])
            # backend.md § Stale batches: a stale batch's create_page for a
            # deleted title is dropped, and not reported.
            if title in stale:
                return
            # backend.md § The write path: create_page idempotently ensures
            # a page exists.
            self.pages.add(title)
            return
        uid = op["uid"]

        def skip(reason: str) -> None:
            skipped.append((index, kind, uid, reason))

        # § Stale batches: a stale batch's create / update_text text has its
        # links to deleted titles unlinked and a leading attribute naming
        # one fenced, before anything else reads it.
        text = (unlink_stale(op["text"], stale)
                if kind in ("create", "update_text") and stale else
                op.get("text", ""))
        if kind == "create":
            self._create(op, uid, text, skip, kept, stale)
            return
        block = self.blocks.get(uid)
        if block is None:
            # backend.md § Missing targets: a skipped op whose uid fails
            # UID_RE is still a 400.
            if not _valid_uid(uid):
                raise _Rejected
            # § Missing targets, every block-gone row reports
            # block_not_found. Rows `set_collapsed`/`delete`: a no-op, which
            # (code, not docs) the ack still lists (ops_core.skip_report).
            # Row `move`/`set_heading`/`set_view_type`: skipped; such a
            # move's parent uid is never shape-checked (code:
            # ops_core.impossible_uid_reason).
            skip("block_not_found")
            # § Missing targets, row `update_text`, block gone, hashed or
            # not: the text lands; a blank text lands nothing.
            if kind == "update_text" and text.strip():
                kept.append(text)
            return
        if kind == "update_text":
            self._update_text(op, block, text, skip, kept, stale)
        elif kind == "move":
            self._move(op, block, skip, stale)
        elif kind == "delete":
            self._delete(op, uid, kept)
        elif kind == "set_collapsed":
            self.blocks[uid] = replace(block, collapsed=bool(op["collapsed"]))
        elif kind == "set_heading":
            self.blocks[uid] = replace(block, heading=op.get("heading"))
        elif kind == "set_view_type":
            self.blocks[uid] = replace(block, view_type=op["view_type"])
        else:
            raise AssertionError(f"unknown op kind: {kind}")

    def _create(self, op: Op, uid: BlockUid, text: str, skip: SkipFn,
                kept: list[str], stale: frozenset[str]) -> None:
        # backend.md § Missing targets: an invalid uid is a 400 -- for a
        # create, checked before anything else.
        if not _valid_uid(uid):
            raise _Rejected
        parent = op.get("parent_uid")
        exists = uid in self.blocks
        if not exists and parent is not None and parent not in self.blocks:
            # § Missing targets, row `create`, parent gone: not created; its
            # text lands, a blank text lands nothing. A parent uid failing
            # UID_RE is a 400 instead.
            if not _valid_uid(parent):
                raise _Rejected
            skip("parent_not_found")
            if text.strip():
                kept.append(text)
            return
        # § Missing targets: "uid already exists" is a 400.
        if exists:
            raise _Rejected
        if parent is not None:
            # § Concurrent structure edits, row `create` under a live parent
            # on another page: created on the parent's page; page_title is
            # ignored and creates no page.
            page = self.blocks[parent].page
        else:
            # § The write path: page_title places (and may create) the page
            # of a top-level create.
            page = _page_name(op["page_title"])
            if page in stale:
                # § Missing targets, row top-level `create` into a page
                # deleted since `seen_seq`: not created; its text lands, a
                # blank text lands nothing.
                skip("page_deleted")
                if text.strip():
                    kept.append(text)
                return
            self.pages.add(page)
        key = op["order_idx"]
        self._shift(page, parent, key)
        # Code, not docs: a create keeps its heading and view_type, and
        # starts uncollapsed (ops_core.plan_op's InsertBlock).
        self.blocks[uid] = MBlock(
            uid=uid, page=page,
            parent=parent, order_idx=key, text=text,
            heading=op.get("heading"), collapsed=False,
            view_type=op.get("view_type"))
        self._touch(text)
        self._record_written(uid, op["text"], text, stale, ())
        self.deleted.discard(uid)

    def _update_text(self, op: Op, block: MBlock, text: str, skip: SkipFn,
                     kept: list[str], stale: frozenset[str]) -> None:
        sent = op["text"]
        base = op.get("base_text_hash")
        if base is None:
            # backend.md § Conflicts: a hashless edit to a live block is
            # unconditional last-write-wins.
            self._write(block, text)
            self._record_written(block.uid, sent, text, stale, ())
            return
        unreplayed = text
        steps = self.rewrites.get(block.uid, ())
        if replay_peak(steps, unreplayed, base) > TEXT_CAP:
            # backend.md § Conflicts: a replay may not store text past a
            # limit. The edit lands, the block keeps its text. Every
            # drawn text closes the runs it opens, so its copies cannot
            # join into a deeper link and only the length cap can be
            # reached (code: ops_core._replay_step judges each step's
            # splice on both, and on the depth times the length).
            # § Planning, "Replayed text": the landing has every title
            # the chain deleted or renamed away made plain, the steps past
            # the one over the cap included (code:
            # ops_core.over_limit_landing_text). The machine draws no
            # rename, so a `Rewrite` carries no retitles and `gone` is the
            # deleted titles alone; a rename rule must add the old titles.
            gone = frozenset().union(
                *(step.unlinked
                  for step in replay_chain(steps, unreplayed, base)[2]))
            landed = unlink_stale(unreplayed, gone)
            self._paths.append(
                "update_text replay: over the length cap"
                + (", gone titles unlinked" if landed != unreplayed else ""))
            skip("text_limit")
            kept.append(landed)
            return
        text, base, replayed = self._replay(block.uid, text, base)
        kind = ("identical" if text == block.text else
                "clean" if text_hash(block.text) == base else "conflict")
        if replayed:
            self._paths.append(f"update_text replay: {kind}"
                               + (", edit rewritten" if text != unreplayed
                                  else ""))
        elif kind == "identical" and text != sent:
            self._paths.append("update_text: identical after stale unlink")
        if text == block.text:
            # Row "Incoming text equals current": no-op, whatever the hash.
            # Code, not docs: this is tested before the hash, so an
            # identical edit with a stale hash keeps nothing
            # (ops_core.classify_text_edit).
            self._record_written(block.uid, sent, text, stale, replayed)
            return
        if text_hash(block.text) != base:
            # backend.md § Conflicts, rows "Hashes differ" and "Block
            # exists, hash mismatch": incoming wins, the overwritten text
            # is kept.
            kept.append(block.text)
        # Row "hash(current) == base_text_hash": clean apply.
        self._write(block, text)
        self._record_written(block.uid, sent, text, stale, replayed)

    def _write(self, block: MBlock, text: str) -> None:
        self.blocks[block.uid] = replace(block, text=text)
        self._touch(text)

    def _move(self, op: Op, block: MBlock, skip: SkipFn,
              stale: frozenset[str]) -> None:
        parent = op.get("parent_uid")
        key = op["order_idx"]
        if parent is not None:
            if parent not in self.blocks:
                # § Missing targets, row `move`, block exists, parent gone:
                # the block stays put. An invalid parent uid is a 400.
                if not _valid_uid(parent):
                    raise _Rejected
                skip("parent_not_found")
                return
            if block.uid in self._chain(parent):
                # § Concurrent structure edits, row `move` whose target is
                # the block or its descendant: skipped as a cycle.
                skip("cycle")
                return
            # § Concurrent structure edits, row `move` under a parent no
            # longer on page_title's page: lands on the parent's page.
            page = self.blocks[parent].page
        else:
            # § The write path: page_title places a top-level move; absent,
            # the block stays on its page.
            title = op.get("page_title")
            page = _page_name(title) if title is not None else block.page
            if title is not None and page in stale:
                # § Missing targets, row top-level `move` onto a page
                # deleted since `seen_seq`: the block stays put.
                skip("page_deleted")
                return
            self.pages.add(page)
        # § The write path, Ordering: shift the destination's siblings at or
        # after the key, then place the block. Its old group is left with a
        # gap: nothing renumbers.
        self._shift(page, parent, key, moving=block.uid)
        subtree = self.subtree(block.uid)
        self.blocks[block.uid] = replace(block, parent=parent,
                                         order_idx=key)
        if page != block.page:
            # § The write path: a cross-page move re-pages the whole subtree.
            for u in subtree:
                self.blocks[u] = replace(self.blocks[u], page=page)

    def _delete(self, op: Op, uid: BlockUid, kept: list[str]) -> None:
        subtree = self.subtree(uid)
        base = op.get("base_subtree_hash")
        if base is not None and subtree_hash(
                (u, self.blocks[u].text) for u in subtree) != base:
            # backend.md § Conflicts, row "Guarded `delete` whose subtree
            # changed": the delete wins, but every text of the subtree is
            # kept first. A matching or hashless delete keeps nothing.
            kept.extend(self.blocks[u].text for u in subtree)
        # § The write path: delete removes a block and its subtree.
        for u in subtree:
            del self.blocks[u]
            self.deleted.add(u)


# --- `pkm batch` positions ---------------------------------------------------

_UID_SPEC = re.compile(r"^\(\((.+)\)\)\Z")
_ALIAS_SPEC = re.compile(r"^\{\{(.+)\}\}\Z")

Groups = dict[BlockUid | None, list[BlockUid]]


def positions_after(groups: Mapping[BlockUid | None, Sequence[BlockUid]],
                    commands: Sequence[Mapping[str, Any]],
                    new_uids: Iterator[BlockUid]) -> Groups:
    """Each parent's children, in order, after the `pkm batch` `commands`
    run over `groups` (parent uid -> child uids, None for the page's top
    level). Positions only, never order keys: this is the CLI contract the
    planner's keys must realise (cli-and-mcp.md § Pure planners, on `index`).

    - create/todo: lands at `index` among the parent's children as the
      earlier commands left them; None, or an index past the end, appends.
      Each mints the next of `new_uids`, in command order; `as` names it
      for a later `{{alias}}`.
    - move: the block leaves its group first, then lands at `index` among
      the destination's children without it; None or past the end appends.
      Its subtree comes with it.
    - delete: removes the block and its subtree.
    - update: no change of place.

    A command whose block or parent is not in `groups` changes nothing (a
    create still spends its uid), and a move into the block itself or its
    own subtree is left undone: backend.md § Missing targets and
    § Concurrent structure edits, which the server reports as skips. Parent
    specs are `((uid))` or `{{alias}}`; a `## Heading` spec, which the
    planner would create, and `outline` are not modelled and raise.
    The input is not mutated."""
    out: Groups = {k: list(v) for k, v in groups.items()}
    aliases: dict[str, BlockUid] = {}

    def parent_of(uid: BlockUid) -> tuple[bool, BlockUid | None]:
        for parent, kids in out.items():
            if uid in kids:
                return True, parent
        return False, None

    def subtree(uid: BlockUid) -> list[BlockUid]:
        found = [uid]
        for kid in out.get(uid, []):
            found.extend(subtree(kid))
        return found

    def named(value: str) -> BlockUid:
        m = _ALIAS_SPEC.match(value)
        return aliases[m.group(1)] if m else uid_of(value)

    def parent_spec(spec: str | None) -> BlockUid | None:
        if spec is None:
            return None
        m = _UID_SPEC.match(spec)
        if m:
            return uid_of(m.group(1))
        if _ALIAS_SPEC.match(spec):
            return named(spec)
        raise ValueError(f"parent spec not modelled: {spec!r}")

    def live(uid: BlockUid | None) -> bool:
        return uid is None or parent_of(uid)[0]

    def land(parent: BlockUid | None, uid: BlockUid, index: int | None) -> None:
        group = out.setdefault(parent, [])
        group.insert(len(group) if index is None else min(index, len(group)),
                     uid)

    for command in commands:
        kind, params = command["command"], command["params"]
        if kind in ("create", "todo"):
            uid = next(new_uids)
            if params.get("as"):
                aliases[params["as"]] = uid
            parent = parent_spec(params.get("parent"))
            if live(parent):
                land(parent, uid, params.get("index"))
                out[uid] = []
        elif kind == "move":
            uid = named(params["uid"])
            parent = parent_spec(params.get("parent"))
            found, source = parent_of(uid)
            if found and live(parent) and parent not in subtree(uid):
                out[source].remove(uid)
                land(parent, uid, params.get("index"))
        elif kind == "delete":
            uid = named(params["uid"])
            found, source = parent_of(uid)
            if found:
                out[source].remove(uid)
                for u in subtree(uid):
                    out.pop(u, None)
        elif kind != "update":
            raise ValueError(f"command not modelled: {kind!r}")
    return out
