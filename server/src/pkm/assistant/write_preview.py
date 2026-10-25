# pattern: Functional Core
"""What the approval card shows before an assistant write runs.

The card is the only thing between a prompt-injected model and a write
to the user's notes, so it previews what the tool will receive, not what
the model sent: each write tool's own FastMCP argument model parses the
input first (FastMCP JSON-decodes every non-`str` argument, so
`page: "null"` arrives as None and `allow_merge: "yes"` as True), and a
batch's commands go through the same schema `apply_batch` applies. Input
neither accepts is refused rather than previewed, and so is a key the
argument model does not declare: the tool drops it, so a card row for it
could only be a decoy beside the real target.

A write that replaces, moves or deletes an existing block also shows that
block's current text and page, which the shell reads for the uids
`write_target_uids` names and passes in: a uid alone does not tell the
user what they are approving away. A delete removes the block's subtree
too, so for the uids `delete_target_uids` names the shell also counts the
blocks under it.

That count is of the store as read, so a batch delete must not take a
block an earlier write of the same batch moved under it: the count would
leave that block and its subtree out. Such a batch is refused, and so is
one where the card cannot tell where such a move lands; for that the shell
reads the ancestors of the `((uid))` parents `ancestor_uids` names. The
CLI's batch is not checked: its user wrote the batch.

The tool functions come from `pkm.mcp.tools`, never `pkm.mcp.server`:
constructing the server's `FastMCP` configures the root logger and reads
`FASTMCP_*` settings, and the web server imports this module."""
from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from mcp.server.fastmcp.utilities.func_metadata import (FuncMetadata,
                                                        func_metadata)
from pydantic import ValidationError

from pkm.assistant.policy import (CURRENT_TEXT_ENTRIES,
                                  SUBTREE_DELETE_ENTRIES,
                                  WRITE_PREVIEW_FIELDS, WRITE_TOOLS)
from pkm.batch import (BatchItemError, NestedItem, alias_name, batch_aliases,
                       nested_items, validate_batch)
from pkm.contracts.ops import MAX_OPS_PER_BATCH, BlockUid
from pkm.contracts.titles import CanonicalTitle
from pkm.echo import echo, loc_text
from pkm.mcp import tools as mcp_tools
from pkm.planning import parse_uid_spec
from pkm.refs import parse_block_uid

# The card sends every content value whole, so [show] can reveal all of
# it; a longer one is refused rather than approved partly unseen.
CONTENT_LIMIT_CHARS = 50_000
# A target is a uid, title, path or parent spec. The server bounds none of
# them (a page title has no length limit), so the card does: a multi-MB
# value would freeze the tab the user must approve from.
TARGET_LIMIT_CHARS = 1000
# The current text is context for the target, not something the write
# sends, so the card shows its start and says how long the whole is.
CURRENT_EXCERPT_CHARS = 200
# Everything the card holds at once: a batch of many content-sized writes
# would otherwise be a card the tab cannot render for the user to approve.
PREVIEW_LIMIT_CHARS = 250_000
# A batch with more commands than one batch can carry is refused before any
# row is built.
MAX_PREVIEW_OPS = MAX_OPS_PER_BATCH
# A refusal quotes the model's input, so the message the model reads back
# (and the log line) is cut, saying how long it was.
REFUSAL_LIMIT_CHARS = 500

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StoredBlock:
    """What the shell read for one uid."""
    page_title: CanonicalTitle
    text: str
    # How many blocks sit under it: counted only for a uid
    # `delete_target_uids` names, else None.
    descendants: int | None = None
    # The blocks above it, its parent first: read only for a uid
    # `ancestor_uids` names, else None.
    ancestors: tuple[BlockUid, ...] | None = None


@dataclass(frozen=True)
class FoundBlock:
    page_title: CanonicalTitle
    # The first CURRENT_EXCERPT_CHARS code points of the text.
    excerpt: str
    # The whole text's length in code points.
    text_length: int
    # The blocks under it that a delete removes with it; None for a write
    # that leaves them where they are.
    descendants: int | None = None
    state: Literal["found"] = "found"


