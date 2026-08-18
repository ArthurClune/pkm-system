# pattern: Functional Core
"""Plan a write as /api/ops ops. Pure: a page's blocks and a uid iterator
come in, `pkm.contracts.ops` models come out. The shell fetches pages,
generates uids, and posts the result.

Transport-neutral on purpose: `pkm` (CLI), `pkm-mcp` and the shared write
workflows in `pkm.client.workflows` all plan through here, so this module
imports none of them. `pkm.batch` builds on it for the multi-command
`batch` language.

Both ends are contract models rather than dicts (pkm-0wr8): the blocks
planned against are `BlockNode`s exactly as the server serialized them,
and each planned op is validated the moment it is built, so a planner
that emits a wrong-shaped op fails here rather than as a 422 from the
server after the page was already fetched."""
from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Sequence

from pkm.contracts.ops import (BlockOp, CreateOp, CreatePageOp, SetHeadingOp,
                               UpdateTextOp, text_hash)
from pkm.contracts.responses import BlockNode, walk_blocks
from pkm.todo import with_state

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


def next_child_idx(blocks: Sequence[BlockNode],
                   parent_uid: str | None) -> int:
    """Append position under `parent_uid` in a page's `blocks` tree;
    `None` means top level of the page."""
    if parent_uid is None:
        return len(blocks)
    for n in walk_blocks(blocks):
        if n.uid == parent_uid:
            return len(n.children)
    raise BuildError(f"parent block not on page: {parent_uid}")


def parse_uid_spec(spec: str | None) -> str | None:
    """The uid inside a `((uid))` parent spec, or None for anything else
    (no spec, a "## Heading", a malformed one). Callers that can see uids
    `resolve_parent` cannot -- blocks created earlier in the same batch --
    use this to recognize such a spec before resolving it against a page."""
    m = _UID_SPEC.match(spec) if spec else None
    return m.group(1) if m else None


def resolve_parent(
    blocks: Sequence[BlockNode], spec: str | None
) -> tuple[str | None, tuple[int, str] | None]:
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
        level, text = len(m.group(1)), m.group(2)
        for n in walk_blocks(blocks):
            if n.heading == level and n.text == text:
                return n.uid, None
        return None, (level, text)
    raise BuildError(
        f"unrecognized parent spec: {spec!r} "
        '(use "((uid))" or "## Heading")'
    )


def split_heading(text: str) -> tuple[str, int | None]:
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
    return (m.group(2), len(m.group(1))) if m else (text, None)


def _create(uid: str, page: str, parent: str | None, idx: int, text: str,
            heading: int | None = None) -> CreateOp:
    return CreateOp(op="create", uid=uid, page_title=page, parent_uid=parent,
                    order_idx=idx, text=text, heading=heading)


