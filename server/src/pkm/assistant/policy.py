# pattern: Functional Core
"""Tool-gate policy, model allowlist, tool summaries, the write-preview
table, and the system prompt."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Literal

from pkm.contracts.responses import AssistantModel

MCP_SERVER_NAME = "pkm"

READ_TOOLS: tuple[str, ...] = ("get_page", "get_block", "search", "query",
                               "backlinks", "todos", "changed_blocks",
                               "search_assets")
WRITE_TOOLS: tuple[str, ...] = ("save_note", "update_block", "batch",
                                "rename_page")
# Verbs `pkm-mcp` serves that the in-app assistant never gets: its MCP
# subprocess is started without them, and `classify_tool` calls them
# "unknown", so the permission gate denies them without a card.
# upload_asset reads a host path as the server's service account, so an
# approved call could upload the server's own secrets; the assistant has
# no files of its own to upload.
MCP_ONLY_TOOLS: tuple[str, ...] = ("upload_asset",)

# What the approval card shows for each write: action key -> (label,
# target keys in display order, content keys). A target says where a
# write lands or how destructive it is, and the card shows it in full,
# first; only content may be clipped. Batch ops are keyed `batch:<command>`
# and name params by their wire names (`uid`, `as`). A key not named here
# is shown as a target, so an unclassified argument is never clipped; a
# test fails when a tool or batch params model gains one.
WRITE_PREVIEW_FIELDS: dict[str, tuple[str, tuple[str, ...], tuple[str, ...]]] = {
    "save_note": ("save note", ("page", "parent", "todo"), ("text",)),
    "update_block": ("update block", ("uid", "mark"), ("text",)),
    "rename_page": ("rename page", ("title", "new_title", "allow_merge"), ()),
    "batch:create": ("create block", ("page", "parent", "index", "as"),
                     ("text",)),
    "batch:todo": ("create TODO", ("page", "parent", "index", "as"),
                   ("text",)),
    "batch:update": ("update block", ("uid",), ("text",)),
    "batch:move": ("move block", ("uid", "page", "parent", "index"), ()),
    "batch:delete": ("delete block", ("uid",), ()),
    "batch:outline": ("add outline", ("page", "parent"), ("items",)),
}

# The Claude models also exist as the web picker's fetch-failure fallback
# (useAssistant.ts); a rename or addition there must stay in sync.
MODELS: tuple[AssistantModel, ...] = ("sonnet", "opus", "haiku", "fable", "glm")

# Models that route to z.ai's Anthropic-compatible endpoint and are only
# offered when a z.ai key is configured. The Claude models need no such
# gate: they ride the machine's logged-in Claude subscription.
ZAI_MODELS: tuple[AssistantModel, ...] = ("glm",)

_MAX_VALUE_CHARS = 120


def mcp_tool_name(short: str) -> str:
    return f"mcp__{MCP_SERVER_NAME}__{short}"


def read_tool_names() -> list[str]:
    return [mcp_tool_name(t) for t in READ_TOOLS]


def all_tool_names() -> list[str]:
    """The full read+write tool set. No production caller: `claude_engine`
    passes `read_tool_names()` for `allowed_tools` and gates writes at
    confirm-time by `classify_tool`, never by an explicit write allowlist.
    This function exists so `test_tool_names_namespaced`'s count assertion
    has something to call -- it is a tripwire that fails loudly if a tool is
    added to READ_TOOLS/WRITE_TOOLS without updating that count. Keep it,
    even though nothing in `src/` imports it."""
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


def available_models(*, zai_configured: bool) -> list[AssistantModel]:
    if zai_configured:
        return list(MODELS)
    return [m for m in MODELS if m not in ZAI_MODELS]


def default_model(available: Sequence[AssistantModel]) -> AssistantModel:
    """glm when it is servable, else sonnet. The default depends
    on availability because glm rides a z.ai key: a keyless deployment must
    fall back rather than reject every default-model create."""
    return "glm" if "glm" in available else "sonnet"


def resolve_model(name: str) -> AssistantModel:
    if name not in MODELS:
        raise ValueError(f"unknown model {name!r}; expected one of {', '.join(MODELS)}")
    return name


def _clip(value: object, limit: int = _MAX_VALUE_CHARS) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text


_SUMMARY_KEYS: dict[str, tuple[str, str]] = {
    # short tool name -> (format, input key)
    "search": ('searching "{}"', "q"),
    "query": ('querying "{}"', "q"),
    "get_page": ('reading page "{}"', "title"),
    "backlinks": ('backlinks for "{}"', "title"),
    "get_block": ("reading block {}", "uid"),
}


def tool_summary(short: str, tool_input: Mapping[str, object]) -> str:
    if short == "todos":
        return "listing TODOs"
    if short == "changed_blocks":
        since = tool_input.get("since")
        return f"listing changes since {_clip(since)}" if since else short
    entry = _SUMMARY_KEYS.get(short)
    if entry is not None:
        fmt, key = entry
        value = tool_input.get(key)
        if value:
            return fmt.format(_clip(value))
    return short


SYSTEM_PROMPT = """\
You are the assistant embedded in the user's personal knowledge base (PKM).
Your only tools are the PKM verbs exposed over MCP; you have no shell,
filesystem, or web access.

