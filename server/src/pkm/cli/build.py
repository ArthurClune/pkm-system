# pattern: Functional Core
"""Plan CLI/MCP writes as /api/ops ops. Pure: a page's blocks and a uid
iterator come in, `pkm.contracts.ops` models come out. The shell fetches
pages, generates uids, and posts the result.

Both ends are contract models rather than dicts (pkm-0wr8): the blocks
planned against are `BlockNode`s exactly as the server serialized them,
and each planned op is validated the moment it is built, so a planner
that emits a wrong-shaped op fails here rather than as a 422 from the
server after the page was already fetched."""
from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Annotated, Literal, Union

from pydantic import (BaseModel, ConfigDict, Field, TypeAdapter,
                      ValidationError, model_validator)

from pkm.contracts.ops import (BlockOp, CreateOp, CreatePageOp, DeleteOp,
                               MoveOp, SetHeadingOp, UpdateTextOp, text_hash)
from pkm.contracts.responses import BlockNode
from pkm.todo import with_state

_HEADING_SPEC = re.compile(r"^(#{1,3}) (.+)$")
_UID_SPEC = re.compile(r"^\(\((.+)\)\)$")
_ALIAS_SPEC = re.compile(r"^\{\{(.+)\}\}$")


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


def _walk(nodes: Sequence[BlockNode]) -> Iterator[BlockNode]:
    for n in nodes:
        yield n
        yield from _walk(n.children)


