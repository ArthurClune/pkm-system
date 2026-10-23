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

The tool functions come from `pkm.mcp.tools`, never `pkm.mcp.server`:
constructing the server's `FastMCP` configures the root logger and reads
`FASTMCP_*` settings, and the web server imports this module."""
from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from mcp.server.fastmcp.utilities.func_metadata import (FuncMetadata,
                                                        func_metadata)
from pydantic import ValidationError

from pkm.assistant.policy import WRITE_PREVIEW_FIELDS, WRITE_TOOLS
from pkm.batch import (BatchItemError, NestedItem, alias_name, nested_items,
                       validate_batch)
from pkm.mcp import tools as mcp_tools
from pkm.planning import parse_uid_spec

# The card sends every content value whole, so [show] can reveal all of
# it; a longer one is refused rather than approved partly unseen.
CONTENT_LIMIT_CHARS = 50_000


@dataclass(frozen=True)
class PreviewOp:
    action: str
    # JSON values, never clipped.
    targets: list[tuple[str, object]]
    # (key, text, its length in code points)
    content: list[tuple[str, str, int]]
    warnings: list[str]


@dataclass(frozen=True)
class WritePreview:
    ops: list[PreviewOp]
    # One line for logs and transcripts.
    summary: str


@dataclass(frozen=True)
class Refusal:
    message: str


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


def _parent_warning(entry: str, parent: object) -> list[str]:
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
        return [f"parent {_quoted(parent)} is the block created as "
                f"{_quoted(alias)} earlier in this batch: this lands under "
                "it, on that block's page, whatever the page row says (no "
                "such earlier block: nothing is written)"]
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


def _warnings(entry: str, validated: Mapping[str, Any]) -> list[str]:
    """Fixed text around JSON-quoted values, so no value can write the
    rest of a sentence."""
    out = _merge_warning(validated) if entry == "rename_page" else []
    out += _parent_warning(entry, validated.get("parent"))
    if entry in ("batch:update", "batch:move"):
        out += _missing_uid_warning(entry, validated.get("uid"))
    return out


def _op(entry: str, validated: Mapping[str, Any]) -> PreviewOp:
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
                     warnings=_warnings(entry, validated))


def _limit_problem(op: PreviewOp) -> str | None:
    """Why `op` is too large to preview, or None."""
    for key, _, total in op.content:
        if total > CONTENT_LIMIT_CHARS:
            return (f"{key} is {total} characters; split the write into "
                    f"parts under {CONTENT_LIMIT_CHARS}")
    return None


def _first_error(exc: ValidationError) -> str:
    first = exc.errors()[0]
    path = ".".join(str(p) for p in first["loc"])
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


def _batch_preview(commands: list[dict[str, object]]
                   ) -> WritePreview | Refusal:
    if not commands:
        return Refusal("batch: no commands to apply")
    try:
        parsed = validate_batch(commands)
    except BatchItemError as exc:
        return Refusal(f"batch item {exc.index}: {exc.problem}")
    ops: list[PreviewOp] = []
    names: list[str] = []
    for i, command in enumerate(parsed):
        op = _op(f"batch:{command.command}",
                 command.params.model_dump(mode="json", by_alias=True))
        problem = _limit_problem(op)
        if problem is not None:
            return Refusal(f"batch item {i}: {problem}")
        ops.append(op)
        names.append(command.command)
    return WritePreview(
        ops=ops, summary=f"batch: {len(ops)} ops ({', '.join(names)})")


def build_write_preview(short: str, tool_input: Mapping[str, object]
                        ) -> WritePreview | Refusal:
    """The card for write tool `short` called with `tool_input`, or why
    the call must be refused instead."""
    meta = _ARG_MODELS.get(short)
    if meta is None:
        return Refusal(f"{short} is not a write tool")
    unknown = _unknown_key(meta, tool_input)
    if unknown is not None:
        return Refusal(f"{short}: unknown argument {json.dumps(unknown)}")
    try:
        model = meta.arg_model.model_validate(
            meta.pre_parse_json(dict(tool_input)))
    except ValidationError as exc:
        return Refusal(f"{short}: {_first_error(exc)}")
    validated = model.model_dump(mode="json", by_alias=True)
    if short == "batch":
        return _batch_preview(validated["commands"])
    op = _op(short, validated)
    problem = _limit_problem(op)
    if problem is not None:
        return Refusal(f"{short}: {problem}")
    # Values ASCII-escaped: U+2028 and friends break lines in log viewers.
    shown = ", ".join(f"{json.dumps(k)}={json.dumps(v)}"
                      for k, v in op.targets)
    return WritePreview(ops=[op], summary=f"{short}: {shown}")
