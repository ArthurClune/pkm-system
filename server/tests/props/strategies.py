# pattern: Functional Core
"""Hypothesis strategies for the server property tests: a uid pool, block
texts, a seeded tree, `/api/ops` ops and batches drawn against the
reference model, and `pkm batch` command lists for the CLI planner.

Every weighted choice puts its common case first, so Hypothesis shrinks a
failure toward live targets, valid uids and present hashes rather than
toward the rare branches."""
from __future__ import annotations

import copy
from collections.abc import Sequence
from typing import Any, TypeVar

from hypothesis import strategies as st

from pkm.contracts.ops import subtree_hash, text_hash
from props.model import MBlock, Model

T = TypeVar("T")

# The pages generated ops address. None of them is today's daily page,
# where the server lands conflict headers: ops there would interleave with
# them and break the model's agreement with the server.
PAGES = ("Alpha", "Beta", "Gamma")

# Fails UID_RE (space, "!"), so an op carrying it is a 400.
INVALID_UID = "not a uid!"

_WORDS = ("apple", "river", "note", "plan", "draft")
_KINDS = ("create", "update_text", "move", "delete", "set_collapsed",
          "set_heading", "set_view_type", "create_page")
_HEADINGS = st.sampled_from((None, None, None, 1, 2, 3))
_VIEW_TYPES = st.sampled_from((None, None, "numbered", "document"))


def uid_pool(n: int) -> list[str]:
    """n distinct UID_RE-valid uids. Deterministic, so `texts()` can name
    pool blocks in `((uid))` refs; the `pool` prefix keeps them clear of the
    seed database's `uid_b*` rows."""
    return [f"pool{i:04d}" for i in range(n)]


def texts(uids: Sequence[str] | None = None) -> st.SearchStrategy[str]:
    """Short texts of up to three tokens: plain words, `[[Alpha]]`, `#Beta`,
    a `((uid))` ref to a pool block (`uids`, default the first eight of
    `uid_pool`); no tokens gives ""."""
    pool = list(uids) if uids else uid_pool(8)
    token = st.one_of(st.sampled_from(_WORDS), st.just("[[Alpha]]"),
                      st.just("#Beta"),
                      st.sampled_from(pool).map(lambda u: f"(({u}))"))
    return st.lists(token, max_size=3).map(" ".join)


def _weighted(draw: st.DrawFn, options: Sequence[tuple[int, T]]) -> T:
    """One option, with probability proportional to its weight; zero-weight
    options are never picked. Shrinks toward the first option."""
    live = [(w, o) for w, o in options if w > 0]
    n = draw(st.integers(0, sum(w for w, _ in live) - 1))
    for weight, option in live:
        if n < weight:
            return option
        n -= weight
    raise AssertionError("unreachable")


@st.composite
def seed_tree(draw: st.DrawFn, uids: Sequence[str]) -> list[MBlock]:
    """0-12 blocks over PAGES, at most three levels deep, in creation order:
    a parent before its children, and each sibling group's keys ascending,
    starting at 0-3 with gaps of 1-4, so the seed has the gapped keys a
    delete or a move leaves behind. Seeds start uncollapsed, so they can be
    posted as plain creates."""
    n = draw(st.integers(0, min(12, len(uids))))
    chosen = draw(st.permutations(list(uids)))[:n]
    placed: list[tuple[str, str, str | None, int]] = []   # uid, page, parent, depth
    for uid in chosen:
        parents = [p for p in placed if p[3] < 2]
        parent = draw(st.none() | st.sampled_from(parents)) if parents else None
        if parent is None:
            placed.append((uid, draw(st.sampled_from(PAGES)), None, 0))
        else:
            placed.append((uid, parent[1], parent[0], parent[3] + 1))
    next_key: dict[tuple[str, str | None], int] = {}
    rows: list[MBlock] = []
    for uid, page, parent, _ in placed:
        group = (page, parent)
        key = (next_key[group] + draw(st.integers(1, 4)) if group in next_key
               else draw(st.integers(0, 3)))
        next_key[group] = key
        rows.append(MBlock(uid=uid, page=page, parent=parent, order_idx=key,
                           text=draw(texts(uids)), heading=draw(_HEADINGS),
                           collapsed=False, view_type=draw(_VIEW_TYPES)))
    return rows


def _target(draw: st.DrawFn, model: Model, uids: Sequence[str]) -> str:
    """A pool uid that is live, deleted or never existed, weighted 6:2:2
    among the kinds the pool currently has."""
    live = [u for u in uids if u in model.blocks]
    deleted = [u for u in uids if u in model.deleted and u not in model.blocks]
    fresh = [u for u in uids if u not in model.blocks and u not in model.deleted]
    pool = _weighted(draw, [(6 if live else 0, live),
                            (2 if deleted else 0, deleted),
                            (2 if fresh else 0, fresh)])
    return draw(st.sampled_from(pool))


