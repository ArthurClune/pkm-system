# pattern: Functional Core
"""A reference model of what `POST /api/ops` does to the blocks a property
test generates, written from the architecture docs rather than from the
server: an independent second implementation the state machine checks the
real server against. It must never import `pkm.server.*` or
`pkm.planning` (a test pins that), or it would agree with the server by
construction.

The rules come from backend.md § The write path (Ordering), § Conflicts,
§ Missing targets and § Concurrent structure edits, and sync-and-offline.md
§ Conflicts at push time. Each rule below names the row it encodes. Where
the docs are silent the rule follows the code, and says so.

Ops are plain dicts in the wire shape of `pkm.contracts.ops`. The model
tracks only the blocks the ops address; the conflict headers and copies
the server writes on today's daily page are represented by
`Outcome.kept_texts`, not as blocks."""
from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
import re
from dataclasses import dataclass, replace
from typing import Any

from pkm.contracts.ops import UID_RE, subtree_hash, text_hash
from pkm.refs import extract, is_blank_title, title_syntax_reason

# What a whitespace-only page_title resolves to: the ops path never rejects
# a batch over a blank title (code: ops_apply.UNTITLED_PAGE_TITLE).
UNTITLED = "Untitled"

Op = Mapping[str, Any]
SkipEntry = tuple[int, str, str, str]
# Records the current op as skipped, with the given reason.
SkipFn = Callable[[str], None]


@dataclass(frozen=True)
class MBlock:
    uid: str
    page: str
    parent: str | None
    order_idx: int
    text: str
    heading: int | None
    collapsed: bool
    view_type: str | None


@dataclass(frozen=True)
class Outcome:
    """What a batch does, as the client sees it. `skipped` mirrors the ack's
    `skipped` entries as `(index, op, uid, reason)`. `kept_texts` are texts
    the conflict rules say must now exist under a `[[conflict]]` header on
    today's daily page: a losing text, an orphaned edit, a diverted create's
    text, a diverged delete's subtree. The notes a skipped structural op
    lands (`move skipped: ...`) are not listed: they are messages, not text
    a user wrote."""
    status: int
    skipped: tuple[SkipEntry, ...] = ()
    kept_texts: tuple[str, ...] = ()


class _Rejected(Exception):
    """The batch is a 400: nothing in it applies."""


def _valid_uid(uid: str) -> bool:
    return UID_RE.fullmatch(uid) is not None


def _title_violation(ops: Sequence[Op]) -> bool:
    """backend.md § Missing targets: "title syntax" is still a 400. Checked
    over the whole batch before any op applies: a create's, create_page's or
    move's page_title (even one a live parent makes the server ignore), and
    every `[[ref]]`/`#tag` title in a create's or edit's text. An edit's
    page_title is only a header label and is never checked (§ Conflicts)."""
    for op in ops:
        kind = op["op"]
        title = op.get("page_title") if kind in ("create", "create_page",
                                                  "move") else None
        if title is not None and title_syntax_reason(title) is not None:
            return True
        if kind in ("create", "update_text"):
            if any(title_syntax_reason(ref.title) is not None
                   for ref in extract(op["text"]).refs):
                return True
    return False


def _page_name(title: str) -> str:
    return UNTITLED if is_blank_title(title) else title