@dataclass(frozen=True)
class MissingBlock:
    state: Literal["missing"] = "missing"


@dataclass(frozen=True)
class CreatedInBatch:
    """A batch op on the block an earlier write of the batch creates."""
    # 1-based, as the card numbers the writes.
    write: int
    alias: str
    state: Literal["created"] = "created"


CurrentBlock = FoundBlock | MissingBlock | CreatedInBatch


@dataclass(frozen=True)
class PreviewOp:
    action: str
    # JSON values, never clipped.
    targets: list[tuple[str, object]]
    # (key, text, its length in code points)
    content: list[tuple[str, str, int]]
    warnings: list[str]
    # None: the op touches no existing block.
    current: CurrentBlock | None


@dataclass(frozen=True)
class WritePreview:
    ops: list[PreviewOp]
    # One line for logs and transcripts.
    summary: str
    # Another write, of this turn or of a stopped one, was awaiting its
    # answer or running while the blocks were read, so it may land after
    # the read and the current text may be stale. The engine stamps it;
    # until then it is True, so an unstamped card errs towards saying so.
    writes_in_flight: bool = True


@dataclass(frozen=True)
class Refusal:
    message: str


@dataclass(frozen=True)
class _Checked:
    """A call the tool accepts: each op's `WRITE_PREVIEW_FIELDS` key with
    its params as validated, in order, and each batch alias mapped to the
    index of the op that creates it (empty outside a batch)."""
    ops: list[tuple[str, dict[str, Any]]]
    aliases: dict[str, int]


_ARG_MODELS: dict[str, FuncMetadata] = {
    name: func_metadata(getattr(mcp_tools, name)) for name in WRITE_TOOLS}


def _outline_text(items: list[NestedItem]) -> str:
    """One line per item, two spaces per level. A newline inside an item
    shows as `\\n`, so an item cannot draw what looks like a child, and a
    backslash as `\\\\`, so a literal backslash-n cannot pass for one."""
    return "\n".join(
        "  " * depth + text.replace("\\", "\\\\").replace("\n", "\\n")
        for depth, text in nested_items(items))


def _content_text(key: str, value: object) -> str:
    if key == "items" and isinstance(value, list):
        return _outline_text(value)
    return value if isinstance(value, str) else json.dumps(value)


def _quoted(value: object) -> str:
    """A value inside prose, JSON-quoted so it cannot close the quote and
    write the rest of the sentence."""
    return json.dumps(value, ensure_ascii=False)


def _merge_warning(validated: Mapping[str, Any]) -> list[str]:
    if validated.get("allow_merge") is not True:
        return []
    return [f'allow_merge is on: if {_quoted(validated["new_title"])} '
            f'exists, {_quoted(validated["title"])} is merged into it '
            '(irreversible)']


def _parent_warning(entry: str, parent: object,
                    aliases: Mapping[str, int]) -> list[str]:
    """Where a `((uid))` or `{{alias}}` parent puts the write, as
    `plan_save` and `plan_batch` decide it. A `((uid))` must be on the
    fetched page, or planning fails before anything is sent. An alias
    resolves to a block created earlier in the batch, and the create or
    move then goes under it, so the op's own `page` does not place it."""
    if not isinstance(parent, str):
        return []
    alias = alias_name(parent)
    if alias is not None and not entry.startswith("batch:"):
        return [f"parent {_quoted(parent)} is an alias, which only batch "
                "knows: nothing is written"]
    if alias is not None:
        return [f"parent {_quoted(parent)} is the block write "
                f"{aliases[alias] + 1} creates as {_quoted(alias)}: this "
                "lands under it, on that block's page, whatever the page "
                "row says"]
    if parse_uid_spec(parent) is not None:
        return [f"parent {_quoted(parent)} must be a block on the page "
                "shown, or nothing is written"]
    return []