def _order_idx(draw: st.DrawFn, model: Model) -> int:
    top = max((b.order_idx for b in model.blocks.values()), default=0)
    return draw(st.integers(0, top + 2))


def _stale(text: str) -> str:
    return text + " (stale)"


def _text_hash_field(draw: st.DrawFn, model: Model, uid: str) -> dict:
    """base_text_hash: correct, stale (the hash of a different text) or
    absent. A missing block has no current text; "correct" there hashes ""."""
    current = model.blocks[uid].text if uid in model.blocks else ""
    choice = _weighted(draw, [(1, "correct"), (1, "stale"), (1, "absent")])
    if choice == "absent":
        return {}
    text = current if choice == "correct" else _stale(current)
    return {"base_text_hash": text_hash(text)}


def _subtree_hash_field(draw: st.DrawFn, model: Model, uid: str) -> dict:
    """base_subtree_hash: correct, stale (one text changed) or absent."""
    choice = _weighted(draw, [(1, "correct"), (1, "stale"), (1, "absent")])
    if choice == "absent":
        return {}
    pairs = ([(u, model.blocks[u].text) for u in model.subtree(uid)]
             if uid in model.blocks else [(uid, "")])
    if choice == "stale":
        pairs[0] = (pairs[0][0], _stale(pairs[0][1]))
    return {"base_subtree_hash": subtree_hash(pairs)}


def _create_op(draw: st.DrawFn, model: Model, uids: Sequence[str]) -> dict:
    """A create of a uid that is not live (1 in 40 is live, a 400), at top
    level or under a live, deleted or never-existed parent."""
    free = [u for u in uids if u not in model.blocks]
    taken = [u for u in uids if u in model.blocks]
    uid = draw(st.sampled_from(_weighted(
        draw, [(39 if free else 0, free), (1 if taken else 0, taken)])))
    parent = _weighted(draw, [(3, None), (7, "target")])
    return {"op": "create", "uid": uid,
            "page_title": draw(st.sampled_from(PAGES)),
            "parent_uid": (None if parent is None
                           else _target(draw, model, uids)),
            "order_idx": _order_idx(draw, model),
            "text": draw(texts(uids)),
            "heading": draw(_HEADINGS), "view_type": draw(_VIEW_TYPES)}


def _move_parent(draw: st.DrawFn, model: Model, uids: Sequence[str],
                 uid: str) -> str | None:
    """Top level, a live block outside the subtree, the block itself or a
    descendant (a cycle, 1 in 4 when the block is live), or a missing one."""
    inside = model.subtree(uid) if uid in model.blocks else []
    outside = [u for u in uids if u in model.blocks and u not in inside]
    missing = [u for u in uids if u not in model.blocks]
    pool = _weighted(draw, [(2, [None]), (3 if outside else 0, outside),
                            (2 if inside else 0, inside),
                            (1 if missing else 0, missing)])
    return draw(st.sampled_from(pool))


@st.composite
def op_for(draw: st.DrawFn, model: Model, uids: list[str]) -> dict:
    """One op of the eight kinds, in the wire shape of pkm.contracts.ops,
    drawn against `model` as it stands. `create` is drawn less often than
    the rest: the uid pool is only 8-12 wide, so a uniform draw exhausts
    it (every later create hits an already-live uid, a 400) well before a
    batch runs out of ops. About 1 in 150 ops carries an invalid uid, so
    the 400 path is reached that way too."""
    kind = _weighted(draw, [*((4, k) for k in _KINDS[1:]), (1, "create")])
    if kind == "create_page":
        return {"op": "create_page", "page_title": draw(st.sampled_from(PAGES))}
    if kind == "create":
        op = _create_op(draw, model, uids)
    else:
        uid = _target(draw, model, uids)
        op: dict[str, Any] = {"op": kind, "uid": uid}
        if kind == "update_text":
            op["text"] = draw(texts(uids))
            op.update(_text_hash_field(draw, model, uid))
            hint = draw(st.none() | st.sampled_from(PAGES))
            if hint is not None:
                op["page_title"] = hint
        elif kind == "move":
            op["parent_uid"] = _move_parent(draw, model, uids, uid)
            op["order_idx"] = _order_idx(draw, model)
            title = draw(st.none() | st.sampled_from(PAGES))
            if title is not None:
                op["page_title"] = title
        elif kind == "delete":
            op.update(_subtree_hash_field(draw, model, uid))
        elif kind == "set_collapsed":
            op["collapsed"] = draw(st.booleans())
        elif kind == "set_heading":
            op["heading"] = draw(_HEADINGS)
        else:
            op["view_type"] = draw(st.sampled_from(("numbered", "document")))
    if draw(st.integers(0, 149)) == 149:
        op["uid"] = INVALID_UID
    return op