class Model:
    """The pool blocks as the server should hold them. `deleted` is every
    uid an op removed and nothing has re-created since; strategies draw
    "deleted" targets from it."""

    def __init__(self) -> None:
        self.blocks: dict[str, MBlock] = {}
        self.pages: set[str] = set()
        self.deleted: set[str] = set()

    @classmethod
    def from_rows(cls, pages: Iterable[str], rows: Iterable[MBlock]) -> Model:
        m = cls()
        m.pages = set(pages)
        for row in rows:
            m.blocks[row.uid] = row
            m.pages.add(row.page)
        return m

    def snapshot(self) -> dict[str, MBlock]:
        return dict(self.blocks)

    def apply(self, ops: Sequence[Op]) -> Outcome:
        """Apply one batch atomically: a 400 leaves the model unchanged
        (backend.md § The write path: one transaction per batch)."""
        saved = (dict(self.blocks), set(self.pages), set(self.deleted))
        skipped: list[SkipEntry] = []
        kept: list[str] = []
        try:
            if _title_violation(ops):
                raise _Rejected
            for index, op in enumerate(ops):
                self._apply_op(index, op, skipped, kept)
        except _Rejected:
            self.blocks, self.pages, self.deleted = saved
            return Outcome(400)
        return Outcome(200, tuple(skipped), tuple(kept))

    # --- tree helpers -------------------------------------------------------

    def _children(self, uid: str) -> list[MBlock]:
        return sorted((b for b in self.blocks.values() if b.parent == uid),
                      key=lambda b: (b.order_idx, b.uid))

    def subtree(self, uid: str) -> list[str]:
        """uid and its descendants, pre-order, siblings by (order_idx, uid):
        the order the server copies a diverged delete's rows in."""
        out = [uid]
        for child in self._children(uid):
            out.extend(self.subtree(child.uid))
        return out

    def _chain(self, uid: str) -> list[str]:
        """uid and every ancestor above it."""
        out: list[str] = []
        cur: str | None = uid
        while cur is not None and cur not in out:
            out.append(cur)
            cur = self.blocks[cur].parent
        return out

    def _shift(self, page: str, parent: str | None, key: int,
               moving: str | None = None) -> None:
        """backend.md § The write path, Ordering: landing at `key` first
        bumps every sibling (same page, same parent) whose key is >= `key`
        by one. A moving block is left out of its own shift: its key is
        overwritten when it lands, so only its siblings move."""
        for b in list(self.blocks.values()):
            if (b.page == page and b.parent == parent and b.order_idx >= key
                    and b.uid != moving):
                self.blocks[b.uid] = replace(b, order_idx=b.order_idx + 1)

    # --- ops ----------------------------------------------------------------

    def _apply_op(self, index: int, op: Op, skipped: list[SkipEntry],
                  kept: list[str]) -> None:
        kind = op["op"]
        if kind == "create_page":
            # backend.md § The write path: create_page idempotently ensures
            # a page exists.
            self.pages.add(_page_name(op["page_title"]))
            return
        uid = op["uid"]

        def skip(reason: str) -> None:
            skipped.append((index, kind, uid, reason))

        if kind == "create":
            self._create(op, uid, skip, kept)
            return
        block = self.blocks.get(uid)
        if block is None:
            # backend.md § Missing targets: a skipped op whose uid fails
            # UID_RE is still a 400.
            if not _valid_uid(uid):
                raise _Rejected
            # § Missing targets, every block-gone row reports
            # block_not_found. Rows `set_collapsed`/`delete`: a no-op, which
            # (code, not docs) the ack still lists (ops_core.skip_report).
            # Row `move`/`set_heading`/`set_view_type`: skipped; such a
            # move's parent uid is never shape-checked (code:
            # ops_core.impossible_uid_reason).
            skip("block_not_found")
            # § Missing targets, row `update_text`, block gone, hashed or
            # not: the text lands; a blank text lands nothing.
            if kind == "update_text" and op["text"].strip():
                kept.append(op["text"])
            return
        if kind == "update_text":
            self._update_text(op, block, kept)
        elif kind == "move":
            self._move(op, block, skip)
        elif kind == "delete":
            self._delete(op, uid, kept)
        elif kind == "set_collapsed":
            self.blocks[uid] = replace(block, collapsed=bool(op["collapsed"]))
        elif kind == "set_heading":
            self.blocks[uid] = replace(block, heading=op.get("heading"))
        elif kind == "set_view_type":
            self.blocks[uid] = replace(block, view_type=op["view_type"])
        else:
            raise AssertionError(f"unknown op kind: {kind}")

    def _create(self, op: Op, uid: str, skip: SkipFn, kept: list[str]) -> None:
        # backend.md § Missing targets: an invalid uid is a 400 -- for a
        # create, checked before anything else.
        if not _valid_uid(uid):
            raise _Rejected
        parent = op.get("parent_uid")
        exists = uid in self.blocks
        if not exists and parent is not None and parent not in self.blocks:
            # § Missing targets, row `create`, parent gone: not created; its
            # text lands, a blank text lands nothing. A parent uid failing
            # UID_RE is a 400 instead.
            if not _valid_uid(parent):
                raise _Rejected
            skip("parent_not_found")
            if op["text"].strip():
                kept.append(op["text"])
            return
        # § Missing targets: "uid already exists" is a 400.
        if exists:
            raise _Rejected
        if parent is not None:
            # § Concurrent structure edits, row `create` under a live parent
            # on another page: created on the parent's page; page_title is
            # ignored and creates no page.
            page = self.blocks[parent].page
        else:
            # § The write path: page_title places (and may create) the page
            # of a top-level create.
            page = _page_name(op["page_title"])
            self.pages.add(page)
        key = op["order_idx"]
        self._shift(page, parent, key)
        # Code, not docs: a create keeps its heading and view_type, and
        # starts uncollapsed (ops_core.plan_op's InsertBlock).
        self.blocks[uid] = MBlock(
            uid=uid, page=page,
            parent=parent, order_idx=key, text=op["text"],
            heading=op.get("heading"), collapsed=False,
            view_type=op.get("view_type"))
        self.deleted.discard(uid)

    def _update_text(self, op: Op, block: MBlock, kept: list[str]) -> None:
        text = op["text"]
        base = op.get("base_text_hash")
        if base is None:
            # sync-and-offline.md § Conflicts at push time, row "No hash
            # sent, block exists": unconditional last-write-wins.
            self.blocks[block.uid] = replace(block, text=text)
            return
        if text == block.text:
            # Row "Incoming text equals current": no-op, whatever the hash.
            # Code, not docs: this is tested before the hash, so an
            # identical edit with a stale hash keeps nothing
            # (ops_core.classify_text_edit).
            return
        if text_hash(block.text) != base:
            # Row "Hashes differ" / backend.md § Conflicts, header row
            # "Block still exists (mismatch)": incoming wins, the overwritten
            # text is kept.
            kept.append(block.text)
        # Row "hash(current) == base_text_hash": clean apply.
        self.blocks[block.uid] = replace(block, text=text)

    def _move(self, op: Op, block: MBlock, skip: SkipFn) -> None:
        parent = op.get("parent_uid")
        key = op["order_idx"]
        if parent is not None:
            if parent not in self.blocks:
                # § Missing targets, row `move`, block exists, parent gone:
                # the block stays put. An invalid parent uid is a 400.
                if not _valid_uid(parent):
                    raise _Rejected
                skip("parent_not_found")
                return
            if block.uid in self._chain(parent):
                # § Concurrent structure edits, row `move` whose target is
                # the block or its descendant: skipped as a cycle.
                skip("cycle")
                return
            # § Concurrent structure edits, row `move` under a parent no
            # longer on page_title's page: lands on the parent's page.
            page = self.blocks[parent].page
        else:
            # § The write path: page_title places a top-level move; absent,
            # the block stays on its page.
            title = op.get("page_title")
            page = _page_name(title) if title is not None else block.page
            self.pages.add(page)
        # § The write path, Ordering: shift the destination's siblings at or
        # after the key, then place the block. Its old group is left with a
        # gap: nothing renumbers.
        self._shift(page, parent, key, moving=block.uid)
        subtree = self.subtree(block.uid)
        self.blocks[block.uid] = replace(block, parent=parent,
                                         order_idx=key)
        if page != block.page:
            # § The write path: a cross-page move re-pages the whole subtree.
            for u in subtree:
                self.blocks[u] = replace(self.blocks[u], page=page)

    def _delete(self, op: Op, uid: str, kept: list[str]) -> None:
        subtree = self.subtree(uid)
        base = op.get("base_subtree_hash")
        if base is not None and subtree_hash(
                (u, self.blocks[u].text) for u in subtree) != base:
            # backend.md § Conflicts, guarded delete / sync-and-offline.md
            # row "`delete` whose subtree another device changed": the
            # delete wins, but every text of the subtree is kept first. A
            # matching or hashless delete keeps nothing.
            kept.extend(self.blocks[u].text for u in subtree)
        # § The write path: delete removes a block and its subtree.
        for u in subtree:
            del self.blocks[u]
            self.deleted.add(u)