def _missing_uid_warning(entry: str, spec: object) -> list[str]:
    """A batch update or move sends its uid unchecked; the server skips
    one that names no block (`ops_core.classify_skip`: orphan_edit,
    orphan_structural) and lands the text, or a note, on today's daily
    note. An alias names a block this batch creates, so it exists."""
    if not isinstance(spec, str) or alias_name(spec) is not None:
        return []
    if entry == "batch:update":
        return [f"if no block has uid {_quoted(spec)}, nothing is updated "
                "and the text is added to today's daily note instead"]
    return [f"if no block has uid {_quoted(spec)}, nothing moves and a note "
            "saying so is added to today's daily note"]


def _warnings(entry: str, validated: Mapping[str, Any],
              aliases: Mapping[str, int]) -> list[str]:
    """Fixed text around JSON-quoted values, so no value can write the
    rest of a sentence."""
    out = _merge_warning(validated) if entry == "rename_page" else []
    out += _parent_warning(entry, validated.get("parent"), aliases)
    if entry in ("batch:update", "batch:move"):
        out += _missing_uid_warning(entry, validated.get("uid"))
    return out


def _target_uid(entry: str, validated: Mapping[str, Any]
                ) -> BlockUid | None:
    """The existing block op `entry` replaces, moves or deletes, or None.
    An `{{alias}}` or malformed spec is never a uid: braces are outside
    the uid alphabet, so no read can be steered by one."""
    spec = validated.get("uid")
    if entry not in CURRENT_TEXT_ENTRIES or not isinstance(spec, str):
        return None
    return parse_block_uid(spec)


def _current(entry: str, validated: Mapping[str, Any],
             aliases: Mapping[str, int],
             blocks: Mapping[BlockUid, StoredBlock]) -> CurrentBlock | None:
    """The block op `entry` acts on as it stands now. Only batch knows
    aliases, so `update_block`'s `{{x}}` names no block: missing."""
    if entry not in CURRENT_TEXT_ENTRIES:
        return None
    spec = validated.get("uid")
    alias = (alias_name(spec) if entry.startswith("batch:")
             and isinstance(spec, str) else None)
    if alias is not None:
        return CreatedInBatch(write=aliases[alias] + 1, alias=alias)
    uid = _target_uid(entry, validated)
    stored = blocks.get(uid) if uid is not None else None
    if stored is None:
        return MissingBlock()
    return FoundBlock(page_title=stored.page_title,
                      excerpt=stored.text[:CURRENT_EXCERPT_CHARS],
                      text_length=len(stored.text),
                      descendants=(stored.descendants
                                   if entry in SUBTREE_DELETE_ENTRIES
                                   else None))


def _op(entry: str, validated: Mapping[str, Any],
        aliases: Mapping[str, int],
        blocks: Mapping[BlockUid, StoredBlock]) -> PreviewOp:
    """One card entry: the table's targets, then any field the argument
    model declares and the table does not name (fail safe: a new field
    shows rather than vanishes), then the content, every value as
    validated. A content value of None is an absent argument and is left
    out."""
    label, target_keys, content_keys = WRITE_PREVIEW_FIELDS[entry]
    named = set(target_keys) | set(content_keys)
    targets: list[tuple[str, object]] = [
        (k, validated.get(k)) for k in target_keys]
    targets += [(k, v) for k, v in validated.items() if k not in named]
    content: list[tuple[str, str, int]] = []
    for key in content_keys:
        value = validated.get(key)
        if value is None:
            continue
        text = _content_text(key, value)
        content.append((key, text, len(text)))
    return PreviewOp(action=label, targets=targets, content=content,
                     warnings=_warnings(entry, validated, aliases),
                     current=_current(entry, validated, aliases, blocks))


@dataclass(frozen=True)
class _Existing:
    """A block the store holds, by uid."""
    uid: BlockUid


@dataclass(frozen=True)
class _Made:
    """The block a batch create makes, by its `as` name."""
    alias: str


_Node = _Existing | _Made
# Where a `parent` spec puts a block: under a node, at its page's top
# level, or somewhere the card cannot place.
_Place = _Node | Literal["top", "unplaced"]
_CREATES = ("batch:create", "batch:todo")


