# pattern: Functional Core
"""What the approval card shows before an assistant write runs.

The card is the only thing between a prompt-injected model and a write
to the user's notes, so it previews what the tool will receive, not what
the model sent: each write tool's own FastMCP argument model parses the
input first (FastMCP JSON-decodes every non-`str` argument, so
`page: "null"` arrives as None and `allow_merge: "yes"` as True), and a
batch's commands go through the same schema `apply_batch` applies. Input
neither accepts is refused rather than previewed.

Importing `pkm.mcp.server` builds its `FastMCP` but does no I/O; this
module reads only the tool functions' signatures."""
from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from mcp.server.fastmcp.utilities.func_metadata import (FuncMetadata,
                                                        func_metadata)
from pydantic import ValidationError

from pkm.assistant.policy import WRITE_PREVIEW_FIELDS, WRITE_TOOLS
from pkm.batch import (BATCH_COMMAND_ADAPTER, NestedItem, command_problem,
                       nested_items)
from pkm.mcp import server as mcp_server

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
    name: func_metadata(getattr(mcp_server, name)) for name in WRITE_TOOLS}


def _outline_text(items: list[NestedItem]) -> str:
    return "\n".join("  " * depth + text
                     for depth, text in nested_items(items))


def _content_text(key: str, value: object) -> str:
    if key == "items" and isinstance(value, list):
        return _outline_text(value)
    return value if isinstance(value, str) else json.dumps(value)


def _op(entry: str, validated: Mapping[str, Any],
        raw: Mapping[str, object],
        extra: list[tuple[str, object]]) -> PreviewOp:
    """One card entry: the table's targets with their validated values,
    then every raw key the table does not name (`extra` adds the keys a
    batch's envelope carries beside `commands`), then the content. A
    content value of None is an absent argument and is left out."""
    label, target_keys, content_keys = WRITE_PREVIEW_FIELDS[entry]
    named = set(target_keys) | set(content_keys)
    targets: list[tuple[str, object]] = [
        (k, validated.get(k)) for k in target_keys]
    targets += [(k, v) for k, v in raw.items() if k not in named]
    targets += extra
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
            f'allow_merge is on: if "{validated["new_title"]}" exists, '
            f'"{validated["title"]}" is merged into it (irreversible)')
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
    ops: list[PreviewOp] = []
    names: list[str] = []
    for i, item in enumerate(commands):
        try:
            parsed = BATCH_COMMAND_ADAPTER.validate_python(item)
        except ValidationError as exc:
            return Refusal(f"batch item {i}: {command_problem(exc)}")
        raw_params = item.get("params")
        assert isinstance(raw_params, dict)  # the schema demands an object
        ops.append(_op(f"batch:{parsed.command}",
                       parsed.params.model_dump(mode="json", by_alias=True),
                       raw_params, extra))
        names.append(parsed.command)
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
    validated = model.model_dump(mode="json")
    if short == "batch":
        extra = [(k, v) for k, v in tool_input.items() if k != "commands"]
        return _batch_preview(validated["commands"], extra)
    op = _op(short, validated, tool_input, [])
    shown = ", ".join(f"{k}={json.dumps(v, ensure_ascii=False)}"
                      for k, v in op.targets)
    return WritePreview(ops=[op], summary=f"{short}: {shown}")
