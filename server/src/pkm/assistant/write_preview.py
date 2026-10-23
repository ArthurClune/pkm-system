# pattern: Functional Core
"""What the approval card shows before an assistant write runs.

The card is the only thing between a prompt-injected model and a write
to the user's notes, so it previews what the tool will receive, not what
the model sent: each write tool's own FastMCP argument model parses the
input first (FastMCP JSON-decodes every non-`str` argument, so
`page: "null"` arrives as None and `allow_merge: "yes"` as True), and a
batch's commands go through the same schema `apply_batch` applies. Input
neither accepts is refused rather than previewed.

The tool functions come from `pkm.mcp.tools`, never `pkm.mcp.server`:
constructing the server's `FastMCP` configures the root logger and reads
`FASTMCP_*` settings, and the web server imports this module."""
from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from mcp.server.fastmcp.utilities.func_metadata import (FuncMetadata,
                                                        func_metadata)
from pydantic import ValidationError

from pkm.assistant.policy import WRITE_PREVIEW_FIELDS, WRITE_TOOLS
from pkm.batch import (BatchItemError, NestedItem, nested_items,
                       validate_batch)
from pkm.mcp import tools as mcp_tools

CONTENT_CLIP_CHARS = 2000


@dataclass(frozen=True)
class PreviewOp:
    action: str
    # JSON values, never clipped.
    targets: list[tuple[str, object]]
    # (key, text clipped to CONTENT_CLIP_CHARS, unclipped length)
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


def _op(entry: str, validated: Mapping[str, Any],
        raw: Mapping[str, object],
        extra: list[tuple[str, object]]) -> PreviewOp:
    """One card entry: the table's targets with their validated values,
    then every raw key the table does not name (`extra` adds the keys a
    batch's envelope carries beside `commands`), then the content. A
    content value of None is an absent argument and is left out. Raw
    values are deep-copied, so the card is a snapshot of the input."""
    label, target_keys, content_keys = WRITE_PREVIEW_FIELDS[entry]
    named = set(target_keys) | set(content_keys)
    targets: list[tuple[str, object]] = [
        (k, validated.get(k)) for k in target_keys]
    targets += [(k, v) for k, v in raw.items() if k not in named]
    targets += extra
    targets = copy.deepcopy(targets)
    content: list[tuple[str, str, int]] = []
    for key in content_keys:
        value = validated.get(key)
        if value is None:
            continue
        text = _content_text(key, value)
        content.append((key, text[:CONTENT_CLIP_CHARS], len(text)))
    warnings: list[str] = []
    if entry == "rename_page" and validated.get("allow_merge") is True:
        warnings.append(
            f'allow_merge is on: if {_quoted(validated["new_title"])} '
            f'exists, {_quoted(validated["title"])} is merged into it '
            '(irreversible)')
    return PreviewOp(action=label, targets=targets, content=content,
                     warnings=warnings)


def _first_error(exc: ValidationError) -> str:
    first = exc.errors()[0]
    path = ".".join(str(p) for p in first["loc"])
    return f"{path}: {first['msg']}" if path else first["msg"]


def _batch_preview(commands: list[dict[str, object]],
                   extra: list[tuple[str, object]]) -> WritePreview | Refusal:
    if not commands:
        return Refusal("batch: no commands to apply")
    try:
        parsed = validate_batch(commands)
    except BatchItemError as exc:
        return Refusal(f"batch item {exc.index}: {exc.problem}")
    ops: list[PreviewOp] = []
    names: list[str] = []
    for i, (item, command) in enumerate(zip(commands, parsed)):
        raw_params = item.get("params")
        if not isinstance(raw_params, dict):
            return Refusal(f"batch item {i}: params: expected an object")
        ops.append(_op(f"batch:{command.command}",
                       command.params.model_dump(mode="json", by_alias=True),
                       raw_params, extra))
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
    try:
        model = meta.arg_model.model_validate(
            meta.pre_parse_json(dict(tool_input)))
    except ValidationError as exc:
        return Refusal(f"{short}: {_first_error(exc)}")
    validated = model.model_dump(mode="json", by_alias=True)
    if short == "batch":
        extra = [(k, v) for k, v in tool_input.items() if k != "commands"]
        return _batch_preview(validated["commands"], extra)
    op = _op(short, validated, tool_input, [])
    # Keys and values ASCII-escaped: an unknown key is the model's to
    # choose, and U+2028 and friends break lines in log viewers too.
    shown = ", ".join(f"{json.dumps(k)}={json.dumps(v)}"
                      for k, v in op.targets)
    return WritePreview(ops=[op], summary=f"{short}: {shown}")