class Planner:
    """The state a run of create planning threads through its ops: the next
    append order_idx per (page, parent), and the uid of every '## Heading'
    the run has created. Both exist so that several `creates`/`create_at`
    calls -- i.e. several batch commands -- compose: consecutive creates
    land in consecutive positions, and a heading spec repeated across
    commands reuses the heading already planned instead of duplicating it.

    Every method takes an already-resolved parent uid. Turning a parent
    *spec* into one -- aliases, in-batch uids, a page that was never
    fetched -- is the caller's job (see `_BatchCtx.resolve_parent`); this
    class only positions blocks."""

    def __init__(self, uids: Iterator[str]):
        self._uids = uids
        self._next_idx: dict[tuple[str, str | None], int] = {}
        self._headings: dict[tuple[str, int, str], str] = {}

    def next_uid(self) -> str:
        return next(self._uids)

    def bump(self, blocks: Sequence[BlockNode], page: str,
             parent: str | None, parent_off_page: bool = False) -> int:
        """The next append order_idx under (page, parent), counting up from
        the parent's current child count.

        `parent_off_page` says `parent` was created earlier in this run of
        planning rather than fetched: it is not among `blocks`, so its
        first child starts at 0 instead of consulting `next_child_idx`,
        which would raise. Only a real uid can be off-page -- page top
        level (`parent=None`) is always countable from `blocks`."""
        key = (page, parent)
        if key not in self._next_idx:
            self._next_idx[key] = 0 if parent_off_page \
                else next_child_idx(blocks, parent)
        idx = self._next_idx[key]
        self._next_idx[key] = idx + 1
        return idx

    def heading(self, blocks: Sequence[BlockNode], page: str, level: int,
                text: str) -> tuple[str, list[CreateOp]]:
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
        return uid, [_create(uid, page, None, self.bump(blocks, page, None),
                             text, level)]

    def _one(self, page: str, parent: str | None, idx: int, text: str,
             todo: bool) -> CreateOp:
        """One create op at a decided position: heading marker split off the
        text, task marker applied when asked.

        A heading this creates registers in the memo, so a later
        `parent: "## Notes"` in the same batch nests under this block
        instead of creating a second heading -- `resolve_parent` can't find
        it, since it walks only the fetched page's blocks, which predate
        this batch. Keyed on the stored text (TODO prefix included, if any)
        so the memo agrees with what a later fetch would match."""
        body, level = split_heading(text)
        if todo:
            body = with_state(body, "TODO")
        uid = self.next_uid()
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

        `parent_off_page` is `bump`'s flag for `parent`. Every block this
        call creates is off-page too, so nesting under one starts at 0; the
        `created` set below is what tracks them."""
        ops: list[CreateOp] = []
        created: set[str] = set()
        stack: list[str | None] = [parent]
        for depth, text in items:
            del stack[depth + 1:]
            target = stack[depth]
            off_page = target in created \
                or (target == parent and parent_off_page)
            op = self._one(page, target,
                           self.bump(blocks, page, target, off_page),
                           text, todo and depth == 0)
            ops.append(op)
            created.add(op.uid)
            if len(stack) == depth + 1:
                stack.append(op.uid)
            else:
                stack[depth + 1] = op.uid
        return ops

    def create_at(self, page: str, parent: str | None, index: int, text: str,
                  todo: bool) -> CreateOp:
        """One create whose `order_idx` is `index` verbatim -- the server
        splices siblings at/after it on insert. Only single-item
        `create`/`todo` batch commands ask for this; `outline` and
        `plan_save` always append.

        Deliberately leaves the append counter alone: mixing an indexed
        create with plain appends under the same parent in one batch may
        interleave, since the appends keep counting from the page's
        original child count rather than accounting for the index. See
        `pkm batch --help`."""
        return self._one(page, parent, index, text, todo)


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
                current_heading: int | None | _NotGiven = _NOT_GIVEN
                ) -> list[BlockOp]:
    """Ops for replacing a block's text: `update_text` plus, when the
    heading level is actually changing, the `set_heading` that keeps the
    stored level in step with the text's leading hashes -- no hashes
    means plain text, so a heading is cleared.

    `current_heading` is the block's level before this update, as read by
    the caller (`client.get_block(uid).block.heading`). When it
    equals the new level, `set_heading` is skipped and only `update_text`
    is emitted. This is not just an optimization: a guarded `update_text`
    on a block deleted out from under it is deliberately *rescued* by the
    server -- the edit is preserved as a `[[conflict]]` sibling on today's
    daily page (ops_core.py) -- but a trailing `set_heading` for the same
    now-missing uid is not, since the block it targets no longer exists;
    that turns the rescue into a rolled-back 400. Since the level is
    unchanged for most updates, omitting the redundant op keeps that race
    survivable. `pkm batch`'s `update` command leaves `current_heading` at
    its `_NOT_GIVEN` default and so always emits `set_heading`, as
    before -- it has no fetched block to compare against, and batch
    updates carry no hash guard anyway, so there is no rescue to protect.

    `base_text`, when given, adds the `base_text_hash` concurrent-edit
    guard (the standalone `pkm update` / `update_block` path). `pkm batch`'s
    `update` command passes None: batch updates carry no guard by design.

    Callers must NOT route a task-marker change (`-D`/`-T`/`mark=`)
    through here: the text those read back from the API is already bare,
    so it would split to no hashes and demote a real heading.
    """
    body, level = split_heading(text)
    ops: list[BlockOp] = [UpdateTextOp(
        op="update_text", uid=uid, text=body,
        base_text_hash=None if base_text is None else text_hash(base_text))]
    if isinstance(current_heading, _NotGiven) or current_heading != level:
        ops.append(SetHeadingOp(op="set_heading", uid=uid, heading=level))
    return ops


def plan_mark(uid: str, current_text: str, mark: str) -> list[UpdateTextOp]:
    """Ops for a task-marker change (`pkm update -D`/`-T`, `update_block
    mark=`): `update_text` with the marker applied to `current_text`, plus
    the `base_text_hash` concurrent-edit guard. Deliberately never
    `plan_update` and never emits `set_heading`: `current_text` is read
    back from the API already bare (the heading level lives in its own
    column), so splitting it would find no hashes and demote a real
    heading to plain text."""
    return [UpdateTextOp(op="update_text", uid=uid,
                        text=with_state(current_text, mark),
                        base_text_hash=text_hash(current_text))]


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
    inside the same atomic OpBatch as the blocks that reference it
    (pkm-w80k) -- a batch that fails validation after this point leaves
    neither the page nor its blocks behind, instead of the page having
    already been committed via a separate request."""
    return [CreatePageOp(op="create_page", page_title=t) for t in titles]


__all__ = [
    "BuildError", "Planner", "parse_outline", "next_child_idx",
    "resolve_parent", "parse_uid_spec", "split_heading", "plan_save",
    "plan_update", "plan_mark", "asset_block_text", "create_page_ops",
]