def _node(spec: object) -> _Node | None:
    """The block a batch `uid` spec names; None for a malformed uid,
    which names no block, so the write moves or deletes nothing."""
    if not isinstance(spec, str):
        return None
    alias = alias_name(spec)
    if alias is not None:
        return _Made(alias)
    uid = parse_block_uid(spec)
    return _Existing(uid) if uid is not None else None


def _place(parent: str | None) -> _Place:
    """Where a create's or move's `parent` spec puts the block. A
    "## Heading" resolves against the fetched page, and a malformed
    `((uid))` fails planning: the card can place neither."""
    if parent is None:
        return "top"
    alias = alias_name(parent)
    if alias is not None:
        return _Made(alias)
    inner = parse_uid_spec(parent)
    uid = parse_block_uid(inner) if inner is not None else None
    return _Existing(uid) if uid is not None else "unplaced"


def _ends_under(start: _Node, target: _Node,
                parents: Mapping[_Node, _Place],
                blocks: Mapping[BlockUid, StoredBlock]) -> bool | None:
    """Whether `start` sits under `target` once the writes recorded in
    `parents` have run. A block a create or move placed follows
    `parents`; one left where it is follows its stored ancestors, read
    for each `((uid))` parent `ancestor_uids` names. None: the card cannot
    tell (an unplaced parent, an unread block, a cycle)."""
    seen: set[_Node] = {start}
    place = parents[start]
    while True:
        if place == "top":
            return False
        if place == "unplaced":
            return None
        if place == target:
            return True
        if place in seen:
            return None
        seen.add(place)
        if place in parents:
            place = parents[place]
            continue
        stored = (blocks.get(place.uid) if isinstance(place, _Existing)
                  else None)
        if stored is None or stored.ancestors is None:
            return None
        for ancestor in stored.ancestors:
            node = _Existing(ancestor)
            if node == target:
                return True
            if node in parents:
                place = node
                break
        else:
            return False


def _moved_into_delete(ops: Sequence[tuple[str, Mapping[str, Any]]],
                       blocks: Mapping[BlockUid, StoredBlock]
                       ) -> Refusal | None:
    """Why a batch delete would take an existing block an earlier write
    moved under it, or None. The delete's count is of the store as read,
    so that block and everything under it would go uncounted. Refused
    rather than warned: moving a block where the same batch then deletes
    it is never needed, so the batch can be split."""
    parents: dict[_Node, _Place] = {}
    moved: dict[_Existing, int] = {}
    for i, (entry, params) in enumerate(ops):
        if entry in _CREATES and params.get("as"):
            parents[_Made(params["as"])] = _place(params.get("parent"))
            continue
        node = _node(params.get("uid"))
        if node is None:
            continue
        if entry == "batch:move":
            parents[node] = _place(params.get("parent"))
            if isinstance(node, _Existing):
                moved[node] = i
        elif entry == "batch:delete":
            for block, write in moved.items():
                under = (False if block == node
                         else _ends_under(block, node, parents, blocks))
                if under is False:
                    continue
                deleted = (f"batch: write {i + 1} deletes "
                           f"{echo(params['uid'])} and every block under "
                           "it, and ")
                if under:
                    return Refusal(
                        f"{deleted}write {write + 1} moves an existing "
                        "block there first, so it would be deleted too; "
                        "move it elsewhere or split the batch")
                return Refusal(
                    f"{deleted}the card cannot tell whether write "
                    f"{write + 1} moves an existing block there first; "
                    "split the batch")
    return None


def _limit_problem(op: PreviewOp) -> str | None:
    """Why `op` is too large to preview, or None."""
    for key, value in op.targets:
        if isinstance(value, str) and len(value) > TARGET_LIMIT_CHARS:
            return (f"{key} is {len(value)} characters; a target is at most "
                    f"{TARGET_LIMIT_CHARS}")
    current = op.current
    if isinstance(current, FoundBlock) \
            and len(current.page_title) > TARGET_LIMIT_CHARS:
        return (f"the block's page title is {len(current.page_title)} "
                f"characters; a target is at most {TARGET_LIMIT_CHARS}")
    for key, _, total in op.content:
        if total > CONTENT_LIMIT_CHARS:
            return (f"{key} is {total} characters; split the write into "
                    f"parts under {CONTENT_LIMIT_CHARS}")
    return None


