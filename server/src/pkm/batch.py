# pattern: Functional Core
"""The `pkm batch` command language: the schema a batch item must satisfy,
and the dispatch that turns a validated batch into one op list.

Transport-neutral like the planners it calls -- `pkm batch` and the MCP
`batch` tool are two front doors onto this module, and neither owns it.
What comes in is decoded JSON plus the pages the shell fetched; what goes
out is `pkm.contracts.ops` models for `POST /api/ops` to apply as one
atomic transaction.

Positioning blocks is `pkm.planning`'s job. What lives here is everything
a single command's planner cannot know: the shape of a command, `{{alias}}`
bookkeeping across commands, and which uids exist only inside this batch."""
from __future__ import annotations

import re
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Annotated, Literal, Union

from pydantic import (BaseModel, ConfigDict, Field, TypeAdapter,
                      ValidationError, model_validator)

from pkm.contracts.ops import BlockOp, CreateOp, DeleteOp, MoveOp
from pkm.contracts.responses import BlockNode
from pkm.planning import (BuildError, Planner, parse_uid_spec, plan_update,
                          resolve_parent)

_ALIAS_SPEC = re.compile(r"^\{\{(.+)\}\}$")


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
    one `Planner` they share (append counters and heading memo), the pages
    the shell fetched, the `{{alias}}` -> uid map that `as` params fill in,
    and the uids created so far in this batch -- which are on none of those
    fetched pages."""
    planner: Planner
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
    ctx = _BatchCtx(planner=Planner(uids), pages=pages)
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
    "NestedItem", "BatchCommand", "PageBlocks", "validate_batch",
    "referenced_pages", "plan_batch",
]
