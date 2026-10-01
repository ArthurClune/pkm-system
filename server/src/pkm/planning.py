# pattern: Functional Core
"""Plan a write as /api/ops ops. Pure: a page's blocks and a uid iterator
come in, `pkm.contracts.ops` models come out. The shell fetches pages,
generates uids, and posts the result.

Transport-neutral on purpose: `pkm` (CLI), `pkm-mcp` and the shared write
workflows in `pkm.client.workflows` all plan through here, so this module
imports none of them. `pkm.batch` builds on it for the multi-command
`batch` language.

Both ends are contract models rather than dicts: the blocks
planned against are `BlockNode`s exactly as the server serialized them,
and each planned op is validated the moment it is built, so a planner
that emits a wrong-shaped op fails here rather than as a 422 from the
server after the page was already fetched."""
from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Sequence
from typing import cast

from pkm.contracts.ops import (BlockOp, CreateOp, CreatePageOp, HeadingLevel,
                               OrderIdx, SetHeadingOp, UpdateTextOp, text_hash)
from pkm.contracts.responses import BlockNode, walk_blocks
from pkm.todo import TaskMark, with_state

_HEADING_SPEC = re.compile(r"^(#{1,3}) (.+)$")
_UID_SPEC = re.compile(r"^\(\((.+)\)\)$")


class BuildError(ValueError):
    pass