def _card_size(op: PreviewOp) -> int:
    """The characters `op` puts on the card: every string target, every
    content text, every warning and the current block's text, names and
    count."""
    size = sum(len(v) for _, v in op.targets if isinstance(v, str))
    size += sum(total for _, _, total in op.content)
    size += sum(len(w) for w in op.warnings)
    current = op.current
    if isinstance(current, FoundBlock):
        size += len(current.page_title) + len(current.excerpt)
        if current.descendants is not None:
            size += len(str(current.descendants))
    elif isinstance(current, CreatedInBatch):
        size += len(current.alias)
    return size


def _first_error(exc: ValidationError) -> str:
    first = exc.errors()[0]
    path = loc_text(first["loc"])
    return f"{path}: {first['msg']}" if path else first["msg"]


def _unknown_key(meta: FuncMetadata, tool_input: Mapping[str, object]
                 ) -> str | None:
    """The first key of `tool_input` the argument model neither names nor
    aliases. FastMCP's model ignores such a key, so the tool never sees
    it."""
    declared = {name for name in meta.arg_model.model_fields}
    declared |= {f.alias for f in meta.arg_model.model_fields.values()
                 if f.alias}
    return next((k for k in tool_input if k not in declared), None)


def write_target_uids(short: str, tool_input: Mapping[str, object]
                      ) -> list[BlockUid]:
    """The existing blocks the card for this call shows, in first-seen
    order, for the shell to read before `build_write_preview`. Input the
    preview refuses names none, and so does input it cannot handle: like
    `build_write_preview`, this never raises."""
    return _targets(short, tool_input, CURRENT_TEXT_ENTRIES)


def delete_target_uids(short: str, tool_input: Mapping[str, object]
                       ) -> list[BlockUid]:
    """Those of `write_target_uids` this call deletes, each with the blocks
    under it, for the shell to count them. Never raises."""
    return _targets(short, tool_input, SUBTREE_DELETE_ENTRIES)


def ancestor_uids(short: str, tool_input: Mapping[str, object]
                  ) -> list[BlockUid]:
    """The `((uid))` parents of a batch's moves and aliased creates, when
    a move comes before a delete, for the shell to read their ancestors:
    without them the card cannot tell whether the move lands inside the
    deleted subtree. Never raises."""
    checked = _accepted(short, tool_input)
    if checked is None:
        return []
    entries = [entry for entry, _ in checked.ops]
    if "batch:move" not in entries or "batch:delete" not in entries[
            entries.index("batch:move"):]:
        return []
    places = (_place(params.get("parent")) for entry, params in checked.ops
              if entry == "batch:move"
              or (entry in _CREATES and params.get("as")))
    return list(dict.fromkeys(place.uid for place in places
                              if isinstance(place, _Existing)))


def _accepted(short: str, tool_input: Mapping[str, object]
              ) -> _Checked | None:
    """`_validate`'s result; None for input the preview refuses or cannot
    handle."""
    try:
        checked = _validate(short, tool_input)
    except Exception as exc:
        logger.warning("write targets of %s failed: %s", short,
                       type(exc).__name__)
        return None
    return None if isinstance(checked, Refusal) else checked


def _targets(short: str, tool_input: Mapping[str, object],
             entries: frozenset[str]) -> list[BlockUid]:
    """The uids the ops in `entries` name, first-seen and deduped; none for
    input the preview refuses or cannot handle."""
    checked = _accepted(short, tool_input)
    if checked is None:
        return []
    uids = (_target_uid(entry, validated) for entry, validated in checked.ops
            if entry in entries)
    return list(dict.fromkeys(uid for uid in uids if uid is not None))


