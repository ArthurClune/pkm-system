# pattern: Functional Core
"""Plan CLI/MCP writes as /api/ops op dicts. Pure: page payloads and a uid
iterator come in, op dicts come out. The shell fetches pages, generates
uids, and posts the result."""
from __future__ import annotations

import re
from collections.abc import Iterator

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
            if n["text"] == text:
                return n["uid"], None
        return None, (level, text)
    raise BuildError(
        f"unrecognized parent spec: {spec!r} "
        '(use "((uid))" or "## Heading")'
    )


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
    block doesn't exist in the payload)."""

    def __init__(self, uids: Iterator[str]):
        self._uids = uids
        self._next_idx: dict[tuple[str, str | None], int] = {}

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
                in_batch: frozenset[str] = frozenset()) -> list[dict]:
        """Plan creates for `items` (depth, text) pairs under `parent_spec`.
        Resolves the parent spec first (handling in-batch alias uids, which
        `resolve_parent` can't see since they aren't in the payload), then
        walks the outline maintaining a depth->uid stack so nested items
        attach to the most recently created ancestor at the right depth.
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
            uid = self.next_uid()
            ops.append(_create(uid, page, None,
                               self.bump(payload, page, None, in_batch),
                               text, level))
            created.add(uid)
            parent = uid
        stack: list[str | None] = [parent]
        for depth, text in items:
            del stack[depth + 1:]
            target = stack[depth]
            if todo and depth == 0:
                text = with_state(text, "TODO")
            uid = self.next_uid()
            idx = self.bump(payload, page, target, in_batch | frozenset(created))
            ops.append(_create(uid, page, target, idx, text))
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
    out: list[tuple[int, str]] = []
    for item in items:
        if isinstance(item, str):
            out.append((depth, item))
        elif isinstance(item, list):
            out.extend(_nested_items(item, depth + 1))
        else:
            raise BuildError(
                f"outline items must be strings or lists, got {type(item).__name__}"
            )
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


def plan_batch(commands: list[dict], pages: dict[str, dict],
               uids: Iterator[str]) -> list[dict]:
    """Translate a batch of `{command, params}` items into one op list.

    `create`/`todo` accept an `as` alias so later commands in the same
    batch can reference the block just created via `parent: "{{alias}}"`.
    Those in-batch uids are tracked in `created` and threaded through as
    `_Planner.creates`'s `in_batch` set, since they don't exist on the
    fetched page payloads that `resolve_parent`/`next_child_idx` consult.
    """
    planner = _Planner(uids)
    aliases: dict[str, str] = {}
    created: set[str] = set()
    ops: list[dict] = []

    def _page(params: dict) -> tuple[str, dict]:
        title = params.get("page")
        if not title:
            raise BuildError("command needs a 'page' param")
        if title not in pages:
            raise BuildError(f"page not fetched: {title}")
        return title, pages[title]

    for cmd in commands:
        name, params = cmd.get("command"), cmd.get("params", {})
        if name in ("create", "todo"):
            title, payload = _page(params)
            spec = _resolve_alias(params.get("parent"), aliases)
            new = planner.creates(payload, title, spec,
                                  [(0, params["text"])],
                                  todo=(name == "todo"),
                                  in_batch=frozenset(created))
            ops.extend(new)
            created.update(o["uid"] for o in new)
            if params.get("as"):
                aliases[params["as"]] = new[-1]["uid"]
        elif name == "outline":
            title, payload = _page(params)
            items = _nested_items(params.get("items", []))
            if not items:
                raise BuildError("outline needs non-empty 'items'")
            new = planner.creates(payload, title,
                                  _resolve_alias(params.get("parent"), aliases),
                                  items, todo=False,
                                  in_batch=frozenset(created))
            ops.extend(new)
            created.update(o["uid"] for o in new)
        elif name == "update":
            ops.append({"op": "update_text", "uid": params["uid"],
                        "text": params["text"]})
        elif name == "move":
            title, payload = _page(params)
            spec = _resolve_alias(params.get("parent"), aliases)
            m = _UID_SPEC.match(spec) if spec else None
            if m and m.group(1) in created:
                parent: str | None = m.group(1)
            else:
                parent, missing = resolve_parent(payload, spec)
                if missing is not None:
                    raise BuildError("move target heading does not exist")
            idx = params.get("index")
            if idx is None:
                idx = planner.bump(payload, title, parent, frozenset(created))
            ops.append({"op": "move", "uid": params["uid"],
                        "parent_uid": parent, "order_idx": idx,
                        "page_title": None if parent else title})
        elif name == "delete":
            ops.append({"op": "delete", "uid": params["uid"]})
        else:
            raise BuildError(f"unknown command: {name!r}")
    return ops


__all__ = [
    "BuildError", "parse_outline", "next_child_idx", "resolve_parent",
    "plan_save", "referenced_pages", "plan_batch",
]
