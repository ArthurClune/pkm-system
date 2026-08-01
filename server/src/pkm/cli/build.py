# pattern: Functional Core
"""Plan CLI/MCP writes as /api/ops op dicts. Pure: page payloads and a uid
iterator come in, op dicts come out. The shell fetches pages, generates
uids, and posts the result."""
from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Sequence
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from pkm.server.ops_core import text_hash
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


def _walk(nodes: list[dict]) -> Iterator[dict]:
    for n in nodes:
        yield n
        yield from _walk(n["children"])


def next_child_idx(blocks: list[dict], parent_uid: str | None) -> int:
    """Append position under `parent_uid` in a `build_tree`-shaped `blocks`
    list; `None` means top level of the page."""
    if parent_uid is None:
        return len(blocks)
    for n in _walk(blocks):
        if n["uid"] == parent_uid:
            return len(n["children"])
    raise BuildError(f"parent block not on page: {parent_uid}")


def resolve_parent(
    payload: dict, spec: str | None
) -> tuple[str | None, tuple[int, str] | None]:
    """Resolve a parent spec against a fetched page payload.

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
    m = _UID_SPEC.match(spec)
    if m:
        uid = m.group(1)
        if not any(n["uid"] == uid for n in _walk(payload["blocks"])):
            raise BuildError(f"block not on page: {uid}")
        return uid, None
    m = _HEADING_SPEC.match(spec)
    if m:
        level, text = len(m.group(1)), m.group(2)
        for n in _walk(payload["blocks"]):
            if n["heading"] == level and n["text"] == text:
                return n["uid"], None
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
            heading: int | None = None) -> dict:
    op = {"op": "create", "uid": uid, "page_title": page,
          "parent_uid": parent, "order_idx": idx, "text": text}
    if heading is not None:
        op["heading"] = heading
    return op


class _Planner:
    """Tracks the next append order_idx per (page, parent) across ops so
    consecutive creates land in consecutive positions. `in_batch` is the
    set of uids created earlier in the same batch: they are not on the
    fetched page payload, so their first child starts at order_idx 0
    instead of consulting `next_child_idx` (which would raise, since the
    block doesn't exist in the payload). Also memoizes missing '## Heading'
    parents by (page, level, text): a repeated spec across separate
    `creates` calls (i.e. separate batch commands) reuses the heading
    already planned instead of creating a duplicate."""

    def __init__(self, uids: Iterator[str]):
        self._uids = uids
        self._next_idx: dict[tuple[str, str | None], int] = {}
        self._headings: dict[tuple[str, int, str], str] = {}

    def next_uid(self) -> str:
        return next(self._uids)

    def bump(self, payload: dict, page: str, parent: str | None,
             in_batch: frozenset[str] = frozenset()) -> int:
        key = (page, parent)
        if key not in self._next_idx:
            if parent is not None and parent in in_batch:
                self._next_idx[key] = 0
            else:
                self._next_idx[key] = next_child_idx(payload["blocks"], parent)
        idx = self._next_idx[key]
        self._next_idx[key] = idx + 1
        return idx

    def creates(self, payload: dict, page: str, parent_spec: str | None,
                items: list[tuple[int, str]], todo: bool,
                in_batch: frozenset[str] = frozenset(),
                index: int | None = None) -> list[dict]:
        """Plan creates for `items` (depth, text) pairs under `parent_spec`.
        Resolves the parent spec first (handling in-batch alias uids, which
        `resolve_parent` can't see since they aren't in the payload), then
        walks the outline maintaining a depth->uid stack so nested items
        attach to the most recently created ancestor at the right depth.

        `index`, when given, becomes the first depth-0 item's `order_idx`
        verbatim -- the server splices siblings at/after it on insert. Only
        single-item `create`/`todo` batch commands pass it (never `outline`,
        never `plan_save`). Mixing an indexed create with plain appends
        under the same parent in one batch may interleave, since appends
        keep counting from the payload's original length rather than
        accounting for the index; see `pkm batch --help`.
        """
        m = _UID_SPEC.match(parent_spec) if parent_spec else None
        if m and m.group(1) in in_batch:
            parent: str | None = m.group(1)
            missing_heading = None
        else:
            parent, missing_heading = resolve_parent(payload, parent_spec)
        ops: list[dict] = []
        created: set[str] = set()
        if missing_heading is not None:
            level, text = missing_heading
            heading_key = (page, level, text)
            if heading_key in self._headings:
                parent = self._headings[heading_key]
            else:
                parent = self.next_uid()
                ops.append(_create(parent, page, None,
                                   self.bump(payload, page, None, in_batch),
                                   text, level))
                self._headings[heading_key] = parent
            created.add(parent)
        stack: list[str | None] = [parent]
        first = True
        for depth, text in items:
            del stack[depth + 1:]
            target = stack[depth]
            body, level = split_heading(text)
            if todo and depth == 0:
                body = with_state(body, "TODO")
            uid = self.next_uid()
            if depth == 0 and first and index is not None:
                idx = index
            else:
                idx = self.bump(payload, page, target,
                                in_batch | frozenset(created))
            first = False
            ops.append(_create(uid, page, target, idx, body, level))
            if level is not None:
                # So a later `parent: "## Notes"` in the same batch nests
                # under this block instead of creating a second heading.
                # `resolve_parent` can't find it: it walks only the
                # fetched page payload, which predates this batch. Keyed
                # on the stored text (TODO prefix included, if any) so
                # the memo agrees with what a later fetch would match.
                self._headings.setdefault((page, level, body), uid)
            created.add(uid)
            if len(stack) == depth + 1:
                stack.append(uid)
            else:
                stack[depth + 1] = uid
        return ops


def plan_save(payload: dict, page_title: str, parent_spec: str | None,
              text: str, todo: bool, uids: Iterator[str]) -> list[dict]:
    """Plan the create ops for `pkm save`: an outline of `text` nested
    under `parent_spec` (page top level if None)."""
    items = parse_outline(text)
    if not items:
        raise BuildError("nothing to save: text is empty")
    return _Planner(uids).creates(payload, page_title, parent_spec, items, todo)


class _NotGiven:
    """Sentinel for `plan_update`'s `current_heading` default: `pkm
    batch`'s `update` command has no fetched block to compare against, so
    it never passes one. Distinguishes that from a real, meaningful
    `current_heading=None` (the block is currently plain text)."""


_NOT_GIVEN = _NotGiven()


def plan_update(uid: str, text: str, base_text: str | None = None,
                current_heading: int | None | _NotGiven = _NOT_GIVEN
                ) -> list[dict]:
    """Ops for replacing a block's text: `update_text` plus, when the
    heading level is actually changing, the `set_heading` that keeps the
    stored level in step with the text's leading hashes -- no hashes
    means plain text, so a heading is cleared.

    `current_heading` is the block's level before this update, as read by
    the caller (`client.get_block(uid)["block"]["heading"]`). When it
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
    update: dict = {"op": "update_text", "uid": uid, "text": body}
    if base_text is not None:
        update["base_text_hash"] = text_hash(base_text)
    ops = [update]
    if isinstance(current_heading, _NotGiven) or current_heading != level:
        ops.append({"op": "set_heading", "uid": uid, "heading": level})
    return ops


def plan_mark(uid: str, current_text: str, mark: str) -> list[dict]:
    """Ops for a task-marker change (`pkm update -D`/`-T`, `update_block
    mark=`): `update_text` with the marker applied to `current_text`, plus
    the `base_text_hash` concurrent-edit guard. Deliberately never
    `plan_update` and never emits `set_heading`: `current_text` is read
    back from the API already bare (the heading level lives in its own
    column), so splitting it would find no hashes and demote a real
    heading to plain text."""
    return [{"op": "update_text", "uid": uid,
             "text": with_state(current_text, mark),
             "base_text_hash": text_hash(current_text)}]


def asset_block_text(filename: str, mime: str, url: str) -> str:
    """Render an uploaded asset as a block: image embed, `pdf` macro, or a
    plain link, keyed off the asset's mime type. Pure text shaping shared
    by the CLI (`pkm upload`) and the MCP server's upload tool."""
    if mime.startswith("image/"):
        return f"![{filename}]({url})"
    if mime == "application/pdf":
        return f"{{{{[[pdf]]: {url}}}}}"
    return f"[{filename}]({url})"


def create_page_ops(titles: Iterable[str]) -> list[dict]:
    """`create_page` ops for pages that don't exist yet, meant to be
    prepended to a planned batch's ops so a missing page's creation rides
    inside the same atomic OpBatch as the blocks that reference it
    (pkm-w80k) -- a batch that fails validation after this point leaves
    neither the page nor its blocks behind, instead of the page having
    already been committed via a separate request."""
    return [{"op": "create_page", "page_title": t} for t in titles]


def referenced_pages(commands: list[dict]) -> list[str]:
    """Page titles a batch's commands need fetched (in first-seen order),
    so the shell knows what to fetch/create before planning."""
    seen: list[str] = []
    for cmd in commands:
        page = cmd.get("params", {}).get("page")
        if page and page not in seen:
            seen.append(page)
    return seen


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


def _fetch_page(title: str, pages: dict[str, dict]) -> dict:
    if title not in pages:
        raise BuildError(f"page not fetched: {title}")
    return pages[title]


def _batch_create(cmd: CreateCommand | TodoCommand, pages: dict[str, dict],
                  planner: _Planner, aliases: dict[str, str],
                  created: set[str]) -> list[dict]:
    p = cmd.params
    payload = _fetch_page(p.page, pages)
    spec = _resolve_alias(p.parent, aliases)
    new = planner.creates(payload, p.page, spec, [(0, p.text)],
                          todo=(cmd.command == "todo"),
                          in_batch=frozenset(created), index=p.index)
    if p.as_:
        aliases[p.as_] = new[-1]["uid"]
    return new


def _batch_outline(cmd: OutlineCommand, pages: dict[str, dict],
                   planner: _Planner, aliases: dict[str, str],
                   created: set[str]) -> list[dict]:
    p = cmd.params
    payload = _fetch_page(p.page, pages)
    items = _nested_items(p.items)
    spec = _resolve_alias(p.parent, aliases)
    return planner.creates(payload, p.page, spec, items, todo=False,
                           in_batch=frozenset(created))


def _batch_update(cmd: UpdateCommand, aliases: dict[str, str]) -> list[dict]:
    p = cmd.params
    uid = _alias_uid(p.uid, aliases)
    return plan_update(uid, p.text)


def _batch_move(cmd: MoveCommand, pages: dict[str, dict], planner: _Planner,
                aliases: dict[str, str], created: set[str]) -> list[dict]:
    p = cmd.params
    payload = _fetch_page(p.page, pages)
    uid = _alias_uid(p.uid, aliases)
    spec = _resolve_alias(p.parent, aliases)
    m = _UID_SPEC.match(spec) if spec else None
    if m and m.group(1) in created:
        parent: str | None = m.group(1)
    else:
        parent, missing = resolve_parent(payload, spec)
        if missing is not None:
            raise BuildError("move target heading does not exist")
    idx = p.index
    if idx is None:
        idx = planner.bump(payload, p.page, parent, frozenset(created))
    return [{"op": "move", "uid": uid, "parent_uid": parent,
             "order_idx": idx, "page_title": None if parent else p.page}]


def _batch_delete(cmd: DeleteCommand, aliases: dict[str, str]) -> list[dict]:
    return [{"op": "delete", "uid": _alias_uid(cmd.params.uid, aliases)}]


def plan_batch(commands: Sequence[object], pages: dict[str, dict],
               uids: Iterator[str]) -> list[dict]:
    """Translate a batch of `{command, params}` items into one op list.

    The first step parses every item against the command schema (see
    `validate_batch`), so a malformed item -- non-object, unknown/missing
    `command`, missing/wrong-typed/extra params -- raises `BuildError`
    naming its index here too, not just when the shell validates upfront.

    `create`/`todo` accept an `as` alias so later commands in the same
    batch can reference the block just created via `parent: "{{alias}}"`.
    Those in-batch uids are tracked in `created` and threaded through as
    `_Planner.creates`'s `in_batch` set, since they don't exist on the
    fetched page payloads that `resolve_parent`/`next_child_idx` consult.
    """
    parsed = [_parse_command(cmd, i) for i, cmd in enumerate(commands)]
    planner = _Planner(uids)
    aliases: dict[str, str] = {}
    created: set[str] = set()
    ops: list[dict] = []

    for cmd in parsed:
        if isinstance(cmd, CreateCommand | TodoCommand):
            new = _batch_create(cmd, pages, planner, aliases, created)
            ops.extend(new)
            created.update(o["uid"] for o in new)
        elif isinstance(cmd, OutlineCommand):
            new = _batch_outline(cmd, pages, planner, aliases, created)
            ops.extend(new)
            created.update(o["uid"] for o in new)
        elif isinstance(cmd, UpdateCommand):
            ops.extend(_batch_update(cmd, aliases))
        elif isinstance(cmd, MoveCommand):
            ops.extend(_batch_move(cmd, pages, planner, aliases, created))
        else:
            ops.extend(_batch_delete(cmd, aliases))
    return ops


__all__ = [
    "BuildError", "parse_outline", "next_child_idx", "resolve_parent",
    "split_heading", "plan_save", "plan_update", "plan_mark",
    "asset_block_text", "referenced_pages", "plan_batch", "create_page_ops",
    "validate_batch",
]