def build_write_preview(short: str, tool_input: Mapping[str, object],
                        blocks: Mapping[BlockUid, StoredBlock]
                        ) -> WritePreview | Refusal:
    """The card for write tool `short` called with `tool_input`, given the
    `blocks` the shell read for `write_target_uids` and `ancestor_uids`,
    or why the call must be refused instead. An input the builder cannot
    handle (an outline nested past pydantic's depth limit, say) is refused
    too: raised out of `can_use_tool`, it would reach the SDK as a control
    error instead of a reason the model can act on."""
    try:
        out = _build(short, tool_input, blocks)
    except Exception as exc:
        # The type only: the message can quote the attacker's input.
        logger.warning("write preview of %s failed: %s", short,
                       type(exc).__name__)
        return Refusal(f"{short}: input could not be previewed")
    if isinstance(out, Refusal) and len(out.message) > REFUSAL_LIMIT_CHARS:
        return Refusal(out.message[:REFUSAL_LIMIT_CHARS]
                       + f"… ({len(out.message):,} characters)")
    return out


def _validate(short: str, tool_input: Mapping[str, object]
              ) -> _Checked | Refusal:
    """`tool_input` as write tool `short` receives it, or why the tool
    would not run it as sent: the one check both public functions make,
    so the blocks read are those of the call the card shows."""
    meta = _ARG_MODELS.get(short)
    if meta is None:
        return Refusal(f"{short} is not a write tool")
    unknown = _unknown_key(meta, tool_input)
    if unknown is not None:
        return Refusal(f"{short}: unknown argument {echo(unknown)}")
    try:
        model = meta.arg_model.model_validate(
            meta.pre_parse_json(dict(tool_input)))
    except ValidationError as exc:
        return Refusal(f"{short}: {_first_error(exc)}")
    validated = model.model_dump(mode="json", by_alias=True)
    if short != "batch":
        return _Checked(ops=[(short, validated)], aliases={})
    commands = validated["commands"]
    if not commands:
        return Refusal("batch: no commands to apply")
    if len(commands) > MAX_PREVIEW_OPS:
        return Refusal(f"batch: {len(commands)} commands; at most "
                       f"{MAX_PREVIEW_OPS} fit one batch, so split it")
    try:
        parsed = validate_batch(commands)
        aliases = batch_aliases(parsed)
    except BatchItemError as exc:
        return Refusal(f"batch item {exc.index}: {exc.problem}")
    return _Checked(
        ops=[(f"batch:{c.command}",
              c.params.model_dump(mode="json", by_alias=True))
             for c in parsed],
        aliases=aliases)


def _build(short: str, tool_input: Mapping[str, object],
           blocks: Mapping[BlockUid, StoredBlock]) -> WritePreview | Refusal:
    checked = _validate(short, tool_input)
    if isinstance(checked, Refusal):
        return checked
    moved_in = _moved_into_delete(checked.ops, blocks)
    if moved_in is not None:
        return moved_in
    ops = [_op(entry, validated, checked.aliases, blocks)
           for entry, validated in checked.ops]
    for i, op in enumerate(ops):
        problem = _limit_problem(op)
        if problem is not None:
            where = f"batch item {i}" if short == "batch" else short
            return Refusal(f"{where}: {problem}")
    size = sum(_card_size(op) for op in ops)
    if size > PREVIEW_LIMIT_CHARS:
        return Refusal(f"{short}: the card would hold {size:,} characters; "
                       "split the write into parts under "
                       f"{PREVIEW_LIMIT_CHARS:,}")
    if short == "batch":
        names = ", ".join(entry.removeprefix("batch:")
                          for entry, _ in checked.ops)
        return WritePreview(ops=ops,
                            summary=f"batch: {len(ops)} ops ({names})")
    (op,) = ops
    # Values ASCII-escaped: U+2028 and friends break lines in log viewers.
    shown = ", ".join(f"{json.dumps(k)}={json.dumps(v)}"
                      for k, v in op.targets)
    return WritePreview(ops=[op], summary=f"{short}: {shown}")