def next_child_idx(blocks: Sequence[BlockNode],
                   parent_uid: str | None) -> int:
    """Append position under `parent_uid` in a page's `blocks` tree;
    `None` means top level of the page."""
    if parent_uid is None:
        return len(blocks)
    for n in _walk(blocks):
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
    the first in document order wins, same rule `_Planner._headings`
    applies via `setdefault` for headings created earlier in the same
    batch -- so a page fetched before vs. after that heading exists
    resolves the same parent either way.
    """
    if spec is None:
        return None, None
    uid = parse_uid_spec(spec)
    if uid is not None:
        if not any(n.uid == uid for n in _walk(blocks)):
            raise BuildError(f"block not on page: {uid}")
        return uid, None
    m = _HEADING_SPEC.match(spec)
    if m:
        level, text = len(m.group(1)), m.group(2)
        for n in _walk(blocks):
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


class _Planner:
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
    planner = _Planner(uids)
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





def _nested_items(items: list, depth: int = 0) -> list[tuple[int, str]]:
    """Flatten a validated `outline` item list (`NestedItem`: a leaf string,
    or a list one level deeper) into (depth, text) pairs, depth-first. Shape
    is guaranteed by `OutlineParams.items` before this ever runs, so unlike
    the pre-schema version this never rejects a malformed item itself."""
    out: list[tuple[int, str]] = []
    for item in items:
        if isinstance(item, str):
            out.append((depth, item))
        else:
            out.extend(_nested_items(item, depth + 1))
    return out


def _resolve_alias(spec: str | None, aliases: dict[str, str]) -> str | None:
    if isinstance(spec, str):
        m = _ALIAS_SPEC.match(spec)
        if m:
            alias = m.group(1)
            if alias not in aliases:
                raise BuildError(f"unknown alias: {alias}")
            return f"(({aliases[alias]}))"
    return spec


def _alias_uid(value: str, aliases: dict[str, str]) -> str:
    m = _ALIAS_SPEC.match(value)
    if m:
        if m.group(1) not in aliases:
            raise BuildError(f"unknown alias: {m.group(1)}")
        return aliases[m.group(1)]
    return value


def _in_batch_uid(spec: str | None, created: set[str]) -> str | None:
    """The uid of a `((uid))` spec naming a block created earlier in this
    batch, else None. Those uids are on none of the fetched pages, so
    `resolve_parent` would reject the spec and `next_child_idx` could not
    count the block's children -- both consult the fetched blocks, which
    predate the batch."""
    uid = parse_uid_spec(spec)
    return uid if uid is not None and uid in created else None


# -- Batch command schema -----------------------------------------------
#
# One discriminated model per `command` value, all rejecting unknown keys
# so a typo'd param is a validation error rather than a silent no-op. This
# is the FULL structural contract for a batch item: object shape, field
# presence/types, index range. What it deliberately does NOT check --
# whether a `page` was fetched, whether an `{{alias}}` was defined earlier
# in the batch, whether a "## Heading" move target exists -- is inherently
# stateful (depends on fetched pages / on-batch ordering) and stays in
# each command's planner below, raising the same `BuildError` it always
# has.

# Recursive alias for `outline`'s nested item lists: a leaf string, or a
# list of items one level deeper, e.g. ["Groceries", ["Milk", "Eggs"]].
type NestedItem = str | list[NestedItem]


class _Strict(BaseModel):
    """Base for every command/params model: unknown keys are a validation
    error, not a silent no-op."""
    model_config = ConfigDict(extra="forbid")


class CreateParams(_Strict):
    """Shared by `create` and `todo` -- identical shape, `todo` only
    changes how the planner stores the text."""
    page: str = Field(min_length=1)
    text: str
    parent: str | None = None
    index: int | None = Field(default=None, ge=0)
    as_: str | None = Field(default=None, alias="as")


class OutlineParams(_Strict):
    page: str = Field(min_length=1)
    parent: str | None = None
    items: list[NestedItem] = Field(min_length=1)

    @model_validator(mode="after")
    def _require_a_leaf_item(self) -> OutlineParams:
        # `Field(min_length=1)` only bounds the top-level list -- items=[[]]
        # (or any all-empty nesting) satisfies it but flattens to zero leaf
        # strings via `_nested_items`, which would otherwise plan zero ops
        # for what looks like a non-empty outline command.
        if not _nested_items(self.items):
            raise ValueError("items: must contain at least one item")
        return self


class UpdateParams(_Strict):
    uid: str = Field(min_length=1)
    text: str


class MoveParams(_Strict):
    uid: str = Field(min_length=1)
    page: str = Field(min_length=1)
    parent: str | None = None
    index: int | None = Field(default=None, ge=0)


class DeleteParams(_Strict):
    uid: str = Field(min_length=1)


class CreateCommand(_Strict):
    command: Literal["create"]
    params: CreateParams


class TodoCommand(_Strict):
    command: Literal["todo"]
    params: CreateParams


class OutlineCommand(_Strict):
    command: Literal["outline"]
    params: OutlineParams


class UpdateCommand(_Strict):
    command: Literal["update"]
    params: UpdateParams


class MoveCommand(_Strict):
    command: Literal["move"]
    params: MoveParams


class DeleteCommand(_Strict):
    command: Literal["delete"]
    params: DeleteParams


BatchCommand = Annotated[
    Union[CreateCommand, TodoCommand, OutlineCommand, UpdateCommand,
         MoveCommand, DeleteCommand],
    Field(discriminator="command")]

_BATCH_COMMAND_ADAPTER: TypeAdapter[BatchCommand] = TypeAdapter(BatchCommand)


def _format_command_error(index: int, exc: ValidationError) -> str:
    """Render the first of `exc`'s errors as one `batch[i]: problem` line
    -- a malformed batch fails with a clear per-item error naming the
    index and problem, not a pydantic error dump. The three discriminator-
    level error kinds (`model_attributes_type` for a non-object item,
    `union_tag_not_found`/`union_tag_invalid` for a missing/unrecognized
    `command`) have no useful `loc`, so they get bespoke messages; anything
    else is a `params`-shape problem, reported as its field path (with the
    discriminator's matched tag dropped from `loc` -- it's redundant with
    the message) plus pydantic's own `msg`."""
    first = exc.errors()[0]
    kind = first["type"]
    if kind == "model_attributes_type":
        return f"batch[{index}]: expected an object"
    if kind == "union_tag_not_found":
        return f"batch[{index}]: missing 'command'"
    if kind == "union_tag_invalid":
        return f"batch[{index}]: unknown command: {first['ctx']['tag']!r}"
    path = ".".join(str(p) for p in first["loc"][1:])
    return f"batch[{index}]: {path}: {first['msg']}" if path \
        else f"batch[{index}]: {first['msg']}"