Retrieval questions ("what have I written about X", "who did I meet"):
- Loop: search -> get_page -> backlinks. Backlinks (not search) usually
  answer "who/when" questions; daily notes are pages titled like
  "July 26th, 2026".
- Quote or reference the notes you used, with their page titles.
- "What did I add or change yesterday / this week": changed_blocks with
  a since/until window. It keeps only each block's latest edit time and
  cannot see deleted blocks; say so when the answer depends on it.

Editing and reorganisation ("tidy this page", "merge these notes"):
- Read the page first with get_page; blocks carry uids.
- Propose changes concisely, then apply them with the write verbs
  (save_note, update_block, batch, rename_page).
- Every write pauses for the user to confirm in the UI. If the user
  declines a write, do not retry it; ask what they want instead.

Citing (the UI turns these into clickable links; plain names are inert):
- Mention an asset (image, PDF, ...) by its full /assets/<sha256>/<filename>
  URL exactly as search_assets returned it, even in list-style answers —
  never by filename alone.
- Point at a specific block by citing its uid as ((uid)). Tool output
  marks blocks with a trailing ^uid; the uid is the part AFTER the caret.
  Write ((abc123)), never ((^abc123)) — a caret inside (( )) breaks the
  link.

Local copy links (a "Local copy:: pkm/Papers/a b.pdf" property is plain text
until converted):
- Target form: Local copy:: [<filename>](/api/local/<path>). The link text
  is the bare filename (last path segment), unencoded.
- <path> is relative to the local documents folder: drop any leading
  iCloud/Documents/ and pkm/, which name that folder itself.
- Percent-encode each path segment but keep the / separators: every
  character except letters, digits and _ . - ~ becomes %XX in UTF-8. So a
  space is %20, and ' ( ) & # % and non-ASCII characters are encoded too (a
  raw ")" would end the link early).
- Example: Local copy:: pkm/Papers/Machine Learning/complex paper.pdf
  becomes
  Local copy:: [complex paper.pdf](/api/local/Papers/Machine%20Learning/complex%20paper.pdf)

Tables:
- Markdown pipe tables (| a | b |) render nowhere — not in this chat, not
  in notes; they show as literal pipes. In answers, give tabular results
  as a list instead.
- To put a table in a note, write the {{table}} macro. Its columns are
  nesting: the macro block's text is exactly {{table}}; each direct child
  is a row, the first row is the header; a row's cells are a chain of
  single children, one level deeper per column. Every cell but the last
  in its row has exactly ONE child — a second child anywhere turns the
  whole table back into a plain outline. With save_note:
    {{table}}
      Tool
        Licence
      ripgrep
        MIT
      fd
        Apache-2.0
- Blank lines are dropped, so an empty interior cell shifts the rest of
  its row left; put a placeholder such as "-" in it.
- For wide tables, offer the alternative too: one block per row with
  "Attribute:: value" children.

Style: answer in plain markdown (no pipe tables), be brief, never invent page titles or
uids — always look them up first.
"""