@st.composite
def batch_for(draw: st.DrawFn, model: Model, uids: list[str]) -> list[dict]:
    """1-20 ops, each drawn against the model as the earlier ops in this
    batch leave it, so a batch can edit a block it created, move a block
    into one it just made, delete then re-create, and so on. Works on a
    `copy.deepcopy` of `model`, applying each drawn op to the copy before
    drawing the next; the copy is then discarded, so `model` is untouched
    and the caller applies the whole batch to it."""
    sim = copy.deepcopy(model)
    ops: list[dict] = []
    for _ in range(draw(st.integers(1, 20))):
        op = draw(op_for(sim, uids))
        ops.append(op)
        sim.apply([op])
    return ops


def _index(draw: st.DrawFn, n: int) -> int | None:
    """A position among n siblings: None (append), inside (0..n) or past
    the end."""
    choice = _weighted(draw, [(1, "none"), (2, "inside"), (1, "past")])
    if choice == "none":
        return None
    if choice == "inside":
        return draw(st.integers(0, n))
    return draw(st.integers(n + 1, n + 3))


@st.composite
def cli_batch(draw: st.DrawFn, blocks: list[MBlock], page: str) -> list[dict]:
    """1-8 `pkm batch` items (`create`, `todo`, `move`, `delete`) on `page`,
    whose fetched blocks are `blocks`. Parents are live blocks (`((uid))`)
    or the `{{alias}}` of an earlier create; moves include onto their own
    slot and cycles. Commands address only blocks the batch has not
    deleted, so a skip can only come from a cycle or a concurrent edit.

    The sibling order is tracked through the batch with list positions
    alone, so indexes land inside or past the end of the group as it then
    stands. A cycle move leaves the tracking untouched, as the server
    skips it."""
    # Group keys are the spec a command would name the block by: a fetched
    # block's uid, or "{{alias}}". Unaliased creates are tracked under a
    # name no command can use, so they still count as siblings.
    order = sorted(blocks, key=lambda b: (b.order_idx, b.uid))
    children: dict[str | None, list[str]] = {}
    for b in order:
        children.setdefault(b.parent, []).append(b.uid)
        children.setdefault(b.uid, [])
    for b in blocks:
        children.setdefault(b.uid, [])

    def parent_of(key: str) -> str | None:
        return next(p for p, kids in children.items() if key in kids)

    def subtree(key: str) -> list[str]:
        out = [key]
        for kid in children.get(key, []):
            out.extend(subtree(kid))
        return out

    def addressable() -> list[str]:
        return [k for k in children if k is not None
                and not k.startswith("#")]

    def spec(key: str) -> str:
        return key if key.startswith("{{") else f"(({key}))"

    items: list[dict] = []
    for i in range(draw(st.integers(1, 8))):
        live = addressable()
        kinds = ["create", "todo", "move", "delete"] if live else ["create",
                                                                   "todo"]
        command = draw(st.sampled_from(kinds))
        if command in ("create", "todo"):
            parent = draw(st.none() | st.sampled_from(live)) if live else None
            group = children.setdefault(parent, [])
            index = _index(draw, len(group))
            params: dict[str, Any] = {"page": page,
                                      "text": draw(st.sampled_from(_WORDS)),
                                      "parent": None if parent is None
                                      else spec(parent),
                                      "index": index}
            alias = draw(st.booleans())
            key = f"{{{{a{i}}}}}" if alias else f"#new{i}"
            if alias:
                params["as"] = f"a{i}"
            pos = len(group) if index is None else min(index, len(group))
            group.insert(pos, key)
            children[key] = []
            items.append({"command": command, "params": params})
        elif command == "move":
            key = draw(st.sampled_from(live))
            inside = subtree(key)
            current = parent_of(key)
            outside = [k for k in live if k not in inside]
            target = _weighted(draw, [(2, "top"), (3 if outside else 0, "other"),
                                      (2, "own"), (1, "cycle")])
            if target == "cycle":
                # An unaliased create inside the subtree has no name a
                # command could use, so it is never a cycle's target.
                dest = draw(st.sampled_from(
                    [k for k in inside if not k.startswith("#")]))
                index = _index(draw, len(children[dest]))
            elif target == "own":
                dest = current
                index = children[current].index(key)
            else:
                dest = (None if target == "top"
                        else draw(st.sampled_from(outside)))
                index = _index(draw, len([k for k in children.setdefault(dest, [])
                                          if k != key]))
            items.append({"command": "move", "params": {
                "uid": key, "page": page,
                "parent": None if dest is None else spec(dest),
                "index": index}})
            if target != "cycle":
                children[current].remove(key)
                group = children.setdefault(dest, [])
                pos = len(group) if index is None else min(index, len(group))
                group.insert(pos, key)
        else:
            key = draw(st.sampled_from(live))
            items.append({"command": "delete", "params": {"uid": key}})
            children[parent_of(key)].remove(key)
            for k in subtree(key):
                children.pop(k, None)
    return items
