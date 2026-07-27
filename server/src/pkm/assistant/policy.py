# pattern: Functional Core
"""Tool-gate policy, model allowlist, previews, and the system prompt."""

from __future__ import annotations

import json
from typing import Literal

MCP_SERVER_NAME = "pkm"

READ_TOOLS: tuple[str, ...] = ("get_page", "get_block", "search", "query", "backlinks", "todos")
WRITE_TOOLS: tuple[str, ...] = ("save_note", "update_block", "batch", "upload_asset")

MODELS: tuple[str, ...] = ("sonnet", "opus", "haiku")
DEFAULT_MODEL = "sonnet"

_MAX_VALUE_CHARS = 120

# ops_preview (pkm-c98s item 6) is what the user reads before approving a
# write, not the transient "tool is running" indicator -- it must show
# (almost) everything, clipping only pathologically long values (e.g. a
# save_note with megabytes of pasted text) so the approval UI stays
# bounded. See docs/SECURITY.md's "Embedded assistant" section.
_MAX_PREVIEW_VALUE_CHARS = 4000


def mcp_tool_name(short: str) -> str:
    return f"mcp__{MCP_SERVER_NAME}__{short}"


def read_tool_names() -> list[str]:
    return [mcp_tool_name(t) for t in READ_TOOLS]


def all_tool_names() -> list[str]:
    return [mcp_tool_name(t) for t in READ_TOOLS + WRITE_TOOLS]


def short_tool_name(full_name: str) -> str:
    prefix = f"mcp__{MCP_SERVER_NAME}__"
    return full_name.removeprefix(prefix)


def classify_tool(full_name: str) -> Literal["read", "write", "unknown"]:
    short = short_tool_name(full_name)
    if short == full_name:  # prefix absent: not one of ours
        return "unknown"
    if short in READ_TOOLS:
        return "read"
    if short in WRITE_TOOLS:
        return "write"
    return "unknown"


def resolve_model(name: str | None) -> str:
    if name is None:
        return DEFAULT_MODEL
    if name not in MODELS:
        raise ValueError(f"unknown model {name!r}; expected one of {', '.join(MODELS)}")
    return name


def _clip(value: object, limit: int = _MAX_VALUE_CHARS) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text


def _clip_preview(value: object) -> str:
    return _clip(value, limit=_MAX_PREVIEW_VALUE_CHARS)


_SUMMARY_KEYS: dict[str, tuple[str, str]] = {
    # short tool name -> (format, input key)
    "search": ('searching "{}"', "q"),
    "query": ('querying "{}"', "q"),
    "get_page": ('reading page "{}"', "title"),
    "backlinks": ('backlinks for "{}"', "title"),
    "get_block": ("reading block {}", "uid"),
}


def tool_summary(short: str, tool_input: dict) -> str:
    if short == "todos":
        return "listing TODOs"
    entry = _SUMMARY_KEYS.get(short)
    if entry is not None:
        fmt, key = entry
        value = tool_input.get(key)
        if value:
            return fmt.format(_clip(value))
    return short


def ops_preview(short: str, tool_input: dict) -> str:
    if short == "batch":
        ops = tool_input.get("ops") or []
        lines = [f"batch: {len(ops)} operation(s)"]
        lines += [f"  {i + 1}. {_clip_preview(op)}" for i, op in enumerate(ops)]
        return "\n".join(lines)
    args = ", ".join(f"{k}={_clip_preview(v)}" for k, v in tool_input.items())
    return f"{short}({args})"


SYSTEM_PROMPT = """\
You are the assistant embedded in the user's personal knowledge base (PKM).
Your only tools are the ten PKM verbs exposed over MCP; you have no shell,
filesystem, or web access.

Retrieval questions ("what have I written about X", "who did I meet"):
- Loop: search -> get_page -> backlinks. Backlinks (not search) usually
  answer "who/when" questions; daily notes are pages titled like
  "July 26th, 2026".
- Quote or reference the notes you used, with their page titles.

Editing and reorganisation ("tidy this page", "merge these notes"):
- Read the page first with get_page; blocks carry uids.
- Propose changes concisely, then apply them with the write verbs
  (save_note, update_block, batch, upload_asset).
- Every write pauses for the user to confirm in the UI. If the user
  declines a write, do not retry it; ask what they want instead.

Style: answer in plain markdown, be brief, never invent page titles or
uids — always look them up first.
"""