def _parse_command(raw: object, index: int) -> BatchCommand:
    try:
        return _BATCH_COMMAND_ADAPTER.validate_python(raw)
    except ValidationError as exc:
        raise BuildError(_format_command_error(index, exc)) from None


def validate_batch(commands: object) -> list[BatchCommand]:
    """Validate a full batch envelope against the command schema before any
    page discovery or I/O -- the CLI/MCP shells call this first, right
    after decoding the request body, so a malformed batch never triggers a
    page fetch or asset upload. `plan_batch` runs the same per-item parse
    as its own first step (see `_parse_command`), so a batch fails with an
    identical message whether caught here or by calling `plan_batch`
    directly -- one stable error contract regardless of which caller
    validates first."""
    if not isinstance(commands, list):
        raise BuildError("batch input must be a JSON array")
    return [_parse_command(cmd, i) for i, cmd in enumerate(commands)]


def referenced_pages(commands: Sequence[BatchCommand]) -> list[str]:
    """Page titles a batch's commands need fetched (in first-seen order),
    so the shell knows what to fetch/create before planning. Reads the
    validated commands rather than the raw JSON: `update` and `delete`
    address a block by uid and name no page, and those are exactly the
    two params models without a `page` field."""
    seen: list[str] = []
    for cmd in commands:
        params = cmd.params
        if isinstance(params, CreateParams | OutlineParams | MoveParams) \
                and params.page not in seen:
            seen.append(params.page)
    return seen


PageBlocks = Mapping[str, Sequence[BlockNode]]


@dataclass
class _BatchCtx:
    """The state `plan_batch` threads through its per-command planners: the
    one `_Planner` they share (append counters and heading memo), the pages
    the shell fetched, the `{{alias}}` -> uid map that `as` params fill in,
    and the uids created so far in this batch -- which are on none of those
    fetched pages."""
    planner: _Planner
    pages: PageBlocks
    aliases: dict[str, str] = field(default_factory=dict)
    created: set[str] = field(default_factory=set)

    def blocks(self, title: str) -> Sequence[BlockNode]:
        if title not in self.pages:
            raise BuildError(f"page not fetched: {title}")
        return self.pages[title]

    def record(self, ops: Sequence[BlockOp]) -> None:
        """Remember the uids `ops` create, so a later command's `((uid))`
        parent or move target resolves against them."""
        self.created.update(o.uid for o in ops if isinstance(o, CreateOp))

    def resolve_parent(
        self, blocks: Sequence[BlockNode], page: str, spec: str | None
    ) -> tuple[str | None, bool, list[CreateOp]]:
        """A create/outline command's parent spec resolved to
        (parent uid, whether it is off-page, ops creating a missing
        heading). Three cases, in precedence order: a `((uid))` from earlier
        in this batch, which `resolve_parent` cannot see; a spec that
        resolves on the fetched page; a "## Heading" that isn't there yet,
        which the planner creates or reuses from its memo -- off-page either
        way, since the fetched blocks predate this batch."""
        in_batch = _in_batch_uid(spec, self.created)
        if in_batch is not None:
            return in_batch, True, []
        parent, missing = resolve_parent(blocks, spec)
        if missing is None:
            return parent, False, []
        uid, ops = self.planner.heading(blocks, page, *missing)
        return uid, True, ops


def _batch_create(cmd: CreateCommand | TodoCommand,
                  ctx: _BatchCtx) -> list[CreateOp]:
    p = cmd.params
    blocks = ctx.blocks(p.page)
    spec = _resolve_alias(p.parent, ctx.aliases)
    parent, off_page, ops = ctx.resolve_parent(blocks, p.page, spec)
    todo = cmd.command == "todo"
    if p.index is None:
        ops = [*ops, *ctx.planner.creates(blocks, p.page, parent,
                                          [(0, p.text)], todo, off_page)]
    else:
        ops = [*ops, ctx.planner.create_at(p.page, parent, p.index, p.text,
                                           todo)]
    if p.as_:
        # The content block, never a heading this command had to create
        # first: the alias names what the caller asked for.
        ctx.aliases[p.as_] = ops[-1].uid
    return ops