def parse_outline(text: str) -> list[tuple[int, str]]:
    """Split `text` into (depth, text) per non-blank line. Depth is leading
    indent / 2 spaces (each tab counts as one level). A line may not jump
    more than one level deeper than the previous line (clamped)."""
    items: list[tuple[int, str]] = []
    for raw in text.splitlines():
        if not raw.strip():
            continue
        stripped = raw.lstrip(" \t")
        indent = raw[:len(raw) - len(stripped)]
        depth = indent.count("\t") + (len(indent.replace("\t", "")) // 2)
        prev = items[-1][0] if items else -1
        items.append((min(depth, prev + 1), stripped))
    return items


def next_child_order_idx(blocks: Sequence[BlockNode],
                         parent_uid: str | None) -> OrderIdx:
    """Append `order_idx` under `parent_uid` in a page's `blocks` tree: one
    past the last sibling's `order_idx`, or 0 with none -- never a sibling
    COUNT. `order_idx` is sparse (a delete leaves a gap; nothing
    renumbers), so counting siblings can land inside existing gaps instead
    of after every one of them, and the server's `ShiftSiblings` only
    moves siblings at/after the new key into place. `None` means top level
    of the page.

    A standalone snapshot of one page as fetched -- `Planner` keeps its
    own running sibling model instead (it has to, to compose several
    batch commands in sequence), but this is the simpler building block
    `plan_save`'s single-page, single-call use doesn't need that for."""
    def _after(siblings: Sequence[BlockNode]) -> OrderIdx:
        last = max((n.order_idx for n in siblings), default=None)
        return OrderIdx(0) if last is None else OrderIdx(last + 1)
    if parent_uid is None:
        return _after(blocks)
    for n in walk_blocks(blocks):
        if n.uid == parent_uid:
            return _after(n.children)
    raise BuildError(f"parent block not on page: {parent_uid}")


def order_idx_at_position(siblings: Sequence[tuple[str, OrderIdx]],
                          position: int) -> OrderIdx:
    """The order key of 0-based `position` among `siblings` (uid,
    order_idx pairs, already sorted ascending by order_idx) -- the ONE
    place a user-supplied position becomes a minted `OrderIdx`. A
    `position` at or past the end means append: one past the last
    sibling's key, or 0 with none. Never a sibling COUNT -- see
    `next_child_order_idx` for why that would land in a gap instead of
    after every real key."""
    if position < len(siblings):
        return siblings[position][1]
    last = siblings[-1][1] if siblings else None
    return OrderIdx(0) if last is None else OrderIdx(last + 1)


def parse_uid_spec(spec: str | None) -> str | None:
    """The uid inside a `((uid))` parent spec, or None for anything else
    (no spec, a "## Heading", a malformed one). Callers that can see uids
    `resolve_parent` cannot -- blocks created earlier in the same batch --
    use this to recognize such a spec before resolving it against a page."""
    m = _UID_SPEC.match(spec) if spec else None
    return m.group(1) if m else None


def find_block(blocks: Sequence[BlockNode], uid: str) -> BlockNode | None:
    """The node with `uid` somewhere in `blocks`' tree, or None if `uid`
    isn't on this page. A `BlockNode` already nests its own children, so
    the node returned IS its full subtree -- there is no separate cutting
    step."""
    for n in walk_blocks(blocks):
        if n.uid == uid:
            return n
    return None


def resolve_parent(
    blocks: Sequence[BlockNode], spec: str | None
) -> tuple[str | None, tuple[HeadingLevel, str] | None]:
    """Resolve a parent spec against a fetched page's blocks.

    Returns (parent_uid, heading_to_create). `heading_to_create` is
    (level, text) when `spec` names a "## Heading" that doesn't yet exist
    on the page -- the caller must create it at page top level first, then
    nest under it.

    A "## Heading" spec matches only a block whose `heading` attribute
    equals the requested level *and* whose text matches -- a plain block
    (heading is `None`) with the same text, or a heading at a different
    level, is not a match; the spec is treated as missing and the caller
    creates it. When more than one block matches (level and text both),
    the first in document order wins, same rule `Planner._headings`
    applies via `setdefault` for headings created earlier in the same
    batch -- so a page fetched before vs. after that heading exists
    resolves the same parent either way.
    """
    if spec is None:
        return None, None
    uid = parse_uid_spec(spec)
    if uid is not None:
        if not any(n.uid == uid for n in walk_blocks(blocks)):
            raise BuildError(f"block not on page: {uid}")
        return uid, None
    m = _HEADING_SPEC.match(spec)
    if m:
        level, text = cast(HeadingLevel, len(m.group(1))), m.group(2)
        for n in walk_blocks(blocks):
            if n.heading == level and n.text == text:
                return n.uid, None
        return None, (level, text)
    raise BuildError(
        f"unrecognized parent spec: {spec!r} "
        '(use "((uid))" or "## Heading")'
    )


def split_heading(text: str) -> tuple[str, HeadingLevel | None]:
    """Split a leading markdown heading marker off `text`, returning
    (body, level): '## Overview' -> ('Overview', 2).

    Text that doesn't match comes back unchanged with None: '#Tag' (no
    space after the hashes, so tag-only blocks survive), '#### x' (blocks
    carry levels 1-3 only), '# ' (no body), and any multi-line text --
    _HEADING_SPEC is neither MULTILINE nor DOTALL, so `$` cannot match
    mid-string and a pasted markdown document stays verbatim in its
    block. Same syntax as a `parent:` spec, same regex.
    """
    m = _HEADING_SPEC.match(text)
    return (m.group(2), cast(HeadingLevel, len(m.group(1)))) if m \
        else (text, None)


def _create(uid: str, page: str, parent: str | None, idx: OrderIdx, text: str,
            heading: HeadingLevel | None = None) -> CreateOp:
    return CreateOp(op="create", uid=uid, page_title=page, parent_uid=parent,
                    order_idx=idx, text=text, heading=heading)


SiblingKey = tuple[str, str | None]  # (page, parent uid or None for top level)


class Planner:
    """The state a run of create/move/delete planning threads through its
    ops: a per-(page, parent) model of the live sibling list (uid,
    order_idx pairs, ascending), a uid -> its current (page, parent) for
    finding a moved/deleted block's own list, and the uid of every
    '## Heading' the run has created. All three exist so that several
    batch commands compose: a position counts against the page AS THE
    BATCH HAS LEFT IT SO FAR, so consecutive creates/moves/deletes have to
    see each other's effects, and a heading spec repeated across commands
    reuses the heading already planned instead of duplicating it.

    The sibling model mirrors the server's own arithmetic exactly (see
    `ops_core.plan_op`/`ops_apply._execute`'s `ShiftSiblings`): a create or
    move landing at order key K shifts every sibling at/after K up by one
    before the block lands at K; a move additionally removes the block
    from wherever it was first. `order_idx_at_position` is the only place
    a user-supplied position becomes that key.

    A page is seeded into the model -- its whole tree, every parent's
    children at once -- the first time any group on it is touched;
    `plan_batch` seeds every fetched page up front so that a `delete` or
    `move`, which may carry no `blocks` of their own to seed from, still
    see a page some other command in the batch already touched. A uid the
    model never saw (an unfetched page, or a batch command whose page was
    never referenced elsewhere) is simply absent from `_location`: a move
    of it still lands, a delete of it is just not tracked -- see
    `_remove`.

    Known limit: this model does not simulate the server skipping a move
    under the block's own descendant (a cycle) -- it applies the shift and
    the relocation as asked. That skip is rare and only ever changes what
    the move ops *contain*, never silently corrupts a position elsewhere,
    so it's left unmodeled.

    Every method takes an already-resolved parent uid. Turning a parent
    *spec* into one -- aliases, in-batch uids, a page that was never
    fetched -- is the caller's job (see `_BatchCtx.resolve_parent`); this
    class only positions blocks."""

    def __init__(self, uids: Iterator[str]):
        self._uids = uids
        self._siblings: dict[SiblingKey, list[tuple[str, OrderIdx]]] = {}
        self._location: dict[str, SiblingKey] = {}
        self._seeded_pages: set[str] = set()
        self._headings: dict[tuple[str, HeadingLevel, str], str] = {}

    def next_uid(self) -> str:
        return next(self._uids)

    # -- sibling model ----------------------------------------------------

    def seed_page(self, page: str, blocks: Sequence[BlockNode]) -> None:
        """Seed every (page, parent) sibling group on `page` from its
        fetched `blocks`, once. Idempotent, so every caller that might be
        first to touch a page -- a batch command's own planner, or
        `plan_batch`'s up-front pass over every fetched page -- can call it
        freely."""
        if page in self._seeded_pages:
            return
        self._seeded_pages.add(page)
        self._seed_level(page, None, blocks)

    def _seed_level(self, page: str, parent: str | None,
                    nodes: Sequence[BlockNode]) -> None:
        self._siblings[(page, parent)] = [(n.uid, n.order_idx) for n in nodes]
        for n in nodes:
            self._location[n.uid] = (page, parent)
            self._seed_level(page, n.uid, n.children)

    def _group(self, blocks: Sequence[BlockNode], page: str,
              parent: str | None,
              parent_off_page: bool) -> list[tuple[str, OrderIdx]]:
        """The live (uid, order_idx) list for (page, parent), seeding
        `page` from `blocks` first unless `parent` was created earlier in
        this run (off-page: not among `blocks`, so it has no fetched
        children to seed from -- it starts empty, same as a fresh heading).
        Raises like `next_child_order_idx` did if a real `parent` turns out
        not to be on the page at all."""
        key = (page, parent)
        if parent_off_page:
            return self._siblings.setdefault(key, [])
        self.seed_page(page, blocks)
        if key not in self._siblings:
            raise BuildError(f"parent block not on page: {parent}")
        return self._siblings[key]

    def _land(self, key: SiblingKey, uid: str, idx: OrderIdx) -> None:
        """`ShiftSiblings` then insert: every sibling already in `key`'s
        group at/after `idx` moves up by one, then `uid` lands at `idx`.
        `uid` may already be one of those siblings (a same-parent move) --
        shifting it is harmless since the caller removes it before this
        runs."""
        siblings = self._siblings[key]
        for i, (u, k) in enumerate(siblings):
            if k >= idx:
                siblings[i] = (u, OrderIdx(k + 1))
        siblings.append((uid, idx))
        siblings.sort(key=lambda pair: pair[1])
        self._location[uid] = key

    def _remove(self, uid: str) -> None:
        """Drop `uid` from wherever the model last saw it -- a no-op if the
        model never did (its page was never fetched, or was fetched but
        this uid wasn't on it)."""
        loc = self._location.pop(uid, None)
        if loc is not None:
            self._siblings[loc] = [p for p in self._siblings[loc]
                                   if p[0] != uid]

    def heading(self, blocks: Sequence[BlockNode], page: str,
               level: HeadingLevel, text: str) -> tuple[str, list[CreateOp]]:
        """The uid of a page-top-level heading with `level` and `text`, plus
        the op creating it -- or no ops, if this run planned it already.
        Memoized per (page, level, text) so a "## Heading" parent spec
        repeated across separate calls (i.e. separate batch commands) nests
        under the one heading instead of minting a second."""
        key = (page, level, text)
        planned = self._headings.get(key)
        if planned is not None:
            return planned, []
        uid = self.next_uid()
        self._headings[key] = uid
        siblings = self._group(blocks, page, None, False)
        idx = order_idx_at_position(siblings, len(siblings))
        self._land((page, None), uid, idx)
        return uid, [_create(uid, page, None, idx, text, level)]

    def _one(self, uid: str, page: str, parent: str | None, idx: OrderIdx,
            text: str, todo: bool) -> CreateOp:
        """One create op at a decided (uid, position): heading marker split
        off the text, task marker applied when asked.

        A heading this creates registers in the memo, so a later
        `parent: "## Notes"` in the same batch nests under this block
        instead of creating a second heading -- `resolve_parent` can't find
        it, since it walks only the fetched page's blocks, which predate
        this batch. Keyed on the stored text (TODO prefix included, if any)
        so the memo agrees with what a later fetch would match."""
        body, level = split_heading(text)
        if todo:
            body = with_state(body, "TODO")
        if level is not None:
            self._headings.setdefault((page, level, body), uid)
        return _create(uid, page, parent, idx, body, level)

    def creates(self, blocks: Sequence[BlockNode], page: str,
                parent: str | None, items: list[tuple[int, str]], todo: bool,
                parent_off_page: bool = False) -> list[CreateOp]:
        """Plan appended creates for `items` (depth, text) pairs under the
        resolved `parent` uid (`None` = page top level), maintaining a
        depth->uid stack so a nested item attaches to the most recently
        created ancestor at the right depth. `todo` marks depth-0 items
        only.

        `parent_off_page` is the off-page flag for `parent` itself. Every
        block this call creates is off-page too, so nesting under one
        starts empty; the `created` set below is what tracks them."""
        ops: list[CreateOp] = []
        created: set[str] = set()
        stack: list[str | None] = [parent]
        for depth, text in items:
            del stack[depth + 1:]
            target = stack[depth]
            off_page = target in created \
                or (target == parent and parent_off_page)
            uid = self.next_uid()
            siblings = self._group(blocks, page, target, off_page)
            idx = order_idx_at_position(siblings, len(siblings))
            self._land((page, target), uid, idx)
            op = self._one(uid, page, target, idx, text, todo and depth == 0)
            ops.append(op)
            created.add(op.uid)
            if len(stack) == depth + 1:
                stack.append(op.uid)
            else:
                stack[depth + 1] = op.uid
        return ops

    def create_at(self, blocks: Sequence[BlockNode], page: str,
                  parent: str | None, position: int, text: str, todo: bool,
                  parent_off_page: bool = False) -> CreateOp:
        """One create landing at `position`: 0-based among (page, parent)'s
        current children AS THE BATCH HAS LEFT THEM SO FAR -- past the end
        means append, same as a plain create. Only single-item
        `create`/`todo` batch commands ask for an explicit position;
        `outline` and `plan_save` always append."""
        uid = self.next_uid()
        siblings = self._group(blocks, page, parent, parent_off_page)
        idx = order_idx_at_position(siblings, position)
        self._land((page, parent), uid, idx)
        return self._one(uid, page, parent, idx, text, todo)

    def move(self, blocks: Sequence[BlockNode], page: str,
            parent: str | None, uid: str, position: int | None,
            parent_off_page: bool = False) -> OrderIdx:
        """Mint the order key for moving `uid` to (page, parent), landing
        at `position` -- 0-based among the destination's children WITHOUT
        `uid` itself, past the end or `None` meaning append -- and advance
        the model: remove `uid` from wherever it currently sits (a same-
        parent move's own old entry does not count towards `position`
        either way), then land it at the minted key, shifting the
        destination's remaining siblings same as a create. Mirrors the
        server's `ShiftSiblings` then `SetParent`, in that order -- a
        same-parent move's `ShiftSiblings` also touches `uid`'s own
        pre-move row, but that row is about to be overwritten by
        `SetParent` regardless, so the model never has to represent it."""
        siblings = self._group(blocks, page, parent, parent_off_page)
        excl = [p for p in siblings if p[0] != uid]
        idx = order_idx_at_position(
            excl, len(excl) if position is None else position)
        self._remove(uid)
        self._land((page, parent), uid, idx)
        return idx

    def delete(self, uid: str) -> None:
        """Remove `uid` from the sibling model, wherever it currently sits
        -- a no-op if the model never saw it."""
        self._remove(uid)


def plan_save(blocks: Sequence[BlockNode], page_title: str,
              parent_spec: str | None, text: str, todo: bool,
              uids: Iterator[str]) -> list[CreateOp]:
    """Plan the create ops for `pkm save`: an outline of `text` nested
    under `parent_spec` (page top level if None). A "## Heading" spec not
    yet on the page is created first, at page top level, so the whole save
    is one atomic batch either way."""
    items = parse_outline(text)
    if not items:
        raise BuildError("nothing to save: text is empty")
    planner = Planner(uids)
    parent, missing = resolve_parent(blocks, parent_spec)
    head: list[CreateOp] = []
    if missing is not None:
        parent, head = planner.heading(blocks, page_title, *missing)
    return [*head, *planner.creates(blocks, page_title, parent, items, todo,
                                    parent_off_page=missing is not None)]


class _NotGiven:
    """Sentinel for `plan_update`'s `current_heading` default: `pkm
    batch`'s `update` command has no fetched block to compare against, so
    it never passes one. Distinguishes that from a real, meaningful
    `current_heading=None` (the block is currently plain text)."""


_NOT_GIVEN = _NotGiven()


def plan_update(uid: str, text: str, base_text: str | None = None,
                current_heading: HeadingLevel | None | _NotGiven = _NOT_GIVEN,
                page_title: str | None = None
                ) -> list[BlockOp]:
    """Ops for replacing a block's text: `update_text` plus, when the
    heading level is actually changing, the `set_heading` that keeps the
    stored level in step with the text's leading hashes -- no hashes
    means plain text, so a heading is cleared.

    `current_heading` is the block's level before this update, as read by
    the caller (`client.get_block(uid).block.heading`). When it
    equals the new level, `set_heading` is skipped and only `update_text`
    is emitted. An `update_text` on a block deleted out from under it is
    *rescued* by the server -- the edit is preserved under a
    `[[conflict]]` header on today's daily page (ops_core.py) -- and a
    trailing `set_heading` for the same missing uid adds a "heading change
    skipped" note under that header, so omitting the redundant op keeps
    that note from appearing when the level didn't change. `pkm batch`'s
    `update` command leaves `current_heading` at its `_NOT_GIVEN` default
    and so always emits `set_heading` -- it has no fetched block to
    compare against.

    `base_text`, when given, adds the `base_text_hash` concurrent-edit
    guard (the standalone `pkm update` / `update_block` path). `pkm batch`'s
    `update` command passes None: batch updates carry no guard by design.

    `page_title`, when given, rides on `update_text` as the conflict-label
    hint the server falls back to if this uid is gone by the time the op
    lands (`UpdateTextOp.page_title`). It only labels a rescue header; it
    never changes where or whether the edit applies.

    Callers must NOT route a task-marker change (`-D`/`-T`/`mark=`)
    through here: the text those read back from the API is already bare,
    so it would split to no hashes and demote a real heading.
    """
    body, level = split_heading(text)
    ops: list[BlockOp] = [UpdateTextOp(
        op="update_text", uid=uid, text=body,
        base_text_hash=None if base_text is None else text_hash(base_text),
        page_title=page_title)]
    if isinstance(current_heading, _NotGiven) or current_heading != level:
        ops.append(SetHeadingOp(op="set_heading", uid=uid, heading=level))
    return ops


def plan_mark(uid: str, current_text: str, mark: TaskMark,
             page_title: str | None = None) -> list[UpdateTextOp]:
    """Ops for a task-marker change (`pkm update -D`/`-T`, `update_block
    mark=`): `update_text` with the marker applied to `current_text`, plus
    the `base_text_hash` concurrent-edit guard. Deliberately never
    `plan_update` and never emits `set_heading`: `current_text` is read
    back from the API already bare (the heading level lives in its own
    column), so splitting it would find no hashes and demote a real
    heading to plain text.

    `page_title`, when given, is the same conflict-label hint
    `plan_update` attaches -- see its docstring."""
    return [UpdateTextOp(op="update_text", uid=uid,
                        text=with_state(current_text, mark),
                        base_text_hash=text_hash(current_text),
                        page_title=page_title)]


def asset_block_text(filename: str, mime: str, url: str) -> str:
    """Render an uploaded asset as a block: image embed, `pdf` macro, or a
    plain link, keyed off the asset's mime type. Pure text shaping shared
    by the CLI (`pkm upload`) and the MCP server's upload tool."""
    if mime.startswith("image/"):
        return f"![{filename}]({url})"
    if mime == "application/pdf":
        return f"{{{{[[pdf]]: {url}}}}}"
    return f"[{filename}]({url})"


def create_page_ops(titles: Iterable[str]) -> list[CreatePageOp]:
    """`create_page` ops for pages that don't exist yet, meant to be
    prepended to a planned batch's ops so a missing page's creation rides
    inside the same atomic OpBatch as the blocks that reference it --
    a batch that fails validation after this point leaves
    neither the page nor its blocks behind, instead of the page having
    already been committed via a separate request."""
    return [CreatePageOp(op="create_page", page_title=t) for t in titles]


__all__ = [
    "BuildError", "Planner", "parse_outline", "next_child_order_idx",
    "order_idx_at_position", "resolve_parent", "parse_uid_spec",
    "split_heading", "plan_save", "plan_update", "plan_mark",
    "asset_block_text", "create_page_ops",
]