# --- `pkm batch` positions ---------------------------------------------------

_UID_SPEC = re.compile(r"^\(\((.+)\)\)$")
_ALIAS_SPEC = re.compile(r"^\{\{(.+)\}\}$")

Groups = dict[str | None, list[str]]


def positions_after(groups: Mapping[str | None, Sequence[str]],
                    commands: Sequence[Mapping[str, Any]],
                    new_uids: Iterator[str]) -> Groups:
    """Each parent's children, in order, after the `pkm batch` `commands`
    run over `groups` (parent uid -> child uids, None for the page's top
    level). Positions only, never order keys: this is the CLI contract the
    planner's keys must realise (cli-and-mcp.md, the batch `index` row).

    - create/todo: lands at `index` among the parent's children as the
      earlier commands left them; None, or an index past the end, appends.
      Each mints the next of `new_uids`, in command order; `as` names it
      for a later `{{alias}}`.
    - move: the block leaves its group first, then lands at `index` among
      the destination's children without it; None or past the end appends.
      Its subtree comes with it.
    - delete: removes the block and its subtree.
    - update: no change of place.

    A command whose block or parent is not in `groups` changes nothing (a
    create still spends its uid), and a move into the block itself or its
    own subtree is left undone: backend.md § Missing targets and
    § Concurrent structure edits, which the server reports as skips. Parent
    specs are `((uid))` or `{{alias}}`; a `## Heading` spec, which the
    planner would create, and `outline` are not modelled and raise.
    The input is not mutated."""
    out: Groups = {k: list(v) for k, v in groups.items()}
    aliases: dict[str, str] = {}

    def parent_of(uid: str) -> tuple[bool, str | None]:
        for parent, kids in out.items():
            if uid in kids:
                return True, parent
        return False, None

    def subtree(uid: str) -> list[str]:
        found = [uid]
        for kid in out.get(uid, []):
            found.extend(subtree(kid))
        return found

    def named(value: str) -> str:
        m = _ALIAS_SPEC.match(value)
        return aliases[m.group(1)] if m else value

    def parent_spec(spec: str | None) -> str | None:
        if spec is None:
            return None
        m = _UID_SPEC.match(spec)
        if m:
            return m.group(1)
        if _ALIAS_SPEC.match(spec):
            return named(spec)
        raise ValueError(f"parent spec not modelled: {spec!r}")

    def live(uid: str | None) -> bool:
        return uid is None or parent_of(uid)[0]

    def land(parent: str | None, uid: str, index: int | None) -> None:
        group = out.setdefault(parent, [])
        group.insert(len(group) if index is None else min(index, len(group)),
                     uid)

    for command in commands:
        kind, params = command["command"], command["params"]
        if kind in ("create", "todo"):
            uid = next(new_uids)
            if params.get("as"):
                aliases[params["as"]] = uid
            parent = parent_spec(params.get("parent"))
            if live(parent):
                land(parent, uid, params.get("index"))
                out[uid] = []
        elif kind == "move":
            uid = named(params["uid"])
            parent = parent_spec(params.get("parent"))
            found, source = parent_of(uid)
            if found and live(parent) and parent not in subtree(uid):
                out[source].remove(uid)
                land(parent, uid, params.get("index"))
        elif kind == "delete":
            uid = named(params["uid"])
            found, source = parent_of(uid)
            if found:
                out[source].remove(uid)
                for u in subtree(uid):
                    out.pop(u, None)
        elif kind != "update":
            raise ValueError(f"command not modelled: {kind!r}")
    return out