def _batch_outline(cmd: OutlineCommand, ctx: _BatchCtx) -> list[CreateOp]:
    p = cmd.params
    blocks = ctx.blocks(p.page)
    spec = _resolve_alias(p.parent, ctx.aliases)
    parent, off_page, ops = ctx.resolve_parent(blocks, p.page, spec)
    return [*ops, *ctx.planner.creates(blocks, p.page, parent,
                                       _nested_items(p.items), todo=False,
                                       parent_off_page=off_page)]


def _batch_update(cmd: UpdateCommand, ctx: _BatchCtx) -> list[BlockOp]:
    p = cmd.params
    return plan_update(_alias_uid(p.uid, ctx.aliases), p.text)


def _batch_move(cmd: MoveCommand, ctx: _BatchCtx) -> list[MoveOp]:
    p = cmd.params
    blocks = ctx.blocks(p.page)
    uid = _alias_uid(p.uid, ctx.aliases)
    spec = _resolve_alias(p.parent, ctx.aliases)
    # Not `ctx.resolve_parent`: `move` never creates its target. A missing
    # heading here means the caller named a section that doesn't exist,
    # which is a mistake rather than an instruction.
    in_batch = _in_batch_uid(spec, ctx.created)
    if in_batch is not None:
        parent, off_page = in_batch, True
    else:
        parent, missing = resolve_parent(blocks, spec)
        if missing is not None:
            raise BuildError("move target heading does not exist")
        off_page = False
    idx = p.index if p.index is not None \
        else ctx.planner.bump(blocks, p.page, parent, off_page)
    return [MoveOp(op="move", uid=uid, parent_uid=parent, order_idx=idx,
                   page_title=None if parent else p.page)]


def _batch_delete(cmd: DeleteCommand, ctx: _BatchCtx) -> list[DeleteOp]:
    return [DeleteOp(op="delete",
                     uid=_alias_uid(cmd.params.uid, ctx.aliases))]


def plan_batch(commands: Sequence[object], pages: PageBlocks,
               uids: Iterator[str]) -> list[BlockOp]:
    """Translate a batch of `{command, params}` items into one op list.

    The first step parses every item against the command schema (see
    `validate_batch`), so a malformed item -- non-object, unknown/missing
    `command`, missing/wrong-typed/extra params -- raises `BuildError`
    naming its index here too, not just when the shell validates upfront.

    `create`/`todo` accept an `as` alias so later commands in the same
    batch can reference the block just created via `parent: "{{alias}}"`.
    Those in-batch uids live in `_BatchCtx.created`, since they don't exist
    on the fetched pages that `resolve_parent`/`next_child_idx` consult.
    """
    parsed = [_parse_command(cmd, i) for i, cmd in enumerate(commands)]
    ctx = _BatchCtx(planner=_Planner(uids), pages=pages)
    ops: list[BlockOp] = []

    for cmd in parsed:
        new: Sequence[BlockOp]
        if isinstance(cmd, CreateCommand | TodoCommand):
            new = _batch_create(cmd, ctx)
        elif isinstance(cmd, OutlineCommand):
            new = _batch_outline(cmd, ctx)
        elif isinstance(cmd, UpdateCommand):
            new = _batch_update(cmd, ctx)
        elif isinstance(cmd, MoveCommand):
            new = _batch_move(cmd, ctx)
        else:
            new = _batch_delete(cmd, ctx)
        ops.extend(new)
        ctx.record(new)
    return ops


__all__ = [
    "BuildError", "parse_outline", "next_child_idx", "resolve_parent",
    "split_heading", "plan_save", "plan_update", "plan_mark",
    "asset_block_text", "referenced_pages", "plan_batch", "create_page_ops",
    "validate_batch",
]
